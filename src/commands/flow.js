/**
 * @file src/commands/flow.js
 * @module commands/flow
 * @purpose Shared one-shot flow: open a session, run one turn, print the summary, and return an exit code.
 * @depends node:path, node:fs/promises, core/attachments, core/placeholders, core/runtime-env, agent/loop, util/text, commands/shared
 * @usedBy commands/ask, commands/run, commands/image
 * @exports loadTextFormat, runOnce
 * @ai.tags cli, turn
 * @ai.hint io
 * @changed 2026-10-27 Prompt and instructions expand {{env:}}, {{fs:}}, {{task:PROMPT}}, and {{delegated:PROMPT}}.
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { buildUserMessage } from '../core/attachments.js';
import { renderPlaceholders } from '../core/placeholders.js';
import { liveEnv } from '../core/runtime-env.js';
import { runTurn, builtinTools } from '../agent/loop.js';
import { formatBytes } from '../util/text.js';
import { UsageError, createClientFor, createLedgerFor, openSession, writeOutput, resultObject, exitCodeFor, STATUS_LABELS,
    usageRow, backupSummaryRows, turnExtender } from './shared.js';

/**
 * Load a JSON schema file for structured output (--schema).
 * @param {string|undefined} file Path relative to cwd. A falsy value skips the schema.
 * @param {string} cwd Working directory.
 * @returns {Promise<object|null>} json_schema text format, or null.
 * @exports
 * @ai.hint io
 */
export async function loadTextFormat(file, cwd) {
    if (!file) return null;
    const target = path.resolve(cwd, file);
    let schema;
    try { schema = JSON.parse(await readFile(target, 'utf8')); }
    catch (error) { throw new UsageError(`Не удалось прочитать JSON-схему ${target}: ${error.message}`); }
    const name = path.parse(target).name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'result';
    return { type: 'json_schema', name, strict: true, schema };
}

/**
 * Shared single-prompt flow for `ask`, `run` and `image`:
 * open session → add the user message → runTurn → print/save → summary → exit code.
 * @param {object} ctx Command context. client and ledger are created when absent.
 * @param {{ prompt: string, parts?: object[], instructions: string, toolset?: object|null, toolChoice?: object|null, textFormat?: object|null, imageTarget?: string, maxTurns?: number, summaryTitle?: string, extraRows?: Function, builtin?: object[] }} flow Turn inputs. extraRows adds summary lines.
 * @returns {Promise<number>} Exit code from exitCodeFor.
 * @exports
 * @ai.hint io
 */
export async function runOnce(ctx, {
    prompt, parts = [], instructions, toolset = null, toolChoice = null, textFormat = null, imageTarget,
    maxTurns, summaryTitle = 'итог', extraRows = () => [], builtin,
}) {
    const { config, renderer, signal, values, emit } = ctx;
    const client = ctx.client ?? createClientFor(config);
    const ledger = ctx.ledger ?? createLedgerFor(config);
    const scope = {
        env: liveEnv(), root: ctx.cwd, task: prompt, maxBytes: config.limits.maxFileReadBytes,
    };
    const task = await renderPlaceholders(prompt, { ...scope, namespaces: ['env', 'fs'] });
    const renderedInstructions = await renderPlaceholders(instructions, { ...scope, task });
    const { session, file: sessionFile, resumed } = await openSession({ config, name: values.session ?? null, instructions: renderedInstructions });
    if (resumed) renderer.line('info', `Сессия продолжена: ${values.session} (${session.size} элементов истории)`, { dim: true });
    session.addUserMessage(buildUserMessage({ text: task, parts }));

    const builtinList = builtin ?? builtinTools(config, { web: config.tools.web, images: config.tools.images });
    renderer.begin();
    renderer.ledger = ledger.snapshot();
    const result = await runTurn({
        client, config, session, ledger, toolset, builtin: builtinList, toolChoice, instructions: renderedInstructions, textFormat,
        background: Boolean(values.background), imageTarget: imageTarget ?? config.image.outputDir,
        maxTurns: maxTurns ?? (toolset ? config.limits.maxTurns : 1), signal, emit,
        onMaxTurns: turnExtender(renderer, config, signal),
    });
    renderer.idle();

    if (!config.stream && result.text) renderer.text(`${result.text}\n`);
    else if (!config.stream && result.refusal) renderer.text(`${result.refusal}\n`);
    renderer.ensureNewline();

    let outFile = null;
    if (values.out && result.text && !result.images.length) {
        outFile = await writeOutput(values.out, result.text, { cwd: ctx.cwd });
        renderer.line('ok', `Ответ сохранён: ${outFile} (${formatBytes(Buffer.byteLength(result.text))})`);
    }
    if (sessionFile) {
        await session.save(sessionFile);
        renderer.line('info', `Сессия сохранена: ${sessionFile}`, { dim: true });
    }
    if (result.error && result.status === 'failed') renderer.line('fail', result.error.message);
    if (result.error && result.status === 'cancelled') renderer.line('warn', 'Отменено.');

    const stats = toolset?.stats() ?? null;
    renderer.summary({
        title: summaryTitle,
        rows: [
            ['статус', STATUS_LABELS[result.status] ?? result.status],
            ...(toolset ? [['ходов', `${result.turns}`], ['вызовов инструментов', stats.calls ? `${stats.calls} (${Object.entries(stats.byTool).map(([n, c]) => `${n} ×${c}`).join(', ')})${stats.denied ? `, отклонено ${stats.denied}` : ''}` : '0']] : []),
            ...backupSummaryRows(stats?.changes, ctx.backupDir),
            ...(stats?.commands?.length ? [['команды', stats.commands.map((c) => `${c.command} → ${c.exitCode ?? '?'}`).join('; ')]] : []),
            ...(result.images.length ? [['изображения', result.images.join(', ')]] : []),
            ['токены', usageRow(ledger)],
            ...(values.verbose && result.response?.id ? [['response id', result.response.id]] : []),
            ...extraRows(result),
        ],
    });
    const summary = resultObject({ result, ledger, toolset, outFile, session });
    renderer.json(summary);
    await ctx.reporter?.finish(summary, exitCodeFor(result.status));
    client.close();
    return exitCodeFor(result.status);
}
