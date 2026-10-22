/**
 * @file src/agent/image-tools.js
 * @module agent/image-tools
 * @purpose Local generate_image and edit_image tools for the images API.
 * @depends node:path, node:fs/promises, agent/paths, openai/images
 * @usedBy agent/tools
 * @exports createImageHandlers
 * @ai.tags images, tools
 * @ai.hint io
 * @changed 2026-10-22 generate_image accepts optional reference; edit_image accepts extra_images.
 */

import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolveInside } from './paths.js';
import { imageModelFor, sniffImage } from '../openai/images.js';

/**
 * Handlers for generate_image and edit_image. `client.images` talks to /images/generations and /images/edits.
 * @param {{ root: string, client: object, config: object, signal?: AbortSignal }} options
 * @returns {{ generate_image: Function, edit_image: Function }}
 * @exports
 * @ai.hint io
 */
export function createImageHandlers({ root, client, config, signal }) {
    /**
     * Write one base64 image inside the working directory.
     * @param {string} b64
     * @param {string} requested
     * @param {number} index
     * @param {number} total
     * @returns {Promise<{ rel: string, bytes: number }>}
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
        return { rel: safe, bytes: buffer.length };
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
        return {
            output: saved.map((item) => `Сохранено ${item.rel} (${item.bytes} bytes).`).join('\n'),
            summary: saved.map((item) => item.rel).join(', '),
        };
    }

    return {
        /**
         * POST /images/generations (no image) or POST /images/edits (with reference).
         * When `reference` is set, routes to the vision-capable edit endpoint
         * so the model conditions on the pixel data instead of text description alone.
         */
        async generate_image(args) {
            if (!client?.images) throw new Error('Клиент API недоступен для generate_image.');

            const ref = String(args.reference ?? '').trim();
            if (ref) {
                // Direct reference path: edit the reference with the prompt.
                const located = await resolveInside(root, ref, { allowRoot: false });
                const bytes = await readFile(located.abs);
                const kind = sniffImage(bytes);
                const payloads = await client.images.edit({
                    model: imageModelFor(config, { hasImage: true }),
                    prompt: args.prompt,
                    size: args.size || null,
                    signal, image_format: "png", background: "transparent",
                    files: [{ filename: path.basename(located.rel), mime: kind.mime, bytes }],
                });
                return saveAll(payloads, args.path);
            }

            // No reference: pure text-to-image generation.
            const payloads = await client.images.generate({
                model: imageModelFor(config), prompt: args.prompt, size: args.size || null, quality: args.quality || null, signal, background: "transparent", image_format: "png"
            });
            return saveAll(payloads, args.path);
        },
        /**
         * POST /images/edits with one required source image and optional extra references.
         * All images are sent as `image` fields in the multipart form.
         */
        async edit_image(args) {
            if (!client?.images) throw new Error('Клиент API недоступен для edit_image.');
            const located = await resolveInside(root, args.image, { allowRoot: false });
            const bytes = await readFile(located.abs);
            const kind = sniffImage(bytes);
            const files = [{ filename: path.basename(located.rel), mime: kind.mime, bytes }];

            // Optional additional reference images (JSON array of paths).
            const extra = String(args.extra_images ?? '').trim();
            if (extra) {
                let paths;
                try { paths = JSON.parse(extra); }
                catch { paths = []; }
                if (Array.isArray(paths)) {
                    for (const p of paths) {
                        if (typeof p !== 'string' || !p.trim()) continue;
                        const eloc = await resolveInside(root, p, { allowRoot: false });
                        const ebytes = await readFile(eloc.abs);
                        const ekind = sniffImage(ebytes);
                        files.push({ filename: path.basename(eloc.rel), mime: ekind.mime, bytes: ebytes });
                    }
                }
            }

            const payloads = await client.images.edit({
                model: imageModelFor(config, { hasImage: true }), prompt: args.prompt, size: args.size || null, signal, image_format: "png", background: "transparent",
                files,
            });
            return saveAll(payloads, args.path);
        },
    };
}
