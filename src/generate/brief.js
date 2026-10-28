/**
 * @file src/generate/brief.js
 * @module generate/brief
 * @purpose Turn a generation request into a team task, operator instructions, and a manifest.
 * @depends node:path, node:fs/promises, generate/fidelity, generate/platform, generate/scaffold
 * @usedBy commands/gen
 * @exports GENERATION_KINDS, KIND_OUTPUTS, buildGenerationBrief, writeGenerationManifest
 * @ai.tags generate
 * @ai.hint pure
 * @changed 2026-10-22 Reference images carry staged paths and pixel dimensions.
 */
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fidelityContract, fidelityInstructions, effectiveFidelity } from './fidelity.js';
import { platformInstructions } from './platform.js';
import { filesForKind, filesForStack, stackText, recommendStack, renderGenerationTask, kindRules } from './scaffold.js';

/** Kinds `ai gen` accepts. */
export const GENERATION_KINDS = Object.freeze(['landing', 'site', 'backend', 'app']);

/** Files the model is asked to create for each kind. */
export const KIND_OUTPUTS = Object.freeze({
    landing: Object.freeze(filesForKind('landing')),
    site: Object.freeze(filesForKind('site')),
    backend: Object.freeze(filesForKind('backend')),
    app: Object.freeze(filesForKind('app')),
});

/**
 * One reference group as bullet lines. Empty groups are omitted.
 * @param {string} label
 * @param {string[]} items
 * @returns {string[]}
 * @ai.hint pure
 */
function referenceLines(label, items) {
    if (!items?.length) return [];
    return [`${label}:`, ...items.map((item) => `- ${item}`)];
}

/**
 * Format a staged reference as a bullet line with optional dimensions.
 * @param {object} ref
 * @returns {string}
 */
function formatStagedRef(ref) {
    const dim = ref.width && ref.height ? ` (${ref.width}×${ref.height})` : '';
    return `- ${ref.rel}${dim}`;
}

/**
 * Build the task, the operator instructions, and the manifest that is written to disk.
 * @param {{ kind: string, prompt?: string, name?: string, fidelity: number, creativity: number, platform: object, references?: { images?: string[], files?: string[], templates?: string[], examples?: string[] }, stagedRefs?: object[] }} request
 * @returns {{ task: string, instructions: string, manifest: object }}
 * @exports
 * @ai.hint pure
 */
export function buildGenerationBrief({ kind = null, prompt = '', name = 'app', fidelity, creativity, platform, quality = 40, references = {}, stagedRefs = [] }) {
    if (kind != null && !GENERATION_KINDS.includes(kind)) throw new Error(`Вид генерации: ${GENERATION_KINDS.join('|')}`);
    const contract = fidelityContract({ fidelity, creativity });
    const effective = effectiveFidelity(contract.fidelity, quality);
    const refs = {
        images: [...(references.images ?? [])],
        files: [...(references.files ?? [])],
        templates: [...(references.templates ?? [])],
        examples: [...(references.examples ?? [])],
    };
    const listed = [
        ...referenceLines('Images and mockups', refs.images),
        ...referenceLines('Files', refs.files),
        ...referenceLines('Templates', refs.templates),
        ...referenceLines('Design examples', refs.examples),
    ];

    // Staged reference bullets (project-relative paths with dimensions).
    const stagedLines = stagedRefs.length
        ? ['', 'Staged references (project-relative, ready for crop/generate):', ...stagedRefs.map(formatStagedRef)]
        : [];

    const recommendations = recommendStack({ kind, prompt, references: refs });
    const outputs = kind ? [...filesForStack({ kind, libraries: recommendations.libraries })] : [];
    const manifest = {
        kind, prompt, fidelity: contract.fidelity, effectiveFidelity: effective, creativity: contract.creativity, measured: null,
        method: 'unmeasured', reason: contract.reason, platform: platform.id, experimentalFlags: false,
        references: refs, outputs, stack: { kind, text: stackText(kind, platform, recommendations.libraries) }, recommendations,
        stagedRefs: stagedRefs.map((r) => ({ rel: r.rel, bytes: r.bytes, mime: r.mime, width: r.width, height: r.height })),
    };
    const task = [
        renderGenerationTask({ kind, prompt, platform, recommendations, name }),
        '',
        `Fidelity target: ${effective}%. Measured match: unmeasured. Do not invent a percentage.`,
        `Requested fidelity ${contract.fidelity}% at quality ${quality} works as ${effective}%.`,
        `Creativity for elements that are not in the references: ${contract.creativity}%.`,
        '',
        listed.length ? 'References:' : 'References: none attached.',
        ...listed,
        '',
        'A contract file .ai/generation.json is already written. You may add the paths you created. Leave measured null.',
        ...stagedLines,
        '',
        ...(refs.images.length ? [
            'Reference images are mockups. Recreate their photographs, illustrations, and textures without using a reference image as the page background or as a screenshot of the whole layout. Type, controls, and layout are HTML and CSS.',
            '',
            '# Reference artwork workflow',
            '1. Use view_image to inspect the reference and crop_image or split_image only to extract the needed existing artwork regions.',
            '2. Reuse existing artwork candidates. Do not call generate_image, edit_image, or image_generation to make comparison variants or to assemble an atlas/sprite sheet. Compare existing files with compare_images: it reads pixels locally via sharp/node-canvas, renders SVG candidates through ReSVG, and writes a PNG sheet and optional pixel-difference map, without an SVG snapshot, browser rasterization, ImageMagick pipeline, or another AI request.',
            '3. If any existing stage produced a PNG with a real alpha channel, keep that file as the preferred candidate. Do not regenerate, repaint, or flatten it; an optional SVG conversion may be tried on a copy. If a WebP copy is useful, convert it locally and keep the PNG; never use image generation or editing just to change the format.',
            '4. Compare candidates in a common frame with the same aspect ratio. compare_images fits each image proportionally using transparent/neutral padding or a deliberate crop; never stretch an image. Keep the original files unchanged.',
            '5. Inspect the result with view_image only when visual judgment is needed, then keep the best existing candidate.'
        ] : []),
        '',
        'Customer task:',
        '',
        '```md',
        prompt.trim() || '(no text; follow the references)',
        '```',
    ].join('\n');
    const instructions = [
        platformInstructions(platform),
        '',
        kindRules(kind, recommendations),
        '',
        fidelityInstructions({ ...contract, fidelity: effective }),
        ...(refs.images.length ? ['', 'The worker must create each artwork region with generate_image or edit_image before the page is finished. The saved image paths belong in the HTML and CSS. Use generate_image(reference=...) to send cropped regions directly to the generator.'] : []),
    ].join('\n');
    return { task, instructions, manifest };
}

/**
 * Write the manifest to `.ai/generation.json` under `root`.
 * @param {string} root Working directory.
 * @param {object} manifest
 * @returns {Promise<string>} Absolute path of the file.
 * @exports
 * @ai.hint io
 */
export async function writeGenerationManifest(root, manifest) {
    const dir = path.join(root, '.ai');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'generation.json');
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
    return file;
}
