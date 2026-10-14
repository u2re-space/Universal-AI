import { ApiError } from './errors.js';

const BUILTIN_KINDS = {
  image_generation_call: 'image_generation',
  web_search_call: 'web_search',
  file_search_call: 'file_search',
  code_interpreter_call: 'code_interpreter',
  computer_call: 'computer',
  mcp_call: 'mcp',
  mcp_list_tools: 'mcp',
  local_shell_call: 'local_shell',
  custom_tool_call: 'custom_tool',
};

/**
 * Turns raw Responses API streaming events into a small, stable set of application events
 * and keeps track of the final response object. Also accumulates streamed text so that a
 * truncated stream still yields something useful.
 *
 * Application events (all have `type`):
 *   response.created {responseId, status, model}        response.status {status}
 *   text.delta {text, itemId}                             text.done {text, itemId}
 *   refusal.delta {text}                                  reasoning.delta {text}   reasoning.done {text}
 *   tool.call.start {itemId, name, callId}               tool.args.delta {itemId, bytes}
 *   tool.args.done {itemId, name, arguments}
 *   builtin.start {kind, itemId}  builtin.progress {kind, itemId, status}  builtin.done {kind, item}
 *   image.partial {itemId, index, b64, outputFormat}      item.done {item}
 *   stream.error {code, message}
 */
