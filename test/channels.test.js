import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { ApiError } from '../src/openai/errors.js';
import { createClient } from '../src/openai/client.js';
import { defaults, loadConfig, redactConfig } from '../src/core/config.js';
import { overridesFrom } from '../src/commands/flags.js';
import { enabledToolNames, createToolset } from '../src/agent/tools.js';
import { questionsFor, validateQuestions } from '../src/channels/questions.js';
import { routeFlag, verdictFromAnswers, verdictFromModeration } from '../src/channels/verdict.js';
import { moderateText } from '../src/channels/moderate.js';
import { draftReply } from '../src/channels/reply.js';
import { handleInbound } from '../src/channels/handle.js';
import { startChannelServer } from '../src/channels/server.js';
import { normalizeUpdate } from '../src/telegram/update.js';
import { enforcementFor } from '../src/telegram/policy.js';

const thresholds = { reviewAt: 0.5, blockAt: 0.9 };

test('question packs validate and unknown names fail', () => {
    for (const name of ['community', 'support', 'smm', 'guard', 'route']) {
        const questions = validateQuestions(questionsFor(name));
        assert.ok(Object.keys(questions).length >= 2);
    }
    assert.equal(questionsFor('community').violation.type, 'noul');
    assert.throws(() => questionsFor('nope'), /Неизвестный набор/);
    assert.throws(() => validateQuestions({ bad: { type: 'maybe', instructions: 'x', criteria: {} } }), /noul, choice или score/);
});

test('thresholds hide spam, review a medium score, and keep self-harm for a person', () => {
    const hidden = verdictFromAnswers({ violation: { type: 'noul', noul: 0.96 }, spam: { type: 'noul', noul: 0.1 } }, thresholds);
    assert.equal(hidden.action, 'hide');
    assert.equal(hidden.top, 'violation');
    const review = verdictFromAnswers({ spam: { type: 'noul', noul: 0.62 } }, thresholds);
    assert.equal(review.action, 'review');
    const allow = verdictFromAnswers({ spam: { type: 'noul', noul: 0.2 } }, thresholds);
    assert.equal(allow.action, 'allow');
    const crisis = verdictFromAnswers({ self_harm: { type: 'noul', noul: 0.99 } }, thresholds);
    assert.equal(crisis.action, 'review');
    assert.equal(routeFlag({ next: { type: 'choice', choice: 'encode' }, risky: { type: 'noul', noul: 0.95 } }, { blockAt: 0.9 }), 'planner');
    assert.equal(routeFlag({ next: { type: 'choice', choice: 'encode' }, risky: { type: 'noul', noul: 0.1 } }), 'encoder');
});

test('omni moderation maps flagged scores and a missing route can fall back', () => {
    const verdict = verdictFromModeration({
        id: 'modr_1', model: 'omni-moderation-latest',
        results: [{ flagged: true, categories: { harassment: true }, category_scores: { harassment: 0.93, hate: 0.01 } }],
    }, thresholds);
    assert.equal(verdict.action, 'hide');
    assert.equal(verdict.source, 'moderations');
    assert.equal(verdict.top, 'harassment');
});

test('a hidden draft is not sent to the text model', async () => {
    let called = false;
    const reply = await draftReply({
        client: { responses: { create: async () => { called = true; return { output_text: 'no' }; } } },
        config: defaults, purpose: 'support', message: { text: 'верните деньги' }, decision: { action: 'hide' },
    });
    assert.equal(called, false);
    assert.equal(reply.skipped, true);
    assert.equal(reply.reason, 'hidden');
});

test('auto moderation uses decisions when /moderations is missing', async () => {
    const seen = [];
    const server = await listen(async (req, res, body) => {
        seen.push(req.url);
        if (req.url === '/v1/moderations') return json(res, 404, { error: { message: 'Not Found', code: 'not_found' } });
        assert.equal(body.model, 'openai/gpt-6-luna-decisions');
        assert.equal(body.state.preset, 'community');
        return json(res, 200, {
            id: 'gen-dec-1', model: body.model,
            answers: { violation: { type: 'noul', noul: 0.96 }, spam: { type: 'noul', noul: 0.05 } },
            usage: { input_tokens: 12, output_tokens: 3 },
        });
    });
    const client = createClient({ apiKey: 'sk-test', baseURL: server.baseURL, retries: 0 });
    try {
        const verdict = await moderateText({ client, input: 'купите подписчиков', config: defaults, preset: 'community' });
        assert.deepEqual(seen, ['/v1/moderations', '/v1/decisions']);
        assert.equal(verdict.action, 'hide');
        assert.equal(verdict.source, 'decisions');
        assert.equal(verdict.model, 'openai/gpt-6-luna-decisions');
    } finally {
        client.close();
        await server.close();
    }
});

