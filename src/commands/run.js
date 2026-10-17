/**
 * @file src/commands/run.js
 * @module commands/run
 * @purpose Run an autonomous task as a role team or as a single tool loop.
 * @depends agent/map, agent/tools, agent/roles, agent/team, agent/workspace-scan, core/config, util/text, commands/instructions, commands/flow, commands/shared, mcp/session, node:path
 * @usedBy cli
 * @exports run, resumeLocal
 * @ai.tags cli, agent, team
 * @ai.hint io
 * @changed 2026-10-16 Prepared scaffold files are written before the model plans.
 */
import path from 'node:path';
import { ensureProjectMap } from '../agent/map.js';
import { createToolset, enabledToolNames } from '../agent/tools.js';
import { builtinTools } from '../agent/loop.js';
import { createRoleRunner } from '../agent/roles.js';
import { runTeam } from '../agent/team.js';
import { resolveRole, ROLE_NAMES } from '../core/config.js';
import { formatBytes, truncate } from '../util/text.js';
import { agentBase } from './instructions.js';
import { runOnce } from './flow.js';
import { UsageError, readStdin, resolveTextArg, loadAttachments, composeInstructions, approvalLevel, backupDirFor, openMemoryFor,
    describeRoles, usageRow, usageBreakdownRows, describeChanges, createClientFor, createLedgerFor, writeOutput, exitCodeFor, STATUS_LABELS } from './shared.js';
import { openMcpSources } from '../mcp/session.js';
import { prepareTeamInvocation } from './team-args.js';
import { findLatestResumable, resolveResumeStep } from '../agent/work-plan.js';
import { imageTransport } from '../openai/images.js';
import { formatWorkspace, scanWorkspace } from '../agent/workspace-scan.js';
import { buildGenerationBrief, writeGenerationManifest } from '../generate/brief.js';
import { preparedScaffoldFiles, writePreparedScaffold } from '../generate/scaffold.js';
import { resolvePlatform } from '../generate/platform.js';
import { stdinFence } from '../core/attachments.js';

const TEAM_STATUS = { ...STATUS_LABELS, revise: 'ревью не приняло результат', incomplete: 'шаги выполнены не полностью' };

/**
 * `ai run <task>` — autonomous agent in the working directory.
 *   team   (default): planner → collector → worker steps → reviewer (+fix rounds) → summarizer/memory,
 *                     each role with its own model (config.roles / --role).
 *   single (--single): one model, one tool loop (plus memory tools).
 * @param {object} ctx Command context from cli.main.
 * @returns {Promise<number>} Exit code from the team or single flow.
 * @exports
 * @ai.hint io
 */
