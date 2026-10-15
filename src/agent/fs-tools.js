import path from 'node:path';
import { readFile, writeFile, mkdir, stat, readdir, unlink, copyFile, open } from 'node:fs/promises';
import { resolveInside, NOISY_DIRS } from './paths.js';
import { formatBytes } from '../util/text.js';

const utf8 = new TextDecoder('utf-8', { fatal: true });

async function isBinary(abs, size) {
    const handle = await open(abs, 'r');
    try {
        const sample = Buffer.alloc(Math.min(8192, size));
        const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
        return sample.subarray(0, bytesRead).includes(0);
    } finally { await handle.close(); }
}

/** Copy the current version of a file into the backup directory before it is modified. */
async function backup(abs, rel, backupDir) {
    if (!backupDir) return null;
    const target = path.join(backupDir, ...rel.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    let destination = target;
    let n = 1;
    while (await stat(destination).catch(() => null)) destination = `${target}.${n++}.bak`;
    await copyFile(abs, destination);
    return destination;
}

export async function listFiles({ root, dir = '.', depth = 2, includeHidden = false, maxEntries = 400 }) {
    const { abs, rel } = await resolveInside(root, dir);
    const info = await stat(abs).catch(() => null);
    if (!info) throw new Error(`Каталог не найден: ${dir}`);
    if (!info.isDirectory()) throw new Error(`Не каталог: ${dir}`);
    const lines = [];
    let truncated = false;
    async function walk(current, prefix, level) {
        if (truncated) return;
        let entries;
        try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
        entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
        for (const entry of entries) {
            if (!includeHidden && entry.name.startsWith('.') && entry.name !== '.github') continue;
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (lines.length >= maxEntries) { truncated = true; return; }
            if (entry.isDirectory()) {
                const skip = NOISY_DIRS.test(entry.name);
                lines.push(`${relative}/${skip ? '  (пропущено)' : ''}`);
                if (!skip && level < depth) await walk(path.join(current, entry.name), relative, level + 1);
            } else if (entry.isFile()) {
                const size = await stat(path.join(current, entry.name)).then((s) => s.size).catch(() => 0);
                lines.push(`${relative}  (${formatBytes(size)})`);
            } else if (entry.isSymbolicLink()) {
                lines.push(`${relative}  (symlink)`);
            }
        }
    }
    await walk(abs, rel === '.' ? '' : rel, 1);
    return { text: `${lines.join('\n') || '(пусто)'}${truncated ? `\n…список усечён (${maxEntries} записей)` : ''}`, count: lines.length, truncated };
}

export async function readTextFile({ root, file, startLine = null, endLine = null, maxBytes = 256 * 1024 }) {
    const { abs, rel } = await resolveInside(root, file, { allowRoot: false });
    const info = await stat(abs).catch(() => null);
    if (!info) throw new Error(`Файл не найден: ${file}`);
    if (!info.isFile()) throw new Error(`Не файл: ${file}`);
    if (await isBinary(abs, info.size)) throw new Error(`Бинарный файл (${formatBytes(info.size)}); для изображений используйте view_image.`);
    const buffer = await readFile(abs);
    let text;
    try { text = utf8.decode(buffer); } catch { throw new Error(`Файл ${rel} не в UTF-8.`); }
    const lines = text.split(/\r?\n/);
    const total = lines.length;
    const from = Math.max(1, startLine ?? 1);
    let to = Math.min(total, endLine ?? total);
    if (from > total) throw new Error(`start_line ${from} больше числа строк (${total}).`);
    let selected = lines.slice(from - 1, to);
    let bytes = Buffer.byteLength(selected.join('\n'));
    let truncated = false;
    while (bytes > maxBytes && selected.length > 1) {
        selected = selected.slice(0, Math.max(1, Math.floor(selected.length * (maxBytes / bytes) * 0.9)));
        bytes = Buffer.byteLength(selected.join('\n'));
        truncated = true;
        to = from + selected.length - 1;
    }
    const width = String(to).length;
    const numbered = selected.map((line, index) => `${String(from + index).padStart(width)}| ${line}`).join('\n');
    const header = `# ${rel} — строки ${from}-${to} из ${total}${truncated ? ' (усечено по размеру; запросите диапазон)' : ''}`;
    return { text: `${header}\n${numbered}`, totalLines: total, from, to, bytes: buffer.length, truncated };
}

export async function searchFiles({ root, query, dir = '.', regex = false, maxResults = 60, maxFileBytes = 1024 * 1024 }) {
    if (typeof query !== 'string' || !query) throw new Error('Пустой запрос поиска.');
    const { abs, rel } = await resolveInside(root, dir);
    let matcher;
    if (regex) {
        try { matcher = new RegExp(query, 'i'); } catch (error) { throw new Error(`Некорректное регулярное выражение: ${error.message}`); }
    }
    const results = [];
    let scanned = 0, truncated = false;
    async function walk(current, prefix) {
        if (truncated) return;
        let entries;
        try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (truncated) return;
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (NOISY_DIRS.test(entry.name) || /^\.(ssh|gnupg|aws|azure)$/i.test(entry.name)) continue;
                await walk(path.join(current, entry.name), relative);
            } else if (entry.isFile()) {
                if (/^\.env|\.(pem|key|p12|pfx)$/i.test(entry.name)) continue;
                const full = path.join(current, entry.name);
                const info = await stat(full).catch(() => null);
                if (!info || info.size > maxFileBytes) continue;
                if (await isBinary(full, info.size)) continue;
                let text;
                try { text = utf8.decode(await readFile(full)); } catch { continue; }
                scanned++;
                const lines = text.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const hit = regex ? matcher.test(line) : line.toLowerCase().includes(query.toLowerCase());
                    if (!hit) continue;
                    results.push(`${relative}:${i + 1}: ${line.trim().slice(0, 240)}`);
                    if (results.length >= maxResults) { truncated = true; break; }
                }
            }
        }
    }
    await walk(abs, rel === '.' ? '' : rel);
    return { text: results.length ? `${results.join('\n')}${truncated ? `\n…результаты усечены (${maxResults})` : ''}` : `Совпадений не найдено (просмотрено файлов: ${scanned}).`,
        count: results.length, scanned, truncated };
}

