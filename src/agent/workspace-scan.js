/**
 * @file src/agent/workspace-scan.js
 * @module agent/workspace-scan
 * @purpose Read a Node.js or frontend workspace and name the files an edit or generation should touch.
 * @depends node:path, node:fs/promises, util/text, agent/paths
 * @usedBy agent/team, commands/run, index.js
 * @exports INDEX_HTML_INLINE_BYTES, parseJsonc, extractHtmlEntries, resolveSpecifier, mergeTaskDraft, formatWorkspace, scanWorkspace
 * @ai.tags workspace, imports, context
 * @ai.hint io
 * @changed 2026-10-15 Scanner for package.json, tsconfig/jsconfig, import maps, and root index.html.
 */

import path from 'node:path';
import { open, readFile, stat } from 'node:fs/promises';
import { clipMiddle } from '../util/text.js';
import { isProtectedFileName } from './paths.js';

/** Root index.html at or under this size is sent in full. Larger pages need a task that is about the page. */
export const INDEX_HTML_INLINE_BYTES = 8192;

const READ_CAP = 256 * 1024;
const CONTEXT_CAP = 8192;
const FILE_CAP = 24;
const IMPORT_TARGET_CAP = 8;
const ENTRY_IMPORT_CAP = 8;
const EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json'];
const EDIT_TASK = /исправ|правк|fix|edit|change|измен|баг|bug|рефактор|добав|implement|генер|generate|созда|собер/i;
const PAGE_TASK = /index\.html|importmap|страниц|вёрст|верст|landing|frontend|\bhtml\b/i;

/**
 * Index of the next character that is not whitespace or a comment.
 * @param {string} source
 * @param {number} index
 * @returns {number}
 * @ai.hint pure
 */
function skipNoise(source, index) {
    let i = index;
    while (i < source.length) {
        if (/\s/.test(source[i])) {
            i += 1;
            continue;
        }
        if (source[i] === '/' && source[i + 1] === '/') {
            while (i < source.length && source[i] !== '\n') i += 1;
            continue;
        }
        if (source[i] === '/' && source[i + 1] === '*') {
            i += 2;
            while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
            i += 2;
            continue;
        }
        break;
    }
    return i;
}

/**
 * Parse JSON that may contain comments and trailing commas. Invalid text is null.
 * @param {string} text
 * @returns {object | null}
 * @exports
 * @ai.hint pure
 */
export function parseJsonc(text) {
    const source = String(text ?? '').replace(/^\uFEFF/, '');
    let out = '';
    let quote = false;
    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (quote) {
            out += char;
            if (char === '\\') {
                out += source[i + 1] ?? '';
                i += 1;
                continue;
            }
            if (char === '"') quote = false;
            continue;
        }
        if (char === '"') {
            quote = true;
            out += char;
            continue;
        }
        if (char === '/' && source[i + 1] === '/') {
            while (i < source.length && source[i] !== '\n') i += 1;
            continue;
        }
        if (char === '/' && source[i + 1] === '*') {
            i += 2;
            while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
            i += 1;
            continue;
        }
        if (char === ',') {
            const next = skipNoise(source, i + 1);
            if (source[next] === '}' || source[next] === ']') continue;
        }
        out += char;
    }
    try {
        const value = JSON.parse(out);
        return value && typeof value === 'object' ? value : null;
    } catch {
        return null;
    }
}

/**
 * Script sources, stylesheets, and an inline or linked import map from one HTML document.
 * @param {string} html
 * @returns {{ scripts: Array<{ src: string, module: boolean }>, styles: string[], importMap: object | null, importMapSrc: string | null }}
 * @exports
 * @ai.hint pure
 */
export function extractHtmlEntries(html) {
    const scripts = [];
    const styles = [];
    let importMap = null;
    let importMapSrc = null;
    const source = String(html ?? '');
    for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        const attrs = match[1];
        const type = attr(attrs, 'type').toLowerCase();
        const src = attr(attrs, 'src');
        if (type === 'importmap') {
            if (importMap == null && !importMapSrc) {
                if (src) importMapSrc = src;
                else importMap = parseJsonc(match[2]);
            }
            continue;
        }
        if (src) scripts.push({ src, module: type === 'module' });
    }
    for (const match of source.matchAll(/<link\b([^>]*)>/gi)) {
        const rel = attr(match[1], 'rel');
        const href = attr(match[1], 'href');
        if (href && /\bstylesheet\b/i.test(rel)) styles.push(href);
    }
    return { scripts, styles, importMap, importMapSrc };
}