export async function run(ctx) {
    const { config, renderer, values, positionals } = ctx;
    const stdinText = await readStdin({ maxBytes: config.limits.maxStdinBytes, stdin: ctx.stdin ?? process.stdin });
    const prepared = await prepareTeamInvocation({ positionals, values, cwd: ctx.cwd, stdinText: stdinText ?? '' });
    let task = prepared.task;
    const parts = await loadAttachments({ images: values.image ?? [], files: values.file ?? [], detail: values.detail ?? 'auto', cwd: ctx.cwd, config, renderer });
    if (stdinText && task !== stdinText) parts.push({ type: 'input_text', text: stdinFence(stdinText) });

    const interactive = renderer.interactive;
    const level = approvalLevel(config, interactive);
    const store = openMemoryFor(config, ctx.cwd, renderer);
    const mockups = values.image ?? [];
    const toolsChosen = values.tools !== undefined || Boolean(values['no-tools']) || Boolean(values.images);
    if (prepared.wantsProfile && mockups.length && !toolsChosen) config.tools.images = true;
    if (prepared.wantsProfile && mockups.length && config.tools.images && !values.route) config.agent.route = 'planner';
    const imageApi = imageTransport(config) === 'images';
    const names = enabledToolNames(config.tools, { interactive, memory: Boolean(store), summarize: true, imageApi });
    if (!names.length && !config.tools.web && !config.tools.images) {
        throw new UsageError('Все инструменты отключены; для run нужен хотя бы один (fs, shell, fetch, web, images).');
    }
    ctx.backupDir = backupDirFor(config);
    let extra = await resolveTextArg(values.instructions, { cwd: ctx.cwd, what: 'инструкции' });
    if (prepared.wantsProfile) {
        const brief = buildGenerationBrief({
            kind: prepared.kind, prompt: task, fidelity: config.generate.fidelity, creativity: config.generate.creativity,
            platform: resolvePlatform(config.generate.platform),
            references: { images: values.image ?? [], files: values.file ?? [], examples: values.example ?? [] },
            name: path.basename(ctx.cwd),
        });
        await writeGenerationManifest(ctx.cwd, brief.manifest);
        if (level === 'write' || level === 'all') {
            const boilerplate = preparedScaffoldFiles({
                kind: prepared.kind, platform: resolvePlatform(config.generate.platform),
                recommendations: brief.manifest.recommendations, name: path.basename(ctx.cwd),
            });
            const saved = await writePreparedScaffold(ctx.cwd, boilerplate);
            if (saved.written.length) renderer.line('info', `Каркас уже записан: ${saved.written.join(', ')}`, { dim: true });
        }
        renderer.line('info', `Контракт генерации: .ai/generation.json · точность ${brief.manifest.fidelity}% · креативность ${brief.manifest.creativity}%`, { dim: true });
        task = brief.task;
        extra = [brief.instructions, extra].filter(Boolean).join('\n\n');
    }
    if (level === 'read' && !interactive) renderer.line('warn', 'Неинтерактивный режим без --approve write|all: агент сможет только читать файлы.');

    try {
        const ensured = await ensureProjectMap(ctx.cwd);
        if (ensured?.error) renderer.line('warn', `Карта проекта не построена: ${ensured.error.message}`);
        if (config.agent.mode === 'team') return await runTeamFlow(ctx, { task, parts, level, interactive, store, names, extra, seedFiles: prepared.seedFiles, generation: prepared.wantsProfile });
        return await runSingleFlow(ctx, { task, parts, level, interactive, store, names, extra });
    } finally {
        store?.memory.close();
    }
}

/**
 * One model and one tool loop. runOnce prints the summary and returns the exit code.
 * @param {object} ctx Command context. client and ledger are attached before runOnce.
 * @param {{ task: string, parts: object[], level: string, interactive: boolean, store: object|null, names: string[], extra: string|null }} options Task text, attachments, approval level, and tool names.
 * @returns {Promise<number>}
 * @ai.hint io
 */
async function runSingleFlow(ctx, { task, parts, level, interactive, store, names, extra }) {
    const { config, renderer, signal, emit } = ctx;
    const role = resolveRole(config, 'default');
    const client = createClientFor(config);
    const ledger = createLedgerFor(config);
    const roles = createRoleRunner({ client, config, ledger, emit, signal });
    const mcp = await openMcpSources(config, { signal, notify: emit });
    try {
        const toolset = createToolset({
            root: ctx.cwd, config, client, ledger, names, approvalLevel: level, extras: mcp.extras,
            approve: (request) => renderer.approve(request, { signal }), askUser: interactive ? (q) => renderer.ask(q, { signal }) : null,
            backupDir: ctx.backupDir, signal, emit, memory: store?.memory ?? null, projectKey: store?.projectKey ?? null, projectName: store?.projectName ?? null,
            describeImage: roles.shouldDelegateVision('default') ? roles.describeImage : null, summarizeFile: roles.summarizeFile,
            scaffoldTask: task,
        });
        const mcpNote = mcp.describe() ? `\n\nMCP sources:\n${mcp.describe()}` : '';
        const instructions = composeInstructions(agentBase({ root: ctx.cwd, approvalLevel: level, toolNames: toolset.names(), interactive, shell: config.shell ?? null }), config, extra) + mcpNote;
        let prompt = task;
        try {
            const card = await scanWorkspace(ctx.cwd, { task });
            if (card) {
                emit({ type: 'stage.start', stage: 'scan', role: 'scanner' });
                prompt = `${formatWorkspace(card)}\n\n# Task\n${task}`;
                emit({ type: 'stage.done', stage: 'scan', status: 'completed', files: card.files.map((item) => item.path) });
            }
        } catch (error) {
            emit({ type: 'warning', message: `Сканер workspace: ${error.message}` });
        }
        renderer.line('info', `Агент (single): ${role.model}${role.effort ? `:${role.effort}` : ''} · каталог ${ctx.cwd} · доступ: ${level} · инструменты: ${toolset.names().join(', ')}${config.tools.web ? ' + web_search' : ''}${config.tools.images ? ' + image_generation' : ''}${store ? ' · память включена' : ''}`, { dim: true });
        ctx.client = client;
        ctx.ledger = ledger;
        const imageApi = imageTransport(config) === 'images';
        return await runOnce({ ...ctx, config: role.config }, { prompt, parts, instructions, toolset, maxTurns: config.limits.maxTurns, summaryTitle: 'итог задачи',
            builtin: builtinTools(config, { web: config.tools.web, images: config.tools.images && !imageApi }),
            extraRows: () => [...usageBreakdownRows(ledger), ...(toolset.stats().memories.length ? [['память', `сохранено ${toolset.stats().memories.length}`]] : [])] });
    } finally {
        await mcp.close();
    }
}

