/**
 * @file src/agent/team.js
 * @module agent/team
 * @purpose Run planner, collector, worker, reviewer, and summarizer over one shared context.
 * @depends node:path, node:fs/promises, core/session, core/context, core/memory, openai/errors, util/text, commands/instructions, roles/index, agent/tools, agent/desktop, agent/fs-tools, agent/diff, agent/roles, agent/loop, agent/schemas, agent/map, agent/task-map, agent/team-text, agent/workspace-scan, agent/work-plan, agent/handoff, mcp/session, channels/decide, channels/questions, channels/verdict
 * @usedBy commands/run, index.js
 * @exports toolNamesForRole, runTeam
 * @ai.tags team, roles
 * @ai.hint keep
 * @changed 2026-10-16 Plan and progress are stored in `.tmp`; a run resumes from the newest unfinished progress.
 */

import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createSession, loadSession } from '../core/session.js';
import { createSharedContext } from '../core/context.js';
import { renderMemories } from '../core/memory.js';
import { isAbortError, CancelledError } from '../openai/errors.js';
import { clipMiddle, errorMessage } from '../util/text.js';
import { ROLE_INSTRUCTIONS } from '../commands/instructions.js';
import { SPECIALISTS } from '../roles/index.js';
import { coderChoice, isCodingStep } from '../roles/coder.js';
import { writerChoice, isWritingStep } from '../roles/writer.js';
import { createToolset, enabledToolNames, READ_ONLY_TOOLS } from './tools.js';
import { DESKTOP_TOOL_NAMES } from './desktop.js';
import { listFiles } from './fs-tools.js';
import { describeChangeSet } from './diff.js';
import { createRoleRunner } from './roles.js';
import { builtinTools } from './loop.js';
import { imageTransport } from '../openai/images.js';
import { planLimit, stepAllowance } from './step-budget.js';
import { PLAN_SCHEMA, COLLECTOR_SCHEMA, REVIEW_SCHEMA, MEMORY_SCHEMA, BATCH_SCHEMA } from './schemas.js';
import { ensureProjectMap, loadProjectMap } from './map.js';
import { draftTaskMap, filterTaskMap, formatDraft, formatMarks, formatScan } from './task-map.js';
import { formatWorkspace, mergeTaskDraft, scanWorkspace } from './workspace-scan.js';
import { SHELL_TOOL_NAMES } from './tool-specs.js';
import { openMcpSources } from '../mcp/session.js';
import { ANSWER_INSTRUCTIONS, chooseRoute, loadHandoff, openHandoff, readDirectory, saveHandoff, seedDirectory, seedTextFile, spillAnswer } from './handoff.js';
import { applyFromStep, applyPlanUpdate, briefPlan, briefProgress, continuationText, createProgress, expandPlan, findResumable, loadWork, newWorkId, parsePlanUpdate, pathsIn, recordStep, revisionClause, saveWork, syncProgress } from './work-plan.js';
import { neutralPlan, neutralProgress, neutralSession } from './neutral.js';
import { CommandBatchError, executeFileCommands, FILE_COMMANDS_SCHEMA } from './file-commands.js';

/**
 * Coder for source files, writer for documents, worker for everything else.
 * @param {string[]} files
 * @param {string} goal
 * @returns {'coder'|'writer'|'worker'}
 * @ai.hint pure
 */
function authorFor(files, goal) {
    if (isCodingStep(files, goal)) return 'coder';
    if (isWritingStep(files, goal)) return 'writer';
    return 'worker';
}
import { fileInstructions } from '../roles/encoder.js';
import { requestDecision } from '../channels/decide.js';
import { questionsFor } from '../channels/questions.js';
import { routeFlag } from '../channels/verdict.js';

