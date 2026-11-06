import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, redactConfig } from '../src/core/config.js';
import { createClient } from '../src/openai/client.js';
import { createFallbackClient, providerList, supportsRoute } from '../src/openai/fallback.js';
import { startMockServer } from './helpers/mock-server.js';

const home = 'test/.home-backends';
const servers = [];
after(async () => {
    for (const server of servers) await server.close();
});

/**
 * Start a mock OpenAI host and keep it for cleanup.
 * @param {object} options
 * @returns {Promise<object>}
 */
async function host(options) {
    const server = await startMockServer(options);
    servers.push(server);
    return server;
}

/**
 * A config with only the fields the client reads.
 * @param {object[]} backends
 * @param {string} baseURL
 * @param {string} apiKey
 * @returns {object}
 */
const configFor = (backends, baseURL, apiKey) => ({
    apiKey, baseURL, retries: 0,
    backends,
    fallback: { enabled: true, providers: [], models: {} },
    limits: {},
    completionsBackends: [],
    imagesBackends: [],
    decisionsBackends: [],
    moderationsBackends: [],
});

// ── configuration ──────────────────────────────────────────────────────────

test('backends accept baseUrl, expand placeholders, and make the first keyed entry primary', async () => {
    const config = await loadConfig({
        env: {
            AI_AGENT_HOME: home, AI_MODEL: 'gpt-6.1-terra',
            OPENAI_API_KEY: 'sk-primary', SPRUTDOCK_API_KEY: 'sk-sprut', GPTUNNEL_API_KEY: 'sk-gpt',
        },
        overrides: {
            backends: [
                { baseUrl: 'https://api.proxyapi.ru/v1', apiKey: '{{env:OPENAI_API_KEY}}' },
                { baseUrl: 'https://sprutdock.ru/v1', apiKey: '{{env:SPRUTDOCK_API_KEY}}', supports: { decisionAPI: false } },
                { baseUrl: 'https://gptunnel.ru/', apiKey: '{{env:GPTUNNEL_API_KEY}}', headers: { useWalletBalance: true } },
            ],
        },
        ensureHome: false,
    });
    assert.equal(config.baseURL, 'https://api.proxyapi.ru/v1');
    assert.equal(config.apiKey, 'sk-primary');
    assert.equal(config.backends[0].baseURL, 'https://api.proxyapi.ru/v1');
    assert.deepEqual(config.backends[1].supports, { decisions: false });
    assert.deepEqual(config.backends[2].headers, { useWalletBalance: 'true' });
    assert.equal(config.backends[2].baseURL, 'https://gptunnel.ru/');
});

test('a backend without a key does not become primary when a later one has a key', async () => {
    const config = await loadConfig({
        env: { AI_AGENT_HOME: home, AI_MODEL: 'gpt-6.1-terra' },
        overrides: {
            backends: [
                { baseUrl: 'https://keyless.example/v1' },
                { baseUrl: 'https://keyed.example/v1', apiKey: 'sk-keyed' },
            ],
        },
        ensureHome: false,
    });
    assert.equal(config.baseURL, 'https://keyed.example/v1');
    assert.equal(config.apiKey, 'sk-keyed');
});

test('an env key makes a backend primary and is used as the top-level key', async () => {
    const load = (env) => loadConfig({
        env: { AI_AGENT_HOME: home, AI_MODEL: 'gpt-6.1-terra', ...env },
        overrides: {
            backends: [
                { baseUrl: 'https://first.example/v1', env: 'FIRST_KEY' },
                { baseUrl: 'https://second.example/v1', apiKey: 'sk-second' },
            ],
        },
        ensureHome: false,
    });
    const config = await load({ FIRST_KEY: 'sk-first' });
    assert.equal(config.baseURL, 'https://first.example/v1');
    assert.equal(config.apiKey, 'sk-first');
    const unkeyed = await load({});
    assert.equal(unkeyed.baseURL, 'https://second.example/v1');
    assert.equal(unkeyed.apiKey, 'sk-second');
});

