/**
 * @file src/generate/references.js
 * @module generate/references
 * @purpose Stage reference images (local, http(s), data:) into .ai/refs/ so every agent tool can
 *           reach them by project-relative path. Uses content-hash naming for idempotent resume.
 * @depends node:crypto, node:path, node:fs/promises, agent/paths, agent/image-magick, core/attachments
 * @usedBy commands/run, commands/gen
 * @exports stageReferences, resolveRefPath
 * @ai.tags generate, references, staging
 * @ai.hint io
 * @changed 2026-10-22 Created for direct-reference image generation path.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isInside, toPosix } from '../agent/paths.js';
import { detectMagick, magickIdentify } from '../agent/image-magick.js';
import { loadImageAttachment, detectImageMime } from '../core/attachments.js';

/** Directory under the project root where staged references live. */
const REFS_DIR = '.ai/refs';

/** MIME types the image tools accept. */
const SUPPORTED_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Compute a short content hash for a buffer (hex, first 12 chars).
 * @param {Buffer} buf
 * @returns {string}
 */
function hash(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

/**
 * Detect extension from MIME type.
 * @param {string} mime
 * @returns {string}
 */
function extFromMime(mime) {
    switch (mime) {
        case 'image/png': return 'png';
        case 'image/jpeg': return 'jpg';
        case 'image/gif': return 'gif';
        case 'image/webp': return 'webp';
        default: return 'png';
    }
}

/**
 * Stage one reference image into the project. Returns { rel, abs, bytes, mime, width, height }.
 * - Local file inside root: reuse its relative path (no copy).
 * - Local file outside root: copy to .ai/refs/<hash>.<ext>.
 * - http(s) / data: URL: decode, write to .ai/refs/<hash>.<ext>.
 *
 * @param {string} ref Original reference string (path, URL, data:).
 * @param {string} cwd Working directory.
 * @param {number} maxBytes Max bytes for downloads/decodes.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ rel: string, abs: string, bytes: number, mime: string, width?: number, height?: number }>}
 */
export async function stageOneReference(ref, cwd, maxBytes, signal) {
    if (typeof ref !== 'string' || !ref.trim()) throw new Error('Пустая ссылка на референс.');

    let buffer;
    let mime = null;
    let resolvedPath = null;

    // --- Local file ---
    if (!ref.startsWith('http://') && !ref.startsWith('https://') && !ref.startsWith('data:')) {
        const abs = path.resolve(cwd, ref);
        const info = await stat(abs).catch(() => null);
        if (!info?.isFile()) throw new Error(`Файл не найден: ${ref}`);
        if (info.size > maxBytes) throw new Error(`Изображение ${ref} больше лимита ${formatBytes(maxBytes)}.`);
        buffer = await readFile(abs);
        mime = detectImageMime(buffer, ref);
        if (!mime) throw new Error(`Неподдерживаемый формат: ${ref}.`);
        resolvedPath = abs;
    }
    // --- URL or data: ---
    else {
        const attachment = await loadImageAttachment(ref, { maxBytes, cwd });
        // loadImageAttachment returns base64 data URL for local files too
        const dataUrl = attachment.part.image_url;
        if (dataUrl.startsWith('data:')) {
            const commaIdx = dataUrl.indexOf(',');
            const header = dataUrl.slice(0, commaIdx);
            const b64 = dataUrl.slice(commaIdx + 1);
            const mimeMatch = /image\/(\w+)/i.exec(header);
            mime = mimeMatch ? `image/${mimeMatch[1].toLowerCase()}` : null;
            if (!SUPPORTED_MIMES.has(mime)) throw new Error(`Неподдерживаемый MIME: ${mime}.`);
            buffer = Buffer.from(b64, 'base64');
        } else {
            // http(s) URL — loadImageAttachment returns the URL as-is
            const res = await fetch(dataUrl, { signal });
            if (res.status >= 400) throw new Error(`HTTP ${res.status} при загрузке ${ref}`);
            const chunks = [];
            let total = 0;
            const reader = res.body?.getReader();
            if (reader) {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (total + value.length > maxBytes) {
                        chunks.push(value.subarray(0, maxBytes - total));
                        total = maxBytes;
                        await reader.cancel().catch(() => {});
                        break;
                    }
                    chunks.push(value);
                    total += value.length;
                }
            }
            buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)), total);
            mime = res.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || null;
            if (!SUPPORTED_MIMES.has(mime)) throw new Error(`Неподдерживаемый MIME: ${mime}.`);
        }
    }

    const ext = extFromMime(mime);
    const h = hash(buffer);
    const fileName = `${h}.${ext}`;

    // For local files inside root: return the original relative path (model can use it directly).
    if (resolvedPath && isInside(cwd, resolvedPath)) {
        const rel = toPosix(path.relative(cwd, resolvedPath)) || fileName;
        return { rel, abs: resolvedPath, bytes: buffer.length, mime, width: undefined, height: undefined };
    }

    // Otherwise: stage into .ai/refs/
    const targetDir = path.join(cwd, REFS_DIR);
    await mkdir(targetDir, { recursive: true });
    const targetAbs = path.join(targetDir, fileName);
    await writeFile(targetAbs, buffer);

    return {
        rel: toPosix(path.join(REFS_DIR, fileName)),
        abs: targetAbs,
        bytes: buffer.length,
        mime,
        width: undefined,
        height: undefined,
    };
}

/**
 * Stage all reference images for a generation run.
 * Copies outside-root files and downloads URLs into .ai/refs/.
 * Returns { refs: [...], warnings: [...] }.
 *
 * @param {{ images: string[], cwd: string, maxBytes?: number, signal?: AbortSignal, magickPath?: string|null }} request
 * @returns {Promise<{ refs: object[], warnings: string[] }>}
 */
export async function stageReferences({ images, cwd, maxBytes = 20 * 1024 * 1024, signal, magickPath = null }) {
    if (!images?.length) return { refs: [], warnings: [] };

    const refs = [];
    const warnings = [];
    const exe = await detectMagick({ magickPath }).catch(() => null);

    for (const ref of images) {
        try {
            const staged = await stageOneReference(ref, cwd, maxBytes, signal);

            // Try to get dimensions via ImageMagick (optional, non-fatal).
            if (exe) {
                try {
                    const identify = await magickIdentify({ exe, input: staged.abs, cwd, signal });
                    if (identify.width && identify.height) {
                        staged.width = identify.width;
                        staged.height = identify.height;
                    }
                } catch { /* magickIdentify is optional */ }
            }

            refs.push(staged);
        } catch (error) {
            warnings.push(`Референс пропущен: ${ref} (${error.message})`);
        }
    }

    return { refs, warnings };
}

/**
 * Given a raw CLI reference string, return its project-relative path after staging.
 * If already inside the project, returns the relative path; otherwise returns null.
 * Useful for brief generation when no staging is needed (reference already local).
 *
 * @param {string} ref
 * @param {string} cwd
 * @returns {{ rel: string, abs: string } | null}
 */
export function resolveRefPath(ref, cwd) {
    if (ref.startsWith('http://') || ref.startsWith('https://') || ref.startsWith('data:')) return null;
    const abs = path.resolve(cwd, ref);
    if (!isInside(cwd, abs)) return null;
    return { rel: path.relative(cwd, abs), abs };
}

/** Format bytes as human-readable string. */
function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}
