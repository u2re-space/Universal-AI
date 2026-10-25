/**
 * @file src/roles/index.js
 * @module roles/index
 * @purpose Collect role prompts, settings, and desktop specialist limits.
 * @depends roles/default, roles/planner, roles/architect, roles/orchestrator, roles/worker, roles/coder, roles/writer, roles/reviewer, roles/vision, roles/summarizer, roles/solver, roles/clicker, roles/typer, roles/encoder, roles/tester, roles/classifier, roles/extractor, roles/measurer, roles/image-processor, roles/reader, roles/implementor, roles/verifier
 * @usedBy commands/instructions, agent/team
 * @exports ROLE_MODULES, ROLE_INSTRUCTIONS, SPECIALISTS
 * @ai.tags roles, prompts, desktop
 * @ai.hint pure
 * @changed 2026-10-25 Added the sub-agent roles (reader, implementor, verifier).
 */

import * as roleDefault from './default.js';
import * as planner from './planner.js';
import * as architect from './architect.js';
import * as orchestrator from './orchestrator.js';
import * as worker from './worker.js';
import * as coder from './coder.js';
import * as writer from './writer.js';
import * as reviewer from './reviewer.js';
import * as vision from './vision.js';
import * as summarizer from './summarizer.js';
import * as solver from './solver.js';
import * as clicker from './clicker.js';
import * as typer from './typer.js';
import * as encoder from './encoder.js';
import * as tester from './tester.js';
import * as classifier from './classifier.js';
import * as extractor from './extractor.js';
import * as measurer from './measurer.js';
import * as imageProcessor from './image-processor.js';
import * as reader from './reader.js';
import * as implementor from './implementor.js';
import * as verifier from './verifier.js';

/**
 * Instructions and settings for every named role.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const ROLE_MODULES = {
    default: { instructions: roleDefault.instructions, settings: roleDefault.settings },
    planner: { instructions: planner.instructions, settings: planner.settings },
    architect: { instructions: architect.instructions, settings: architect.settings },
    orchestrator: { instructions: orchestrator.instructions, settings: orchestrator.settings },
    worker: { instructions: worker.instructions, settings: worker.settings },
    coder: { instructions: coder.instructions, settings: coder.settings },
    writer: { instructions: writer.instructions, settings: writer.settings },
    reviewer: { instructions: reviewer.instructions, settings: reviewer.settings },
    vision: { instructions: vision.instructions, settings: vision.settings },
    summarizer: { instructions: summarizer.fileInstructions, settings: summarizer.settings },
    solver: { instructions: solver.instructions, settings: solver.settings },
    clicker: { instructions: clicker.instructions, settings: clicker.settings },
    typer: { instructions: typer.instructions, settings: typer.settings },
    encoder: { instructions: encoder.instructions, settings: encoder.settings },
    tester: { instructions: tester.instructions, settings: tester.settings },
    classifier: { instructions: classifier.instructions, settings: classifier.settings },
    extractor: { instructions: extractor.instructions, settings: extractor.settings },
    measurer: { instructions: measurer.instructions, settings: measurer.settings },
    'image-processor': { instructions: imageProcessor.instructions, settings: imageProcessor.settings },
    reader: { instructions: reader.instructions, settings: reader.settings },
    implementor: { instructions: implementor.instructions, settings: implementor.settings },
    verifier: { instructions: verifier.instructions, settings: verifier.settings },
};

/**
 * Prompt strings keyed by role, plus summarizer, vision, and measurer variants.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const ROLE_INSTRUCTIONS = {
    ...Object.fromEntries(Object.entries(ROLE_MODULES).map(([name, role]) => [name, role.instructions])),
    summarizerMemory: summarizer.memoryInstructions,
    summarizerFile: summarizer.fileInstructions,
    visionScreen: vision.screenInstructions,
    measurerFragment: measurer.reMeasureInstructions,
};

/**
 * Desktop helper roles with their tools, turn caps, and optional batch schema.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const SPECIALISTS = {
    solver: { tools: ['screenshot', 'view_image'], turns: 6, schema: null },
    clicker: { tools: ['click', 'screenshot'], turns: 4, schema: null },
    typer: { tools: ['type', 'screenshot'], turns: 4, schema: null },
    encoder: { tools: ['screenshot'], turns: 3, schema: 'batch' },
    tester: { tools: ['screenshot'], turns: 4, schema: null },
    measurer: { tools: ['view_image', 'crop_image', 'split_image'], turns: 12, schema: 'measure' },
};
