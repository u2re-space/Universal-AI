import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { spillFences, stripRoute, chooseRoute, openHandoff, spillAnswer, seedTextFile, readDirectory, seedDirectory } from '../src/agent/handoff.js';
import { executeFileCommands, CommandBatchError, parseMention, collectMentions } from '../src/agent/file-commands.js';
import { applyTemplate, resolveKind, splitTeamPositionals, prepareTeamInvocation } from '../src/commands/team-args.js';
import { defaults } from '../src/core/config.js';

test('fences become extensionless artifacts and keep a nearby filename as a hint', () => {
    const spilled = spillFences('# Файл scan_add.comp\n\n```glsl\nvoid main() {}\n```\n');
    assert.equal(spilled.blocks.length, 1);
    assert.equal(spilled.blocks[0].id, 'a001');
    assert.equal(spilled.blocks[0].hintLanguage, 'glsl');
    assert.equal(spilled.blocks[0].hintPath, 'scan_add.comp');
    assert.equal(spilled.blocks[0].body, 'void main() {}');
    assert.match(spilled.text, /\[\[artifact a001\]\]/);
    assert.equal(spilled.text.includes('.glsl'), false);
});

test('route flag wins, then the label, then code; a broken label is ignored', () => {
    const broken = stripRoute('ответ\nroute: sideways');
    assert.equal(broken.label, null);
    assert.match(broken.text, /sideways/);
    const labeled = stripRoute('ответ\nroute: encode');
    assert.equal(labeled.label, 'encode');
    assert.equal(chooseRoute({ flag: 'planner', label: 'encode', artifacts: [{}] }), 'plan');
    assert.equal(chooseRoute({ label: 'encode', text: 'нет кода' }), 'encode');
    assert.equal(chooseRoute({ text: 'смотри `src/app.js`', artifacts: [] }), 'encode');
    assert.equal(chooseRoute({ text: labeled.text, artifacts: [] }), 'plan');
});

test('kind comes from the flag, the first word, or one word in the task', () => {
    assert.deepEqual(splitTeamPositionals(['landing', 'страница']), { kindToken: 'landing', task: 'страница' });
    assert.equal(resolveKind({ flag: 'site', token: null, task: 'исправь тест' }), 'site');
    assert.equal(resolveKind({ task: 'собери landing' }), 'landing');
    assert.equal(resolveKind({ task: 'landing и site' }), null);
    assert.equal(resolveKind({ task: 'исправь тест' }), null);
    assert.throws(() => resolveKind({ flag: 'site', token: 'landing', task: 'x' }), /не совпадает/);
});

test('a message template replaces, wraps, or is the whole task', () => {
    assert.equal(applyTemplate('Сделай {{message}} аккуратно', 'шейдер'), 'Сделай шейдер аккуратно');
    assert.equal(applyTemplate('Контекст', 'шейдер'), 'Контекст\n\nшейдер');
    assert.equal(applyTemplate('Только файл', ''), 'Только файл');
});

