/**
 * @file src/roles/index.js
 * @module roles/index
 * @purpose Collect the prompt of every named role.
 * @depends roles/default, roles/planner, roles/architect, roles/orchestrator, roles/worker, roles/coder, roles/styler, roles/iconifier, roles/reviewer, roles/solver, roles/clicker, roles/typer, roles/encoder, roles/classifier, roles/decomposer, roles/measurer, roles/decorator, roles/image-processor
 * @usedBy commands/instructions, agent/team
 * @exports ROLE_INSTRUCTIONS
 * @ai.tags roles, prompts
 * @ai.hint pure
 * @changed 2026-10-31 tester, vision, extractor, summarizer, and writer merged into reviewer, encoder, and orchestrator.
 */

import * as roleDefault from './default.js';
import * as planner from './planner.js';
import * as architect from './architect.js';
import * as orchestrator from './orchestrator.js';
import * as worker from './worker.js';
import * as coder from './coder.js';
import * as styler from './styler.js';
import * as iconifier from './iconifier.js';
import * as reviewer from './reviewer.js';
import * as solver from './solver.js';
import * as clicker from './clicker.js';
import * as typer from './typer.js';
import * as encoder from './encoder.js';
import * as classifier from './classifier.js';
import * as decomposer from './decomposer.js';
import * as measurer from './measurer.js';
import * as decorator from './decorator.js';
import * as imageProcessor from './image-processor.js';

/**
 * Prompt strings keyed by role, plus the reviewer, encoder, and measurer variants.
 * Model, effort, tools, and context come from `roles.<name>` in the configuration.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const ROLE_INSTRUCTIONS = {
    default: roleDefault.instructions,
    planner: planner.instructions,
    architect: architect.instructions,
    orchestrator: orchestrator.instructions,
    worker: worker.instructions,
    coder: coder.instructions,
    styler: styler.instructions,
    iconifier: iconifier.instructions,
    reviewer: reviewer.instructions,
    solver: solver.instructions,
    clicker: clicker.instructions,
    typer: typer.instructions,
    encoder: encoder.instructions,
    classifier: classifier.instructions,
    decomposer: decomposer.instructions,
    measurer: measurer.instructions,
    decorator: decorator.instructions,
    'image-processor': imageProcessor.instructions,
    reviewerCheck: reviewer.checkInstructions,
    reviewerVision: reviewer.visionInstructions,
    reviewerVisionScreen: reviewer.visionScreenInstructions,
    encoderExtract: encoder.extractInstructions,
    orchestratorMemory: orchestrator.memoryInstructions,
    orchestratorFileSummary: orchestrator.fileSummaryInstructions,
    orchestratorWriting: orchestrator.writingInstructions,
    measurerFragment: measurer.reMeasureInstructions,
};
