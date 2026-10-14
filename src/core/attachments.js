import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { formatBytes } from '../util/text.js';

const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.toml', '.ini', '.csv', '.tsv',
  '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java',
  '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.ps1', '.bat', '.sql', '.log', '.env.example', '.svg']);

/** Detect image MIME from magic bytes, falling back to the extension. */
export function detectImageMime(buffer, filename = '') {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return IMAGE_MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? null;
}

const isUrl = (value) => /^https?:\/\//i.test(value);
const isDataUrl = (value) => /^data:[a-z]+\/[a-z0-9.+-]+;base64,/i.test(value);

/**
 * Build an `input_image` content part from a local path, an http(s) URL or a data: URL.
 * Local files are embedded as base64 data URLs (the API accepts both forms).
 */
export async function loadImageAttachment(ref, { detail = 'auto', maxBytes = 20 * 1024 * 1024, cwd = process.cwd() } = {}) {
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('Пустая ссылка на изображение.');
  if (isUrl(ref) || isDataUrl(ref)) {
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
 * Build an input part for a document: PDFs become `input_file` (base64 file_data), text-like files
 * become `input_text` with a header. Other binary files are rejected.
 */
export async function loadFileAttachment(ref, { maxBytes = 32 * 1024 * 1024, cwd = process.cwd() } = {}) {
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('Пустой путь к файлу.');
  if (isUrl(ref)) {
    return { part: { type: 'input_file', file_url: ref }, meta: { source: ref, bytes: null, kind: 'url' } };
  }
  const file = path.resolve(cwd, ref);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error(`Файл не найден: ${ref}`);
  if (info.size > maxBytes) throw new Error(`Файл ${ref} больше лимита ${formatBytes(maxBytes)}.`);
  const buffer = await readFile(file);
  const ext = path.extname(file).toLowerCase();
  const name = path.basename(file);
  if (ext === '.pdf' || buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    return {
      part: { type: 'input_file', filename: name, file_data: `data:application/pdf;base64,${buffer.toString('base64')}` },
      meta: { source: file, bytes: buffer.length, kind: 'pdf' },
    };
  }
  const imageMime = detectImageMime(buffer, file);
  if (imageMime) {
    return { part: { type: 'input_image', image_url: `data:${imageMime};base64,${buffer.toString('base64')}`, detail: 'auto' },
      meta: { source: file, bytes: buffer.length, kind: 'image', mime: imageMime } };
  }
  const looksText = TEXT_EXTENSIONS.has(ext) || !buffer.subarray(0, 8192).includes(0);
  if (!looksText) throw new Error(`Бинарный файл не поддерживается как вложение: ${ref}`);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Error(`Файл ${ref} не в кодировке UTF-8.`); }
  const relative = path.relative(cwd, file) || name;
  return {
    part: { type: 'input_text', text: `--- Файл: ${relative} (${formatBytes(buffer.length)}) ---\n${text}\n--- Конец файла: ${relative} ---` },
    meta: { source: file, bytes: buffer.length, kind: 'text' },
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
