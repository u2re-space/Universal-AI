/**
 * @file src/agent/measure-crops.js
 * @module agent/measure-crops
 * @purpose Cut ready reference crops for the regions in a measurement sheet so the worker can
 *          pass them straight to generate_image instead of cropping the same mockup again.
 * @depends node:path, node:fs/promises, agent/paths, agent/image-magick
 * @usedBy agent/team
 * @exports stageMeasurementCrops
 * @ai.tags images, measurement, crop
 * @ai.hint io
 * @changed 2026-10-22 Created: reuse measure crops as image-generation references.
 */

import path from 'node:path';
import { stat } from 'node:fs/promises';
import { resolveInside } from './paths.js';
import { detectMagick, magickCrop, magickIdentify } from './image-magick.js';

/** Upper bound on automatic crops for one measurement sheet. */
const MAX_CROPS = 24;

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
 * Cut every region in `sheet` that has a usable box and no existing crop. The crop path is
 * written back to `region.crop`, so `renderMeasurements` and `measurements.json` carry it.
 * @param {{ root: string, workId: string, sheet: object, referencePaths?: string[], config?: object, signal?: AbortSignal }} options
 * @returns {Promise<{ crops: Array<{ name: string, crop: string, bytes?: number }>, warnings: string[] }>}
 * @exports
 * @ai.hint io
 */
export async function stageMeasurementCrops({ root, workId, sheet, referencePaths = [], config = {}, signal }) {
    const regions = Array.isArray(sheet?.regions) ? sheet.regions : [];
    if (!regions.length) return { crops: [], warnings: [] };
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
    let created = 0;
    for (const [index, region] of regions.entries()) {
        if (!region || typeof region !== 'object') continue;
        const box = region.box ?? {};
        const x = Number(box.x);
        const y = Number(box.y);
        const width = Number(box.width);
        const height = Number(box.height);
        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;

        if (typeof region.crop === 'string' && region.crop.trim()) {
            const existing = await insideFile(root, region.crop);
            if (existing) {
                region.crop = existing;
                crops.push({ name: String(region.name ?? ''), crop: existing });
                continue;
            }
        }
        if (created >= MAX_CROPS) {
            warnings.push(`Кропы ограничены ${MAX_CROPS} областями.`);
            break;
        }

        const left = Math.max(0, Math.min(Math.round(x), size.width - 1));
        const top = Math.max(0, Math.min(Math.round(y), size.height - 1));
        const w = Math.min(Math.round(width), size.width - left);
        const h = Math.min(Math.round(height), size.height - top);
        if (w <= 0 || h <= 0) continue;

        const rel = `.tmp/${workId}/crops/${String(index + 1).padStart(2, '0')}-${slug(region.name, 'region')}.png`;
        try {
            const result = await magickCrop({ exe, input: source, output: rel, x: left, y: top, width: w, height: h, cwd: root, signal });
            region.crop = result.rel;
            crops.push({ name: String(region.name ?? ''), crop: result.rel, bytes: result.bytes });
            created++;
        } catch (error) {
            warnings.push(`Кроп «${region.name || index + 1}» не создан: ${error.message}`);
        }
    }
    return { crops, warnings };
}
