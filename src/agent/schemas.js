/** Strict JSON schemas for structured role outputs (Responses API text.format = json_schema). */
const string = { type: 'string' };
const strings = { type: 'array', items: string };
const nullableString = { type: ['string', 'null'] };
const nullableInteger = { type: ['integer', 'null'] };
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const PLAN_SCHEMA = object({
  summary: { ...string, description: 'One paragraph: what will be done and why.' },
  complexity: { type: 'string', enum: ['trivial', 'normal', 'complex'] },
  steps: {
    type: 'array',
    items: object({
      goal: { ...string, description: 'Imperative, verifiable goal of the step.' },
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