import { bullets, renderFindings } from './team-text.js';
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
    seedFiles = [], generation = false, revision = '', fromStep = null, resumeId = null,
}) {
    const notify = (event) => { try { emit(event); } catch { /* observer */ } };
    const roles = createRoleRunner({ client, config, ledger, emit, signal });
    const ctx = createSharedContext({ task, root });
    const maxBytes = config.agent.maxContextBytes;
    const stepLimit = planLimit({ maxSteps: config.agent.maxSteps, generation });
    const result = { status: 'failed', text: '', plan: null, review: null, steps: [], images: [], changes: [], stats: null,
        recalled: [], memoriesSaved: [], reviewRounds: 0, error: null };

    const toolBase = { root, config, client, ledger, approve, askUser, backupDir, signal, emit, memory, projectKey, projectName, summarizeFile: roles.summarizeFile, scaffoldTask: task };
    const mcp = await openMcpSources(config, { signal, notify });
    const mcpRead = mcp.extras.filter((extra) => extra.category === 'read');
    const imageApi = imageTransport(config) === 'images';
    const enabled = enabledToolNames(config.tools, { interactive, memory: Boolean(memory), summarize: true, imageApi, unsafeScreenshot: config.desktop?.unsafeScreenshot === true });
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
    let work = null;
    const finish = () => {
        result.changes = [...fileChanges, ...workerTools.stats().changes];
        result.stats = { worker: workerTools.stats(), collector: collectorTools.stats(), reviewer: reviewerTools.stats() };
        return result;
    };
    /** Write the current plan and progress. A missing work record is a no-op. */
    const persist = async (status) => {
        if (!work) return;
        if (status) work.progress.status = status;
        try { await saveWork(root, work); }
        catch (error) { notify({ type: 'warning', message: `План не сохранён: ${errorMessage(error)}` }); }
    };
    /** Store this stage's status as the team error and return the finished result. */
    const stop = async (roleResult, stage) => {
        result.status = roleResult.status === 'completed' ? 'failed' : roleResult.status;
        result.error = roleResult.error ?? new Error(`Этап «${stage}» завершился со статусом ${roleResult.status}.`);
        await persist(result.status);
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
        let workspace = null;
        try { workspace = await scanWorkspace(root, { task }); }
        catch (error) { notify({ type: 'warning', message: `Сканер workspace: ${errorMessage(error)}` }); }
        if (workspace) {
            notify({ type: 'stage.start', stage: 'scan', role: 'scanner' });
            ctx.set('workspace', 'Workspace scan', formatWorkspace(workspace), { priority: 8 });
            notify({ type: 'stage.done', stage: 'scan', status: 'completed', files: workspace.files.map((item) => item.path) });
        }
        const draft = formatDraft(mergeTaskDraft(draftTaskMap(task, projectMap), workspace?.files ?? []));
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
                await persist(result.status);
                return { ok: false, done: finish() };
            }
        }
        /** Ask the encoder for file commands and run them. */
        async function encodeHandoff() {
            notify({ type: 'stage.start', stage: 'encode', role: 'encoder', model: roles.resolve('encoder').model });
            const index = handoff.artifacts.map((item) => `${item.id} ${item.rel} ${item.hintLanguage ?? ''} ${item.hintPath ?? ''}`.trim()).join('\n') || '(none)';
            const workspaceText = ctx.get('workspace');
            const encoded = await roles.run('encoder', {
                text: `${handoff.text}\n\n# Directory tree\n${directoryTree}${workspaceText ? `\n\n# Workspace scan\n${workspaceText}` : ''}\n\n# Artifacts\n${index}`,
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

        let plan = null;
        let progress = null;
        const resumedWork = resumeId
            ? await loadWork(root, resumeId).catch(() => null)
            : (config.agent.resume !== false ? await findResumable(root, task) : null);
        if (resumeId && !resumedWork) throw new Error(`План .tmp/${resumeId} не прочитан.`);
        /** Put the short plan and the latest reports into the shared context. Bodies stay in `.tmp`. */
        const publish = () => {
            if (!plan || !progress) return;
            ctx.set('plan', 'Plan', briefPlan(plan, progress), { priority: 8 });
            ctx.set('progress', 'Progress (worker reports)', briefProgress(progress), { priority: 6 });
        };
        /** Confirmed read/edit/scan marks for the worker and the collector. */
        const applyMarks = (source) => {
            marks = filterTaskMap(source?.taskMap, projectMap);
            taskMarks.edit = new Set(marks.filter((item) => item.role === 'edit').map((item) => item.path));
            ctx.set('taskMap', 'Task map', formatMarks(marks), { priority: 8 });
            const scan = formatScan(projectMap, marks);
            ctx.set('scan', 'Symbols (scan)', scan, { priority: 4 });
        };
        const showPlan = () => notify({
            type: 'plan.ready', summary: plan.summary, complexity: plan.complexity, steps: plan.steps.map((step) => step.goal),
            acceptanceCriteria: plan.acceptanceCriteria, needsReview: plan.needsReview, risks: plan.risks,
        });
        let seenChanges = workerTools.stats().changes.length;
        /** Paths written since the previous worker pass. */
        const takeFiles = () => {
            const paths = workerTools.stats().changes.slice(seenChanges).map((change) => change.path);
            seenChanges = workerTools.stats().changes.length;
            return paths;
        };
        let workerSession = createSession({ store: false, model: roles.resolve('worker').model });
        let sessionModel = workerSession ? roles.resolve('worker').model : null;
        let contextSent = false;
        let pendingSession = null;
        const sessionFile = () => work?.id ? path.join(root, '.tmp', work.id, 'worker-session.json') : null;
        /**
         * Model that will run this step. A restored session is used only when it matches.
         * @param {string[]} files
         * @param {string} goal
         * @returns {{ author: string, model: string }}
         */
        const authorModel = (files, goal) => {
            const author = authorFor(files, goal);
            const configured = config.roles?.[author] ?? {};
            const choice = author === 'coder' ? coderChoice(plan?.complexity, configured)
                : author === 'writer' ? writerChoice(plan?.complexity, configured) : null;
            return { author, model: choice?.model ?? roles.resolve(author).model };
        };
        /** Send one worker, coder, or writer turn. A restored session continues the interrupted turn. */
        const runWorker = async (title, body, maxTurns = config.agent.workerMaxTurnsPerStep, author = 'worker', checkpoint = null) => {
            const configured = config.roles?.[author] ?? {};
            const choice = author === 'coder' ? coderChoice(plan?.complexity, configured)
                : author === 'writer' ? writerChoice(plan?.complexity, configured) : null;
            const model = choice?.model ?? roles.resolve(author).model;
            const restored = Boolean(checkpoint?.resume && pendingSession && pendingSession.model === model);
            if (restored) {
                workerSession = pendingSession;
                pendingSession = null;
                sessionModel = model;
                contextSent = true;
            } else if (workerSession.size > 160 || sessionModel !== model) {
                workerSession = createSession({ store: false, model });
                sessionModel = model;
                contextSent = false;
            }
            const header = contextSent ? `# Context updates\n${ctx.get('progress') ? clipMiddle(ctx.get('progress'), 12 * 1024) : '(none)'}` : ctx.render({ maxBytes, exclude: ['tree'] });
            contextSent = true;
            const outcome = await roles.run(author, {
                text: `${header}\n\n# ${title}\n${body}`, instructions: ROLE_INSTRUCTIONS[author], toolset: workerTools, builtin,
                maxTurns, session: workerSession, imageTarget: config.image.outputDir,
                model: choice?.model ?? null, effort: choice?.effort ?? null,
            });
            if (checkpoint?.stepId && work) {
                progress.checkpoint = { stepId: checkpoint.stepId, phase: checkpoint.phase, model };
                work.progress = progress;
                const file = sessionFile();
                if (file) {
                    neutralSession(workerSession);
                    await workerSession.save(file).catch((error) => notify({ type: 'warning', message: `Сессия шага не сохранена: ${errorMessage(error)}` }));
                }
            }
            return outcome;
        };
        /**
         * Remember the live plan. `expose` is false for an encode compatibility plan so `result.plan` stays null.
         * @param {object} nextPlan
         * @param {object} nextProgress
         * @param {{ expose?: boolean }} [options]
         */
        const bind = (nextPlan, nextProgress, { expose = true } = {}) => {
            plan = neutralPlan(nextPlan);
            progress = neutralProgress(nextProgress);
            if (generation) progress.generation = true;
            work = { id: progress.id, plan, progress };
            if (expose) result.plan = plan;
            result.workId = work.id;
            applyMarks(plan);
            if (plan.imageNotes) ctx.set('images', 'Attached images (planner notes)', plan.imageNotes, { priority: 7 });
            publish();
        };
        /** Fill lists the planner schema always sends, so a resumed file cannot crash the collector. */
        const lists = (source) => {
            for (const key of ['filesOfInterest', 'searchQueries', 'questionsForCollector', 'acceptanceCriteria', 'risks']) {
                if (!Array.isArray(source[key])) source[key] = [];
            }
            if (!Array.isArray(source.fileActions)) source.fileActions = [];
            if (!Array.isArray(source.taskMap)) source.taskMap = [];
            return source;
        };

        if (resumedWork) {
            handoff = await loadHandoff(root, resumedWork.id);
            bind(lists(resumedWork.plan), resumedWork.progress);
            if (handoff?.text) {
                ctx.set('answer', 'First answer', handoff.text, { priority: 5 });
                ctx.set('artifacts', 'Artifacts', handoff.artifacts.map((item) => `${item.id} ${item.rel} ${item.hintLanguage ?? ''}`.trim()).join('\n') || '(none)', { priority: 8 });
            }
            const findings = await readFile(path.join(root, '.tmp', work.id, 'findings.md'), 'utf8').catch(() => '');
            if (findings.trim()) ctx.set('findings', 'Collected context (by the collector)', findings, { priority: 6 });
            pendingSession = await loadSession(path.join(root, '.tmp', work.id, 'worker-session.json')).catch(() => null);
            if (pendingSession) neutralSession(pendingSession);
            if (Number.isInteger(fromStep)) progress = applyFromStep(progress, fromStep);
            work.progress = progress;
            const open = progress.steps?.[progress.cursor];
            notify({
                type: 'plan.resume', id: work.id, cursor: progress.cursor, steps: plan.steps.length,
                phase: open?.phase ?? null, stage: progress.stage,
            });
            showPlan();
        }

        if (!resumedWork && config.agent.chain !== false) {
            handoff = await openHandoff(root);
            for (const file of seedFiles) {
                const seeded = await seedTextFile({ root, state: handoff, file, maxBytes: config.limits.maxFileReadBytes });
                if (!seeded) await seedDirectory({ root, state: handoff, file, depth: 2, mode: 'tree' });
            }
            notify({ type: 'stage.start', stage: 'answer', role: 'default', model: roles.resolve('default').model });
            const answered = await roles.run('default', {
                text: `${ctx.render({ maxBytes })}\n\n# Task\n${task}${handoff.text ? `\n\n# Attached files\n${handoff.text}` : ''}`,
                parts, instructions: ANSWER_INSTRUCTIONS, instructionsOnly: true,
                builtin: config.tools.web ? builtinTools(config, { web: true }) : [],
            });
            if (answered.status !== 'completed') return stop(answered, 'ответ');
            const spilled = await spillAnswer(root, handoff, answered.text);
            let routeChoice = config.agent.route;
            if (routeChoice === 'decisions') {
                routeChoice = null;
                try {
                    const raw = await requestDecision(client, {
                        model: config.decisions?.model ?? 'openai/gpt-6-luna-decisions',
                        state: { task, answer: handoff.text },
                        questions: questionsFor('route'),
                        signal,
                    });
                    ledger.record({ model: raw.model, usage: raw.usage, kind: 'decision', responseId: raw.id });
                    routeChoice = routeFlag(raw.answers, { blockAt: config.decisions?.blockAt ?? 0.9 });
                    notify({ type: 'decision.route', choice: raw.answers?.next?.choice ?? null, flag: routeChoice });
                } catch (error) {
                    notify({ type: 'decision.route', error: error.message });
                }
            }
            const route = chooseRoute({
                flag: routeChoice, label: spilled.label, text: handoff.text,
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
                if (encoded.written.length >= 2) {
                    const filePlan = lists(expandPlan({
                        summary: 'Запись файлов', complexity: 'normal',
                        steps: encoded.written.map((file) => ({ goal: `Записать ${file}`, details: file, verify: `Прочитать ${file}.` })),
                        filesOfInterest: [], searchQueries: [], questionsForCollector: [],
                        acceptanceCriteria: ['Файлы согласованы между собой.'], needsReview: false, imageNotes: null, risks: [],
                        fileActions: [], taskMap: [],
                    }, { maxSteps: config.agent.maxSteps }));
                    let fileProgress = createProgress({ id: handoff.id, task, plan: filePlan });
                    for (let index = 0; index < filePlan.steps.length; index++) {
                        if (filePlan.steps[index].kind === 'compat') break;
                        fileProgress = recordStep(fileProgress, {
                            index, status: 'completed', report: `записан ${filePlan.steps[index].files?.[0] ?? ''}`,
                            files: filePlan.steps[index].files ?? [],
                        });
                    }
                    bind(filePlan, fileProgress, { expose: false });
                    await persist('running');
                    const compatIndex = plan.steps.findIndex((step) => step.kind === 'compat');
                    if (compatIndex >= 0) {
                        const step = plan.steps[compatIndex];
                        notify({ type: 'step.start', index: compatIndex + 1, total: plan.steps.length, goal: step.goal });
                        const outcome = await runWorker(`Compatibility pass (step ${compatIndex + 1} of ${plan.steps.length})`,
                            `Goal: ${step.goal}\nDetails: ${step.details}\nVerify: ${step.verify}`, config.agent.workerMaxTurnsPerStep, authorFor(step.files, step.goal));
                        result.images.push(...outcome.images);
                        progress = recordStep(progress, {
                            index: compatIndex, status: outcome.status, report: outcome.text.trim() || '(отчёт отсутствует)', files: takeFiles(),
                        });
                        work.progress = progress;
                        publish();
                        await persist(outcome.status === 'completed' ? 'running' : outcome.status);
                        notify({ type: 'step.done', index: compatIndex + 1, total: plan.steps.length, status: outcome.status, summary: outcome.text.trim() });
                        if (HARD_STOP.has(outcome.status)) return stop(outcome, 'согласование');
                        if (outcome.status !== 'completed') {
                            result.status = 'incomplete';
                            result.text = handoff.text;
                            await persist('incomplete');
                            return finish();
                        }
                    }
                    work.progress.stage = 'done';
                    await persist('completed');
                }
                result.status = 'completed';
                const files = encoded.written.length ? `## Файлы\n${encoded.written.map((item) => `- ${item}`).join('\n')}` : '';
                const compatReport = progress?.steps?.find((step) => step.kind === 'compat' && step.report)?.report;
                const compat = compatReport ? `## Согласование\n${compatReport}` : '';
                result.text = [handoff.text, files, compat].filter(Boolean).join('\n\n');
                result.finalNote = encoded.written.length ? `Записаны файлы: ${encoded.written.join(', ')}` : handoff.text;
                return finish();
            }
        }

        // 1. Planner. A resumed plan is already bound.
        if (!plan) {
        notify({ type: 'stage.start', stage: 'plan', role: 'planner', model: roles.resolve('planner').model });
        const planned = await roles.run('planner', {
            text: `${ctx.render({ maxBytes })}\n\n# Directory tree\n${directoryTree}\n\n${draft}\n\n# Task\n${task}`, parts: handoff ? [] : parts,
            instructions: ROLE_INSTRUCTIONS.planner.replace('{maxSteps}', String(stepLimit)), schema: PLAN_SCHEMA, schemaName: 'plan',
            builtin: config.tools.web ? builtinTools(config, { web: true }) : [],
        });
        if (planned.status !== 'completed') return stop(planned, 'план');
        const drafted = lists(planned.data);
        drafted.steps = drafted.steps.slice(0, stepLimit);
        if (!drafted.steps.length) drafted.steps = [{ goal: task, details: 'Complete the task as described.', verify: 'Re-read the result.' }];
        const expanded = lists(expandPlan(drafted, { maxSteps: stepLimit, splitFiles: !generation }));
        const id = handoff?.id ?? newWorkId();
        bind(expanded, createProgress({ id, task, plan: expanded }));
        await persist('running');
        showPlan();
        notify({ type: 'stage.done', stage: 'plan', status: 'completed' });
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
        }

        // 2. Collector (cheap model, read-only). Skipped when this run already moved past it.
        const wantsContext = plan.complexity !== 'trivial' && (
            plan.filesOfInterest.length || plan.searchQueries.length || plan.questionsForCollector.length
            || marks.some((item) => item.role === 'read' || item.role === 'edit')
        );
        const pastCollect = Boolean(resumedWork) && (
            progress.cursor > 0 || Boolean(ctx.get('findings')) || ['work', 'review', 'fix', 'done'].includes(progress.stage)
        );
        if (!pastCollect && wantsContext && readNames.length) {
            notify({ type: 'stage.start', stage: 'collect', role: 'collector', model: roles.resolve('collector').model });
            const focus = marks.filter((item) => item.role === 'read' || item.role === 'edit').map((item) => `${item.role} ${item.path} — ${item.reason}`);
            const brief = `# Collector brief\nTask map (read/edit):\n${bullets(focus)}\nFiles of interest:\n${bullets(plan.filesOfInterest)}\nSearch queries:\n${bullets(plan.searchQueries)}\nQuestions to answer:\n${bullets(plan.questionsForCollector)}`;
            const collected = await roles.run('collector', {
                text: `${ctx.render({ maxBytes })}\n\n${brief}`, instructions: ROLE_INSTRUCTIONS.collector, toolset: collectorTools,
                schema: COLLECTOR_SCHEMA, schemaName: 'context_report', maxTurns: config.agent.collectorMaxTurns,
            });
            if (HARD_STOP.has(collected.status)) return stop(collected, 'сбор контекста');
            if (collected.status === 'completed' && collected.data) {
                const text = renderFindings(collected.data);
                ctx.set('findings', 'Collected context (by the collector)', text, { priority: 6 });
                await writeFile(path.join(root, '.tmp', work.id, 'findings.md'), text, 'utf8').catch(() => {});
            } else notify({ type: 'warning', message: `Сбор контекста не завершён (${collected.status}${collected.error ? `: ${errorMessage(collected.error)}` : ''}); продолжаем без него.` });
            notify({ type: 'stage.done', stage: 'collect', status: collected.status });
        }

        // 3. Worker: one conversation, one step at a time, starting at the saved cursor.
        notify({ type: 'stage.start', stage: 'work', role: 'worker', model: roles.resolve('worker').model });
        progress.stage = 'work';
        let workIncomplete = false;
        let revisionUsed = false;
        const revisionAt = String(revision ?? '').trim() ? progress.cursor : -1;
        const revisionOnly = revisionAt >= 0 && progress.cursor >= plan.steps.length;
        /**
         * Run one plan step. A file step is two turns: the public surface, then the bodies.
         * @param {number} index
         * @returns {Promise<{ outcome: object, report: string, files: string[] }>}
         */
        const runStep = async (index) => {
            const step = plan.steps[index];
            const number = index + 1;
            const allowance = stepAllowance({
                complexity: plan.complexity, kind: step.kind,
                files: step.files?.length ? step.files : pathsIn(`${step.goal}\n${step.details}`),
                goal: step.goal, details: step.details, generation, ceiling: config.agent.workerMaxTurnsPerStep,
            });
            const file = step.files?.[0];
            const title = step.kind === 'compat'
                ? `Compatibility pass (step ${number} of ${plan.steps.length})`
                : `Your step ${number} of ${plan.steps.length}`;
            const prior = progress.steps[index];
            const interrupted = Boolean(prior && prior.status !== 'pending' && prior.status !== 'completed');
            const chosen = authorModel(step.files, step.goal);
            const resumeSession = interrupted && progress.checkpoint?.stepId === step.id && pendingSession?.model === chosen.model;
            const extra = index === revisionAt ? revisionClause(revision) : '';
            if (extra) revisionUsed = true;
            const base = `Goal: ${step.goal}\nDetails: ${step.details}\nVerify: ${step.verify}${extra}`;
            const passes = [];
            if (interrupted) {
                const phase = prior.phase === 'surface' ? 'surface' : 'body';
                passes.push({
                    body: continuationText(step, prior, { resumeSession, revision: index === revisionAt ? revision : '' }),
                    maxTurns: phase === 'surface' ? allowance.surfaceTurns : (allowance.maxTurns ?? allowance.bodyTurns),
                    phase, resume: resumeSession,
                });
                if (phase === 'surface') {
                    passes.push({
                        body: `Fill in ${file} so this step is complete. Keep the public surface already written. Do not edit other files.\n${base}`,
                        maxTurns: allowance.bodyTurns, phase: 'body', resume: false,
                    });
                }
            } else if (allowance.passes === 1) passes.push({ body: base, maxTurns: allowance.maxTurns, phase: 'body', resume: false });
            else {
                if (prior?.phase !== 'body') {
                    passes.push({
                        body: `Write only the public surface of ${file}: exports, signatures, and headings. Leave bodies as short stubs. Do not edit other files.\n${base}`,
                        maxTurns: allowance.surfaceTurns, phase: 'surface', resume: false,
                    });
                }
                passes.push({
                    body: `Fill in ${file} so this step is complete. Keep the public surface already written. Do not edit other files.\n${base}`,
                    maxTurns: allowance.bodyTurns, phase: 'body', resume: false,
                });
            }
            let outcome = null;
            let lastPhase = prior?.phase ?? 'body';
            const reports = [];
            const files = [];
            for (const pass of passes) {
                lastPhase = pass.phase;
                progress.steps[index].phase = pass.phase;
                workerTools.setBackupSlot?.(`${step.id ?? `s${number}`}-${pass.phase}`);
                outcome = await runWorker(title, pass.body, pass.maxTurns, chosen.author, { stepId: step.id, phase: pass.phase, resume: pass.resume });
                result.images.push(...outcome.images);
                reports.push(outcome.text.trim());
                files.push(...takeFiles());
                if (outcome.status !== 'completed') break;
                if (pass.phase === 'surface') {
                    progress.steps[index].phase = 'body';
                    progress.steps[index].report = reports.filter(Boolean).join('\n\n');
                    progress.steps[index].files = [...new Set([...(progress.steps[index].files ?? []), ...files])];
                    work.progress = progress;
                    await persist('running');
                }
            }
            return {
                outcome, phase: lastPhase, files: [...new Set(files)],
                report: reports.filter(Boolean).join('\n\n') || '(отчёт отсутствует)',
            };
        };
        for (let index = progress.cursor; index < plan.steps.length; index++) {
            if (progress.steps[index]?.status === 'completed') continue;
            const step = plan.steps[index];
            const number = index + 1;
            notify({ type: 'step.start', index: number, total: plan.steps.length, goal: step.goal });
            const ran = await runStep(index);
            const update = parsePlanUpdate(ran.report);
            if (update) {
                const applied = applyPlanUpdate(plan, update, { maxSteps: stepLimit, afterId: step.id });
                plan = applied.plan;
                progress = syncProgress(progress, plan);
                progress.notes ??= [];
                if (applied.note) progress.notes.push({ kind: 'plan', note: applied.note });
                work.plan = plan;
                result.plan = plan;
            }
            const recordAt = plan.steps.findIndex((item) => item.id === step.id);
            if (recordAt < 0) {
                workIncomplete = true;
                notify({ type: 'warning', message: `Шаг ${number} пропал из плана после обновления.` });
                break;
            }
            progress = recordStep(progress, { index: recordAt, status: ran.outcome.status, report: ran.report, files: ran.files, phase: ran.phase });
            work.plan = plan;
            work.progress = progress;
            publish();
            await persist();
            index = recordAt;
            result.steps.push({ index: recordAt + 1, goal: step.goal, status: ran.outcome.status, report: ran.report });
            notify({ type: 'step.done', index: recordAt + 1, total: plan.steps.length, status: ran.outcome.status, summary: ran.report });
            if (HARD_STOP.has(ran.outcome.status)) return stop(ran.outcome, `шаг ${number}`);
            if (ran.outcome.status !== 'completed') {
                workIncomplete = true;
                if (generation && ran.outcome.status === 'max_turns') {
                    notify({ type: 'warning', message: `Шаг ${number} упёрся в лимит ходов; следующий шаг всё равно выполняется.` });
                    continue;
                }
                notify({ type: 'warning', message: `Шаг ${number} не завершён (${ran.outcome.status}${ran.outcome.error ? `: ${errorMessage(ran.outcome.error)}` : ''}); дальнейшие шаги пропущены.` });
                break;
            }
        }
            notify({ type: 'stage.done', stage: 'work', status: workIncomplete ? 'incomplete' : 'completed' });
            if (String(revision ?? '').trim() && !revisionUsed) {
                const chosen = authorModel(pathsIn(revision), revision);
                notify({ type: 'step.start', index: plan.steps.length + 1, total: plan.steps.length, goal: 'Доработка' });
                const outcome = await runWorker(
                    'Operator revision',
                    `The plan steps are already complete. Apply this revision to the existing project. Do not repeat finished steps.${revisionClause(revision)}`,
                    config.agent.workerMaxTurnsPerStep,
                    chosen.author,
                    { stepId: 'revision', phase: 'body', resume: false },
                );
                result.images.push(...outcome.images);
                result.steps.push({ index: 'revision', goal: 'Доработка', status: outcome.status, report: outcome.text.trim() });
                progress.notes ??= [];
                progress.notes.push({ kind: 'revision', status: outcome.status, report: outcome.text.trim(), note: String(revision).trim() });
                work.progress = progress;
                await persist(outcome.status === 'completed' ? 'running' : outcome.status);
                notify({ type: 'step.done', index: 'revision', total: plan.steps.length, status: outcome.status, summary: outcome.text.trim() });
                if (HARD_STOP.has(outcome.status)) return stop(outcome, 'доработка');
                if (outcome.status !== 'completed') workIncomplete = true;
                revisionUsed = true;
            }

        // 4. Review and fix rounds.
        const shouldReview = plan.needsReview && plan.complexity !== 'trivial' && config.agent.maxReviewRounds > 0 && !workIncomplete && !revisionOnly;
        let review = null;
        if (shouldReview) {
            progress.stage = 'review';
            work.progress = progress;
            await persist('running');
        }
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
            const fixed = await runWorker(`Review round ${round}: changes requested`, `${review.summary}\n${issues}\n\nAddress every issue, verify, and report what you changed.`, config.agent.workerMaxTurnsPerStep, plan.steps.some((step) => authorFor(step.files, step.goal) === 'coder') ? 'coder' : plan.steps.some((step) => authorFor(step.files, step.goal) === 'writer') ? 'writer' : 'worker');
            result.images.push(...fixed.images);
            result.steps.push({ index: `fix-${round}`, goal: 'Устранение замечаний ревью', status: fixed.status, report: fixed.text.trim() });
            progress.notes ??= [];
            progress.notes.push({ kind: 'fix', round, status: fixed.status, report: fixed.text.trim() });
            work.progress = progress;
            publish();
            await persist();
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
        if (work) {
            work.progress.status = result.status;
            if (!workIncomplete && (result.status === 'completed' || result.status === 'revise')) work.progress.stage = 'done';
            await persist();
        }
        return finish();
    } catch (error) {
        result.status = isAbortError(error) || signal?.aborted || error instanceof CancelledError ? 'cancelled' : 'failed';
        result.error = error;
        await persist(result.status);
        return finish();
    } finally {
        await mcp.close();
    }
}