/**
 * @param {string} attrs
 * @param {string} name
 * @returns {string}
 * @ai.hint pure
 */
function attr(attrs, name) {
    const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
    return match?.[1] ?? match?.[2] ?? '';
}

/**
 * @param {string[]} items
 * @returns {string[]}
 * @ai.hint pure
 */
function unique(items) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        if (!item || seen.has(item)) continue;
        seen.add(item);
        out.push(item);
    }
    return out;
}

/**
 * Project-relative path, or null when it escapes the root or enters a skipped tree.
 * @param {string} rel
 * @returns {string | null}
 * @ai.hint pure
 */
function normalizeRel(rel) {
    if (typeof rel !== 'string') return null;
    const posix = rel.replaceAll('\\', '/');
    if (!posix || posix.includes('\0') || posix.includes('://')) return null;
    const normalized = path.posix.normalize(posix);
    if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) return null;
    const segments = normalized.split('/');
    if (segments.some((segment) => segment === 'node_modules' || segment === '.git' || isProtectedFileName(segment))) return null;
    return normalized;
}

/**
 * @param {string} rel
 * @returns {string[]}
 * @ai.hint pure
 */
function withExtensions(rel) {
    const normalized = normalizeRel(rel);
    if (!normalized) return [];
    if (path.posix.extname(normalized)) return [normalized];
    return unique([
        normalized,
        ...EXTS.map((ext) => `${normalized}${ext}`),
        ...EXTS.filter((ext) => ext !== '.json').map((ext) => `${normalized}/index${ext}`),
    ]);
}

/**
 * @param {string} pattern
 * @param {string} spec
 * @returns {string | null} Text captured by `*`, or an empty string for an exact key. Null when the pattern misses.
 * @ai.hint pure
 */
function matchPattern(pattern, spec) {
    const star = pattern.indexOf('*');
    if (star === -1) return pattern === spec ? '' : null;
    if (pattern.indexOf('*', star + 1) !== -1) return null;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) return null;
    if (spec.length < prefix.length + suffix.length) return null;
    return spec.slice(prefix.length, spec.length - suffix.length);
}

/**
 * @param {unknown} value
 * @param {'browser' | 'node'} prefer
 * @returns {string[]}
 * @ai.hint pure
 */
function conditionTargets(value, prefer) {
    if (typeof value === 'string') return [value];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const order = prefer === 'browser'
        ? ['browser', 'import', 'default', 'node', 'require']
        : ['import', 'node', 'default', 'require', 'browser'];
    const picked = [];
    for (const key of order) {
        if (typeof value[key] === 'string') picked.push(value[key]);
    }
    if (!picked.length) {
        for (const item of Object.values(value)) {
            if (typeof item === 'string') picked.push(item);
        }
    }
    return picked;
}

/**
 * @param {object | null | undefined} map
 * @param {string} spec
 * @param {'browser' | 'node'} prefer
 * @returns {string[]}
 * @ai.hint pure
 */
function matchSubpath(map, spec, prefer) {
    if (!map || typeof map !== 'object') return [];
    if (Object.hasOwn(map, spec)) return conditionTargets(map[spec], prefer);
    let best = null;
    let bestLength = -1;
    for (const [key, value] of Object.entries(map)) {
        const captured = matchPattern(key, spec);
        if (captured == null || !key.includes('*')) continue;
        if (key.length > bestLength) {
            bestLength = key.length;
            best = { value, captured };
        }
    }
    if (!best) return [];
    return conditionTargets(best.value, prefer).map((target) => target.replaceAll('*', best.captured));
}

/**
 * HTML import maps use an exact key or the longest prefix that ends with `/`.
 * @param {object | null | undefined} imports
 * @param {string} spec
 * @param {'browser' | 'node'} prefer
 * @returns {string[]}
 * @ai.hint pure
 */
function matchImportMap(imports, spec, prefer) {
    if (!imports || typeof imports !== 'object') return [];
    if (Object.hasOwn(imports, spec)) return conditionTargets(imports[spec], prefer);
    let best = null;
    for (const [key, value] of Object.entries(imports)) {
        if (!key.endsWith('/') || !spec.startsWith(key)) continue;
        if (!best || key.length > best.key.length) best = { key, value };
    }
    if (!best) return [];
    const rest = spec.slice(best.key.length);
    return conditionTargets(best.value, prefer).map((target) => `${target.endsWith('/') ? target : `${target}/`}${rest}`);
}