test('backends validate their fields and route switches', async () => {
    const load = (backends) => loadConfig({
        env: { AI_AGENT_HOME: home, AI_MODEL: 'gpt-6.1-terra' },
        overrides: { backends }, ensureHome: false,
    });
    await assert.rejects(load([{ baseUrl: 'https://x/v1', apiKey: 'sk', speed: 1 }]), /backends\[0\]\.speed/);
    await assert.rejects(load([{ baseUrl: 'not a url', apiKey: 'sk' }]), /backends\[0\]\.baseURL/);
    await assert.rejects(load([{ baseUrl: 'https://x/v1', apiKey: 'sk', supports: { telepathy: true } }]), /supports\.telepathy/);
    await assert.rejects(load([{ baseUrl: 'https://x/v1', apiKey: 'sk', supports: { decisions: 'no' } }]), /decisions: true \| false/);
    await assert.rejects(load([{ baseUrl: 'https://x/v1', apiKey: 'sk', headers: { 'bad header': '1' } }]), /имя заголовка/);
    await assert.rejects(load([{ baseUrl: 'https://x/v1', apiKey: 'sk', headers: { x: 'a\nb' } }]), /перевода строки/);
});

test('modelsBackends normalize URLs, inherit keys by exact baseURL, validate, and redact secrets', async () => {
    const config = await loadConfig({
        env: { AI_AGENT_HOME: home, AI_MODEL: 'gpt-6.1-terra', OPENAI_API_KEY: 'sk-primary' },
        overrides: {
            backends: [{ baseURL: 'https://model.example/v1', apiKey: 'sk-inherited', headers: { 'x-api-key': 'secret' } }],
            modelsBackends: {
                'gpt-6-luna': ['https://model.example/v1'],
                'gpt-6.1-sol': [{ baseURL: 'https://other.example/v1', apiKey: 'sk-local', vendor: 'acme', prefix: 'gpt-', suffix: '-pro', type: 'text' }],
            },
        },
        ensureHome: false,
    });
    assert.deepEqual(config.modelsBackends['gpt-6-luna'], [{ baseURL: 'https://model.example/v1' }]);
    assert.equal(config.modelsBackends['gpt-6.1-sol'][0].apiKey, 'sk-local');
    const shown = redactConfig(config);
    assert.equal(shown.modelsBackends['gpt-6.1-sol'][0].apiKey, '…');
    assert.equal(shown.backends[0].headers['x-api-key'], '…');
    for (const invalid of [
        { m: [{ apiKey: 'sk' }] },
        { m: [{ baseURL: 'https://x/v1', apiKey: 'sk', type: 'audio' }] },
        { m: [{ baseURL: 'https://x/v1' }] },
    ]) {
        await assert.rejects(loadConfig({
            env: { AI_AGENT_HOME: home, AI_MODEL: 'gpt-6.1-terra' },
            overrides: { modelsBackends: invalid }, ensureHome: false,
        }), /modelsBackends/);
    }
    await assert.rejects(loadConfig({
        env: { AI_AGENT_HOME: home, AI_MODEL: 'gpt-6.1-terra' },
        overrides: {
            backends: [{ baseURL: 'https://x/v1/', apiKey: 'sk' }],
            modelsBackends: { m: [{ baseURL: 'https://x/v1', type: 'auto' }] },
        }, ensureHome: false,
    }), /apiKey не задан/);
});

// ── fallback list ──────────────────────────────────────────────────────────

test('providerList reads backends, skips the primary and entries without a key', () => {
    const config = {
        baseURL: 'https://a.example/v1/', apiKey: 'sk-a',
        backends: [
            { baseURL: 'https://a.example/v1', apiKey: 'sk-a' },
            { baseURL: 'https://b.example/v1', apiKey: 'sk-b', supports: { decisions: false } },
            { baseURL: 'https://c.example/v1', apiKey: null },
            { baseURL: 'https://d.example/v1', apiKey: 'sk-d', headers: { useWalletBalance: 'true' } },
        ],
        fallback: { enabled: true, providers: [] },
    };
    assert.deepEqual(providerList(config, {}), [
        { baseURL: 'https://b.example/v1', apiKey: 'sk-b', supports: { decisions: false } },
        { baseURL: 'https://d.example/v1', apiKey: 'sk-d', headers: { useWalletBalance: 'true' } },
    ]);
});

