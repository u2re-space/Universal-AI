/**
 * @file src/agent/schemas.js
 * @module agent/schemas
 * @purpose Strict JSON schemas for structured role outputs (Responses API text.format = json_schema).
 * @usedBy agent/team, agent/roles
 * @exports PLAN_SCHEMA, ARCHITECT_SCHEMA, IMAGE_PROCESSOR_SCHEMA, COLLECTOR_SCHEMA, REVIEW_SCHEMA, COORDINATION_SCHEMA, MEMORY_SCHEMA, SCREEN_SCHEMA, BATCH_SCHEMA, CLASSIFIER_SCHEMA, EXTRACT_SCHEMA, MEASURER_SCHEMA
 * @ai.tags schema, roles
 * @ai.hint pure
 * @changed 2026-10-24 Added the architect structure and design brief.
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

export const IMAGE_PROCESSOR_SCHEMA = object({
    summary: { ...string, description: 'What image and asset tasks were completed or could not be completed.' },
    assets: {
        type: 'array',
        items: object({
            path: { ...string, description: 'Project-relative path to a created or reused image or visual asset.' },
            format: { ...string, description: 'File format such as png, webp, svg, woff2, or a named icon set.' },
            use: { ...string, description: 'How the implementation should use this asset.' },
        }),
    },
    typography: {
        type: 'array',
        description: 'Researched font recommendations for implementation; empty when no typography work was requested.',
        items: object({
            family: { ...string, description: 'Exact Google Fonts family name or an existing project-provided family.' },
            role: { type: 'string', enum: ['heading', 'body', 'display', 'monospace', 'accent'], description: 'Intended typographic role.' },
            cssFamily: { ...string, description: 'CSS font-family value, with a suitable fallback.' },
            cssUrl: { ...nullableString, description: 'Verified Google Fonts CSS2 stylesheet URL for this family and its recommended weights; null for project-provided or local fonts.' },
            weights: { ...strings, description: 'Recommended available weights, such as 400 and 700.' },
            rationale: { ...string, description: 'Why this family suits its role and how it pairs with the other recommendations.' },
            source: { ...string, description: 'URL used to verify the family.' },
            localPath: { ...nullableString, description: 'Project-relative font file path when downloaded; null when no local file was needed.' },
        }),
    },
    notes: { ...strings, description: 'Unavailable tools, failed operations, or important limitations.' },
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
    filesOfInterest: { ...strings, description: 'Paths (relative) the orchestrator should read or summarize first.' },
    searchQueries: { ...strings, description: 'Literal strings worth searching for in the codebase.' },
    questionsForCollector: { ...strings, description: 'Specific questions the orchestrator should answer from the files.' },
    acceptanceCriteria: strings,
    needsReview: { type: 'boolean', description: 'Whether an independent review of the result is worth its cost.' },
    imageNotes: { ...nullableString, description: 'What the attached images show that matters for the task (null if none).' },
    imageTasks: {
        type: 'array',
        description: 'Image generation/editing and visual asset tasks to complete before implementation. Empty when no assets are needed.',
        items: object({
            goal: { ...string, description: 'Concrete image, fragment, or asset to prepare.' },
            details: { ...string, description: 'Visual direction, source references, intended format, and output path when known.' },
        }),
    },
    risks: strings,
    fileActions: {
        type: 'array',
        description: 'File work after the plan and before the orchestrator collects context. Empty when there is none.',
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

export const ARCHITECT_SCHEMA = object({
    summary: { ...string, description: 'How the solution is organized and why; the shortest useful architecture overview.' },
    structure: {
        type: 'array',
        description: 'Every file, module, component, style sheet, asset, test, or document the implementation will create or change, in build order.',
        items: object({
            path: { ...string, description: 'Project-relative path such as src/app.js or styles/main.scss.' },
            kind: { type: 'string', enum: ['code', 'style', 'markup', 'asset', 'document', 'config', 'test', 'other'], description: 'What kind of file this is.' },
            purpose: { ...string, description: 'What this file is for.' },
            responsibilities: { ...string, description: 'What belongs in this file and what does not.' },
            dependsOn: { ...strings, description: 'Project-relative paths this file imports or builds on; empty when none.' },
            notes: { ...string, description: 'Interfaces, exports, naming, or implementation constraints; empty when none.' },
        }),
    },
    design: object({
        layout: { ...string, description: 'Page, section, and component layout plus responsive behavior; empty when the task is not visual.' },
        typography: { ...string, description: 'Type scale, fonts, and text treatment; empty when not applicable.' },
        color: { ...string, description: 'Palette, design tokens, and contrast rules; empty when not applicable.' },
        motion: { ...string, description: 'Transitions, animation, and interaction states; empty when not applicable.' },
        assets: { ...string, description: 'How measured crops, generated images, icons, and fonts are used; empty when none.' },
    }),
    stepGuidance: {
        type: 'array',
        description: 'Implementation brief for every remaining plan step, keyed by the step id.',
        items: object({
            stepId: { ...string, description: 'Plan step id such as s01.' },
            files: { ...strings, description: 'Project-relative files this step owns; empty when the step owns none.' },
            guidance: { ...string, description: 'What to implement and how: interfaces, order, data flow, styling, pitfalls.' },
        }),
    },
    questionsForOrchestrator: { ...strings, description: 'Facts the orchestrator must confirm from the project before implementation; empty when none.' },
    conventions: { ...strings, description: 'Cross-file conventions and rules every role must follow.' },
    risks: { ...strings, description: 'Structural or design risks that remain; empty when none.' },
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
const insets = object({
    top: { ...nullableNumber, description: 'Measured top side in source pixels.' },
    right: { ...nullableNumber, description: 'Measured right side in source pixels.' },
    bottom: { ...nullableNumber, description: 'Measured bottom side in source pixels.' },
    left: { ...nullableNumber, description: 'Measured left side in source pixels.' },
});

/** How a measured element or region may be reused by another role. */
const measuredKind = {
    type: 'string',
    enum: ['text', 'image', 'icon', 'logo', 'control', 'card', 'background', 'ornament', 'layer', 'other'],
    description: 'What the item is, so another role can decide whether to reuse its crop.',
};

