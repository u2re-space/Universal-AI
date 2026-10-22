/**
 * @file src/agent/image-tools.js
 * @module agent/image-tools
 * @purpose Local generate_image and edit_image tools for the images API, plus vectorize_image.
 * @depends node:path, node:fs/promises, agent/paths, agent/image-magick, openai/images
 * @usedBy agent/tools
 * @exports createImageHandlers
 * @ai.tags images, tools
 * @ai.hint io
 * @changed 2026-10-22 Transparent background through a model-drawn mask, extra references, model-aware format fields, and vectorize_image.
 */

import path from 'node:path';
import { mkdir, readFile, writeFile, stat, unlink, readdir } from 'node:fs/promises';
import { resolveInside } from './paths.js';
import { detectMagick, magickRemoveFlatBackground, assessVectorSuitability } from './image-magick.js';
import { applyGeneratedAlphaMask } from './image-alpha.js';
import { imageModelFor, sniffImage, PROXY_VECTOR_MODEL } from '../openai/images.js';
import { formatBytes } from '../util/text.js';

/** Prompt the vector model gets when the caller did not describe the artwork. */
const DEFAULT_VECTOR_PROMPT = 'Vectorize the attached image exactly as it is: keep the original shapes, palette, and proportions; flat shapes with smooth paths and a transparent background; do not redesign it or add new colors.';

/** Raster extensions worth offering for vectorization. */
const VECTOR_SOURCE_EXT = /\.(png|webp)$/i;

/**
 * Handlers for generate_image and edit_image. `client.images` talks to /images/generations and /images/edits.
 * `describeImage({ part, question, rel, buffer })` is the optional vision role used to describe a
 * logo before vectorization, so the vector model keeps its shapes and palette.
 * @param {{ root: string, client: object, config: object, signal?: AbortSignal, describeImage?: Function|null }} options
 * @returns {{ generate_image: Function, edit_image: Function, vectorize_image: Function }}
 * @exports
 * @ai.hint io
 */
