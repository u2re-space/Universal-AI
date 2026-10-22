/**
 * @file src/core/images.js
 * @module core/images
 * @purpose Write generated images to disk, one file per item, partials then the final.
 * @depends node:path, node:fs/promises, util/text
 * @usedBy agent/loop
 * @exports createImageSink
 * @ai.tags images
 * @ai.hint io
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */
import path from 'node:path';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { timestampSlug } from '../util/text.js';

const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' };

/**
 * Collects generated images (final and partial) into files.
 * `target` may be a directory or an explicit file path (used for the first image; others get a suffix).
 * Writes for the same item are serialized so a late partial image can never overwrite the final one.
 */
export function createImageSink({ target = '.', format = 'png', prefix = 'ai-image' } = {}) {
    target = path.resolve(target);
    const paths = new Map();   // itemId -> absolute file path
    const queues = new Map();  // itemId -> promise chain
    let counter = 0;
    let targetIsFile = null;
    const stamp = timestampSlug();

    /**
     * Decide once whether `target` is a file path or a directory.
     * @returns {Promise<void>}
     * @ai.hint io
     */
    async function resolveTarget() {
        if (targetIsFile !== null) return;
        const info = await stat(target).catch(() => null);
        targetIsFile = info ? !info.isDirectory() : /\.(png|jpe?g|webp)$/i.test(target);
    }

    /**
     * Absolute path for an item. The same id always returns the path assigned on the first call.
     * @param {string} itemId
     * @param {string} [outputFormat]
     * @returns {Promise<string>}
     * @ai.hint io
     */
    async function fileFor(itemId, outputFormat) {
        await resolveTarget();
        if (paths.has(itemId)) return paths.get(itemId);
        counter++;
        const ext = EXT[(outputFormat ?? format) || 0] ?? 'png';
        let file;
        if (targetIsFile) {
            const parsed = path.parse(target);
            file = counter === 1 ? target : path.join(parsed.dir, `${parsed.name}-${counter}${parsed.ext || `.${ext}`}`);
        } else {
            file = path.join(target, `${prefix}-${stamp}-${counter}.${ext}`);
        }
        paths.set(itemId, file);
        await mkdir(path.dirname(path.resolve(file)), { recursive: true });
        return file;
    }

    /**
     * Decode base64 and write it. Writes for one item run in order so a late partial cannot pass the final.
     * @param {string|null} itemId
     * @param {string} b64
     * @param {string} [outputFormat]
     * @returns {Promise<{ file: string, bytes: number }|null>}
     * @ai.hint io
     */
    function write(itemId, b64, outputFormat) {
        if (!b64) return Promise.resolve(null);
        const key = itemId ?? `#${counter + 1}`;
        const job = (queues.get(key) ?? Promise.resolve()).then(async () => {
            const file = await fileFor(key, outputFormat);
            const buffer = Buffer.from(b64, 'base64');
            await writeFile(file, buffer);
            return { file, bytes: buffer.length };
        });
        queues.set(key, job.catch(() => null));
        return job;
    }

    return {
        savePartial: (itemId, b64, outputFormat) => write(itemId, b64, outputFormat),
        saveFinal: (itemId, b64, outputFormat) => write(itemId, b64, outputFormat),
        /**
         * Copy of item id to absolute path.
         * @returns {Map<string, string>}
         * @ai.hint pure
         */
        get paths() { return new Map(paths); },
        /**
         * Absolute paths written so far, in assignment order.
         * @returns {string[]}
         * @ai.hint pure
         */
        get files() { return [...paths.values()]; },
    };
}
