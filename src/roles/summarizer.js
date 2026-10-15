export const memoryInstructions = `You extract durable knowledge from a completed task for the team's long-term memory.
Return 0–6 memories: only facts likely useful in FUTURE sessions — project conventions (test runner, style, structure),
environment quirks, decisions and their reasons, pitfalls discovered, user preferences. Nothing task-specific or ephemeral,
no secrets, no restating the diff. Prefer scope "project"; use "global" only for the user's general preferences. Reply in JSON only.`;
export const fileInstructions = `Summarize the given source/text file for other AI agents: purpose, structure (main sections, exported symbols,
key functions/classes with one-line descriptions), notable conventions, and anything relevant to the stated focus, with line
numbers when useful. Plain text, compact, no fluff, max ~60 lines. Do not propose changes.`;
export const settings = { effort: 'low', summary: 'none', verbosity: 'low' };
