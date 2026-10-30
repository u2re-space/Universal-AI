/**
 * @file src/agent/decomposition.js
 * @module agent/decomposition
 * @purpose Collect the sub-reference images the decomposer produced, hand them to the measurer,
 *   and render the decomposition for the shared context.
 * @depends node:path, node:fs/promises, agent/paths, core/attachments, agent/schemas
 * @usedBy agent/team
 * @exports SUB_REFERENCE_DIR, MAX_SUB_REFERENCES, collectSubReferences, attachSubReferences, decompositionReport
 * @ai.tags decomposition, images, measurement
 * @ai.hint io
 * @changed 2026-10-31 The decomposer now builds one clean image per screen instead of only naming it.
 */

import path from 'node:path';
import { stat } from 'node:fs/promises';
import { resolveInside } from './paths.js';
import { loadImageAttachment } from '../core/attachments.js';
import { SUB_REFERENCE_KINDS } from './schemas.js';

/** Working subdirectory of `.tmp/<id>/` where the decomposer writes its images. */
export const SUB_REFERENCE_DIR = 'decomposition';

/** Upper bound on sub-references collected for one run. */
export const MAX_SUB_REFERENCES = 16;

const KIND_FALLBACK = 'crop';

/**
 * A project-relative, forward-slashed path, or null for anything that cannot be a file
 * (empty, a URL, a data: reference).
 * @param {unknown} value
 * @returns {string|null}
 * @ai.hint pure
 */
function cleanPath(value) {
    const text = String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!text || /^https?:\/\//i.test(text) || /^data:/i.test(text)) return null;
    return text;
}

/**
 * A kind the schema accepts, or the crop fallback when the role left it out.
 * @param {unknown} value
 * @returns {string}
 * @ai.hint pure
 */
function kindOf(value) {
    return SUB_REFERENCE_KINDS.includes(value) ? value : KIND_FALLBACK;
}

