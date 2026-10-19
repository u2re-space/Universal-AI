import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessRegistry } from '../src/encode/registry.js';

function pair() {
    const frames = [];
    return { frames, send(frame) { frames.push(frame); }, close() {} };
}
const ids = () => { let n = 0; return () => `id${++n}`; };

test('a client claims write_file and the next call waits on that socket', async () => {
    const registry = createProcessRegistry({ createId: ids() });
    const owner = pair();
    const socket = registry.connect(owner);
    await registry.receive(socket, { type: 'hello' });
    await registry.receive(socket, { type: 'processing.claim', tools: ['write_file', 'read_file'] });
    assert.deepEqual(owner.frames.find((frame) => frame.type === 'processing.claimed').tools, ['write_file', 'read_file']);
    assert.equal(await registry.requestTool('run_command', { command: 'echo' }), null);
    const pending = registry.requestTool('write_file', { path: 'a.js', content: 'x' });
    const request = owner.frames.find((frame) => frame.type === 'tool.request');
    assert.equal(request.name, 'write_file');
    await registry.receive(socket, { type: 'tool.result', requestId: request.requestId, output: 'записан', summary: '+ a.js' });
    assert.deepEqual(await pending, { output: 'записан', summary: '+ a.js', changes: [] });
});

test('an empty claim releases names and a bad name changes nothing', async () => {
    const registry = createProcessRegistry({ createId: ids() });
    const owner = pair();
    const socket = registry.connect(owner);
    await registry.receive(socket, { type: 'hello' });
    await registry.receive(socket, { type: 'processing.claim', tools: ['read_file'] });
    await registry.receive(socket, { type: 'processing.claim', tools: ['nope'] });
    assert.equal(owner.frames.at(-1).code, 'bad_request');
    const pending = registry.requestTool('read_file', { path: 'a.js' });
    const request = owner.frames.find((frame) => frame.type === 'tool.request');
    await registry.receive(socket, { type: 'processing.claim', tools: [] });
    await registry.receive(socket, { type: 'tool.result', requestId: request.requestId, output: 'text', summary: 's' });
    assert.equal((await pending).output, 'text');
    assert.equal(await registry.requestTool('read_file', { path: 'b.js' }), null);
});

test('holder disconnect fails an in-flight call and returns the name to Node', async () => {
    const registry = createProcessRegistry({ createId: ids() });
    const owner = pair();
    const socket = registry.connect(owner);
    await registry.receive(socket, { type: 'hello' });
    await registry.receive(socket, { type: 'processing.claim', tools: ['write_file'] });
    const pending = registry.requestTool('write_file', { path: 'a.js', content: 'x' });
    registry.disconnect(socket);
    await assert.rejects(pending, { message: 'Держатель инструмента отключился.' });
    assert.equal(await registry.requestTool('write_file', { path: 'a.js', content: 'x' }), null);
});