/**
 * Planner, collector, worker, and reviewer. Prints the summary and writes --out.
 * @param {object} ctx Command context.
 * @param {{ task: string, parts: object[], level: string, interactive: boolean, store: object|null, extra: string|null }} options Task text, attachments, approval level, and extra instructions.
 * @returns {Promise<number>}
 * @ai.hint io
 */
async function runTeamFlow(ctx, { task, parts, level, interactive, store, extra, seedFiles = [], generation = false, revision = '', fromStep = null, resumeId = null }) {
    const { config, renderer, values, signal, emit } = ctx;
    const client = createClientFor(config);
    const ledger = createLedgerFor(config);
    renderer.line('info', `Команда агентов · каталог ${ctx.cwd} · доступ: ${level} · роли: ${describeRoles(config, ROLE_NAMES.filter((n) => n !== 'default'))}${store ? ' · память включена' : ' · память выключена'}`, { dim: true });
    renderer.begin();
    renderer.ledger = ledger.snapshot();
    const result = await runTeam({
        client, config, ledger, task, parts, root: ctx.cwd, approvalLevel: level, interactive,
        approve: (request) => renderer.approve(request, { signal }), askUser: interactive ? (q) => renderer.ask(q, { signal }) : null,
        memory: store?.memory ?? null, projectKey: store?.projectKey ?? null, projectName: store?.projectName ?? null,
        backupDir: ctx.backupDir, extraInstructions: extra, emit, signal, seedFiles, generation, revision, fromStep, resumeId,
    });
    renderer.idle();
    renderer.ensureNewline();
    if (!config.stream && result.finalNote) renderer.text(`${result.finalNote}\n`);
    if (result.error && ['failed', 'budget'].includes(result.status)) renderer.line('fail', result.error.message);
    if (result.status === 'cancelled') renderer.line('warn', 'Отменено.');

    let outFile = null;
    if (values.out && result.text) {
        outFile = await writeOutput(values.out, result.text, { cwd: ctx.cwd });
        renderer.line('ok', `Отчёт сохранён: ${outFile} (${formatBytes(Buffer.byteLength(result.text))})`);
    }
    const worker = result.stats?.worker;
    const toolCalls = result.stats ? Object.values(result.stats).reduce((sum, s) => sum + s.calls, 0) : 0;
    renderer.summary({
        title: 'итог задачи',
        rows: [
            ['статус', TEAM_STATUS[result.status] ?? result.status],
            ...(result.plan ? [['план', `${result.plan.complexity} · ${truncate(result.plan.summary, 200)}`]] : []),
            ...(result.workId ? [['план на диске', `.tmp/${result.workId}/`]] : []),
            ['шагов', result.steps.length ? `${result.steps.length} (${result.steps.map((s) => `${s.index}: ${s.status}`).join(', ')})` : '0'],
            ...(result.review ? [['ревью', `${result.review.verdict === 'accept' ? 'принято' : 'правки'} после ${result.reviewRounds} раунд(а/ов) · ${truncate(result.review.summary, 200)}`]] : []),
            ['вызовов инструментов', toolCalls ? `${toolCalls} (worker ${worker.calls}, collector ${result.stats.collector.calls}, reviewer ${result.stats.reviewer.calls})${worker.denied ? `, отклонено ${worker.denied}` : ''}` : '0'],
            ...(result.changes.length ? [['изменения', describeChanges({ changes: result.changes })], ['резервные копии', ctx.backupDir]] : []),
            ...(worker?.commands?.length ? [['команды', worker.commands.map((c) => `${c.command} → ${c.exitCode ?? '?'}`).join('; ')]] : []),
            ...(result.images.length ? [['изображения', result.images.join(', ')]] : []),
            ...(store ? [['память', `найдено ${result.recalled.length}, сохранено ${result.memoriesSaved.length}`]] : []),
            ['токены', usageRow(ledger)],
            ...usageBreakdownRows(ledger),
        ],
    });
    const summary = {
        type: 'result', status: result.status, text: result.text, plan: result.plan, review: result.review, steps: result.steps,
        workId: result.workId ?? null,
        images: result.images, changes: result.changes, memoriesSaved: result.memoriesSaved.map((m) => ({ id: m.id, scope: m.scope, kind: m.kind, content: m.content })),
        outFile, usage: ledger.snapshot(), tools: result.stats, error: result.error ? { message: result.error.message, code: result.error.code ?? null } : null,
    };
    renderer.json(summary);
    const code = exitCodeFor(result.status);
    await ctx.reporter?.finish(summary, code);
    client.close();
    return code;
}