test('supportsRoute defaults to on and maps the images variants', () => {
    assert.equal(supportsRoute(null, 'decisions'), true);
    assert.equal(supportsRoute({ decisions: false }, 'decisions'), false);
    assert.equal(supportsRoute({ decisions: false }, 'responses'), true);
    assert.equal(supportsRoute({ decisionAPI: false }, 'decisions'), false);
    assert.equal(supportsRoute({ images: false }, 'images-edit'), false);
    assert.equal(supportsRoute({ images: false }, 'images-vector'), false);
});

test('modelsBackends inherit matching backend settings, rewrite the model, and filter by route type', async () => {
    const general = await host({ script: () => ({ text: 'general' }), images: () => ({ data: [{ b64_json: Buffer.from('general').toString('base64') }] }) });
    const modelText = await host({ script: () => ({ text: 'model text' }) });
    const modelImages = await host({ images: () => ({ data: [{ b64_json: Buffer.from('model image').toString('base64') }] }) });
    const modelDecisions = await host({ decisions: () => ({ answers: [{ label: 'model decision' }] }) });
    const config = configFor([
        { baseURL: general.baseURL, apiKey: 'sk-general', body: { inheritedFlag: true } },
    ], general.baseURL, 'sk-general');
    config.modelsBackends = {
        'gpt-6-luna': [
            { baseURL: modelText.baseURL, apiKey: 'sk-text', vendor: 'acme', prefix: 'openai/', suffix: '-pro', type: 'text' },
            { baseURL: modelImages.baseURL, apiKey: 'sk-image', prefix: 'image/', type: 'images' },
        ],
        'gpt-6.1-terra': [{ baseURL: general.baseURL, prefix: 'vendor/' }],
        'gpt-6-luna-decisions': [{ baseURL: modelDecisions.baseURL, apiKey: 'sk-decision', vendor: 'acme', suffix: '-safe', type: 'decisions' }],
    };
    const client = createFallbackClient(config);
    try {
        await client.responses.create({ model: 'gpt-6-luna', input: 'hello', stream: false });
        const textRequest = modelText.requests.find((request) => request.path === '/v1/responses');
        assert.equal(textRequest.body.model, 'acme/openai/gpt-6-luna-pro');
        assert.equal(textRequest.headers.authorization, 'Bearer sk-text');
        assert.equal(general.requests.filter((request) => request.path === '/v1/responses').length, 0);

        await client.images.generate({ model: 'gpt-6-luna', prompt: 'draw' });
        const imageRequest = modelImages.requests.find((request) => request.path === '/v1/images/generations');
        assert.equal(imageRequest.body.model, 'image/gpt-6-luna');
        assert.equal(general.requests.filter((request) => request.path === '/v1/images/generations').length, 0);

        await client.responses.create({ model: 'gpt-6.1-terra', input: 'inherit', stream: false });
        const inheritedRequest = general.requests.find((request) => request.path === '/v1/responses');
        assert.equal(inheritedRequest.body.model, 'vendor/gpt-6.1-terra');
        assert.equal(inheritedRequest.headers.authorization, 'Bearer sk-general');
        assert.equal(inheritedRequest.body.inheritedFlag, true);

        const decisions = await client.decisions.create({ model: 'gpt-6-luna-decisions', input: 'check' });
        assert.deepEqual(decisions.answers, [{ label: 'model decision' }]);
        const decisionRequest = modelDecisions.requests.find((request) => request.path === '/v1/decisions');
        assert.equal(decisionRequest.body.model, 'acme/gpt-6-luna-decisions-safe');
        assert.equal(general.requests.filter((request) => request.path === '/v1/decisions').length, 0);
    } finally {
        client.close();
    }
});

// ── requests ───────────────────────────────────────────────────────────────