test('moderations mode does not fall back', async () => {
    const server = await listen(async (req, res) => json(res, 404, { error: { message: 'Not Found', code: 'not_found' } }));
    const client = createClient({ apiKey: 'sk-test', baseURL: server.baseURL, retries: 0 });
    const config = structuredClone(defaults);
    config.moderation.mode = 'moderations';
    try {
        await assert.rejects(
            () => moderateText({ client, input: 'привет', config, preset: 'community' }),
            (error) => error instanceof ApiError && error.status === 404,
        );
    } finally {
        client.close();
        await server.close();
    }
});

test('channel HTTP and websocket return a moderation verdict', async () => {
    const client = fakeClient();
    const config = structuredClone(defaults);
    const server = await startChannelServer({ client, config, port: 0, token: 'channel-secret' });
    try {
        const denied = await fetch(`${server.httpURL}/v1/moderate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(denied.status, 401);
        const health = await fetch(`${server.httpURL}/health`);
        assert.equal((await health.json()).ok, true);
        const response = await fetch(`${server.httpURL}/v1/moderate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer channel-secret' },
            body: JSON.stringify({ input: 'привет группе', preset: 'community' }),
        });
        const body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.moderation.action, 'hide');
        assert.equal(body.moderation.source, 'decisions');
        const ws = new WebSocket(`${server.wsURL}?token=channel-secret`);
        const opened = new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true });
            ws.addEventListener('error', () => reject(new Error('websocket failed')), { once: true });
        });
        await opened;
        const message = new Promise((resolve) => ws.addEventListener('message', (event) => resolve(JSON.parse(String(event.data))), { once: true }));
        ws.send(JSON.stringify({ type: 'moderate', id: 'm1', input: 'привет группе', preset: 'community' }));
        const frame = await message;
        assert.equal(frame.type, 'result');
        assert.equal(frame.id, 'm1');
        assert.equal(frame.moderation.action, 'hide');
        ws.close();
    } finally {
        await server.close();
    }
});

test('a group hide deletes the message and a private chat gets a support draft', async () => {
    const calls = [];
    const telegram = {
        async call(method, body) { calls.push({ method, body }); return { ok: true }; },
        async sendMessage(args) { calls.push({ method: 'sendMessage', args }); return { message_id: 9 }; },
    };
    const config = structuredClone(defaults);
    config.telegram.reply = true;
    const hidden = await handleInbound({
        client: fakeClient(), config, telegram,
        message: { channel: 'telegram', kind: 'supergroup', chatId: -100, messageId: 4, threadId: 7, text: 'купите', title: 'Цех', from: { name: 'A' } },
    });
    assert.equal(hidden.moderation.action, 'hide');
    assert.equal(hidden.reply, null);
    assert.deepEqual(calls[0], { method: 'deleteMessage', body: { chat_id: -100, message_id: 4 } });
    calls.length = 0;
    const direct = await handleInbound({
        client: fakeClient(), config, telegram,
        message: { channel: 'telegram', kind: 'private', chatId: 5, messageId: 1, text: 'где заказ?', from: { name: 'Б' } },
    });
    assert.equal(direct.moderation.action, 'allow');
    assert.equal(direct.reply.text, 'Здравствуйте');
    assert.equal(direct.reply.sent, true);
    assert.equal(calls[0].method, 'sendMessage');
    assert.equal(enforcementFor({ kind: 'private', chatId: 5, messageId: 1 }, { action: 'hide' }), null);
});

