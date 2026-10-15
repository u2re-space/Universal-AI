/**
 * @file src/agent/map-scan.js
 * @module agent/map-scan
 * @purpose Read one source text and list symbols, JSDoc tags, and relative imports.
 * @depends node:path
 * @usedBy agent/map
 * @exports extractSymbols, resolveImports, mayHaveImports
 * @ai.tags index, jsdoc, symbols
 * @ai.hint pure
 * @changed 2026-10-15 Split out of agent/map.js. JS symbols now keep purpose, params, and @ai tags.
 */

import path from 'node:path';

const JS_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx']);

/** Line patterns. The first match wins. `export async function` is an export, not a plain function. */
const JS_SYMBOLS = [
    [/^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, 'export'],
    [/^\s*export\s+class\s+([A-Za-z_$][\w$]*)/, 'export'],
    [/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, 'export'],
    [/^\s*export\s*\{([^}]+)\}/, 'export-list'],
    [/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, 'function'],
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

const CLIP = { purpose: 240, hint: 160, changed: 240, returns: 80 };

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 * @ai.hint pure
 */
function clip(text, max) {
    const value = String(text).replace(/\s+/g, ' ').trim();
    return value.length > max ? value.slice(0, max) : value;
}

/**
 * Take a `{type}` prefix, including one level of `<...>` and nested braces.
 * @param {string} text
 * @returns {{ type: string, rest: string } | null}
 * @ai.hint pure
 */
function takeBraceType(text) {
    if (!text.startsWith('{')) return null;
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') {
            depth -= 1;
            if (depth === 0) return { type: text.slice(1, i).trim(), rest: text.slice(i + 1).trim() };
        }
    }
    return null;
}

/**
 * Turn the inside of a block comment into tag fields.
 * A bare paragraph becomes `purpose` when `@purpose` is absent.
 * @param {string} body
 * @returns {object}
 * @ai.hint pure
 */
function parseDoc(body) {
    const tags = {};
    const prose = [];
    let current = null;
    for (const raw of body.split('\n')) {
        const line = raw.replace(/^\s*\*\s?/, '').trim();
        if (!line) {
            current = null;
            continue;
        }
        const tag = /^@([\w.-]+)(?:\s+([\s\S]*))?$/.exec(line);
        if (!tag) {
            if (current && typeof tags[current] === 'string') tags[current] += ` ${line}`;
            else if (!current) prose.push(line);
            continue;
        }
        current = tag[1];
        const value = (tag[2] ?? '').trim();
        if (current === 'param') {
            const typed = takeBraceType(value);
            if (!typed) continue;
            const name = typed.rest.replace(/^\[/, '').split(/[\s=\]]/)[0];
            if (!name) continue;
            tags.params ??= [];
            tags.params.push({ name, type: typed.type });
            current = null;
        } else if (current === 'returns' || current === 'return') {
            const typed = takeBraceType(value);
            tags.returns = typed ? typed.type : value;
            current = 'returns';
        } else if (current === 'exports') {
            tags.exports = true;
            if (value) tags.exportNames = value.split(/[, ]+/).filter(Boolean);
            current = null;
        } else if (current === 'ai.tags' || current === 'tags') {
            tags.tags = value.split(/[, ]+/).filter(Boolean);
            current = null;
        } else if (current === 'ai.hint' || current === 'hint') {
            tags.hint = value;
            current = 'hint';
        } else if (current === 'depends' || current === 'usedBy') {
            tags[current] = value.split(/[, ]+/).filter(Boolean);
            current = null;
        } else {
            tags[current] = value;
        }
    }
    if (!tags.purpose && prose.length) tags.purpose = prose.join(' ');
    return tags;
}

/**
 * Keep only the fields the on-disk map should store for a file.
 * @param {object} parsed
 * @returns {object | null}
 * @ai.hint pure
 */
function fileDoc(parsed) {
    const doc = {};
    if (parsed.file) doc.file = clip(parsed.file, CLIP.purpose);
    if (parsed.module) doc.module = clip(parsed.module, 120);
    if (parsed.purpose) doc.purpose = clip(parsed.purpose, CLIP.purpose);
    if (parsed.depends?.length) doc.depends = parsed.depends.slice(0, 24);
    if (parsed.usedBy?.length) doc.usedBy = parsed.usedBy.slice(0, 24);
    if (parsed.exportNames?.length) doc.exports = parsed.exportNames.slice(0, 40);
    if (parsed.tags?.length) doc.tags = parsed.tags.slice(0, 12);
    if (parsed.hint) doc.hint = clip(parsed.hint, CLIP.hint);
    if (parsed.changed) doc.changed = clip(parsed.changed, CLIP.changed);
    return Object.keys(doc).length ? doc : null;
}

/**
 * @param {object} doc
 * @param {{ name: string, kind: string, line: number }} found
 * @returns {object}
 * @ai.hint pure
 */
function symbolRecord(doc, found) {
    const item = { name: found.name, kind: found.kind, line: found.line };
    if (doc?.purpose) item.purpose = clip(doc.purpose, CLIP.purpose);
    if (found.kind === 'export' || doc?.exports) item.exported = true;
    if (doc?.hint) item.hint = clip(doc.hint, CLIP.hint);
    if (doc?.tags?.length) item.tags = doc.tags.slice(0, 12);
    if (doc?.params?.length) item.params = doc.params.slice(0, 16);
    if (doc?.returns) item.returns = clip(doc.returns, CLIP.returns);
    return item;
}

