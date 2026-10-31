/**
 * @file src/agent/extract.js
 * @module agent/extract
 * @purpose Turn fenced answer artifacts into clean files under `.tmp/<id>/extracted`.
 * @depends node:path, node:fs/promises, agent/handoff
 * @usedBy agent/team
 * @exports EXTRACT_MAX_BYTES, EXTRACT_MAX_FILES, languageExtension, normalizeLanguage, cleanExtractPath, extractionChunks, applyRemoveLines, parseExtraction, renderExtractionPrompt, hasExtractableArtifacts, extractHandoff
 * @ai.tags handoff, extraction, tmp
 * @ai.hint io
 * @changed 2026-10-21 Raw answers stay in answer.md; the encoder writes clean code files.
 * @changed 2026-10-31 The former extractor role merged into the encoder; notifications say Encoder.
 */

import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { referenceLine, saveHandoff } from './handoff.js';

/** One encoder request covers at most this many bytes of artifact bodies. */
export const EXTRACT_MAX_BYTES = 48 * 1024;
/** One encoder request covers at most this many artifacts. */
export const EXTRACT_MAX_FILES = 4;

const EXTENSIONS = Object.freeze({
    js: '.js', javascript: '.js', mjs: '.mjs', cjs: '.cjs', jsx: '.jsx',
    ts: '.ts', typescript: '.ts', tsx: '.tsx',
    html: '.html', htm: '.html', xhtml: '.html',
    css: '.css', scss: '.scss', sass: '.sass', less: '.less',
    json: '.json', jsonc: '.jsonc', json5: '.json5',
    md: '.md', markdown: '.md', mdx: '.mdx', txt: '.txt', text: '.txt',
    py: '.py', python: '.py', rb: '.rb', ruby: '.rb', go: '.go', rs: '.rs', rust: '.rs',
    java: '.java', kt: '.kt', kotlin: '.kt', kts: '.kts', scala: '.scala',
    c: '.c', h: '.h', cpp: '.cpp', 'c++': '.cpp', cc: '.cc', hpp: '.hpp', cs: '.cs', 'c#': '.cs',
    php: '.php', swift: '.swift', dart: '.dart', lua: '.lua', r: '.r',
    sh: '.sh', shell: '.sh', bash: '.sh', zsh: '.sh', ps1: '.ps1', powershell: '.ps1',
    bat: '.bat', cmd: '.cmd',
    yml: '.yml', yaml: '.yaml', toml: '.toml', ini: '.ini', conf: '.conf',
    sql: '.sql', graphql: '.graphql', gql: '.graphql',
    glsl: '.glsl', vert: '.vert', frag: '.frag', wgsl: '.wgsl',
    vue: '.vue', svelte: '.svelte', astro: '.astro',
    xml: '.xml', svg: '.svg', csv: '.csv', env: '.env',
});

const ALIASES = Object.freeze({
    javascript: 'js', typescript: 'ts', markdown: 'md', plaintext: 'text', text: 'text',
    shell: 'sh', powershell: 'ps1', 'c++': 'cpp', 'c#': 'cs', yml: 'yaml',
});

/**
 * Lower-case language tag with common aliases collapsed.
 * @param {string} [language]
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function normalizeLanguage(language = '') {
    const key = String(language ?? '').trim().toLowerCase().replace(/^\./, '').split(/\s+/)[0];
    return ALIASES[key] ?? (key || 'text');
}

/**
 * Extension for a language tag. Unknown languages use `.txt`.
 * @param {string} [language]
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function languageExtension(language = '') {
    return EXTENSIONS[normalizeLanguage(language)] ?? '.txt';
}

/**
 * A safe relative path with an extension. A missing or unsafe path becomes `snippet-NNN.ext`.
 * @param {string} [value]
 * @param {string} [language]
 * @param {number} [index]
 * @param {Set<string>} [used]
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function cleanExtractPath(value, language = '', index = 1, used = new Set()) {
    let rel = String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
    const segments = rel.split('/');
    const unsafe = !rel
        || rel === '.'
        || rel.endsWith('/')
        || rel.startsWith('/')
        || /^[A-Za-z]:/.test(rel)
        || /[\x00-\x1f:*?"<>|]/.test(rel)
        || segments.some((segment) => !segment || segment === '.' || segment === '..')
        || rel.startsWith('.tmp/');
    if (unsafe) rel = `snippet-${String(index).padStart(3, '0')}${languageExtension(language)}`;
    const leaf = rel.split('/').at(-1) ?? '';
    if (!/\.[A-Za-z0-9]+$/.test(leaf)) rel += languageExtension(language);
    let candidate = rel;
    let counter = 2;
    while (used.has(candidate)) {
        const extension = candidate.match(/\.[^./]+$/)?.[0] ?? '';
        const stem = extension ? candidate.slice(0, -extension.length) : candidate;
        candidate = `${stem}-${counter}${extension}`;
        counter += 1;
    }
    used.add(candidate);
    return candidate;
}

/**
 * Split artifacts into bounded encoder requests.
 * @param {object[]} artifacts
 * @param {{ maxBytes?: number, maxFiles?: number }} [options]
 * @returns {object[][]}
 * @exports
 * @ai.hint pure
 */
