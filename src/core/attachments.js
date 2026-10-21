/**
 * @file src/core/attachments.js
 * @module core/attachments
 * @purpose Turn local files, URLs, and data URLs into Responses API input parts, and reject binaries.
 * @depends node:path, node:fs/promises, util/text
 * @usedBy commands/shared, commands/flow, commands/chat, agent/roles, agent/tools, agent/desktop
 * @exports detectImageMime, detectBinary, loadImageAttachment, loadFileAttachment, buildUserMessage, stdinFence
 * @ai.tags attachments, images, base64, urls
 * @ai.hint io
 * @changed 2026-10-22 data: URLs, http(s) downloads, binary rejection.
 */
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { formatBytes } from '../util/text.js';

const IMAGE_MIME_BY_EXT = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};
/** Image types the Responses API accepts as input_image. */
const SUPPORTED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Extensions that are never sent to the model, even when they look like text. */
const BINARY_EXTENSIONS = new Set([
    '.exe', '.dll', '.so', '.dylib', '.bin', '.com', '.msi', '.app', '.o', '.obj', '.a', '.lib', '.class', '.jar', '.war',
    '.apk', '.ipa', '.deb', '.rpm', '.dmg', '.iso', '.img', '.pyc', '.pyo', '.wasm', '.sqlite', '.sqlite3', '.db',
    '.zip', '.gz', '.tar', '.7z', '.rar', '.bz2', '.xz', '.zst', '.tgz', '.cab', '.lz', '.lzma',
    '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.wma', '.mp4', '.avi', '.mkv', '.mov', '.webm', '.wmv', '.flv',
    '.ttf', '.otf', '.woff', '.woff2', '.eot', '.psd', '.ai', '.sketch', '.fig', '.blend', '.fbx', '.stl',
]);

/** Magic bytes of executables, archives, and other binaries that must never reach the model. */
const BINARY_MAGIC = [
    { bytes: [0x4d, 0x5a], kind: 'исполняемый файл (PE/EXE/DLL)' },
    { bytes: [0x7f, 0x45, 0x4c, 0x46], kind: 'исполняемый файл (ELF)' },
    { bytes: [0xcf, 0xfa, 0xed, 0xfe], kind: 'исполняемый файл (Mach-O)' },
    { bytes: [0xce, 0xfa, 0xed, 0xfe], kind: 'исполняемый файл (Mach-O)' },
    { bytes: [0xca, 0xfe, 0xba, 0xbe], kind: 'байткод (Java/Mach-O)' },
    { bytes: [0x50, 0x4b, 0x03, 0x04], kind: 'архив (ZIP/JAR/DOCX)' },
    { bytes: [0x50, 0x4b, 0x05, 0x06], kind: 'архив (ZIP)' },
    { bytes: [0x1f, 0x8b], kind: 'архив (gzip)' },
    { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], kind: 'архив (7z)' },
    { bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], kind: 'архив (RAR)' },
    { bytes: [0x42, 0x5a, 0x68], kind: 'архив (bzip2)' },
    { bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], kind: 'архив (xz)' },
    { bytes: [0x00, 0x61, 0x73, 0x6d], kind: 'модуль WebAssembly' },
    { bytes: [0x00, 0x01, 0x00, 0x00, 0x00], kind: 'шрифт (TrueType)' },
    { bytes: [0x4f, 0x54, 0x54, 0x4f], kind: 'шрифт (OpenType)' },
    { bytes: [0x77, 0x4f, 0x46, 0x46], kind: 'шрифт (WOFF)' },
    { bytes: [0x77, 0x4f, 0x46, 0x32], kind: 'шрифт (WOFF2)' },
];

/** Detect image MIME from magic bytes, falling back to the extension. */
export function detectImageMime(buffer, filename = '') {
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('latin1'))) return 'image/gif';
    if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return IMAGE_MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? null;
}

/**
 * Detect a binary payload that must not be sent to the model.
 * Returns a human-readable kind, or null for text and supported images/PDF.
 * @param {Buffer} buffer
 * @param {string} [filename]
 * @returns {string | null}
 * @exports
 * @ai.hint pure
 */
