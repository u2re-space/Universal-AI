import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/openai/errors.js';
import { attemptChain, fallbackModel, modelMissing, providerDown, providerList } from '../src/openai/fallback.js';
import { defaults } from '../src/core/config.js';

test('known models fall back to another channel', () => {
    assert.equal(fallbackModel('gpt-6.1-terra'), 'anthropic/claude-haiku-5-5');
    assert.equal(fallbackModel('openai/gpt-6.1-sol'), 'anthropic/claude-sonnet-5.5');
    assert.equal(fallbackModel('openai/gpt-6-luna-decisions'), 'typesafe/jev-1.14');
    assert.equal(modelMissing(new ApiError('missing', { status: 404, apiCode: 'model_not_found' })), true);
    assert.equal(modelMissing(new ApiError('bad temperature', { status: 400 })), false);
    assert.equal(providerDown(new ApiError('down', { code: 'TIMEOUT' })), true);
    assert.equal(providerDown(new ApiError('no', { status: 401 })), true);
    assert.equal(providerDown(new ApiError('bad', { status: 400 })), false);
});

test('a missing model is tried on the same host, then on the next host', async () => {
    const seen = [];
    const result = await attemptChain({
        endpoints: [{ label: 'primary' }, { label: 'https://sprutdock.ru/v1' }],
        model: 'gpt-6.1-terra',
        map: defaults.fallback.models,
        send: async (endpoint, model) => {
            seen.push(`${endpoint.label}:${model}`);
            if (model !== 'anthropic/claude-haiku-5-5' || endpoint.label === 'primary') {
                throw new ApiError('missing', { status: 404, apiCode: 'model_not_found' });
            }
            return { ok: true };
        },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(seen, [
        'primary:gpt-6.1-terra',
        'primary:anthropic/claude-haiku-5-5',
        'https://sprutdock.ru/v1:gpt-6.1-terra',
        'https://sprutdock.ru/v1:anthropic/claude-haiku-5-5',
    ]);
});

test('a persistent request error does not move to the next host', async () => {
    let calls = 0;
    await assert.rejects(() => attemptChain({
        endpoints: [{ label: 'primary' }, { label: 'other' }],
        model: 'gpt-6.1-terra',
        map: {},
        send: async () => {
            calls += 1;
            throw new ApiError('bad input', { status: 400 });
        },
    }), (error) => error.status === 400);
    assert.equal(calls, 1);
});

test('sprutdock is used only when its key is present', () => {
    const config = { baseURL: 'https://api.proxyapi.ru/v1', fallback: defaults.fallback };
    assert.deepEqual(providerList(config, {}), [
        { baseURL: 'https://api.proxyapi.ru/v1', apiKey: "{{env:PROXYAPI_API_KEY}}" },
        { baseURL: 'https://sprutdock.ru/v1', apiKey: "{{env:SPRUTDOCK_API_KEY}}", supports: { decisionAPI: false } },
        { baseURL: 'https://gptunnel.ru/', apiKey: '{{env:GPTUNNEL_API_KEY}}', headers: { useWalletBalance: true } }
    ]);
    assert.equal(providerList(config, { PROXYAPI_API_KEY: '{{env:PROXYAPI_API_KEY}}' })[0].baseURL, 'https://api.proxyapi.ru/v1');
    assert.equal(providerList(config, { PROXYAPI_API_KEY: '{{env:PROXYAPI_API_KEY}}' })[0].apiKey, '{{env:PROXYAPI_API_KEY}}');
});
