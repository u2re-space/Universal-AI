/**
 * @file src/openai/chat.js
 * @module openai/chat
 * @purpose Translate Responses API requests and answers to and from /v1/chat/completions.
 * @depends openai/errors
 * @usedBy openai/client
 * @exports CHAT_PATH, toChatBody, fromChatCompletion, normalizeChatResult, responsesRouteUnsupported, createChatStreamReducer, stripRejectedFields, droppedTools
 * @ai.tags openai, chat, transport
 * @ai.hint pure
 * @changed 2026-11-04 droppedTools names the mcp and built-in tools a chat host cannot carry.
 * @changed 2026-11-04 chatGaps names reasoning.mode, which has no chat spelling.
 */
import { ApiError } from './errors.js';

/** Route of the Chat Completions transport, relative to the client base URL. */
export const CHAT_PATH = 'chat/completions';

/** Optional chat fields a strict gateway may reject by name; each one can be dropped and retried. */
const REJECTABLE = Object.freeze([
    'stream_options', 'reasoning_effort', 'max_completion_tokens', 'response_format',
    'parallel_tool_calls', 'service_tier', 'tool_choice', 'temperature', 'top_p',
]);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = (value) => (typeof value === 'string' ? value : '');
const intOf = (value) => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);

/** Roles /v1/chat/completions accepts; a Responses `developer` role is a chat `system` role. */
function chatRole(role) {
    if (role === 'developer') return 'system';
    return ['system', 'user', 'assistant', 'tool'].includes(role) ? role : 'user';
}

/**
 * Responses content parts as chat user content: a plain string when every part is text,
 * the `text` / `image_url` / `file` part array otherwise. Null when nothing survived.
 * @param {object[]} parts
 * @returns {string|object[]|null}
 * @ai.hint pure
 */
function userContent(parts) {
    const out = [];
    for (const part of parts) {
        switch (part?.type) {
            case 'input_text':
            case 'output_text':
            case 'text':
                if (textOf(part.text)) out.push({ type: 'text', text: part.text });
                break;
            case 'refusal':
                if (textOf(part.refusal)) out.push({ type: 'text', text: part.refusal });
                break;
            case 'input_image': {
                const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
                if (typeof url === 'string' && url) {
                    out.push({ type: 'image_url', image_url: { url, ...(part.detail ? { detail: part.detail } : {}) } });
                }
                break;
            }
            case 'input_file': {
                const file = isRecord(part.file) ? part.file : {};
                if (typeof file.file_data === 'string' && file.file_data) {
                    out.push({ type: 'file', file: { file_data: file.file_data, ...(file.filename ? { filename: file.filename } : {}) } });
                } else if (typeof file.file_id === 'string' && file.file_id) {
                    out.push({ type: 'file', file: { file_id: file.file_id } });
                } else if (typeof part.file === 'string' && part.file) {
                    out.push({ type: 'file', file: { file_id: part.file } });
                }
                break;
            }
            default:
                break;
        }
    }
    if (!out.length) return null;
    return out.every((part) => part.type === 'text') ? out.map((part) => part.text).join('') : out;
}

/**
 * Responses content parts as chat assistant content. Chat answers are plain strings, so text and
 * refusal parts are concatenated; anything else the model produced has no chat representation.
 * @param {object[]} parts
 * @returns {string|null}
 * @ai.hint pure
 */
function assistantContent(parts) {
    const chunks = [];
    for (const part of parts) {
        if (part?.type === 'refusal') chunks.push(textOf(part.refusal));
        else if (['input_text', 'output_text', 'text'].includes(part?.type)) chunks.push(textOf(part.text));
    }
    const joined = chunks.join('');
    return joined || null;
}

/** Text and images of a tool result: chat takes a string, so images travel as a follow-up message. */
function toolContent(output) {
    if (typeof output === 'string') return { text: output, images: [] };
    if (Array.isArray(output)) {
        const text = userContent(output);
        const images = (Array.isArray(text) ? text : []).filter((part) => part.type === 'image_url');
        const rest = (Array.isArray(text) ? text : []).filter((part) => part.type !== 'image_url').map((part) => part.text).join('\n');
        return { text: rest || '[результат инструмента содержал только изображения]', images };
    }
    if (output == null) return { text: '', images: [] };
    return { text: JSON.stringify(output), images: [] };
}

