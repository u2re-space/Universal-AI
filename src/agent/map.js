/**
 * @file src/agent/map.js
 * @module agent/map
 * @purpose On-disk project index (`.ai/map.json`) and the per-root RAM cache.
 * @depends node:path, node:fs/promises, agent/paths, agent/map-scan
 * @usedBy index.js, commands/map, agent/tools, agent/team
 * @exports projectMapFile, buildProjectMap, loadProjectMap, ensureProjectMap, updateProjectMapPath, countProjectMap, searchMapped
 * @ai.tags index, cache, filesystem
 * @ai.hint io. File text lives only in the LRU. Symbol text is stored on the map.
 * @changed 2026-10-15 Symbol scan moved to agent/map-scan.js. Records keep JSDoc purpose, params, and tags.
 */
import path from 'node:path';
import { readdir, readFile, writeFile, mkdir, stat, open } from 'node:fs/promises';
import { NOISY_DIRS, isProtectedFileName, isForbiddenDirName } from './paths.js';
import { extractSymbols, mayHaveImports, resolveImports } from './map-scan.js';

const TEXT_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_INDEX_BYTES = 1024 * 1024;
const SCOPES = new Set(['path', 'symbol', 'content', 'all']);

/** @type {Map<string, object>} */
const cache = new Map();
/** @type {WeakMap<object, { lru: Map<string, { text: string, bytes: number }>, bytes: number }>} */
const textCaches = new WeakMap();
/** @type {WeakMap<object, Map<string, unknown[]>>} */
const importSpecsByEntry = new WeakMap();
/** @type {WeakMap<object, string>} */
const rootsByEntry = new WeakMap();

/**
 * Absolute path of `.ai/map.json` for a project root.
 * Used by build, load, update, and `ai map` before any read or write.
 * @param {string} root Absolute working directory.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function projectMapFile(root) {
    return path.join(root, '.ai', 'map.json');
}

function normalizeRel(rel) {
    if (typeof rel !== 'string' || rel.includes('\0')) return null;
    const posix = rel.replaceAll('\\', '/');
    const normalized = path.posix.normalize(posix);
    if (!normalized || normalized === '.' || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(rel) || normalized.startsWith('../') || normalized === '..') {
        return null;
    }
    return normalized;
}

function inDir(rel, dir) {
    let normalized = String(dir ?? '.').replaceAll('\\', '/');
    if (normalized.startsWith('./')) normalized = normalized.slice(2);
    normalized = path.posix.normalize(normalized);
    if (normalized === '.' || normalized === '') return true;
    return rel === normalized || rel.startsWith(`${normalized}/`);
}

/**
 * `Stats.mtime` rounds `mtimeMs`. `utimes(Date)` writes that rounded clock time back,
 * so a restored map file no longer has the original fractional `mtimeMs`.
 * @param {import('node:fs').Stats} info
 * @param {number} storedMs
 * @returns {boolean}
 * @ai.hint pure
 */
function sameMapTime(info, storedMs) {
    return info.mtimeMs === storedMs || info.mtime.getTime() === Math.round(storedMs);
}

async function hasNulByte(abs, size) {
    const handle = await open(abs, 'r');
    try {
        const length = Math.min(8192, size);
        const sample = Buffer.alloc(length);
        const { bytesRead } = await handle.read(sample, 0, length, 0);
        return sample.subarray(0, bytesRead).includes(0);
    } finally {
        await handle.close();
    }
}

/**
 * Directories the walker never enters: the map itself, noisy trees, and secret homes.
 * @param {string} name
 * @returns {boolean}
 * @ai.hint pure
 */
function isSkippedDir(name) {
    return name === '.ai' || NOISY_DIRS.test(name) || isForbiddenDirName(name);
}

function skippedRel(rel) {
    const segments = rel.split('/');
    const name = segments.at(-1);
    if (!name || isProtectedFileName(name)) return true;
    return segments.slice(0, -1).some((segment) => isSkippedDir(segment));
}

async function indexFile(root, rel) {
    if (skippedRel(rel)) return null;
    const abs = path.join(root, ...rel.split('/'));
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile() || info.size > MAX_INDEX_BYTES) return null;
    try {
        if (await hasNulByte(abs, info.size)) return null;
    } catch {
        return null;
    }
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(abs));
    } catch {
        return null;
    }
    const { symbols, importSpecs, doc } = extractSymbols(rel, text);
    return { bytes: info.size, mtimeMs: info.mtimeMs, symbols, importSpecs, doc };
}

