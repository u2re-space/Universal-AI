/**
 * On-disk project index (.ai/map.json) and the per-working-directory RAM cache.
 * Symbols and relative imports are line regexes. File text lives only in the LRU.
 */
import path from 'node:path';
import { readdir, readFile, writeFile, mkdir, stat, open } from 'node:fs/promises';
import { NOISY_DIRS, isProtectedFileName, isForbiddenDirName } from './paths.js';

const TEXT_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_INDEX_BYTES = 1024 * 1024;
const JS_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx']);
const SCOPES = new Set(['path', 'symbol', 'content', 'all']);
const JS_SYMBOLS = [
  [/^\s*export\s+function\s+([A-Za-z_$][\w$]*)/, 'export'],
  [/^\s*export\s+class\s+([A-Za-z_$][\w$]*)/, 'export'],
  [/^\s*export\s+const\s+([A-Za-z_$][\w$]*)/, 'export'],
  [/^\s*export\s*\{\s*([A-Za-z_$][\w$]*)/, 'export'],
  [/^\s*function\s+([A-Za-z_$][\w$]*)/, 'function'],
  [/^\s*class\s+([A-Za-z_$][\w$]*)/, 'class'],
];
const PY_SYMBOLS = [
  [/^\s*def\s+([A-Za-z_][\w]*)/, 'function'],
  [/^\s*class\s+([A-Za-z_][\w]*)/, 'class'],
];
const GO_SYMBOLS = [
  [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/, 'function'],
  [/^\s*type\s+([A-Za-z_][\w]*)\s+struct\b/, 'class'],
];
const RS_SYMBOLS = [
  [/^\s*pub\s+fn\s+([A-Za-z_][\w]*)/, 'export'],
  [/^\s*pub\s+struct\s+([A-Za-z_][\w]*)/, 'export'],
  [/^\s*pub\s+enum\s+([A-Za-z_][\w]*)/, 'export'],
  [/^\s*fn\s+([A-Za-z_][\w]*)/, 'function'],
  [/^\s*struct\s+([A-Za-z_][\w]*)/, 'class'],
  [/^\s*enum\s+([A-Za-z_][\w]*)/, 'class'],
];

/** @type {Map<string, object>} */
const cache = new Map();
/** @type {WeakMap<object, { lru: Map<string, { text: string, bytes: number }>, bytes: number }>} */
const textCaches = new WeakMap();
/** @type {WeakMap<object, Map<string, unknown[]>>} */
const importSpecsByEntry = new WeakMap();
/** @type {WeakMap<object, string>} */
const rootsByEntry = new WeakMap();

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
 */
function sameMapTime(info, storedMs) {
  return info.mtimeMs === storedMs || info.mtime.getTime() === Math.round(storedMs);
}

function matchSymbol(line, patterns) {
  for (const [pattern, kind] of patterns) {
    const match = pattern.exec(line);
    if (match) return { name: match[1], kind };
  }
  return null;
}

function jsImportSpecs(text) {
  const specs = [];
  const patterns = [
    /\bfrom\s+(['"])(\.[^'"]*)\1/g,
    /\bimport\s+(['"])(\.[^'"]*)\1/g,
    /\brequire\(\s*(['"])(\.[^'"]*)\1\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) specs.push(match[2]);
  }
  return specs;
}

function pythonImportSpecs(text) {
  const specs = [];
  for (const match of text.matchAll(/^\s*from\s+(\.+)([A-Za-z_][\w]*)\s+import\b/gm)) {
    specs.push({ dots: match[1], name: match[2] });
  }
  return specs;
}

function extractSymbols(rel, text) {
  const ext = path.posix.extname(rel).toLowerCase();
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.split(/\r?\n/);
  const symbols = [];
  let patterns = null;
  if (JS_EXTS.has(ext)) patterns = JS_SYMBOLS;
  else if (ext === '.py') patterns = PY_SYMBOLS;
  else if (ext === '.go') patterns = GO_SYMBOLS;
  else if (ext === '.rs') patterns = RS_SYMBOLS;
  if (patterns) {
    for (let index = 0; index < lines.length; index++) {
      const symbol = matchSymbol(lines[index], patterns);
      if (symbol) symbols.push({ name: symbol.name, kind: symbol.kind, line: index + 1 });
    }
  }
  let importSpecs = [];
  if (JS_EXTS.has(ext)) importSpecs = jsImportSpecs(source);
  else if (ext === '.py') importSpecs = pythonImportSpecs(source);
  return { symbols, importSpecs };
}

function jsCandidates(fromRel, spec) {
  const dir = path.posix.dirname(fromRel);
  const joined = path.posix.normalize(path.posix.join(dir, spec));
  if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) return [];
  if (joined === '.') return ['index.js'];
  return ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '/index.js'].map((suffix) => `${joined}${suffix}`);
}

function pythonCandidate(fromRel, spec) {
  let dir = path.posix.dirname(fromRel);
  for (let extra = 1; extra < spec.dots.length; extra++) {
    if (dir === '.' || dir === '') return null;
    dir = path.posix.dirname(dir);
  }
  const file = `${spec.name}.py`;
  return dir === '.' ? file : path.posix.join(dir, file);
}

function resolveImports(rel, importSpecs, keys) {
  const kept = new Set();
  for (const spec of importSpecs) {
    if (typeof spec === 'string') {
      for (const candidate of jsCandidates(rel, spec)) {
        if (keys.has(candidate)) kept.add(candidate);
      }
    } else if (spec && typeof spec.dots === 'string' && typeof spec.name === 'string') {
      const candidate = pythonCandidate(rel, spec);
      if (candidate && keys.has(candidate)) kept.add(candidate);
    }
  }
  return [...kept].sort();
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

function isSkippedDir(name) {
  return name === '.ai' || NOISY_DIRS.test(name) || isForbiddenDirName(name);
}

function mayHaveImports(rel) {
  const ext = path.posix.extname(rel).toLowerCase();
  return JS_EXTS.has(ext) || ext === '.py';
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
  const { symbols, importSpecs } = extractSymbols(rel, text);
  return { bytes: info.size, mtimeMs: info.mtimeMs, symbols, importSpecs };
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

function sanitizeRecord(record) {
  return {
    bytes: Number(record?.bytes) || 0,
    mtimeMs: Number(record?.mtimeMs) || 0,
    imports: Array.isArray(record?.imports) ? record.imports : [],
    symbols: Array.isArray(record?.symbols) ? record.symbols : [],
  };
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
    };
  }
  const map = { version: 1, builtAt: new Date().toISOString(), files };
  const info = await writeMap(root, map);
  return install(root, map, info.mtimeMs, importSpecs);
}

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

export async function ensureProjectMap(root) {
  try {
    return await loadProjectMap(root, { rebuild: true });
  } catch (error) {
    return { error };
  }
}

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

export function countProjectMap(projectMap) {
  let symbols = 0;
  for (const file of projectMap.files.values()) symbols += Array.isArray(file.symbols) ? file.symbols.length : 0;
  return { files: projectMap.files.size, symbols };
}

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
      for (const symbol of projectMap.files.get(rel).symbols) {
        if (!String(symbol.name).toLowerCase().includes(needle)) continue;
        if (!push(`${rel}:${symbol.line}: ${symbol.kind} ${symbol.name}`, rel)) {
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