/**
 * @param {string} line
 * @param {Array<[RegExp, string]>} patterns
 * @returns {Array<{ name: string, kind: string }>}
 * @ai.hint pure
 */
function matchSymbol(line, patterns) {
    for (const [pattern, kind] of patterns) {
        const match = pattern.exec(line);
        if (!match) continue;
        if (kind === 'export-list') {
            const names = [];
            for (const part of match[1].split(',')) {
                const bits = part.trim().split(/\s+as\s+/);
                const name = (bits[1] || bits[0] || '').trim();
                if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push({ name, kind: 'export' });
            }
            return names;
        }
        return [{ name: match[1], kind }];
    }
    return [];
}

/**
 * Walk JS lines. A block comment sticks to the next declaration.
 * The first block comment in the file is the module card.
 * @param {string} source
 * @returns {{ symbols: object[], doc: object | null }}
 * @ai.hint pure
 */
function scanJs(source) {
    const lines = source.split(/\r?\n/);
    const symbols = [];
    let doc = null;
    let pending = null;
    let seenCode = false;
    let block = null;

    const finishBlock = (body, atLine) => {
        const parsed = parseDoc(body);
        if (!seenCode && !doc) doc = fileDoc(parsed);
        pending = { parsed, atLine };
    };

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (block) {
            const end = line.indexOf('*/');
            if (end === -1) {
                block.lines.push(line);
                continue;
            }
            block.lines.push(line.slice(0, end));
            finishBlock(block.lines.join('\n'), index);
            block = null;
            continue;
        }
        const open = line.indexOf('/**');
        if (open !== -1 && !line.slice(0, open).includes('//')) {
            const rest = line.slice(open + 3);
            const end = rest.indexOf('*/');
            if (end === -1) {
                block = { lines: [rest] };
                continue;
            }
            finishBlock(rest.slice(0, end), index);
            continue;
        }
        if (!line.trim() || line.trim().startsWith('//')) continue;
        seenCode = true;
        const found = matchSymbol(line, JS_SYMBOLS);
        if (found.length && pending) {
            for (const item of found) symbols.push(symbolRecord(pending.parsed, { ...item, line: index + 1 }));
            pending = null;
            continue;
        }
        pending = null;
        for (const item of found) symbols.push(symbolRecord(null, { ...item, line: index + 1 }));
    }
    return { symbols, doc };
}

/**
 * Relative import specifiers (`./`, `../`) in JS, plus dotted Python imports.
 * @param {string} rel Project-relative path.
 * @param {string} text File text. A leading BOM is ignored.
 * @returns {{ symbols: object[], importSpecs: Array<string | { dots: string, name: string }>, doc: object | null }}
 * @exports
 * @ai.hint pure
 */
export function extractSymbols(rel, text) {
    const ext = path.posix.extname(rel).toLowerCase();
    const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    let symbols = [];
    let doc = null;
    let patterns = null;
    if (JS_EXTS.has(ext)) {
        const scanned = scanJs(source);
        symbols = scanned.symbols;
        doc = scanned.doc;
    } else if (ext === '.py') patterns = PY_SYMBOLS;
    else if (ext === '.go') patterns = GO_SYMBOLS;
    else if (ext === '.rs') patterns = RS_SYMBOLS;
    if (patterns) {
        const lines = source.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
            for (const item of matchSymbol(lines[index], patterns)) {
                symbols.push({ name: item.name, kind: item.kind, line: index + 1 });
            }
        }
    }
    let importSpecs = [];
    if (JS_EXTS.has(ext)) importSpecs = jsImportSpecs(source);
    else if (ext === '.py') importSpecs = pythonImportSpecs(source);
    return { symbols, importSpecs, doc };
}

/**
 * @param {string} text
 * @returns {string[]}
 * @ai.hint pure
 */
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

/**
 * @param {string} text
 * @returns {Array<{ dots: string, name: string }>}
 * @ai.hint pure
 */
function pythonImportSpecs(text) {
    const specs = [];
    for (const match of text.matchAll(/^\s*from\s+(\.+)([A-Za-z_][\w]*)\s+import\b/gm)) {
        specs.push({ dots: match[1], name: match[2] });
    }
    return specs;
}

/**
 * @param {string} fromRel
 * @param {string} spec
 * @returns {string[]}
 * @ai.hint pure
 */
function jsCandidates(fromRel, spec) {
    const dir = path.posix.dirname(fromRel);
    const joined = path.posix.normalize(path.posix.join(dir, spec));
    if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) return [];
    if (joined === '.') return ['index.js'];
    return ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '/index.js'].map((suffix) => `${joined}${suffix}`);
}

/**
 * @param {string} fromRel
 * @param {{ dots: string, name: string }} spec
 * @returns {string | null}
 * @ai.hint pure
 */
function pythonCandidate(fromRel, spec) {
    let dir = path.posix.dirname(fromRel);
    for (let extra = 1; extra < spec.dots.length; extra++) {
        if (dir === '.' || dir === '') return null;
        dir = path.posix.dirname(dir);
    }
    const file = `${spec.name}.py`;
    return dir === '.' ? file : path.posix.join(dir, file);
}

/**
 * Keep import targets that exist in this project map.
 * @param {string} rel
 * @param {Array<string | { dots: string, name: string }>} importSpecs
 * @param {Set<string>} keys
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function resolveImports(rel, importSpecs, keys) {
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

/**
 * JS and Python files may import a path that was just deleted, so their edges are recomputed.
 * @param {string} rel
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function mayHaveImports(rel) {
    const ext = path.posix.extname(rel).toLowerCase();
    return JS_EXTS.has(ext) || ext === '.py';
}