export function detectBinary(buffer, filename = '') {
    if (!buffer.length) return null;
    const ext = path.extname(String(filename)).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) return `бинарный файл (${ext})`;
    for (const entry of BINARY_MAGIC) {
        if (buffer.length < entry.bytes.length) continue;
        if (!entry.bytes.every((value, index) => buffer[index] === value)) continue;
        return entry.kind;
    }
    // A NUL byte in the first 8 KiB marks a binary stream (UTF-16 text is rare in this tool).
    if (buffer.subarray(0, 8192).includes(0)) return 'бинарные данные (NUL в первых 8 КиБ)';
    return null;
}

const isUrl = (value) => /^https?:\/\//i.test(value);
const isDataUrl = (value) => /^data:/i.test(value);

/**
 * Parse a data: URL into its MIME type and bytes.
 * @param {string} value
 * @returns {{ mime: string, buffer: Buffer }}
 * @ai.hint pure
 */
function parseDataUrl(value) {
    const match = /^data:([^,]*),([\s\S]*)$/i.exec(value);
    if (!match) throw new Error('Некорректный data: URL.');
    const meta = match[1] ?? '';
    const isBase64 = /;\s*base64\s*$/i.test(meta);
    const mime = (meta.replace(/;\s*base64\s*$/i, '').split(';')[0] || 'text/plain').trim().toLowerCase();
    const data = match[2] ?? '';
    let buffer;
    if (isBase64) {
        const clean = data.replace(/\s+/g, '');
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('data: URL содержит некорректный base64.');
        buffer = Buffer.from(clean, 'base64');
    } else {
        try { buffer = Buffer.from(decodeURIComponent(data), 'utf8'); }
        catch { buffer = Buffer.from(data, 'utf8'); }
    }
    return { mime, buffer };
}

/**
 * Strip tags and collapse whitespace so fetched HTML becomes readable text.
 * @param {string} html
 * @returns {string}
 * @ai.hint pure
 */
function htmlToText(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<\/(p|div|br|li|h[1-6]|tr|section|article|pre|blockquote)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/[ 	]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

/**
 * Download a URL with a byte cap and a timeout.
 * @param {string} url
 * @param {{ maxBytes: number, signal?: AbortSignal }} options
 * @returns {Promise<{ buffer: Buffer, mime: string, status: number }>}
 * @ai.hint io
 */
async function fetchUrl(url, { maxBytes, signal }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Таймаут загрузки (45 с).')), 45_000);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        const res = await fetch(url, {
            signal: controller.signal, redirect: 'follow',
            headers: { 'User-Agent': 'ai-agent-cli/1.0', Accept: 'text/html, application/pdf, image/*, text/plain, application/json, */*' },
        });
        const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        const reader = res.body?.getReader();
        const chunks = [];
        let total = 0;
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
                chunks.push(value); total += value.length;
            }
        }
        return { buffer: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total), mime, status: res.status };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

/**
 * Build an `input_image` content part from a local path, an http(s) URL or a data: URL.
 * Local files are embedded as base64 data URLs (the API accepts both forms).
 */
export async function loadImageAttachment(ref, { detail = 'auto', maxBytes = 20 * 1024 * 1024, cwd = process.cwd() } = {}) {
    if (typeof ref !== 'string' || !ref.trim()) throw new Error('Пустая ссылка на изображение.');
    if (isDataUrl(ref)) {
        const { mime, buffer } = parseDataUrl(ref);
        if (!SUPPORTED_IMAGE_MIMES.has(mime)) throw new Error(`data: URL не является поддерживаемым изображением: ${mime || 'без типа'} (нужны PNG, JPEG, GIF или WebP).`);
        if (buffer.length > maxBytes) throw new Error(`Изображение больше лимита ${formatBytes(maxBytes)}.`);
        return { part: { type: 'input_image', image_url: ref, detail }, meta: { source: 'data:', bytes: buffer.length, mime } };
    }
    if (isUrl(ref)) {
        return { part: { type: 'input_image', image_url: ref, detail }, meta: { source: ref, bytes: null, mime: null } };
    }
    const file = path.resolve(cwd, ref);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new Error(`Изображение не найдено: ${ref}`);
    if (info.size > maxBytes) throw new Error(`Изображение ${ref} больше лимита ${formatBytes(maxBytes)}.`);
    const buffer = await readFile(file);
    const mime = detectImageMime(buffer, file);
    if (!mime) throw new Error(`Неподдерживаемый формат изображения: ${ref} (нужны PNG, JPEG, GIF или WebP).`);
    return {
        part: { type: 'input_image', image_url: `data:${mime};base64,${buffer.toString('base64')}`, detail },
        meta: { source: file, bytes: buffer.length, mime },
    };
}

