/**
 * @file src/agent/team.js
 * @module agent/team
 * @purpose Run planner, architect, measurer, image processor, orchestrator, worker, reviewer, and summarizer over one shared context.
 * @depends node:path, node:fs/promises, core/session, core/context, core/memory, openai/errors, util/text, commands/instructions, roles/index, agent/tools, agent/desktop, agent/fs-tools, agent/diff, agent/roles, agent/loop, agent/schemas, agent/map, agent/task-map, agent/team-text, agent/workspace-scan, agent/work-plan, agent/handoff, agent/quality, agent/pipeline, mcp/session, channels/decide, channels/questions, channels/verdict
 * @usedBy commands/run, index.js
 * @exports toolNamesForRole, runTeam
 * @ai.tags team, roles
 * @ai.hint keep
 * @changed 2026-10-27 The decorator stage builds the decorative layer before the page markup.
 * @changed 2026-10-28 The iconifier conditionally integrates icons after changed page markup.
 * @changed 2026-10-26 Stages run from a data-driven pipeline; the plan and the config choose the order.
 */

import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createSession, loadSession } from '../core/session.js';
import { createSharedContext } from '../core/context.js';
import { renderMemories } from '../core/memory.js';
import { discoverAgents } from '../core/agents-md.js';
import { isAbortError, CancelledError, BudgetError } from '../openai/errors.js';
import { clipMiddle, errorMessage } from '../util/text.js';
import { ROLE_INSTRUCTIONS } from '../commands/instructions.js';
import { EXECUTORS, executorSpec, executorToolNames, executorNames } from './role-registry.js';
import { isCodingStep } from '../roles/coder.js';
import { isStylingStep } from '../roles/styler.js';
import { isWritingStep } from '../roles/writer.js';
import { createToolset, enabledToolNames, READ_ONLY_TOOLS } from './tools.js';
import { createSubagentRunner } from './subagents.js';
import { DESKTOP_TOOL_NAMES } from './desktop.js';
import { listFiles } from './fs-tools.js';
import { describeChangeSet } from './diff.js';
import { createRoleRunner } from './roles.js';
import { builtinTools } from './loop.js';
import { imageTransport } from '../openai/images.js';
import { planLimit, stepAllowance } from './step-budget.js';
import { PLAN_SCHEMA, ARCHITECT_SCHEMA, IMAGE_PROCESSOR_SCHEMA, DECORATOR_SCHEMA, COLLECTOR_SCHEMA, REVIEW_SCHEMA, COORDINATION_SCHEMA, MEMORY_SCHEMA, BATCH_SCHEMA, CLASSIFIER_SCHEMA, EXTRACT_SCHEMA, DECOMPOSER_SCHEMA, MEASURER_SCHEMA } from './schemas.js';
import { SUB_REFERENCE_DIR, collectSubReferences, attachSubReferences, decompositionReport } from './decomposition.js';
import { acceptanceParagraph, applyPins, clampModel, guaranteesParagraph, resolvePace, stageEffort, fineQuality, defaultFineQuality } from './pace.js';
import { contextBytes, profileFor } from '../openai/model-profiles.js';
import { ensureProjectMap, loadProjectMap } from './map.js';
import { draftTaskMap, filterTaskMap, formatDraft, formatMarks, formatScan } from './task-map.js';
import { formatWorkspace, mergeTaskDraft, scanWorkspace } from './workspace-scan.js';
import { SHELL_TOOL_NAMES, IMAGE_TOOL_NAMES } from './tool-specs.js';
import { openMcpSources } from '../mcp/session.js';
import { ANSWER_INSTRUCTIONS, chooseRoute, loadHandoff, openHandoff, readDirectory, saveHandoff, seedDirectory, seedTextFile, spillAnswer } from './handoff.js';
import { applyFromStep, applyPlanUpdate, briefPlan, briefProgress, continuationText, createProgress, expandPlan, findResumable, loadWork, newWorkId, parsePlanUpdate, pathsIn, recordStep, revisionClause, saveWork, syncProgress } from './work-plan.js';
import { neutralPlan, neutralProgress, neutralSession } from './neutral.js';
import { CommandBatchError, executeFileCommands, FILE_COMMANDS_SCHEMA } from './file-commands.js';
import { EXTRACT_MAX_BYTES, EXTRACT_MAX_FILES, extractHandoff, hasExtractableArtifacts } from './extract.js';
import { assessQuality, assessmentImages } from './quality.js';
import { stageMeasurementCrops, measurementConclusion } from './measure-crops.js';
import { createPipeline } from './pipeline.js';
import { resolveInside } from './paths.js';

/**
 * Styler for CSS/SCSS, coder for other source files, writer for documents, worker for everything else.
 * @param {string[]} files
 * @param {string} goal
 * @returns {'styler'|'coder'|'writer'|'worker'}
 * @ai.hint pure
 */
function authorFor(files, goal) {
    if (isStylingStep(files, goal)) return 'styler';
    if (isCodingStep(files, goal)) return 'coder';
    if (isWritingStep(files, goal)) return 'writer';
    return 'worker';
}
import { fileInstructions } from '../roles/encoder.js';
import { requestDecision } from '../channels/decide.js';
import { questionsFor } from '../channels/questions.js';
import { routeFlag } from '../channels/verdict.js';
import { safeReviewerModel } from '../roles/reviewer.js';

import { bullets, renderArchitecture, renderDecorations, renderFindings, renderMeasurements } from './team-text.js';
const HARD_STOP = new Set(['cancelled', 'budget', 'failed']);
const MARKUP_EXTENSIONS = /\.(?:html?|jsx|tsx|vue|svelte|astro)$/i;
const JS_EXTENSIONS = /\.(?:js|mjs|cjs|ts|mts|cts)$/i;

/** Whether a changed source file contains page or component markup. */
export function isIconifierMarkup(file, source = '') {
    if (MARKUP_EXTENSIONS.test(String(file ?? ''))) return true;
    if (!JS_EXTENSIONS.test(String(file ?? ''))) return false;
    return /<\/?[A-Za-z][\w:.-]*(?:\s|\/?>)/.test(String(source))
        || /\b(?:ReactDOM|React\.createElement|createElement|createRoot|document\.createElement(?:NS)?)\b/.test(String(source))
        || /\.(?:innerHTML|outerHTML|insertAdjacentHTML)\b/.test(String(source));
}

/**
 * Render the measurement sheet, its deterministic conclusion, and the saved file paths.
 * `runTeam` uses this both after measuring and when a saved run resumes.
 * @param {object} sheet
 * @param {object|null} conclusion
 * @param {string} dir Project-relative work directory such as `.tmp/<id>`.
 * @returns {string}
 * @ai.hint pure
 */
function measurementReport(sheet, conclusion, dir) {
    const counts = conclusion?.counts ?? {};
    const line = conclusion
        ? `Conclusion: ${counts.elements ?? 0} element(s), ${counts.regions ?? 0} region(s), ` +
        `${counts.rules ?? 0} rule(s), ${counts.crops ?? 0} crop(s); overall confidence ${conclusion.confidence ?? 'unknown'}; ` +
        `${counts.lowConfidence ?? 0} low/unknown element(s).`
        : '';
    return [renderMeasurements(sheet), line, `Measurement JSON: ${dir}/measurements.json.`].filter(Boolean).join('\n\n');
}




/**
 * Tools one role may use, cut from the enabled names of the run.
 * The orchestrator and architect stay read-only. Reviewer may run commands and use the desktop.
 * Worker keeps every enabled name. A role that names its own tools (a user-defined role) keeps only those.
 * @param {string[]} allNames
 * @param {string} role
 * @param {{ tools?: string[] | null }} [spec] the `roles.<name>` entry of the configuration
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function toolNamesForRole(allNames, role, spec = null) {
    if (role === 'iconifier') {
        const allowed = new Set(['list_files', 'read_file', 'search_files', 'view_image', 'write_file', 'replace_text', 'fetch_url', 'download_font', 'download_icons', 'generate_svg', 'vectorize_image']);
        return allNames.filter((name) => allowed.has(name) && (!Array.isArray(spec?.tools) || !spec.tools.length || spec.tools.includes(name)));
    }
    if (role === 'styler') {
        const allowed = new Set(EXECUTORS.styler.tools);
        return allNames.filter((name) => allowed.has(name) && (!Array.isArray(spec?.tools) || !spec.tools.length || spec.tools.includes(name)));
    }
    if (Array.isArray(spec?.tools) && spec.tools.length) {
        return allNames.filter((name) => spec.tools.includes(name));
    }
    if (role === 'orchestrator' || role === 'architect' || role === 'collector' || role === 'coordinator') return allNames.filter((name) => READ_ONLY_TOOLS.includes(name));
    if (role === 'reviewer') {
        return allNames.filter((name) => READ_ONLY_TOOLS.includes(name) || SHELL_TOOL_NAMES.includes(name) || DESKTOP_TOOL_NAMES.includes(name) || name === 'run_subagent' || name === 'delegate_role');
    }
    if (role === 'image-processor' || role === 'measurer' || role === 'decomposer' || role === 'decorator') {
        const allowed = new Set(role === 'image-processor'
            ? [...IMAGE_TOOL_NAMES, 'fetch_url']
            : role === 'measurer'
                ? ['view_image', 'crop_image', 'split_image', 'fetch_url']
                : role === 'decomposer'
                    ? ['view_image', 'fetch_url', 'crop_image', 'split_image', 'compare_images', 'generate_image', 'edit_image']
                    : [...READ_ONLY_TOOLS, 'write_file', 'replace_text', 'generate_svg', 'fetch_url']);
        return allNames.filter((name) => allowed.has(name));
    }
    return allNames;
}

/**
 * Multi-role run: planner (senior) → orchestrator (collects context, coordinates after stages)
 * → worker (tool calls, step by step) → reviewer (+ fix rounds) → summarizer (long-term memory).
 *
 * Returns { status, text, plan, review, steps, images, changes, stats, recalled, memoriesSaved, error }.
 * status: completed | revise (review not accepted) | incomplete | cancelled | budget | failed
 */
