import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { startMockServer } from './helpers/mock-server.js';
import { defaults, loadConfig } from '../src/core/config.js';
import { completeCode } from '../src/complete/complete.js';
import { buildProbeBody, completionChannelList, createCompletionChannels } from '../src/complete/channels.js';

const scripts = {};
let primary;
let fast;
let slow;
let missing;

function startChannel(name) {
    scripts[name] = () => ({ text: `${name}()` });
    return startMockServer({ script: (body) => scripts[name](body) });
}

function callsOf(server) {
    const requests = server.requests.filter((request) => request.method === 'POST' && request.path === '/v1/responses');
    return {
        probes: requests.filter((request) => request.body?.input === 'ping'),
        completions: requests.filter((request) => request.body?.input !== 'ping'),
    };
}

function channelScript({ probeDelay = 0, completionDelay = 0, probeStatus = null, completionStatus = null, text = 'ok' } = {}) {
    return (body) => {
        if (body.input === 'ping') {
            if (probeStatus) return { httpStatus: probeStatus.status, httpBody: probeStatus.body, delayMs: probeDelay };
            return { text: 'ok', delayMs: probeDelay };
        }
        if (completionStatus) return { httpStatus: completionStatus.status, httpBody: completionStatus.body, delayMs: completionDelay };
        return { text, delayMs: completionDelay };
    };
}

function configFor(providers, completion = {}) {
    return {
        ...defaults,
        apiKey: 'sk-primary',
        baseURL: primary.baseURL,
        completion: { ...defaults.completion, ...completion },
        fallback: { ...defaults.fallback, enabled: true, providers },
    };
}

function router(config) {
    return createCompletionChannels(config, { env: {} });
}

before(async () => {
    primary = await startChannel('primary');
    fast = await startChannel('fast');
    slow = await startChannel('slow');
    missing = await startChannel('missing');
});

beforeEach(() => {
    for (const server of [primary, fast, slow, missing]) server.reset();
});

after(async () => {
    for (const server of [primary, fast, slow, missing]) await server.close();
});

test('the fastest channel for the model wins and the choice is cached', async () => {
    scripts.primary = channelScript({ probeDelay: 240, completionDelay: 240, text: 'primary()' });
    scripts.fast = channelScript({ probeDelay: 10, completionDelay: 10, text: 'fast()' });
    scripts.slow = channelScript({ probeDelay: 120, completionDelay: 120, text: 'slow()' });
    scripts.missing = channelScript({
        probeDelay: 5,
        probeStatus: { status: 404, body: { error: { message: 'model not found', type: 'invalid_request_error', code: 'model_not_found' } } },
        text: 'missing()',
    });
    const config = configFor([
        { baseURL: fast.baseURL, apiKey: 'sk-fast' },
        { baseURL: slow.baseURL, apiKey: 'sk-slow' },
        { baseURL: missing.baseURL, apiKey: 'sk-missing' },
    ]);
    const channels = router(config);
    try {
        const first = await completeCode({ channels, config, request: { content: 'const a = |' } });
        assert.equal(first.text, 'fast()');
        assert.equal(callsOf(fast).completions.length, 1);
        assert.equal(callsOf(primary).completions.length, 0);
        assert.equal(callsOf(slow).completions.length, 0);
        assert.equal(callsOf(missing).completions.length, 0);
        assert.equal(callsOf(missing).probes.length, 1);

        const second = await completeCode({ channels, config, request: { content: 'const b = |' } });
        assert.equal(second.text, 'fast()');
        assert.equal(callsOf(fast).completions.length, 2);
        assert.equal(callsOf(fast).probes.length, 1);
        assert.equal(callsOf(primary).probes.length, 1);
    } finally { channels.close(); }
});

