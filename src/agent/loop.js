import { ApiError, BudgetError, CancelledError, isAbortError } from '../openai/errors.js';
import { outputText, refusalText } from '../openai/stream.js';
import { isReasoningModel, supportsVerbosity } from '../core/config.js';
import { createImageSink } from '../core/images.js';
import { attachBackground, awaitBackground, TERMINAL_STATUSES } from '../core/background.js';
import { byteSize, estimateTokens, errorMessage, formatBytes } from '../util/text.js';

/** Built-in tool definitions derived from the configuration. */
export function builtinTools(config, { web = false, images = false } = {}) {
    const tools = [];
    if (web) tools.push({ type: 'web_search', search_context_size: config.webSearch.contextSize });
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
 * Returns { status, text, response, turns, toolCalls, images, refusal, error }.
 * status: completed | incomplete | refused | max_turns | budget | cancelled | failed
 */
export async function runTurn({
    client, config, session, ledger, toolset = null, builtin = [], toolChoice = null, instructions = null,
    model = config.model, textFormat = null, background = false, imageTarget = config.image.outputDir,
    maxTurns = config.limits.maxTurns, signal, emit = () => {},
}) {
    const notify = (event) => { try { emit(event); } catch { /* observers never break the loop */ } };
    const images = createImageSink({ target: imageTarget, format: config.image.format });
    const result = { status: 'failed', text: '', response: null, turns: 0, toolCalls: 0, images: [], refusal: '', error: null };
    const tools = [...(toolset ? toolset.definitions() : []), ...builtin];
    // function_call items recorded in the session that still need a function_call_output.
    // If the turn is interrupted we answer them synthetically so the history stays valid.
    let pendingCalls = [];
    const settlePending = (note) => {
        if (!pendingCalls.length) return;
        session.addItems(pendingCalls.map((call) => ({ type: 'function_call_output', call_id: call.call_id, output: note })));
        pendingCalls = [];
    };

    const onEvent = (event) => {
        if (event.type === 'image.partial' && event.b64) {
            images.savePartial(event.itemId, event.b64, event.outputFormat)
                .then((saved) => saved && notify({ type: 'image.progress', path: saved.file, index: event.index, bytes: saved.bytes }))
                .catch((error) => notify({ type: 'warning', message: `Не удалось сохранить промежуточное изображение: ${errorMessage(error)}` }));
            return;
        }
        notify(event);
    };

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
            const { input, previous_response_id: previousResponseId } = session.requestInput();
            const body = buildRequestBody({ config, model, instructions, input, previousResponseId, tools, toolChoice, textFormat, background });
            const requestBytes = byteSize(body);
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
            notify({ type: 'response.done', responseId: response.id ?? null, status: response.status, usage: entry.usage, costUsd: entry.costUsd,
                elapsedMs, ledger: ledger.snapshot(), model: response.model ?? model });

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