export const MEASURER_SCHEMA = object({
    summary: { ...string, description: 'What the reference shows and how it was measured.' },
    source: { ...string, description: 'The reference file or image this sheet measures.' },
    unit: { ...string, description: 'Source unit of every raw number, usually px; CSS units belong in units and css.' },
    units: object({
        source: { ...string, description: 'Source unit such as px, pt, cm, or unknown.' },
        rootFontSize: { ...nullableNumber, description: 'Source pixels per 1rem when a root size can be supported; null when it is only a guess.' },
        scale: { ...nullableNumber, description: 'CSS pixels per source unit when the reference is scaled; null when unknown.' },
        preferred: { ...strings, description: 'CSS units suitable for the target, such as rem, em, %, vw, vh, ch.' },
        notes: { ...string, description: 'How the units were chosen and which conversions are assumptions.' },
    }),
    confidence: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'], description: 'Overall confidence in this sheet; low when key values are inferred.' },
    assumptions: { ...strings, description: 'Every inferred value or interpretation that is not directly measured.' },
    canvas: { ...box, description: 'The whole reference size.' },
    elements: {
        type: 'array',
        description: 'Every element that carries a number: text block, control, icon, image, ornament.',
        items: object({
            name: { ...string, description: 'Short element name the author can reuse.' },
            kind: measuredKind,
            box,
            rotation: { ...nullableNumber, description: 'Turn clockwise from upright, in degrees. Null when straight or unreadable.' },
            borders: { ...string, description: 'Where the borders and edges fall and how thick they are; empty when none.' },
            radius: { ...nullableNumber, description: 'Corner radius in source pixels. Null when square or unknown.' },
            padding: { ...insets, description: 'Numeric inner spacing by side in source pixels; use null for sides that cannot be measured.' },
            margin: { ...insets, description: 'Numeric outer spacing by side in source pixels; use null for sides that cannot be measured.' },
            gap: { ...nullableNumber, description: 'Numeric gap to adjacent items in source pixels, or null when unknown.' },
            spacing: { ...string, description: 'Additional spacing notes; prefer numeric padding, margin, and gap fields when measurable.' },
            placement: { ...string, description: 'How to place it: grid or flex track, absolute anchor, stacking order; empty when unknown.' },
            css: { ...string, description: 'Ready CSS declarations with explicit units for this element, such as width: 12.5rem; padding: 1rem 1.25rem; font-size: 1.75rem; line-height: 1.2. Empty when no reliable conversion exists.' },
            typography: {
                ...object({
                    role: { ...string, description: 'Text role such as heading, body, label, or button.' },
                    family: { ...string, description: 'Visually identified family only when useful; empty when unknown. Do not guess an exact identity.' },
                    familyConfidence: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'], description: 'Confidence that the visible family identification is correct; unknown when it cannot be identified.' },
                    fontSize: { ...nullableNumber, description: 'Measured font size in source pixels.' },
                    weight: { ...nullableNumber, description: 'Measured or estimated CSS numeric font weight; null when unreadable.' },
                    lineHeight: { ...nullableNumber, description: 'Measured line height in source pixels.' },
                    letterSpacing: { ...nullableNumber, description: 'Measured letter spacing in source pixels.' },
                    style: { ...string, description: 'Visible style such as italic, uppercase, or underline; empty when none.' },
                }),
                type: ['object', 'null'],
                description: 'Typography measurements for text elements; null for non-text elements.',
            },
            confidence: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'], description: 'Confidence in this element: high only when its numbers were actually read.' },
            notes: { ...string, description: 'What is inferred, ambiguous, or hidden; empty when the element is fully measured.' },
            use: { ...string, description: 'How another role should reuse this element or its crop; empty when it is only a measurement target.' },
            crop: { ...nullableString, description: 'Project-relative path to an existing crop of this element, or null.' },
        }),
    },
    regions: {
        type: 'array',
        description: 'How the picture divides into crops, artwork regions, and layers. Prefer many small, reusable fragments over a few large ones.',
        items: object({
            name: { ...string, description: 'Region name the author can reuse.' },
            kind: measuredKind,
            box,
            how: { ...string, description: 'What the crop contains and how to cut it out (crop_image or split_image with these numbers).' },
            use: { ...string, description: 'Which role reuses this fragment and for what, such as artwork reference, icon source, or background layer.' },
            crop: { ...nullableString, description: 'Project-relative path to an existing crop of this region, or null. The worker reuses it as a generate_image reference.' },
        }),
    },
    rules: {
        type: 'array',
        description: 'Repeated measures: spacing scale, ratios, column width, baseline step.',
        items: object({
            name: { ...string, description: 'What this rule covers.' },
            value: { ...nullableNumber, description: 'Numeric measured value, in the sheet unit.' },
            unit: { ...string, description: 'Unit for this value, usually px.' },
            css: { ...string, description: 'CSS form of this rule with an explicit unit, such as --space-2: 0.5rem or 1.5rem.' },
            from: { ...string, description: 'What it was measured between; empty for a global rule.' },
        }),
    },
    notes: { ...string, description: 'What is uncertain and what needs a re-measure on a crop; empty when nothing.' },
});