/**
 * Read the screen entries and the `subReferences` list of one decomposition and keep the images
 * that really exist. Paths outside the working directory, missing files, and oversized files are
 * dropped with a warning, so a hallucinated path never reaches the measurer.
 * @param {{ root: string, workId: string, decomposition: object, maxBytes?: number, maxFiles?: number }} options
 * @returns {Promise<{ files: Array<{rel:string,abs:string,bytes:number,screen:string,kind:string,source:string,note:string}>, warnings: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function collectSubReferences({ root, workId, decomposition, maxBytes = null, maxFiles = MAX_SUB_REFERENCES }) {
    const files = [];
    const warnings = [];
    const seen = new Set();
    const wanted = [];
    const listed = Array.isArray(decomposition?.subReferences) ? decomposition.subReferences : [];
    for (const entry of listed) {
        const rel = cleanPath(entry?.path);
        if (!rel) continue;
        wanted.push({
            rel,
            screen: String(entry?.screen ?? '').trim(),
            kind: kindOf(entry?.kind),
            source: String(entry?.source ?? '').trim(),
            note: String(entry?.note ?? '').trim(),
        });
    }
    const screens = Array.isArray(decomposition?.screens) ? decomposition.screens : [];
    for (const screen of screens) {
        const rel = cleanPath(screen?.subReference);
        if (!rel) continue;
        if (wanted.some((entry) => entry.rel === rel)) continue;
        wanted.push({
            rel,
            screen: String(screen?.name ?? '').trim(),
            kind: kindOf(screen?.subReferenceKind),
            source: String(screen?.source ?? '').trim(),
            note: '',
        });
    }
    const expectedPrefix = `.tmp/${workId}/${SUB_REFERENCE_DIR}/`;
    for (const entry of wanted) {
        if (files.length >= maxFiles) {
            warnings.push(`Суб-референсов больше ${maxFiles}: остальные не приложены (${wanted.length - files.length} шт.).`);
            break;
        }
        if (seen.has(entry.rel)) continue;
        seen.add(entry.rel);
        let located;
        try {
            located = await resolveInside(root, entry.rel, { allowRoot: false });
        } catch {
            warnings.push(`Суб-референс вне рабочего каталога отброшен: ${entry.rel}`);
            continue;
        }
        const info = await stat(located.abs).catch(() => null);
        if (!info?.isFile()) {
            warnings.push(`Суб-референс не найден: ${entry.rel} (роль его не записала).`);
            continue;
        }
        if (maxBytes && info.size > maxBytes) {
            warnings.push(`Суб-референс ${entry.rel} больше лимита (${info.size} байт): не приложен.`);
            continue;
        }
        if (!entry.rel.startsWith(expectedPrefix)) {
            warnings.push(`Суб-референс ${entry.rel} лежит вне ${expectedPrefix} — следующий этап может принять его за готовый asset.`);
        }
        files.push({ ...entry, rel: located.rel.split(path.sep).join('/'), abs: located.abs, bytes: info.size });
    }
    return { files, warnings };
}

/**
 * Attach the collected sub-references as `input_image` parts, so the measurer looks at the clean
 * screens instead of reconstructing them from a rotated collage.
 * @param {{ root: string, files: object[], maxBytes?: number }} options
 * @returns {Promise<{ parts: object[], warnings: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function attachSubReferences({ root, files, maxBytes = null }) {
    const parts = [];
    const warnings = [];
    for (const file of files) {
        try {
            const attachment = await loadImageAttachment(file.rel, { cwd: root, maxBytes: maxBytes ?? Number.MAX_SAFE_INTEGER });
            parts.push(attachment.part);
        } catch (error) {
            warnings.push(`Суб-референс ${file.rel} не приложен: ${error.message}`);
        }
    }
    return { parts, warnings };
}

/**
 * The shared-context section for one decomposition: screens, their sub-references, and the
 * saved JSON path, so every later role reads the same screen list.
 * @param {object} decomposition
 * @param {object[]} files collected sub-references
 * @param {string} dir project-relative work directory such as `.tmp/<id>`
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function decompositionReport(decomposition, files, dir) {
    const screens = Array.isArray(decomposition?.screens) ? decomposition.screens : [];
    const byPath = new Map(files.map((file) => [file.rel, file]));
    const lines = screens.map((screen, index) => {
        const bits = [`- ${index + 1}. ${screen.name || '(unnamed)'}`];
        if (screen.source) bits.push(`source ${screen.source}`);
        if (screen.nodeId) bits.push(`node ${screen.nodeId}`);
        if (screen.bounds) bits.push(`bounds ${screen.bounds}`);
        const sub = cleanPath(screen.subReference);
        const entry = sub ? byPath.get(sub) ?? files.find((file) => file.screen === screen.name) : null;
        bits.push(entry ? `sub-reference ${entry.rel} (${entry.kind})` : 'sub-reference (none)');
        if (screen.purpose) bits.push(screen.purpose);
        return bits.join(' · ');
    });
    const orphans = files.filter((file) => !screens.some((screen) => cleanPath(screen.subReference) === file.rel || screen.name === file.screen));
    const produced = files.length
        ? `Sub-references produced (${files.length}): ${files.map((file) => `${file.rel} [${file.kind}]`).join(', ')}`
        : 'Sub-references produced: none — the measurer works on the original references.';
    const notes = Array.isArray(decomposition?.notes) ? decomposition.notes.filter(Boolean) : [];
    return [
        `Decomposition: ${decomposition?.summary || '(no summary)'}`,
        lines.join('\n'),
        produced,
        orphans.length ? 'Sub-references without a screen entry: ' + orphans.map((file) => file.rel).join(', ') : '',
        notes.length ? `Notes: ${notes.join(' | ')}` : '',
        `Decomposition JSON: ${dir}/decomposition.json; images: ${dir}/${SUB_REFERENCE_DIR}/.`,
    ].filter(Boolean).join('\n\n');
}