export function extractionChunks(artifacts, { maxBytes = EXTRACT_MAX_BYTES, maxFiles = EXTRACT_MAX_FILES } = {}) {
    const chunks = [];
    let current = [];
    let bytes = 0;
    for (const item of Array.isArray(artifacts) ? artifacts : []) {
        const size = Number.isFinite(item?.bytes) ? item.bytes : 0;
        if (current.length && (current.length >= maxFiles || bytes + size > maxBytes)) {
            chunks.push(current);
            current = [];
            bytes = 0;
        }
        current.push(item);
        bytes += size;
    }
    if (current.length) chunks.push(current);
    return chunks;
}

/**
 * Drop 1-based line numbers from a body.
 * @param {string} body
 * @param {number[]} lines
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function applyRemoveLines(body, lines) {
    if (!Array.isArray(lines) || !lines.length) return String(body ?? '');
    const drop = new Set(lines.filter((line) => Number.isSafeInteger(line) && line >= 1).map((line) => line - 1));
    if (!drop.size) return String(body ?? '');
    return String(body ?? '').split('\n').filter((_, index) => !drop.has(index)).join('\n');
}

/**
 * Remove one outer Markdown fence when the model returned one.
 * @param {string} body
 * @returns {string}
 * @ai.hint pure
 */
function stripFence(body) {
    const text = String(body ?? '').replace(/\r\n/g, '\n');
    const match = /^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/.exec(text);
    return match ? match[1] : text;
}

/**
 * Validate an encoder reply and turn it into clean file records.
 * @param {object} data
 * @param {object[]} artifacts
 * @param {Map<string, string>} bodies
 * @param {{ used?: Set<string> }} [options]
 * @returns {Array<{ source: string, path: string, language: string, body: string }>}
 * @exports
 * @ai.hint pure
 */
export function parseExtraction(data, artifacts, bodies, { used = new Set() } = {}) {
    const byId = new Map((Array.isArray(artifacts) ? artifacts : []).map((item) => [item.id, item]));
    const seen = new Set();
    const files = [];
    for (const entry of Array.isArray(data?.files) ? data.files : []) {
        const source = String(entry?.source ?? '').trim();
        const artifact = byId.get(source);
        if (!artifact || seen.has(source)) continue;
        const original = String(bodies.get(source) ?? '');
        const content = typeof entry.content === 'string' && entry.content.trim() ? stripFence(entry.content) : '';
        const body = content || applyRemoveLines(original, entry.removeLines);
        if (!body.trim()) continue;
        const language = normalizeLanguage(entry.language || artifact.hintLanguage);
        const rel = cleanExtractPath(entry.path || artifact.hintPath, language, files.length + 1, used);
        files.push({ source, path: rel, language, body });
        seen.add(source);
    }
    return files;
}

/**
 * Prompt body with numbered artifact lines, so the encoder can return removeLines.
 * @param {object[]} artifacts
 * @param {Map<string, string>} bodies
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function renderExtractionPrompt(artifacts, bodies) {
    const blocks = artifacts.map((item) => {
        const body = String(bodies.get(item.id) ?? '');
        const numbered = body.split('\n').map((line, index) => `${index + 1}\t${line}`).join('\n');
        return `[artifact ${item.id}] hintPath=${item.hintPath ?? ''} hintLanguage=${item.hintLanguage ?? ''}\n${numbered}`;
    });
    return `# Artifacts to extract\n${blocks.join('\n\n')}`;
}

/**
 * True when the handoff has at least one fenced body that has not been extracted yet.
 * @param {object} state
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function hasExtractableArtifacts(state) {
    return Boolean(state?.artifacts?.some((item) => item.origin == null && !item.extracted && !item.supersededBy && item.bytes > 0));
}

/**
 * Write one clean body under `.tmp/<id>/extracted/` and append it to the artifact list.
 * @param {{ root: string, state: object, file: { source: string, path: string, language: string, body: string } }} input
 * @returns {Promise<object>}
 * @ai.hint io
 */
