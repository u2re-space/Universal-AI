/**
 * @file src/generate/brief.js
 * @module generate/brief
 * @purpose Turn a generation request into a team task, operator instructions, and a manifest.
 * @depends node:path, node:fs/promises, generate/fidelity, generate/platform
 * @usedBy commands/gen
 * @exports GENERATION_KINDS, KIND_OUTPUTS, KIND_RULES, buildGenerationBrief, writeGenerationManifest
 * @ai.tags generate
 * @ai.hint pure
 * @changed 2026-10-15 Brief for landing, site, backend, and app.
 */
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fidelityContract, fidelityInstructions } from './fidelity.js';
import { platformInstructions } from './platform.js';

/** Kinds `ai gen` accepts. */
export const GENERATION_KINDS = Object.freeze(['landing', 'site', 'backend', 'app']);

/** Files the model is asked to create for each kind. */
export const KIND_OUTPUTS = Object.freeze({
    landing: Object.freeze(['index.html', 'styles.css']),
    site: Object.freeze(['index.html', 'styles.css', 'about.html']),
    backend: Object.freeze(['server.js']),
    app: Object.freeze(['server.js', 'public/index.html', 'public/styles.css']),
});

/** Stack rules. No npm and no bundler. Servers stay on node:http. */
export const KIND_RULES = Object.freeze({
    landing: 'One static page. Semantic HTML and one stylesheet. No framework, no bundler, no npm.',
    site: 'A small multi-page static site sharing one stylesheet. No framework, no bundler, no npm.',
    backend: 'Node.js 26 ESM. Use node:http only. No npm dependencies. Bind 127.0.0.1. Port from PORT or 3000.',
    app: 'Node.js 26 ESM server plus static files in public/. Use node:http only. No npm dependencies. Bind 127.0.0.1. Port from PORT or 3000.',
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
 * @param {{ kind: string, prompt?: string, fidelity: number, creativity: number, platform: object, references?: { images?: string[], files?: string[], templates?: string[], examples?: string[] } }} request
 * @returns {{ task: string, instructions: string, manifest: object }}
 * @exports
 * @ai.hint pure
 */
export function buildGenerationBrief({ kind = null, prompt = '', fidelity, creativity, platform, references = {} }) {
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
    const manifest = {
        kind,
        prompt,
        fidelity: contract.fidelity,
        creativity: contract.creativity,
        measured: null,
        method: 'unmeasured',
        reason: contract.reason,
        platform: platform.id,
        experimentalFlags: false,
        references: refs,
        outputs: kind ? [...KIND_OUTPUTS[kind]] : [],
    };
    const task = [
        kind ? `Generate a ${kind}.` : 'Generate from the request and the references.',
        '',
        'User request:',
        prompt.trim() || '(no text; follow the references)',
        '',
        `Fidelity target: ${contract.fidelity}%. Measured match: unmeasured. Do not invent a percentage.`,
        `Creativity for elements that are not in the references: ${contract.creativity}%.`,
        '',
        listed.length ? 'References:' : 'References: none attached.',
        ...listed,
        '',
        manifest.outputs.length ? 'Create these files:' : 'Create the files the request needs.',
        ...manifest.outputs.map((file) => `- ${file}`),
        '',
        'A contract file .ai/generation.json is already written. You may add the paths you created. Leave measured null.',
    ].join('\n');
    const instructions = [
        platformInstructions(platform),
        '',
        kind ? KIND_RULES[kind] : 'Choose the files the request needs.',
        '',
        fidelityInstructions(contract),
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
