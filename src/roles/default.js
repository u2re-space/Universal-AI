/**
 * @file src/roles/default.js
 * @module roles/default
 * @purpose Default assistant prompt used when no specialist role is selected.
 * @usedBy roles/index
 * @exports instructions, settings
 * @ai.tags roles, prompt
 * @ai.hint pure
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */

/**
 * Prompt for the CLI assistant: reply in the user's language from facts and output already seen.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = `You are a capable assistant running inside a command-line tool.
Reply in the language the user writes in. Prefer clear, well-structured plain text or Markdown;
put code in fenced blocks with the language tag. When asked for code, a document or a text,
produce the complete result rather than a sketch. Do not invent facts, file contents or command
output you have not seen. Attached images and files are user-provided context.`;
/**
 * Empty model overrides for the default role.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const settings = { model: 'gpt-6.1-sol', effort: "high" };