/**
 * Chat `tools` from Responses tool objects. Built-in tools (web_search, image_generation, mcp, …)
 * have no chat equivalent and are dropped: a gateway would reject the whole request for one
 * unknown tool type.
 * @param {object[]|undefined} tools
 * @returns {object[]}
 * @ai.hint pure
 */
function chatTools(tools) {
    const out = [];
    for (const tool of Array.isArray(tools) ? tools : []) {
        if (!isRecord(tool)) continue;
        if (tool.type && tool.type !== 'function') continue;
        const source = isRecord(tool.function) ? tool.function : tool;
        const name = textOf(source.name);
        if (!name) continue;
        out.push({
            type: 'function',
            function: {
                name,
                ...(textOf(source.description) ? { description: source.description } : {}),
                parameters: isRecord(source.parameters) ? source.parameters : { type: 'object', properties: {} },
            },
        });
    }
    return out;
}

/**
 * Labels of the tools the chat transport cannot carry — built-in Responses tools and `type: 'mcp'`
 * servers, which a gateway would reject as an unknown tool type. The client warns once with these.
 * @param {object[]|undefined} tools
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function droppedTools(tools) {
    const out = [];
    for (const tool of Array.isArray(tools) ? tools : []) {
        if (!isRecord(tool) || !tool.type || tool.type === 'function') continue;
        out.push(textOf(tool.server_label ?? tool.name ?? tool.function?.name) || tool.type);
    }
    return out;
}

/**
 * What this body needs and /v1/chat/completions cannot carry at all: a built-in Responses tool
 * (`web_search`, `image_generation`, …), background mode, and the gateway field `reasoning.mode`
 * (chat has only `reasoning_effort`, so a mode has no name to travel under). A `type: 'mcp'` server
 * is not a gap: the pipeline runs without it (Figma falls back to the attached pictures), it is often
 * added by the program rather than asked for by the user, and the host is still told about it. Server-side
 * conversation state has its own error in the client.
 * @param {object} body Responses API request body
 * @returns {string[]} names the chat transport cannot serve; empty when the request is portable
 * @exports
 * @ai.hint pure
 */
export function chatGaps(body = {}) {
    const tools = Array.isArray(body?.tools) ? body.tools : [];
    const builtins = tools.filter((tool) => isRecord(tool) && tool.type && tool.type !== 'function' && tool.type !== 'mcp');
    const gaps = droppedTools(builtins);
    if (body?.background === true) gaps.push('background');
    // `off` never reaches the body (modeFor drops it), so a body naming it is a real loss.
    const mode = textOf(body?.reasoning?.mode);
    if (mode && mode !== 'off') gaps.push('reasoning.mode');
    return gaps;
}

/**
 * `tool_choice` in chat shape. A named Responses function choice becomes the nested chat choice;
 * a shape chat cannot express falls back to `auto`, which never breaks the request.
 * @param {unknown} choice
 * @param {object[]} tools the chat tools that survived, used to check a named choice
 * @returns {string|object|null}
 * @ai.hint pure
 */
function chatToolChoice(choice, tools) {
    if (typeof choice === 'string') return ['auto', 'none', 'required'].includes(choice) ? choice : 'auto';
    if (!isRecord(choice)) return null;
    if (choice.type === 'function') {
        const name = textOf(choice.function?.name ?? choice.name);
        return name && tools.some((tool) => tool.function.name === name)
            ? { type: 'function', function: { name } } : 'auto';
    }
    if (choice.type === 'allowed_tools' || Array.isArray(choice)) return 'auto';
    return null;
}

/**
 * `text.format` as chat `response_format`. The Responses shape is flat
 * (`{ type:'json_schema', name, schema, strict }`), the chat shape nests it under `json_schema`.
 * @param {object|undefined} format
 * @returns {object|null}
 * @ai.hint pure
 */
