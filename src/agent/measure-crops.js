/**
 * @file src/agent/measure-crops.js
 * @module agent/measure-crops
 * @purpose Cut ready reference crops for regions and reusable elements in a measurement sheet,
 *          and build the compact run conclusion.
 * @depends node:path, node:fs/promises, agent/paths, agent/image-magick
 * @usedBy agent/team
 * @exports stageMeasurementCrops, measurementConclusion
 * @ai.tags images, measurement, crop
 * @ai.hint io
 * @changed 2026-10-25 Two-pass measurement with deduplicated element crops.
 * @changed 2026-11-03 Crops are cut from the image the item was measured on: sub-references join the source candidates, and an item naming a sub-reference in its notes is cut from that sub-reference.
 */

import path from 'node:path';
import { stat } from 'node:fs/promises';
import { resolveInside } from './paths.js';
import { detectMagick, magickCrop, magickIdentify } from './image-magick.js';

/** Upper bound on automatic crops for one measurement sheet. */
const MAX_CROPS = 192;

/**
 * A filesystem-safe short name for a crop file.
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 * @ai.hint pure
 */
function slug(value, fallback) {
    const text = String(value ?? '')
        .normalize('NFKD')
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase()
        .slice(0, 48);
    return text || fallback;
}

/**
 * True when `abs` is an existing file.
 * @param {string} abs
 * @returns {Promise<boolean>}
 * @ai.hint io
 */
async function isFile(abs) {
    const info = await stat(abs).catch(() => null);
    return Boolean(info?.isFile());
}

/**
 * Resolve the default source image of a sheet. The measurer usually names the reference by
 * basename; a staged reference or sub-reference path is preferred over a model-provided path
 * so nothing outside the working directory can be read.
 * @param {{ root: string, sheet: object, referencePaths: string[], subReferences?: object[] }} options
 * @returns {Promise<string|null>} project-relative or absolute path inside root
 * @ai.hint io
 */
async function insideFile(root, ref) {
    try {
        const { abs, rel } = await resolveInside(root, ref, { allowRoot: false });
        return await isFile(abs) ? rel : null;
    } catch {
        return null;
    }
}

async function resolveSource({ root, sheet, referencePaths, subReferences = [], measureSource = 'auto', warnings = [] }) {
    const originals = (referencePaths ?? []).filter((item) => typeof item === 'string' && item.trim());
    const subRefs = subReferences.map((file) => file?.rel).filter((rel) => typeof rel === 'string' && rel.trim());
    const preferSubRefs = measureSource !== 'original';
    const named = String(sheet?.source ?? '').trim();

    /** The sub-reference that replaces an original, or null when the original stays. */
    const overrideFor = (originalRel) => {
        if (!preferSubRefs) return null;
        const derived = derivedSubReferences(subReferences, originalRel);
        if (derived.length === 1) return derived[0];
        if (derived.length > 1) return measureSource === 'subrefs' ? derived[0] : null;
        if (measureSource === 'subrefs' && subRefs.length) return subRefs[0];
        return null;
    };
    const replaced = (originalRel, overridden) => {
        warnings.push(`Источник замеров ${originalRel} заменён суб-референсом ${overridden} (measure-source: ${measureSource}).`);
        return overridden;
    };

    if (named && !/^https?:|^data:/i.test(named)) {
        const exact = [...subRefs, ...originals].find((item) => item === named || path.basename(item) === path.basename(named));
        if (exact) {
            const overridden = subRefs.includes(exact) ? null : overrideFor(exact);
            if (overridden) return replaced(exact, overridden);
            if (await insideFile(root, exact)) return exact;
        }
        const direct = await insideFile(root, named);
        if (direct) {
            const overridden = subRefs.includes(direct) ? null : overrideFor(direct);
            if (overridden) return replaced(direct, overridden);
            return direct;
        }
    }
    const candidates = measureSource === 'subrefs' ? [...subRefs, ...originals] : [...originals, ...subRefs];
    for (const item of candidates) {
        if (await insideFile(root, item)) return item;
    }
    return null;
}

/**
 * The sub-references one original produced, matched by path or file name of `file.source`.
 * @param {object[]} subReferences
 * @param {string} original project-relative path of the original reference
 * @returns {string[]} sub-reference rel paths in collection order
 * @ai.hint pure
 */
function derivedSubReferences(subReferences, original) {
    const base = path.basename(original);
    return subReferences
        .filter((file) => typeof file?.source === 'string' && file.source.trim()
            && (file.source.trim() === original || path.basename(file.source) === base))
        .map((file) => file.rel);
}

/**
 * The sub-reference an item was measured on, when its notes name one by path or file name.
 * @param {object} item a sheet element or region
 * @param {object[]} subReferences collected sub-references with `rel` paths
 * @returns {string|null} the sub-reference project-relative path
 * @ai.hint pure
 */
