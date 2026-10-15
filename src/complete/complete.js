/**
 * @file src/complete/complete.js
 * @module complete/complete
 * @purpose Ask a fast low-effort model for the text to insert at a cursor.
 * @depends node:fs/promises, core/config, agent/paths, complete/context, complete/errors
 * @usedBy complete/server, commands/complete, index.js
 * @exports COMPLETION_INSTRUCTIONS, stripCompletion, buildCompletionBody, completeCode
 * @ai.tags complete, openai
 * @ai.hint io
 * @changed 2026-10-15 Editor completion on gpt-5.3-codex-spark.
 */

import { readFile, stat } from 'node:fs/promises';
import { isReasoningModel, supportsVerbosity, REASONING_EFFORTS } from '../core/config.js';
import { resolveInside } from '../agent/paths.js';
import { buildCompletionContext, readCompletionWindow } from './context.js';
import { CompletionError } from './errors.js';

/** The model must return only the insertion. No fences, no explanation. */
export const COMPLETION_INSTRUCTIONS = `You are a code completion engine, like an editor inline suggestion.
The user message shows a source focus. The cursor is the | character inserted into the focus.
Reply with only the text to insert at that cursor. Do not repeat text that is already before the cursor.
Do not add an explanation, markdown, or a code fence.
Stop at a natural end of the current expression, statement, or line.
If a line was omitted because it was too large, ignore that line and use the nearest visible lines.`;

/**
 * Remove one wrapping code fence. The insertion itself, including indentation, stays.
 * @param {string} text Model output.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function stripCompletion(text) {
    let value = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const fenced = value.match(/^\s*```[^\n`]*\n([\s\S]*?)\n?```\s*$/);
    if (fenced) value = fenced[1];
    return value;
}

/**
 * @param {*} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @param {string} name
 * @returns {number}
 * @ai.hint pure
 */
function pickInt(value, fallback, min, max, name) {
    if (value === undefined || value === null) return fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new CompletionError(`Некорректное поле ${name}.`);
    }
    return value;
}

/**
 * @param {*} value
 * @param {string} fallback
 * @returns {string}
 * @ai.hint pure
 */
