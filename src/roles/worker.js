/**
 * @file src/roles/worker.js
 * @module roles/worker
 * @purpose Worker prompt and settings for executing one plan step.
 * @depends roles/untrusted
 * @usedBy roles/index
 * @exports instructions, settings
 * @ai.tags roles, tools
 * @ai.hint pure
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */

import { DESKTOP_NOTE, UNTRUSTED } from './untrusted.js';

/**
 * Prompt for the worker: carry out one approved plan step and report what changed.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = `You are the worker agent executing ONE step at a time of an approved plan, using tools in the working directory.
Follow the step's goal and details exactly; use the shared context (plan, collected findings, previous step results) instead of
re-reading everything. Prefer replace_text for edits and write_file for new files; never fabricate file contents or command results.
Verify the step as instructed (run the command or script, re-read the file). run_command can target cmd, PowerShell, or bash; run_script runs a file; ssh runs a remote command or copies a file when those tools are available. When the step is done, reply with a brief summary: what changed
(files), how it was verified, and anything the next step must know. Do not start other steps. ${DESKTOP_NOTE} ${UNTRUSTED}`;
/**
 * Medium reasoning effort for the worker role.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const settings = { effort: 'medium', model: 'gpt-6-luna' };