function namedSubReference(item, subReferences) {
    const text = `${item?.notes ?? ''} ${item?.how ?? ''}`;
    if (!text.trim()) return null;
    for (const file of subReferences) {
        if (typeof file?.rel !== 'string') continue;
        const base = file.rel.split('/').pop();
        if (text.includes(file.rel) || (base && text.includes(base))) return file.rel;
    }
    return null;
}

/**
 * Cut every region and reusable element in `sheet` that has a usable box and no existing crop.
 * The crop path is written back to the item, so `renderMeasurements`, `measurements.json`, and
 * the conclusion carry it. Identical boxes share one file. The image each item is cut from is
 * resolved in this order: the item's own `source` field, a sub-reference named in its notes,
 * the sheet source — with `measureSource: 'subrefs'` forcing derived sub-references over the
 * named original.
 * @param {{ root: string, workId: string, sheet: object, referencePaths?: string[], subReferences?: object[], measureSource?: string, config?: object, signal?: AbortSignal, reuse?: Array<{ crop?: string, box?: object }> }} options
 * @returns {Promise<{ crops: Array<{ kind: string, name: string, crop: string, bytes?: number, box?: object }>, warnings: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function stageMeasurementCrops({ root, workId, sheet, referencePaths = [], subReferences = [], measureSource = 'auto', config = {}, signal, reuse = [] }) {
    const regions = Array.isArray(sheet?.regions) ? sheet.regions : [];
    const elements = Array.isArray(sheet?.elements) ? sheet.elements : [];
    if (!regions.length && elements.length === 0) return { crops: [], warnings: [] };
    const exe = await detectMagick({ magickPath: config.magickPath ?? null }).catch(() => null);
    if (!exe) return { crops: [], warnings: ['ImageMagick не найден: готовые кропы из замеров не созданы.'] };
    const warnings = [];
    const source = await resolveSource({ root, sheet, referencePaths, subReferences, measureSource, warnings });
    if (!source) return { crops: [], warnings: warnings.length ? warnings : ['Источник замеров не найден: готовые кропы не созданы.'] };

    // Resolve one item's own source: its structured `source` field first, then a sub-reference
    // named in the notes, then the sheet source. In the subrefs mode an original that produced
    // sub-references is replaced by a derived sub-reference even when the item pins the original.
    const subRefRels = subReferences.map((file) => file?.rel).filter((rel) => typeof rel === 'string' && rel.trim());
    const resolveItemSource = async (item, name) => {
        const explicit = String(item?.source ?? '').trim();
        if (explicit && !/^https?:|^data:/i.test(explicit)) {
            const sub = subReferences.find((file) => file?.rel === explicit || path.basename(file?.rel ?? '') === path.basename(explicit));
            if (sub && await insideFile(root, sub.rel)) return sub.rel;
            const listed = (referencePaths ?? []).find((item2) => item2 === explicit || path.basename(item2) === path.basename(explicit));
            const originalRel = listed && await insideFile(root, listed) ? listed : await insideFile(root, explicit);
            if (originalRel) {
                if (measureSource === 'subrefs' && subRefRels.length && !subRefRels.includes(originalRel)) {
                    const derived = derivedSubReferences(subReferences, originalRel);
                    const forced = derived[0] ?? subRefRels[0];
                    warnings.push(`Элемент «${name}» назвал источник ${originalRel}: в режиме measure-source: subrefs кроп режется из ${forced}.`);
                    return forced;
                }
                return originalRel;
            }
            warnings.push(`Источник «${explicit}» у элемента «${name}» не найден — использован источник листа.`);
        }
        return namedSubReference(item, subReferences) ?? source;
    };

    // Sizes are resolved per source: a box measured on a restored sub-reference clamps against
    // that sub-reference, not against the original rotated picture.
    const sizeCache = new Map();
    const sizeFor = async (rel) => {
        if (!sizeCache.has(rel)) {
            sizeCache.set(rel, await magickIdentify({ exe, input: rel, cwd: root, signal }).catch(() => null));
        }
        return sizeCache.get(rel);
    };
    const size = await sizeFor(source);
    if (!size?.width || !size?.height) return { crops: [], warnings: [`Не удалось определить размеры ${source}.`] };

    const crops = [];
    const seen = new Map();
    const manifest = new Set();
    const reserved = new Set();
    const cropPrefix = `.tmp/${workId}/crops/`;
    const isCropPath = (rel) => path.normalize(rel).startsWith(path.normalize(cropPrefix));
    let capped = false;

    // Reuse fragments cut after the overview pass when their box survived the second pass.
    for (const item of reuse) {
        if (!item?.crop || !item.box) continue;
        const existing = await insideFile(root, item.crop);
        if (!existing || !isCropPath(existing)) continue;
        reserved.add(existing);
        const key = [Math.round(item.box.x), Math.round(item.box.y), Math.round(item.box.width), Math.round(item.box.height)].join(':');
        if (!seen.has(key)) seen.set(key, existing);
    }

    /** Cut one item and attach the resulting project-relative path to it. */
    const stage = async (item, kind, index, fallback) => {
        if (!item || typeof item !== 'object') return;
        const box = item.box ?? {};
        const x = Number(box.x);
        const y = Number(box.y);
        const width = Number(box.width);
        const height = Number(box.height);
        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
        const name = String(item.name ?? `${fallback} ${index + 1}`);

        if (typeof item.crop === 'string' && item.crop.trim()) {
            const existing = await insideFile(root, item.crop);
            if (existing && isCropPath(existing)) {
                item.crop = existing;
                reserved.add(existing);
                seen.set([Math.round(x), Math.round(y), Math.round(width), Math.round(height)].join(':'), existing);
                if (!manifest.has(existing)) {
                    manifest.add(existing);
                    crops.push({ kind, name, crop: existing, box: { x, y, width, height } });
                }
                return;
            }
        }

        const key = [Math.round(x), Math.round(y), Math.round(width), Math.round(height)].join(':');
        const shared = seen.get(key);
        if (shared) {
            item.crop = shared;
            if (!manifest.has(shared)) {
                manifest.add(shared);
                crops.push({ kind, name, crop: shared, box: { x, y, width, height } });
            }
            return;
        }
        if (reserved.size >= MAX_CROPS) {
            if (!capped) warnings.push(`Кропы ограничены ${MAX_CROPS} фрагментами.`);
            capped = true;
            return;
        }

        const itemSource = await resolveItemSource(item, name);
        const itemSize = itemSource === source ? size : await sizeFor(itemSource);
        if (!itemSize?.width || !itemSize?.height) {
            warnings.push(`Не удалось определить размеры ${itemSource}: кроп «${name}» не создан.`);
            return;
        }

        const left = Math.max(0, Math.min(Math.round(x), itemSize.width - 1));
        const top = Math.max(0, Math.min(Math.round(y), itemSize.height - 1));
        const w = Math.min(Math.round(width), itemSize.width - left);
        const h = Math.min(Math.round(height), itemSize.height - top);
        if (w <= 0 || h <= 0) return;

        let serial = reserved.size + 1;
        let rel = `.tmp/${workId}/crops/${String(serial).padStart(2, '0')}-${kind}-${slug(name, fallback)}.png`;
        while (reserved.has(rel) || await insideFile(root, rel)) {
            serial += 1;
            rel = `.tmp/${workId}/crops/${String(serial).padStart(2, '0')}-${kind}-${slug(name, fallback)}.png`;
        }
        try {
            const result = await magickCrop({ exe, input: itemSource, output: rel, x: left, y: top, width: w, height: h, cwd: root, signal });
            item.crop = result.rel;
            seen.set(key, result.rel);
            manifest.add(result.rel);
            reserved.add(result.rel);
            crops.push({ kind, name, crop: result.rel, bytes: result.bytes, box: { x: left, y: top, width: w, height: h } });
        } catch (error) {
            warnings.push(`Кроп «${name}» не создан: ${error.message}`);
        }
    };

    for (const [index, region] of regions.entries()) await stage(region, 'region', index, 'region');
    for (const [index, element] of elements.entries()) await stage(element, 'element', index, 'element');
    return { crops, warnings };
}