function chatResponseFormat(format) {
    if (!isRecord(format) || !format.type) return null;
    if (format.type === 'text' || format.type === 'json_object') return { type: format.type };
    if (format.type !== 'json_schema') return null;
    const name = textOf(format.name) || 'response';
    const schema = isRecord(format.schema) ? format.schema : null;
    if (!schema) return { type: 'json_object' };
    return {
        type: 'json_schema',
        json_schema: { name, strict: format.strict !== false, schema },
    };
}

/**
 * Append one item to the chat message list. Consecutive `function_call` items merge into one
 * assistant message, because that is how the model produced them in a single answer.
 * @param {object[]} messages
 * @param {object} item
 * @returns {void}
 * @ai.hint pure
 */
function pushItem(messages, item) {
    if (!isRecord(item)) return;
    switch (item.type ?? 'message') {
        case 'message': {
            const role = chatRole(item.role);
            const parts = Array.isArray(item.content) ? item.content : [typeof item.content === 'string' ? { type: 'input_text', text: item.content } : item.content];
            if (role === 'assistant') {
                const content = assistantContent(parts);
                if (content) messages.push({ role: 'assistant', content });
            } else {
                const content = userContent(parts);
                if (content !== null) messages.push({ role, content });
            }
            return;
        }
        case 'function_call': {
            const call = {
                id: textOf(item.call_id) || `call_${messages.length}`,
                type: 'function',
                function: {
                    name: textOf(item.name),
                    arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
                },
            };
            const last = messages.at(-1);
            if (last?.role === 'assistant' && Array.isArray(last.tool_calls)) {
                last.tool_calls.push(call);
                return;
            }
            messages.push({ role: 'assistant', content: null, tool_calls: [call] });
            return;
        }
        case 'function_call_output': {
            const { text, images } = toolContent(item.output);
            messages.push({ role: 'tool', tool_call_id: textOf(item.call_id), content: text });
            if (images.length) {
                messages.push({ role: 'user', content: [{ type: 'text', text: '[изображение из результата инструмента]' }, ...images] });
            }
            return;
        }
        default:
            // reasoning, compaction, and built-in tool calls have no chat input shape.
            return;
    }
}

/**
 * Responses body → Chat Completions body. `instructions` becomes the leading system message,
 * `input` items become messages, and the options chat hosts understand are copied under chat names.
 * Fields with no chat meaning (store, background, previous_response_id, include, truncation,
 * prompt_cache_key, text.verbosity, reasoning.mode) are dropped.
 * @param {object} body Responses API request body
 * @param {{ includeUsage?: boolean, withReasoning?: boolean }} [options]
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function toChatBody(body = {}, { includeUsage = true, withReasoning = true } = {}) {
    const messages = [];
    const instructions = textOf(body.instructions).trim();
    if (instructions) messages.push({ role: 'system', content: instructions });
    if (typeof body.input === 'string') {
        if (body.input.trim()) messages.push({ role: 'user', content: body.input });
    } else if (Array.isArray(body.input)) {
        for (const item of body.input) pushItem(messages, item);
    }
    if (!messages.some((message) => message.role !== 'system')) {
        messages.push({ role: 'user', content: '' });
    }

    const chatBody = { model: body.model, messages };
    if (body.stream) {
        chatBody.stream = true;
        // Without this a streamed answer carries no usage, and the ledger would stay empty.
        if (includeUsage) chatBody.stream_options = { include_usage: true };
    }
    const tools = chatTools(body.tools);
    if (tools.length) {
        chatBody.tools = tools;
        if (body.parallel_tool_calls === true) chatBody.parallel_tool_calls = true;
        const choice = chatToolChoice(body.tool_choice, tools);
        if (choice) chatBody.tool_choice = choice;
    }
    if (Number.isSafeInteger(body.max_output_tokens) && body.max_output_tokens > 0) {
        chatBody.max_completion_tokens = body.max_output_tokens;
    }
    for (const key of ['temperature', 'top_p']) {
        if (typeof body[key] === 'number') chatBody[key] = body[key];
    }
    if (textOf(body.service_tier)) chatBody.service_tier = body.service_tier;
    const effort = textOf(body.reasoning?.effort);
    if (withReasoning && effort) chatBody.reasoning_effort = effort;
    // body.reasoning.mode is a Responses/gateway field with no chat spelling: chatGaps names it.
    const format = chatResponseFormat(body.text?.format);
    if (format) chatBody.response_format = format;
    return chatBody;
}

/**
 * Chat usage block in the Responses spelling the ledger and normalizeUsage read.
 * @param {object|null|undefined} usage
 * @returns {object|null}
 * @ai.hint pure
 */