function pickString(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/**
 * @param {{ line: number, character: number }|null|undefined} position
 * @param {number} startLine
 * @returns {{ line: number, character: number }|null}
 * @ai.hint pure
 */
function shiftPosition(position, startLine) {
    if (!position) return null;
    return { line: Math.max(0, position.line - startLine), character: position.character };
}

/**
 * Load a path when the editor did not send text. Large files are windowed around the cursor.
 * @param {object} request Editor request.
 * @param {{ cwd: string, config: object }} options
 * @returns {Promise<object>} Request plus content, limits, and model fields.
 * @ai.hint io
 */
async function prepareCompletionRequest(request, { cwd, config }) {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
        throw new CompletionError('Запрос дополнения должен быть объектом.');
    }
    const limits = config.completion;
    const maxLineBytes = pickInt(request.maxLineBytes, limits.maxLineBytes, 1, 8 * 1024 * 1024, 'maxLineBytes');
    const maxContextBytes = pickInt(request.maxContextBytes, limits.maxContextBytes, 64, 1024 * 1024, 'maxContextBytes');
    const neighborLines = pickInt(request.neighborLines, limits.neighborLines, 0, 20, 'neighborLines');
    const effort = pickString(request.effort, limits.effort);
    if (!REASONING_EFFORTS.includes(effort)) throw new CompletionError(`effort: ${REASONING_EFFORTS.join(' | ')}`);
    const model = pickString(request.model, limits.model);
    const maxOutputTokens = pickInt(request.maxOutputTokens, limits.maxOutputTokens, 16, 4096, 'maxOutputTokens');

    let content = typeof request.content === 'string' ? request.content : null;
    const hasSplit = typeof request.prefix === 'string' || typeof request.suffix === 'string';
    let startLine = 0;
    let omitLines = [];
    let cursor = request.cursor ?? null;
    let selection = request.selection ?? null;

    if (content === null && !hasSplit) {
        if (typeof request.path !== 'string' || !request.path.trim()) {
            throw new CompletionError('Нужен content, prefix или path к файлу.');
        }
        let abs;
        try { ({ abs } = await resolveInside(cwd, request.path)); }
        catch (error) { throw new CompletionError(error.message, { status: 400, code: 'BAD_PATH' }); }
        let info;
        try { info = await stat(abs); }
        catch { throw new CompletionError(`Файл не найден: ${request.path}`, { status: 400, code: 'BAD_PATH' }); }
        if (!info.isFile()) throw new CompletionError(`Не файл: ${request.path}`, { status: 400, code: 'BAD_PATH' });
        const anchor = cursor?.line ?? selection?.start?.line ?? null;
        if (info.size > maxLineBytes) {
            if (!Number.isSafeInteger(anchor) || anchor < 0) {
                throw new CompletionError('Для файла больше лимита строки укажите cursor или selection.');
            }
            let window;
            try { window = await readCompletionWindow(abs, { cursorLine: anchor, maxLineBytes, maxContextBytes }); }
            catch (error) { throw new CompletionError(`Не удалось прочитать ${request.path}: ${error.message}`, { status: 400, code: 'BAD_PATH' }); }
            content = window.text;
            startLine = window.startLine;
            omitLines = window.omittedLines;
            if (cursor) cursor = { line: window.cursorLine, character: cursor.character ?? cursor.column ?? 0 };
            if (selection) {
                selection = {
                    start: shiftPosition(selection.start, startLine),
                    end: shiftPosition(selection.end, startLine),
                };
            }
        } else {
            try { content = await readFile(abs, 'utf8'); }
            catch (error) { throw new CompletionError(`Не удалось прочитать ${request.path}: ${error.message}`, { status: 400, code: 'BAD_PATH' }); }
        }
    }

    return {
        ...request,
        content,
        cursor,
        selection,
        omitLines,
        startLine,
        maxLineBytes,
        maxContextBytes,
        neighborLines,
        model,
        effort,
        maxOutputTokens,
    };
}

/**
 * Responses API body for one completion. No tools, no stored reasoning transcript.
 * @param {{ model: string, effort: string, prompt: string, maxOutputTokens: number, config: object }} options
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function buildCompletionBody({ model, effort, prompt, maxOutputTokens, config }) {
    const body = {
        model,
        instructions: COMPLETION_INSTRUCTIONS,
        input: prompt,
        stream: false,
        store: false,
        max_output_tokens: maxOutputTokens,
        truncation: 'auto',
    };
    if (isReasoningModel(model)) body.reasoning = { effort };
    else if (config.temperature != null) body.temperature = config.temperature;
    if (supportsVerbosity(model)) body.text = { verbosity: 'low' };
    if (config.serviceTier) body.service_tier = config.serviceTier;
    if (config.promptCacheKey) body.prompt_cache_key = config.promptCacheKey;
    return body;
}

/**
 * Complete code at the cursor. The default model is gpt-5.3-codex-spark at effort low.
 * @param {{ client: object, config: object, request: object, cwd?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ text: string, model: string, omittedLines: number[], truncated: boolean, cursorLineOmitted: boolean, startLine: number }>}
 * @exports
 * @ai.hint io
 */
export async function completeCode({ client, config, request, cwd = process.cwd(), signal }) {
    const prepared = await prepareCompletionRequest(request, { cwd, config });
    const built = buildCompletionContext(prepared);
    const body = buildCompletionBody({
        model: prepared.model,
        effort: prepared.effort,
        prompt: built.prompt,
        maxOutputTokens: prepared.maxOutputTokens,
        config,
    });
    const response = await client.responses.create(body, { signal });
    return {
        text: stripCompletion(response.output_text ?? ''),
        model: response.model ?? prepared.model,
        omittedLines: built.omittedLines,
        truncated: built.truncated,
        cursorLineOmitted: built.cursorLineOmitted,
        startLine: built.startLine,
    };
}
