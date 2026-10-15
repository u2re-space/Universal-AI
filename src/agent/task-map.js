/**
 * @file src/agent/task-map.js
 * @module agent/task-map
 * @purpose Draft and filter read, edit, and scan marks from a project map's RAM tables. An empty map, or a task with no hits, produces an empty draft.
 * @depends node:path
 * @usedBy agent/team, index.js
 * @exports draftTaskMap, filterTaskMap, formatDraft, formatMarks, formatScan
 * @ai.tags map, tasks
 * @ai.hint pure
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */

import path from 'node:path';

const EDIT_CAP = 12;
const READ_CAP = 20;
const SCAN_CAP = 40;
const ROLES = new Set(['read', 'edit', 'scan']);

/**
 * Words of length 3 or more from `task`, lowercased.
 * `draftTaskMap` uses them as search needles.
 * @param {string} task
 * @returns {string[]}
 * @ai.hint pure
 */
function taskWords(task) {
    if (typeof task !== 'string') return [];
    return task.toLowerCase().split(/[^0-9a-zа-яё]+/i).filter((word) => word.length >= 3);
}

/**
 * True when `text` contains any word in `words`.
 * @param {string} text
 * @param {string[]} words
 * @returns {boolean}
 * @ai.hint pure
 */
function containsWord(text, words) {
    return words.some((word) => text.includes(word));
}

/**
 * `[path, record]` pairs from a map entry, or an empty list when the map has no file table.
 * @param {object | null | undefined} projectMap
 * @returns {Array<[string, object]>}
 * @ai.hint pure
 */
function fileEntries(projectMap) {
    const files = projectMap?.files;
    if (!files || typeof files.entries !== 'function') return [];
    return [...files.entries()];
}

/**
 * True when the path, a path segment, a symbol name, or the raw task text matches `words`.
 * @param {string} filePath
 * @param {object} record
 * @param {string[]} words
 * @param {string} task
 * @returns {boolean}
 * @ai.hint pure
 */
function isEditHit(filePath, record, words, task) {
    if (typeof task === 'string' && task.includes(filePath)) return true;
    const lower = String(filePath).toLowerCase();
    if (containsWord(lower, words) || lower.split('/').some((segment) => containsWord(segment, words))) return true;
    const symbols = Array.isArray(record?.symbols) ? record.symbols : [];
    return symbols.some((symbol) => typeof symbol?.name === 'string' && containsWord(symbol.name.toLowerCase(), words));
}

/**
 * Sort `paths` and keep at most `cap` entries.
 * `draftTaskMap` uses this for the edit, read, and scan caps.
 * @param {string[]} paths
 * @param {number} cap
 * @returns {string[]}
 * @ai.hint pure
 */
function takeSorted(paths, cap) {
    return paths.sort().slice(0, cap);
}

/**
 * Turn paths into `{ path, role, reason }` marks.
 * @param {string[]} paths
 * @param {string} role
 * @param {string} reason
 * @returns {Array<{ path: string, role: string, reason: string }>}
 * @ai.hint pure
 */
function marked(paths, role, reason) {
    return paths.map((filePath) => ({ path: filePath, role, reason }));
}

/**
 * Pick edit, read, and scan marks from the map's RAM tables.
 * `runTeam` shows this draft to the planner.
 * @param {string} task
 * @param {object | null | undefined} projectMap
 * @returns {{ edit: object[], read: object[], scan: object[] }}
 * @exports
 * @ai.hint pure
 */
