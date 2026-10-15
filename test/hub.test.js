import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/server/hub.js';

function pair() {
    const frames = [];
    const transport = { frames, send(frame) { frames.push(frame); }, close(code) { this.code = code; } };
    return transport;
}

test('a wrong token is rejected and the socket is closed', async () => {
    const hub = createHub({ token: 'secret' });
    const transport = pair();
    const socket = hub.connect(transport);
    await hub.receive(socket, { type: 'hello', role: 'client', token: 'nope' });
    assert.equal(transport.frames[0].code, 'unauthorized');
    assert.equal(transport.code, 1008);
});

test('subscribers receive events, a non-owner cannot approve, and owner drop aborts the run', async () => {
    let started;
    const hub = createHub({
        token: 'secret',
        createId: (() => { let n = 0; return () => `id${++n}`; })(),
        onStart(run) { started = run; return new Promise(() => {}); },
    });
    const ownerT = pair();
    const watchT = pair();
    const owner = hub.connect(ownerT);
    const watch = hub.connect(watchT);
    await hub.receive(owner, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(watch, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(owner, { type: 'start', command: 'ask', prompt: 'hi', cwd: process.cwd(), tools: 'fs', effort: 'low' });
    const runId = started.id;
    await hub.receive(watch, { type: 'subscribe', runId });
    hub.publish(runId, { type: 'text.delta', text: 'a' });
    assert.ok(watchT.frames.some((frame) => frame.type === 'run.event' && frame.event.text === 'a'));
    const approval = hub.requestApproval(runId, { name: 'write_file', category: 'write', preview: 'p' });
    assert.ok(watchT.frames.some((frame) => frame.type === 'run.event' && frame.event.type === 'approval.pending'));
    assert.equal(watchT.frames.some((frame) => frame.type === 'approval.request'), false);
    await hub.receive(watch, { type: 'approve', requestId: 'id-missing' });
    const request = ownerT.frames.find((frame) => frame.type === 'approval.request');
    await hub.receive(watch, { type: 'approve', requestId: request.requestId, decision: 'yes' });
    assert.ok(watchT.frames.some((frame) => frame.code === 'bad_request'));
    assert.ok(watchT.frames.some((frame) => frame.code === 'not_owner'));
    hub.disconnect(owner);
    assert.equal(await approval, 'abort');
    assert.ok(watchT.frames.some((frame) => frame.type === 'run.ended' && frame.runId === runId && frame.status === 'cancelled' && frame.exitCode === 130));
});

test('ready lists a publisher run and the publisher is not echoed its own event', async () => {
    const hub = createHub({ token: 'secret', createId: () => 'pub1' });
    const pubT = pair();
    const clientT = pair();
    const pub = hub.connect(pubT);
    const client = hub.connect(clientT);
    await hub.receive(client, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(pub, { type: 'hello', role: 'publisher', token: 'secret', command: 'run', title: 'run x', cwd: process.cwd() });
    assert.equal(pubT.frames.find((frame) => frame.type === 'ready').runs[0].id, 'pub1');
    await hub.receive(client, { type: 'subscribe', runId: 'pub1' });
    await hub.receive(pub, { type: 'event', event: { type: 'stage.start', stage: 'plan' } });
    assert.ok(clientT.frames.some((frame) => frame.type === 'run.event' && frame.event.stage === 'plan'));
    assert.equal(pubT.frames.some((frame) => frame.type === 'run.event'), false);
    hub.disconnect(pub);
    assert.ok(clientT.frames.some((frame) => frame.type === 'run.ended' && frame.status === 'cancelled' && frame.exitCode === 130));
});

test('a start frame rejects a detached job and keeps an allowed extra field', async () => {
    const hub = createHub({ token: 'secret', onStart() { return new Promise(() => {}); } });
    const transport = pair();
    const socket = hub.connect(transport);
    await hub.receive(socket, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(socket, { type: 'start', command: 'ask', prompt: 'hi', detach: true });
    assert.equal(transport.frames.at(-1).code, 'invalid_start');
    assert.match(transport.frames.at(-1).message, /detach/);
});