/**
 * Build an input part for a document from a local path, an http(s) URL or a data: URL.
 * PDFs become `input_file` (base64 file_data), text-like files become `input_text` with a header.
 * Images are accepted. Executables, archives, fonts, media, and other binaries are rejected
 * before anything is added to the request.
 */
export async function loadFileAttachment(ref, { maxBytes = 32 * 1024 * 1024, cwd = process.cwd(), signal } = {}) {
    if (typeof ref !== 'string' || !ref.trim()) throw new Error('Пустой путь к файлу.');
    let buffer;
    let name;
    let source = ref;
    let declaredMime = '';

    if (isDataUrl(ref)) {
        const parsed = parseDataUrl(ref);
        buffer = parsed.buffer;
        declaredMime = parsed.mime;
        const suffix = declaredMime === 'application/pdf' ? '.pdf'
            : declaredMime === 'image/jpeg' ? '.jpg'
                : declaredMime === 'image/png' ? '.png'
                    : declaredMime === 'image/gif' ? '.gif'
                        : declaredMime === 'image/webp' ? '.webp'
                            : declaredMime === 'image/svg+xml' ? '.svg' : '.txt';
        name = `data-${Date.now()}${suffix}`;
        source = `data:${declaredMime || 'application/octet-stream'}`;
    } else if (isUrl(ref)) {
        const fetched = await fetchUrl(ref, { maxBytes, signal });
        if (fetched.status >= 400) throw new Error(`HTTP ${fetched.status} при загрузке ${ref}`);
        buffer = fetched.buffer;
        declaredMime = fetched.mime;
        name = path.basename(new URL(ref).pathname) || 'download';
    } else {
        const file = path.resolve(cwd, ref);
        const info = await stat(file).catch(() => null);
        if (!info?.isFile()) throw new Error(`Файл не найден: ${ref}`);
        if (info.size > maxBytes) throw new Error(`Файл ${ref} больше лимита ${formatBytes(maxBytes)}.`);
        buffer = await readFile(file);
        name = path.basename(file);
    }

    if (buffer.length > maxBytes) throw new Error(`Вложение больше лимита ${formatBytes(maxBytes)}.`);

    const ext = path.extname(name).toLowerCase();
    const imageMime = detectImageMime(buffer, name) ?? (SUPPORTED_IMAGE_MIMES.has(declaredMime) ? declaredMime : null);
    if (imageMime) {
        return { part: { type: 'input_image', image_url: `data:${imageMime};base64,${buffer.toString('base64')}`, detail: 'auto' },
            meta: { source, bytes: buffer.length, kind: 'image', mime: imageMime } };
    }
    if (ext === '.pdf' || buffer.subarray(0, 5).toString('latin1') === '%PDF-' || declaredMime === 'application/pdf') {
        return {
            part: { type: 'input_file', filename: name, file_data: `data:application/pdf;base64,${buffer.toString('base64')}` },
            meta: { source, bytes: buffer.length, kind: 'pdf' },
        };
    }
    const binary = detectBinary(buffer, name);
    if (binary) {
        throw new Error(`Бинарный файл не отправляется в модель: ${ref} (${binary}). Поддерживаются изображения, PDF и текстовые файлы.`);
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { throw new Error(`Файл ${ref} не в кодировке UTF-8.`); }
    if (declaredMime === 'text/html' || ext === '.html' || ext === '.htm' || /^\s*<!doctype html/i.test(text.slice(0, 256))) {
        text = htmlToText(text);
    }
    const relative = isUrl(ref) || isDataUrl(ref) ? source : (path.relative(cwd, path.resolve(cwd, ref)) || name);
    return {
        part: { type: 'input_text', text: `--- File: ${relative} (${formatBytes(buffer.length)}) ---\n${text}\n--- End of file: ${relative} ---` },
        meta: { source, bytes: buffer.length, kind: 'text' },
    };
}

/** Compose a user message item from text and attachment parts. */
export function buildUserMessage({ text = '', parts = [] } = {}) {
    const content = [];
    if (text && text.trim()) content.push({ type: 'input_text', text });
    for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        content.push(part);
    }
    if (!content.length) throw new Error('Сообщение пустое: нужен текст или вложение.');
    return { type: 'message', role: 'user', content };
}

/**
 * English fence around stdin that is context rather than the prompt itself.
 * @param {string} text
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function stdinFence(text) {
    return `--- stdin ---\n${text}\n--- end stdin ---`;
}