/**
 * Build the compact conclusion for context and run events. It counts what was measured, keeps
 * the unit strategy and assumptions, and lists the shared crops.
 * @param {object} sheet
 * @param {Array<{ kind?: string, name?: string, crop?: string, bytes?: number }>} [crops]
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function measurementConclusion(sheet, crops = []) {
    const elements = Array.isArray(sheet?.elements) ? sheet.elements : [];
    const regions = Array.isArray(sheet?.regions) ? sheet.regions : [];
    const rules = Array.isArray(sheet?.rules) ? sheet.rules : [];
    const lowConfidence = elements.filter((item) => ['low', 'unknown'].includes(item?.confidence)).length;
    return {
        summary: String(sheet?.summary ?? ''),
        source: String(sheet?.source ?? ''),
        unit: String(sheet?.unit ?? 'px'),
        canvas: sheet?.canvas ?? null,
        units: sheet?.units ?? null,
        confidence: String(sheet?.confidence ?? 'unknown'),
        counts: {
            elements: elements.length,
            textElements: elements.filter((item) => item?.typography).length,
            regions: regions.length,
            rules: rules.length,
            crops: crops.length,
            lowConfidence,
        },
        assumptions: Array.isArray(sheet?.assumptions) ? sheet.assumptions : [],
        notes: String(sheet?.notes ?? ''),
        crops: crops.map((item) => ({
            kind: String(item?.kind ?? ''),
            name: String(item?.name ?? ''),
            crop: String(item?.crop ?? ''),
            bytes: Number.isFinite(item?.bytes) ? item.bytes : null,
        })),
    };
}