test('normalizeUpdate keeps a forum topic and channel posts', () => {
    const message = normalizeUpdate({
        update_id: 3,
        message: { message_id: 8, message_thread_id: 15, date: 1, text: 'тема', chat: { id: -1, type: 'supergroup', title: 'Цех' }, from: { id: 2, first_name: 'Анна' } },
    });
    assert.equal(message.kind, 'supergroup');
    assert.equal(message.threadId, 15);
    assert.equal(message.from.name, 'Анна');
    const post = normalizeUpdate({ update_id: 4, channel_post: { message_id: 1, text: 'новость', chat: { id: -2, type: 'channel', title: 'Лента' } } });
    assert.equal(post.kind, 'channel');
    assert.equal(post.text, 'новость');
});

test('channel tools are off until enabled and moderate_text calls the API', async () => {
    assert.equal(enabledToolNames({ ...defaults.tools, channels: false }).includes('moderate_text'), false);
    assert.equal(overridesFrom({ tools: 'channels' }).tools.channels, true);
    assert.equal(overridesFrom({ tools: 'channels' }).tools.fs, false);
    assert.equal(overridesFrom({ 'no-tools': true }).tools.channels, false);
    const server = await listen(async (req, res, body) => {
        if (req.url === '/v1/moderations') return json(res, 404, { error: { message: 'Not Found' } });
        return json(res, 200, { id: 'gen-dec-2', model: body.model, answers: { spam: { type: 'noul', noul: 0.2 } }, usage: { input_tokens: 1, output_tokens: 1 } });
    });
    const client = createClient({ apiKey: 'sk-test', baseURL: server.baseURL, retries: 0 });
    const config = structuredClone(defaults);
    config.apiKey = 'sk-test';
    config.baseURL = server.baseURL;
    const toolset = createToolset({ root: os.tmpdir(), config, names: ['moderate_text'], approvalLevel: 'all', client });
    try {
        const result = await toolset.execute({ name: 'moderate_text', arguments: JSON.stringify({ text: 'добрый день', preset: 'community' }) });
        assert.equal(result.ok, true);
        assert.match(result.output, /"action":"allow"/);
    } finally {
        client.close();
        await server.close();
    }
});

test('config reads the decision model and hides the bot token', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-channels-'));
    try {
        const config = await loadConfig({
            ensureHome: true,
            env: {
                AI_AGENT_HOME: home, OPENAI_API_KEY: 'sk-test', AI_DECISION_MODEL: 'openai/gpt-6-luna-decisions',
                TELEGRAM_BOT_TOKEN: '123456:ABCDEF', AI_CHANNELS_TOKEN: 'channel-secret',
            },
        });
        assert.equal(config.decisions.model, 'openai/gpt-6-luna-decisions');
        assert.equal(config.telegram.token, '123456:ABCDEF');
        assert.equal(redactConfig(config).telegram.token, '…');
        assert.equal(redactConfig(config).channels.token, '…');
        assert.equal(JSON.stringify(redactConfig(config)).includes('123456:ABCDEF'), false);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

/**
 * Decision client used by the channel server tests. Moderations is missing; decisions flags a violation.
 * Support state gets a reply-needed answer instead.
 * @returns {object}
 */
function fakeClient() {
    return {
        async close() {},
        moderations: { create: async () => { throw new ApiError('OpenAI API: Not Found', { status: 404, code: 'HTTP_ERROR' }); } },
        decisions: {
            async create(body) {
                if (body.state?.preset === 'support') {
                    return { id: 'gen-support', model: body.model, answers: { needs_reply: { type: 'noul', noul: 0.92 }, handoff: { type: 'noul', noul: 0.05 } }, usage: { input_tokens: 2, output_tokens: 1 } };
                }
                return { id: 'gen-dec', model: body.model, answers: { violation: { type: 'noul', noul: 0.97 } }, usage: { input_tokens: 2, output_tokens: 1 } };
            },
        },
        responses: { create: async () => ({ id: 'resp_1', model: 'gpt-6.1-terra', output_text: 'Здравствуйте', usage: { input_tokens: 2, output_tokens: 2 } }) },
    };
}

/**
 * Local JSON server. handler(req, res, body) writes the response.
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: object|null) => void} handler
 * @returns {Promise<{ baseURL: string, close: () => Promise<void> }>}
 */
function listen(handler) {
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('utf8');
        await handler(req, res, raw ? JSON.parse(raw) : null);
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                baseURL: `http://127.0.0.1:${port}/v1`,
                close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done); }),
            });
        });
    });
}

/**
 * Write a JSON response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} body
 * @returns {void}
 */
function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
}
