/**
 * @file src/commands/image.js
 * @module commands/image
 * @purpose Generate or edit images through the Responses image_generation tool.
 * @depends agent/loop, commands/instructions, commands/flow, commands/shared
 * @usedBy cli
 * @exports image
 * @ai.tags cli, image
 * @ai.hint io
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */
import path from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { builtinTools } from '../agent/loop.js';
import { IMAGE_BASE } from './instructions.js';
import { runOnce } from './flow.js';
import { UsageError, readStdin, loadAttachments, composeInstructions, resolveTextArg, createClientFor } from './shared.js';
import { imageModelFor, imageTransport, sniffImage } from '../openai/images.js';
import { applyGeneratedAlphaMask } from '../agent/image-alpha.js';
import { resolveInside } from '../agent/paths.js';

/**
 * `ai image <prompt>` — generate (or edit, with --image) pictures through the Responses API
 * image_generation tool. Partial images are written progressively; final files are listed.
 * @param {object} ctx Command context from cli.main.
 * @returns {Promise<number>} Worst exit code across --count images.
 * @exports
 * @ai.hint io
 */
export async function image(ctx) {
    const { config, renderer, values, positionals } = ctx;
    let prompt = positionals.join(' ').trim();
    if (!prompt) prompt = (await readStdin({ maxBytes: config.limits.maxStdinBytes, stdin: ctx.stdin ?? process.stdin })) ?? '';
    if (!prompt.trim()) throw new UsageError('Укажите описание изображения: ai image "…"');
    const count = Math.max(1, Math.min(10, Number(values.count ?? 1) || 1));
    const parts = await loadAttachments({ images: values.image ?? [], files: [], detail: values.detail ?? 'auto', cwd: ctx.cwd, config, renderer });
    const extra = await resolveTextArg(values.instructions, { cwd: ctx.cwd, what: 'инструкции' });
    const instructions = composeInstructions(IMAGE_BASE, config, extra);
    if (imageTransport(config) === 'images') return runImagesEndpoint(ctx, prompt, count);
    const builtin = builtinTools({ ...config, tools: { ...config.tools, images: true } }, { images: true, web: true });
    const target = values.out ?? config.image.outputDir;
    renderer.line('info', `Генерация: ${config.imageModel ?? 'модель по умолчанию инструмента'} · ${config.image.size} · качество ${config.image.quality} · ${config.image.format} → ${target}`, { dim: true });

    let code = 0;
    const produced = [];
    for (let i = 0; i < count; i++) {
        if (count > 1) renderer.line('info', `Изображение ${i + 1} из ${count}`);
        const exit = await runOnce({ ...ctx, values: { ...values, session: null, out: null } }, {
            prompt: parts.length ? `${prompt}\n(Use the attached image(s) as the reference / source to edit. Never paint a checkerboard or a fake transparency pattern; keep the background flat and even.)` : prompt,            parts, instructions, builtin, toolChoice: { type: 'image_generation' }, imageTarget: target, maxTurns: 1,
            summaryTitle: count > 1 ? `изображение ${i + 1}/${count}` : 'итог',
            extraRows: (result) => { produced.push(...result.images); return []; },
        });
        code = Math.max(code, exit);
    }
    if (count > 1) renderer.line('ok', `Готово: ${produced.length} файл(ов): ${produced.join(', ')}`);
    return code;
}

/**
 * Draw or edit through /images/generations and /images/edits. No Responses image tool.
 * @param {object} ctx
 * @param {string} prompt
 * @param {number} count
 * @returns {Promise<number>}
 * @ai.hint io
 */
async function runImagesEndpoint(ctx, prompt, count) {
    const { config, renderer, values, signal } = ctx;
    const sources = values.image ?? [];
    const model = imageModelFor(config, { hasImage: sources.length > 0 });
    const target = values.out ?? config.image.outputDir;
    const format = config.image.format;
    const background = config.image.background;
    const wantsTransparent = background === 'transparent';
    renderer.line('info', `Изображения API: ${model} · ${sources.length ? 'редактирование' : 'генерация'} · ${format} · фон ${background} → ${target}`, { dim: true });
    const client = createClientFor(config);
    try {
        const payloads = sources.length
            ? await client.images.edit({
                model, prompt, size: config.image.size, format, background, signal,
                files: await Promise.all(sources.map(async (file) => {
                    const located = await resolveInside(ctx.cwd, file, { allowRoot: false });
                    const bytes = await readFile(located.abs);
                    return { filename: path.basename(located.rel), mime: sniffImage(bytes).mime, bytes };
                })),
            })
            : await client.images.generate({ model, prompt, size: config.image.size, quality: config.image.quality, n: count, format, background, signal });
        const saved = [];
        for (const [index, b64] of payloads.entries()) {
            const buffer = Buffer.from(b64, 'base64');
            const kind = sniffImage(buffer);
            const rel = payloads.length > 1 ? `image-${index + 1}.${kind.ext}` : `image.${kind.ext}`;
            const dest = path.resolve(ctx.cwd, target, rel);
            await mkdir(path.dirname(dest), { recursive: true });
            await writeFile(dest, buffer);
            saved.push(path.relative(ctx.cwd, dest));
            if (wantsTransparent) {
                const alpha = await applyGeneratedAlphaMask({ client, config, file: dest, signal, alphaSource: sources[0] });
                if (alpha.reason === 'already') {
                    renderer.line('info', `Альфа-канал настоящий: модель отдала прозрачный фон, маска не потребовалась (${saved.at(-1)})`, { dim: true });
                } else if (alpha.changed) {
                    const how = alpha.reason === 'mask'
                        ? `по anti-aliased маске ${alpha.model}${alpha.painted ? ' после заливки фона цветом объекта' : ''}`
                        : alpha.reason === 'contour' ? 'по локальному контуру' : 'заливкой от углов';
                    renderer.line('info', `Альфа-канал собран ${how}: ${saved.at(-1)}`, { dim: true });
                } else if (alpha.reason === 'opaque') renderer.line('info', `Прозрачность ${saved.at(-1)}: фоном оказался сам объект, файл оставлен непрозрачным.`, { dim: true });
                else if (alpha.reason === 'no-magick') renderer.line('warn', `Прозрачность ${saved.at(-1)}: ImageMagick не найден.`);
                else if (alpha.reason === 'format') renderer.line('warn', `Прозрачность ${saved.at(-1)}: JPEG не хранит альфа-канал, нужен PNG.`);
            }
            renderer.line('ok', `Изображение сохранено: ${saved.at(-1)}`);
        }
        renderer.line('ok', `Готово: ${saved.join(', ')}`);
        return saved.length ? 0 : 1;
    } catch (error) {
        renderer.line('fail', error.message);
        return 1;
    } finally {
        client.close();
    }
}
