import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE } from '../src/openai/sse.js';

async function* chunks(parts) { for (const part of parts) yield Buffer.from(part, 'utf8'); }
async function collect(source, limits) { const out = []; for await (const e of parseSSE(source, limits)) out.push(e); return out; }

test('parses events split across arbitrary chunk boundaries (including inside UTF-8)', async () => {
    const payload = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"При"}\n\n';
    const bytes = Buffer.from(payload, 'utf8');
    const parts = [bytes.subarray(0, 30), bytes.subarray(30, 75), bytes.subarray(75)];
    const events = [];
    for await (const e of parseSSE((async function* () { for (const p of parts) yield p; })())) events.push(e);
    assert.equal(events.length, 1);
    assert.equal(events[0].delta, 'При');
});

test('handles CRLF line endings, comments, multi-line data and [DONE]', async () => {
    const text = ': keep-alive\r\n' +
        'data: {"type":"a",\r\ndata: "x":1}\r\n\r\n' +
        'event: b\r\ndata: {"type":"b"}\r\n\r\n' +
        'data: [DONE]\r\n\r\n';
    const events = await collect(chunks([text]));
    assert.deepEqual(events.map((e) => e.type), ['a', 'b', '__done']);
    assert.equal(events[0].x, 1);
});

test('yields a final event without trailing blank line', async () => {
    const events = await collect(chunks(['data: {"type":"last"}']));
    assert.deepEqual(events.map((e) => e.type), ['last']);
});

test('rejects invalid JSON and mismatching event names', async () => {
    await assert.rejects(collect(chunks(['data: {oops}\n\n'])), /JSON/);
    await assert.rejects(collect(chunks(['event: foo\ndata: {"type":"bar"}\n\n'])), /не совпадает/);
});

test('enforces byte limits', async () => {
    await assert.rejects(collect(chunks([`data: {"type":"x","v":"${'a'.repeat(100)}"}\n\n`]), { maxEventBytes: 50 }), /лимит/);
});
