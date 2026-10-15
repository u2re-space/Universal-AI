/**
 * @file src/agent/team.js
 * @module agent/team
 * @purpose Run planner, collector, worker, reviewer, and summarizer over one shared context.
 * @depends node:path, node:fs/promises, core/session, core/context, core/memory, openai/errors, util/text, commands/instructions, roles/index, agent/tools, agent/desktop, agent/fs-tools, agent/diff, agent/roles, agent/loop, agent/schemas, agent/map, agent/task-map, agent/team-text, mcp/session
 * @usedBy commands/run, index.js
 * @exports toolNamesForRole, runTeam
 * @ai.tags team, roles
 * @ai.hint keep
 * @changed 2026-10-15 MCP tools on the worker, and read-only MCP tools on collector and reviewer.
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createSession } from '../core/session.js';
import { createSharedContext } from '../core/context.js';
import { renderMemories } from '../core/memory.js';
import { isAbortError, CancelledError } from '../openai/errors.js';
import { clipMiddle, errorMessage } from '../util/text.js';
import { ROLE_INSTRUCTIONS } from '../commands/instructions.js';
import { SPECIALISTS } from '../roles/index.js';
import { createToolset, enabledToolNames, READ_ONLY_TOOLS } from './tools.js';
import { DESKTOP_TOOL_NAMES } from './desktop.js';
import { listFiles } from './fs-tools.js';
import { describeChangeSet } from './diff.js';
import { createRoleRunner } from './roles.js';
import { builtinTools } from './loop.js';
import { imageTransport } from '../openai/images.js';
import { PLAN_SCHEMA, COLLECTOR_SCHEMA, REVIEW_SCHEMA, MEMORY_SCHEMA, BATCH_SCHEMA } from './schemas.js';
import { ensureProjectMap, loadProjectMap } from './map.js';
import { draftTaskMap, filterTaskMap, formatDraft, formatMarks, formatScan } from './task-map.js';
import { SHELL_TOOL_NAMES } from './tool-specs.js';
import { openMcpSources } from '../mcp/session.js';
import { ANSWER_INSTRUCTIONS, chooseRoute, openHandoff, readDirectory, saveHandoff, seedDirectory, seedTextFile, spillAnswer } from './handoff.js';
import { CommandBatchError, executeFileCommands, FILE_COMMANDS_SCHEMA } from './file-commands.js';
import { fileInstructions } from '../roles/encoder.js';

import { bullets, renderFindings, renderPlan } from './team-text.js';
const HARD_STOP = new Set(['cancelled', 'budget']);




/** Collector stays read-only. Reviewer may run commands and use the desktop. Worker keeps every enabled name. */
export function toolNamesForRole(allNames, role) {
    if (role === 'collector') return allNames.filter((name) => READ_ONLY_TOOLS.includes(name));
    if (role === 'reviewer') {
        return allNames.filter((name) => READ_ONLY_TOOLS.includes(name) || SHELL_TOOL_NAMES.includes(name) || DESKTOP_TOOL_NAMES.includes(name));
    }
    return allNames;
}

/**
 * Multi-role run: planner (senior) → collector (cheap, read-only) → worker (tool calls, step by step)
 * → reviewer (+ fix rounds) → summarizer (long-term memory). All roles share one context document.
 *
 * Returns { status, text, plan, review, steps, images, changes, stats, recalled, memoriesSaved, error }.
 * status: completed | revise (review not accepted) | incomplete | cancelled | budget | failed
 */