async function walk(root, dirRel, collected) {
    const dirAbs = dirRel ? path.join(root, ...dirRel.split('/')) : root;
    const entries = await readdir(dirAbs, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (isSkippedDir(entry.name)) continue;
            const child = dirRel ? `${dirRel}/${entry.name}` : entry.name;
            try {
                await walk(root, child, collected);
            } catch {
                // Unreadable nested directories are omitted.
            }
        } else if (entry.isFile()) {
            const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
            const indexed = await indexFile(root, rel);
            if (indexed) collected.push({ rel, ...indexed });
        }
    }
}

function symbolTable(files) {
    const symbols = new Map();
    for (const [rel, record] of files) {
        for (const symbol of record.symbols) {
            const key = String(symbol.name).toLowerCase();
            const hit = { path: rel, kind: symbol.kind, line: symbol.line };
            const list = symbols.get(key);
            if (list) list.push(hit);
            else symbols.set(key, [hit]);
        }
    }
    return symbols;
}

/**
 * Drop unexpected fields so a hand-edited map cannot grow arbitrary objects.
 * @param {object} symbol
 * @returns {object | null}
 * @ai.hint pure
 */
function sanitizeSymbol(symbol) {
    if (!symbol || typeof symbol.name !== 'string' || !symbol.name) return null;
    const item = {
        name: symbol.name,
        kind: typeof symbol.kind === 'string' ? symbol.kind : '',
        line: Number(symbol.line) || 0,
    };
    if (typeof symbol.purpose === 'string' && symbol.purpose) item.purpose = symbol.purpose.slice(0, 240);
    if (symbol.exported === true) item.exported = true;
    if (typeof symbol.hint === 'string' && symbol.hint) item.hint = symbol.hint.slice(0, 160);
    if (Array.isArray(symbol.tags)) {
        const tags = symbol.tags.filter((tag) => typeof tag === 'string' && tag).slice(0, 12);
        if (tags.length) item.tags = tags;
    }
    if (Array.isArray(symbol.params)) {
        const params = symbol.params
            .filter((param) => param && typeof param.name === 'string' && typeof param.type === 'string')
            .slice(0, 16)
            .map((param) => ({ name: param.name, type: param.type }));
        if (params.length) item.params = params;
    }
    if (typeof symbol.returns === 'string' && symbol.returns) item.returns = symbol.returns.slice(0, 80);
    return item;
}

/**
 * @param {object} doc
 * @returns {object | null}
 * @ai.hint pure
 */
function sanitizeDoc(doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
    const item = {};
    for (const key of ['file', 'module', 'purpose', 'hint', 'changed']) {
        if (typeof doc[key] === 'string' && doc[key]) item[key] = doc[key].slice(0, 240);
    }
    for (const key of ['depends', 'usedBy', 'exports', 'tags']) {
        if (!Array.isArray(doc[key])) continue;
        const values = doc[key].filter((value) => typeof value === 'string' && value).slice(0, 40);
        if (values.length) item[key] = values;
    }
    return Object.keys(item).length ? item : null;
}

/**
 * @param {object} record
 * @returns {object}
 * @ai.hint pure
 */
function sanitizeRecord(record) {
    const item = {
        bytes: Number(record?.bytes) || 0,
        mtimeMs: Number(record?.mtimeMs) || 0,
        imports: Array.isArray(record?.imports) ? record.imports : [],
        symbols: Array.isArray(record?.symbols) ? record.symbols.map(sanitizeSymbol).filter(Boolean) : [],
    };
    const doc = sanitizeDoc(record?.doc);
    if (doc) item.doc = doc;
    return item;
}

async function readCachedText(root, entry, rel) {
    const posix = normalizeRel(rel);
    if (!posix) throw new Error(`Путь вне рабочего каталога: ${rel}`);
    const abs = path.join(root, ...posix.split('/'));
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) throw new Error(`Файл не найден: ${rel}`);
    const state = textCaches.get(entry);
    const key = `${posix}\0${info.mtimeMs}`;
    const hit = state.lru.get(key);
    if (hit) {
        state.lru.delete(key);
        state.lru.set(key, hit);
        return hit.text;
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(abs));
    const bytes = Buffer.byteLength(text);
    if (bytes <= TEXT_CACHE_BYTES) {
        while (state.bytes + bytes > TEXT_CACHE_BYTES && state.lru.size > 0) {
            const oldest = state.lru.keys().next().value;
            state.bytes -= state.lru.get(oldest).bytes;
            state.lru.delete(oldest);
        }
        state.lru.set(key, { text, bytes });
        state.bytes += bytes;
    }
    return text;
}

