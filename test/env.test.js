import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/core/config.js';
import {
    envValue, liveEnv, parseEnvFile, reconcileCredentialScopes, refreshRuntimeEnv, resetLiveEnv, resolveRuntimeEnv, setLiveEnv,
} from '../src/core/runtime-env.js';
import { providerList } from '../src/openai/fallback.js';

test('parseEnvFile skips comments and strips quotes', () => {
    const parsed = parseEnvFile('# comment\r\n\r\nexport OPENAI_API_KEY="sk-quoted"\nOPENAI_BASE_URL=\'https://example.test/v1\'\n');
    assert.equal(parsed.OPENAI_API_KEY, 'sk-quoted');
    assert.equal(parsed.OPENAI_BASE_URL, 'https://example.test/v1');
});

test('a user key does not split a system key and base URL', () => {
    const env = reconcileCredentialScopes({
        env: { OPENAI_API_KEY: 'user-key', OPENAI_BASE_URL: 'https://api.proxyapi.ru/v1', KEEP: 'yes' },
        user: { OPENAI_API_KEY: 'user-key' },
        machine: { OPENAI_API_KEY: 'machine-key', OPENAI_BASE_URL: 'https://api.proxyapi.ru/v1' },
    });
    assert.equal(env.OPENAI_API_KEY, 'machine-key');
    assert.equal(env.OPENAI_BASE_URL, 'https://api.proxyapi.ru/v1');
    assert.equal(env.KEEP, 'yes');
});

test('a key set only in this process is kept', () => {
    const env = reconcileCredentialScopes({
        env: { OPENAI_API_KEY: 'session-key', OPENAI_BASE_URL: 'https://api.proxyapi.ru/v1' },
        user: { OPENAI_API_KEY: 'user-key' },
        machine: { OPENAI_API_KEY: 'machine-key', OPENAI_BASE_URL: 'https://api.proxyapi.ru/v1' },
    });
    assert.equal(env.OPENAI_API_KEY, 'session-key');
    assert.equal(env.OPENAI_BASE_URL, 'https://api.proxyapi.ru/v1');
});

test('a complete user pair stays in front of the system pair', () => {
    const env = reconcileCredentialScopes({
        env: { OPENAI_API_KEY: 'user-key', OPENAI_BASE_URL: 'https://api.openai.com/v1' },
        user: { OPENAI_API_KEY: 'user-key', OPENAI_BASE_URL: 'https://api.openai.com/v1' },
        machine: { OPENAI_API_KEY: 'machine-key', OPENAI_BASE_URL: 'https://api.proxyapi.ru/v1' },
    });
    assert.equal(env.OPENAI_API_KEY, 'user-key');
    assert.equal(env.OPENAI_BASE_URL, 'https://api.openai.com/v1');
});