export function createImageHandlers({ root, client, config, signal, describeImage = null }) {
    const format = config.image?.format ?? 'png';
    const background = config.image?.background ?? 'auto';
    const wantsTransparent = background === 'transparent';

    /**
     * Write one base64 image inside the working directory.
     * @param {string} b64
     * @param {string} requested
     * @param {number} index
     * @param {number} total
     * @returns {Promise<{ rel: string, bytes: number, alpha: object|null }>}
     * @ai.hint io
     */
    async function save(b64, requested, index, total) {
        const buffer = Buffer.from(b64, 'base64');
        const kind = sniffImage(buffer);
        let rel = String(requested ?? '').trim();
        if (!rel) rel = `assets/image-${Date.now()}.${kind.ext}`;
        else if (!/\.(png|jpe?g|webp|gif)$/i.test(rel)) rel += `.${kind.ext}`;
        if (total > 1) rel = rel.replace(/(\.\w+)$/, `-${index + 1}$1`);
        const { abs, rel: safe } = await resolveInside(root, rel, { forWrite: true, allowRoot: false });
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, buffer);
        const alpha = wantsTransparent
            ? await applyGeneratedAlphaMask({ client, config, file: abs, signal })
            : null;
        return { rel: safe, bytes: buffer.length, alpha };
    }

    /**
     * @param {string[]} payloads
     * @param {string} requested
     * @returns {Promise<{ output: string, summary: string }>}
     * @ai.hint io
     */
    async function saveAll(payloads, requested) {
        const saved = [];
        for (const [index, b64] of payloads.entries()) saved.push(await save(b64, requested, index, payloads.length));
        const notes = [];
        if (wantsTransparent) {
            const masked = saved.filter((item) => item.alpha?.reason === 'mask').length;
            const flat = saved.filter((item) => item.alpha?.reason === 'flat').length;
            if (masked) notes.push(`Прозрачность: альфа-канал собран по маске модели у ${masked} файл(ов).`);
            if (flat) notes.push(`Прозрачность: маска не удалась, фон удалён заливкой от углов у ${flat} файл(ов).`);
            if (saved.some((item) => item.alpha?.reason === 'opaque')) notes.push('Прозрачность: маска пустая, фон не найден — файл оставлен непрозрачным.');
            if (saved.some((item) => item.alpha?.reason === 'no-magick')) notes.push('Прозрачность: ImageMagick не найден, альфа-канал не гарантирован.');
            if (saved.some((item) => item.alpha?.reason === 'format')) notes.push('Прозрачность: JPEG не хранит альфа-канал, сохраните результат в PNG.');
            if (saved.some((item) => item.alpha?.reason === 'failed')) notes.push('Прозрачность: локальное удаление фона не удалось.');
        }
        return {
            output: [...saved.map((item) => `Сохранено ${item.rel} (${item.bytes} bytes).`), ...notes].join('\n'),
            summary: saved.map((item) => item.rel).join(', '),
        };
    }

    /**
     * Load a project-relative image as a multipart file.
     * @param {string} ref
     * @returns {Promise<{ filename: string, mime: string, bytes: Buffer }>}
     * @ai.hint io
     */
    async function loadFile(ref) {
        const located = await resolveInside(root, ref, { allowRoot: false });
        const bytes = await readFile(located.abs);
        const kind = sniffImage(bytes);
        return { filename: path.basename(located.rel), mime: kind.mime, bytes };
    }

    /**
     * Extra reference images from a JSON array. Unreadable entries are skipped.
     * @param {string} raw
     * @returns {Promise<Array<{ filename: string, mime: string, bytes: Buffer }>>}
     * @ai.hint io
     */
    async function loadExtras(raw) {
        const text = String(raw ?? '').trim();
        if (!text) return [];
        let paths;
        try { paths = JSON.parse(text); }
        catch { return []; }
        if (!Array.isArray(paths)) return [];
        const files = [];
        for (const item of paths) {
            if (typeof item !== 'string' || !item.trim()) continue;
            try { files.push(await loadFile(item)); }
            catch { /* an unreadable extra must not lose the main image */ }
        }
        return files;
    }

    /**
     * Describe the artwork through the vision role so the vector model keeps its palette.
     * A bare "make it vector" prompt lets the model restyle the picture; naming the shapes and
     * colors keeps the result close to the source. Falls back to the generic prompt.
     * @param {string} rel
     * @param {Buffer} bytes
     * @param {string} mime
     * @returns {Promise<string>}
     * @ai.hint io
     */
    async function describeForVector(rel, bytes, mime) {
        if (!describeImage) return DEFAULT_VECTOR_PROMPT;
        try {
            const part = { type: 'input_image', image_url: `data:${mime};base64,${bytes.toString('base64')}`, detail: 'auto' };
            const text = await describeImage({
                part, rel, buffer: bytes,
                question: 'Describe this artwork for vector tracing in one short paragraph: its shapes and their layout, the exact colors (hex), and whether the background is flat or transparent. Do not suggest a style.',
            });
            const clean = String(text ?? '').trim().replace(/\s+/g, ' ').slice(0, 1200);
            return clean ? `${DEFAULT_VECTOR_PROMPT} The artwork: ${clean}` : DEFAULT_VECTOR_PROMPT;
        } catch {
            return DEFAULT_VECTOR_PROMPT;
        }
    }

    /**
     * List the rasters the measurer left in `.tmp/<id>/crops/` and rate each for vectorization.
     * `vectorize_image` calls this when the model leaves `image` empty, so a finished measurement
     * run still feeds the vector pass without re-cropping the mockup.
     * @returns {Promise<{ output: string, summary: string }>}
     * @ai.hint io
     */
    async function listVectorCandidates() {
        const exe = await detectMagick({ magickPath: config.magickPath ?? null });
        const maxColors = config.image?.vectorMaxColors ?? 256;
        const found = [];
        let runs = [];
        try {
            runs = await readdir(path.join(root, '.tmp'), { withFileTypes: true });
        } catch { /* no .tmp directory: nothing was measured */ }
        for (const run of runs) {
            if (!run.isDirectory()) continue;
            let names = [];
            try {
                names = await readdir(path.join(root, '.tmp', run.name, 'crops'));
            } catch { /* this run has no crops */ }
            for (const name of names) {
                if (!VECTOR_SOURCE_EXT.test(name)) continue;
                found.push(`.tmp/${run.name}/crops/${name}`);
            }
        }
        if (!found.length) {
            throw new Error('Укажите image: кропов из замеров в .tmp/*/crops/ не осталось. Передайте путь PNG/WebP (логотип, бейдж, иконка).');
        }
        const lines = [];
        for (const rel of found.slice(0, 40)) {
            const abs = path.join(root, rel.split('/').join(path.sep));
            const info = await stat(abs).catch(() => null);
            if (!info?.isFile()) continue;
            const stats = exe ? await assessVectorSuitability({ exe, input: rel, cwd: root, signal, maxColors }).catch(() => null) : null;
            const shape = stats ? `${stats.width}×${stats.height}, ${stats.colors ?? '?'} цветов` : `${formatBytes(info.size)}`;
            const verdict = !stats ? 'не проверено' : stats.suitable ? 'подходит' : 'не подходит';
            lines.push(`${rel} — ${shape}, ratio ${stats?.ratio ? stats.ratio.toFixed(2) : '?'} → ${verdict}`);
        }
        return {
            output: `Кандидаты для векторизации в .tmp/*/crops/ (вызовите vectorize_image с image=<путь>):\n${lines.join('\n')}`,
            summary: `${found.length} кропов`,
        };
    }

    return {
        /**
         * POST /images/generations (no image) or POST /images/edits (with reference).
         * When `reference` is set, routes to the vision-capable edit endpoint
         * so the model conditions on the pixel data instead of text description alone.
         * `extra_images` adds ready measurement crops or other fragments to the same request.
         */
        async generate_image(args) {
            if (!client?.images) throw new Error('Клиент API недоступен для generate_image.');

            const ref = String(args.reference ?? '').trim();
            if (ref) {
                const files = [await loadFile(ref), ...(await loadExtras(args.extra_images))];
                const payloads = await client.images.edit({
                    model: imageModelFor(config, { hasImage: true }),
                    prompt: args.prompt,
                    size: args.size || null,
                    format, background, signal,
                    files,
                });
                return saveAll(payloads, args.path);
            }

            if (String(args.extra_images ?? '').trim()) throw new Error('generate_image: extra_images требует reference.');

            // No reference: pure text-to-image generation.
            const payloads = await client.images.generate({
                model: imageModelFor(config), prompt: args.prompt, size: args.size || null, quality: args.quality || null,
                format, background, signal,
            });
            return saveAll(payloads, args.path);
        },
        /**
         * POST /images/edits with one required source image and optional extra references.
         * All images are sent as `image` fields in the multipart form.
         */
        async edit_image(args) {
            if (!client?.images) throw new Error('Клиент API недоступен для edit_image.');
            const files = [await loadFile(args.image), ...(await loadExtras(args.extra_images))];
            const payloads = await client.images.edit({
                model: imageModelFor(config, { hasImage: true }), prompt: args.prompt, size: args.size || null,
                format, background, signal,
                files,
            });
            return saveAll(payloads, args.path);
        },
        /**
         * Vectorize a flat raster (logo, badge, icon) into an SVG document with the vector model.
         * The source is a PNG/WebP inside the working directory; measurement crops from
         * `.tmp/<id>/crops/` are the preferred source, so an empty `image` lists what is left there.
         * A flat background is removed on a copy before the request, so the source crop stays intact.
         */
        async vectorize_image(args) {
            if (!client?.images) throw new Error('Клиент API недоступен для vectorize_image (нужен images transport).');

            const srcPath = String(args.image ?? '').trim();
            if (!srcPath) return listVectorCandidates();

            const { abs, rel } = await resolveInside(root, srcPath, { allowRoot: false });
            const info = await stat(abs).catch(() => null);
            if (!info?.isFile()) throw new Error(`Файл не найден: ${srcPath}`);
            const maxImageBytes = config.limits?.maxImageBytes ?? 20 * 1024 * 1024;
            if (info.size > maxImageBytes) throw new Error(`Изображение больше лимита ${formatBytes(maxImageBytes)}.`);

            const source = await readFile(abs);
            const kind = sniffImage(source);
            if (kind.ext === 'svg') throw new Error(`${rel} уже является SVG.`);
            if (kind.ext === 'jpg') throw new Error(`${rel} — JPEG со сжатием с потерями: артефакты мешают векторизации. Возьмите PNG или WebP.`);
            if (!['png', 'webp'].includes(kind.ext)) throw new Error(`${rel}: для векторизации нужен PNG или WebP.`);

            const exe = await detectMagick({ magickPath: config.magickPath ?? null });
            const maxColors = config.image?.vectorMaxColors ?? 256;
            const stats = exe ? await assessVectorSuitability({ exe, input: rel, cwd: root, signal, maxColors }).catch(() => null) : null;

            if (stats && !stats.suitable && args.force !== true) {
                return {
                    output: `Векторизация пропущена: ${rel} не похожа на плоскую графику — ${stats.colors ?? '?'} цветов при ${stats.width}×${stats.height}`
                        + ` (порог ${maxColors}; доминирующие цвета покрывают ${stats.coverage == null ? '?' : Math.round(stats.coverage * 100) + '%'}).`
                        + ' Фотографии и сложные градиенты передайте generate_image, либо повторите с force=true.',
                    summary: `${rel}: не подходит (${stats.colors} цветов)`,
                    ok: false,
                };
            }

            // Strip a flat background on a copy so the vector model sees the artwork without a plate.
            let bytes = source;
            let mime = kind.mime;
            let cleaned = null;
            let work = null;
            if (exe && args.remove_background !== false) {
                work = `.tmp/vector-source-${Date.now()}.png`;
                try {
                    await mkdir(path.join(root, '.tmp'), { recursive: true });
                    cleaned = await magickRemoveFlatBackground({ exe, input: rel, output: work, cwd: root, signal });
                    if (cleaned.changed) {
                        bytes = await readFile(path.join(root, work));
                        mime = 'image/png';
                    } else {
                        work = null;
                    }
                } catch {
                    cleaned = null;
                    work = null;
                }
            }

            const vectorModel = config.image?.vectorModel || PROXY_VECTOR_MODEL;
            const prompt = String(args.prompt ?? '').trim() || await describeForVector(rel, bytes, mime);
            let payload;
            try {
                payload = await client.images.vectorize({
                    model: vectorModel,
                    prompt,
                    image: { mime, bytes },
                    signal,
                });
            } finally {
                if (work) await unlink(path.join(root, work)).catch(() => {});
            }

            const svg = Buffer.from(payload[0], 'base64');
            const out = sniffImage(svg);
            if (out.ext !== 'svg') {
                throw new Error(`Модель ${vectorModel} вернула не SVG (${out.ext}); файл не сохранён.`);
            }

            let requested = String(args.path ?? '').trim();
            if (!requested) {
                // A crop lives in .tmp; its vector belongs to the project, so default to assets/.
                const parts = rel.split('/');
                const dir = parts.includes('.tmp') || path.dirname(rel) === '.' ? 'assets' : path.dirname(rel).split(path.sep).join('/');
                requested = `${dir}/${path.basename(rel, path.extname(rel))}.svg`;
            } else if (!/\.svg$/i.test(requested)) requested += '.svg';
            const { abs: outAbs, rel: outRel } = await resolveInside(root, requested, { forWrite: true, allowRoot: false });
            await mkdir(path.dirname(outAbs), { recursive: true });
            await writeFile(outAbs, svg, 'utf8');

            const notes = [];
            if (stats?.colors != null) notes.push(`Палитра источника: ${stats.colors} цвет(ов), ${stats.width}×${stats.height}, ratio ${stats.ratio ? stats.ratio.toFixed(2) : '?'}.`);
            if (stats?.coverage != null) notes.push(`Доминирующие цвета покрывают ${Math.round(stats.coverage * 100)}% пикселей (${stats.reason}).`);
            if (cleaned?.changed) notes.push(`Фон удалён локально (${cleaned.color}) — вектор получает прозрачную подложку.`);
            if (cleaned && !cleaned.changed && cleaned.reason === 'already') notes.push('Фон уже прозрачный.');
            if (!exe) notes.push('ImageMagick не найден: фон не проверялся, палитра не считалась.');
            return {
                output: `Векторизовано ${rel} → ${outRel} (${formatBytes(svg.length)})${notes.length ? `\n${notes.join('\n')}` : ''}`,
                summary: `${rel} → ${outRel}`,
            };
        },
    };
}
