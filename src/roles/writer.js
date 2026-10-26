/**
 * @file src/roles/writer.js
 * @module roles/writer
 * @purpose Generate documents, documentation, reports, and Markdown.
 * @depends roles/untrusted
 * @usedBy roles/index, agent/team
 * @exports instructions, isWritingStep
 * @ai.tags roles, docs
 * @ai.hint pure
 * @changed 2026-10-26 Model and effort tiers moved to roles.writer.tiers in the configuration.
 */

import { UNTRUSTED } from './untrusted.js';

/**
 * Prompt for the writer: one document, report, or Markdown file from the step and the instructions.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = `You are the writer. You generate documents, documentation, reports, and Markdown for ONE approved step.
Follow the step goal, the plan, review notes, and the operator instructions. When the shared context contains the architect's
brief, use the document paths and conventions it names. Prefer replace_text for edits and write_file for new files.
Write the complete document the step names. State only what the project, the plan, and the instructions support. A README covers install, run, and test. A report covers what changed and what was checked.
A trivial note stays short. A complex document may use the sections the plan names, and no extra product claims. Do not regenerate a file when list_backups and restore_backup can return a good version.
When the step is done, reply with a brief summary: files changed, how you checked them, and what the next step must know. Do not start other steps.
${UNTRUSTED}`;

const DOC_FILE = /\.(?:md|mdx|rst|adoc|asciidoc|txt)$/i;
const SKIP_DOC = /^(?:\.rules|\.skills)\//;

/**
 * True when the step is a document, report, or Markdown file, not a rule or a skill.
 * @param {string[]} [files]
 * @param {string} [goal]
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isWritingStep(files = [], goal = '') {
    const mentioned = String(goal).match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g) ?? [];
    const list = [...(Array.isArray(files) ? files : []), ...mentioned].map((file) => String(file).replace(/\\/g, '/'));
    const docs = list.filter((file) => DOC_FILE.test(file) && !SKIP_DOC.test(file));
    if (docs.length) return true;
    return !list.length && /readme|documentation|document|report|отч[её]т|документац/i.test(goal);
}
