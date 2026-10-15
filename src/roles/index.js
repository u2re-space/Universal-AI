import * as roleDefault from './default.js';
import * as planner from './planner.js';
import * as collector from './collector.js';
import * as worker from './worker.js';
import * as reviewer from './reviewer.js';
import * as vision from './vision.js';
import * as summarizer from './summarizer.js';
import * as scanner from './scanner.js';
import * as solver from './solver.js';
import * as clicker from './clicker.js';
import * as typer from './typer.js';
import * as encoder from './encoder.js';
import * as tester from './tester.js';

export const ROLE_MODULES = {
    default: { instructions: roleDefault.instructions, settings: roleDefault.settings },
    planner: { instructions: planner.instructions, settings: planner.settings },
    collector: { instructions: collector.instructions, settings: collector.settings },
    worker: { instructions: worker.instructions, settings: worker.settings },
    reviewer: { instructions: reviewer.instructions, settings: reviewer.settings },
    vision: { instructions: vision.instructions, settings: vision.settings },
    summarizer: { instructions: summarizer.fileInstructions, settings: summarizer.settings },
    scanner: { instructions: scanner.instructions, settings: scanner.settings },
    solver: { instructions: solver.instructions, settings: solver.settings },
    clicker: { instructions: clicker.instructions, settings: clicker.settings },
    typer: { instructions: typer.instructions, settings: typer.settings },
    encoder: { instructions: encoder.instructions, settings: encoder.settings },
    tester: { instructions: tester.instructions, settings: tester.settings },
};

export const ROLE_INSTRUCTIONS = {
    ...Object.fromEntries(Object.entries(ROLE_MODULES).map(([name, role]) => [name, role.instructions])),
    summarizerMemory: summarizer.memoryInstructions,
    summarizerFile: summarizer.fileInstructions,
    visionScreen: vision.screenInstructions,
};

export const SPECIALISTS = {
    scanner: { tools: ['screenshot'], turns: 4, schema: null },
    solver: { tools: ['screenshot'], turns: 6, schema: null },
    clicker: { tools: ['click', 'screenshot'], turns: 4, schema: null },
    typer: { tools: ['type', 'screenshot'], turns: 4, schema: null },
    encoder: { tools: ['screenshot'], turns: 3, schema: 'batch' },
    tester: { tools: ['screenshot'], turns: 4, schema: null },
};