export function draftTaskMap(task, projectMap) {
    const entries = fileEntries(projectMap);
    const words = taskWords(task);
    const editPaths = takeSorted(
        entries.filter(([filePath, record]) => isEditHit(filePath, record, words, task)).map(([filePath]) => filePath),
        EDIT_CAP,
    );
    const editSet = new Set(editPaths);
    const importedByEdit = new Set();
    for (const filePath of editPaths) {
        const imports = projectMap.files.get(filePath)?.imports;
        if (!Array.isArray(imports)) continue;
        for (const imported of imports) {
            if (typeof imported === 'string') importedByEdit.add(imported);
        }
    }
    const readPaths = takeSorted(
        entries.filter(([filePath, record]) => {
            if (editSet.has(filePath)) return false;
            const imports = Array.isArray(record?.imports) ? record.imports : [];
            return imports.some((imported) => editSet.has(imported)) || importedByEdit.has(filePath);
        }).map(([filePath]) => filePath),
        READ_CAP,
    );
    const readSet = new Set(readPaths);
    const editDirs = new Set(editPaths.map((filePath) => path.posix.dirname(filePath)));
    const scanPaths = takeSorted(
        entries
            .filter(([filePath]) => !editSet.has(filePath) && !readSet.has(filePath) && editDirs.has(path.posix.dirname(filePath)))
            .map(([filePath]) => filePath),
        SCAN_CAP,
    );
    return {
        edit: marked(editPaths, 'edit', 'совпадение с задачей'),
        read: marked(readPaths, 'read', 'импорт рядом с правкой'),
        scan: marked(scanPaths, 'scan', 'тот же каталог'),
    };
}

/**
 * Keep marks whose path is on the map and whose role is read, edit, or scan.
 * `runTeam` calls this with `plan.taskMap`.
 * @param {unknown} entries
 * @param {object | null | undefined} projectMap
 * @returns {Array<{ path: string, role: string, reason: string }>}
 * @exports
 * @ai.hint pure
 */
export function filterTaskMap(entries, projectMap) {
    if (projectMap == null || !Array.isArray(entries)) return [];
    const files = projectMap.files;
    if (!files || typeof files.has !== 'function') return [];
    const kept = [];
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        if (!ROLES.has(entry.role)) continue;
        if (typeof entry.path !== 'string' || !files.has(entry.path)) continue;
        if (typeof entry.reason !== 'string') continue;
        kept.push({ path: entry.path, role: entry.role, reason: entry.reason });
    }
    return kept;
}

/**
 * Render `header` plus one bullet per mark, or `empty` when `items` is empty.
 * `formatDraft` and `formatMarks` call this.
 * @param {string} header
 * @param {string} empty
 * @param {Array<{ path: string, role: string, reason: string }>} items
 * @returns {string}
 * @ai.hint pure
 */
function bulletList(header, empty, items) {
    if (!items.length) return empty;
    return [header, ...items.map((item) => `- ${item.role} ${item.path} — ${item.reason}`)].join('\n');
}

/**
 * Render the draft the planner sees.
 * @param {{ edit?: object[], read?: object[], scan?: object[] }} draft
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function formatDraft(draft) {
    const edit = Array.isArray(draft?.edit) ? draft.edit : [];
    const read = Array.isArray(draft?.read) ? draft.read : [];
    const scan = Array.isArray(draft?.scan) ? draft.scan : [];
    return bulletList('Task map draft:', 'Task map draft: (empty)', [...edit, ...read, ...scan]);
}

/**
 * Render the marks stored on the shared context.
 * `runTeam` calls this after the planner returns.
 * @param {Array<{ path: string, role: string, reason: string }>} marks
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function formatMarks(marks) {
    return bulletList('Task map:', 'Task map: (empty)', Array.isArray(marks) ? marks : []);
}

/**
 * List `kind name` lines for files marked scan.
 * `runTeam` puts this text on the shared context.
 * @param {object | null | undefined} projectMap
 * @param {Array<{ path?: string, role?: string }>} marks
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function formatScan(projectMap, marks) {
    if (!projectMap?.files || typeof projectMap.files.get !== 'function' || !Array.isArray(marks)) return '';
    const lines = [];
    for (const item of marks) {
        if (item?.role !== 'scan' || typeof item.path !== 'string') continue;
        const symbols = projectMap.files.get(item.path)?.symbols;
        if (!Array.isArray(symbols)) continue;
        for (const symbol of symbols) {
            if (!symbol || typeof symbol.name !== 'string' || typeof symbol.kind !== 'string') continue;
            lines.push(`${item.path}:${symbol.line}: ${symbol.kind} ${symbol.name}`);
        }
    }
    return lines.join('\n');
}