test('writes keep a .comp path beside language glsl and default a missing path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-handoff-'));
    try {
        const state = await openHandoff(root);
        const spilled = await spillAnswer(root, state, '```glsl\nvoid main() {}\n```\nroute: encode');
        assert.equal(spilled.label, 'encode');
        assert.equal(state.artifacts[0].hintLanguage, 'glsl');
        const source = state.artifacts[0].rel;
        assert.equal(source.endsWith('/a001'), true);
        const outcome = await executeFileCommands({
            root, state, approvalLevel: 'all', limits: defaults.limits,
            commands: [{
                command: 'fs:write', path: 'scan_add.comp', cwd: 'output', type: 'code', language: 'glsl',
                content: null, lines: null, source, start: null, end: null,
            }],
        });
        assert.equal(outcome.status, 'completed');
        assert.equal(await readFile(path.join(root, 'output', 'scan_add.comp'), 'utf8'), 'void main() {}');
        const unnamed = await executeFileCommands({
            root, state, approvalLevel: 'all', limits: defaults.limits,
            commands: [{
                command: 'fs:write', path: '', cwd: '.', type: 'code', language: '',
                content: null, lines: null, source, start: null, end: null,
            }],
        });
        assert.equal(unnamed.written[0], 'snippet-001.glsl');
        assert.equal(await stat(path.join(root, '.tmp', state.id)).then(() => true), true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a read range is stored without the rest of the file and a short fragment is inlined', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-handoff-read-'));
    try {
        await writeFile(path.join(root, 'note.txt'), 'alpha\nbeta\ngamma\n');
        const state = await openHandoff(root);
        await executeFileCommands({
            root, state, approvalLevel: 'read', limits: defaults.limits,
            commands: [{
                command: 'fs:read', path: 'note.txt', cwd: '.', type: 'text', language: 'text',
                content: null, lines: null, source: null, start: 2, end: 2,
            }],
        });
        const saved = await readFile(path.join(root, '.tmp', state.id, 'a001'), 'utf8');
        assert.equal(saved, 'beta');
        assert.match(state.text, /beta/);
        assert.equal(state.text.includes('alpha'), false);
        assert.equal(state.artifacts[0].start, 2);
        assert.equal(state.artifacts[0].end, 2);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a long fragment stays a reference and JSON mentions are followed once', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-handoff-json-'));
    try {
        const body = `${'x'.repeat(3000)}\n`;
        await writeFile(path.join(root, 'big.txt'), body);
        await mkdir(path.join(root, 'src'), { recursive: true });
        await writeFile(path.join(root, 'src', 'app.js'), 'one\ntwo\nthree\n');
        await writeFile(path.join(root, 'list.json'), JSON.stringify({ file: 'src/app.js#2-2', skip: 'https://example.com/a.js', escape: '../secret.txt' }));
        const state = await openHandoff(root);
        await executeFileCommands({
            root, state, approvalLevel: 'read', limits: defaults.limits,
            commands: [
                { command: 'fs:read', path: 'big.txt', cwd: '.', type: 'text', language: 'text', content: null, lines: null, source: null, start: null, end: null },
                { command: 'fs:read', path: 'list.json', cwd: '.', type: 'text', language: 'json', content: null, lines: null, source: null, start: null, end: null },
            ],
        });
        const big = state.artifacts.find((item) => item.origin === 'big.txt');
        assert.ok(big.bytes > 2048);
        assert.equal(state.text.includes('x'.repeat(100)), false);
        assert.match(state.text, /\[artifact a001\]/);
        const line = await readFile(path.join(root, '.tmp', state.id, state.artifacts.find((item) => item.origin === 'src/app.js').id), 'utf8');
        assert.equal(line, 'two');
        assert.equal(state.artifacts.some((item) => item.origin === 'secret.txt'), false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('shape errors write nothing and a denied write stops the rest', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-handoff-deny-'));
    try {
        const state = await openHandoff(root);
        await assert.rejects(() => executeFileCommands({
            root, state, approvalLevel: 'all', limits: defaults.limits,
            commands: [{ command: 'fs:write', path: 'a.txt', cwd: '.', type: 'text', language: 'text', content: 'a', lines: ['b'], source: null, start: null, end: null }],
        }), (error) => error instanceof CommandBatchError && error.fatal);
        assert.equal(await stat(path.join(root, 'a.txt')).then(() => true).catch(() => false), false);
        await assert.rejects(() => executeFileCommands({
            root, state, approvalLevel: 'all', limits: defaults.limits,
            commands: [{ command: 'fs:write', path: 'a.txt', cwd: '.', type: 'text', language: 'text', content: 'x'.repeat(2049), lines: null, source: null, start: null, end: null }],
        }), /2048/);
        const denied = await executeFileCommands({
            root, state, approvalLevel: 'ask', approve: async () => 'no', limits: defaults.limits,
            commands: [
                { command: 'fs:write', path: 'first.txt', cwd: '.', type: 'text', language: 'text', content: 'one', lines: null, source: null, start: null, end: null },
                { command: 'fs:write', path: 'second.txt', cwd: '.', type: 'text', language: 'text', content: 'two', lines: null, source: null, start: null, end: null },
            ],
        }).then(() => null, (error) => error);
        assert.ok(denied instanceof CommandBatchError);
        assert.equal(await stat(path.join(root, 'second.txt')).then(() => true).catch(() => false), false);
        await assert.rejects(() => executeFileCommands({
            root, state, approvalLevel: 'read', limits: defaults.limits,
            commands: [{ command: 'fs:read', path: 'missing.txt', cwd: '.', type: 'text', language: 'text', content: null, lines: null, source: null, start: null, end: null }],
        }), /не найден/);
        const readOk = await executeFileCommands({
            root, state, approvalLevel: 'read', limits: defaults.limits,
            commands: [{ command: 'fs:read', path: 'nope.txt', cwd: '.', type: 'text', language: '', content: null, lines: null, source: null, start: null, end: null }],
        }).catch((error) => error);
        assert.ok(readOk instanceof CommandBatchError);
        await assert.rejects(() => executeFileCommands({
            root, state, approvalLevel: 'read', limits: defaults.limits,
            commands: [{ command: 'fs:write', path: 'blocked.txt', cwd: '.', type: 'text', language: 'text', content: 'z', lines: null, source: null, start: null, end: null }],
        }), /политикой/);
        assert.equal(parseMention('../secret.txt'), null);
        const mentions = [];
        collectMentions({ nested: { file: 'src/app.js#10-20' } }, mentions);
        assert.deepEqual(mentions, [{ path: 'src/app.js', start: 10, end: 20 }]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a later write can copy an artifact created by an earlier read', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-handoff-copy-'));
    try {
        await writeFile(path.join(root, 'source.txt'), 'copied\n');
        const state = await openHandoff(root);
        const outcome = await executeFileCommands({
            root, state, approvalLevel: 'all', limits: defaults.limits,
            commands: [
                { command: 'fs:read', path: 'source.txt', cwd: '.', type: 'text', language: 'text', content: null, lines: null, source: null, start: null, end: null },
                { command: 'fs:write', path: 'copy.txt', cwd: '.', type: 'text', language: 'text', content: null, lines: null, source: `${state.relDir}/a001`, start: null, end: null },
            ],
        });
        assert.equal(outcome.written[0], 'copy.txt');
        assert.equal(await readFile(path.join(root, 'copy.txt'), 'utf8'), 'copied\n');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a directory is a nested tree or a flat list, and a seeded directory enters the handoff', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-handoff-tree-'));
    try {
        await mkdir(path.join(root, 'src', 'util'), { recursive: true });
        await writeFile(path.join(root, 'src', 'app.js'), 'export {}\n');
        await writeFile(path.join(root, 'src', 'util', 'text.js'), 'export {}\n');
        await writeFile(path.join(root, '.env'), 'SECRET=1\n');
        const tree = await readDirectory({ root, dir: 'src', depth: 3, mode: 'tree' });
        assert.match(tree.text, /^src\/\n {2}util\/\n {4}text\.js\n {2}app\.js$/);
        assert.equal(tree.text.includes('.env'), false);
        const flat = await readDirectory({ root, dir: 'src', depth: 3, mode: 'list' });
        assert.match(flat.text, /src\/util\/text\.js/);
        assert.equal(flat.text.includes('  '), false);
        const state = await openHandoff(root);
        const seeded = await seedDirectory({ root, state, file: 'src', depth: 3, mode: 'tree' });
        assert.equal(seeded.hintLanguage, 'tree');
        assert.equal(seeded.entries.some((item) => item.path === 'src/util/text.js' && item.type === 'file'), true);
        const listed = await executeFileCommands({
            root, state, approvalLevel: 'read', limits: defaults.limits,
            commands: [{ command: 'fs:list', path: 'src', cwd: '.', type: 'text', language: 'text', content: null, lines: null, source: null, start: null, end: null, depth: 3, mode: 'list' }],
        });
        assert.equal(listed.status, 'completed');
        assert.match(state.text, /src\/app\.js/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('prepareTeamInvocation reads a template and does not require a generation profile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-handoff-task-'));
    try {
        await writeFile(path.join(root, 'quest.md'), 'Исправь опечатку');
        await writeFile(path.join(root, 'wrap.md'), 'Сделай {{message}}');
        const whole = await prepareTeamInvocation({ positionals: [], values: { template: ['quest.md'] }, cwd: root, stdinText: '' });
        assert.equal(whole.task, 'Исправь опечатку');
        assert.equal(whole.kind, null);
        assert.equal(whole.wantsProfile, false);
        const wrapped = await prepareTeamInvocation({ positionals: ['шейдер'], values: { template: ['wrap.md'] }, cwd: root, stdinText: '' });
        assert.equal(wrapped.task, 'Сделай шейдер');
        await mkdir(path.join(root, 'dir'), { recursive: true });
        await assert.rejects(
            () => prepareTeamInvocation({ positionals: [], values: { template: ['dir'] }, cwd: root, stdinText: '' }),
            /--template/,
        );
        const seeded = await openHandoff(root);
        await writeFile(path.join(root, 'notes.md'), 'заметка');
        const artifact = await seedTextFile({ root, state: seeded, file: 'notes.md', maxBytes: 256 * 1024 });
        assert.equal(artifact.origin, 'notes.md');
        assert.match(seeded.text, /заметка/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
