import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/core/config.js';
import { parseEnvFile, reconcileCredentialScopes, resolveRuntimeEnv } from '../src/core/runtime-env.js';

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
