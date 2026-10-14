import Ajv from 'ajv';
import { randomUUID } from 'node:crypto';

/**
 * Node.js 26+, ESM. Responses API over native fetch; no OpenAI SDK.
 * Dependencies: ajv (local validation of the completed structured output).
 * No retries, tools, prompt logging, or budget enforcement in this transport.
 * Dollar reservation and accounting belong to the calling orchestrator.
 */
const MiB = 1024 * 1024;
const defaults = Object.freeze({
  baseURL: 'https://api.openai.com/v1/',
  timeoutMs: 180_000,
  maxRequestBytes: 512 * 1024,
  maxResponseBytes: 16 * MiB,
  maxEventBytes: 8 * MiB,
  maxOutputBytes: 2 * MiB,
  maxEvents: 100_000,
  maxErrorBytes: 64 * 1024,
});
const byteLength = (text) => Buffer.byteLength(text, 'utf8');
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class ModelRequestError extends Error {
  constructor(message, { code = 'MODEL_ERROR', cause, ...details } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ModelRequestError';
    this.code = code;
    Object.assign(this, details);
  }

  // Deliberately omit response, cause, prompts, and output from log serialization.
  toJSON() {
    return {
      name: this.name, code: this.code, message: this.message,
      status: this.status ?? null,
      requestId: this.requestId ?? null,
      clientRequestId: this.clientRequestId ?? null,
      responseId: this.responseId ?? null,
      retryAfter: this.retryAfter ?? null,
      usage: this.usage ?? null,
      unknownUsagePossible: this.unknownUsagePossible ?? false,
      schemaErrors: this.schemaErrors ?? null,
    };
  }
}

function fail(code, message, details) {
  throw new ModelRequestError(message, { code, ...details });
}

function getUsage(response) {
  const u = response?.usage;
  if (!isRecord(u) || !Number.isSafeInteger(u.input_tokens) || u.input_tokens < 0 ||
      !Number.isSafeInteger(u.output_tokens) || u.output_tokens < 0) return null;
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  if (!Number.isSafeInteger(cached) || cached < 0 || cached > u.input_tokens) return null;
  return u;
}

export function getOutputText(response, maxBytes = defaults.maxOutputBytes) {
  if (!positiveInteger(maxBytes)) throw new TypeError('maxBytes must be a positive integer');
  if (!Array.isArray(response?.output)) fail('INVALID_RESPONSE', 'Response has no output array');
  const parts = [];
  let total = 0;
  for (const item of response.output) {
    if (item?.type !== 'message') continue;
    if (!Array.isArray(item.content)) fail('INVALID_RESPONSE', 'Message has no content array');
    for (const content of item.content) {
      if (content?.type === 'refusal') {
        // Do not expose untrusted refusal text as terminal output by default.
        fail('MODEL_REFUSAL', 'The model refused this request');
      }
      if (content?.type !== 'output_text') continue;
      if (typeof content.text !== 'string') fail('INVALID_RESPONSE', 'output_text is not a string');
      total += byteLength(content.text);
      if (total > maxBytes) fail('OUTPUT_LIMIT', 'Completed output exceeds maxOutputBytes');
      parts.push(content.text);
    }
  }
  if (!parts.length) fail('EMPTY_OUTPUT', 'The model returned no output_text');
  return parts.join('');
}

function buildValidator(schema) {
  if (!isRecord(schema)) throw new TypeError('schema must be a JSON Schema object');
  // A fresh compiler avoids stale cached validators after mutable schema changes.
  // Unknown formats/keywords fail rather than silently disabling validation.
  const ajv = new Ajv({ allErrors: true, strict: true });
  return ajv.compile(schema);
}

function parseAndValidate(response, validate, maxOutputBytes) {
  if (!isRecord(response) || response.status !== 'completed') {
    fail(response?.status === 'incomplete' ? 'RESPONSE_INCOMPLETE' : 'RESPONSE_FAILED',
      'The model did not return a completed response');
  }
  if (response.error) fail('RESPONSE_FAILED', 'The response contains an API error');
  const text = getOutputText(response, maxOutputBytes);
  let data;
  try { data = JSON.parse(text); }
  catch (cause) { fail('INVALID_OUTPUT_JSON', 'Completed output is not valid JSON', { cause }); }
  if (!validate(data)) {
    fail('SCHEMA_VALIDATION', 'Completed JSON does not match the requested schema', {
      schemaErrors: (validate.errors ?? []).slice(0, 20).map((e) => ({
        instancePath: e.instancePath, schemaPath: e.schemaPath,
        keyword: e.keyword, message: e.message,
      })),
    });
  }
  return { text, data };
}

