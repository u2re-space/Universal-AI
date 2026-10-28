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
 */

import path from 'node:path';
import { stat } from 'node:fs/promises';
import { resolveInside } from './paths.js';
import { detectMagick, magickCrop, magickIdentify } from './image-magick.js';

/** Upper bound on automatic crops for one measurement sheet. */
const MAX_CROPS = 96;

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
 * Resolve the source image of a sheet. The measurer usually names the reference by basename;
 * a staged reference path is preferred over a model-provided path so nothing outside the
 * working directory can be read.
 * @param {{ root: string, sheet: object, referencePaths: string[] }} options
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

async function resolveSource({ root, sheet, referencePaths }) {
    const candidates = (referencePaths ?? []).filter((item) => typeof item === 'string' && item.trim());
    const named = String(sheet?.source ?? '').trim();
    if (named && !/^https?:|^data:/i.test(named)) {
        const exact = candidates.find((item) => item === named || path.basename(item) === path.basename(named));
        if (exact && await insideFile(root, exact)) return exact;
        const direct = await insideFile(root, named);
        if (direct) return direct;
    }
    for (const item of candidates) {
        if (await insideFile(root, item)) return item;
    }
    return null;
}

/**
 * Cut every region and reusable element in `sheet` that has a usable box and no existing crop.
 * The crop path is written back to the item, so `renderMeasurements`, `measurements.json`, and
 * the conclusion carry it. Identical boxes share one file.
 * @param {{ root: string, workId: string, sheet: object, referencePaths?: string[], config?: object, signal?: AbortSignal, reuse?: Array<{ crop?: string, box?: object }> }} options
 * @returns {Promise<{ crops: Array<{ kind: string, name: string, crop: string, bytes?: number, box?: object }>, warnings: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function stageMeasurementCrops({ root, workId, sheet, referencePaths = [], config = {}, signal, reuse = [] }) {
    const regions = Array.isArray(sheet?.regions) ? sheet.regions : [];
    const elements = Array.isArray(sheet?.elements) ? sheet.elements : [];
    if (!regions.length && !elements.length) return { crops: [], warnings: [] };
    const exe = await detectMagick({ magickPath: config.magickPath ?? null }).catch(() => null);
    if (!exe) return { crops: [], warnings: ['ImageMagick не найден: готовые кропы из замеров не созданы.'] };
    const source = await resolveSource({ root, sheet, referencePaths });
    if (!source) return { crops: [], warnings: ['Источник замеров не найден: готовые кропы не созданы.'] };

    let size;
    try {
        size = await magickIdentify({ exe, input: source, cwd: root, signal });
    } catch (error) {
        return { crops: [], warnings: [`Не удалось прочитать ${source}: ${error.message}`] };
    }
    if (!size.width || !size.height) return { crops: [], warnings: [`Не удалось определить размеры ${source}.`] };

    const crops = [];
    const warnings = [];
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

        const left = Math.max(0, Math.min(Math.round(x), size.width - 1));
        const top = Math.max(0, Math.min(Math.round(y), size.height - 1));
        const w = Math.min(Math.round(width), size.width - left);
        const h = Math.min(Math.round(height), size.height - top);
        if (w <= 0 || h <= 0) return;

        let serial = reserved.size + 1;
        let rel = `.tmp/${workId}/crops/${String(serial).padStart(2, '0')}-${kind}-${slug(name, fallback)}.png`;
        while (reserved.has(rel) || await insideFile(root, rel)) {
            serial += 1;
            rel = `.tmp/${workId}/crops/${String(serial).padStart(2, '0')}-${kind}-${slug(name, fallback)}.png`;
        }
        try {
            const result = await magickCrop({ exe, input: source, output: rel, x: left, y: top, width: w, height: h, cwd: root, signal });
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