/**
 * `ai resume` without a response id. Continues the newest unfinished step, or applies a revision.
 * @param {object} ctx Command context from cli.main.
 * @param {{ revision?: string, stepToken?: string|null }} [request]
 * @returns {Promise<number>}
 * @exports
 * @ai.hint io
 */
export async function resumeLocal(ctx, { revision = '', stepToken = null } = {}) {
    const note = String(revision ?? '').trim();
    const found = await findLatestResumable(ctx.cwd, { includeDone: Boolean(note) || stepToken != null });
    if (!found) throw new UsageError('В этом каталоге нет сохранённой работы в .tmp. Сначала запустите ai run или ai gen.');
    const steps = found.plan.steps ?? [];
    const open = found.progress.cursor < steps.length || found.progress.stage === 'review' || found.progress.stage === 'fix';
    if (!open && !note && stepToken == null) {
        throw new UsageError('Незавершённых шагов нет. Напишите, что добавить или исправить: ai resume "…"');
    }
    const fromStep = stepToken == null ? null : resolveResumeStep(found.plan, stepToken);
    if (fromStep != null && fromStep < 0) throw new UsageError(`В плане .tmp/${found.id} нет шага ${stepToken}. Шаги: 1–${steps.length}.`);
    const task = found.progress.task || found.plan.task || '';
    if (!task.trim()) throw new UsageError(`У работы .tmp/${found.id} нет текста задачи.`);
    const generation = found.progress.generation === true || /Already written\. Do not plan/.test(task);

    const { config, renderer, values } = ctx;
    const interactive = renderer.interactive;
    const level = approvalLevel(config, interactive);
    const store = openMemoryFor(config, ctx.cwd, renderer);
    const toolsChosen = values.tools !== undefined || Boolean(values['no-tools']) || Boolean(values.images);
    if (generation && /generate_image|image_generation|edit_image/.test(task) && !toolsChosen) config.tools.images = true;
    const imageApi = imageTransport(config) === 'images';
    const names = enabledToolNames(config.tools, { interactive, memory: Boolean(store), summarize: true, imageApi });
    if (!names.length && !config.tools.web && !config.tools.images) {
        throw new UsageError('Все инструменты отключены; для resume нужен хотя бы один (fs, shell, fetch, web, images).');
    }
    ctx.backupDir = backupDirFor(config);
    const extra = await resolveTextArg(values.instructions, { cwd: ctx.cwd, what: 'инструкции' });
    const where = fromStep == null ? `шаг ${Math.min(found.progress.cursor + 1, steps.length)}` : `шаг ${fromStep + 1}`;
    renderer.line('info', note
        ? `Доработка .tmp/${found.id}, ${where}: ${note}`
        : `Продолжение .tmp/${found.id} с места остановки (${where}).`, { dim: true });
    try {
        const ensured = await ensureProjectMap(ctx.cwd);
        if (ensured?.error) renderer.line('warn', `Карта проекта не построена: ${ensured.error.message}`);
        return await runTeamFlow(ctx, {
            task, parts: [], level, interactive, store, names, extra, generation, revision: note, fromStep, resumeId: found.id,
        });
    } finally {
        store?.memory.close();
    }
}