/** Explicit helper for callers that want the parsed object, not the API response. */
export function parseStructuredResponse(response, schema, { maxOutputBytes = defaults.maxOutputBytes } = {}) {
  if (!positiveInteger(maxOutputBytes)) throw new TypeError('maxOutputBytes must be a positive integer');
  try { return parseAndValidate(response, buildValidator(schema), maxOutputBytes).data; }
  catch (error) {
    if (error instanceof ModelRequestError) {
      error.response = response;
      error.responseId = response?.id ?? null;
      error.usage = getUsage(response);
      error.unknownUsagePossible = error.usage === null;
    }
    throw error;
  }
}

async function cancelBody(body) {
  try { await body?.cancel(); } catch { /* Already locked, closed, or aborted. */ }
}

async function readText(body, cap, { truncate = false } = {}) {
  if (!body) fail('INVALID_RESPONSE', 'HTTP response has no body');
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  let finished = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { finished = true; break; }
      const room = cap - total;
      if (value.byteLength > room) {
        if (!truncate) fail('RESPONSE_LIMIT', 'HTTP body exceeds its byte limit');
        if (room > 0) chunks.push(Buffer.from(value.subarray(0, room)));
        total = cap;
        break;
      }
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: !truncate }).decode(Buffer.concat(chunks, total));
  } finally {
    if (!finished) { try { await reader.cancel(); } catch {} }
    reader.releaseLock();
  }
}

/**
 * Bounded SSE parser: handles split UTF-8 characters, CR/LF/CRLF, comments,
 * multiple data lines, and a terminal event without a final blank line.
 * Unknown non-data SSE fields are ignored as required by the SSE protocol.
 */
async function* readEvents(body, limits) {
  if (!body) fail('INVALID_RESPONSE', 'SSE response has no body');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let wireBytes = 0;
  let events = 0;
  let eventBytes = 0;
  let line = '';
  let lineBytes = 0;
  let skipLF = false;
  let dataLines = [];
  let eventName = '';
  let finished = false;

  function append(fragment) {
    lineBytes += byteLength(fragment);
    if (lineBytes + eventBytes > limits.maxEventBytes) {
      fail('EVENT_LIMIT', 'SSE event exceeds maxEventBytes');
    }
    line += fragment;
  }
  function dispatch() {
    const data = dataLines.length ? dataLines.join('\n') : null;
    const name = eventName;
    dataLines = [];
    eventName = '';
    eventBytes = 0;
    if (data === null) return null;
    if (++events > limits.maxEvents) fail('EVENT_COUNT_LIMIT', 'Too many SSE events');
    if (data.trim() === '[DONE]') return { type: '__done' };
    let event;
    try { event = JSON.parse(data); }
    catch (cause) { fail('INVALID_SSE_JSON', 'SSE data is not valid JSON', { cause }); }
    if (!isRecord(event) || typeof event.type !== 'string' || !event.type) {
      fail('INVALID_SSE_EVENT', 'SSE data has no event type');
    }
    if (name && name !== 'message' && name !== event.type) {
      fail('INVALID_SSE_EVENT', 'SSE event name disagrees with its JSON type');
    }
    return event;
  }
  function endLine() {
    const current = line;
    eventBytes += lineBytes + 1;
    line = '';
    lineBytes = 0;
    if (eventBytes > limits.maxEventBytes) fail('EVENT_LIMIT', 'SSE event exceeds maxEventBytes');
    if (current === '') return dispatch();
    if (current.startsWith(':')) return null;
    const colon = current.indexOf(':');
    const field = colon < 0 ? current : current.slice(0, colon);
    let value = colon < 0 ? '' : current.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    if (field === 'event') eventName = value;
    return null;
  }
  function* consume(text) {
    let start = 0;
    if (skipLF && text.length) {
      if (text[0] === '\n') start = 1;
      skipLF = false;
    }
    const separators = /[\r\n]/g;
    separators.lastIndex = start;
    let match;
    while ((match = separators.exec(text))) {
      const index = match.index;
      append(text.slice(start, index));
      const event = endLine();
      if (event) yield event;
      start = index + 1;
      if (text[index] === '\r') {
        if (text[start] === '\n') { start++; separators.lastIndex = start; }
        else if (start === text.length) skipLF = true;
      }
    }
    append(text.slice(start));
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { finished = true; break; }
      wireBytes += value.byteLength;
      if (wireBytes > limits.maxResponseBytes) fail('RESPONSE_LIMIT', 'SSE body exceeds maxResponseBytes');
      yield* consume(decoder.decode(value, { stream: true }));
    }
    yield* consume(decoder.decode());
    if (line.length) { const event = endLine(); if (event) yield event; }
    const last = dispatch();
    if (last) yield last;
  } finally {
    if (!finished) { try { await reader.cancel(); } catch {} }
    reader.releaseLock();
  }
}

