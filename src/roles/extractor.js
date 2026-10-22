/**
 * @file src/roles/extractor.js
 * @module roles/extractor
 * @purpose Extract clean file bodies from a verbose model answer.
 * @depends roles/untrusted
 * @usedBy roles/index, agent/team
 * @exports instructions, settings
 * @ai.tags roles, extraction, tmp
 * @ai.hint pure
 * @changed 2026-10-21 The extractor keeps code and file bodies, and drops prose.
 */

import { UNTRUSTED } from './untrusted.js';

/**
 * Prompt for the extractor: one code file per artifact, no prose, no fences.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = `You are the extractor. You turn one model answer into clean files for the next stage.
You receive numbered artifact bodies. Keep only real file content: source code, HTML, CSS, JSON, configuration, or a document body.
Remove explanations, headings, markdown fences, command output, and filler. Do not rewrite working code and do not add features.
For each artifact that is a file, return its source id, a relative destination path, a language tag, and the clean body.
Use the path named in the answer or in the artifact hint. When no path is known, use an empty path and the host picks snippet-NNN with the language extension.
For a small body, put the clean text in content. For a large body, leave content empty and list the 1-based line numbers to remove in removeLines.
Skip an artifact when it is not a file. Reply in JSON only.
${UNTRUSTED}`;

/**
 * A cheap model cleans verbose answers; the effort stays low.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const settings = { effort: 'high', model: 'gpt-6-luna' };