/**
 * @param {object | null | undefined} paths
 * @param {string} spec
 * @returns {string[]}
 * @ai.hint pure
 */
function matchPaths(paths, spec) {
    if (!paths || typeof paths !== 'object') return [];
    const keys = Object.keys(paths).sort((left, right) => right.length - left.length);
    for (const key of keys) {
        const captured = matchPattern(key, spec);
        if (captured == null) continue;
        const targets = Array.isArray(paths[key]) ? paths[key] : [];
        return targets.filter((target) => typeof target === 'string').map((target) => target.replaceAll('*', captured));
    }
    return [];
}

/**
 * @param {string | null | undefined} baseUrl
 * @param {string} spec
 * @returns {string}
 * @ai.hint pure
 */
function joinBase(baseUrl, spec) {
    const base = typeof baseUrl === 'string' ? baseUrl.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '') : '';
    if (!base || base === '.') return spec;
    return path.posix.join(base, spec);
}

/**
 * Turn one specifier into project-relative candidates. Existence is checked by the caller.
 * @param {string} spec
 * @param {{ from?: string, baseUrl?: string | null, paths?: object | null, imports?: object | null, importMap?: object | null, prefer?: 'browser' | 'node' }} [rules]
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function resolveSpecifier(spec, rules = {}) {
    const raw = String(spec ?? '').trim();
    if (!raw || raw.includes('://') || raw.startsWith('//') || /^[A-Za-z]:[\\/]/.test(raw)) return [];
    const bare = raw.startsWith('/') ? raw.slice(1) : raw;
    const prefer = rules.prefer === 'node' ? 'node' : 'browser';
    if (bare.startsWith('.')) {
        const fromDir = rules.from ? path.posix.dirname(rules.from) : '';
        return withExtensions(path.posix.join(fromDir, bare));
    }
    const candidates = [];
    const pushTarget = (target) => {
        if (typeof target !== 'string' || target.includes('://')) return;
        const relative = target.startsWith('/') ? target.slice(1) : target;
        candidates.push(...withExtensions(relative));
    };
    if (bare.startsWith('#')) {
        for (const target of matchSubpath(rules.imports, bare, prefer)) pushTarget(target);
        return unique(candidates);
    }
    const mapImports = rules.importMap?.imports ?? null;
    for (const target of matchImportMap(mapImports, bare, prefer)) pushTarget(target);
    for (const target of matchPaths(rules.paths, bare)) pushTarget(joinBase(rules.baseUrl, target));
    if (bare.includes('/') || bare.startsWith('@')) candidates.push(...withExtensions(bare));
    if (!candidates.length && bare.includes('/') && !bare.startsWith('@')) candidates.push(...withExtensions(joinBase(rules.baseUrl, bare)));
    return unique(candidates);
}

/**
 * @param {string} task
 * @returns {string[]}
 * @ai.hint pure
 */