export function createStreamReducer({ emit = () => {} } = {}) {
  let response = null;
  let lastSequence = null;
  let streamError = null;
  const items = new Map();            // output_index -> item (as added)
  const textByItem = new Map();       // item_id -> accumulated text
  const argsByItem = new Map();       // item_id -> accumulated arguments

  const notify = (event) => { try { emit(event); } catch { /* observers never break a request */ } };
  const kindOf = (item) => BUILTIN_KINDS[item?.type] ?? null;

  function handle(event) {
    if (Number.isSafeInteger(event.sequence_number)) lastSequence = event.sequence_number;
    switch (event.type) {
      case 'response.created':
        response = event.response ?? response;
        notify({ type: 'response.created', responseId: response?.id ?? null, status: response?.status ?? 'in_progress',
          model: response?.model ?? null });
        break;
      case 'response.queued':
      case 'response.in_progress':
        response = event.response ?? response;
        notify({ type: 'response.status', status: event.type.slice('response.'.length), responseId: response?.id ?? null });
        break;
      case 'response.output_item.added': {
        const item = event.item ?? {};
        items.set(event.output_index, item);
        if (item.type === 'function_call') {
          notify({ type: 'tool.call.start', itemId: item.id ?? null, name: item.name ?? null, callId: item.call_id ?? null });
        } else if (item.type === 'reasoning') {
          notify({ type: 'reasoning.start', itemId: item.id ?? null });
        } else if (item.type === 'message') {
          notify({ type: 'message.start', itemId: item.id ?? null, role: item.role ?? 'assistant' });
        } else if (kindOf(item)) {
          notify({ type: 'builtin.start', kind: kindOf(item), itemId: item.id ?? null, item });
        }
        break;
      }
      case 'response.output_text.delta': {
        if (typeof event.delta !== 'string') throw new ApiError('Текстовая дельта не является строкой.', { code: 'INVALID_SSE' });
        const id = event.item_id ?? `#${event.output_index}`;
        textByItem.set(id, (textByItem.get(id) ?? '') + event.delta);
        notify({ type: 'text.delta', text: event.delta, itemId: id });
        break;
      }
      case 'response.output_text.done':
        notify({ type: 'text.done', text: event.text ?? textByItem.get(event.item_id) ?? '', itemId: event.item_id ?? null });
        break;
      case 'response.refusal.delta':
        notify({ type: 'refusal.delta', text: String(event.delta ?? '') });
        break;
      case 'response.refusal.done':
        notify({ type: 'refusal.done', text: String(event.refusal ?? '') });
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        notify({ type: 'reasoning.delta', text: String(event.delta ?? ''), itemId: event.item_id ?? null });
        break;
      case 'response.reasoning_summary_text.done':
      case 'response.reasoning_text.done':
        notify({ type: 'reasoning.done', text: String(event.text ?? ''), itemId: event.item_id ?? null });
        break;
      case 'response.function_call_arguments.delta': {
        const id = event.item_id ?? `#${event.output_index}`;
        const delta = String(event.delta ?? '');
        argsByItem.set(id, (argsByItem.get(id) ?? '') + delta);
        notify({ type: 'tool.args.delta', itemId: id, bytes: Buffer.byteLength(delta) });
        break;
      }
      case 'response.function_call_arguments.done': {
        const item = items.get(event.output_index);
        notify({ type: 'tool.args.done', itemId: event.item_id ?? null, name: event.name ?? item?.name ?? null,
          arguments: event.arguments ?? argsByItem.get(event.item_id) ?? '' });
        break;
      }
      case 'response.image_generation_call.partial_image':
        notify({ type: 'image.partial', itemId: event.item_id ?? null, index: event.partial_image_index ?? 0,
          b64: event.partial_image_b64 ?? '', outputFormat: event.output_format ?? null, size: event.size ?? null });
        break;
      case 'response.output_item.done': {
        const item = event.item ?? items.get(event.output_index) ?? {};
        items.set(event.output_index, item);
        if (kindOf(item)) notify({ type: 'builtin.done', kind: kindOf(item), itemId: item.id ?? null, item });
        notify({ type: 'item.done', item });
        break;
      }
      case 'response.completed':
      case 'response.failed':
      case 'response.incomplete':
        response = event.response ?? response;
        break;
      case 'error': {
        // Shape: { type:'error', error:{ type, code, message, param } } (nested) or flat { code, message }.
        const payload = event.error && typeof event.error === 'object' ? event.error : event;
        streamError = new ApiError(`Ошибка потока Responses API: ${payload.message ?? payload.code ?? 'unknown'}`, {
          code: 'STREAM_ERROR', apiCode: payload.code ?? null, apiType: payload.type ?? null, param: payload.param ?? null,
        });
        notify({ type: 'stream.error', code: payload.code ?? null, message: payload.message ?? 'stream error' });
        // Do not throw yet: the API normally follows with response.failed carrying the final state.
        break;
      }
      default: {
        // Progress events of built-in tools: response.<tool>_call.<status>
        const match = /^response\.([a-z_]+_call)(?:_[a-z_]+)?\.([a-z_]+)$/.exec(event.type);
        if (match && BUILTIN_KINDS[match[1]]) {
          notify({ type: 'builtin.progress', kind: BUILTIN_KINDS[match[1]], itemId: event.item_id ?? null,
            status: match[2], raw: event.type });
        } else if (event.type.startsWith('response.') && !/content_part|output_text\.annotation|reasoning_summary_part/.test(event.type)) {
          notify({ type: 'stream.other', raw: event.type });
        }
      }
    }
  }

  return {
    handle,
    get response() { return response; },
    get lastSequence() { return lastSequence; },
    get streamError() { return streamError; },
    get items() { return [...items.values()]; },
    /** Text accumulated so far (useful when the stream was cut before response.completed). */
    partialText() { return [...textByItem.values()].join(''); },
  };
}

/** Concatenate all assistant output_text parts of a response. */
export function outputText(response) {
  if (!Array.isArray(response?.output)) return '';
  const parts = [];
  for (const item of response.output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('');
}

/** Refusal text of a response, if any. */
export function refusalText(response) {
  if (!Array.isArray(response?.output)) return '';
  for (const item of response.output) {
    for (const part of item?.content ?? []) if (part?.type === 'refusal') return String(part.refusal ?? '');
  }
  return '';
}

/** Normalize usage from a response; returns null if the usage block is missing or malformed. */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const int = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  const input = int(usage.input_tokens);
  const output = int(usage.output_tokens);
  if (!Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens)) return null;
  return {
    input, output,
    cached: Math.min(input, int(usage.input_tokens_details?.cached_tokens)),
    reasoning: Math.min(output, int(usage.output_tokens_details?.reasoning_tokens)),
    total: int(usage.total_tokens) || input + output,
  };
}
