/**
 * @file src/agent/loop.js
 * @module agent/loop
 * @purpose Send one conversation turn, run requested local tools, and record images and usage.
 * @depends openai/errors, openai/stream, openai/web-search, core/config, core/images, core/background, util/text
 * @usedBy commands/chat, commands/flow, commands/image, agent/roles, agent/team, index.js
 * @exports builtinTools, buildRequestBody, compactSession, shrinkHistory, runTurn
 * @ai.tags loop, tools
 * @ai.hint hot
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */

import { ApiError, BudgetError, CancelledError, isAbortError } from '../openai/errors.js';
import { outputText, refusalText } from '../openai/stream.js';
import { collectWebSources, webSearchTool } from '../openai/web-search.js';
import { isReasoningModel, supportsVerbosity } from '../core/config.js';
import { createImageSink } from '../core/images.js';
import { attachBackground, awaitBackground, TERMINAL_STATUSES } from '../core/background.js';
import { byteSize, clipMiddle, estimateTokens, errorMessage, formatBytes } from '../util/text.js';
import { guardCommandInput } from './command-risk.js';

/** Built-in tool definitions derived from the configuration. */
export function builtinTools(config, { web = false, images = false } = {}) {
    const tools = [];
    if (web) tools.push(webSearchTool(config.webSearch?.contextSize));
    if (images) {
        const image = { type: 'image_generation', output_format: config.image.format, partial_images: config.image.partialImages };
        if (config.imageModel) image.model = config.imageModel;
        if (config.image.size !== 'auto') image.size = config.image.size;
        if (config.image.quality !== 'auto') image.quality = config.image.quality;
        if (config.image.background !== 'auto') image.background = config.image.background;
        tools.push(image);
    }
    return tools;
}

/** Compose the Responses API request body from the configuration and conversation state. */
export function buildRequestBody({
    config, model = config.model, instructions = null, input, previousResponseId = null, tools = [], toolChoice = null,
    stream = config.stream, background = false, textFormat = null, maxOutputTokens = config.maxOutputTokens, store = config.store,
    reasoningEffort = config.reasoning.effort, reasoningSummary = config.reasoning.summary,
}) {
    const body = { model, input, stream: Boolean(stream), store: background ? true : Boolean(store) };
    if (instructions) body.instructions = instructions;
    if (previousResponseId) body.previous_response_id = previousResponseId;
    if (background) body.background = true;
    if (tools.length) {
        body.tools = tools;
        body.parallel_tool_calls = true;
        if (toolChoice) body.tool_choice = toolChoice;
    }
    const include = [];
    if (isReasoningModel(model)) {
        const reasoning = {};
        if (reasoningEffort) reasoning.effort = reasoningEffort;
        if (reasoningSummary && reasoningSummary !== 'none') reasoning.summary = reasoningSummary;
        if (Object.keys(reasoning).length) body.reasoning = reasoning;
        if (!body.store) include.push('reasoning.encrypted_content');
    } else if (config.temperature !== null && config.temperature !== undefined) {
        body.temperature = config.temperature;
    }
    const text = {};
    if (textFormat) text.format = textFormat;
    if (config.verbosity && supportsVerbosity(model)) text.verbosity = config.verbosity;
    if (Object.keys(text).length) body.text = text;
    if (config.truncation) body.truncation = config.truncation;
    if (maxOutputTokens) body.max_output_tokens = maxOutputTokens;
    if (config.serviceTier) body.service_tier = config.serviceTier;
    if (config.promptCacheKey) body.prompt_cache_key = config.promptCacheKey;
    if (include.length) body.include = include;
    return body;
}

const OUTPUT_KEEP_BYTES = 16 * 1024;

/**
 * Drop older screenshots and clip old tool output so the next request can fit maxRequestBytes.
 * The newest tool result is kept intact on the first pass.
 * @param {object[]} items
 * @param {{ clipNewest?: boolean }} [options]
 * @returns {{ items: object[], changed: boolean }}
 * @exports
 * @ai.hint pure
 */