export async function writeTextFile({ root, file, content, overwrite = true, maxBytes = 4 * 1024 * 1024, backupDir = null }) {
    if (typeof content !== 'string') throw new Error('content должен быть строкой.');
    if (Buffer.byteLength(content) > maxBytes) throw new Error(`Содержимое больше лимита ${formatBytes(maxBytes)}.`);
    const { abs, rel } = await resolveInside(root, file, { forWrite: true, allowRoot: false });
    const existing = await stat(abs).catch(() => null);
    if (existing?.isDirectory()) throw new Error(`По этому пути находится каталог: ${rel}`);
    if (existing && !overwrite) throw new Error(`Файл уже существует: ${rel} (overwrite=false).`);
    let backupPath = null;
    if (existing) backupPath = await backup(abs, rel, backupDir);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    return { rel, bytes: Buffer.byteLength(content), created: !existing, backupPath };
}

export async function replaceInFile({ root, file, search, replacement, all = false, maxBytes = 4 * 1024 * 1024, backupDir = null }) {
    if (typeof search !== 'string' || !search) throw new Error('search должен быть непустой строкой.');
    if (typeof replacement !== 'string') throw new Error('replacement должен быть строкой.');
    const { abs, rel } = await resolveInside(root, file, { forWrite: true, allowRoot: false });
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) throw new Error(`Файл не найден: ${file}`);
    if (info.size > maxBytes) throw new Error(`Файл больше лимита ${formatBytes(maxBytes)}.`);
    let text;
    try { text = utf8.decode(await readFile(abs)); } catch { throw new Error(`Файл ${rel} не в UTF-8.`); }
    let count = 0;
    for (let index = text.indexOf(search); index !== -1; index = text.indexOf(search, index + search.length)) count++;
    if (count === 0) {
        // Help the model: CRLF files are common on Windows.
        const normalizedCount = text.replaceAll('\r\n', '\n').split(search.replaceAll('\r\n', '\n')).length - 1;
        throw new Error(normalizedCount > 0
            ? 'Фрагмент не найден из-за различий переводов строк (CRLF/LF); прочитайте файл заново и используйте точный текст.'
            : 'Фрагмент search не найден в файле; прочитайте файл и укажите точный уникальный текст.');
    }
    if (count > 1 && !all) throw new Error(`Фрагмент встречается ${count} раз(а); уточните контекст или укажите all=true.`);
    const updated = all ? text.split(search).join(replacement) : text.replace(search, () => replacement);
    const backupPath = await backup(abs, rel, backupDir);
    await writeFile(abs, updated, 'utf8');
    return { rel, replacements: all ? count : 1, bytes: Buffer.byteLength(updated), backupPath };
}

export async function deleteFile({ root, file, backupDir = null }) {
    const { abs, rel } = await resolveInside(root, file, { forWrite: true, allowRoot: false });
    const info = await stat(abs).catch(() => null);
    if (!info) throw new Error(`Файл не найден: ${file}`);
    if (!info.isFile()) throw new Error('Удалять можно только файлы (не каталоги).');
    const backupPath = await backup(abs, rel, backupDir);
    await unlink(abs);
    return { rel, backupPath };
}

export async function makeDirectory({ root, dir }) {
    const { abs, rel } = await resolveInside(root, dir, { forWrite: true, allowRoot: false });
    await mkdir(abs, { recursive: true });
    return { rel };
}
