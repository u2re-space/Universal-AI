import { builtinTools } from '../agent/loop.js';
import { IMAGE_BASE } from './instructions.js';
import { runOnce } from './flow.js';
import { UsageError, readStdin, loadAttachments, composeInstructions, resolveTextArg } from './shared.js';

/**
 * `ai image <prompt>` — generate (or edit, with --image) pictures through the Responses API
 * image_generation tool. Partial images are written progressively; final files are listed.
 */
export async function image(ctx) {
    const { config, renderer, values, positionals } = ctx;
    let prompt = positionals.join(' ').trim();
    if (!prompt) prompt = (await readStdin({ maxBytes: config.limits.maxStdinBytes })) ?? '';
    if (!prompt.trim()) throw new UsageError('Укажите описание изображения: ai image "…"');
    const count = Math.max(1, Math.min(10, Number(values.count ?? 1) || 1));
    const parts = await loadAttachments({ images: values.image ?? [], files: [], detail: values.detail ?? 'auto', cwd: ctx.cwd, config, renderer });
    const extra = await resolveTextArg(values.instructions, { cwd: ctx.cwd, what: 'инструкции' });
    const instructions = composeInstructions(IMAGE_BASE, config, extra);
    const builtin = builtinTools({ ...config, tools: { ...config.tools, images: true } }, { images: true, web: false });
    const target = values.out ?? config.image.outputDir;
    renderer.line('info', `Генерация: ${config.imageModel ?? 'модель по умолчанию инструмента'} · ${config.image.size} · качество ${config.image.quality} · ${config.image.format} → ${target}`, { dim: true });

    let code = 0;
    const produced = [];
    for (let i = 0; i < count; i++) {
        if (count > 1) renderer.line('info', `Изображение ${i + 1} из ${count}`);
        const exit = await runOnce({ ...ctx, values: { ...values, session: null, out: null } }, {
            prompt: parts.length ? `${prompt}\n(Use the attached image(s) as the reference / source to edit.)` : prompt,
            parts, instructions, builtin, toolChoice: { type: 'image_generation' }, imageTarget: target, maxTurns: 1,
            summaryTitle: count > 1 ? `изображение ${i + 1}/${count}` : 'итог',
            extraRows: (result) => { produced.push(...result.images); return []; },
        });
        code = Math.max(code, exit);
    }
    if (count > 1) renderer.line('ok', `Готово: ${produced.length} файл(ов): ${produced.join(', ')}`);
    return code;
}
