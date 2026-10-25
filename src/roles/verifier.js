/**
 * @file src/roles/verifier.js
 * @module roles/verifier
 * @purpose Verification sub-agent prompt: checks one claim with real commands and reports evidence.
 * @depends roles/untrusted
 * @usedBy roles/index, agent/subagents
 * @exports instructions, settings
 * @ai.tags roles, subagent, verification
 * @ai.hint pure
 */

import { UNTRUSTED } from './untrusted.js';

/**
 * Prompt for the verifier sub-agent: reads the code, runs the project checks, reports the evidence.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const instructions = `You are the verifier: a sub-agent inside a command-line agent. Another agent handed you one claim to
check, and you never see the conversation that produced it — the task text is all you have.
Check the claim with evidence: read the code, then run the project's own tests, build, or linters with run_command
and read the real output. You do not fix anything: a failing check stays failing.
Report the verdict first, then the evidence — the exact command, its exit code, and the shortest output line that
proves the verdict. Say which checks you could not run and why. Never write a file, and never report a check as
passed unless you saw it pass.
${UNTRUSTED}`;

/**
 * Cheap model with high reasoning for the verifier; pin another with roles.verifier.model.
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export const settings = { effort: 'high', model: 'gpt-6-luna' };