async function writeExtractedFile({ root, state, file }) {
    const next = state.artifacts.reduce((max, item) => Math.max(max, Number(String(item.id).replace(/^a/, '')) || 0), 0) + 1;
    const id = `a${String(next).padStart(3, '0')}`;
    const rel = `${state.relDir}/extracted/${file.path}`;
    const abs = path.join(root, state.relDir, 'extracted', ...file.path.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, file.body, 'utf8');
    const artifact = {
        id, rel,
        hintLanguage: file.language,
        hintPath: file.path,
        bytes: Buffer.byteLength(file.body),
        origin: `extracted:${file.source}`,
        start: null,
        end: null,
        extracted: true,
    };
    state.artifacts.push(artifact);
    return artifact;
}

/**
 * Add a reference section for extracted files without removing the original answer.
 * @param {object} state
 * @param {object[]} artifacts
 * @returns {void}
 * @ai.hint pure
 */
function appendExtractionSection(state, artifacts) {
    const lines = artifacts.map((item) => `${referenceLine(item)} · replaces ${String(item.origin ?? '').replace('extracted:', '')}`);
    const section = `# Extracted files\nThese clean files replace the original fenced blocks. Use their source paths.\n${lines.join('\n')}`;
    state.text = state.text ? `${state.text}\n\n${section}` : section;
}

/**
 * Run the encoder over fenced artifacts, one request per bounded chunk.
 * A failed request leaves its original artifacts in place.
 * @param {{ root: string, state: object, run: (text: string) => Promise<object>, notify?: (event: object) => void, maxBytes?: number, maxFiles?: number }} options
 * @returns {Promise<{ files: object[], calls: number }>}
 * @exports
 * @ai.hint io
 */
export async function extractHandoff({ root, state, run, notify = () => {}, maxBytes = EXTRACT_MAX_BYTES, maxFiles = EXTRACT_MAX_FILES }) {
    const candidates = state.artifacts.filter((item) => item.origin == null && !item.extracted && !item.supersededBy && item.bytes > 0);
    if (!candidates.length) return { files: [], calls: 0 };
    const created = [];
    let calls = 0;
    for (const chunk of extractionChunks(candidates, { maxBytes, maxFiles })) {
        const bodies = new Map();
        for (const item of chunk) {
            try { bodies.set(item.id, await readFile(path.join(root, item.rel), 'utf8')); }
            catch { bodies.set(item.id, ''); }
        }
        if (![...bodies.values()].some((body) => body.trim())) continue;
        let result;
        try { result = await run(renderExtractionPrompt(chunk, bodies)); }
        catch (error) {
            if (error?.name === 'AbortError' || error?.name === 'CancelledError') throw error;
            notify({ type: 'warning', message: `Encoder: ${error.message}` });
            continue;
        }
        calls += 1;
        if (result?.status !== 'completed' || !result.data) {
            notify({ type: 'warning', message: `Encoder не ответил (${result?.status ?? 'unknown'}); исходные артефакты сохранены.` });
            continue;
        }
        const used = new Set(state.artifacts.filter((item) => item.extracted && item.hintPath).map((item) => item.hintPath));
        const files = parseExtraction(result.data, chunk, bodies, { used });
        const artifacts = [];
        for (const file of files) {
            let artifact;
            try { artifact = await writeExtractedFile({ root, state, file }); }
            catch (error) {
                notify({ type: 'warning', message: `Encoder: файл ${file.path} не записан (${error.message}).` });
                continue;
            }
            const original = state.artifacts.find((item) => item.id === file.source);
            if (original) original.supersededBy = artifact.id;
            artifacts.push(artifact);
            created.push(artifact);
        }
        if (artifacts.length) await saveHandoff(root, state);
    }
    if (created.length) {
        appendExtractionSection(state, created);
        await saveHandoff(root, state);
    }
    return { files: created, calls };
}