function endpointFor(baseURL) {
  const url = new URL(baseURL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new TypeError('baseURL must be HTTPS with no credentials, query, or fragment');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return new URL('responses', url).href;
}

function notify(emit, event) {
  // Observers are notifications, not action hooks; returned promises are not awaited.
  // Prefer synchronous handlers. Sink errors must not interrupt a billable request.
  try {
    const pending = emit?.(event);
    if (pending && typeof pending.then === 'function') {
      Promise.resolve(pending).catch(() => {});
    }
  } catch { /* Observer errors are intentionally ignored. */ }
}

/**
 * baseURL/apiKey/fetchImpl are TRUSTED local configuration, never model output.
 * baseURL is an API root (e.g. https://api.openai.com/v1/), not /responses.
 * Custom endpoints receive the credential: configure them only when trusted.
 */
export function createNativeModelClient(options = {}) {
  const limits = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    if (key === 'baseURL') continue;
    limits[key] = options[key] ?? fallback;
    if (!positiveInteger(limits[key])) throw new TypeError(`${key} must be a positive integer`);
  }
  const endpoint = endpointFor(options.baseURL ?? defaults.baseURL);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is not available');

  async function requestStructured({
    model, instructions, payload, schema, maxOutputTokens,
    signal, emit = options.emit, schemaName = 'agent_result',
    timeoutMs = limits.timeoutMs, stream = true,
  } = {}) {
    // All preparation/validation happens before dispatch, and therefore before API cost.
    if (typeof model !== 'string' || !model.trim()) throw new TypeError('model is required');
    if (typeof instructions !== 'string') throw new TypeError('instructions must be a string');
    if (!positiveInteger(maxOutputTokens)) throw new TypeError('maxOutputTokens must be a positive integer');
    if (!positiveInteger(timeoutMs) || timeoutMs > 2_147_483_647) throw new TypeError('Invalid timeoutMs');
    if (typeof stream !== 'boolean') throw new TypeError('stream must be boolean');
    if (emit != null && typeof emit !== 'function') throw new TypeError('emit must be a function');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(schemaName)) throw new TypeError('Invalid schemaName');
    if (signal != null && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
    signal?.throwIfAborted();
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) {
      throw new TypeError('OPENAI_API_KEY/apiKey is not configured correctly');
    }
    const input = JSON.stringify(payload);
    if (input === undefined) throw new TypeError('payload must be JSON serializable');
    // Freeze the effective schema by serialization, not by mutating the caller's object.
    const effectiveSchema = JSON.parse(JSON.stringify(schema));
    const validate = buildValidator(effectiveSchema);
    const body = JSON.stringify({
      model, instructions, input, store: false,
      max_output_tokens: maxOutputTokens,
      text: { format: { type: 'json_schema', name: schemaName, strict: true, schema: effectiveSchema } },
      stream,
    });
    const requestBytes = byteLength(body);
    if (requestBytes > limits.maxRequestBytes) fail('REQUEST_LIMIT', 'Request exceeds maxRequestBytes');

    const controller = new AbortController();
    const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('Responses API deadline exceeded'));
    }, timeoutMs);
    const clientRequestId = randomUUID();
    let requestId = null;
    let status = null;
    let dispatched = false;
    let http;
    let response;
    let usage = null;
    let responseId = null;
    let outputBytes = 0;
    let observerEvents = 0;

    function capture(value) {
      if (!isRecord(value)) fail('INVALID_RESPONSE', 'Terminal response is not an object');
      response = value;
      usage = getUsage(value);
      responseId = value.id ?? null;
      notify(emit, {
        type: 'model.usage', requestId, clientRequestId, responseId,
        usage, unknownUsagePossible: usage === null,
      });
    }
    try {
      notify(emit, { type: 'model.request.started', model, clientRequestId, requestBytes, stream });
      combinedSignal.throwIfAborted();
      dispatched = true;
      http = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', signal: combinedSignal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: stream ? 'text/event-stream' : 'application/json',
          'X-Client-Request-Id': clientRequestId,
        },
        body,
      });
      status = http.status;
      requestId = http.headers.get('x-request-id');
      notify(emit, { type: 'model.request.headers', status, requestId, clientRequestId });
      if (!http.ok) {
        // Bounded diagnostic body; no raw body is printed or emitted.
        const text = await readText(http.body, limits.maxErrorBytes, { truncate: true });
        let apiCode = null;
        try {
          const code = JSON.parse(text)?.error?.code;
          if (typeof code === 'string') apiCode = code.slice(0, 100);
        } catch {}
        fail('HTTP_ERROR', `Responses API returned HTTP ${status}`, {
          status, apiCode, retryAfter: http.headers.get('retry-after'),
        });
      }
      const mime = (http.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
      if (mime === 'text/event-stream') {
        for await (const event of readEvents(http.body, limits)) {
          if (++observerEvents > limits.maxEvents) fail('EVENT_COUNT_LIMIT', 'Too many response events');
          if (event.type === 'response.created' || event.type === 'response.in_progress') {
            responseId = event.response?.id ?? responseId;
            notify(emit, { type: 'model.status', status: event.type, requestId, clientRequestId, responseId });
          } else if (event.type === 'response.output_text.delta') {
            if (typeof event.delta !== 'string') fail('INVALID_SSE_EVENT', 'Text delta is not a string');
            outputBytes += byteLength(event.delta);
            if (outputBytes > limits.maxOutputBytes) fail('OUTPUT_LIMIT', 'Streamed output exceeds maxOutputBytes');
            notify(emit, { type: 'model.output.delta', text: event.delta, requestId, clientRequestId, responseId });
          } else if (event.type === 'response.refusal.delta') {
            // Wait for the terminal response so usage can still be accounted for.
            notify(emit, { type: 'model.refusal', requestId, clientRequestId, responseId });
          } else if (event.type === 'response.completed') {
            capture(event.response);
            break; // Cancel the remaining body; do not wait indefinitely for transport EOF.
          } else if (event.type === 'response.incomplete' || event.type === 'response.failed') {
            capture(event.response);
            fail(event.type === 'response.incomplete' ? 'RESPONSE_INCOMPLETE' : 'RESPONSE_FAILED',
              `Responses stream ended with ${event.type}`);
          } else if (event.type === 'error') {
            if (isRecord(event.response)) capture(event.response);
            fail('STREAM_ERROR', 'Responses API sent a stream error');
          } else if (event.type === '__done') {
            break;
          }
          // Tool calls and reasoning events are not executed or exposed.
        }
        if (!response) fail('STREAM_TRUNCATED', 'Stream ended without a terminal response');
      } else if (mime === 'application/json' || mime.endsWith('+json')) {
        let value;
        try { value = JSON.parse(await readText(http.body, limits.maxResponseBytes)); }
        catch (cause) {
          if (cause instanceof ModelRequestError || combinedSignal.aborted) throw cause;
          fail('INVALID_RESPONSE_JSON', 'HTTP response is not valid JSON', { cause });
        }
        capture(value);
      } else {
        fail('CONTENT_TYPE', 'Unexpected Responses API content type');
      }
      combinedSignal.throwIfAborted();
      const { text } = parseAndValidate(response, validate, limits.maxOutputBytes);
      notify(emit, { type: 'model.request.completed', requestId, clientRequestId, responseId, usage });
      // output_text is a convenience property provided by the SDK, not always by wire JSON.
      return { ...response, output_text: text };
    } catch (cause) {
      let error;
      if (combinedSignal.aborted) {
        error = new ModelRequestError(timedOut ? 'Responses request timed out' : 'Responses request was cancelled', {
          code: timedOut ? 'TIMEOUT' : 'ABORTED', cause,
        });
      } else if (cause instanceof ModelRequestError) error = cause;
      else error = new ModelRequestError('Responses transport or decoding failed', { code: 'TRANSPORT_ERROR', cause });
      Object.assign(error, {
        status, requestId, clientRequestId, responseId, usage,
        // Conservatively retain uncertainty after any dispatched request with no final usage.
        unknownUsagePossible: dispatched && usage === null,
      });
      if (response) error.response = response;
      notify(emit, { type: 'model.request.failed', ...error.toJSON() });
      throw error;
    } finally {
      clearTimeout(timer);
      // Ensure every exit releases/cancels the response body, including content-type errors.
      await cancelBody(http?.body);
      controller.abort();
    }
  }

  return Object.freeze({ requestStructured });
}

let defaultClient;
/** Backward-compatible entry point: returns the completed response, not parsed data. */
export async function requestStructured(args) {
  defaultClient ??= createNativeModelClient();
  return defaultClient.requestStructured(args);
}
