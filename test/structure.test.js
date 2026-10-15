import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { structureText } from '../src/structure/structure.js';
import { startCompletionServer } from '../src/complete/server.js';
import { createToolset } from '../src/agent/tools.js';
import { defaults } from '../src/core/config.js';

let work;
let endpoint;

before(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), 'ai-structure-'));
    endpoint = await startCompletionServer({
        port: 0,
        token: 'structure-token',
        structure: async (request) => structureText(request.content ?? '', request),
    });
});
after(async () => {
    await endpoint?.close();
    await rm(work, { recursive: true, force: true });
});

test('sort-imports groups modules and sorts names inside a brace list', () => {
    const source = [
        'import { b, a } from "./local";',
        'import "side-effect";',
        'import { z } from "zod";',
        'import { x } from "@/app";',
        '',
        'export const kept = 1;',
    ].join('\n');
    const result = structureText(source, { language: 'ts', tasks: ['sort-imports'] });
    assert.match(result.text, /import "side-effect";\n\nimport \{ z \} from "zod";\n\nimport \{ x \} from "@\/app";\n\nimport \{ a, b \} from "\.\/local";/);
    assert.match(result.text, /export const kept = 1;/);
});

test('scss tasks dedupe, merge, group selectors, and group properties', () => {
    const source = [
        '.btn {',
        '  color: red;',
        '  color: blue;',
        '  margin: 1px;',
        '  display: block;',
        '}',
        '.btn { padding: 2px; }',
        '.b { color: red; }',
        '.a { color: red; }',
    ].join('\n');
    const result = structureText(source, { language: 'scss', tasks: ['dedupe', 'merge', 'group-selectors', 'group-properties'] });
    assert.equal(result.text.includes('color: red'), true);
    assert.match(result.text, /\.btn \{[^}]*display: block;[^}]*margin: 1px;[^}]*padding: 2px;[^}]*color: blue;/s);
    assert.match(result.text, /\.a, \.b \{/);
    assert.equal((result.text.match(/color: red/g) ?? []).length, 1);
});

test('layers follow user rules and a selection edits only that range', () => {
    const source = 'keep\nbody { margin: 0; }\n.btn { color: red; }\nstay';
    const whole = structureText('body { margin: 0; }\n.btn { color: red; }\n', {
        language: 'css',
        tasks: ['layers'],
        rules: { layers: ['base', 'components'], layerMatch: [{ layer: 'base', pattern: '^body\\b' }, { layer: 'components', pattern: '^\\.btn' }] },
    });
    assert.match(whole.text, /@layer base, components;/);
    assert.match(whole.text, /@layer base \{\n  body \{/);
    assert.match(whole.text, /@layer components \{\n  \.btn \{/);
    const inline = structureText(source, {
        language: 'css',
        tasks: ['sort-lines'],
        selection: { start: { line: 1, character: 0 }, end: { line: 3, character: 0 } },
    });
    assert.match(inline.text, /^keep\n/);
    assert.match(inline.text, /stay$/);
    assert.equal(inline.text.includes('body'), true);
});

test('POST /v1/structure and a structure websocket frame return the edit', async () => {
    const body = JSON.stringify({
        id: 's1', language: 'ts', tasks: ['sort-imports'],
        content: 'import { b, a } from "lib";\n',
    });
    const denied = await fetch(endpoint.structureURL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(denied.status, 401);
    const accepted = await fetch(endpoint.structureURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer structure-token' },
        body,
    });
    const json = await accepted.json();
    assert.equal(accepted.status, 200);
    assert.match(json.text, /import \{ a, b \} from "lib";/);
    const ws = new WebSocket(`${endpoint.wsURL.replace('/v1/complete', '/v1/structure')}?token=structure-token`);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const message = await new Promise((resolve, reject) => {
        ws.onmessage = (event) => resolve(JSON.parse(event.data));
        ws.onerror = reject;
        ws.send(JSON.stringify({ type: 'structure', id: 'w1', language: 'text', tasks: ['clean'], content: 'a   \n\n\n\nb' }));
    });
    ws.close();
    assert.equal(message.type, 'structured');
    assert.equal(message.id, 'w1');
    assert.equal(message.text, 'a\n\nb');
});

test('structure_file writes the restructured stylesheet', async () => {
    await writeFile(path.join(work, 'widget.scss'), '.b{color:red}.a{color:red}\n', 'utf8');
    const toolset = createToolset({
        root: work, config: defaults, names: ['structure_file'], approvalLevel: 'all', approve: async () => 'no',
    });
    const result = await toolset.execute({
        name: 'structure_file',
        arguments: JSON.stringify({
            path: 'widget.scss', language: 'scss', tasks: 'group-selectors', rules_json: '', prompt: '',
            selection_start_line: null, selection_start_character: null, selection_end_line: null, selection_end_character: null,
            write: true, reason: 'unify selectors',
        }),
    });
    assert.equal(result.ok, true);
    const written = await readFile(path.join(work, 'widget.scss'), 'utf8');
    assert.match(written, /\.a, \.b \{/);
});