function chatUsage(usage) {
    if (!isRecord(usage)) return null;
    const input = intOf(usage.prompt_tokens);
    const output = intOf(usage.completion_tokens);
    return {
        input_tokens: input,
        output_tokens: output,
        total_tokens: intOf(usage.total_tokens) || input + output,
        input_tokens_details: { cached_tokens: Math.min(input, intOf(usage.prompt_tokens_details?.cached_tokens)) },
        output_tokens_details: { reasoning_tokens: Math.min(output, intOf(usage.completion_tokens_details?.reasoning_tokens)) },
    };
}

/** `length` and `content_filter` are an incomplete answer; everything else completed. */
function statusOf(finishReason) {
    if (finishReason === 'length' || finishReason === 'content_filter') return 'incomplete';
    return 'completed';
}

/**
 * One chat completion in the Responses shape the agent loop reads: output items, output_text,
 * usage, and incomplete_details.
 * @param {object} data a `chat.completion` JSON body
 * @param {{ model?: string|null }} [options] model to report when the answer omits its own
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function fromChatCompletion(data, { model = null } = {}) {
    const source = isRecord(data) ? data : {};
    const choice = isRecord(source.choices?.[0]) ? source.choices[0] : {};
    const message = isRecord(choice.message) ? choice.message : {};
    const output = [];
    const text = typeof message.content === 'string'
        ? message.content
        : (Array.isArray(message.content) ? userContent(message.content.map((part) => (typeof part === 'string' ? { type: 'text', text: part } : part))) ?? '' : '');
    const refusal = typeof message.refusal === 'string' ? message.refusal : '';
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (text || refusal) {
        output.push({
            id: `msg_${source.id ?? 'chat'}`, type: 'message', role: 'assistant', status: 'completed',
            content: [text ? { type: 'output_text', text, annotations: [] } : { type: 'refusal', refusal }],
        });
    }
    for (const [index, call] of calls.entries()) {
        const callId = textOf(call.id) || `call_${source.id ?? 'chat'}_${index}`;
        output.push({
            id: `fc_${callId}`, type: 'function_call', status: 'completed', call_id: callId,
            name: textOf(call.function?.name), arguments: textOf(call.function?.arguments) || '{}',
        });
    }
    const reasoning = textOf(message.reasoning_content);
    if (reasoning) output.push({ id: `rs_${source.id ?? 'chat'}`, type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }] });
    const status = source.error ? 'failed' : statusOf(choice.finish_reason);
    return {
        id: source.id ?? null,
        object: 'response',
        created_at: Number.isFinite(source.created) ? source.created : Math.floor(Date.now() / 1000),
        status,
        model: textOf(source.model) || model,
        output,
        output_text: text,
        usage: chatUsage(source.usage),
        error: source.error ? { code: source.error.code ?? null, message: textOf(source.error.message) || 'chat completion failed' } : null,
        incomplete_details: status === 'incomplete'
            ? { reason: choice.finish_reason === 'length' ? 'max_output_tokens' : String(choice.finish_reason) } : null,
    };
}

/**
 * Whatever the chat route answered — a `chat.completion` body or an already translated streamed
 * response — in the Responses shape.
 * @param {object} result
 * @param {{ model?: string|null }} [options]
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function normalizeChatResult(result, { model = null } = {}) {
    if (isRecord(result) && (result.object === 'chat.completion' || Array.isArray(result.choices))) {
        return fromChatCompletion(result, { model });
    }
    return result;
}

/**
 * The host has no /v1/responses route, so the same request belongs on /v1/chat/completions.
 * A missing model is not a missing route: that answer means try another model, not another path.
 * @param {Error & { status?: number, apiCode?: string, param?: string }} error
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function responsesRouteUnsupported(error) {
    const details = `${textOf(error?.apiCode)} ${textOf(error?.code)} ${textOf(error?.message)}`;
    if (/model_not_found|model_not_available|invalid_model|unknown_model/i.test(details)) return false;
    if (error?.param === 'model') return false;
    if (/model.{0,40}(not found|does not exist|unavailable|unknown|недоступ|не найден)/i.test(details)) return false;
    if ([404, 405, 501].includes(error?.status)) return true;
    return error?.status === 400
        && /\/?responses\b/i.test(details)
        && /(not\s+(found|supported|available|implemented|enabled)|unsupported|unknown|unrecognized|missing|disabled|no\s+such|отсутств|не\s+поддерж)/i.test(details);
}

/**
 * A gateway refused one optional field of the request. Returns the body without those fields and
 * what was dropped, so the caller can repeat the call once and tell the user why.
 * @param {object} body the chat body that was refused
 * @param {Error & { status?: number, param?: string, message?: string }} error
 * @param {string[]} [configured] extra field names the caller added from its configuration
 * @returns {{ body: object, removed: string[] }}
 * @exports
 * @ai.hint pure
 */
