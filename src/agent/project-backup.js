/**
 * @file src/agent/project-backup.js
 * @module agent/project-backup
 * @purpose Project-local snapshots in `.backup`, one record per overwritten or deleted file.
 * @depends node:path, node:fs/promises
 * @usedBy agent/fs-tools, agent/tools
 * @exports backupId, saveProjectBackup, listProjectBackups, restoreProjectBackup
 * @ai.tags filesystem, backup
 * @ai.hint io
 * @changed 2026-10-16 Restore a file from the step that overwrote it.
 */
import path from 'node:path';
import { appendFile, copyFile, mkdir, readFile, stat } from 'node:fs/promises';

/**
 * Short id for one snapshot. `salt` keeps two calls in the same millisecond apart.
 * @param {number} [now]
 * @param {string} [salt]
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function backupId(now = Date.now(), salt = Math.random().toString(36).slice(2, 6)) {
    return `b${now.toString(36)}${salt}`;
}

/**
 * Slot label safe to store. Empty input becomes `write`.
 * @param {string} slot
 * @returns {string}
 * @ai.hint pure
 */
function cleanSlot(slot) {
    const cleaned = String(slot ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
    return cleaned || 'write';
}

/**
 * Copy the current file into `.backup/<id>/` and append one index line.
 * The record is the contents from before `slot` changes the file. Returns null for `.backup` itself.
 * @param {{ root: string, rel: string, abs: string, slot?: string, now?: number, salt?: string }} request
 * @returns {Promise<{ id: string, slot: string, path: string, bytes: number } | null>}
 * @exports
 * @ai.hint io
 */
export async function saveProjectBackup({ root, rel, abs, slot = 'write', now, salt }) {
    const posix = String(rel).replace(/\\/g, '/');
    if (!posix || posix === '.backup' || posix.startsWith('.backup/')) return null;
    const id = backupId(now, salt);
    const dest = path.join(root, '.backup', id, ...posix.split('/'));
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(abs, dest);
    const bytes = (await stat(abs)).size;
    const record = { id, slot: cleanSlot(slot), path: posix, bytes };
    await appendFile(path.join(root, '.backup', 'index.jsonl'), `${JSON.stringify(record)}\n`);
    return record;
}

/**
 * Read the index. A broken line is skipped.
 * @param {string} root
 * @returns {Promise<object[]>}
 * @ai.hint io
 */
async function readIndex(root) {
    const text = await readFile(path.join(root, '.backup', 'index.jsonl'), 'utf8').catch(() => '');
    const records = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const record = JSON.parse(line);
            if (record && typeof record.id === 'string' && typeof record.path === 'string') records.push(record);
        } catch { /* a torn line does not hide the others */ }
    }
    return records;
}

/**
 * Snapshots for one file, or the latest records in the project. Newest last.
 * @param {{ root: string, file?: string | null, limit?: number }} request
 * @returns {Promise<object[]>}
 * @exports
 * @ai.hint io
 */
export async function listProjectBackups({ root, file = null, limit = 40 }) {
    const wanted = file ? String(file).replace(/\\/g, '/') : null;
    const records = (await readIndex(root)).filter((record) => !wanted || record.path === wanted);
    return records.slice(-Math.max(1, limit));
}

/**
 * Copy a snapshot back over the project file. The current bytes are snapshotted first.
 * @param {{ root: string, id: string, file?: string | null }} request
 * @returns {Promise<{ id: string, path: string, slot: string, replaced: string | null }>}
 * @exports
 * @ai.hint io
 */
export async function restoreProjectBackup({ root, id, file = null }) {
    const records = await readIndex(root);
    const record = records.find((item) => item.id === id);
    if (!record) throw new Error(`Снимок не найден: ${id}`);
    const wanted = file ? String(file).replace(/\\/g, '/') : record.path;
    if (wanted !== record.path) throw new Error(`Снимок ${id} хранит ${record.path}, не ${wanted}.`);
    const source = path.join(root, '.backup', record.id, ...record.path.split('/'));
    if (!await stat(source).then((info) => info.isFile()).catch(() => false)) throw new Error(`Файл снимка отсутствует: ${id}`);
    const dest = path.join(root, ...record.path.split('/'));
    let replaced = null;
    if (await stat(dest).then((info) => info.isFile()).catch(() => false)) {
        const prior = await saveProjectBackup({ root, rel: record.path, abs: dest, slot: `before-${record.id}` });
        replaced = prior?.id ?? null;
    }
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(source, dest);
    return { id: record.id, path: record.path, slot: record.slot, replaced };
}