test('decisions skip a backend that turned the route off', async () => {
    const primary = await host({ script: () => ({ text: 'ok' }), decisions: () => ({ answers: [{ label: 'primary' }] }) });
    const fallback = await host({ script: () => ({ text: 'ok' }), decisions: () => ({ answers: [{ label: 'fallback' }] }) });
    const client = createFallbackClient(configFor([
        { baseURL: primary.baseURL, apiKey: 'sk-primary', supports: { decisions: false } },
        { baseURL: fallback.baseURL, apiKey: 'sk-fallback' },
    ], primary.baseURL, 'sk-primary'));
    try {
        const answer = await client.decisions.create({ model: 'openai/gpt-6-luna-decisions', input: 'is it spam?' });
        assert.deepEqual(answer.answers, [{ label: 'fallback' }]);
        assert.equal(primary.requests.filter((request) => request.path === '/v1/decisions').length, 0);
        assert.equal(fallback.requests.filter((request) => request.path === '/v1/decisions').length, 1);
    } finally {
        client.close();
    }
});

test('decisions use decisionsBackends when configured', async () => {
    const textHost = await host({ script: () => ({ text: 'ok' }), decisions: () => ({ answers: [{ label: 'text' }] }) });
    const decisionHost = await host({ script: () => ({ text: 'ok' }), decisions: () => ({ answers: [{ label: 'decision' }] }) });
    const config = {
        baseURL: textHost.baseURL, apiKey: 'sk-text', retries: 0,
        backends: [{ baseURL: textHost.baseURL, apiKey: 'sk-text' }],
        decisionsBackends: [{ baseURL: decisionHost.baseURL, apiKey: 'sk-decision' }],
        fallback: { enabled: true, providers: [], models: {} },
        limits: {},
    };
    const client = createFallbackClient(config);
    try {
        const answer = await client.decisions.create({ model: 'openai/gpt-6-luna-decisions', input: 'is it spam?' });
        assert.deepEqual(answer.answers, [{ label: 'decision' }]);
        assert.equal(textHost.requests.filter((request) => request.path === '/v1/decisions').length, 0);
        assert.equal(decisionHost.requests.filter((request) => request.path === '/v1/decisions').length, 1);
    } finally {
        client.close();
    }
});

test('images use imagesBackends when configured', async () => {
    const textHost = await host({
        script: () => ({ text: 'ok' }),
        images: () => ({ data: [{ b64_json: Buffer.from('image').toString('base64') }] }),
    });
    const imageHost = await host({
        script: () => ({ text: 'ok' }),
        images: () => ({ data: [{ b64_json: Buffer.from('image').toString('base64') }] }),
    });
    const config = {
        baseURL: textHost.baseURL, apiKey: 'sk-text', retries: 0,
        backends: [{ baseURL: textHost.baseURL, apiKey: 'sk-text' }],
        imagesBackends: [{ baseURL: imageHost.baseURL, apiKey: 'sk-image' }],
        fallback: { enabled: true, providers: [], models: {} },
        limits: {},
    };
    const client = createFallbackClient(config);
    try {
        await client.images.generate({ model: 'openai/gpt-image-2.6-sunburst', prompt: 'a cat' });
        assert.equal(textHost.requests.filter((request) => request.path === '/v1/images/generations').length, 0);
        assert.equal(imageHost.requests.filter((request) => request.path === '/v1/images/generations').length, 1);
    } finally {
        client.close();
    }
});

test('an empty pool falls back to backends', async () => {
    const primary = await host({ script: () => ({ text: 'ok' }), decisions: () => ({ answers: [{ label: 'primary' }] }) });
    const fallback = await host({ script: () => ({ text: 'ok' }), decisions: () => ({ answers: [{ label: 'fallback' }] }) });
    const config = {
        baseURL: primary.baseURL, apiKey: 'sk-primary', retries: 0,
        backends: [
            { baseURL: primary.baseURL, apiKey: 'sk-primary' },
            { baseURL: fallback.baseURL, apiKey: 'sk-fallback' },
        ],
        decisionsBackends: [],
        fallback: { enabled: true, providers: [], models: {} },
        limits: {},
    };
    const client = createFallbackClient(config);
    try {
        const answer = await client.decisions.create({ model: 'openai/gpt-6-luna-decisions', input: 'is it spam?' });
        assert.deepEqual(answer.answers, [{ label: 'primary' }]);
    } finally {
        client.close();
    }
});