export function stripRejectedFields(body, error, configured = []) {
    if (error?.status !== 400) return { body, removed: [] };
    const details = `${textOf(error?.param ? ` ${error.param}` : '')} ${textOf(error?.message)}`;
    const removed = [];
    const next = { ...body };
    const fields = [...new Set([...REJECTABLE, ...configured])];
    for (const field of fields) {
        if (!Object.hasOwn(next, field)) continue;
        if (!new RegExp(`\\b${field.replace(/_/g, '[_\\s-]?')}\\b`, 'i').test(details)) continue;
        delete next[field];
        removed.push(field);
    }
    // Older hosts spell the output cap `max_tokens`; keep the cap when the new name is refused.
    if (removed.includes('max_completion_tokens') && !Object.hasOwn(next, 'max_tokens')) {
        next.max_tokens = body.max_completion_tokens;
    }
    return { body: next, removed };
}

/**
 * Reducer over `chat.completion.chunk` events with the same face as createStreamReducer, so the
 * client stream loop, the renderer events, and the loop stay transport-agnostic.
 *
 * Emitted application events: response.created, message.start, text.delta, text.done,
 * refusal.delta, reasoning.delta, reasoning.done, tool.call.start, tool.args.delta,
 * tool.args.done, stream.error.
 *
 * @param {{ emit?: Function, model?: string|null }} [options]
 * @returns {{ handle: (event: object) => void, response: object|null, lastSequence: null,
 *   streamError: Error|null, items: object[], partialText: () => string }}
 * @exports
 * @ai.hint pure
 */
