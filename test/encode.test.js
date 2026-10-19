import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { encodeArtifacts } from '../src/encode/encode.ts';

async function rootFor() {
    return mkdtemp(path.join(os.tmpdir(), 'ai-encode-'));
}

test('encode writes one hinted artifact and rejects a bad hint before writing', async () => {
    const root = await rootFor();
    const disk = new Map();
    const writeFile = async (file, content) => { disk.set(file, content); };
    try {
        const ok = await encodeArtifacts({
            root, text: 'answer', workspace: '', directoryTree: '.',
            artifacts: [{ id: 'a001', body: 'hello\n', hintLanguage: 'js', hintPath: 'src/a.js' }],
            writeFile,
        });
        assert.deepEqual(ok.written, ['src/a.js']);
        assert.equal(disk.get('src/a.js'), 'hello\n');
        disk.clear();
        await assert.rejects(encodeArtifacts({
            root, text: '', workspace: '', directoryTree: '.',
            artifacts: [{ id: 'a001', body: 'x', hintLanguage: null, hintPath: null }],
            writeFile,
        }));
        await assert.rejects(encodeArtifacts({
            root, text: '', workspace: '', directoryTree: '.',
            artifacts: [{ id: 'a001', body: 'x', hintLanguage: null, hintPath: '../out.js' }],
            writeFile,
        }));
        assert.equal(disk.size, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('encode keeps an earlier file when a later write throws and does not return written', async () => {
    const root = await rootFor();
    let calls = 0;
    const writeFile = async (file, content) => {
        calls += 1;
        if (calls === 2) throw new Error('holder refused');
        await import('node:fs/promises').then((fs) => fs.writeFile(path.join(root, file), content));
    };
    try {
        await assert.rejects(encodeArtifacts({
            root, text: '', workspace: '', directoryTree: '.',
            artifacts: [
                { id: 'a001', body: 'one', hintLanguage: null, hintPath: 'one.txt' },
                { id: 'a002', body: 'two', hintLanguage: null, hintPath: 'two.txt' },
            ],
            writeFile,
        }), /holder refused/);
        assert.equal(await readFile(path.join(root, 'one.txt'), 'utf8'), 'one');
        assert.equal(await stat(path.join(root, 'two.txt')).catch(() => null), null);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('encode sends the write to the provided holder', async () => {
    const root = await rootFor();
    const seen = [];
    try {
        const result = await encodeArtifacts({
            root, text: 't', workspace: 'scan', directoryTree: 'tree',
            artifacts: [{ id: 'a001', body: 'body', hintLanguage: 'md', hintPath: 'note.md' }],
            writeFile: async (file, content) => { seen.push([file, content]); },
        });
        assert.deepEqual(result.written, ['note.md']);
        assert.deepEqual(seen, [['note.md', 'body']]);
        assert.equal(await stat(path.join(root, 'note.md')).catch(() => null), null);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
