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

function ids() {
    let n = 0;
    return () => `id${++n}`;
}

test('processing: start.processing claims before onStart and a bad list opens no run', async () => {
    let claimedBeforeStart = false;
    let starts = 0;
    let transport;
    const hub = createHub({
        token: 'secret', createId: ids(),
        onStart() {
            starts += 1;
            claimedBeforeStart = transport.frames.some((frame) => frame.type === 'processing.claimed');
            return new Promise(() => {});
        },
    });
    transport = pair();
    const socket = hub.connect(transport);
    await hub.receive(socket, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(socket, { type: 'start', command: 'ask', prompt: 'hi', cwd: process.cwd(), processing: ['nope', 'nope'] });
    assert.equal(transport.frames.at(-1).code, 'invalid_start');
    assert.match(transport.frames.at(-1).message, /Имя инструмента повторяется: nope/);
    await hub.receive(socket, { type: 'start', command: 'ask', prompt: 'hi', cwd: process.cwd(), processing: 'read_file' });
    assert.match(transport.frames.at(-1).message, /processing должен быть массивом/);
    await hub.receive(socket, { type: 'start', command: 'ask', prompt: 'hi', cwd: process.cwd(), processing: ['read_file', 'missing'] });
    assert.match(transport.frames.at(-1).message, /Инструмент недоступен для захвата: missing/);
    assert.equal(starts, 0);
    await hub.receive(socket, { type: 'start', command: 'ask', prompt: 'empty', cwd: process.cwd(), processing: [] });
    assert.equal(starts, 1);
    assert.equal(claimedBeforeStart, false);
    assert.equal(transport.frames.some((frame) => frame.type === 'processing.claimed'), false);
    await hub.receive(socket, { type: 'start', command: 'ask', prompt: 'hi', cwd: process.cwd(), processing: ['write_file', 'read_file'] });
    assert.equal(claimedBeforeStart, true);
    assert.equal(starts, 2);
    assert.deepEqual(transport.frames.find((frame) => frame.type === 'processing.claimed').tools, ['write_file', 'read_file']);
    const held = transport.frames.find((frame) => frame.type === 'run.event' && frame.event.type === 'processing.held');
    assert.deepEqual(held.event.tools, ['read_file', 'write_file']);
});

test('processing: claims replace a socket set, steal a name, and stay inside one run', async () => {
    const hub = createHub({ token: 'secret', createId: ids(), onStart() { return new Promise(() => {}); } });
    const ownerT = pair();
    const otherT = pair();
    const watchT = pair();
    const owner = hub.connect(ownerT);
    const other = hub.connect(otherT);
    const watch = hub.connect(watchT);
    await hub.receive(owner, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(other, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(watch, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(owner, { type: 'start', command: 'ask', prompt: 'one', cwd: process.cwd(), processing: ['read_file', 'write_file'] });
    await hub.receive(owner, { type: 'start', command: 'ask', prompt: 'two', cwd: process.cwd() });
    const runs = ownerT.frames.filter((frame) => frame.type === 'run.started').map((frame) => frame.run.id);
    await hub.receive(watch, { type: 'subscribe', runId: runs[1] });
    await hub.receive(other, { type: 'processing.claim', runId: runs[0], tools: ['read_file'] });
    assert.deepEqual(otherT.frames.find((frame) => frame.type === 'processing.claimed').tools, ['read_file']);
    assert.deepEqual(ownerT.frames.find((frame) => frame.type === 'processing.released').tools, ['read_file']);
    await hub.receive(owner, { type: 'processing.claim', runId: runs[0], tools: [] });
    assert.deepEqual(ownerT.frames.filter((frame) => frame.type === 'processing.claimed').at(-1).tools, []);
    const held = ownerT.frames.filter((frame) => frame.event?.type === 'processing.held').at(-1);
    assert.deepEqual(held.event.tools, ['read_file']);
    assert.equal(watchT.frames.some((frame) => frame.event?.type === 'processing.held'), false);
    const claimedCount = otherT.frames.filter((frame) => frame.type === 'processing.claimed').length;
    await hub.receive(other, { type: 'processing.claim', runId: runs[0], tools: ['read_file'] });
    assert.equal(otherT.frames.filter((frame) => frame.type === 'processing.claimed').length, claimedCount + 1);
    await hub.receive(other, { type: 'processing.claim', runId: runs[0], tools: ['read_file', 'read_file'] });
    assert.match(otherT.frames.at(-1).message, /Имя инструмента повторяется: read_file/);
    assert.deepEqual(ownerT.frames.filter((frame) => frame.event?.type === 'processing.held').at(-1).event.tools, ['read_file']);
    await hub.receive(other, { type: 'processing.claim', runId: 'missing', tools: ['read_file'] });
    assert.equal(otherT.frames.at(-1).code, 'unknown_run');
});

test('processing: a publisher may claim a client run but not its own terminal run', async () => {
    const hub = createHub({ token: 'secret', createId: ids(), onStart() { return new Promise(() => {}); } });
    const ownerT = pair();
    const pubT = pair();
    const owner = hub.connect(ownerT);
    const pub = hub.connect(pubT);
    await hub.receive(owner, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(pub, { type: 'hello', role: 'publisher', token: 'secret', command: 'run', title: 't', cwd: process.cwd() });
    await hub.receive(owner, { type: 'start', command: 'ask', prompt: 'hi', cwd: process.cwd() });
    const clientRun = ownerT.frames.find((frame) => frame.type === 'run.started' && frame.run.source === 'client').run.id;
    const terminalRun = pubT.frames.find((frame) => frame.type === 'run.started' && frame.run.source === 'terminal').run.id;
    await hub.receive(owner, { type: 'processing.claim', runId: terminalRun, tools: ['read_file'] });
    assert.equal(ownerT.frames.at(-1).code, 'bad_request');
    assert.equal(ownerT.frames.at(-1).message, 'Захват доступен только для клиентского запуска.');
    await hub.receive(pub, { type: 'processing.claim', runId: clientRun, tools: ['read_file'] });
    assert.deepEqual(pubT.frames.find((frame) => frame.type === 'processing.claimed').tools, ['read_file']);
    assert.equal(pubT.frames.some((frame) => frame.type === 'run.event' && frame.event?.type === 'processing.held'), false);
    assert.deepEqual(ownerT.frames.find((frame) => frame.event?.type === 'processing.held').event.tools, ['read_file']);
});

async function clientRun(hub) {
    const ownerT = pair();
    const owner = hub.connect(ownerT);
    await hub.receive(owner, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(owner, { type: 'start', command: 'ask', prompt: 'hi', cwd: process.cwd(), processing: ['read_file', 'write_file'] });
    const runId = ownerT.frames.find((frame) => frame.type === 'run.started').run.id;
    return { owner, ownerT, runId };
}

test('processing: tool.result returns output and a bad frame keeps waiting', async () => {
    const hub = createHub({ token: 'secret', createId: ids(), onStart() { return new Promise(() => {}); } });
    const { owner, ownerT, runId } = await clientRun(hub);
    assert.equal(await hub.requestTool(runId, 'delete_file', { path: 'a.js' }), null);
    const pending = hub.requestTool(runId, 'read_file', { path: 'a.js' });
    const request = ownerT.frames.find((frame) => frame.type === 'tool.request');
    assert.equal(request.name, 'read_file');
    assert.deepEqual(request.args, { path: 'a.js' });
    const watchT = pair();
    const watch = hub.connect(watchT);
    await hub.receive(watch, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(watch, { type: 'tool.result', requestId: request.requestId, output: 'stolen', summary: 's' });
    assert.equal(watchT.frames.at(-1).message, 'Этот requestId адресован другому сокету.');
    await hub.receive(owner, { type: 'approve', requestId: request.requestId, decision: 'yes' });
    assert.equal(ownerT.frames.at(-1).message, 'Неизвестный requestId.');
    await hub.receive(owner, { type: 'tool.result', requestId: request.requestId, error: 1 });
    assert.equal(ownerT.frames.at(-1).message, 'error должен быть строкой.');
    await hub.receive(owner, { type: 'tool.result', requestId: request.requestId, output: 1, summary: 's' });
    assert.equal(ownerT.frames.at(-1).message, 'output и summary должны быть строками.');
    await hub.receive(owner, { type: 'tool.result', requestId: request.requestId, error: '   ', output: 'text', summary: 'sum' });
    assert.deepEqual(await pending, { output: 'text', summary: 'sum', changes: [] });
    const failed = hub.requestTool(runId, 'read_file', { path: 'b.js' });
    const failRequest = ownerT.frames.filter((frame) => frame.type === 'tool.request').at(-1);
    await hub.receive(owner, { type: 'tool.result', requestId: failRequest.requestId, error: 'Файл не найден', output: 'ignored' });
    await assert.rejects(failed, { message: 'Файл не найден' });
    await hub.receive(owner, { type: 'tool.result', requestId: 'nope', output: 'x', summary: 'y' });
    assert.equal(ownerT.frames.at(-1).message, 'Неизвестный requestId.');
});

test('processing: an in-flight request stays on the old holder', async () => {
    const hub = createHub({ token: 'secret', createId: ids(), onStart() { return new Promise(() => {}); } });
    const { owner, ownerT, runId } = await clientRun(hub);
    const first = hub.requestTool(runId, 'read_file', { path: 'a.js' });
    const second = hub.requestTool(runId, 'read_file', { path: 'b.js' });
    const requests = ownerT.frames.filter((frame) => frame.type === 'tool.request');
    assert.equal(requests.length, 2);
    const otherT = pair();
    const other = hub.connect(otherT);
    await hub.receive(other, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(other, { type: 'processing.claim', runId, tools: ['read_file'] });
    await hub.receive(owner, { type: 'tool.result', requestId: requests[0].requestId, output: 'old', summary: 'o' });
    await hub.receive(owner, { type: 'tool.result', requestId: requests[1].requestId, output: 'old-2', summary: 'o2' });
    assert.equal((await first).output, 'old');
    assert.equal((await second).output, 'old-2');
    const third = hub.requestTool(runId, 'read_file', { path: 'c.js' });
    const moved = otherT.frames.find((frame) => frame.type === 'tool.request');
    assert.equal(moved.args.path, 'c.js');
    await hub.receive(other, { type: 'tool.result', requestId: moved.requestId, output: 'new', summary: 'n', changes: [{ op: 'edit', path: 'c.js' }] });
    assert.deepEqual(await third, { output: 'new', summary: 'n', changes: [{ op: 'edit', path: 'c.js' }] });
    const huge = Array.from({ length: 101 }, () => ({ op: 'edit', path: 'c.js' }));
    const fourth = hub.requestTool(runId, 'read_file', { path: 'd.js' });
    const hugeRequest = otherT.frames.filter((frame) => frame.type === 'tool.request').at(-1);
    await hub.receive(other, { type: 'tool.result', requestId: hugeRequest.requestId, output: 'x', summary: 'y', changes: huge });
    assert.match(otherT.frames.at(-1).message, /op create, overwrite, edit или delete/);
    await hub.receive(other, { type: 'tool.result', requestId: hugeRequest.requestId, output: 'x', summary: 'y' });
    assert.equal((await fourth).output, 'x');
});

test('processing: holder disconnect fails its calls, and owner disconnect cancels the run', async () => {
    const hub = createHub({ token: 'secret', createId: ids(), onStart() { return new Promise(() => {}); } });
    const ownerT = pair();
    const otherT = pair();
    const owner = hub.connect(ownerT);
    const other = hub.connect(otherT);
    await hub.receive(owner, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(other, { type: 'hello', role: 'client', token: 'secret' });
    await hub.receive(owner, { type: 'start', command: 'ask', prompt: 'owned', cwd: process.cwd(), processing: ['read_file'] });
    await hub.receive(other, { type: 'start', command: 'ask', prompt: 'other', cwd: process.cwd() });
    const ownedId = ownerT.frames.find((frame) => frame.type === 'run.started' && frame.run.title.startsWith('ask owned')).run.id;
    const otherId = otherT.frames.find((frame) => frame.type === 'run.started' && frame.run.title.startsWith('ask other')).run.id;
    await hub.receive(owner, { type: 'processing.claim', runId: otherId, tools: ['write_file'] });
    const ownedCall = hub.requestTool(ownedId, 'read_file', { path: 'a.js' });
    const otherCall = hub.requestTool(otherId, 'write_file', { path: 'b.js' });
    hub.disconnect(owner);
    await assert.rejects(ownedCall, { name: 'AbortError', message: 'Отменено.' });
    await assert.rejects(otherCall, { message: 'Держатель инструмента отключился.' });
    assert.equal(otherT.frames.some((frame) => frame.type === 'run.ended' && frame.runId === otherId), false);
    assert.equal(await hub.requestTool(otherId, 'write_file', { path: 'b.js' }), null);
    await assert.rejects(hub.requestTool('gone', 'read_file', {}), { message: 'Запуск не найден.' });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(hub.requestTool('gone', 'read_file', {}, controller.signal), { name: 'AbortError' });
});