function mentionedSpecs(task) {
    const text = String(task ?? '').replaceAll('\\', '/');
    const found = [];
    const pattern = /(?:^|[^\w./#-])([@#][\w./-]*[\w]|\.{1,2}\/[\w./-]+|(?:[\w.-]+\/)+[\w.-]+(?:\.[\w]+)?)/g;
    for (const match of text.matchAll(pattern)) {
        const token = match[1];
        if (token.split('/').includes('..')) continue;
        found.push(token);
    }
    return unique(found);
}

/**
 * @param {string} text
 * @returns {string[]}
 * @ai.hint pure
 */
function importSpecifiers(text) {
    const specs = [];
    const patterns = [
        /\bfrom\s+(['"])([^'"]+)\1/g,
        /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
        /\bimport\s+(['"])([^'"]+)\1/g,
        /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g,
    ];
    for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) specs.push(match[2]);
    }
    return unique(specs);
}

/**
 * @param {unknown} value
 * @returns {{ imports: object, scopes: object | null } | null}
 * @ai.hint pure
 */
function asImportMap(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (!keys.length) return null;
    if (keys.every((key) => key === 'imports' || key === 'scopes' || key === 'integrity')) {
        if (!value.imports || typeof value.imports !== 'object' || Array.isArray(value.imports)) return null;
        return { imports: value.imports, scopes: value.scopes && typeof value.scopes === 'object' ? value.scopes : null };
    }
    return { imports: value, scopes: null };
}

/**
 * @param {object | null | undefined} draft
 * @param {Array<{ path: string, role: string, reason: string }> | null | undefined} files
 * @returns {{ edit: object[], read: object[], scan: object[] }}
 * @exports
 * @ai.hint pure
 */
export function mergeTaskDraft(draft, files) {
    const edit = [];
    const read = [];
    const scan = [];
    const seen = new Set();
    /**
     * @param {{ path?: string, role?: string, reason?: string }} item
     * @returns {void}
     * @ai.hint pure
     */
    const take = (item) => {
        if (!item || typeof item.path !== 'string' || seen.has(item.path)) return;
        if (item.role !== 'edit' && item.role !== 'read' && item.role !== 'scan') return;
        seen.add(item.path);
        const mark = { path: item.path, role: item.role, reason: typeof item.reason === 'string' ? item.reason : '' };
        if (mark.role === 'edit') edit.push(mark);
        else if (mark.role === 'read') read.push(mark);
        else scan.push(mark);
    };
    for (const item of files ?? []) take(item);
    for (const item of [...(draft?.edit ?? []), ...(draft?.read ?? []), ...(draft?.scan ?? [])]) take(item);
    return { edit: edit.slice(0, 12), read: read.slice(0, 20), scan: scan.slice(0, 40) };
}

/**
 * Prompt block. Config bodies are clipped. An empty card is an empty string.
 * @param {object | null | undefined} card
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function formatWorkspace(card) {
    if (!card) return '';
    const lines = [`Workspace: ${card.kind}`];
    if (card.notes?.length) {
        lines.push('', 'Notes:');
        for (const note of card.notes) lines.push(`- ${note}`);
    }
    if (card.packageText) lines.push('', 'package.json:', clipMiddle(card.packageText, CONTEXT_CAP));
    if (card.configFile && card.configText) lines.push('', `${card.configFile}:`, clipMiddle(card.configText, CONTEXT_CAP));
    lines.push('', 'Aliases:');
    let aliases = 0;
    if (card.paths && typeof card.paths === 'object') {
        for (const [key, targets] of Object.entries(card.paths)) {
            if (!Array.isArray(targets)) continue;
            aliases += 1;
            lines.push(`- ${key} → ${targets.filter((target) => typeof target === 'string').join(', ')}`);
        }
    }
    for (const item of card.importMaps ?? []) {
        for (const [key, target] of Object.entries(item.map?.imports ?? {})) {
            aliases += 1;
            const shown = typeof target === 'string' ? target : JSON.stringify(target);
            lines.push(`- ${key} → ${shown} (${item.source})`);
        }
    }
    if (!aliases) lines.push('- (none)');
    for (const item of card.importMaps ?? []) {
        lines.push('', `Import map (${item.source}):`, clipMiddle(JSON.stringify(item.map, null, 2), CONTEXT_CAP));
    }
    if (card.indexHtml) {
        const html = card.indexHtml;
        lines.push('', 'index.html entries:');
        if (!html.scripts.length && !html.styles.length) lines.push('- (none)');
        for (const script of html.scripts) lines.push(`- script${script.module ? ' module' : ''} ${script.src}`);
        for (const href of html.styles) lines.push(`- style ${href}`);
        if (html.included && html.text) lines.push('', 'index.html:', clipMiddle(html.text, CONTEXT_CAP));
        else lines.push('', `index.html body omitted (${html.bytes} bytes).`);
    }
    lines.push('', 'Scanner files:');
    if (!card.files?.length) lines.push('- (none)');
    else for (const file of card.files) lines.push(`- ${file.role} ${file.path} — ${file.reason}`);
    return lines.join('\n');
}

/**
 * @param {string} root
 * @param {string} rel
 * @returns {Promise<{ text: string, bytes: number } | null>}
 * @ai.hint io
 */
async function readTextFile(root, rel) {
    const normalized = normalizeRel(rel);
    if (!normalized) return null;
    const abs = path.join(root, ...normalized.split('/'));
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) return null;
    try {
        if (info.size <= READ_CAP) {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(abs));
            return { text, bytes: info.size };
        }
        const handle = await open(abs, 'r');
        try {
            const buf = Buffer.alloc(READ_CAP);
            const { bytesRead } = await handle.read(buf, 0, READ_CAP, 0);
            return { text: new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(0, bytesRead)), bytes: info.size };
        } finally {
            await handle.close();
        }
    } catch {
        return null;
    }
}

/**
 * @param {unknown} value
 * @param {string[]} out
 * @param {number} depth
 * @returns {void}
 * @ai.hint pure
 */
function collectExportFiles(value, out, depth) {
    if (depth > 4 || out.length >= 16) return;
    if (typeof value === 'string') {
        out.push(value);
        return;
    }
    if (!value || typeof value !== 'object') return;
    for (const item of Object.values(value)) collectExportFiles(item, out, depth + 1);
}

/**
 * @param {object | null} pkg
 * @returns {string[]}
 * @ai.hint pure
 */
function packageEntries(pkg) {
    if (!pkg) return [];
    const out = [];
    for (const key of ['module', 'main', 'browser']) {
        if (typeof pkg[key] === 'string') out.push(pkg[key]);
    }
    collectExportFiles(pkg.exports, out, 0);
    return out;
}

/**
 * Read package.json, tsconfig or jsconfig, import maps, and root index.html.
 * Returns null when this directory is not a Node.js or frontend workspace.
 * @param {string} root
 * @param {{ task?: string }} [options]
 * @returns {Promise<object | null>}
 * @exports
 * @ai.hint io
 */
export async function scanWorkspace(root, { task = '' } = {}) {
    const packageFile = await readTextFile(root, 'package.json');
    const tsconfigFile = await readTextFile(root, 'tsconfig.json');
    const jsconfigFile = tsconfigFile ? null : await readTextFile(root, 'jsconfig.json');
    const indexFile = await readTextFile(root, 'index.html');
    if (!packageFile && !tsconfigFile && !jsconfigFile && !indexFile) return null;

    const notes = [];
    const pkg = packageFile ? parseJsonc(packageFile.text) : null;
    if (packageFile && !pkg) notes.push('package.json is not valid JSON.');
    const configFile = tsconfigFile ? 'tsconfig.json' : jsconfigFile ? 'jsconfig.json' : null;
    const configRead = tsconfigFile ?? jsconfigFile;
    const configJson = configRead ? parseJsonc(configRead.text) : null;
    if (configRead && !configJson) notes.push(`${configFile} is not valid JSON.`);

    let paths = configJson?.compilerOptions?.paths ?? null;
    let baseUrl = configJson?.compilerOptions?.baseUrl ?? null;
    const extendsPath = typeof configJson?.extends === 'string' && configJson.extends.startsWith('.')
        ? normalizeRel(configJson.extends.replace(/^\.\//, ''))
        : null;
    if (extendsPath && (paths == null || baseUrl == null)) {
        const base = await readTextFile(root, extendsPath);
        const baseJson = base ? parseJsonc(base.text) : null;
        const baseOptions = baseJson?.compilerOptions && typeof baseJson.compilerOptions === 'object' ? baseJson.compilerOptions : {};
        if (paths == null && baseOptions.paths) paths = baseOptions.paths;
        if (baseUrl == null && baseOptions.baseUrl != null) baseUrl = baseOptions.baseUrl;
    }
    if (paths && (typeof paths !== 'object' || Array.isArray(paths))) paths = null;

    const hasIndex = Boolean(indexFile);
    const hasPackage = Boolean(packageFile);
    const kind = hasPackage && hasIndex ? 'node-frontend' : hasIndex || (!hasPackage && configFile) ? 'frontend' : 'node';
    const prefer = kind === 'node' ? 'node' : 'browser';
    const importMaps = [];
    const packageMap = asImportMap(pkg?.imports);
    if (packageMap) importMaps.push({ source: 'package.json', map: packageMap });
    let html = null;
    if (indexFile) {
        const entries = extractHtmlEntries(indexFile.text);
        let importMap = entries.importMap ? asImportMap(entries.importMap) : null;
        if (!importMap && entries.importMapSrc && !entries.importMapSrc.includes('://')) {
            let linkedRel = entries.importMapSrc.replace(/^\.\//, '');
            if (linkedRel.startsWith('/') && !linkedRel.startsWith('//')) linkedRel = linkedRel.slice(1);
            const linked = await readTextFile(root, linkedRel);
            const parsed = linked ? asImportMap(parseJsonc(linked.text)) : null;
            if (parsed) importMap = parsed;
        }
        if (importMap) importMaps.push({ source: 'index.html', map: importMap });
        const included = indexFile.bytes <= INDEX_HTML_INLINE_BYTES || PAGE_TASK.test(String(task ?? ''));
        html = {
            path: 'index.html',
            bytes: indexFile.bytes,
            included,
            text: included ? indexFile.text : null,
            scripts: entries.scripts,
            styles: entries.styles,
        };
    }

    const htmlMap = importMaps.find((item) => item.source === 'index.html')?.map ?? null;
    const rules = { baseUrl, paths, imports: packageMap?.imports ?? null, importMap: htmlMap, prefer };
    const exists = new Map();
    /**
     * @param {string} rel
     * @returns {Promise<boolean>}
     * @ai.hint io
     */
    const fileExists = async (rel) => {
        if (exists.has(rel)) return exists.get(rel);
        const abs = path.join(root, ...rel.split('/'));
        const info = await stat(abs).catch(() => null);
        const ok = Boolean(info?.isFile());
        exists.set(rel, ok);
        return ok;
    };
    /**
     * @param {string} spec
     * @param {string} [from]
     * @returns {Promise<string | null>}
     * @ai.hint io
     */
    const firstExisting = async (spec, from) => {
        for (const candidate of resolveSpecifier(spec, { ...rules, from })) {
            if (await fileExists(candidate)) return candidate;
        }
        return null;
    };

    const files = [];
    /**
     * @param {{ path: string, role: string, reason: string }} item
     * @returns {void}
     * @ai.hint pure
     */
    const addFile = (item) => {
        if (files.length >= FILE_CAP && !files.some((file) => file.path === item.path)) return;
        const found = files.find((file) => file.path === item.path);
        if (!found) {
            if (files.length < FILE_CAP) files.push(item);
            return;
        }
        if (found.role !== 'edit' && item.role === 'edit') {
            found.role = 'edit';
            found.reason = item.reason;
        }
    };

    const editing = EDIT_TASK.test(String(task ?? ''));
    for (const spec of mentionedSpecs(task)) {
        const found = await firstExisting(spec);
        if (!found) continue;
        addFile({ path: found, role: editing ? 'edit' : 'read', reason: 'упомянут в задаче' });
    }
    if (html && /index\.html/i.test(String(task ?? ''))) addFile({ path: 'index.html', role: 'edit', reason: 'корневой index.html' });

    const entries = [];
    for (const spec of packageEntries(pkg)) {
        const found = await firstExisting(spec);
        if (found) entries.push(found);
    }
    for (const script of html?.scripts ?? []) {
        const found = await firstExisting(script.src);
        if (found) entries.push(found);
    }
    for (const href of html?.styles ?? []) {
        const found = await firstExisting(href);
        if (found) entries.push(found);
    }
    for (const entry of unique(entries)) addFile({ path: entry, role: 'read', reason: 'точка входа' });

    let followed = 0;
    for (const entry of unique(entries)) {
        if (followed >= ENTRY_IMPORT_CAP) break;
        const body = await readTextFile(root, entry);
        if (!body) continue;
        for (const spec of importSpecifiers(body.text)) {
            if (followed >= ENTRY_IMPORT_CAP) break;
            const found = await firstExisting(spec, entry);
            if (!found || found === entry) continue;
            addFile({ path: found, role: 'read', reason: 'импорт точки входа' });
            followed += 1;
        }
    }

    let targets = 0;
    for (const item of importMaps) {
        for (const target of Object.values(item.map.imports ?? {})) {
            if (targets >= IMPORT_TARGET_CAP) break;
            const values = conditionTargets(target, prefer);
            for (const value of values) {
                const found = await firstExisting(value);
                if (!found) continue;
                addFile({ path: found, role: 'read', reason: 'цель import map' });
                targets += 1;
                break;
            }
        }
    }

    return {
        kind,
        packageText: packageFile?.text ?? null,
        configFile,
        configText: configRead?.text ?? null,
        paths,
        baseUrl: typeof baseUrl === 'string' ? baseUrl : null,
        importMaps,
        indexHtml: html,
        files,
        notes,
    };
}
