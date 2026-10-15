/**
 * @file src/agent/image-tools.js
 * @module agent/image-tools
 * @purpose Local generate_image and edit_image tools for the images API.
 * @depends node:path, node:fs/promises, agent/paths, openai/images
 * @usedBy agent/tools
 * @exports createImageHandlers
 * @ai.tags images, tools
 * @ai.hint io
 * @changed 2026-10-15 ProxyAPI generations and edits.
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
        /** POST /images/generations and save every returned image. */
        async generate_image(args) {
            if (!client?.images) throw new Error('Клиент API недоступен для generate_image.');
            const payloads = await client.images.generate({
                model: imageModelFor(config), prompt: args.prompt, size: args.size || null, quality: args.quality || null, signal,
            });
            return saveAll(payloads, args.path);
        },
        /** POST /images/edits with one source file and save the result. */
        async edit_image(args) {
            if (!client?.images) throw new Error('Клиент API недоступен для edit_image.');
            const located = await resolveInside(root, args.image, { allowRoot: false });
            const bytes = await readFile(located.abs);
            const kind = sniffImage(bytes);
            const payloads = await client.images.edit({
                model: imageModelFor(config), prompt: args.prompt, size: args.size || null, signal,
                files: [{ filename: path.basename(located.rel), mime: kind.mime, bytes }],
            });
            return saveAll(payloads, args.path);
        },
    };
}
