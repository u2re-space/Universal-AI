import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/core/config.js';
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
});

// ── configuration ──────────────────────────────────────────────────────────

test('backends accept baseUrl, expand placeholders, and make the first keyed entry primary', async () => {
    const config = await loadConfig({
        env: {
            AI_AGENT_HOME: home, AI_MODEL: 'gpt-6-luna',
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
        env: { AI_AGENT_HOME: home, AI_MODEL: 'gpt-6-luna' },
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
        env: { AI_AGENT_HOME: home, AI_MODEL: 'gpt-6-luna', ...env },
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
        env: { AI_AGENT_HOME: home, AI_MODEL: 'gpt-6-luna' },
        overrides: { backends }, ensureHome: false,
    });
    await assert.rejects(load([{ baseUrl: 'https://x/v1', apiKey: 'sk', speed: 1 }]), /backends\[0\]\.speed/);
    await assert.rejects(load([{ baseUrl: 'not a url', apiKey: 'sk' }]), /backends\[0\]\.baseURL/);
    await assert.rejects(load([{ baseUrl: 'https://x/v1', apiKey: 'sk', supports: { telepathy: true } }]), /supports\.telepathy/);
    await assert.rejects(load([{ baseUrl: 'https://x/v1', apiKey: 'sk', supports: { decisions: 'no' } }]), /decisions: true \| false/);
    await assert.rejects(load([{ baseUrl: 'https://x/v1', apiKey: 'sk', headers: { 'bad header': '1' } }]), /имя заголовка/);
    await assert.rejects(load([{ baseUrl: 'https://x/v1', apiKey: 'sk', headers: { x: 'a\nb' } }]), /перевода строки/);
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

// ── requests ───────────────────────────────────────────────────────────────

test('decisions skip a backend that turned the route off', async () => {
    const primary = await host({ script: () => ({ text: 'ok' }), decisions: () => ({ answers: [{ label: 'primary' }] }) });
    const fallback = await host({ script: () => ({ text: 'ok' }), decisions: () => ({ answers: [{ label: 'fallback' }] }) });
    const client = createFallbackClient(configFor([
        { baseURL: primary.baseURL, apiKey: 'sk-primary', supports: { decisions: false } },
        { baseURL: fallback.baseURL, apiKey: 'sk-fallback' },
    ], primary.baseURL, 'sk-primary'));
    try {
        const answer = await client.decisions.create({ model: 'gpt-6-luna-decisions', input: 'is it spam?' });
        assert.deepEqual(answer.answers, [{ label: 'fallback' }]);
        assert.equal(primary.requests.filter((request) => request.path === '/v1/decisions').length, 0);
        assert.equal(fallback.requests.filter((request) => request.path === '/v1/decisions').length, 1);
    } finally {
        client.close();
    }
});

test('custom headers reach the request and cannot replace Authorization', async () => {
    const server = await host({ script: () => ({ text: 'ok' }) });
    const client = createClient({
        apiKey: 'sk-test', baseURL: server.baseURL,
        headers: { useWalletBalance: true, Authorization: 'Bearer nope' },
    });
    try {
        await client.responses.create({ model: 'gpt-6-luna', input: [], stream: false });
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
        await client.responses.create({ model: 'gpt-6-luna', input: [], stream: false });
        const request = live.requests.find((item) => item.path === '/v1/responses');
        assert.equal(request.headers.usewalletbalance, 'true');
    } finally {
        client.close();
    }
});
