import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { renderPlaceholders, expandConfigStrings } from '../src/core/placeholders.js';
import { loadConfig, defaults } from '../src/core/config.js';
import { setLiveEnv, resetLiveEnv } from '../src/core/runtime-env.js';
import { prepareTeamInvocation } from '../src/commands/team-args.js';
import { createRoleRunner } from '../src/agent/roles.js';
import { createLedger } from '../src/core/usage.js';

const dirs = [];
beforeEach(() => { resetLiveEnv(); });
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

/**
 * Make a temporary project directory with the given files.
 * @param {Record<string, string|Buffer>} files
 * @returns {Promise<string>}
 */
async function project(files = {}) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-placeholders-'));
    dirs.push(dir);
    for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), body);
    return dir;
}

// ── the four scopes ────────────────────────────────────────────────────────

test('env, task, and delegated placeholders replace their values', async () => {
    assert.equal(await renderPlaceholders('key={{env:KEY}}', { env: { KEY: 'sk-1' } }), 'key=sk-1');
    assert.equal(await renderPlaceholders('missing={{env:NOPE}}', { env: {} }), 'missing=');
    assert.equal(await renderPlaceholders('{{task:PROMPT}} / {{delegated:PROMPT}}', { task: 'outer', delegated: 'inner' }), 'outer / inner');
    assert.equal(await renderPlaceholders('{{ task : prompt }}', { task: 'spaced' }), 'spaced');
    assert.equal(await renderPlaceholders('{{task:OTHER}}', { task: 'outer' }), '{{task:OTHER}}');
});

test('a task or delegated scope that was not supplied stays for a later pass', async () => {
    assert.equal(await renderPlaceholders('{{task:PROMPT}}', {}), '{{task:PROMPT}}');
    assert.equal(await renderPlaceholders('{{delegated:PROMPT}}', {}), '{{delegated:PROMPT}}');
    assert.equal(await renderPlaceholders('{{task:PROMPT}}', { task: null }), '');
});

test('fs reads a project file and keeps its text', async () => {
    const root = await project({ 'rules.md': 'Rule one.\n' });
    assert.equal(await renderPlaceholders('{{fs:rules.md}}', { root }), 'Rule one.\n');
});

test('fs refuses an escape, a secret, a binary file, and an oversized file', async () => {
    const root = await project({ 'note.txt': 'ok', '.env': 'SECRET=1', 'raw.bin': Buffer.from([0, 1, 2]), 'big.txt': 'x'.repeat(40) });
    await assert.rejects(renderPlaceholders('{{fs:../outside.txt}}', { root }), /вне рабочего каталога/);
    await assert.rejects(renderPlaceholders('{{fs:.env}}', { root }), /секрет/i);
    await assert.rejects(renderPlaceholders('{{fs:raw.bin}}', { root }), /бинарный/);
    await assert.rejects(renderPlaceholders('{{fs:big.txt}}', { root, maxBytes: 8 }), /больше лимита/);
    await assert.rejects(renderPlaceholders('{{fs:nope.txt}}', { root }), /не найден/);
});

test('expandConfigStrings walks objects and arrays but leaves task placeholders', async () => {
    const root = await project({ 'note.txt': 'hello' });
    const out = await expandConfigStrings({
        a: '{{env:X}}', list: ['{{fs:note.txt}}'], n: 1,
        nested: { prompt: '{{task:PROMPT}}' },
    }, { env: { X: '1' }, root });
    assert.deepEqual(out, {
        a: '1', list: ['hello'], n: 1,
        nested: { prompt: '{{task:PROMPT}}' },
    });
});

// ── configuration ──────────────────────────────────────────────────────────

test('loadConfig expands env and fs in every string, including backends', async () => {
    const root = await project({ 'rules.md': 'Be brief.\n' });
    const config = await loadConfig({
        env: { AI_AGENT_HOME: root, AI_MODEL: 'gpt-6-luna', HOST: 'api.example.test', KEY: 'sk-from-env', RULES: 'Be brief.' },
        overrides: {
            baseURL: 'https://{{env:HOST}}/v1',
            roles: { coder: { instructions: '{{env:RULES}} {{fs:rules.md}}' } },
            backends: [{ baseUrl: 'https://{{env:HOST}}/v1', apiKey: '{{env:KEY}}' }],
        },
        ensureHome: false, cwd: root,
    });
    assert.equal(config.baseURL, 'https://api.example.test/v1');
    assert.equal(config.apiKey, 'sk-from-env');
    assert.equal(config.backends[0].baseURL, 'https://api.example.test/v1');
    assert.equal(config.roles.coder.instructions, 'Be brief. Be brief.\n');
});

test('the task template expands env and fs before the run', async () => {
    const root = await project({ 'rules.md': 'Rule one.' });
    setLiveEnv({ WHO: 'team' });
    const result = await prepareTeamInvocation({
        positionals: ['Hello {{env:WHO}}: {{fs:rules.md}}'], values: {}, cwd: root,
    });
    assert.equal(result.task, 'Hello team: Rule one.');
});

// ── role instructions ──────────────────────────────────────────────────────

test('role instructions see the outer task, the delegated task, and env', async () => {
    const root = await project({ 'note.txt': 'file text' });
    setLiveEnv({ ROLE_ENV: 'live' });
    const config = structuredClone(defaults);
    config.model = 'gpt-6-luna';
    config.roles.coder.instructions = 'Outer={{task:PROMPT}}; Sub={{delegated:PROMPT}}; Env={{env:ROLE_ENV}}; File={{fs:note.txt}}';
    let body = null;
    const client = {
        responses: {
            create: async (request) => {
                body = request;
                return {
                    id: 'resp_1', status: 'completed',
                    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
                    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                };
            },
        },
        close: () => {},
    };
    const roles = createRoleRunner({ client, config, ledger: createLedger(), root, task: 'outer work' });
    const result = await roles.run('coder', { text: 'do {{env:ROLE_ENV}}', delegated: 'sub work' });
    assert.equal(result.status, 'completed', result.error?.message);
    assert.match(body.instructions, /Outer=outer work; Sub=sub work; Env=live; File=file text/);
    assert.match(JSON.stringify(body.input), /do live/);
});
