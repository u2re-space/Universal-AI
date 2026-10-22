/**
 * @file src/agent/schemas.js
 * @module agent/schemas
 * @purpose Strict JSON schemas for structured role outputs (Responses API text.format = json_schema).
 * @usedBy agent/team, agent/roles
 * @exports PLAN_SCHEMA, COLLECTOR_SCHEMA, REVIEW_SCHEMA, COORDINATION_SCHEMA, MEMORY_SCHEMA, SCREEN_SCHEMA, BATCH_SCHEMA, CLASSIFIER_SCHEMA, EXTRACT_SCHEMA, MEASURER_SCHEMA
 * @ai.tags schema, roles
 * @ai.hint pure
 * @changed 2026-10-22 Added the measurer sheet.
 */

const string = { type: 'string' };
const strings = { type: 'array', items: string };
const nullableString = { type: ['string', 'null'] };
const nullableInteger = { type: ['integer', 'null'] };
const nullableNumber = { type: ['number', 'null'] };
/**
 * Build a strict object schema: every property is required and extras are rejected.
 * Each exported role schema is built with this.
 * @param {object} properties
 * @returns {object}
 * @ai.hint pure
 */
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const CLASSIFIER_SCHEMA = object({
    label: { type: 'string', enum: ['trivial', 'normal', 'complex'], description: 'How large the task is.' },
});

export const PLAN_SCHEMA = object({
    summary: { ...string, description: 'One paragraph: what will be done and why.' },
    complexity: { type: 'string', enum: ['trivial', 'normal', 'complex'] },
    steps: {
        type: 'array',
            items: object({
                goal: { ...string, description: 'Imperative, verifiable goal of the step.' },
                complexity: { type: 'string', enum: ['trivial', 'normal', 'complex'], description: 'How hard this step is.' },
                details: { ...string, description: 'Concrete guidance: files, functions, commands, edge cases.' },
            verify: { ...string, description: 'How the worker should verify this step (command, check, re-read).' },
        }),
    },
    filesOfInterest: { ...strings, description: 'Paths (relative) the collector should read or summarize first.' },
    searchQueries: { ...strings, description: 'Literal strings worth searching for in the codebase.' },
    questionsForCollector: { ...strings, description: 'Specific questions the context collector should answer from the files.' },
    acceptanceCriteria: strings,
    needsReview: { type: 'boolean', description: 'Whether an independent review of the result is worth its cost.' },
    imageNotes: { ...nullableString, description: 'What the attached images show that matters for the task (null if none).' },
    risks: strings,
    fileActions: {
        type: 'array',
        description: 'File work after the plan and before the collector. Empty when there is none.',
        items: object({
            action: { type: 'string', enum: ['encode', 'write', 'read', 'list'] },
            source: nullableString,
            path: nullableString,
            cwd: nullableString,
            language: nullableString,
            reason: string,
            start: nullableInteger,
            end: nullableInteger,
            depth: nullableInteger,
            mode: { type: ['string', 'null'], enum: ['tree', 'list', null], description: 'list action: tree is nested, list is flat.' },
        }),
    },
    taskMap: {
        type: 'array',
        description: 'Final read/edit/scan marks. Empty array when nothing applies.',
        items: object({
            path: string,
            role: { type: 'string', enum: ['read', 'edit', 'scan'] },
            reason: { ...string, description: 'Why this file has this role.' },
        }),
    },
});

export const COLLECTOR_SCHEMA = object({
    findings: {
        type: 'array',
        items: object({
            path: string,
            purpose: { ...string, description: 'What this file is for.' },
            relevant: { ...string, description: 'The parts relevant to the task: symbols, line ranges, snippets, conventions.' },
        }),
    },
    answers: { type: 'array', items: object({ question: string, answer: string }) },
    conventions: { ...strings, description: 'Project conventions observed (style, tooling, test runner, naming).' },
    notes: { ...string, description: 'Anything else the worker must know; empty string if nothing.' },
});

export const REVIEW_SCHEMA = object({
    verdict: { type: 'string', enum: ['accept', 'revise'] },
    summary: string,
    issues: {
        type: 'array',
        items: object({
            severity: { type: 'string', enum: ['low', 'medium', 'high'] },
            path: nullableString,
            message: string,
            requestedChange: string,
        }),
    },
    unverified: { ...strings, description: 'Acceptance criteria that could not be verified.' },
});

export const COORDINATION_SCHEMA = object({
    summary: { ...string, description: 'Current state: what was just done and whether the plan is on track.' },
    nextStep: { ...string, description: 'Concrete guidance for the next worker turn; empty string when none.' },
    planUpdate: object({
        note: { ...string, description: 'Short reason for the change; empty string when the plan is unchanged.' },
        addSteps: {
            type: 'array',
            items: object({
                goal: { ...string, description: 'Imperative, verifiable goal of the new step.' },
                details: { ...string, description: 'Files, functions, commands, and edge cases.' },
                verify: { ...string, description: 'How the worker should verify the step.' },
            }),
        },
        revise: {
            type: 'array',
            items: object({
                id: { ...string, description: 'Pending step id such as s03.' },
                goal: { ...string, description: 'New goal; empty string keeps the current one.' },
                details: { ...string, description: 'New details; empty string keeps the current ones.' },
                verify: { ...string, description: 'New verification; empty string keeps the current one.' },
            }),
        },
    }),
    risks: strings,
});

