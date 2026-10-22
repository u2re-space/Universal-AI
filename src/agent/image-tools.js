/**
 * @file src/agent/image-tools.js
 * @module agent/image-tools
 * @purpose Local generate_image and edit_image tools for the images API.
 * @depends node:path, node:fs/promises, agent/paths, agent/image-magick, openai/images
 * @usedBy agent/tools
 * @exports createImageHandlers
 * @ai.tags images, tools
 * @ai.hint io
 * @changed 2026-10-22 Transparent background fallback, extra references, model-aware format fields.
 */

import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolveInside } from './paths.js';
import { ensureTransparentBackground } from './image-magick.js';
import { imageModelFor, sniffImage } from '../openai/images.js';

/**
 * Handlers for generate_image and edit_image. `client.images` talks to /images/generations and /images/edits.
 * @param {{ root: string, client: object, config: object, signal?: AbortSignal }} options
 * @returns {{ generate_image: Function, edit_image: Function }}
 * @exports
 * @ai.hint io
 */
export function createImageHandlers({ root, client, config, signal }) {
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
            ? await ensureTransparentBackground({ file: abs, magickPath: config.magickPath ?? null, signal })
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
            const changed = saved.filter((item) => item.alpha?.changed).length;
            if (changed) notes.push(`Прозрачность: фон удалён локально у ${changed} файл(ов).`);
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
    };
}
