import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, retryDelayMs } from '../src/openai/client.js';
import { transientNetwork } from '../src/openai/http.js';
import { startMockServer } from './helpers/mock-server.js';

let server;
let scenarios = [];
before(async () => { server = await startMockServer({ script: (body, index) => scenarios[index] ?? scenarios.at(-1) }); });
beforeEach(() => server.reset());
after(() => server.close());

const client = () => createClient({ apiKey: 'sk-test', baseURL: server.baseURL, retries: 2 });

test('streams a response and returns the final object with output_text', async () => {
    scenarios = [{ text: 'Привет, мир!', reasoning: 'thinking about greeting' }];
    const events = [];
    const response = await client().responses.create({ model: 'mock-model', input: 'hi', stream: true }, { onEvent: (e) => events.push(e.type) });
    assert.equal(response.status, 'completed');
    assert.equal(response.output_text, 'Привет, мир!');
    assert.ok(events.includes('reasoning.delta'));
    assert.ok(events.includes('text.delta'));
    assert.ok(events.includes('request.done'));
    assert.equal(response.usage.input_tokens, 100);
});

test('non-streaming create returns JSON', async () => {
    scenarios = [{ text: 'plain' }];
    const response = await client().responses.create({ model: 'mock-model', input: 'hi', stream: false });
    assert.equal(response.output_text, 'plain');
    const last = server.requests.at(-1);
    assert.equal(last.headers.accept, 'application/json');
    assert.equal(last.headers.authorization, 'Bearer sk-test');
});

test('retries retryable HTTP errors then succeeds', async () => {
    scenarios = [{ httpStatus: 429, httpBody: { error: { message: 'slow down', type: 'rate_limit', code: 'rate_limited' } } }, { text: 'after retry' }];
    const events = [];
    const response = await client().responses.create({ model: 'mock-model', input: 'hi', stream: true }, { onEvent: (e) => events.push(e) });
    assert.equal(response.output_text, 'after retry');
    const retry = events.find((e) => e.type === 'request.retry' && e.status === 429);
    assert.ok(retry);
    assert.ok(retry.delayMs >= 3000);
    assert.match(retry.reason, /429/);
});

test('a dropped network can be retried and a persistent status cannot', async () => {
    assert.equal(transientNetwork({ code: 'ENETRESET' }), true);
    assert.equal(transientNetwork({ message: 'read ECONNRESET: network changed' }), true);
    assert.equal(transientNetwork({ code: 'EACCES' }), false);
    for (const status of [400, 401, 403, 404]) {
        server.reset();
        scenarios = [{ httpStatus: status, httpBody: { error: { message: 'постоянная ошибка', code: 'denied' } } }];
        const events = [];
        await assert.rejects(client().responses.create({ model: 'mock-model', input: 'hi', stream: false }, { onEvent: (event) => events.push(event) }), (error) => error.status === status);
        assert.equal(server.requests.length, 1);
        assert.equal(events.some((event) => event.type === 'request.retry'), false);
        assert.ok(events.some((event) => event.type === 'warning' && String(event.message).includes(String(status))));
    }
});

test('a 429 waits at least 3 seconds and honors a longer Retry-After', () => {
    assert.ok(retryDelayMs(0, null, 429) >= 3000);
    assert.ok(retryDelayMs(0, 1, 429) >= 3000);
    assert.equal(retryDelayMs(0, 8, 429), 8000);
    assert.ok(retryDelayMs(0, null, 500) < 3000);
});

test('non-retryable HTTP error surfaces as ApiError with details', async () => {
    scenarios = [{ httpStatus: 400, httpBody: { error: { message: 'bad model', type: 'invalid_request_error', code: 'model_not_found', param: 'model' } } }];
    await assert.rejects(client().responses.create({ model: 'nope', input: 'hi', stream: true }), (error) => {
        assert.equal(error.name, 'ApiError');
        assert.equal(error.status, 400);
        assert.equal(error.apiCode, 'model_not_found');
        assert.equal(error.param, 'model');
        assert.match(error.message, /bad model/);
        return true;
    });
});

test('nested stream error followed by response.failed yields a failed response with error', async () => {
    scenarios = [{ status: 'failed', streamError: { type: 'insufficient_quota', code: 'credit_balance_exhausted', message: 'no credits' }, error: { code: 'credit_balance_exhausted', message: 'no credits' } }];
    const response = await client().responses.create({ model: 'mock-model', input: 'hi', stream: true });
    assert.equal(response.status, 'failed');
    assert.equal(response.error.code, 'credit_balance_exhausted');
});

test('truncated stream reports STREAM_TRUNCATED with the response id and last sequence', async () => {
    scenarios = [{ truncateAfterEvents: 3 }];
    await assert.rejects(client().responses.create({ model: 'mock-model', input: 'hi', stream: true }), (error) => {
        assert.equal(error.code, 'STREAM_TRUNCATED');
        assert.match(error.responseId, /^resp_/);
        assert.equal(error.details.lastSequence, 4);
        assert.equal(error.details.partialText, 'xxx');
        return true;
    });
});

test('a foreground stream that drops after it started is restarted once', async () => {
    scenarios = [{ truncateAfterEvents: 3 }, { text: 'recovered' }];
    const events = [];
    const response = await client().responses.create({ model: 'mock-model', input: 'hi', stream: true }, { onEvent: (event) => events.push(event) });
    assert.equal(response.output_text, 'recovered');
    assert.ok(events.some((event) => event.type === 'request.retry' && /Поток оборван/.test(event.reason)));
    assert.equal(server.requests.filter((request) => request.path === '/v1/responses').length, 2);
});

test('retrieve with stream and starting_after resumes a background response', async () => {
    scenarios = [{ text: 'resumed text' }];
    const c = client();
    const created = await c.responses.create({ model: 'mock-model', input: 'hi', stream: false, background: true });
    assert.equal(created.status, 'queued');
    const events = [];
    const final = await c.responses.retrieve(created.id, { stream: true, startingAfter: 1, onEvent: (e) => events.push(e.type) });
    assert.equal(final.output_text, 'resumed text');
    assert.ok(!events.includes('response.created'), 'events before starting_after are skipped');
    assert.equal(server.requests.at(-1).query.starting_after, '1');
});

test('models.list and inputTokens hit the expected routes', async () => {
    const c = client();
    const list = await c.models.list();
    assert.ok(list.data.some((m) => m.id === 'mock-model'));
    const count = await c.responses.inputTokens({ model: 'mock-model', input: [{ type: 'message', role: 'user', content: 'abc' }] });
    assert.ok(count.input_tokens > 0);
});

test('rejects a missing API key and non-https base URLs', () => {
    assert.throws(() => createClient({ apiKey: '' }), /OPENAI_API_KEY/);
    assert.throws(() => createClient({ apiKey: 'x', baseURL: 'https://u:p@api.openai.com/v1/' }), /учётные/);
});
