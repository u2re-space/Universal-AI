/**
 * @file src/roles/index.js
 * @module roles/index
 * @purpose Collect the prompt of every named role.
 * @depends roles/default, roles/planner, roles/architect, roles/orchestrator, roles/worker, roles/coder, roles/styler, roles/writer, roles/reviewer, roles/vision, roles/summarizer, roles/solver, roles/clicker, roles/typer, roles/encoder, roles/tester, roles/classifier, roles/extractor, roles/measurer, roles/decorator, roles/image-processor
 * @usedBy commands/instructions, agent/team
 * @exports ROLE_INSTRUCTIONS
 * @ai.tags roles, prompts
 * @ai.hint pure
 * @changed 2026-10-26 Role modules carry prompts only; model settings and tiers live in roles.* of the configuration.
 */

import * as roleDefault from './default.js';
import * as planner from './planner.js';
import * as architect from './architect.js';
import * as orchestrator from './orchestrator.js';
import * as worker from './worker.js';
import * as coder from './coder.js';
import * as styler from './styler.js';
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
import * as decorator from './decorator.js';
import * as imageProcessor from './image-processor.js';

/**
 * Prompt strings keyed by role, plus the summarizer, vision, and measurer variants.
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
    writer: writer.instructions,
    reviewer: reviewer.instructions,
    vision: vision.instructions,
    summarizer: summarizer.fileInstructions,
    solver: solver.instructions,
    clicker: clicker.instructions,
    typer: typer.instructions,
    encoder: encoder.instructions,
    tester: tester.instructions,
    classifier: classifier.instructions,
    extractor: extractor.instructions,
    measurer: measurer.instructions,
    decorator: decorator.instructions,
    'image-processor': imageProcessor.instructions,
    summarizerMemory: summarizer.memoryInstructions,
    summarizerFile: summarizer.fileInstructions,
    visionScreen: vision.screenInstructions,
    measurerFragment: measurer.reMeasureInstructions,
};