test('a failed fastest channel moves to the next probe winner', async () => {
    scripts.primary = channelScript({ probeDelay: 240, completionDelay: 240, text: 'primary()' });
    scripts.fast = channelScript({
        probeDelay: 10,
        completionStatus: { status: 500, body: { error: { message: 'boom', type: 'server_error', code: 'server_error' } } },
    });
    scripts.slow = channelScript({ probeDelay: 120, completionDelay: 10, text: 'slow()' });
    const config = configFor([
        { baseURL: fast.baseURL, apiKey: 'sk-fast' },
        { baseURL: slow.baseURL, apiKey: 'sk-slow' },
    ]);
    const channels = router(config);
    try {
        const first = await completeCode({ channels, config, request: { content: 'const a = |' } });
        assert.equal(first.text, 'slow()');
        assert.equal(callsOf(fast).completions.length, 1);
        assert.equal(callsOf(slow).completions.length, 1);

        const second = await completeCode({ channels, config, request: { content: 'const b = |' } });
        assert.equal(second.text, 'slow()');
        assert.equal(callsOf(fast).completions.length, 1);
        assert.equal(callsOf(slow).completions.length, 2);
        assert.equal(callsOf(slow).probes.length, 1);
    } finally { channels.close(); }
});

test('channelProbe false keeps the primary first and sends no probe', async () => {
    scripts.primary = channelScript({ text: 'primary()' });
    scripts.fast = channelScript({ text: 'fast()' });
    const config = configFor([{ baseURL: fast.baseURL, apiKey: 'sk-fast' }], { channelProbe: false });
    const channels = router(config);
    try {
        const result = await completeCode({ channels, config, request: { content: 'const a = |' } });
        assert.equal(result.text, 'primary()');
        assert.equal(callsOf(primary).probes.length, 0);
        assert.equal(callsOf(fast).probes.length, 0);
        assert.equal(callsOf(primary).completions.length, 1);
        assert.equal(callsOf(fast).completions.length, 0);
    } finally { channels.close(); }
});

test('a single channel is used without a probe', async () => {
    scripts.primary = channelScript({ text: 'primary()' });
    const config = configFor([]);
    const channels = router(config);
    try {
        const result = await completeCode({ channels, config, request: { content: 'const a = |' } });
        assert.equal(result.text, 'primary()');
        assert.equal(callsOf(primary).probes.length, 0);
        assert.equal(callsOf(primary).completions.length, 1);
    } finally { channels.close(); }
});

test('when every probe fails the primary is still tried', async () => {
    scripts.primary = (body) => body.input === 'ping'
        ? { httpStatus: 503, httpBody: { error: { message: 'down', type: 'server_error' } } }
        : { text: 'primary()' };
    scripts.fast = () => ({ httpStatus: 503, httpBody: { error: { message: 'down', type: 'server_error' } } });
    const config = configFor([{ baseURL: fast.baseURL, apiKey: 'sk-fast' }]);
    const channels = router(config);
    try {
        const result = await completeCode({ channels, config, request: { content: 'const a = |' } });
        assert.equal(result.text, 'primary()');
        assert.equal(callsOf(primary).completions.length, 1);
        assert.equal(callsOf(fast).completions.length, 0);
    } finally { channels.close(); }
});

test('the probe and the completion use the requested model', async () => {
    scripts.primary = (body) => {
        assert.equal(body.model, 'qwen/qwen3.8-flash');
        return { text: body.input === 'ping' ? 'ok' : 'primary()', delayMs: 200 };
    };
    scripts.fast = (body) => {
        assert.equal(body.model, 'qwen/qwen3.8-flash');
        return { text: body.input === 'ping' ? 'ok' : 'fast()', delayMs: 5 };
    };
    const config = configFor([{ baseURL: fast.baseURL, apiKey: 'sk-fast' }]);
    const channels = router(config);
    try {
        const result = await completeCode({
            channels, config,
            request: { content: 'const a = |', model: 'qwen/qwen3.8-flash' },
        });
        assert.equal(result.text, 'fast()');
        assert.equal(callsOf(fast).probes[0].body.model, 'qwen/qwen3.8-flash');
        assert.equal(callsOf(fast).completions[0].body.model, 'qwen/qwen3.8-flash');
    } finally { channels.close(); }
});