export function shrinkHistory(items, { clipNewest = false } = {}) {
    const outputs = [];
    items.forEach((item, index) => { if (item?.type === 'function_call_output') outputs.push(index); });
    const newest = outputs.at(-1);
    let changed = false;
    const next = items.map((item, index) => {
        if (item?.type !== 'function_call_output') return item;
        const keep = index === newest && !clipNewest;
        if (Array.isArray(item.output)) {
            if (keep || !item.output.some((part) => part?.type === 'input_image')) return item;
            changed = true;
            const text = item.output.filter((part) => part?.type === 'input_text').map((part) => part.text).join('\n');
            return { ...item, output: text || '[изображение убрано из истории]' };
        }
        if (!keep && typeof item.output === 'string' && Buffer.byteLength(item.output) > OUTPUT_KEEP_BYTES) {
            changed = true;
            return { ...item, output: clipMiddle(item.output, OUTPUT_KEEP_BYTES) };
        }
        return item;
    });
    return { items: next, changed };
}

/** Server-side compaction of a stateless history (POST /responses/compact). */
export async function compactSession({ client, session, model, instructions = null, signal }) {
    const { input } = session.requestInput();
    const body = { model, input };
    if (instructions) body.instructions = instructions;
    const result = await client.responses.compact(body, { signal });
    if (!Array.isArray(result?.output)) throw new ApiError('Компактизация: сервер вернул неожиданный ответ.', { code: 'INVALID_RESPONSE' });
    const before = session.size;
    session.replace(result.output);
    return { before, after: session.size, usage: result.usage ?? null };
}

/**
 * Execute one user turn: send the conversation, run requested local tools, repeat until the
 * model answers without tool calls (or a limit is reached). Works for plain prompts too
 * (toolset = null): then it is a single request plus image/usage bookkeeping.
 *
 * Returns { status, text, response, turns, toolCalls, images, sources, refusal, error }.
 * status: completed | incomplete | refused | max_turns | budget | cancelled | failed
 */