export async function runTeam({
    client, config, ledger, task, parts = [], root, approvalLevel = 'read', interactive = false, approve, askUser = null,
    memory = null, projectKey = null, projectName = null, backupDir = null, extraInstructions = null, emit = () => {}, signal,
    seedFiles = [],
}) {
    const notify = (event) => { try { emit(event); } catch { /* observer */ } };
    const roles = createRoleRunner({ client, config, ledger, emit, signal });
    const ctx = createSharedContext({ task, root });
    const maxBytes = config.agent.maxContextBytes;
    const result = { status: 'failed', text: '', plan: null, review: null, steps: [], images: [], changes: [], stats: null,
        recalled: [], memoriesSaved: [], reviewRounds: 0, error: null };

    const toolBase = { root, config, client, approve, askUser, backupDir, signal, emit, memory, projectKey, projectName, summarizeFile: roles.summarizeFile };
    const mcp = await openMcpSources(config, { signal, notify });
    const mcpRead = mcp.extras.filter((extra) => extra.category === 'read');
    const imageApi = imageTransport(config) === 'images';
    const enabled = enabledToolNames(config.tools, { interactive, memory: Boolean(memory), summarize: true, imageApi });
    const readNames = toolNamesForRole(enabled, 'collector');
    const reviewerNames = toolNamesForRole(enabled, 'reviewer');
    const allNames = toolNamesForRole(enabled, 'worker');
    const vision = (role) => {
        if (config.agent.visionDelegate === 'never') return null;
        if (role === 'worker' || role === 'reviewer') return roles.describeImage;
        return roles.shouldDelegateVision(role) ? roles.describeImage : null;
    };
    const taskMarks = { edit: null };
    let marks = [];
    /** Run one specialist on `task` and return its text, status, and JSON. */
    async function delegate(role, task) {
        if (!Object.hasOwn(SPECIALISTS, role)) throw new Error(`delegate_role: неизвестная роль «${role}».`);
        const spec = SPECIALISTS[role];
        const names = spec.tools.filter((name) => allNames.includes(name));
        const toolset = createToolset({ ...toolBase, names, approvalLevel, describeScreen: roles.describeScreen });
        const result = await roles.run(role, {
            text: task, instructions: ROLE_INSTRUCTIONS[role], toolset, maxTurns: spec.turns, silent: true,
            ...(spec.schema === 'batch' ? { schema: BATCH_SCHEMA, schemaName: 'batch' } : {}),
        });
        return { output: result.text, summary: role + ' ' + result.status, data: result.data ?? null };
    }
    const workerTools = createToolset({
        ...toolBase, names: allNames, approvalLevel, describeImage: vision('worker'), editPaths: () => taskMarks.edit,
        describeScreen: roles.describeScreen, delegate, extras: mcp.extras,
    });
    const collectorTools = createToolset({ ...toolBase, names: readNames, approvalLevel: 'read', describeImage: vision('collector'), extras: mcpRead });
    const reviewerTools = createToolset({
        ...toolBase, names: reviewerNames, approvalLevel, describeImage: vision('reviewer'),
        describeScreen: roles.describeScreen, delegate, extras: mcpRead,
    });
    const builtin = builtinTools(config, { web: config.tools.web, images: config.tools.images && !imageApi });
    /** Copy tool stats onto the team result and return it. */
    const fileChanges = [];
    const finish = () => {
        result.changes = [...fileChanges, ...workerTools.stats().changes];
        result.stats = { worker: workerTools.stats(), collector: collectorTools.stats(), reviewer: reviewerTools.stats() };
        return result;
    };
    /** Store this stage's status as the team error and return the finished result. */
    const stop = (roleResult, stage) => {
        result.status = roleResult.status === 'completed' ? 'failed' : roleResult.status;
        result.error = roleResult.error ?? new Error(`Этап «${stage}» завершился со статусом ${roleResult.status}.`);
        return finish();
    };

    try {
        ctx.set('environment', 'Environment', `Platform: ${process.platform}; shell for run_command: ${config.shell ?? (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh')}; ` +
            `access policy: ${approvalLevel}; interactive operator: ${interactive ? 'yes' : 'no'}; date: ${new Date().toISOString().slice(0, 10)}`, { priority: 9 });
        if (extraInstructions) ctx.set('operator', 'Operator instructions', extraInstructions, { priority: 9 });
        if (mcp.describe()) ctx.set('mcp', 'MCP sources', mcp.describe(), { priority: 8 });

        // 0. Long-term memory and project notes.
        if (memory) {
            result.recalled = memory.recall(task, { project: projectKey, limit: config.memory.maxRecall });
            if (result.recalled.length) {
                ctx.set('memory', 'Long-term memory (relevant entries)', renderMemories(result.recalled), { priority: 7 });
                notify({ type: 'memory.recalled', count: result.recalled.length, items: result.recalled });
            }
        }
        if (config.memory.notesFile) {
            const notes = await readFile(path.join(root, config.memory.notesFile), 'utf8').catch(() => null);
            if (notes?.trim()) ctx.set('notes', `Project notes (${config.memory.notesFile})`, clipMiddle(notes, 16 * 1024), { priority: 8 });
        }
        const tree = await listFiles({ root, dir: '.', depth: 2, maxEntries: 150 }).catch(() => null);
        if (tree) ctx.set('tree', 'Directory listing (depth 2)', tree.text, { priority: 3 });

        let projectMap = await loadProjectMap(root);
        if (!projectMap) {
            const ensured = await ensureProjectMap(root);
            projectMap = ensured?.error ? null : ensured;
        }
        const draft = formatDraft(draftTaskMap(task, projectMap));
        let handoff = null;

        /** Run fs:read and fs:write. A batch error finishes the team. */
        async function applyCommands(commands) {
            try {
                const outcome = await executeFileCommands({
                    root, state: handoff, commands, limits: config.limits, approvalLevel, approve, backupDir, emit,
                });
                fileChanges.push(...outcome.changes);
                return { ok: true, outcome };
            } catch (error) {
                if (!(error instanceof CommandBatchError)) throw error;
                fileChanges.push(...error.changes);
                result.status = error.fatal ? 'failed' : 'incomplete';
                result.error = error;
                result.text = handoff?.text ?? '';
                return { ok: false, done: finish() };
            }
        }
        /** Ask the encoder for file commands and run them. */
        async function encodeHandoff() {
            notify({ type: 'stage.start', stage: 'encode', role: 'encoder', model: roles.resolve('encoder').model });
            const index = handoff.artifacts.map((item) => `${item.id} ${item.rel} ${item.hintLanguage ?? ''} ${item.hintPath ?? ''}`.trim()).join('\n') || '(none)';
            const encoded = await roles.run('encoder', {
                text: `${handoff.text}\n\n# Directory tree\n${directoryTree}\n\n# Artifacts\n${index}`,
                instructions: fileInstructions, instructionsOnly: true, schema: FILE_COMMANDS_SCHEMA, schemaName: 'file_commands',
            });
            if (encoded.status !== 'completed' || !encoded.data) return { ok: false, done: stop(encoded, 'encoder') };
            const applied = await applyCommands(encoded.data.commands ?? []);
            if (!applied.ok) return applied;
            notify({ type: 'stage.done', stage: 'encode', status: 'completed' });
            return { ok: true, written: applied.outcome.written };
        }

        let directoryTree = '(пусто)';
        try { directoryTree = (await readDirectory({ root, dir: '.', depth: 2, mode: 'tree' })).text; }
        catch { /* a missing root is reported by later file commands */ }

        if (config.agent.chain !== false) {
            handoff = await openHandoff(root);
            for (const file of seedFiles) {
                const seeded = await seedTextFile({ root, state: handoff, file, maxBytes: config.limits.maxFileReadBytes });
                if (!seeded) await seedDirectory({ root, state: handoff, file, depth: 2, mode: 'tree' });
            }
            notify({ type: 'stage.start', stage: 'answer', role: 'default', model: roles.resolve('default').model });
            const answered = await roles.run('default', {
                text: `${ctx.render({ maxBytes })}\n\n# Task\n${task}${handoff.text ? `\n\n# Attached files\n${handoff.text}` : ''}`,
                parts, instructions: ANSWER_INSTRUCTIONS, instructionsOnly: true,
            });
            if (answered.status !== 'completed') return stop(answered, 'ответ');
            const spilled = await spillAnswer(root, handoff, answered.text);
            const route = chooseRoute({
                flag: config.agent.route, label: spilled.label, text: handoff.text,
                artifacts: handoff.artifacts.filter((item) => item.origin == null),
            });
            handoff.route = route;
            handoff.to = route === 'encode' ? 'encoder' : 'planner';
            await saveHandoff(root, handoff);
            ctx.set('answer', 'First answer', handoff.text, { priority: 5 });
            ctx.set('artifacts', 'Artifacts', handoff.artifacts.map((item) => `${item.id} ${item.rel}`).join('\n') || '(none)', { priority: 8 });
            notify({ type: 'stage.done', stage: 'answer', status: 'completed', route });
            if (route === 'encode') {
                const encoded = await encodeHandoff();
                if (!encoded.ok) return encoded.done;
                result.status = 'completed';
                const files = encoded.written.length ? `## Файлы\n${encoded.written.map((item) => `- ${item}`).join('\n')}` : '';
                result.text = [handoff.text, files].filter(Boolean).join('\n\n');
                result.finalNote = encoded.written.length ? `Записаны файлы: ${encoded.written.join(', ')}` : handoff.text;
                return finish();
            }
        }

        // 1. Planner.
        notify({ type: 'stage.start', stage: 'plan', role: 'planner', model: roles.resolve('planner').model });
        const planned = await roles.run('planner', {
            text: `${ctx.render({ maxBytes })}\n\n# Directory tree\n${directoryTree}\n\n${draft}\n\n# Task\n${task}`, parts: handoff ? [] : parts,
            instructions: ROLE_INSTRUCTIONS.planner.replace('{maxSteps}', String(config.agent.maxSteps)), schema: PLAN_SCHEMA, schemaName: 'plan',
        });
        if (planned.status !== 'completed') return stop(planned, 'план');
        const plan = planned.data;
        plan.steps = plan.steps.slice(0, config.agent.maxSteps);
        if (!plan.steps.length) plan.steps = [{ goal: task, details: 'Complete the task as described.', verify: 'Re-read the result.' }];
        marks = filterTaskMap(plan.taskMap, projectMap);
        taskMarks.edit = new Set(marks.filter((item) => item.role === 'edit').map((item) => item.path));
        ctx.set('taskMap', 'Task map', formatMarks(marks), { priority: 8 });
        const scan = formatScan(projectMap, marks);
        if (scan) ctx.set('scan', 'Symbols (scan)', scan, { priority: 4 });
        result.plan = plan;
        ctx.set('plan', 'Plan', renderPlan(plan), { priority: 8 });
        if (plan.imageNotes) ctx.set('images', 'Attached images (planner notes)', plan.imageNotes, { priority: 7 });
        notify({ type: 'plan.ready', summary: plan.summary, complexity: plan.complexity, steps: plan.steps.map((s) => s.goal),
            acceptanceCriteria: plan.acceptanceCriteria, needsReview: plan.needsReview, risks: plan.risks });
        notify({ type: 'stage.done', stage: 'plan', status: 'completed' });
        plan.fileActions = Array.isArray(plan.fileActions) ? plan.fileActions : [];
        if (handoff) {
            for (const action of plan.fileActions) {
                if (action?.action === 'encode') {
                    const encoded = await encodeHandoff();
                    if (!encoded.ok) return encoded.done;
                } else if (action?.action === 'read' || action?.action === 'write' || action?.action === 'list') {
                    const command = action.action === 'list'
                        ? {
                            command: 'fs:list', path: action.path || '.', cwd: action.cwd || '.', type: 'text', language: 'text',
                            content: null, lines: null, source: null, start: null, end: null,
                            depth: action.depth ?? 2, mode: action.mode || 'tree',
                        }
                        : {
                            command: action.action === 'read' ? 'fs:read' : 'fs:write',
                            path: action.path ?? '', cwd: action.cwd || '.', type: action.language === 'text' ? 'text' : 'code',
                            language: action.language ?? '', content: null, lines: null,
                            source: action.action === 'write' ? (action.source ?? null) : null,
                            start: action.action === 'read' ? (action.start ?? null) : null,
                            end: action.action === 'read' ? (action.end ?? null) : null,
                        };
                    const applied = await applyCommands([command]);
                    if (!applied.ok) return applied.done;
                }
            }
            ctx.set('answer', 'First answer', handoff.text, { priority: 5 });
            ctx.set('artifacts', 'Artifacts', handoff.artifacts.map((item) => `${item.id} ${item.rel} ${item.hintLanguage ?? ''}`.trim()).join('\n') || '(none)', { priority: 8 });
        }

        // 2. Collector (cheap model, read-only).
        const wantsContext = plan.complexity !== 'trivial' && (
            plan.filesOfInterest.length || plan.searchQueries.length || plan.questionsForCollector.length
            || marks.some((item) => item.role === 'read' || item.role === 'edit')
        );
        if (wantsContext && readNames.length) {
            notify({ type: 'stage.start', stage: 'collect', role: 'collector', model: roles.resolve('collector').model });
            const focus = marks.filter((item) => item.role === 'read' || item.role === 'edit').map((item) => `${item.role} ${item.path} — ${item.reason}`);
            const brief = `# Collector brief\nTask map (read/edit):\n${bullets(focus)}\nFiles of interest:\n${bullets(plan.filesOfInterest)}\nSearch queries:\n${bullets(plan.searchQueries)}\nQuestions to answer:\n${bullets(plan.questionsForCollector)}`;
            const collected = await roles.run('collector', {
                text: `${ctx.render({ maxBytes })}\n\n${brief}`, instructions: ROLE_INSTRUCTIONS.collector, toolset: collectorTools,
                schema: COLLECTOR_SCHEMA, schemaName: 'context_report', maxTurns: config.agent.collectorMaxTurns,
            });
            if (HARD_STOP.has(collected.status)) return stop(collected, 'сбор контекста');
            if (collected.status === 'completed' && collected.data) ctx.set('findings', 'Collected context (by the collector)', renderFindings(collected.data), { priority: 6 });
            else notify({ type: 'warning', message: `Сбор контекста не завершён (${collected.status}${collected.error ? `: ${errorMessage(collected.error)}` : ''}); продолжаем без него.` });
            notify({ type: 'stage.done', stage: 'collect', status: collected.status });
        }

        // 3. Worker: one conversation, one step at a time.
        notify({ type: 'stage.start', stage: 'work', role: 'worker', model: roles.resolve('worker').model });
        let workerSession = createSession({ store: false, model: roles.resolve('worker').model });
        let workIncomplete = false;
        let contextSent = false;
        /** Send one worker step, reusing the session until it grows past 160 items. */
        const runWorker = async (title, body) => {
            if (workerSession.size > 160) { workerSession = createSession({ store: false, model: roles.resolve('worker').model }); contextSent = false; }
            const header = contextSent ? `# Context updates\n${ctx.get('progress') ? clipMiddle(ctx.get('progress'), 12 * 1024) : '(none)'}` : ctx.render({ maxBytes, exclude: ['tree'] });
            contextSent = true;
            return roles.run('worker', { text: `${header}\n\n# ${title}\n${body}`, instructions: ROLE_INSTRUCTIONS.worker, toolset: workerTools, builtin,
                maxTurns: config.agent.workerMaxTurnsPerStep, session: workerSession, imageTarget: config.image.outputDir });
        };
        for (const [index, step] of plan.steps.entries()) {
            const number = index + 1;
            notify({ type: 'step.start', index: number, total: plan.steps.length, goal: step.goal });
            const outcome = await runWorker(`Your step ${number} of ${plan.steps.length}`, `Goal: ${step.goal}\nDetails: ${step.details}\nVerify: ${step.verify}`);
            result.images.push(...outcome.images);
            const report = outcome.text.trim() || '(отчёт отсутствует)';
            result.steps.push({ index: number, goal: step.goal, status: outcome.status, report });
            ctx.append('progress', 'Progress (worker reports)', `### Step ${number}: ${step.goal}\nStatus: ${outcome.status}\n${report}`, { priority: 6 });
            notify({ type: 'step.done', index: number, total: plan.steps.length, status: outcome.status, summary: report });
            if (HARD_STOP.has(outcome.status)) return stop(outcome, `шаг ${number}`);
            if (outcome.status !== 'completed') {
                notify({ type: 'warning', message: `Шаг ${number} не завершён (${outcome.status}${outcome.error ? `: ${errorMessage(outcome.error)}` : ''}); дальнейшие шаги пропущены.` });
                workIncomplete = true;
                break;
            }
        }
        notify({ type: 'stage.done', stage: 'work', status: workIncomplete ? 'incomplete' : 'completed' });

        // 4. Review and fix rounds.
        const shouldReview = plan.needsReview && plan.complexity !== 'trivial' && config.agent.maxReviewRounds > 0 && !workIncomplete;
        let review = null;
        for (let round = 1; shouldReview; round++) {
            notify({ type: 'stage.start', stage: 'review', role: 'reviewer', model: roles.resolve('reviewer').model, round });
            ctx.set('diff', 'Changes made by the worker (diff)', await describeChangeSet({ root, changes: workerTools.stats().changes, maxBytes: 48 * 1024 }), { priority: 5 });
            const commands = workerTools.stats().commands.map((c) => `- ${c.command} → exit ${c.exitCode ?? '?'}`).join('\n') || '- (none)';
            const reviewed = await roles.run('reviewer', {
                text: `${ctx.render({ maxBytes })}\n\n# Review request (round ${round})\nAcceptance criteria:\n${bullets(plan.acceptanceCriteria)}\nCommands run by the worker:\n${commands}`,
                instructions: ROLE_INSTRUCTIONS.reviewer, toolset: reviewerTools, schema: REVIEW_SCHEMA, schemaName: 'review', maxTurns: config.agent.reviewerMaxTurns,
            });
            if (HARD_STOP.has(reviewed.status)) return stop(reviewed, 'ревью');
            if (reviewed.status !== 'completed' || !reviewed.data) {
                notify({ type: 'warning', message: `Ревью не завершено (${reviewed.status}); результат принят без независимой проверки.` });
                break;
            }
            review = reviewed.data;
            result.review = review;
            result.reviewRounds = round;
            notify({ type: 'review.done', round, verdict: review.verdict, summary: review.summary, issues: review.issues, unverified: review.unverified });
            notify({ type: 'stage.done', stage: 'review', status: review.verdict });
            if (review.verdict === 'accept' || round > config.agent.maxReviewRounds) break;
            notify({ type: 'stage.start', stage: 'fix', role: 'worker', model: roles.resolve('worker').model, round });
            const issues = review.issues.map((i) => `- [${i.severity}] ${i.path ? `${i.path}: ` : ''}${i.message} → ${i.requestedChange}`).join('\n') || '- (see summary)';
            const fixed = await runWorker(`Review round ${round}: changes requested`, `${review.summary}\n${issues}\n\nAddress every issue, verify, and report what you changed.`);
            result.images.push(...fixed.images);
            result.steps.push({ index: `fix-${round}`, goal: 'Устранение замечаний ревью', status: fixed.status, report: fixed.text.trim() });
            ctx.append('progress', 'Progress (worker reports)', `### Fix round ${round}\nStatus: ${fixed.status}\n${fixed.text.trim()}`, { priority: 6 });
            notify({ type: 'stage.done', stage: 'fix', status: fixed.status });
            if (HARD_STOP.has(fixed.status)) return stop(fixed, 'исправления');
        }

        // 5. Outcome.
        if (workIncomplete) result.status = 'incomplete';
        else if (review && review.verdict !== 'accept') result.status = 'revise';
        else result.status = 'completed';
        const lastReport = result.steps.at(-1)?.report ?? '';
        result.text = [
            `## План\n${plan.summary}`,
            ...result.steps.map((s) => `## Шаг ${s.index}: ${s.goal} — ${s.status}\n${s.report}`),
            review ? `## Ревью (${review.verdict})\n${review.summary}${review.issues.length ? `\n${review.issues.map((i) => `- [${i.severity}] ${i.path ? `${i.path}: ` : ''}${i.message}`).join('\n')}` : ''}${review.unverified.length ? `\nНе проверено:\n${bullets(review.unverified)}` : ''}` : '',
        ].filter(Boolean).join('\n\n');
        result.finalNote = review ? `${review.verdict === 'accept' ? 'Ревью: принято.' : 'Ревью: остались замечания.'} ${review.summary}` : lastReport;

        // 6. Memory extraction (cheap summarizer role).
        if (memory) {
            if (config.memory.autoSave) {
                notify({ type: 'stage.start', stage: 'memory', role: 'summarizer', model: roles.resolve('summarizer').model });
                const extracted = await roles.run('summarizer', {
                    text: `# Task\n${task}\n\n# Plan summary\n${plan.summary}\n\n# Worker reports\n${clipMiddle(ctx.get('progress'), 24 * 1024)}\n\n# Review\n${review ? `${review.verdict}: ${review.summary}` : 'not performed'}` +
                        `\n\n# Existing memories (do not repeat)\n${renderMemories(result.recalled) || '(none)'}`,
                    instructions: ROLE_INSTRUCTIONS.summarizerMemory, schema: MEMORY_SCHEMA, schemaName: 'memory_update',
                });
                if (extracted.status === 'completed' && extracted.data) {
                    for (const item of extracted.data.memories.slice(0, 6)) {
                        try {
                            result.memoriesSaved.push(memory.remember({ scope: item.scope, project: projectKey, projectName, kind: item.kind, content: item.content, tags: item.tags, source: 'summarizer' }));
                        } catch (error) { notify({ type: 'warning', message: `Память: ${errorMessage(error)}` }); }
                    }
                    if (result.memoriesSaved.length) notify({ type: 'memory.saved', count: result.memoriesSaved.length, items: result.memoriesSaved });
                    result.taskSummary = extracted.data.taskSummary;
                }
                notify({ type: 'stage.done', stage: 'memory', status: extracted.status });
            }
            memory.recordTask({ project: projectKey, projectName, task, status: result.status, summary: result.taskSummary ?? plan.summary,
                changes: workerTools.stats().changes.map((c) => c.path), usage: ledger.snapshot() });
        }
        return finish();
    } catch (error) {
        result.status = isAbortError(error) || signal?.aborted || error instanceof CancelledError ? 'cancelled' : 'failed';
        result.error = error;
        return finish();
    } finally {
        await mcp.close();
    }
}
