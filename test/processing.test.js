import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createToolset } from '../src/agent/tools.js';
import { buildProjectMap, loadProjectMap } from '../src/agent/map.js';
import { defaults } from '../src/core/config.js';
import { CancelledError } from '../src/openai/errors.js';

async function rootFor(name) {
    return mkdtemp(path.join(os.tmpdir(), `ai-proc-${name}-`));
}

test('processing: null uses Node and a host result does not touch the disk', async () => {
    const root = await rootFor('null');
    try {
        const local = createToolset({
            root, config: defaults, names: ['write_file'], approvalLevel: 'all',
            processTool: async () => null,
        });
        const written = await local.execute({
            name: 'write_file', call_id: 'c1',
            arguments: JSON.stringify({ path: 'note.txt', content: 'local\n', overwrite: true }),
        });
        assert.equal(written.ok, true);
        assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'local\n');
        const remote = createToolset({
            root, config: defaults, names: ['write_file'], approvalLevel: 'all', editPaths: () => new Set(),
            processTool: async () => ({ output: 'remote', summary: 'r', changes: [{ op: 'create', path: 'other.txt' }] }),
        });
        const hosted = await remote.execute({
            name: 'write_file', call_id: 'c2',
            arguments: JSON.stringify({ path: 'other.txt', content: 'nope\n', overwrite: true }),
        });
        assert.equal(hosted.output, 'remote');
        assert.equal(await stat(path.join(root, 'other.txt')).catch(() => null), null);
        assert.deepEqual(remote.stats().changes, [{ op: 'create', path: 'other.txt' }]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('processing: replace_text changes refresh the project map', async () => {
    const root = await rootFor('map');
    try {
        await writeFile(path.join(root, 'lib.js'), 'export function hello() {}\n');
        await buildProjectMap(root);
        const toolset = createToolset({
            root, config: defaults, names: ['replace_text'], approvalLevel: 'all',
            processTool: async () => {
                await writeFile(path.join(root, 'lib.js'), 'export function goodbye() {}\n');
                return { output: 'Изменён lib.js', summary: '~ lib.js', changes: [{ op: 'edit', path: './lib.js' }] };
            },
        });
        const result = await toolset.execute({
            name: 'replace_text', call_id: 'c1',
            arguments: JSON.stringify({ path: 'lib.js', search: 'hello', replacement: 'goodbye', all: false }),
        });
        assert.equal(result.output, 'Изменён lib.js');
        assert.deepEqual(toolset.stats().changes, [{ op: 'edit', path: 'lib.js' }]);
        const loaded = await loadProjectMap(root);
        assert.ok(loaded.files.get('lib.js').symbols.some((symbol) => symbol.name === 'goodbye'));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('processing: bad changes warn and read_file drops them', async () => {
    const root = await rootFor('warn');
    try {
        await writeFile(path.join(root, 'a.txt'), 'hello\n');
        const warnings = [];
        const edits = createToolset({
            root, config: defaults, names: ['replace_text'], approvalLevel: 'all', emit: (event) => warnings.push(event),
            processTool: async () => ({
                output: 'kept', summary: 's',
                changes: [{ op: 'nope', path: 'a.js' }, { op: 'edit', path: '../out.js' }, { op: 'edit', path: '.backup/a.js' }, { op: 'edit', path: 'b.js' }],
            }),
        });
        const edited = await edits.execute({
            name: 'replace_text', call_id: 'c1',
            arguments: JSON.stringify({ path: 'a.js', search: 'a', replacement: 'b', all: false }),
        });
        assert.equal(edited.output, 'kept');
        assert.deepEqual(edits.stats().changes, [{ op: 'edit', path: 'b.js' }]);
        assert.ok(warnings.some((event) => event.message === 'Некорректная запись changes.'));
        assert.ok(warnings.some((event) => /вне рабочего каталога/.test(event.message)));
        assert.ok(warnings.some((event) => event.message === 'Запись в .backup запрещена: .backup/a.js'));
        const many = Array.from({ length: 101 }, (_, index) => ({ op: 'edit', path: `f${index}.js` }));
        warnings.length = 0;
        const bulk = createToolset({
            root, config: defaults, names: ['delete_file'], approvalLevel: 'all', emit: (event) => warnings.push(event),
            processTool: async () => ({ output: 'bulk', summary: 'b', changes: many }),
        });
        await bulk.execute({ name: 'delete_file', call_id: 'c2', arguments: JSON.stringify({ path: 'a.txt' }) });
        assert.equal(bulk.stats().changes.length, 100);
        assert.ok(warnings.some((event) => event.message === 'changes содержит больше 100 записей.'));
        const reader = createToolset({
            root, config: defaults, names: ['read_file'], approvalLevel: 'all',
            processTool: async () => ({ output: 'host-read', summary: 'h', changes: [{ op: 'edit', path: 'a.txt' }] }),
        });
        const read = await reader.execute({
            name: 'read_file', call_id: 'c3',
            arguments: JSON.stringify({ path: 'a.txt', start_line: null, end_line: null }),
        });
        assert.equal(read.output, 'host-read');
        assert.deepEqual(reader.stats().changes, []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('processing: denial, cancellation, shell stats, and make_dir stay local', async () => {
    const root = await rootFor('gate');
    try {
        let calls = 0;
        const denied = createToolset({
            root, config: defaults, names: ['replace_text'], approvalLevel: 'ask', approve: async () => 'no',
            processTool: async () => { calls += 1; return { output: 'x', summary: 'y' }; },
        });
        const blocked = await denied.execute({
            name: 'replace_text', call_id: 'c1',
            arguments: JSON.stringify({ path: 'a.js', search: 'a', replacement: 'b', all: false }),
        });
        assert.equal(calls, 0);
        assert.equal(blocked.ok, false);
        const cancelled = createToolset({
            root, config: defaults, names: ['read_file'], approvalLevel: 'all',
            processTool: async () => { throw new CancelledError('stop'); },
        });
        await assert.rejects(
            cancelled.execute({ name: 'read_file', call_id: 'c2', arguments: JSON.stringify({ path: 'a.txt', start_line: null, end_line: null }) }),
            (error) => error instanceof CancelledError && error.message === 'stop',
        );
        const aborted = createToolset({
            root, config: defaults, names: ['read_file'], approvalLevel: 'all',
            processTool: async () => {
                const error = new Error('Отменено.');
                error.name = 'AbortError';
                throw error;
            },
        });
        await assert.rejects(
            aborted.execute({ name: 'read_file', call_id: 'c2b', arguments: JSON.stringify({ path: 'a.txt', start_line: null, end_line: null }) }),
            (error) => error instanceof CancelledError && error.message === 'Отменено.',
        );
        const broken = createToolset({
            root, config: defaults, names: ['read_file'], approvalLevel: 'all',
            processTool: async () => { throw new Error('boom'); },
        });
        const failed = await broken.execute({
            name: 'read_file', call_id: 'c3', arguments: JSON.stringify({ path: 'a.txt', start_line: null, end_line: null }),
        });
        assert.equal(failed.ok, false);
        assert.match(failed.output, /^Ошибка: boom/);
        const shell = createToolset({
            root, config: defaults, names: ['run_command'], approvalLevel: 'all',
            editPaths: () => new Set(),
            processTool: async () => ({ output: 'plain', summary: '0', changes: [{ op: 'edit', path: 'a.js' }] }),
        });
        const command = await shell.execute({
            name: 'run_command', call_id: 'c4',
            arguments: JSON.stringify({ command: 'echo hi', shell: '', cwd: null, timeout_seconds: null, reason: 'check' }),
        });
        assert.equal(command.output, 'plain');
        assert.deepEqual(shell.stats().commands, []);
        assert.deepEqual(shell.stats().changes, []);
        const dirs = createToolset({
            root, config: defaults, names: ['make_dir'], approvalLevel: 'all',
            processTool: async () => { calls += 1; return { output: 'no', summary: 'no' }; },
        });
        const made = await dirs.execute({ name: 'make_dir', call_id: 'c5', arguments: JSON.stringify({ path: 'sub' }) });
        assert.equal(made.ok, true);
        assert.equal(calls, 0);
        assert.equal((await stat(path.join(root, 'sub'))).isDirectory(), true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