export async function runTeam({
    client, config, ledger, task, parts = [], root, approvalLevel = 'read', interactive = false, approve, askUser = null,
    memory = null, projectKey = null, projectName = null, backupDir = null, extraInstructions = null, emit = () => { }, signal,
    seedFiles = [], generation = false, revision = '', fromStep = null, resumeId = null, processTool = null, encodeHost = null,
    onMaxTurns = null, referencePaths = [], agentsText = null,
}) {
    const notify = (event) => { try { emit(event); } catch { /* observer */ } };
    const roles = createRoleRunner({ client, config, ledger, emit, signal, root, task });
    const ctx = createSharedContext({ task, root });
    let effectiveAgentsText = agentsText;
    /** Prepend AGENTS.md to role instructions when present. */
    const withAgents = (instructions) => (effectiveAgentsText && instructions) ? `${effectiveAgentsText}\n\n${instructions}` : instructions;
    const maxBytes = config.agent.maxContextBytes;
    let stepLimit = planLimit({ maxSteps: config.agent.maxSteps, generation });
    let encodeRoute = false;
    let paced = null;
    let pacedLabel = 'normal';
    const paceSettings = config.pace ?? { speed: 10, quality: 40, mode: 'auto', models: ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol'] };
    const pins = config.rolePins ?? Object.fromEntries(Object.entries(config.roles ?? {}).flatMap(([name, role]) => (
        typeof role?.model === 'string' && role.model.trim() ? [[name, { model: true, effort: false }]] : []
    )));
    const paceInput = (extra) => ({
        speed: paceSettings.speed, quality: paceSettings.quality, mode: paceSettings.mode, models: paceSettings.models,
        codeQuality: paceSettings.codeQuality, decorQuality: paceSettings.decorQuality, imageQuality: paceSettings.imageQuality,
        measurerQuality: paceSettings.measurerQuality, architectQuality: paceSettings.architectQuality,
        iconifierQuality: paceSettings.iconifierQuality,
        generation, fidelity: generation ? config.generate?.fidelity : null,
        stepCapOverride: config.stepCapPinned ? config.agent.maxSteps : null,
        modelProfiles: config.models ?? null,
        ...extra,
    });
    const adopt = (extra) => {
        paced = applyPins(resolvePace(paceInput(extra)), config.roles ?? {}, pins, config.models ?? null);
        if (extra.label) pacedLabel = extra.label;
        if (paced.ready) stepLimit = planLimit({ maxSteps: paced.stepCap, generation, pace: true });
        return paced;
    };
    /** Role settings for a work size when pace is not driving the run (encode route, verify pass). */
    const legacyChoice = (author, complexity) => {
        const role = roles.resolve(author, complexity);
        return { model: role.model, effort: role.effort };
    };
    const paceChoice = (author, complexity) => {
        const known = complexity === 'trivial' || complexity === 'complex' || complexity === 'normal' ? complexity : 'normal';
        const one = applyPins(resolvePace(paceInput({
            label: pacedLabel,
            steps: [{ complexity: known, author, files: [], goal: '', details: '', verify: '' }],
        })), config.roles ?? {}, pins, config.models ?? null);
        return one.steps?.[0] ?? { model: null, effort: null };
    };
    const result = {
        status: 'failed', text: '', plan: null, architecture: null, decorations: null, review: null, steps: [], images: [], changes: [], stats: null,
        recalled: [], memoriesSaved: [], reviewRounds: 0, error: null
    };

    const toolBase = { root, config, client, ledger, approve, askUser, backupDir, signal, emit, memory, projectKey, projectName, summarizeFile: roles.summarizeFile, scaffoldTask: task, processTool };
    const mcp = await openMcpSources(config, { signal, notify });
    const mcpRead = mcp.extras.filter((extra) => extra.category === 'read');
    const imageApi = imageTransport(config) === 'images';
    const enabled = enabledToolNames(config.tools, { interactive, memory: Boolean(memory), summarize: true, imageApi, unsafeScreenshot: config.desktop?.unsafeScreenshot === true });
    const readNames = toolNamesForRole(enabled, 'orchestrator', config.roles?.orchestrator);
    const reviewerNames = toolNamesForRole(enabled, 'reviewer', config.roles?.reviewer);
    const allNames = toolNamesForRole(enabled, 'worker', config.roles?.worker);
    const vision = (role) => {
        if (config.agent.visionDelegate === 'never') return null;
        if (role === 'worker' || role === 'reviewer') return roles.describeImage;
        return roles.shouldDelegateVision(role) ? roles.describeImage : null;
    };
    const taskMarks = { edit: null };
    const stepState = { complexity: 'normal' };
    let marks = [];
    /**
     * Run one executor on `task` and return its text, status, and JSON.
     * `context` prepends the shared context of this run, so the role does not rediscover what the
     * run already knows; without it the role sees the task alone, like run_subagent.
     */
    async function delegate(role, task, { context = false } = {}) {
        const spec = executorSpec(role, config);
        if (!spec) throw new Error(`delegate_role: неизвестная роль «${role}» (${executorNames(config).join(', ')}).`);
        // Measurement crops are local artifacts, not image generation: keep them available to the measurer.
        const names = executorToolNames(spec, allNames, { nested: true });
        if (role === 'measurer') {
            for (const name of ['crop_image', 'split_image', 'fetch_url']) {
                if (!names.includes(name)) names.push(name);
            }
        }
        // A nested decomposer cuts and restores screens the same way the pipeline stage does.
        if (role === 'decomposer') {
            for (const name of ['view_image', 'crop_image', 'split_image', 'compare_images']) {
                if (!names.includes(name)) names.push(name);
            }
        }
        const allowWrite = role === 'measurer'
            ? ['crop_image', 'split_image']
            : role === 'decomposer'
                ? ['crop_image', 'split_image', 'compare_images', ...names.filter((name) => name === 'generate_image' || name === 'edit_image')]
                : [];
        const toolset = createToolset({
            ...toolBase, names, approvalLevel, allowWrite,
            describeScreen: roles.describeScreen,
        });
        const builtin = role === 'decomposer'
            ? builtinTools(config, { web: config.tools.web })
            : role === 'measurer' && config.tools.web
                ? builtinTools(config, { web: true }).filter((tool) => tool.type === 'web_search')
                : [];
        const known = stepState.complexity === 'trivial' || stepState.complexity === 'complex' ? stepState.complexity : 'normal';
        const tier = role === 'solver' || role === 'measurer' ? roles.resolve(role, known) : null;
        let model = tier?.model ?? null;
        if (!encodeRoute && paced?.ready) {
            model = clampModel(model ?? roles.resolve(role).model, paceSettings.models, paced.ceilingIndex, Boolean(pins[role]?.model));
        }
        const text = context ? `${ctx.render({ maxBytes })}\n\n# Task\n${task}` : task;
        const result = await roles.run(role, {
            text, instructions: withAgents(ROLE_INSTRUCTIONS[role] ?? ''), toolset, maxTurns: role === 'measurer' ? (config.agent.measurerMaxTurns ?? spec.turns) : spec.turns,
            ...(builtin.length ? { builtin } : {}),
            silent: true,
            delegated: task,
            ...(spec.schema === 'batch' ? { schema: BATCH_SCHEMA, schemaName: 'batch' } : {}),
            ...(spec.schema === 'measure' ? { schema: MEASURER_SCHEMA, schemaName: 'measure' } : {}),
            ...(spec.schema === 'decompose' ? { schema: DECOMPOSER_SCHEMA, schemaName: 'decomposition' } : {}),
            ...(spec.schema === 'decorations' ? { schema: DECORATOR_SCHEMA, schemaName: 'decorations' } : {}),
            ...(model ? { model } : {}),
            ...(tier ? { effort: tier.effort } : {}),
        });
        return { output: result.text, summary: role + ' ' + result.status, data: result.data ?? null };
    }
    /** Start one nested agent (a pipeline role on a fresh context) for run_subagent. */
    const subagent = createSubagentRunner({
        config, roles, root, allNames, approvalLevel, toolBase, emit, parentTask: task,
        toolOptions: { describeImage: vision('worker'), describeScreen: roles.describeScreen },
        agentsText: () => effectiveAgentsText,
    });
    // Both delegation tools offer the same role list: the built-in executors plus the user-defined roles.
    const executors = executorNames(config);
    const toolEnums = { delegate_role: { role: executors }, run_subagent: { kind: executors } };
    const workerTools = createToolset({
        ...toolBase, names: allNames, approvalLevel, describeImage: vision('worker'), editPaths: () => taskMarks.edit,
        describeScreen: roles.describeScreen, delegate, subagent, extras: mcp.extras, toolEnums,
    });
    const stylerTools = createToolset({
        ...toolBase, names: toolNamesForRole(enabled, 'styler', config.roles?.styler), approvalLevel,
        editPaths: () => taskMarks.edit,
    });
    const workerToolsFor = (author) => author === 'styler' ? stylerTools : workerTools;
    const workerChanges = () => [...workerTools.stats().changes, ...stylerTools.stats().changes];
    const orchestratorTools = createToolset({ ...toolBase, names: readNames, approvalLevel: 'read', describeImage: vision('orchestrator'), extras: mcpRead });
    const architectTools = createToolset({ ...toolBase, names: readNames, approvalLevel: 'read', describeImage: vision('architect'), extras: mcpRead });
    const reviewerTools = createToolset({
        ...toolBase, names: reviewerNames, approvalLevel, describeImage: vision('reviewer'),
        describeScreen: roles.describeScreen, delegate, subagent, extras: mcpRead, toolEnums,
    });
    const imageProcessorNames = toolNamesForRole(enabled, 'image-processor', config.roles?.['image-processor']);
    const imageProcessorTools = createToolset({ ...toolBase, names: imageProcessorNames, approvalLevel });
    const decoratorNames = toolNamesForRole(enabled, 'decorator', config.roles?.decorator);
    const decoratorTools = createToolset({ ...toolBase, names: decoratorNames, approvalLevel });
    const iconifierNames = toolNamesForRole(enabled, 'iconifier', config.roles?.iconifier);
    const iconifierTools = createToolset({ ...toolBase, names: iconifierNames, approvalLevel });
    const builtin = builtinTools(config, { web: config.tools.web, images: config.tools.images && !imageApi });
    const imageProcessorBuiltin = builtinTools(config, { web: config.tools.web, images: config.tools.images && !imageApi })
        .filter((tool) => tool.type === 'image_generation' || tool.type === 'web_search');
    /** Copy tool stats onto the team result and return it. */
    const fileChanges = [];
    let work = null;
    const allChanges = () => [...fileChanges, ...workerChanges(), ...iconifierTools.stats().changes];
    const takeWorkerChanges = (seen) => {
        const worker = workerTools.stats().changes;
        const styler = stylerTools.stats().changes;
        const changes = [...worker.slice(seen.worker), ...styler.slice(seen.styler)];
        seen.worker = worker.length;
        seen.styler = styler.length;
        return changes;
    };
    const finish = () => {
        result.changes = allChanges();
        result.stats = {
            worker: workerTools.stats(), styler: stylerTools.stats(), architect: architectTools.stats(), orchestrator: orchestratorTools.stats(),
            reviewer: reviewerTools.stats(), 'image-processor': imageProcessorTools.stats(), decorator: decoratorTools.stats(),
            iconifier: iconifierTools.stats(),
        };
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
        if (referencePaths.length) {
            ctx.set('references', 'Reference images (project-relative paths)', referencePaths.map((item) => `- ${item}`).join('\n'), { priority: 9 });
        }
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
        if (config.agents.enabled && !effectiveAgentsText) {
            const agents = await discoverAgents({ cwd: root, home: config.home, config: config.agents }).catch(() => null);
            if (agents?.text) {
                effectiveAgentsText = agents.text;
                notify({ type: 'agents.loaded', files: agents.files.length, source: agents.source });
            }
        }
        if (effectiveAgentsText) {
            ctx.set('agents', 'Project instructions (AGENTS.md)', effectiveAgentsText, { priority: 8 });
        }
        if (!config.agents.enabled && config.memory.notesFile) {
            // Legacy: read notesFile as a single shared-context section only.
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
            notify({ type: 'stage.start', stage: 'scan', role: 'workspace' });
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
        /** Ask the encoder model, or execute the MCP encode host when it is connected. */
        async function encodeHandoff() {
            notify({ type: 'stage.start', stage: 'encode', role: 'encoder', model: roles.resolve('encoder').model });
            if (encodeHost) {
                const workspaceText = ctx.get('workspace') ?? '';
                const artifacts = [];
                for (const item of handoff.artifacts.filter((entry) => !entry.supersededBy)) {
                    let body = item.body;
                    if (typeof body !== 'string') {
                        try { body = await readFile(path.join(root, item.rel), 'utf8'); }
                        catch { body = ''; }
                    }
                    artifacts.push({ id: item.id, body, hintLanguage: item.hintLanguage ?? null, hintPath: item.hintPath ?? null });
                }
                try {
                    const encoded = await encodeHost.encode({
                        root, text: handoff.text, artifacts, workspace: workspaceText, directoryTree,
                    });
                    notify({ type: 'stage.done', stage: 'encode', status: 'completed' });
                    return { ok: true, written: encoded.written };
                } catch (error) {
                    if (error instanceof CancelledError || error?.name === 'AbortError') throw error;
                    notify({ type: 'stage.done', stage: 'encode', status: 'failed' });
                    result.status = 'failed';
                    result.error = error;
                    result.text = handoff.text;
                    await persist('failed');
                    return { ok: false, done: finish() };
                }
            }
            const index = handoff.artifacts.filter((item) => !item.supersededBy).map((item) => `${item.id} ${item.rel} ${item.hintLanguage ?? ''} ${item.hintPath ?? ''}${item.extracted ? ' extracted' : ''}`.trim()).join('\n') || '(none)';
            const workspaceText = ctx.get('workspace');
            const encoded = await roles.run('encoder', {
                text: `${handoff.text}\n\n# Directory tree\n${directoryTree}${workspaceText ? `\n\n# Workspace scan\n${workspaceText}` : ''}\n\n# Artifacts\n${index}`,
                instructions: withAgents(fileInstructions), instructionsOnly: true, schema: FILE_COMMANDS_SCHEMA, schemaName: 'file_commands',
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
        let architecture = null;
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
        /** Confirmed read/edit/scan marks for the worker and the orchestrator. */
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
        const seenChanges = { worker: 0, styler: 0 };
        /** Paths written since the previous worker pass. */
        const takeFiles = () => takeWorkerChanges(seenChanges).map((change) => change.path);
        const orchestratorSettings = config.agent.orchestrator ?? {};
        const orchestratorOn = Boolean(orchestratorSettings.enabled);
        const orchestratorAfter = new Set(Array.isArray(orchestratorSettings.after) ? orchestratorSettings.after : []);
        const orchestratorSeenChanges = { worker: 0, styler: 0 };
        const orchestratorLog = [];
        let orchestratorGuidance = '';
        /**
         * Consult the orchestrator after a stage. Its plan update is applied when configured;
         * its nextStep becomes explicit guidance for the next worker turn. A failed orchestrator
         * is advisory: the run continues on the existing plan.
         * @param {'plan'|'collect'|'work'|'review'|'fix'} stage
         * @param {{ step?: object|null, status?: string, report?: string, review?: object|null }} [input]
         * @returns {Promise<object|null>}
         */
        const orchestrate = async (stage, { step = null, status = '', report = '', review = null } = {}) => {
            if (!orchestratorOn || !orchestratorAfter.has(stage) || !plan || !progress) return null;
            const recent = takeWorkerChanges(orchestratorSeenChanges);
            let diff = '(no file changes since the previous stage)';
            if (recent.length) {
                try { diff = await describeChangeSet({ root, changes: recent, maxBytes: orchestratorSettings.diffMaxBytes ?? 256 * 1024 }); }
                catch (error) { notify({ type: 'warning', message: `Оркестратор: diff не собран (${errorMessage(error)}).` }); }
            }
            ctx.set('recentDiff', 'Recent changes (since the previous stage)', diff, { priority: 8 });
            const role = roles.resolve('orchestrator');
            const sections = [];
            if (step) {
                sections.push(`# Step just finished\nID: ${step.id ?? '(none)'}\nGoal: ${step.goal}\nStatus: ${status || 'unknown'}\nReport:\n${clipMiddle(report || '(empty)', 8000)}`);
            }
            if (review) {
                const issues = (review.issues ?? []).map((issue) => `- [${issue.severity}] ${issue.path ? `${issue.path}: ` : ''}${issue.message} -> ${issue.requestedChange}`).join('\n') || '- (none)';
                sections.push(`# Review just finished\nVerdict: ${review.verdict}\nSummary: ${review.summary}\nIssues:\n${issues}`);
            }
            const rule = stage === 'review' || stage === 'fix'
                ? 'Plan updates are not applied at this stage. Put every concrete change into nextStep.'
                : 'Plan updates returned here are applied to the plan before the next worker turn.';
            const request = [
                ctx.render({ maxBytes: orchestratorSettings.maxContextBytes ?? 4 * 1024 * 1024, exclude: ['tree'] }),
                ...sections,
                `# Orchestration request\nStage: ${stage}\n${rule}`,
            ].filter(Boolean).join('\n\n');
            notify({ type: 'stage.start', stage: 'orchestrate', role: 'orchestrator', model: role.model });
            const reply = await roles.run('orchestrator', {
                text: request, instructions: withAgents(ROLE_INSTRUCTIONS.orchestrator), toolset: orchestratorTools,
                schema: COORDINATION_SCHEMA, schemaName: 'coordination',
                maxTurns: orchestratorSettings.maxTurns ?? 6, model: role.model, effort: role.effort,
            });
            if (reply.status === 'cancelled' || reply.status === 'budget') {
                throw reply.error ?? new CancelledError('Оркестратор остановлен.');
            }
            if (reply.status !== 'completed' || !reply.data) {
                notify({ type: 'warning', message: `Оркестратор не ответил (${reply.status}${reply.error ? `: ${errorMessage(reply.error)}` : ''}); продолжаем по плану.` });
                notify({ type: 'stage.done', stage: 'orchestrate', status: reply.status });
                return null;
            }
            const data = reply.data;
            const summary = String(data.summary ?? '').trim();
            const nextStep = String(data.nextStep ?? '').trim();
            const risks = Array.isArray(data.risks) ? data.risks.filter((item) => typeof item === 'string' && item.trim()) : [];
            orchestratorGuidance = nextStep;
            orchestratorLog.push([`[${stage}] ${summary}`, nextStep ? `Next: ${nextStep}` : '', risks.length ? `Risks: ${risks.join('; ')}` : ''].filter(Boolean).join('\n'));
            progress.notes ??= [];
            progress.notes.push({ kind: 'orchestrator', stage, status: 'completed', report: summary, note: nextStep });
            ctx.set('orchestration', 'Orchestrator notes', clipMiddle(orchestratorLog.join('\n\n'), orchestratorSettings.logMaxBytes ?? 32 * 1024), { priority: 9 });
            notify({ type: 'orchestrator.done', stage, summary, nextStep, risks });
            const update = data.planUpdate ?? {};
            const addSteps = Array.isArray(update.addSteps) ? update.addSteps : [];
            const revise = Array.isArray(update.revise) ? update.revise : [];
            if (orchestratorSettings.applyPlan !== false && stage !== 'review' && stage !== 'fix' && (addSteps.length || revise.length)) {
                const applied = applyPlanUpdate(plan, { note: update.note ?? '', addSteps, revise }, { maxSteps: stepLimit, afterId: step?.id ?? null });
                plan = applied.plan;
                progress = syncProgress(progress, plan);
                if (work) { work.plan = plan; work.progress = progress; }
                result.plan = plan;
                publish();
                await persist();
                notify({ type: 'plan.updated', stage, note: applied.note, steps: plan.steps.length });
            }
            notify({ type: 'stage.done', stage: 'orchestrate', status: 'completed' });
            return { ...data, summary, nextStep, risks };
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
        const authorModel = (files, goal, complexity = plan?.complexity) => {
            const author = authorFor(files, goal);
            const choice = encodeRoute || !paced?.ready ? legacyChoice(author, complexity) : paceChoice(author, complexity);
            const normalizePath = (file) => String(file).replaceAll(String.fromCharCode(92), '/').toLowerCase();
            const targets = [...(Array.isArray(files) ? files : []), ...pathsIn(goal)].map(normalizePath);
            const priorSolScss = author === 'styler' && progress.steps?.some((step) => step.status === 'completed'
                && step.model === 'gpt-6.1-sol'
                && [...(step.files ?? []), ...pathsIn(step.goal)].some((file) => targets.includes(normalizePath(file)) && /\.scss$/i.test(file)));
            const pinned = config.rolePins?.styler?.model === true;
            const model = priorSolScss && !pinned ? 'gpt-6.1-terra' : choice.model ?? roles.resolve(author).model;
            return { author, model, effort: choice.effort ?? null };
        };
        /** Send one worker, coder, or writer turn. A restored session continues the interrupted turn. */
        const runWorker = async (title, body, maxTurns = config.agent.workerMaxTurnsPerStep, author = 'worker', checkpoint = null) => {
            const complexity = checkpoint?.complexity ?? plan?.complexity;
            stepState.complexity = complexity === 'trivial' || complexity === 'complex' || complexity === 'normal' ? complexity : 'normal';
            const choice = encodeRoute || !paced?.ready ? legacyChoice(author, complexity) : paceChoice(author, complexity);
            const model = checkpoint?.model ?? choice.model ?? roles.resolve(author).model;
            const effort = choice.effort ?? null;
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
                text: `${header}\n\n# ${title}\n${body}`, instructions: withAgents(ROLE_INSTRUCTIONS[author]), toolset: workerToolsFor(author), builtin: author === 'styler' ? [] : builtin,
                maxTurns, session: workerSession, imageTarget: config.image.outputDir,
                model, effort, onMaxTurns,
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
        /** Fill lists the planner schema always sends, so a resumed file cannot crash the orchestrator. */
        const lists = (source) => {
            for (const key of ['filesOfInterest', 'searchQueries', 'questionsForCollector', 'acceptanceCriteria', 'risks']) {
                if (!Array.isArray(source[key])) source[key] = [];
            }
            if (!Array.isArray(source.fileActions)) source.fileActions = [];
            if (!Array.isArray(source.taskMap)) source.taskMap = [];
            if (!Array.isArray(source.imageTasks)) source.imageTasks = [];
            if (!Array.isArray(source.decorationTasks)) source.decorationTasks = [];
            const planComplexity = source.complexity === 'trivial' || source.complexity === 'complex' || source.complexity === 'normal' ? source.complexity : 'normal';
            if (Array.isArray(source.steps)) {
                for (const step of source.steps) {
                    if (step.complexity !== 'trivial' && step.complexity !== 'normal' && step.complexity !== 'complex') step.complexity = planComplexity;
                }
            }
            return source;
        };
        /** Fill lists and the design object the architect schema always sends, so a resumed file cannot crash the authors. */
        const architectureLists = (source) => {
            const out = source && typeof source === 'object' ? source : {};
            out.summary = typeof out.summary === 'string' ? out.summary : '';
            for (const key of ['structure', 'stepGuidance', 'questionsForOrchestrator', 'conventions', 'risks']) {
                if (!Array.isArray(out[key])) out[key] = [];
            }
            out.structure = out.structure.filter((item) => item && typeof item.path === 'string' && item.path.trim())
                .map((item) => ({ ...item, dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn : [] }));
            out.stepGuidance = out.stepGuidance.filter((item) => item && typeof item.stepId === 'string' && typeof item.guidance === 'string');
            out.design = out.design && typeof out.design === 'object' ? out.design : {};
            for (const key of ['layout', 'typography', 'color', 'motion', 'assets']) {
                if (typeof out.design[key] !== 'string') out.design[key] = '';
            }
            return out;
        };
        /** Per-step implementation brief from the architect. */
        const architectureAdvice = (step) => {
            const guide = architecture?.stepGuidance?.find((item) => item.stepId === step?.id);
            if (!guide) return '';
            const files = guide.files?.length ? `\nOwn files: ${guide.files.join(', ')}` : '';
            return `\n\nArchitect guidance for this step:\n${guide.guidance}${files}`;
        };
        /** Compact architect brief for the orchestrator's context collection. */
        const architectureBrief = () => {
            if (!architecture) return '';
            const files = (architecture.structure ?? []).map((item) => `- ${item.path} — ${item.purpose}`).join('\n') || '- (none)';
            return `# Architect brief\n${architecture.summary}\nFiles:\n${files}\nQuestions from the architect:\n${bullets(architecture.questionsForOrchestrator ?? [])}`;
        };

        if (resumedWork) {
            handoff = await loadHandoff(root, resumedWork.id);
            bind(lists(resumedWork.plan), resumedWork.progress);
            if (handoff?.text) {
                ctx.set('answer', 'First answer', handoff.text, { priority: 5 });
                ctx.set('artifacts', 'Artifacts', handoff.artifacts.filter((item) => !item.supersededBy).map((item) => `${item.id} ${item.rel} ${item.hintLanguage ?? ''}`.trim()).join('\n') || '(none)', { priority: 8 });
            }
            const findings = await readFile(path.join(root, '.tmp', work.id, 'findings.md'), 'utf8').catch(() => '');
            if (findings.trim()) ctx.set('findings', 'Collected context (by the orchestrator)', findings, { priority: 6 });
            const sheet = await readFile(path.join(root, '.tmp', work.id, 'measurements.json'), 'utf8').catch(() => null);
            if (sheet) {
                try {
                    const parsedSheet = JSON.parse(sheet);
                    ctx.set('metrics', 'Reference measurements (by the measurer)',
                        measurementReport(parsedSheet, measurementConclusion(parsedSheet), `.tmp/${work.id}`), { priority: 8 });
                } catch { /* a damaged sheet is skipped, the run continues on the plan */ }
            }
            const imageReport = await readFile(path.join(root, '.tmp', work.id, 'image-assets.json'), 'utf8').catch(() => '');
            if (imageReport.trim()) ctx.set('imageAssets', 'Prepared images and visual assets', imageReport, { priority: 9 });
            const architectureFile = await readFile(path.join(root, '.tmp', work.id, 'architecture.json'), 'utf8').catch(() => null);
            if (architectureFile) {
                try {
                    architecture = architectureLists(JSON.parse(architectureFile));
                    result.architecture = architecture;
                    ctx.set('architecture', 'Architecture (by the architect)', renderArchitecture(architecture), { priority: 8 });
                } catch { /* a damaged brief is skipped; the architect stage can rebuild it */ }
            }
            const decorationsFile = await readFile(path.join(root, '.tmp', work.id, 'decorations.json'), 'utf8').catch(() => null);
            if (decorationsFile) {
                try {
                    const decorations = JSON.parse(decorationsFile);
                    result.decorations = decorations;
                    ctx.set('decorations', 'Decorative elements (by the decorator)', renderDecorations(decorations, `.tmp/${work.id}`), { priority: 9 });
                } catch { /* a damaged sheet is skipped; the decor stage can rebuild it */ }
            }
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
            const known = plan.complexity === 'trivial' || plan.complexity === 'complex' ? plan.complexity : 'normal';
            adopt({
                label: known,
                steps: (plan.steps ?? []).map((step) => ({
                    complexity: step.complexity, author: authorFor(step.files, step.goal),
                    files: step.files, goal: step.goal, details: step.details, verify: step.verify, kind: step.kind,
                })),
            });
            notify({ type: 'pace', speed: paceSettings.speed, quality: paceSettings.quality, policy: paced.policy, model: paced.ceilingModel });
        }

        // The stage sequence is data: the planner may order it, the config may pin it, and the
        // pipeline runner skips what the plan omits. A stage returns { exit } to end the run.
        let workIncomplete = false;
        let revisionUsed = false;
        let revisionAt = -1;
        let revisionOnly = false;
        let review = null;
        let decisionsAccepted = false;
        const iconifierMarkup = new Set();
        const referenceParts = parts.filter((part) => part?.type === 'input_image');
        const hasFigmaReference = /https?:\/\/(?:www\.)?figma\.com\//i.test(task);
        let decomposition = null;
        // Images the decomposer produced (one clean screen per entry). The measurer gets them as
        // attachments, so it measures flat screens instead of a rotated collage.
        let screenReferences = { files: [], parts: [] };
        /** Read the produced sub-references back and turn the existing ones into attachments. */
        const collectScreenReferences = async (data) => {
            const collected = await collectSubReferences({
                root, workId: work.id, decomposition: data, maxBytes: config.limits.maxImageBytes,
            });
            const attached = collected.files.length
                ? await attachSubReferences({ root, files: collected.files, maxBytes: config.limits.maxImageBytes })
                : { parts: [], warnings: [] };
            screenReferences = { files: collected.files, parts: attached.parts };
            for (const warning of [...collected.warnings, ...attached.warnings]) notify({ type: 'warning', message: warning });
            return screenReferences;
        };
        const stages = [
            {
                id: 'answer',
                run: async () => {
                    if (!resumedWork && config.agent.chain !== false) {
                        handoff = await openHandoff(root);
                        for (const file of seedFiles) {
                            const seeded = await seedTextFile({ root, state: handoff, file, maxBytes: config.limits.maxFileReadBytes });
                            if (!seeded) await seedDirectory({ root, state: handoff, file, depth: 2, mode: 'tree' });
                        }
                        notify({ type: 'stage.start', stage: 'answer', role: 'default', model: roles.resolve('default').model });
                        const answered = await roles.run('default', {
                            text: `${ctx.render({ maxBytes })}\n\n# Task\n${task}${handoff.text ? `\n\n# Attached files\n${handoff.text}` : ''}`,
                            parts, instructions: withAgents(generation
                                ? `${ANSWER_INSTRUCTIONS}\nThis is a generation brief. The planner writes the plan and the worker writes the files. Describe the reference and the requested result; do not repeat the plan, the file tree, or file bodies.`
                                : ANSWER_INSTRUCTIONS),
                            instructionsOnly: true,
                            builtin: config.tools.web ? builtinTools(config, { web: true }) : [],
                        });
                        if (answered.status !== 'completed') return { exit: stop(answered, 'ответ') };
                        const spilled = await spillAnswer(root, handoff, answered.text);
                        let routeChoice = config.agent.route;
                        if (routeChoice === 'decisions') {
                            routeChoice = null;
                            try {
                                const raw = await requestDecision(client, {
                                    model: config.decisions?.model ?? 'gpt-6-luna-decisions',
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
                        notify({ type: 'stage.done', stage: 'answer', status: 'completed', route });
                        const extractMode = config.agent.extract ?? 'auto';
                        if (extractMode !== 'off' && (route === 'encode' || extractMode === 'always') && hasExtractableArtifacts(handoff)) {
                            const extractorPace = paced?.roles?.extractor;
                            const extractor = {
                                model: extractorPace?.model ?? config.roles?.extractor?.model ?? config.roles?.default?.model
                                    ?? paceSettings.models?.[0] ?? roles.resolve('extractor').model,
                                effort: config.roles?.extractor?.effort ?? extractorPace?.effort ?? 'low',
                            };
                            notify({ type: 'stage.start', stage: 'extract', role: 'extractor', model: extractor.model });
                            const extracted = await extractHandoff({
                                root, state: handoff, maxBytes: EXTRACT_MAX_BYTES, maxFiles: EXTRACT_MAX_FILES,
                                run: (text) => roles.run('extractor', {
                                    text, instructions: withAgents(ROLE_INSTRUCTIONS.extractor), instructionsOnly: true,
                                    schema: EXTRACT_SCHEMA, schemaName: 'extraction',
                                    silent: true, model: extractor.model, effort: extractor.effort,
                                }),
                                notify,
                            });
                            notify({
                                type: 'stage.done', stage: 'extract', status: extracted.files.length ? 'completed' : 'skipped',
                                files: extracted.files.map((item) => item.hintPath ?? item.rel), calls: extracted.calls,
                            });
                        }
                        ctx.set('answer', 'First answer', handoff.text, { priority: 5 });
                        ctx.set('artifacts', 'Artifacts', handoff.artifacts.filter((item) => !item.supersededBy).map((item) => `${item.id} ${item.rel}`).join('\n') || '(none)', { priority: 8 });
                        if (route === 'encode') {
                            encodeRoute = true;
                            const encoded = await encodeHandoff();
                            if (!encoded.ok) return { exit: encoded.done };
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
                                    if (HARD_STOP.has(outcome.status)) return { exit: stop(outcome, 'согласование') };
                                    if (outcome.status !== 'completed') {
                                        result.status = 'incomplete';
                                        result.text = handoff.text;
                                        await persist('incomplete');
                                        return { exit: finish() };
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
                            return { exit: finish() };
                        }
                    }
                },
            },
            {
                id: 'classify',
                run: async () => {
                    if (!resumedWork && !encodeRoute) {
                        adopt({ label: null });
                        const classified = await roles.run('classifier', {
                            text: task, instructions: withAgents(ROLE_INSTRUCTIONS.classifier), schema: CLASSIFIER_SCHEMA, schemaName: 'task_label',
                            maxTurns: 1, model: paced.roles.classifier.model, effort: paced.roles.classifier.effort,
                        });
                        if (classified.status === 'cancelled' || classified.status === 'budget') return stop(classified, 'классификация');
                        let label = 'normal';
                        if (classified.status === 'completed' && ['trivial', 'normal', 'complex'].includes(classified.data?.label)) label = classified.data.label;
                        else notify({ type: 'warning', message: 'Метка задачи не распознана, взята normal.' });
                        adopt({ label, task, author: authorFor(pathsIn(task), task) });
                        notify({ type: 'pace', speed: paceSettings.speed, quality: paceSettings.quality, policy: paced.policy, model: paced.ceilingModel });
                        if (paced.policy === 'c') {
                            const step = paced.steps[0];
                            const drafted = lists({
                                summary: task, complexity: label,
                                steps: [{ goal: step.goal || task, details: step.details || 'Complete the task as described.', verify: step.verify || 'Re-read the result.', complexity: step.complexity }],
                                filesOfInterest: [], searchQueries: [], questionsForCollector: [], acceptanceCriteria: [],
                                needsReview: false, imageNotes: null, risks: [], fileActions: [], taskMap: [],
                            });
                            const expanded = lists(expandPlan(drafted, { maxSteps: 1, splitFiles: false }));
                            bind(expanded, createProgress({ id: handoff?.id ?? newWorkId(), task, plan: expanded }));
                            await persist('running');
                            showPlan();
                        }
                    }
                },
            },
            {
                id: 'plan',
                run: async () => {
                    // 1. Planner. A resumed plan is already bound.
                    if (!plan) {
                        notify({ type: 'stage.start', stage: 'plan', role: 'planner', model: paced.roles.planner.model });
                        const planned = await roles.run('planner', {
                            text: `${ctx.render({ maxBytes })}\n\n# Directory tree\n${directoryTree}\n\n${draft}\n\n# Task\n${task}`, parts: handoff ? [] : parts,
                            instructions: withAgents(`${ROLE_INSTRUCTIONS.planner.replace('{maxSteps}', String(stepLimit))}\n\n${[acceptanceParagraph(paced.acceptance), guaranteesParagraph(paced.guarantees)].filter(Boolean).join('\n\n')}`),
                            schema: PLAN_SCHEMA, schemaName: 'plan',
                            model: paced.roles.planner.model, effort: paced.roles.planner.effort,
                            builtin: config.tools.web ? builtinTools(config, { web: true }) : [],
                        });
                        if (planned.status !== 'completed') return { exit: stop(planned, 'план') };
                        const drafted = lists(planned.data);
                        drafted.steps = drafted.steps.slice(0, stepLimit);
                        if (!drafted.steps.length) drafted.steps = [{ goal: task, details: 'Complete the task as described.', verify: 'Re-read the result.', complexity: drafted.complexity === 'trivial' || drafted.complexity === 'complex' || drafted.complexity === 'normal' ? drafted.complexity : 'normal' }];
                        const expanded = lists(expandPlan(drafted, { maxSteps: stepLimit, splitFiles: !generation }));
                        const id = handoff?.id ?? newWorkId();
                        bind(expanded, createProgress({ id, task, plan: expanded }));
                        // The planner may disagree with the classifier. Its own complexity, and each step's
                        // own complexity, now drive the model rung for every step.
                        const planComplexity = plan.complexity === 'trivial' || plan.complexity === 'complex' ? plan.complexity : 'normal';
                        adopt({
                            label: planComplexity,
                            steps: plan.steps.map((step) => ({
                                complexity: step.complexity, author: authorFor(step.files, step.goal),
                                files: step.files, goal: step.goal, details: step.details, verify: step.verify, kind: step.kind,
                            })),
                        });
                        await persist('running');
                        showPlan();
                        notify({ type: 'stage.done', stage: 'plan', status: 'completed' });
                        if (handoff) {
                            for (const action of plan.fileActions) {
                                if (action?.action === 'encode') {
                                    const encoded = await encodeHandoff();
                                    if (!encoded.ok) return { exit: encoded.done };
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
                                    if (!applied.ok) return { exit: applied.done };
                                }
                            }
                            ctx.set('answer', 'First answer', handoff.text, { priority: 5 });
                            ctx.set('artifacts', 'Artifacts', handoff.artifacts.filter((item) => !item.supersededBy).map((item) => `${item.id} ${item.rel} ${item.hintLanguage ?? ''}`.trim()).join('\n') || '(none)', { priority: 8 });
                        }
                    }

                    await orchestrate('plan');
                },
            },
            {
                id: 'decompose',
                run: async () => {
                    const decomposeMode = config.agent.decompose ?? 'auto';
                    if (decomposeMode === 'off') return;
                    if (!(referenceParts.length || hasFigmaReference) && decomposeMode !== 'always') return;
                    const dir = `.tmp/${work.id}`;
                    if (resumedWork) {
                        // A resumed run does not ask the role again; it reads back the screens and the
                        // sub-reference images that are still on disk.
                        const saved = await readFile(path.join(root, dir, 'decomposition.json'), 'utf8')
                            .then((text) => JSON.parse(text)).catch(() => null);
                        if (saved) {
                            decomposition = saved;
                            await collectScreenReferences(saved);
                            ctx.set('decomposition', 'Screen decomposition (before measurement)', decompositionReport(decomposition, screenReferences.files, dir), { priority: 9 });
                        }
                        return;
                    }
                    const subRefMode = config.agent.decomposerSubReferences ?? 'auto';
                    const role = roles.resolve('decomposer', plan.complexity === 'trivial' || plan.complexity === 'complex' ? plan.complexity : 'normal');
                    const model = paced?.ready
                        ? clampModel(role.model, paceSettings.models, paced.ceilingIndex, Boolean(pins.decomposer?.model))
                        : role.model;
                    // Local cuts belong to the decomposer the same way they belong to the measurer;
                    // generation needs the images API and an enabled `tools.images`.
                    const names = [...new Set([
                        ...toolNamesForRole(enabled, 'decomposer', config.roles?.decomposer),
                        'view_image', 'crop_image', 'split_image', 'compare_images',
                    ])];
                    const canGenerate = subRefMode !== 'off' && names.includes('generate_image');
                    // `always` demands pictures: say out loud when the run cannot make them, instead of
                    // quietly returning a names-only decomposition.
                    if (subRefMode === 'always' && !canGenerate) {
                        notify({ type: 'warning', message: 'agent.decomposerSubReferences: always, но генерация изображений недоступна (tools.images или image API) — decomposer ограничится локальными кропами.' });
                    }
                    const autoWrite = ['crop_image', 'split_image', 'compare_images', ...(canGenerate ? ['generate_image', 'edit_image'] : [])];
                    const imageDir = `${dir}/${SUB_REFERENCE_DIR}`;
                    const taskLines = [
                        ...referencePaths.map((source) => `- ${source}`),
                        ...[...task.matchAll(/https?:\/\/[^\s)]+/gi)].map(([source]) => `- ${source}`),
                    ];
                    const subRefBrief = subRefMode === 'off'
                        ? 'Mode: names only. Do not write any image; return the screen list and leave subReference null.'
                        : [
                            `Mode: produce sub-references. Write every image you produce under ${imageDir}/ — that directory is the only place you may write.`,
                            'For each screen either cut it out of the source (crop_image, split_image) or, when the source is a rotated, mirrored, tilted or perspective shot, first restore a flat front view of the whole frame (edit_image with that source as reference, or generate_image with it as reference) and cut the screens from the restored picture.',
                            'Check what you wrote: look at the file with view_image and, when a screen was restored, compare_images the result against the source region. Keep a screen out rather than ship an image that is not it.',
                            'Name each file by its order and screen, e.g. 01-home.png, 02-checkout.png.',
                            canGenerate ? '' : 'Image generation is unavailable in this run: use local crops and splits only and say so in notes.',
                        ].filter(Boolean).join(' ');
                    notify({ type: 'stage.start', stage: 'decompose', role: 'decomposer', model });
                    const result = await roles.run('decomposer', {
                        text: `${ctx.render({ maxBytes, exclude: ['tree'] })}\n\n# Design sources\n${taskLines.join('\n') || '(attached image references)'}\n\n# Output directory\n${imageDir}/\n\n${subRefBrief}\n\n# Task\nIdentify screens and relationships before measurements, then return one clean sub-reference per screen.`,
                        parts: referenceParts, instructions: withAgents(ROLE_INSTRUCTIONS.decomposer),
                        toolset: createToolset({
                            ...toolBase, names, approvalLevel: 'read', allowWrite: autoWrite,
                            extras: mcpRead, describeScreen: roles.describeScreen,
                        }),
                        builtin: builtinTools(config, { web: config.tools.web }).filter((tool) => tool.type === 'mcp' || (config.tools.web && tool.type === 'web_search')),
                        schema: DECOMPOSER_SCHEMA, schemaName: 'decomposition',
                        maxTurns: config.agent.decomposerMaxTurns ?? 12, model,
                        ...(role.effort ? { effort: role.effort } : {}),
                    });
                    if (result.status === 'cancelled' || result.status === 'budget') return { exit: stop(result, 'разбиение экранов') };
                    if (result.data) {
                        decomposition = result.data;
                        await collectScreenReferences(decomposition);
                        ctx.set('decomposition', 'Screen decomposition (before measurement)', decompositionReport(decomposition, screenReferences.files, dir), { priority: 9 });
                        await writeFile(path.join(root, dir, 'decomposition.json'), `${JSON.stringify(decomposition, null, 2)}\n`, 'utf8').catch((error) => {
                            notify({ type: 'warning', message: `Разбиение экранов не сохранено: ${errorMessage(error)}` });
                        });
                        if (screenReferences.files.length) {
                            notify({ type: 'decompose.subreferences', count: screenReferences.files.length, files: screenReferences.files.map((file) => ({ path: file.rel, kind: file.kind, screen: file.screen })) });
                        }
                        progress.notes ??= [];
                        progress.notes.push({
                            kind: 'decomposer', status: 'completed',
                            report: `${decomposition.summary || 'screens'} · sub-references: ${screenReferences.files.length}`,
                        });
                        work.progress = progress;
                        await persist();
                    } else {
                        notify({ type: 'warning', message: `Decomposer не ответил (${result.status}${result.error ? `: ${errorMessage(result.error)}` : ''}); замеры продолжаются.` });
                    }
                    notify({ type: 'stage.done', stage: 'decompose', status: result.status });
                },
            },
            {
                id: 'measure',
                run: async () => {
                    // 2. Measurer: numbers for the references before any style, SVG, or artwork is written.
                    const measureMode = config.agent.measure ?? 'auto';
                    if (measureMode !== 'off' && !resumedWork && (referenceParts.length || hasFigmaReference) && (measureMode === 'always' || plan.complexity !== 'trivial')) {
                        const tier = plan.complexity === 'trivial' || plan.complexity === 'complex' ? plan.complexity : 'normal';
                        const measurerRole = roles.resolve('measurer', tier);
                        const model = encodeRoute || !paced?.ready
                            ? measurerRole.model
                            : clampModel(measurerRole.model, paceSettings.models, paced.ceilingIndex, Boolean(pins.measurer?.model));
                        const baseline = defaultFineQuality(paceSettings.speed, paceSettings.quality);
                        const measureEffort = encodeRoute || !paced?.ready
                            ? measurerRole.effort
                            : stageEffort(measurerRole.effort, baseline, paced.qualities.measurer);
                        const measurePasses = Math.max(1, Math.min(2, config.agent.measurerPasses ?? 1));
                        const measureTurns = Math.max(1, config.agent.measurerMaxTurns ?? 8);
                        // One pass spends the whole turn budget on the overview. A second pass splits it
                        // evenly, so the fragment inspection does not starve the overview.
                        const overviewTurns = measurePasses > 1 ? Math.max(1, Math.ceil(measureTurns / 2)) : measureTurns;
                        const fragmentTurns = Math.max(1, measureTurns - overviewTurns);
                        const measureProfile = profileFor(config.model, config.models);
                        const measureMaxBytes = Math.min(
                            contextBytes(config.agent.measurerMaxContextBytes ?? 'large', measureProfile),
                            contextBytes(config.limits?.maxRequestBytes ?? 'max', measureProfile),
                        );
                        const measureToolsFor = (pass) => {
                            const names = (pass === 1
                                ? ['view_image', 'fetch_url']
                                : ['view_image', 'crop_image', 'split_image', 'fetch_url'])
                                // Local measurement crops are part of the measurer's job even when image generation is off.
                                .filter((name) => enabled.includes(name) || name === 'crop_image' || name === 'split_image');
                            return names.length
                                ? createToolset({
                                    ...toolBase, names, approvalLevel, allowWrite: ['crop_image', 'split_image'],
                                    describeScreen: roles.describeScreen,
                                })
                                : null;
                        };
                        const measureBuiltin = builtinTools(config, { web: config.tools.web })
                            .filter((tool) => tool.type === 'mcp' || (config.tools.web && tool.type === 'web_search'));
                        const measureContext = ctx.render({ maxBytes: measureMaxBytes, exclude: ['tree'] });
                        const measurePlan = `Plan: ${plan.summary}\nSteps:\n${bullets(plan.steps.map((step) => step.goal))}`;
                        // The decomposer's flat screens are attached next to the originals, so the sheet
                        // is built on one screen per image instead of on a rotated collage.
                        const subReferenceBlock = screenReferences.files.length
                            ? '\n\n# Screen sub-references (produced by the decomposer)\n'
                                + `${screenReferences.files.map((file) => `- ${file.rel} (${file.kind}${file.screen ? `, ${file.screen}` : ''})`).join('\n')}\n`
                                + 'Measure these flat screens; the original references stay attached only as context. '
                                + 'Say in notes which sub-reference every region and element was measured from.'
                            : '';
                        /** One measurement pass, with a tool-less report when the turn budget is spent. */
                        const measureRun = async ({ pass, text, maxTurns, session }) => {
                            const result = await roles.run('measurer', {
                                text, parts: [...referenceParts, ...screenReferences.parts], instructions: withAgents(ROLE_INSTRUCTIONS.measurer),
                                toolset: measureToolsFor(pass), builtin: measureBuiltin,
                                schema: MEASURER_SCHEMA, schemaName: 'measure', maxTurns,
                                model, effort: measureEffort, onMaxTurns, session,
                            });
                            if (HARD_STOP.has(result.status)) return result;
                            if (!result.data && ['max_turns', 'incomplete'].includes(result.status)) {
                                notify({ type: 'warning', message: `Лимит ходов замера (проход ${pass}) исчерпан; роль отдаёт лист по уже просмотренному.` });
                                const report = await roles.run('measurer', {
                                    text: 'Turn budget is spent and no more tools are available. Reply with the complete measurement sheet for everything you already looked at. ' +
                                        'Use CSS units in units/css, null for a number you did not read, confidence for every element, and name the unchecked parts in assumptions and notes. JSON only.',
                                    instructions: withAgents(ROLE_INSTRUCTIONS.measurer), schema: MEASURER_SCHEMA, schemaName: 'measure',
                                    maxTurns: 1, model, effort: measureEffort, session,
                                });
                                if (report.data) return report;
                            }
                            return result;
                        };
                        notify({ type: 'stage.start', stage: 'measure', role: 'measurer', model });
                        notify({ type: 'measure.pass', pass: 1, phase: 'overview' });
                        let measured = await measureRun({
                            pass: 1,
                            text: `${measureContext}\n\n# Measurement pass 1 — whole reference\n${measurePlan}\n\n` +
                                'Study the whole reference first: the canvas, the global layout, every element, every reusable region, and the spacing rules. ' +
                                'Do not start from a fragment. Return the complete overview sheet with CSS units, per-item confidence, and explicit assumptions. ' +
                                'The harness cuts fragments from your boxes after this pass.' + subReferenceBlock,
                            maxTurns: overviewTurns,
                            session: createSession({ store: false, model }),
                        });
                        if (HARD_STOP.has(measured.status)) return { exit: stop(measured, 'замеры') };
                        let sheet = measured.data ?? null;
                        let stagedCrops = { crops: [], warnings: [] };
                        if (sheet && measurePasses > 1) {
                            // Cut the overview regions and reusable elements first, then let the measurer inspect
                            // the actual fragments instead of guessing from the full-size picture.
                            const preliminary = await stageMeasurementCrops({
                                root, workId: work.id, sheet, referencePaths, config, signal,
                            });
                            const fragmentList = preliminary.crops.length
                                ? preliminary.crops.map((crop) => {
                                    const box = crop.box ?? {};
                                    return `- ${crop.kind}: ${crop.name} — ${crop.crop} (${box.width ?? '?'}×${box.height ?? '?'} at ${box.x ?? '?'},${box.y ?? '?'})`;
                                }).join('\n')
                                : '(no usable boxes yet; add regions or elements with boxes so the harness can cut fragments)';
                            notify({ type: 'measure.pass', pass: 2, phase: 'fragments' });
                            const detailed = await measureRun({
                                pass: 2,
                                text: `${measureContext}\n\n# Measurement pass 2 — fragments\n${measurePlan}\n\n` +
                                    'The overview sheet and the fragments cut from it are below. Study the whole sheet first, then inspect the fragments. ' +
                                    'Cut more small, reusable fragments with crop_image or split_image where a detail is too small to read. ' +
                                    'Return the complete final sheet, not a delta: keep every region and element, keep its crop path when the box is unchanged, ' +
                                    'and add new fragments for the worker, architect, and image-processor. Use CSS units with explicit conversions, mark every ' +
                                    'inferred value in assumptions, and set confidence per element. Do not replace the global layout with a single fragment.\n\n' +
                                    `# Overview sheet (JSON)\n${JSON.stringify(sheet)}\n\n# Staged fragments\n${fragmentList}${subReferenceBlock}`,
                                maxTurns: fragmentTurns,
                                session: createSession({ store: false, model }),
                            });
                            // A failed fragment pass must not throw away the overview sheet; cancellation and
                            // budget exhaustion still stop the run.
                            if (HARD_STOP.has(detailed.status) && detailed.status !== 'failed') return { exit: stop(detailed, 'замеры') };
                            if (detailed.data) {
                                sheet = detailed.data;
                                measured = detailed;
                            } else if (detailed.status !== 'completed') {
                                notify({ type: 'warning', message: `Второй проход замеров не завершён (${detailed.status}); остаётся лист обзорного прохода.` });
                            }
                            stagedCrops = await stageMeasurementCrops({
                                root, workId: work.id, sheet, referencePaths, config, signal, reuse: preliminary.crops,
                            });
                        } else if (sheet) {
                            stagedCrops = await stageMeasurementCrops({
                                root, workId: work.id, sheet, referencePaths, config, signal,
                            });
                        }
                        if (sheet) {
                            for (const warning of stagedCrops.warnings) notify({ type: 'warning', message: warning });
                            if (stagedCrops.crops.length) notify({ type: 'measure.crops', count: stagedCrops.crops.length, crops: stagedCrops.crops });
                            const conclusion = measurementConclusion(sheet, stagedCrops.crops);
                            const dir = `.tmp/${work.id}`;
                            await writeFile(path.join(root, dir, 'measurements.json'), `${JSON.stringify(sheet)}\n`, 'utf8').catch((error) => {
                                notify({ type: 'warning', message: `Файл замеров measurements.json не сохранён: ${errorMessage(error)}` });
                            });
                            ctx.set('metrics', 'Reference measurements (by the measurer)', measurementReport(sheet, conclusion, dir), { priority: 8 });
                            notify({ type: 'measure.conclusion', ...conclusion.counts, confidence: conclusion.confidence });
                        } else if (measured.status !== 'completed') {
                            notify({ type: 'warning', message: `Замеры референсов не завершены (${measured.status}${measured.error ? `: ${errorMessage(measured.error)}` : ''}); продолжаем без них.` });
                        }
                        notify({ type: 'stage.done', stage: 'measure', status: measured.status });
                    }
                },
            },
            {
                id: 'architect',
                run: async () => {
                    // 2b. Architect and designer: the file/module structure and the per-step brief for the remaining roles.
                    // It runs after the measurements (numbers are the source of truth) and before context collection,
                    // so the orchestrator can answer its questions and every author sees the same structure.
                    const architectureMode = config.agent.architect ?? 'auto';
                    const architectureEarly = !resumedWork || ['plan', 'image-processing'].includes(progress?.stage);
                    if (architectureMode !== 'off' && !architecture && architectureEarly
                        && (architectureMode === 'always' || plan.complexity !== 'trivial')) {
                        const role = roles.resolve('architect');
                        const model = paced?.roles.architect?.model ?? role.model;
                        const effort = paced?.roles.architect?.effort
                            ?? stageEffort(role.effort, defaultFineQuality(paceSettings.speed, paceSettings.quality), fineQuality(paceSettings, 'architectQuality'));
                        const stepsBrief = plan.steps.map((step) => `${step.id ?? '(no id)'}: ${step.goal}\n  details: ${step.details || '(none)'}\n  files: ${(step.files ?? []).join(', ') || '(none)'}`).join('\n\n');
                        const references = referencePaths.length ? `\n\n# Reference image paths\n${referencePaths.map((item) => `- ${item}`).join('\n')}` : '';
                        const architectureText = `${ctx.render({ maxBytes, exclude: ['tree'] })}\n\n# Plan steps to design for\n${stepsBrief}${references}`;
                        notify({ type: 'stage.start', stage: 'architect', role: 'architect', model });
                        let architected = await roles.run('architect', {
                            text: architectureText, parts: referenceParts, instructions: withAgents(ROLE_INSTRUCTIONS.architect),
                            toolset: architectTools, schema: ARCHITECT_SCHEMA, schemaName: 'architecture',
                            maxTurns: config.agent.architectMaxTurns ?? 8, model, effort, onMaxTurns,
                        });
                        if (HARD_STOP.has(architected.status)) return { exit: stop(architected, 'архитектура') };
                        // A spent turn budget must not lose the brief: one tool-less pass writes it from what the role already saw.
                        if (!architected.data && ['max_turns', 'incomplete'].includes(architected.status)) {
                            notify({ type: 'warning', message: 'Лимит ходов архитектора исчерпан; роль отдаёт структуру по уже просмотренному.' });
                            const report = await roles.run('architect', {
                                text: 'Turn budget is spent and no more tools are available. Reply with the architecture JSON for everything you already saw. ' +
                                    'Name the unchecked parts in risks. JSON only.',
                                instructions: withAgents(ROLE_INSTRUCTIONS.architect), schema: ARCHITECT_SCHEMA, schemaName: 'architecture',
                                maxTurns: 1, model, effort,
                            });
                            if (report.data) architected = report;
                        }
                        if (architected.data) {
                            architecture = architectureLists(architected.data);
                            result.architecture = architecture;
                            ctx.set('architecture', 'Architecture (by the architect)', renderArchitecture(architecture), { priority: 8 });
                            progress.notes ??= [];
                            progress.notes.push({ kind: 'architect', status: 'completed', report: architecture.summary });
                            work.progress = progress;
                            await writeFile(path.join(root, '.tmp', work.id, 'architecture.json'), `${JSON.stringify(architecture, null, 2)}\n`, 'utf8').catch((error) => {
                                notify({ type: 'warning', message: `Структура не сохранена: ${errorMessage(error)}` });
                            });
                            notify({ type: 'stage.done', stage: 'architect', status: 'completed', files: architecture.structure.map((item) => item.path), steps: architecture.stepGuidance.length });
                        } else {
                            notify({ type: 'warning', message: `Архитектор не ответил (${architected.status}${architected.error ? `: ${errorMessage(architected.error)}` : ''}); продолжаем по плану.` });
                            notify({ type: 'stage.done', stage: 'architect', status: architected.status });
                        }
                    }
                },
            },
            {
                id: 'collect',
                run: async () => {
                    // 2. Context collection by the orchestrator (read-only). Skipped when this run already moved past it.
                    const wantsContext = plan.complexity !== 'trivial' && (
                        plan.filesOfInterest.length || plan.searchQueries.length || plan.questionsForCollector.length
                        || marks.some((item) => item.role === 'read' || item.role === 'edit')
                    );
                    const pastCollect = Boolean(resumedWork) && (
                        progress.cursor > 0 || Boolean(ctx.get('findings')) || ['image-processing', 'work', 'review', 'fix', 'done'].includes(progress.stage)
                    );
                    if (!pastCollect && paced?.collect !== 'off' && wantsContext && readNames.length) {
                        notify({ type: 'stage.start', stage: 'collect', role: 'orchestrator', model: paced.roles.orchestrator.model });
                        const focus = marks.filter((item) => item.role === 'read' || item.role === 'edit').map((item) => `${item.role} ${item.path} — ${item.reason}`);
                        const brief = [
                            `# Orchestrator brief (collect context)\nTask map (read/edit):\n${bullets(focus)}\nFiles of interest:\n${bullets(plan.filesOfInterest)}\nSearch queries:\n${bullets(plan.searchQueries)}\nQuestions to answer:\n${bullets(plan.questionsForCollector)}`,
                            architectureBrief(),
                        ].filter(Boolean).join('\n\n');
                        const collected = await roles.run('orchestrator', {
                            text: `${ctx.render({ maxBytes })}\n\n${brief}`, instructions: withAgents(ROLE_INSTRUCTIONS.orchestrator), toolset: orchestratorTools,
                            schema: COLLECTOR_SCHEMA, schemaName: 'context_report', maxTurns: config.agent.orchestratorMaxTurns,
                            model: paced.roles.orchestrator.model, effort: paced.roles.orchestrator.effort,
                        });
                        if (HARD_STOP.has(collected.status)) return { exit: stop(collected, 'сбор контекста') };
                        if (collected.status === 'completed' && collected.data) {
                            const text = renderFindings(collected.data);
                            ctx.set('findings', 'Collected context (by the orchestrator)', text, { priority: 6 });
                            await writeFile(path.join(root, '.tmp', work.id, 'findings.md'), text, 'utf8').catch(() => { });
                        } else notify({ type: 'warning', message: `Сбор контекста не завершён (${collected.status}${collected.error ? `: ${errorMessage(collected.error)}` : ''}); продолжаем без него.` });
                        notify({ type: 'stage.done', stage: 'collect', status: collected.status });
                    }

                    await orchestrate('collect');
                },
            },
            {
                id: 'images',
                run: async () => {
                    // 3. Prepare requested visual assets once, before implementation starts.
                    const imageTasks = plan.imageTasks.filter((item) => item && typeof item.goal === 'string' && item.goal.trim());
                    if (imageTasks.length) {
                        const previous = progress.imageProcessing;
                        if (previous?.status === 'completed' && previous.report) {
                            ctx.set('imageAssets', 'Prepared images and visual assets', previous.report, { priority: 9 });
                            for (const image of previous.images ?? []) result.images.push(path.resolve(root, image));
                        } else {
                            const imageRole = roles.resolve('image-processor');
                            const model = imageRole.model;
                            const imageEffort = paced?.ready
                                ? stageEffort(imageRole.effort, defaultFineQuality(paceSettings.speed, paceSettings.quality), paced.qualities.image)
                                : imageRole.effort;
                            progress.stage = 'image-processing';
                            progress.imageProcessing = { status: 'running', report: '', images: [] };
                            work.progress = progress;
                            await persist('running');
                            notify({ type: 'stage.start', stage: 'image-processing', role: 'image-processor', model });
                            const tasks = imageTasks.map((item, index) => `${index + 1}. ${item.goal}\n   ${item.details}`).join('\n');
                            const refs = referencePaths.length ? referencePaths.map((item) => `- ${item}`).join('\n') : '(none)';
                            const imageParts = parts.filter((part) => part?.type === 'input_image');
                            const processed = await roles.run('image-processor', {
                                text: `${ctx.render({ maxBytes })}\n\n# Image preparation tasks\n${tasks}\n\n# Reference image paths\n${refs}`,
                                parts: imageParts, instructions: withAgents(ROLE_INSTRUCTIONS['image-processor']),
                                toolset: imageProcessorTools, builtin: imageProcessorBuiltin,
                                schema: IMAGE_PROCESSOR_SCHEMA, schemaName: 'image_assets',
                                maxTurns: config.agent.workerMaxTurnsPerStep, imageTarget: path.join(root, 'assets'),
                                effort: imageEffort,
                            });
                            if (processed.status !== 'completed' || !processed.data) {
                                notify({ type: 'stage.done', stage: 'image-processing', status: processed.status });
                                return { exit: stop(processed, 'подготовка изображений') };
                            }
                            const assets = Array.isArray(processed.data.assets)
                                ? processed.data.assets.filter((asset) => asset && typeof asset.path === 'string' && asset.path.trim())
                                : [];
                            const typography = Array.isArray(processed.data.typography) ? processed.data.typography : [];
                            for (const font of typography) {
                                if (font.localPath && !assets.some((asset) => asset.path === font.localPath)) {
                                    assets.push({ path: font.localPath, format: path.extname(font.localPath).slice(1).toLowerCase() || 'font', use: `${font.role || 'text'} font: ${font.family || font.cssFamily}` });
                                }
                            }
                            const generated = (processed.images ?? []).map((file) => path.relative(root, file).split(path.sep).join('/'));
                            for (const rel of generated) {
                                if (!assets.some((asset) => asset.path === rel)) {
                                    assets.push({ path: rel, format: path.extname(rel).slice(1).toLowerCase() || 'image', use: 'Generated for the implementation from the image preparation plan.' });
                                }
                                result.images.push(path.resolve(root, rel));
                            }
                            const report = [
                                `Summary: ${String(processed.data.summary ?? '').trim() || '(none)'}`,
                                `Assets:\n${assets.length ? assets.map((asset) => `- ${asset.path} (${asset.format || 'unknown'}): ${asset.use || 'Prepared for implementation.'}`).join('\n') : '- (none)'}`,
                                ...(typography.length ? [`Typography recommendations:\n${typography.map((font) => `- ${font.role}: ${font.family} — CSS: ${font.cssFamily}; weights: ${font.weights.join(', ') || '(not specified)'}; ${font.rationale} Source: ${font.source}${font.cssUrl ? `; stylesheet: ${font.cssUrl}` : ''}${font.localPath ? `; local file: ${font.localPath}` : font.cssUrl ? '; load this verified stylesheet unless the project specifies another delivery method.' : '; use the existing project-provided font setup.'}`).join('\n')}`] : []),
                                ...(Array.isArray(processed.data.notes) && processed.data.notes.length ? [`Notes:\n${processed.data.notes.map((note) => `- ${note}`).join('\n')}`] : []),
                            ].join('\n\n');
                            progress.imageProcessing = { status: 'completed', report, assets, images: generated };
                            ctx.set('imageAssets', 'Prepared images and visual assets', report, { priority: 9 });
                            await writeFile(path.join(root, '.tmp', work.id, 'image-assets.json'), `${report}\n`, 'utf8').catch((error) => {
                                notify({ type: 'warning', message: `Отчёт об изображениях не сохранён: ${errorMessage(error)}` });
                            });
                            work.progress = progress;
                            publish();
                            await persist('running');
                            notify({ type: 'stage.done', stage: 'image-processing', status: 'completed', assets: assets.map((asset) => asset.path) });
                        }
                    }
                },
            },
            {
                id: 'decor',
                run: async () => {
                    // 3b. Decorator: complex decorative elements as HTML+CSS or standalone SVG, before the page markup.
                    const decorationMode = config.agent.decorations ?? 'auto';
                    const decorationTasks = (plan.decorationTasks ?? []).filter((item) => item && typeof item.goal === 'string' && item.goal.trim());
                    if (decorationMode === 'off' || (!decorationTasks.length && decorationMode !== 'always')) return;
                    const previous = progress.decorations;
                    if (previous?.status === 'completed' && previous.report) {
                        ctx.set('decorations', 'Decorative elements (by the decorator)', previous.report, { priority: 9 });
                        return;
                    }
                    const known = plan.complexity === 'trivial' || plan.complexity === 'complex' ? plan.complexity : 'normal';
                    const decoratorRole = roles.resolve('decorator', known);
                    const model = encodeRoute || !paced?.ready
                        ? decoratorRole.model
                        : clampModel(decoratorRole.model, paceSettings.models, paced.ceilingIndex, Boolean(pins.decorator?.model));
                    const decorBaselineEffort = roles.resolve('decorator').effort;
                    const decorEffort = encodeRoute || !paced?.ready
                        ? decorBaselineEffort
                        : stageEffort(decorBaselineEffort, defaultFineQuality(paceSettings.speed, paceSettings.quality), paced.qualities.decor);
                    progress.stage = 'decor';
                    progress.decorations = { status: 'running', report: '', files: [] };
                    work.progress = progress;
                    await persist('running');
                    notify({ type: 'stage.start', stage: 'decor', role: 'decorator', model });
                    const tasks = decorationTasks.length
                        ? decorationTasks.map((item, index) => `${index + 1}. ${item.goal}\n   ${item.details || ''}`).join('\n')
                        : 'The plan does not list decoration tasks. Read the plan and the architecture brief and build the complex decorative elements the page needs.';
                    const refs = referencePaths.length ? referencePaths.map((item) => `- ${item}`).join('\n') : '(none)';
                    const decorated = await roles.run('decorator', {
                        text: `${ctx.render({ maxBytes })}\n\n# Decoration tasks\n${tasks}\n\n# Reference image paths\n${refs}`,
                        parts: parts.filter((part) => part?.type === 'input_image'),
                        instructions: withAgents(ROLE_INSTRUCTIONS.decorator),
                        toolset: decoratorTools, schema: DECORATOR_SCHEMA, schemaName: 'decorations',
                        maxTurns: config.agent.decoratorMaxTurns ?? 12, effort: decorEffort,
                    });
                    if (HARD_STOP.has(decorated.status)) return { exit: stop(decorated, 'декоративные элементы') };
                    if (!decorated.data) {
                        notify({ type: 'warning', message: `Декоратор не ответил (${decorated.status}${decorated.error ? `: ${errorMessage(decorated.error)}` : ''}); продолжаем без готовых декораций.` });
                        notify({ type: 'stage.done', stage: 'decor', status: decorated.status });
                        return;
                    }
                    const items = Array.isArray(decorated.data.items) ? decorated.data.items : [];
                    const files = items.flatMap((item) => Array.isArray(item.files) ? item.files : []);
                    const report = renderDecorations(decorated.data, `.tmp/${work.id}`);
                    result.decorations = decorated.data;
                    progress.decorations = { status: 'completed', report, files };
                    ctx.set('decorations', 'Decorative elements (by the decorator)', report, { priority: 9 });
                    await writeFile(path.join(root, '.tmp', work.id, 'decorations.json'), `${JSON.stringify(decorated.data, null, 2)}\n`, 'utf8').catch((error) => {
                        notify({ type: 'warning', message: `Лист декораций не сохранён: ${errorMessage(error)}` });
                    });
                    work.progress = progress;
                    publish();
                    await persist('running');
                    notify({ type: 'stage.done', stage: 'decor', status: 'completed', items: items.length, files });
                },
            },
            {
                id: 'work',
                run: async () => {
                    // 4. Worker: one conversation, one step at a time, starting at the saved cursor.
                    notify({ type: 'stage.start', stage: 'work', role: 'worker', model: roles.resolve('worker').model });
                    progress.stage = 'work';
                    workIncomplete = false;
                    revisionUsed = false;
                    revisionAt = String(revision ?? '').trim() ? progress.cursor : -1;
                    revisionOnly = revisionAt >= 0 && progress.cursor >= plan.steps.length;
                    /**
                     * Run one plan step. A file step is two turns: the public surface, then the bodies.
                     * @param {number} index
                     * @returns {Promise<{ outcome: object, report: string, files: string[] }>}
                     */
                    const runStep = async (index) => {
                        const step = plan.steps[index];
                        const number = index + 1;
                        const stepComplexity = step.complexity === 'trivial' || step.complexity === 'complex' ? step.complexity : 'normal';
                        const allowance = stepAllowance({
                            complexity: stepComplexity, kind: step.kind,
                            files: step.files?.length ? step.files : pathsIn(`${step.goal}\n${step.details}`),
                            goal: step.goal, details: step.details, generation, ceiling: config.agent.workerMaxTurnsPerStep,
                        });
                        const file = step.files?.[0];
                        const title = step.kind === 'compat'
                            ? `Compatibility pass (step ${number} of ${plan.steps.length})`
                            : `Your step ${number} of ${plan.steps.length}`;
                        const prior = progress.steps[index];
                        const interrupted = Boolean(prior && prior.status !== 'pending' && prior.status !== 'completed');
                        const chosen = authorModel(step.files, step.goal, step.complexity);
                        const resumeSession = interrupted && progress.checkpoint?.stepId === step.id && pendingSession?.model === chosen.model;
                        const extra = index === revisionAt ? revisionClause(revision) : '';
                        if (extra) revisionUsed = true;
                        const advice = orchestratorGuidance ? `\n\nOrchestrator guidance (from the previous stage):\n${orchestratorGuidance}` : '';
                        const base = `Goal: ${step.goal}\nDetails: ${step.details}\n${chosen.author === 'styler' ? '' : `
Verify: ${step.verify}`}${extra}${advice}${architectureAdvice(step)}${paced?.guarantees === 'broken' ? `\n\n${guaranteesParagraph('broken')}` : ''}`;
                        const passes = [];
                        if (interrupted) {
                            const phase = prior.phase === 'surface' ? 'surface' : 'body';
                            passes.push({
                                body: `${continuationText(step, prior, { resumeSession, revision: index === revisionAt ? revision : '', author: chosen.author })}${architectureAdvice(step)}`,
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
                            workerToolsFor(chosen.author).setBackupSlot?.(`${step.id ?? `s${number}`}-${pass.phase}`);
                            outcome = await runWorker(title, pass.body, pass.maxTurns, chosen.author, { stepId: step.id, phase: pass.phase, resume: pass.resume, complexity: step.complexity, model: chosen.model });
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
                        // A generation step often spends its last turns on the same failing check.
                        // One short pass on the cheapest rung gives verification a fresh budget without
                        // keeping the expensive model for the rest of the plan.
                        if (generation && chosen.author !== 'styler' && outcome?.status === 'max_turns' && files.length > 0) {
                            const verifyTurns = Math.min(8, Math.max(1, config.agent.workerMaxTurnsPerStep));
                            const verifyChoice = encodeRoute || !paced?.ready ? legacyChoice(chosen.author, 'trivial') : paceChoice(chosen.author, 'trivial');
                            notify({ type: 'stage.start', stage: 'verify', role: chosen.author, model: verifyChoice.model ?? roles.resolve(chosen.author).model });
                            const verifyBody = [
                                `Goal: ${step.goal}`,
                                `Verify: ${step.verify || 'Re-read the files and run the project check.'}`,
                                '',
                                `The previous attempt ran out of turns before verification. Files already written: ${files.join(', ')}.`,
                                'Run the verification now. Fix only errors that block it. Do not rewrite files that already work, add features, or start a dev or preview server.',
                                'If the check still fails, report the exact error and what remains unverified.',
                            ].join('\n');
                            const repaired = await runWorker(`${title} — verify`, verifyBody, verifyTurns, chosen.author,
                                { stepId: step.id, phase: 'verify', resume: false, complexity: 'trivial', model: chosen.model });
                            result.images.push(...repaired.images);
                            reports.push(repaired.text.trim());
                            files.push(...takeFiles());
                            progress.notes ??= [];
                            progress.notes.push({ kind: 'verify', status: repaired.status, report: repaired.text.trim(), note: step.verify || '' });
                            notify({ type: 'stage.done', stage: 'verify', status: repaired.status });
                            if (repaired.status === 'completed') {
                                outcome = repaired;
                                lastPhase = 'body';
                            } else if (HARD_STOP.has(repaired.status)) {
                                outcome = repaired;
                            } else {
                                const reason = repaired.error ? `: ${errorMessage(repaired.error)}` : '';
                                notify({ type: 'warning', message: `Проверка шага ${number} не завершена (${repaired.status}${reason}); шаг остаётся незавершённым.` });
                            }
                        }
                        return {
                            outcome, phase: lastPhase, model: chosen.model, files: [...new Set(files)],
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
                        progress = recordStep(progress, { index: recordAt, status: ran.outcome.status, report: ran.report, files: ran.files, phase: ran.phase, model: ran.model });
                        work.plan = plan;
                        work.progress = progress;
                        publish();
                        await persist();
                        index = recordAt;
                        result.steps.push({ index: recordAt + 1, goal: step.goal, status: ran.outcome.status, report: ran.report });
                        notify({ type: 'step.done', index: recordAt + 1, total: plan.steps.length, status: ran.outcome.status, summary: ran.report });
                        if (HARD_STOP.has(ran.outcome.status)) return { exit: stop(ran.outcome, `шаг ${number}`) };
                        await orchestrate('work', { step, status: ran.outcome.status, report: ran.report });
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
                            { stepId: 'revision', phase: 'body', resume: false, model: chosen.model },
                        );
                        result.images.push(...outcome.images);
                        result.steps.push({ index: 'revision', goal: 'Доработка', status: outcome.status, report: outcome.text.trim() });
                        progress.notes ??= [];
                        progress.notes.push({ kind: 'revision', status: outcome.status, report: outcome.text.trim(), note: String(revision).trim() });
                        work.progress = progress;
                        await persist(outcome.status === 'completed' ? 'running' : outcome.status);
                        notify({ type: 'step.done', index: 'revision', total: plan.steps.length, status: outcome.status, summary: outcome.text.trim() });
                        if (HARD_STOP.has(outcome.status)) return { exit: stop(outcome, 'доработка') };
                        if (outcome.status !== 'completed') workIncomplete = true;
                        revisionUsed = true;
                    }
                    const currentChanges = [...workerChanges(), ...fileChanges];
                    const changedFiles = new Set(progress.iconification?.status === 'completed'
                        ? currentChanges.map((item) => item.path)
                        : [...progress.files.map((item) => item.path), ...currentChanges.map((item) => item.path)]);
                    for (const file of changedFiles) {
                        if (!MARKUP_EXTENSIONS.test(file) && !JS_EXTENSIONS.test(file)) continue;
                        try {
                            const { abs, rel } = await resolveInside(root, file, { allowRoot: false });
                            const source = await readFile(abs, 'utf8');
                            if (isIconifierMarkup(rel, source)) iconifierMarkup.add(rel);
                        } catch { /* a removed or unreadable file is not iconifier input */ }
                    }
                },
            },
            {
                id: 'iconify',
                when: () => iconifierMarkup.size > 0,
                run: async () => {
                    const paths = [...iconifierMarkup];
                    const role = roles.resolve('iconifier');
                    const model = role.model;
                    const effort = paced?.ready
                        ? stageEffort(role.effort, defaultFineQuality(paceSettings.speed, paceSettings.quality), paced.qualities.iconifier)
                        : role.effort;
                    progress.stage = 'iconify';
                    progress.iconification = { status: 'running', files: paths, report: '' };
                    work.progress = progress;
                    await persist('running');
                    notify({ type: 'stage.start', stage: 'iconify', role: 'iconifier', model });
                    const web = config.tools.web ? builtinTools(config, { web: true }).filter((tool) => tool.type === 'web_search') : [];
                    const iconified = await roles.run('iconifier', {
                        text: `${ctx.render({ maxBytes })}\n\n# Changed markup files\n${paths.map((file) => `- ${file}`).join('\n')}\n\nInspect these files and integrate suitable icons only where the page needs them.`,
                        instructions: withAgents(ROLE_INSTRUCTIONS.iconifier), toolset: iconifierTools,
                        builtin: web, maxTurns: 12, model, effort, silent: true,
                    });
                    if (HARD_STOP.has(iconified.status)) return { exit: stop(iconified, 'иконки') };
                    const report = iconified.text.trim() || '(отчёт отсутствует)';
                    const changes = iconifierTools.stats().changes;
                    for (const change of changes) {
                        if (!progress.files.some((item) => item.path === change.path)) progress.files.push({ path: change.path, stepId: null });
                    }
                    progress.iconification = { status: iconified.status === 'completed' ? 'completed' : 'incomplete', files: paths, report };
                    progress.notes ??= [];
                    progress.notes.push({ kind: 'iconify', status: iconified.status, report });
                    work.progress = progress;
                    publish();
                    await persist('running');
                    if (iconified.status !== 'completed') notify({ type: 'warning', message: `Подбор иконок не завершён (${iconified.status}${iconified.error ? `: ${errorMessage(iconified.error)}` : ''}); продолжаем без дальнейшей обработки разметки.` });
                    notify({ type: 'stage.done', stage: 'iconify', status: iconified.status, files: paths, changes: changes.map((change) => change.path) });
                },
            },
            {
                id: 'review',
                run: async () => {
                    // 4. Review and fix rounds.
                    const shouldReview = paced?.reviewMode === 'force'
                        ? paced.reviewRounds > 0 && !workIncomplete && !revisionOnly
                        : paced?.reviewMode === 'plan'
                            ? Boolean(plan.needsReview) && plan.complexity !== 'trivial' && paced.reviewRounds > 0 && !workIncomplete && !revisionOnly
                            : false;
                    if (shouldReview) {
                        progress.stage = 'review';
                        work.progress = progress;
                        await persist('running');
                        // One decisions call can accept the result and skip the reviewer's tool loop.
                        const assessed = await assessQuality({
                            client, config, ledger, signal, notify,
                            state: {
                                task,
                                acceptance: plan.acceptanceCriteria,
                                plan: plan.summary,
                                steps: result.steps.map((step) => ({
                                    index: step.index, goal: step.goal, status: step.status,
                                    report: clipMiddle(step.report ?? '', 4000),
                                })),
                                changes: allChanges().map((change) => change.path),
                                commands: [...workerTools.stats().commands, ...stylerTools.stats().commands].map((command) => ({ command: command.command, exitCode: command.exitCode ?? null })),
                                tree: directoryTree,
                            },
                            images: await assessmentImages({ root, parts, produced: result.images }),
                        });
                        if (assessed) {
                            notify({
                                type: 'decision.review', verdict: assessed.verdict, summary: assessed.summary,
                                model: assessed.model, vision: assessed.vision, scores: assessed.scores,
                            });
                            if (assessed.verdict === 'accept') {
                                decisionsAccepted = true;
                                review = { verdict: 'accept', summary: assessed.summary, issues: [], unverified: [] };
                                result.review = review;
                                result.reviewRounds = 0;
                                notify({ type: 'review.done', round: 0, verdict: 'accept', summary: assessed.summary, issues: [], unverified: [], source: 'decisions' });
                                notify({ type: 'stage.done', stage: 'review', status: 'accept' });
                            }
                        }
                    }
                    for (let round = 1; shouldReview && !decisionsAccepted; round++) {
                        notify({ type: 'stage.start', stage: 'review', role: 'reviewer', model: safeReviewerModel(paced.roles.reviewer.model), round });
                        ctx.set('diff', 'Changes made by the worker (diff)', await describeChangeSet({ root, changes: allChanges(), maxBytes: 48 * 1024 }), { priority: 5 });
                        const commands = workerTools.stats().commands.map((c) => `- ${c.command} → exit ${c.exitCode ?? '?'}`).join('\n') || '- (none)';
                        const reviewed = await roles.run('reviewer', {
                            text: `${ctx.render({ maxBytes })}\n\n# Review request (round ${round})\nAcceptance criteria:\n${bullets(plan.acceptanceCriteria)}\nCommands run by the worker:\n${commands}`,
                            instructions: `${withAgents(ROLE_INSTRUCTIONS.reviewer)}\n\n${[acceptanceParagraph(paced.acceptance), guaranteesParagraph(paced.guarantees)].filter(Boolean).join('\n\n')}`, toolset: reviewerTools, schema: REVIEW_SCHEMA, schemaName: 'review', maxTurns: config.agent.reviewerMaxTurns,
                            model: safeReviewerModel(paced.roles.reviewer.model), effort: paced.roles.reviewer.effort, onMaxTurns,
                        });
                        if (HARD_STOP.has(reviewed.status)) return { exit: stop(reviewed, 'ревью') };
                        if (reviewed.status !== 'completed' || !reviewed.data) {
                            notify({ type: 'warning', message: `Ревью не завершено (${reviewed.status}); результат принят без независимой проверки.` });
                            break;
                        }
                        review = reviewed.data;
                        result.review = review;
                        result.reviewRounds = round;
                        notify({ type: 'review.done', round, verdict: review.verdict, summary: review.summary, issues: review.issues, unverified: review.unverified });
                        notify({ type: 'stage.done', stage: 'review', status: review.verdict });
                        const reviewAdvice = await orchestrate('review', { review, status: review.verdict });
                        if (review.verdict === 'accept' || round >= paced.reviewRounds) break;
                        notify({ type: 'stage.start', stage: 'fix', role: 'worker', model: roles.resolve('worker').model, round });
                        const issues = review.issues.map((i) => `- [${i.severity}] ${i.path ? `${i.path}: ` : ''}${i.message} → ${i.requestedChange}`).join('\n') || '- (see summary)';
                        const fixGuidance = reviewAdvice?.nextStep ? `\n\nOrchestrator guidance:\n${reviewAdvice.nextStep}` : '';
                        const fixed = await runWorker(`Review round ${round}: changes requested`, `${review.summary}\n${issues}${fixGuidance}\n\nAddress every issue, verify, and report what you changed.`, config.agent.workerMaxTurnsPerStep, plan.steps.some((step) => authorFor(step.files, step.goal) === 'coder') ? 'coder' : plan.steps.some((step) => authorFor(step.files, step.goal) === 'writer') ? 'writer' : 'worker', { complexity: [...plan.steps].sort((a, b) => (({ trivial: 0, normal: 1, complex: 2 })[b.complexity] ?? 1) - (({ trivial: 0, normal: 1, complex: 2 })[a.complexity] ?? 1))[0]?.complexity ?? plan.complexity });
                        result.images.push(...fixed.images);
                        result.steps.push({ index: `fix-${round}`, goal: 'Устранение замечаний ревью', status: fixed.status, report: fixed.text.trim() });
                        progress.notes ??= [];
                        progress.notes.push({ kind: 'fix', round, status: fixed.status, report: fixed.text.trim() });
                        work.progress = progress;
                        publish();
                        await persist();
                        notify({ type: 'stage.done', stage: 'fix', status: fixed.status });
                        if (HARD_STOP.has(fixed.status)) return { exit: stop(fixed, 'исправления') };
                        await orchestrate('fix', { status: fixed.status, report: fixed.text.trim(), review });
                    }
                },
            },
            {
                id: 'outcome',
                run: async () => {
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
                },
            },
            {
                id: 'memory',
                run: async () => {
                    // 6. Memory extraction (cheap summarizer role).
                    if (memory) {
                        if (config.memory.autoSave) {
                            notify({ type: 'stage.start', stage: 'memory', role: 'summarizer', model: paced?.roles.summarizer.model ?? roles.resolve('summarizer').model });
                            const extracted = await roles.run('summarizer', {
                                text: `# Task\n${task}\n\n# Plan summary\n${plan.summary}\n\n# Worker reports\n${clipMiddle(ctx.get('progress'), 24 * 1024)}\n\n# Review\n${review ? `${review.verdict}: ${review.summary}` : 'not performed'}` +
                                    `\n\n# Existing memories (do not repeat)\n${renderMemories(result.recalled) || '(none)'}`,
                                instructions: withAgents(ROLE_INSTRUCTIONS.summarizerMemory), schema: MEMORY_SCHEMA, schemaName: 'memory_update',
                                model: paced?.roles.summarizer.model ?? null, effort: paced?.roles.summarizer.effort ?? null,
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
                        memory.recordTask({
                            project: projectKey, projectName, task, status: result.status, summary: result.taskSummary ?? plan.summary,
                            changes: allChanges().map((c) => c.path), usage: ledger.snapshot()
                        });
                    }
                },
            },
        ];
        // A pipeline may start at the plan or skip the classifier; the pace must exist before any stage reads it.
        if (!paced) adopt({ label: pacedLabel });
        const exit = await createPipeline({ stages, config, plan: () => plan, notify }).run();
        if (exit !== undefined) return exit;
        if (work) {
            work.progress.status = result.status;
            if (!workIncomplete && (result.status === 'completed' || result.status === 'revise')) work.progress.stage = 'done';
            await persist();
        }
        return finish();
    } catch (error) {
        result.status = error instanceof BudgetError ? 'budget'
            : isAbortError(error) || signal?.aborted || error instanceof CancelledError ? 'cancelled' : 'failed';
        result.error = error;
        await persist(result.status);
        return finish();
    } finally {
        await mcp.close();
    }
}