export async function runTurn({
    client, config, session, ledger, toolset = null, builtin = [], toolChoice = null, instructions = null,
    model = config.model, textFormat = null, background = false, imageTarget = config.image.outputDir,
    maxTurns = config.limits.maxTurns, signal, emit = () => {},
}) {
    const notify = (event) => { try { emit(event); } catch { /* observers never break the loop */ } };
    const images = createImageSink({ target: imageTarget, format: config.image.format });
    const result = { status: 'failed', text: '', response: null, turns: 0, toolCalls: 0, images: [], sources: [], refusal: '', error: null };
    const tools = [...(toolset ? toolset.definitions() : []), ...builtin];
    // function_call items recorded in the session that still need a function_call_output.
    // If the turn is interrupted we answer them synthetically so the history stays valid.
    let pendingCalls = [];
    /** Write synthetic tool results so an interrupted turn still has a valid history. */
    const settlePending = (note) => {
        if (!pendingCalls.length) return;
        session.addItems(pendingCalls.map((call) => ({ type: 'function_call_output', call_id: call.call_id, output: note })));
        pendingCalls = [];
    };

    /** Save a partial image when the stream sends one, then forward the event. */
    const onEvent = (event) => {
        if (event.type === 'image.partial' && event.b64) {
            images.savePartial(event.itemId, event.b64, event.outputFormat)
                .then((saved) => saved && notify({ type: 'image.progress', path: saved.file, index: event.index, bytes: saved.bytes }))
                .catch((error) => notify({ type: 'warning', message: `Не удалось сохранить промежуточное изображение: ${errorMessage(error)}` }));
            return;
        }
        notify(event);
    };

    /** Create a response; in background mode, reattach a dropped stream or poll. */
    async function request(body) {
        if (!background) return client.responses.create(body, { signal, onEvent });
        // Background mode: keep the stream attached when possible, fall back to polling otherwise.
        if (body.stream) {
            try {
                return await client.responses.create(body, { signal, onEvent });
            } catch (error) {
                const transient = error instanceof ApiError && error.responseId &&
                    ['STREAM_TRUNCATED', 'NETWORK_ERROR', 'TIMEOUT'].includes(error.code);
                if (!transient || signal?.aborted) throw error;
                notify({ type: 'warning', message: `Поток прерван, переподключение к ответу ${error.responseId}…` });
                return attachBackground({ client, id: error.responseId, signal, onEvent, startingAfter: error.details?.lastSequence ?? null,
                    include: body.include });
            }
        }
        const created = await client.responses.create(body, { signal, onEvent });
        notify({ type: 'response.created', responseId: created.id, status: created.status, model: created.model ?? body.model });
        if (TERMINAL_STATUSES.has(created.status)) return created;
        return awaitBackground({ client, id: created.id, signal, emit: notify, pollIntervalMs: config.limits.pollIntervalMs, include: body.include });
    }

    try {
        for (;;) {
            signal?.throwIfAborted();
            result.turns++;
            session.bumpTurn();
            let { input, previous_response_id: previousResponseId } = session.requestInput();
            const guarded = guardCommandInput(input);
            if (guarded.changed) notify({ type: 'warning', message: `Запрос со скриптом или командой переформулирован перед отправкой: ${guarded.reasons.join('; ')}.` });
            let body = buildRequestBody({ config, model, instructions, input, previousResponseId, tools, toolChoice, textFormat, background });
            let requestBytes = byteSize(body);
            if (requestBytes > config.limits.maxRequestBytes && !session.store) {
                const before = requestBytes;
                const apply = (clipNewest) => {
                    const shrunk = shrinkHistory(session.toJSON().items, { clipNewest });
                    if (!shrunk.changed) return false;
                    session.replace(shrunk.items);
                    ({ input, previous_response_id: previousResponseId } = session.requestInput());
                    body = buildRequestBody({ config, model, instructions, input, previousResponseId, tools, toolChoice, textFormat, background });
                    requestBytes = byteSize(body);
                    return true;
                };
                apply(false);
                if (requestBytes > config.limits.maxRequestBytes) apply(true);
                if (requestBytes < before) notify({ type: 'warning', message: `История сокращена: запрос был ${formatBytes(before)}.` });
            }
            if (requestBytes > config.limits.maxRequestBytes) {
                throw new ApiError(`Запрос (${formatBytes(requestBytes)}) превышает limits.maxRequestBytes; сократите контекст (/compact, /clear) или вложения.`, { code: 'REQUEST_LIMIT' });
            }
            ledger.assertBudget({ estimatedTokens: estimateTokens(input), model });
            notify({ type: 'turn.start', turn: result.turns, maxTurns, requestBytes, tools: tools.length });
            const startedAt = Date.now();
            const response = await request(body);
            const elapsedMs = Date.now() - startedAt;
            const entry = ledger.record({ model: response.model ?? model, usage: response.usage, elapsedMs, responseId: response.id ?? null });
            session.recordUsage(entry);
            result.response = response;
            const web = collectWebSources(response);
            for (const source of web.sources) {
                if (!result.sources.some((item) => item.url === source.url)) result.sources.push(source);
            }
            if (web.queries.length || web.sources.length) {
                notify({ type: 'web.sources', queries: web.queries, sources: web.sources, searches: web.searches });
            }
            notify({ type: 'response.done', responseId: response.id ?? null, status: response.status, usage: entry.usage, costUsd: entry.costUsd,
                elapsedMs, ledger: ledger.snapshot(), model: response.model ?? model, searches: web.searches });

            // Persist generated images and remember their paths for the replayable history.
            const imagePaths = new Map();
            for (const item of response.output ?? []) {
                if (item?.type !== 'image_generation_call') continue;
                if (item.status === 'failed' || item.error) {
                    notify({ type: 'warning', message: `Генерация изображения не удалась: ${item.error?.message ?? item.status}` });
                    continue;
                }
                if (!item.result) continue;
                try {
                    const saved = await images.saveFinal(item.id, item.result, item.output_format);
                    if (saved) {
                        imagePaths.set(item.id, saved.file);
                        result.images.push(saved.file);
                        ledger.addImages(1);
                        notify({ type: 'image.saved', path: saved.file, bytes: saved.bytes, revisedPrompt: item.revised_prompt ?? null });
                    }
                } catch (error) {
                    notify({ type: 'warning', message: `Не удалось сохранить изображение: ${errorMessage(error)}` });
                }
            }
            session.recordResponse(response, { imagePaths });
            result.text += outputText(response);
            result.refusal = refusalText(response);
            const calls = (response.output ?? []).filter((item) => item?.type === 'function_call' && item.call_id);
            pendingCalls = calls;

            if (response.status === 'failed') {
                throw new ApiError(`Ответ завершился ошибкой: ${response.error?.message ?? 'unknown'}`, {
                    code: 'RESPONSE_FAILED', apiCode: response.error?.code ?? null, responseId: response.id ?? null, response,
                });
            }
            if (response.status === 'cancelled') { settlePending('Инструмент не выполнен: ответ отменён.'); result.status = 'cancelled'; return result; }
            if (response.status === 'incomplete') {
                notify({ type: 'warning', message: `Ответ неполный: ${response.incomplete_details?.reason ?? 'причина неизвестна'}` });
                settlePending('Инструмент не выполнен: ответ модели оказался неполным.');
                result.status = 'incomplete';
                return result;
            }
            if (result.refusal) { settlePending('Инструмент не выполнен: модель отказалась продолжать.'); result.status = 'refused'; return result; }

            if (!calls.length) { result.status = 'completed'; break; }
            if (!toolset) {
                notify({ type: 'warning', message: 'Модель запросила вызов функции, но локальные инструменты отключены.' });
                settlePending('Локальные инструменты отключены в этом режиме; ответьте без них.');
                result.status = 'completed';
                break;
            }
            if (calls.length > config.limits.maxToolCallsPerTurn) {
                throw new ApiError(`Модель запросила ${calls.length} вызовов инструментов за ход (лимит ${config.limits.maxToolCallsPerTurn}).`, { code: 'TOOL_LIMIT' });
            }
            const outputs = [];
            for (const call of calls) {
                signal?.throwIfAborted();
                result.toolCalls++;
                let args = null;
                try { args = JSON.parse(call.arguments ?? '{}'); } catch { args = null; }
                notify({ type: 'tool.exec.start', name: call.name, callId: call.call_id, args });
                const outcome = await toolset.execute(call);
                notify({ type: 'tool.exec.done', name: call.name, callId: call.call_id, ok: outcome.ok !== false, summary: outcome.summary ?? '',
                    durationMs: outcome.durationMs ?? 0, category: outcome.category ?? null,
                    outputBytes: typeof outcome.output === 'string' ? Buffer.byteLength(outcome.output) : null });
                outputs.push({ type: 'function_call_output', call_id: call.call_id, output: outcome.output });
            }
            pendingCalls = [];
            session.addItems(outputs);
            if (result.turns >= maxTurns) {
                notify({ type: 'warning', message: `Достигнут лимит ходов (${maxTurns}); остановка.` });
                result.status = 'max_turns';
                return result;
            }
            if (config.compaction.auto && !session.store && entry.usage && entry.usage.input > config.compaction.afterInputTokens) {
                try {
                    notify({ type: 'compaction.start', inputTokens: entry.usage.input });
                    const compacted = await compactSession({ client, session, model, instructions, signal });
                    notify({ type: 'compaction.done', ...compacted });
                } catch (error) {
                    notify({ type: 'warning', message: `Компактизация не удалась: ${errorMessage(error)}` });
                }
            }
        }
        return result;
    } catch (error) {
        settlePending('Инструмент не выполнен: ход был прерван.');
        if (error instanceof BudgetError) { result.status = 'budget'; result.error = error; notify({ type: 'budget.exceeded', message: error.message }); return result; }
        if (isAbortError(error) || signal?.aborted || error instanceof CancelledError) { result.status = 'cancelled'; result.error = error; return result; }
        result.status = 'failed';
        result.error = error;
        if (error instanceof ApiError && error.details?.partialText) result.text += error.details.partialText;
        return result;
    }
}