function install(root, map, mtimeMs, importSpecs = new Map()) {
    const files = new Map();
    const rels = Object.keys(map.files ?? {}).sort();
    for (const rel of rels) {
        const record = sanitizeRecord(map.files[rel]);
        map.files[rel] = record;
        files.set(rel, record);
    }
    const entry = {
        map,
        files,
        symbols: null,
        mtimeMs,
        readText(rel) {
            return readCachedText(root, entry, rel);
        },
    };
    entry.symbols = symbolTable(files);
    textCaches.set(entry, { lru: new Map(), bytes: 0 });
    importSpecsByEntry.set(entry, importSpecs);
    rootsByEntry.set(entry, root);
    cache.set(root, entry);
    return entry;
}

async function writeMap(root, map) {
    const file = projectMapFile(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(map, null, 2)}\n`);
    return stat(file);
}

/**
 * Walk the tree, write `.ai/map.json`, and install the RAM entry.
 * Called by `ai map` and by `ensureProjectMap` when the file is missing or invalid.
 * @param {string} root Absolute working directory.
 * @returns {Promise<object>} Map entry with `files`, `symbols`, and `readText`.
 * @exports
 * @ai.hint io
 */
export async function buildProjectMap(root) {
    const collected = [];
    await walk(root, '', collected);
    const keys = new Set(collected.map((item) => item.rel));
    const importSpecs = new Map(collected.map((item) => [item.rel, item.importSpecs]));
    const files = {};
    for (const item of collected.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
        files[item.rel] = {
            bytes: item.bytes,
            mtimeMs: item.mtimeMs,
            imports: resolveImports(item.rel, item.importSpecs, keys),
            symbols: item.symbols,
            ...(item.doc ? { doc: item.doc } : {}),
        };
    }
    const map = { version: 1, builtAt: new Date().toISOString(), files };
    const info = await writeMap(root, map);
    return install(root, map, info.mtimeMs, importSpecs);
}

/**
 * Load the map for `root`. A matching mtime returns the cached entry.
 * @param {string} root Absolute working directory.
 * @param {{ rebuild?: boolean }} [options] Rebuild when the file is missing or not version 1.
 * @returns {Promise<object | null>}
 * @exports
 * @ai.hint io
 */
export async function loadProjectMap(root, { rebuild = false } = {}) {
    const file = projectMapFile(root);
    let info = null;
    try {
        info = await stat(file);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    const cached = cache.get(root);
    if (cached && info && sameMapTime(info, cached.mtimeMs)) return cached;
    if (!info) return rebuild ? buildProjectMap(root) : null;
    let parsed = null;
    try {
        parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch {
        parsed = null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 1) {
        return rebuild ? buildProjectMap(root) : null;
    }
    if (!parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) parsed.files = {};
    return install(root, parsed, info.mtimeMs);
}

/**
 * Load or rebuild. Disk errors become `{ error }` so a team run can continue without a map.
 * Used by `runTeam` before it drafts read/edit/scan marks.
 * @param {string} root
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function ensureProjectMap(root) {
    try {
        return await loadProjectMap(root, { rebuild: true });
    } catch (error) {
        return { error };
    }
}

/**
 * Reindex one relative path and refresh import edges that pointed at it.
 * Called after `write_file`, `replace_text`, and `delete_file`.
 * @param {string} root
 * @param {string} rel Path relative to `root`.
 * @returns {Promise<void>}
 * @exports
 * @ai.hint io
 */
export async function updateProjectMapPath(root, rel) {
    const file = projectMapFile(root);
    try {
        await stat(file);
    } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
    }
    const current = await loadProjectMap(root, { rebuild: false });
    if (!current) return;
    const posix = normalizeRel(rel);
    if (!posix) return;
    const map = structuredClone(current.map);
    if (!map.files || typeof map.files !== 'object' || Array.isArray(map.files)) map.files = {};
    const specs = new Map(importSpecsByEntry.get(current) ?? []);
    const indexed = await indexFile(root, posix);
    if (!indexed) {
        delete map.files[posix];
        specs.delete(posix);
    } else {
        specs.set(posix, indexed.importSpecs);
        map.files[posix] = {
            bytes: indexed.bytes,
            mtimeMs: indexed.mtimeMs,
            imports: [],
            symbols: indexed.symbols,
            ...(indexed.doc ? { doc: indexed.doc } : {}),
        };
    }
    const keys = new Set(Object.keys(map.files));
    for (const fileRel of keys) {
        if (!specs.has(fileRel) && mayHaveImports(fileRel)) {
            const reread = await indexFile(root, fileRel);
            specs.set(fileRel, reread?.importSpecs ?? []);
        }
        map.files[fileRel].imports = resolveImports(fileRel, specs.get(fileRel) ?? [], keys);
    }
    map.version = 1;
    map.builtAt = new Date().toISOString();
    const info = await writeMap(root, map);
    install(root, map, info.mtimeMs, specs);
}

/**
 * Counts for the `ai map` status line.
 * @param {{ files: Map<string, { symbols?: object[] }> }} projectMap
 * @returns {{ files: number, symbols: number }}
 * @exports
 * @ai.hint pure
 */
export function countProjectMap(projectMap) {
    let symbols = 0;
    for (const file of projectMap.files.values()) symbols += Array.isArray(file.symbols) ? file.symbols.length : 0;
    return { files: projectMap.files.size, symbols };
}

/**
 * Search the RAM index. `path` and `symbol` do not read file bytes.
 * `content` reads through the LRU. Symbol hits also match `@purpose`, `@ai.hint`, and `@ai.tags`.
 * Used by `search_files` when `.ai/map.json` is loaded.
 * @param {object} projectMap Entry from `loadProjectMap`.
 * @param {{ query: string, dir?: string, scope?: string, regex?: boolean, maxResults?: number }} options
 * @returns {Promise<{ text: string, count: number }>}
 * @exports
 * @ai.hint io
 */
export async function searchMapped(projectMap, { query, dir = '.', scope = 'all', regex = false, maxResults = 60 } = {}) {
    if (typeof query !== 'string' || query.length === 0) throw new Error('Пустой запрос поиска.');
    const scopeName = scope ?? 'all';
    if (!SCOPES.has(scopeName)) throw new Error('scope: path, symbol, content или all.');
    const needle = query.toLowerCase();
    const lines = [];
    let truncated = false;
    const under = [...projectMap.files.keys()].filter((rel) => inDir(rel, dir)).sort();
    const appeared = [];
    const seen = new Set();

    const push = (line, rel) => {
        if (lines.length >= maxResults) {
            truncated = true;
            return false;
        }
        lines.push(line);
        if (rel && !seen.has(rel)) {
            seen.add(rel);
            appeared.push(rel);
        }
        return true;
    };

    if (scopeName === 'path' || scopeName === 'all') {
        for (const rel of under) {
            if (!rel.toLowerCase().includes(needle)) continue;
            if (!push(rel, rel)) break;
        }
    }

    if (!truncated && (scopeName === 'symbol' || scopeName === 'all')) {
        let stop = false;
        for (const rel of under) {
            if (stop) break;
            const record = projectMap.files.get(rel);
            const doc = record.doc;
            if (doc) {
                const docHay = [doc.purpose, doc.module, doc.hint, doc.changed, ...(doc.tags ?? []), ...(doc.exports ?? [])].join('\n').toLowerCase();
                if (docHay.includes(needle) && !push(`${rel}:1: module ${doc.module || doc.purpose || rel}`, rel)) {
                    stop = true;
                    break;
                }
            }
            for (const symbol of record.symbols) {
                const hay = [symbol.name, symbol.purpose, symbol.hint, ...(symbol.tags ?? [])].join('\n').toLowerCase();
                if (!hay.includes(needle)) continue;
                const note = symbol.purpose ? ` — ${symbol.purpose}` : '';
                if (!push(`${rel}:${symbol.line}: ${symbol.kind} ${symbol.name}${note}`, rel)) {
                    stop = true;
                    break;
                }
            }
        }
    }

    if (!truncated && (scopeName === 'content' || scopeName === 'all')) {
        const contentFiles = scopeName === 'content' || appeared.length === 0 ? under : appeared;
        let matcher = null;
        if (regex) {
            try {
                matcher = new RegExp(query, 'i');
            } catch (error) {
                throw new Error(`Некорректное регулярное выражение: ${error.message}`);
            }
        }
        let stop = false;
        for (const rel of contentFiles) {
            if (stop) break;
            let text;
            try {
                const root = rootsByEntry.get(projectMap);
                if (root) {
                    const info = await stat(path.join(root, ...rel.split('/'))).catch(() => null);
                    if (!info?.isFile() || info.size > MAX_INDEX_BYTES) continue;
                }
                text = await projectMap.readText(rel);
            } catch {
                continue;
            }
            const fileLines = text.split(/\r?\n/);
            for (let index = 0; index < fileLines.length; index++) {
                const line = fileLines[index];
                const hit = matcher ? matcher.test(line) : line.toLowerCase().includes(needle);
                if (!hit) continue;
                if (!push(`${rel}:${index + 1}: ${line.trim().slice(0, 240)}`)) {
                    stop = true;
                    break;
                }
            }
        }
    }

    const text = `${lines.join('\n')}${truncated ? `\n…результаты усечены (${maxResults})` : ''}`;
    return { text, count: lines.length };
}
