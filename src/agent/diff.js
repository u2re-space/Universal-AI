import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { byteSize, clipMiddle, formatBytes } from '../util/text.js';

const lines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** One unified-diff hunk covering the changed region (common prefix/suffix trimmed, 3 context lines). */
export function diffHunk(before, after) {
  const a = lines(before), b = lines(after);
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const start = Math.max(0, prefix - 3), tail = Math.min(3, suffix);
  const aEnd = a.length - suffix + tail, bEnd = b.length - suffix + tail;
  const render = (mark, line) => `${mark}${line.endsWith('\n') ? line : `${line}\n\\ No newline at end of file\n`}`;
  let out = `@@ -${start + 1},${aEnd - start} +${start + 1},${bEnd - start} @@\n`;
  for (let i = start; i < prefix; i++) out += render(' ', a[i]);
  for (let i = prefix; i < a.length - suffix; i++) out += render('-', a[i]);
  for (let i = prefix; i < b.length - suffix; i++) out += render('+', b[i]);
  for (let i = 0; i < tail; i++) out += render(' ', a[a.length - suffix + i]);
  return out;
}

/**
 * Describe what a toolset changed, for the reviewer: diffs for edits (backup → current),
 * heads of new files, notes for deletions. Bounded by maxBytes.
 */
export async function describeChangeSet({ root, changes = [], maxBytes = 48 * 1024 }) {
  const byPath = new Map();
  for (const change of changes) {
    const entry = byPath.get(change.path) ?? { path: change.path, ops: [], firstBackup: change.backupPath ?? null };
    entry.ops.push(change.op);
    if (!entry.firstBackup && change.backupPath) entry.firstBackup = change.backupPath;
    byPath.set(change.path, entry);
  }
  if (!byPath.size) return 'No files were changed.';
  const blocks = [];
  const perFile = Math.max(2048, Math.floor(maxBytes / byPath.size));
  for (const entry of byPath.values()) {
    const abs = path.join(root, ...entry.path.split('/'));
    const current = await stat(abs).catch(() => null);
    const readText = async (file) => { try { return (await readFile(file)).toString('utf8'); } catch { return null; } };
    let block;
    if (!current) {
      block = `--- ${entry.path} (deleted)`;
    } else if (entry.ops.includes('create') && !entry.firstBackup) {
      const text = (await readText(abs)) ?? '';
      block = `+++ ${entry.path} (new file, ${formatBytes(byteSize(text))})\n${clipMiddle(text, perFile)}`;
    } else {
      const before = entry.firstBackup ? await readText(entry.firstBackup) : null;
      const after = (await readText(abs)) ?? '';
      block = before === null
        ? `~~~ ${entry.path} (modified; previous version unavailable)\n${clipMiddle(after, perFile)}`
        : `--- a/${entry.path}\n+++ b/${entry.path}\n${clipMiddle(diffHunk(before, after), perFile)}`;
    }
    blocks.push(block);
  }
  return blocks.join('\n\n');
}
