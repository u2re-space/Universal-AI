/**
 * @file src/roles/encoder.js
 * @module roles/encoder
 * @purpose Encoder prompts: a desktop action batch, file commands, and clean file bodies.
 * @depends roles/untrusted
 * @usedBy roles/index, agent/team
 * @exports instructions, fileInstructions, extractInstructions
 * @ai.tags roles, desktop, batch, extraction
 * @ai.hint pure
 * @changed 2026-10-31 Merged the former extractor role into the encoder.
 */

import { UNTRUSTED } from './untrusted.js';

/**
 * Prompt for file commands. The desktop batch prompt stays `instructions`.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const fileInstructions = `You turn one answer into file commands. Do not run them.
Each command is fs:read, fs:write, or fs:list. You choose path and language. A fence tag and a nearby filename are hints, not the decision.
fs:list reads a directory. mode is "tree" for a nested tree or "list" for a flat list of files and directories. depth is 1 to 6. Other list fields are null.
A write has exactly one body: source (a .tmp path), lines, or content. A body larger than 2048 bytes uses source.
A read leaves content, lines, and source null. start and end are both null, or both 1-based inclusive line numbers.
Use "." for cwd when the path is already relative to the working directory. Unused fields are null. Reply in JSON only.
When a Workspace scan is present, prefer the files it resolved for fs:read and fs:write. Import aliases in that scan are already file paths.
When the handoff has extracted files, prefer their source paths: they are already clean and carry a language. Do not write back into .tmp.
${UNTRUSTED}`;

/**
 * Prompt for the former extractor: one code file per artifact, no prose, no fences.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export const extractInstructions = `You are the encoder in extraction mode. You turn one model answer into clean files for the next stage.
You receive numbered artifact bodies. Keep only real file content: source code, HTML, CSS, JSON, configuration, or a document body.
Remove explanations, headings, markdown fences, command output, and filler. Do not rewrite working code and do not add features.
For each artifact that is a file, return its source id, a relative destination path, a language tag, and the clean body.
Use the path named in the answer or in the artifact hint. When no path is known, use an empty path and the host picks snippet-NNN with the language extension.
For a small body, put the clean text in content. For a large body, leave content empty and list the 1-based line numbers to remove in removeLines.
Skip an artifact when it is not a file. Reply in JSON only.
${UNTRUSTED}`;

export const instructions = `You encode one task into a batch for later execution. Do not run the batch.
The batch has summary and actions. Each action type is screenshot, click, type, or ahk.
click.mode is coord, title, control, or image. type.mode is text or keys. ahk.script is AutoHotkey v2 statements, not a complete program.
Use null for unused fields. Reply in JSON only. ${UNTRUSTED}`;
