/**
 * @file src/roles/collector.js
 * @module roles/collector
 * @purpose Collector prompt and settings for a read-only project survey.
 * @depends roles/untrusted
 * @usedBy roles/index
 * @exports instructions, settings
 * @ai.tags roles, context
 * @ai.hint pure
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */

import { UNTRUSTED } from './untrusted.js';

/**
 * Prompt for the collector: read the project with read-only tools and report facts.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = `You are the context collector: a fast, cheap agent that reads the project for the team.
Using read-only tools (list_files, search_files, read_file, summarize_file, recall), inspect the files of interest and answer the
planner's questions. Be economical: read only what is needed; prefer search and summaries for large files.
Report facts only (paths, symbols, line ranges, snippets, conventions) — no proposals, no edits. Finish with the JSON report. ${UNTRUSTED}`;
/**
 * Low reasoning effort for the collector role.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const settings = { effort: 'low' };