export const EXTRACT_SCHEMA = object({
    summary: { ...string, description: 'What was extracted and what was dropped.' },
    files: {
        type: 'array',
        items: object({
            source: { ...string, description: 'Artifact id such as a001.' },
            path: { ...string, description: 'Relative destination path, or an empty string when unknown.' },
            language: { ...string, description: 'Language tag such as js, ts, html, css, json, or md.' },
            content: { ...string, description: 'Clean file body for a small artifact. Empty for a large artifact.' },
            removeLines: {
                type: 'array',
                items: { type: 'integer' },
                description: '1-based lines to drop from the original body when content is empty.',
            },
        }),
    },
});

export const MEMORY_SCHEMA = object({
    taskSummary: { ...string, description: '2-4 sentences: what was done and the outcome.' },
    memories: {
        type: 'array',
        items: object({
            scope: { type: 'string', enum: ['project', 'global'] },
            kind: { type: 'string', enum: ['fact', 'convention', 'decision', 'preference', 'pitfall'] },
            content: { ...string, description: 'One or two specific sentences, useful in future sessions.' },
            tags: strings,
        }),
    },
});

export const SCREEN_SCHEMA = object({
    summary: { ...string, description: 'What is on screen.' },
    elements: {
        type: 'array',
        description: 'Visible controls. Coordinates are screenshot pixels, or null when unknown.',
        items: object({
            name: { ...string, description: 'Control name.' },
            text: { ...string, description: 'Visible text.' },
            x: nullableInteger,
            y: nullableInteger,
            width: nullableInteger,
            height: nullableInteger,
        }),
    },
    notes: { ...string, description: 'Anything else that matters; empty string if nothing.' },
});

export const BATCH_SCHEMA = object({
    summary: { ...string, description: 'What this batch will do.' },
    actions: {
        type: 'array',
        items: object({
            type: { type: 'string', enum: ['screenshot', 'click', 'type', 'ahk'], description: 'screenshot, click, type, or ahk.' },
            mode: {
                type: ['string', 'null'],
                enum: ['coord', 'title', 'control', 'image', 'text', 'keys', null],
                description: 'Click: coord, title, control, or image. Type: text or keys. Null for screenshot and ahk.',
            },
            x: nullableInteger,
            y: nullableInteger,
            button: {
                type: ['string', 'null'],
                enum: ['left', 'right', 'middle', null],
                description: 'Mouse button. Null when this action does not click.',
            },
            clicks: { ...nullableInteger, description: '1 or 2 for a click. Null when unused.' },
            text: nullableString,
            title: nullableString,
            control: nullableString,
            image: nullableString,
            script: nullableString,
        }),
    },
});

/** A rectangle in source pixels. Every side is null when it cannot be read. */
const box = object({
    x: { ...nullableNumber, description: 'Left edge in source pixels.' },
    y: { ...nullableNumber, description: 'Top edge in source pixels.' },
    width: { ...nullableNumber, description: 'Width in source pixels.' },
    height: { ...nullableNumber, description: 'Height in source pixels.' },
});

export const MEASURER_SCHEMA = object({
    summary: { ...string, description: 'What the reference shows and how it was measured.' },
    source: { ...string, description: 'The reference file or image this sheet measures.' },
    unit: { ...string, description: 'Unit of every number here, usually px of the source image.' },
    canvas: { ...box, description: 'The whole reference size.' },
    elements: {
        type: 'array',
        description: 'Every element that carries a number: text block, control, icon, image, ornament.',
        items: object({
            name: { ...string, description: 'Short element name the author can reuse.' },
            box,
            rotation: { ...nullableNumber, description: 'Turn clockwise from upright, in degrees. Null when straight or unreadable.' },
            borders: { ...string, description: 'Where the borders and edges fall and how thick they are; empty when none.' },
            radius: { ...nullableNumber, description: 'Corner radius in source pixels. Null when square or unknown.' },
            spacing: { ...string, description: 'Padding, margin, and gap around the element; empty when unknown.' },
            placement: { ...string, description: 'How to place it: grid or flex track, absolute anchor, stacking order; empty when unknown.' },
            crop: { ...nullableString, description: 'Project-relative path to an existing crop of this element, or null.' },
        }),
    },
    regions: {
        type: 'array',
        description: 'How the picture divides into crops, artwork regions, and layers.',
        items: object({
            name: { ...string, description: 'Region name the author can reuse.' },
            box,
            how: { ...string, description: 'What the crop contains and how to cut it out (crop_image or split_image with these numbers).' },
            crop: { ...nullableString, description: 'Project-relative path to an existing crop of this region, or null. The worker reuses it as a generate_image reference.' },
        }),
    },
    rules: {
        type: 'array',
        description: 'Repeated measures: spacing scale, ratios, column width, baseline step.',
        items: object({
            name: { ...string, description: 'What this rule covers.' },
            value: { ...string, description: 'The measured value with its unit, for example "8 px step" or "1:1.6".' },
            from: { ...string, description: 'What it was measured between; empty for a global rule.' },
        }),
    },
    notes: { ...string, description: 'What is uncertain and what needs a re-measure on a crop; empty when nothing.' },
});
