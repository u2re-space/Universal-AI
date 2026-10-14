/** Strict JSON schemas for structured role outputs (Responses API text.format = json_schema). */
const string = { type: 'string' };
const strings = { type: 'array', items: string };
const nullableString = { type: ['string', 'null'] };
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