test('providerList reads the kind pool', () => {
    const config = {
        baseURL: 'https://a.example/v1/', apiKey: 'sk-a',
        backends: [{ baseURL: 'https://a.example/v1', apiKey: 'sk-a' }, { baseURL: 'https://b.example/v1', apiKey: 'sk-b' }],
        decisionsBackends: [{ baseURL: 'https://c.example/v1', apiKey: 'sk-c' }, { baseURL: 'https://d.example/v1', apiKey: 'sk-d' }],
        fallback: { enabled: true, providers: [] },
    };
    // decisions primary = c (first usable), so providerList returns d
    assert.deepEqual(providerList(config, {}, 'decisions'), [
        { baseURL: 'https://d.example/v1', apiKey: 'sk-d' },
    ]);
    // responses primary = a, so providerList returns b
    assert.deepEqual(providerList(config, {}, 'responses'), [
        { baseURL: 'https://b.example/v1', apiKey: 'sk-b' },
    ]);
});

test('a legacy fallback.providers entry is merged into backends', async () => {
    const config = await loadConfig({
        env: { AI_AGENT_HOME: home, AI_MODEL: 'gpt-6.1-terra', OPENAI_API_KEY: 'sk-primary' },
        overrides: {
            baseURL: 'https://api.proxyapi.ru/v1', apiKey: '{{env:OPENAI_API_KEY}}',
            backends: [],
            fallback: {
                enabled: true,
                providers: [{ baseURL: 'https://gptunnel.ru/v1', apiKey: '{{env:OPENAI_API_KEY}}' }],
            },
        },
        ensureHome: false,
    });
    assert.equal(config.backends.length, 1);
    assert.equal(config.backends[0].baseURL, 'https://gptunnel.ru/v1');
    assert.equal(config.fallback.providers.length, 0);
});

test('new backend pools are validated', async () => {
    const load = (branch) => loadConfig({
        env: { AI_AGENT_HOME: home, AI_MODEL: 'gpt-6.1-terra' },
        overrides: { [branch]: [{ baseUrl: 'https://x/v1', apiKey: 'sk', unknownField: 1 }] },
        ensureHome: false,
    });
    await assert.rejects(load('imagesBackends'), /imagesBackends\[0\]\.unknownField/);
    await assert.rejects(load('decisionsBackends'), /decisionsBackends\[0\]\.unknownField/);
    await assert.rejects(load('completionsBackends'), /completionsBackends\[0\]\.unknownField/);
    await assert.rejects(load('moderationsBackends'), /moderationsBackends\[0\]\.unknownField/);
});

test('custom headers reach the request and cannot replace Authorization', async () => {
    const server = await host({ script: () => ({ text: 'ok' }) });
    const client = createClient({
        apiKey: 'sk-test', baseURL: server.baseURL,
        headers: { useWalletBalance: true, Authorization: 'Bearer nope' },
    });
    try {
        await client.responses.create({ model: 'gpt-6.1-terra', input: [], stream: false });
        const request = server.requests.find((item) => item.path === '/v1/responses');
        assert.equal(request.headers.usewalletbalance, 'true');
        assert.equal(request.headers.authorization, 'Bearer sk-test');
    } finally {
        client.close();
    }
});

test('a fallback backend sends its own headers', async () => {
    const dead = 'http://127.0.0.1:1/v1/';
    const live = await host({ script: () => ({ text: 'ok' }) });
    const client = createFallbackClient(configFor([
        { baseURL: dead, apiKey: 'sk-dead' },
        { baseURL: live.baseURL, apiKey: 'sk-live', headers: { useWalletBalance: 'true' } },
    ], dead, 'sk-dead'));
    try {
        await client.responses.create({ model: 'gpt-6.1-terra', input: [], stream: false });
        const request = live.requests.find((item) => item.path === '/v1/responses');
        assert.equal(request.headers.usewalletbalance, 'true');
    } finally {
        client.close();
    }
});