export function createChatStreamReducer({ emit = () => {}, model = null } = {}) {
    let id = null;
    let createdAt = null;
    let answerModel = model;
    let text = '';
    let refusal = '';
    let reasoning = '';
    let usage = null;
    let finishReason = null;
    let streamError = null;
    let messageStarted = false;
    let createdSent = false;
    const calls = new Map();          // chunk index -> { id, name, arguments }

    const notify = (event) => { try { emit(event); } catch { /* observers never break a request */ } };
    const itemId = () => `msg_${id ?? 'chat'}`;

    /**
     * The response built from what arrived so far; `in_progress` until a finish_reason landed.
     * @param {string} [status]
     * @returns {object}
     * @ai.hint pure
     */
    const build = (status = finishReason ? statusOf(finishReason) : 'in_progress') => {
        const output = [];
        if (text || refusal) {
            output.push({
                id: itemId(), type: 'message', role: 'assistant', status: 'completed',
                content: [text ? { type: 'output_text', text, annotations: [] } : { type: 'refusal', refusal }],
            });
        }
        for (const [index, call] of calls.entries()) {
            output.push({
                id: `fc_${call.id || index}`, type: 'function_call', status: 'completed',
                call_id: call.id || `call_${index}`, name: call.name, arguments: call.arguments || '{}',
            });
        }
        if (reasoning) output.push({ id: `rs_${id ?? 'chat'}`, type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }] });
        return {
            id, object: 'response', created_at: createdAt, status, model: answerModel, output, output_text: text,
            usage: chatUsage(usage),
            error: streamError && status !== 'completed'
                ? { code: streamError.apiCode ?? null, message: streamError.message } : null,
            incomplete_details: status === 'incomplete'
                ? { reason: finishReason === 'length' ? 'max_output_tokens' : String(finishReason) } : null,
        };
    };

    /**
     * Apply one raw chunk and emit the matching application event.
     * @param {object} event
     * @returns {void}
     * @ai.hint pure
     */
    function handle(event) {
        if (!isRecord(event) || event.type === '__done') return;
        if (event.error) {
            const payload = isRecord(event.error) ? event.error : { message: String(event.error) };
            streamError = new ApiError(`Ошибка потока /v1/chat/completions: ${textOf(payload.message) || textOf(payload.code) || 'unknown'}`, {
                code: 'STREAM_ERROR', apiCode: payload.code ?? null, apiType: payload.type ?? null, param: payload.param ?? null,
            });
            notify({ type: 'stream.error', code: payload.code ?? null, message: streamError.message });
            return;
        }
        if (textOf(event.id)) id = event.id;
        if (Number.isFinite(event.created)) createdAt = event.created;
        if (textOf(event.model)) answerModel = event.model;
        if (isRecord(event.usage)) usage = event.usage;
        const choice = isRecord(event.choices?.[0]) ? event.choices[0] : null;
        if (!choice && !isRecord(event.usage)) return;
        if (!createdSent) {
            createdSent = true;
            notify({ type: 'response.created', responseId: id, status: 'in_progress', model: answerModel });
        }
        const delta = isRecord(choice?.delta) ? choice.delta : {};
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            reasoning += delta.reasoning_content;
            notify({ type: 'reasoning.delta', text: delta.reasoning_content, itemId: `rs_${id ?? 'chat'}` });
        }
        if (typeof delta.refusal === 'string' && delta.refusal) {
            refusal += delta.refusal;
            notify({ type: 'refusal.delta', text: delta.refusal });
        }
        const piece = typeof delta.content === 'string' ? delta.content : '';
        if (piece) {
            if (!messageStarted) {
                messageStarted = true;
                notify({ type: 'message.start', itemId: itemId(), role: 'assistant' });
            }
            text += piece;
            notify({ type: 'text.delta', text: piece, itemId: itemId() });
        }
        for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
            const index = Number.isSafeInteger(call?.index) ? call.index : calls.size;
            const entry = calls.get(index) ?? { id: null, name: null, arguments: '' };
            calls.set(index, entry);
            if (textOf(call.function?.name)) {
                entry.name = call.function.name;
                notify({ type: 'tool.call.start', itemId: `fc_${call.id ?? index}`, name: entry.name, callId: call.id ?? null });
            }
            if (textOf(call.id)) entry.id = call.id;
            const args = textOf(call.function?.arguments);
            if (args) {
                entry.arguments += args;
                notify({ type: 'tool.args.delta', itemId: `fc_${entry.id ?? index}`, bytes: Buffer.byteLength(args) });
            }
        }
        if (textOf(choice?.finish_reason)) {
            finishReason = choice.finish_reason;
            if (messageStarted || text) notify({ type: 'text.done', text, itemId: itemId() });
            if (reasoning) notify({ type: 'reasoning.done', text: reasoning, itemId: `rs_${id ?? 'chat'}` });
            for (const [index, call] of calls.entries()) {
                notify({ type: 'tool.args.done', itemId: `fc_${call.id ?? index}`, name: call.name, arguments: call.arguments || '{}' });
            }
        }
    }

    return {
        handle,
        get response() { return id || text || calls.size ? build() : null; },
        get lastSequence() { return null; },
        get streamError() { return streamError; },
        get items() { return build().output; },
        partialText() { return text; },
    };
}
