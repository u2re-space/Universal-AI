/**
 * @file src/generate/brief.js
 * @module generate/brief
 * @purpose Turn a generation request into a team task, operator instructions, and a manifest.
 * @depends node:path, node:fs/promises, generate/fidelity, generate/platform, generate/scaffold
 * @usedBy commands/gen
 * @exports GENERATION_KINDS, KIND_OUTPUTS, buildGenerationBrief, writeGenerationManifest
 * @ai.tags generate
 * @ai.hint pure
 * @changed 2026-10-16 English scaffold wrapper.
 */
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fidelityContract, fidelityInstructions } from './fidelity.js';
import { platformInstructions } from './platform.js';
import { filesForKind, stackText, recommendStack, renderGenerationTask, kindRules } from './scaffold.js';

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
 * Build the task, the operator instructions, and the manifest that is written to disk.
 * @param {{ kind: string, prompt?: string, name?: string, fidelity: number, creativity: number, platform: object, references?: { images?: string[], files?: string[], templates?: string[], examples?: string[] } }} request
 * @returns {{ task: string, instructions: string, manifest: object }}
 * @exports
 * @ai.hint pure
 */
export function buildGenerationBrief({ kind = null, prompt = '', name = 'app', fidelity, creativity, platform, references = {} }) {
    if (kind != null && !GENERATION_KINDS.includes(kind)) throw new Error(`Вид генерации: ${GENERATION_KINDS.join('|')}`);
    const contract = fidelityContract({ fidelity, creativity });
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
    const recommendations = recommendStack({ kind, prompt, references: refs });
    const outputs = kind ? [...filesForKind(kind)] : [];
    const manifest = {
        kind, prompt, fidelity: contract.fidelity, creativity: contract.creativity, measured: null,
        method: 'unmeasured', reason: contract.reason, platform: platform.id, experimentalFlags: false,
        references: refs, outputs, stack: { kind, text: stackText(kind, platform) }, recommendations,
    };
    const task = [
        renderGenerationTask({ kind, prompt, platform, recommendations, name }),
        '',
        `Fidelity target: ${contract.fidelity}%. Measured match: unmeasured. Do not invent a percentage.`,
        `Creativity for elements that are not in the references: ${contract.creativity}%.`,
        '',
        listed.length ? 'References:' : 'References: none attached.',
        ...listed,
        '',
        'A contract file .ai/generation.json is already written. You may add the paths you created. Leave measured null.',
        ...(refs.images.length ? ['', 'Reference images are mockups. Recreate their photographs, illustrations, and textures with generate_image, or change a reference file with edit_image. If the only image tool is image_generation, use that. Point the page at the new files. Do not use a reference image as the page background or as a screenshot of the whole layout. Type, controls, and layout are HTML and CSS.'] : []),
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
        fidelityInstructions(contract),
        ...(refs.images.length ? ['', 'The worker must create each artwork region with generate_image or edit_image before the page is finished. The saved image paths belong in the HTML and CSS.'] : []),
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
