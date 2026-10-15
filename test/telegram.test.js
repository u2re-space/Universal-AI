import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTelegram } from '../src/telegram/client.js';
import { nextOffset, pollOnce } from '../src/telegram/poll.js';

test('nextOffset steps past the highest update id', () => {
    assert.equal(nextOffset([{ update_id: 4 }, { update_id: 5 }, { foo: 1 }], 0), 6);
    assert.equal(nextOffset([], 3), 3);
});

test('the bot client posts to /bot<token>/<method> and does not echo the token in a network error', async () => {
    const seen = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        seen.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        const method = req.url.split('/').at(-1);
        const payload = JSON.stringify(method === 'getMe' ? { ok: true, result: { id: 1, username: 'shop' } } : { ok: true, result: { message_id: 11 } });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
        res.end(payload);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const token = '123456:TESTTOKEN';
    const bot = createTelegram({ token, baseURL: `http://127.0.0.1:${port}` });
    try {
        const me = await bot.getMe();
        assert.equal(me.username, 'shop');
        const sent = await bot.sendMessage({ chatId: -100, text: 'привет', threadId: 4, replyTo: 8 });
        assert.equal(sent.message_id, 11);
        assert.equal(seen[0].path, `/bot${token}/getMe`);
        assert.deepEqual(seen[1].body, { chat_id: -100, text: 'привет', message_thread_id: 4, reply_parameters: { message_id: 8 } });
        const updates = [];
        const offset = await pollOnce({
            telegram: {
                async getUpdates() { return [{ update_id: 1, message: { text: 'a' } }]; },
            },
            offset: 0,
            onUpdate: async (update) => updates.push(update.update_id),
        });
        assert.deepEqual(updates, [1]);
        assert.equal(offset, 2);
        const dead = createTelegram({ token, baseURL: 'http://127.0.0.1:1', connectTimeoutMs: 300 });
        try {
            await assert.rejects(() => dead.getMe(), (error) => !String(error.message).includes(token));
        } finally { dead.close(); }
    } finally {
        bot.close();
        await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
    }
});

test('a refused bot method is not called', async () => {
    const bot = createTelegram({ token: '123456:TESTTOKEN', baseURL: 'https://api.telegram.org' });
    try {
        await assert.rejects(() => bot.call('setWebhook', { url: 'https://example.test' }), /недоступен/);
    } finally {
        bot.close();
    }
});