test('.env in the working directory overrides inherited credentials', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'ai-env-'));
    try {
        await writeFile(path.join(cwd, '.env'), 'OPENAI_API_KEY=from-file\nOPENAI_BASE_URL=https://example.test/v1\nOPENAI_MODEL=from-file-model\n');
        const env = await resolveRuntimeEnv({
            cwd,
            env: { OPENAI_API_KEY: 'inherited', OPENAI_BASE_URL: 'https://inherited.test/v1', KEEP: 'yes' },
            platform: 'linux',
        });
        assert.equal(env.OPENAI_API_KEY, 'from-file');
        assert.equal(env.OPENAI_BASE_URL, 'https://example.test/v1');
        assert.equal(env.OPENAI_MODEL, 'from-file-model');
        assert.equal(env.KEEP, 'yes');
        assert.equal(process.env.OPENAI_API_KEY === 'from-file', false);
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test('without .env a split Windows pair uses the system pair', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'ai-env-'));
    try {
        const env = await resolveRuntimeEnv({
            cwd,
            env: { OPENAI_API_KEY: 'user-key', OPENAI_BASE_URL: 'https://api.proxyapi.ru/v1', KEEP: 'yes' },
            platform: 'win32',
            readScope(name) {
                return {
                    user: name === 'OPENAI_API_KEY' ? 'user-key' : null,
                    machine: name === 'OPENAI_API_KEY' ? 'machine-key' : 'https://api.proxyapi.ru/v1',
                };
            },
        });
        assert.equal(env.OPENAI_API_KEY, 'machine-key');
        assert.equal(env.OPENAI_BASE_URL, 'https://api.proxyapi.ru/v1');
        assert.equal(env.KEEP, 'yes');
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test('loadConfig reads OPENAI_MODEL when AI_MODEL is absent', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-env-home-'));
    try {
        const config = await loadConfig({
            env: { AI_AGENT_HOME: home, OPENAI_MODEL: 'from-openai-model', OPENAI_API_KEY: 'sk-test' },
            ensureHome: false,
        });
        assert.equal(config.model, 'from-openai-model');
        const preferred = await loadConfig({
            env: { AI_AGENT_HOME: home, AI_MODEL: 'from-ai-model', OPENAI_MODEL: 'from-openai-model', OPENAI_API_KEY: 'sk-test' },
            ensureHome: false,
        });
        assert.equal(preferred.model, 'from-ai-model');
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

test('an edited .env is picked up without restarting the process', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'ai-env-live-'));
    resetLiveEnv();
    try {
        await writeFile(path.join(cwd, '.env'), 'IMAGE_MODEL=first\n');
        const first = await refreshRuntimeEnv({ cwd, platform: 'linux', env: {} });
        assert.equal(first.IMAGE_MODEL, 'first');
        assert.equal(envValue('IMAGE_MODEL'), 'first');

        // A process restart would not be needed: the next refresh sees the new file.
        await new Promise((resolve) => setTimeout(resolve, 20));
        await writeFile(path.join(cwd, '.env'), 'IMAGE_MODEL=second\n');
        const second = await refreshRuntimeEnv({ cwd, platform: 'linux', env: {} });
        assert.equal(second.IMAGE_MODEL, 'second');
        assert.equal(envValue('IMAGE_MODEL'), 'second');
        assert.equal(liveEnv().IMAGE_MODEL, 'second');
    } finally {
        resetLiveEnv();
        await rm(cwd, { recursive: true, force: true });
    }
});

test('a provider key that exists only in .env reaches the fallback list', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'ai-env-provider-'));
    resetLiveEnv();
    try {
        await writeFile(path.join(cwd, '.env'), 'SPRUTDOCK_API_KEY=from-dotenv\n');
        const env = await refreshRuntimeEnv({ cwd, platform: 'linux', env: {} });
        setLiveEnv(env);
        const providers = providerList({ baseURL: 'https://api.proxyapi.ru/v1/', fallback: { enabled: true, providers: [{ baseURL: 'https://sprutdock.ru/v1', apiKey: null, env: 'SPRUTDOCK_API_KEY' }] } });
        assert.equal(providers.length, 1);
        assert.equal(providers[0].apiKey, 'from-dotenv');
        // The .env value wins even when the process inherited a different key.
        if (process.env.SPRUTDOCK_API_KEY) assert.notEqual(providers[0].apiKey, process.env.SPRUTDOCK_API_KEY);
    } finally {
        resetLiveEnv();
        await rm(cwd, { recursive: true, force: true });
    }
});

test('images edit and vectorize move to the fallback host when the primary rejects the key', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>';
    const svgB64 = Buffer.from(svg).toString('base64');
    const seen = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('latin1');
        seen.push({ url: req.url, model: /name="model"\r\n\r\n([^\r]+)\r\n/.exec(raw)?.[1] ?? '' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: svgB64 }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const { createFallbackClient } = await import('../src/openai/fallback.js');
    const client = createFallbackClient({
        apiKey: 'sk-dead', baseURL: 'http://127.0.0.1:1/v1/', retries: 0,
        fallback: { enabled: true, providers: [{ baseURL: `http://127.0.0.1:${port}/v1/`, apiKey: 'sk-live' }] },
        limits: {},
    });
    try {
        const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');
        const edited = await client.images.edit({
            model: 'openai/gpt-image-2.5-sunburst', prompt: 'paint', format: 'png',
            files: [{ filename: 'src.png', mime: 'image/png', bytes: png }],
        });
        assert.equal(edited[0], svgB64);
        const vectored = await client.images.vectorize({
            model: 'recraft/recraft-v4.1-pro-vector', prompt: 'trace',
            image: { mime: 'image/png', bytes: png, filename: 'mark.png' },
        });
        assert.equal(vectored[0], svgB64);
        assert.equal(seen.length, 2);
        assert.match(seen[0].url, /\/images\/edits/);
        assert.equal(seen[0].model, 'openai/gpt-image-2.5-sunburst');
        assert.equal(seen[1].model, 'recraft/recraft-v4.1-pro-vector');
    } finally {
        client.close();
        await new Promise((resolve) => server.close(resolve));
    }
});