test('a missing model retries the stand-in on the fastest channel', async () => {
    const missingModel = { httpStatus: 404, httpBody: { error: { message: 'model not found', type: 'invalid_request_error', code: 'model_not_found' } } };
    scripts.primary = (body) => body.model === 'gpt-6-luna'
        ? missingModel
        : { text: body.input === 'ping' ? 'ok' : 'primary-fallback()', delayMs: 200 };
    scripts.fast = (body) => body.model === 'gpt-6-luna'
        ? missingModel
        : { text: body.input === 'ping' ? 'ok' : 'fast-fallback()', delayMs: 5 };
    const config = configFor([{ baseURL: fast.baseURL, apiKey: 'sk-fast' }]);
    const channels = router(config);
    try {
        const result = await completeCode({ channels, config, request: { content: 'const a = |' } });
        assert.equal(result.text, 'fast-fallback()');
        assert.equal(result.model, 'anthropic/claude-haiku-5-5');
        assert.equal(callsOf(fast).completions.at(-1).body.model, 'anthropic/claude-haiku-5-5');
    } finally { channels.close(); }
});

test('probeTtlMs 0 probes before every completion', async () => {
    scripts.primary = channelScript({ probeDelay: 120, text: 'primary()' });
    scripts.fast = channelScript({ probeDelay: 5, text: 'fast()' });
    const config = configFor([{ baseURL: fast.baseURL, apiKey: 'sk-fast' }], { probeTtlMs: 0 });
    const channels = router(config);
    try {
        await completeCode({ channels, config, request: { content: 'const a = |' } });
        await completeCode({ channels, config, request: { content: 'const b = |' } });
        assert.equal(callsOf(primary).probes.length, 2);
        assert.equal(callsOf(fast).probes.length, 2);
        assert.equal(callsOf(fast).completions.length, 2);
    } finally { channels.close(); }
});

test('channel list keeps the primary and every provider key', () => {
    const config = configFor([
        { baseURL: fast.baseURL, apiKey: 'sk-fast' },
        { baseURL: slow.baseURL, env: 'SLOW_KEY' },
    ]);
    const list = completionChannelList(config, { SLOW_KEY: 'sk-slow-env' });
    assert.deepEqual(list.map((item) => [item.baseURL, item.apiKey, item.primary]), [
        [primary.baseURL, 'sk-primary', true],
        [fast.baseURL, 'sk-fast', false],
        [slow.baseURL, 'sk-slow-env', false],
    ]);
});

test('probe body is short and follows the model catalog', () => {
    assert.deepEqual(buildProbeBody('gpt-6-luna'), {
        model: 'gpt-6-luna',
        input: 'ping',
        max_output_tokens: 32,
        stream: false,
        store: false,
        truncation: 'auto',
        reasoning: { effort: 'none' },
        text: { verbosity: 'low' },
    });
    assert.deepEqual(buildProbeBody('qwen/qwen3.8-flash'), {
        model: 'qwen/qwen3.8-flash',
        input: 'ping',
        max_output_tokens: 32,
        stream: false,
        store: false,
        truncation: 'auto',
    });
    assert.deepEqual(buildProbeBody('x-ai/grok-4.7').reasoning, { effort: 'low' });
});

test('completion channel probe settings are validated', async () => {
    assert.equal(defaults.completion.channelProbe, true);
    assert.equal(defaults.completion.probeTtlMs, 60_000);
    assert.equal(defaults.completion.probeTimeoutMs, 1_500);
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-complete-channels-'));
    try {
        const load = (completion) => loadConfig({ env: { AI_AGENT_HOME: home }, ensureHome: false, overrides: { completion } });
        await assert.rejects(() => load({ probeTtlMs: -1 }), /completion\.probeTtlMs/);
        await assert.rejects(() => load({ probeTimeoutMs: 10 }), /completion\.probeTimeoutMs/);
        await assert.rejects(() => load({ channelProbe: 'yes' }), /completion\.channelProbe/);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});
