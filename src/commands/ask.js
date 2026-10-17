/**
 * @file src/commands/ask.js
 * @module commands/ask
 * @purpose Run one prompt and return when the model stops calling tools.
 * @depends agent/tools, core/config, commands/instructions, commands/flow, commands/shared
 * @usedBy cli
 * @exports ask
 * @ai.tags cli, prompt
 * @ai.hint io
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */
import { createToolset, enabledToolNames } from '../agent/tools.js';
import { resolveRole } from '../core/config.js';
import { ASSISTANT_BASE } from './instructions.js';
import { runOnce, loadTextFormat } from './flow.js';
import { UsageError, readStdin, resolveTextArg, loadAttachments, composeInstructions, approvalLevel, backupDirFor, openMemoryFor } from './shared.js';
import { stdinFence } from '../core/attachments.js';

/**
 * `ai ask [prompt…]` — one prompt, one answer (plus optional attachments, stdin context,
 * web search / image generation tools, structured output and persistent sessions).
 * @param {object} ctx Command context from cli.main.
 * @returns {Promise<number>} Exit code from runOnce.
 * @exports
 * @ai.hint io
 */
export async function ask(ctx) {
    const { config, renderer, values, positionals, signal, emit } = ctx;
    const stdinText = await readStdin({ maxBytes: config.limits.maxStdinBytes, stdin: ctx.stdin ?? process.stdin });
    let prompt = positionals.join(' ').trim();
    let stdinIsPrompt = false;
    if (!prompt && stdinText) { prompt = stdinText; stdinIsPrompt = true; }
    if (!prompt && !values.image?.length && !values.file?.length) {
        throw new UsageError('Укажите запрос: ai "текст запроса" (или передайте текст через stdin).');
    }
    const parts = await loadAttachments({ images: values.image ?? [], files: values.file ?? [], detail: values.detail ?? 'auto', cwd: ctx.cwd, config, renderer });
    if (stdinText && !stdinIsPrompt) parts.push({ type: 'input_text', text: stdinFence(stdinText) });
    if (!prompt) prompt = 'Опиши вложения.';

    const extra = await resolveTextArg(values.instructions, { cwd: ctx.cwd, what: 'инструкции' });
    const instructions = composeInstructions(ASSISTANT_BASE, config, extra);
    const textFormat = await loadTextFormat(values.schema, ctx.cwd);

    // Local tools are opt-in for `ask` (--tools fs,shell,…); built-in web/images follow --web/--images.
    let toolset = null;
    let store = null;
    if (values.tools !== undefined && values.tools !== 'none') {
        store = openMemoryFor(config, ctx.cwd, renderer);
        const names = enabledToolNames(config.tools, { interactive: renderer.interactive, memory: Boolean(store), unsafeScreenshot: config.desktop?.unsafeScreenshot === true });
        if (names.length) {
            ctx.backupDir = backupDirFor(config);
            toolset = createToolset({
                root: ctx.cwd, config, names, approvalLevel: approvalLevel(config, renderer.interactive),
                approve: (request) => renderer.approve(request, { signal }), askUser: renderer.interactive ? (q) => renderer.ask(q, { signal }) : null,
                backupDir: ctx.backupDir, signal, emit, memory: store?.memory ?? null, projectKey: store?.projectKey ?? null, projectName: store?.projectName ?? null,
            });
        }
    }
    try {
        // `ask` speaks with the default role (roles.default may pin its own model / effort).
        return await runOnce({ ...ctx, config: resolveRole(config, 'default').config }, { prompt, parts, instructions, toolset, textFormat, maxTurns: toolset ? config.limits.maxTurns : 1 });
    } finally {
        store?.memory.close();
    }
}
