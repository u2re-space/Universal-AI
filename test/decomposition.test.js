import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { collectSubReferences, attachSubReferences, decompositionReport } from '../src/agent/decomposition.js';
import { DECOMPOSER_SCHEMA } from '../src/agent/schemas.js';
import { createToolset } from '../src/agent/tools.js';
import { defaults } from '../src/core/config.js';
import { TINY_PNG } from './helpers/mock-server.js';

const png = () => Buffer.from(TINY_PNG, 'base64');

async function rootFor(name) {
    return mkdtemp(path.join(os.tmpdir(), `ai-decomp-${name}-`));
}

test('decomposition: only the sub-references that really exist reach the measurer', async () => {
    const root = await rootFor('collect');
    const workId = 'w1';
    try {
        await mkdir(path.join(root, '.tmp', workId, 'decomposition'), { recursive: true });
        await writeFile(path.join(root, '.tmp', workId, 'decomposition', '01-home.png'), png());
        await writeFile(path.join(root, '.tmp', workId, 'decomposition', '02-card.png'), png());
        const decomposition = {
            summary: 'two screens',
            screens: [
                { name: 'Home', source: 'mock.png', subReference: `.tmp/${workId}/decomposition/01-home.png`, subReferenceKind: 'restored' },
                { name: 'Card', source: 'mock.png', subReference: `.tmp/${workId}/decomposition/02-card.png`, subReferenceKind: 'crop' },
                { name: 'Ghost', source: 'mock.png', subReference: `.tmp/${workId}/decomposition/03-ghost.png`, subReferenceKind: 'crop' },
            ],
            subReferences: [
                { path: `.tmp/${workId}/decomposition/01-home.png`, screen: 'Home', kind: 'restored', source: 'mock.png', note: 'перспектива снята' },
                { path: '../outside.png', screen: 'Home', kind: 'crop', source: 'mock.png', note: '' },
            ],
            notes: [],
        };
        const collected = await collectSubReferences({ root, workId, decomposition, maxBytes: 1024 * 1024 });
        assert.deepEqual(collected.files.map((file) => [file.rel, file.kind]), [
            [`.tmp/${workId}/decomposition/01-home.png`, 'restored'],
            [`.tmp/${workId}/decomposition/02-card.png`, 'crop'],
        ]);
        assert.equal(collected.files[0].screen, 'Home');
        assert.match(collected.warnings.join('\n'), /03-ghost\.png/);
        assert.match(collected.warnings.join('\n'), /вне рабочего каталога/);

        const attached = await attachSubReferences({ root, files: collected.files, maxBytes: 1024 * 1024 });
        assert.equal(attached.parts.length, 2);
        assert.equal(attached.warnings.length, 0);
        assert.match(attached.parts[0].image_url, /^data:image\/png;base64,/);

        const report = decompositionReport(decomposition, collected.files, `.tmp/${workId}`);
        assert.match(report, /Screen sub-references|Sub-references produced \(2\)/);
        assert.match(report, /01-home\.png \[restored\]/);
        assert.match(report, /Home/);
        assert.match(report, /\.tmp\/w1\/decomposition\.json|decomposition\//);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('decomposition: a sub-reference outside the work directory is kept but flagged', async () => {
    const root = await rootFor('outside');
    try {
        await mkdir(path.join(root, 'assets'), { recursive: true });
        await writeFile(path.join(root, 'assets', 'screen.png'), png());
        const { files, warnings } = await collectSubReferences({
            root, workId: 'w2',
            decomposition: { screens: [{ name: 'S', subReference: 'assets/screen.png' }], subReferences: [] },
        });
        assert.equal(files.length, 1);
        assert.match(warnings.join('\n'), /вне \.tmp\/w2\/decomposition\//);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('decomposition: the schema makes every produced image name its kind', () => {
    const screen = DECOMPOSER_SCHEMA.properties.screens.items;
    assert.ok(screen.required.includes('subReference'), 'screens carry a sub-reference field');
    assert.ok(screen.required.includes('subReferenceKind'), 'and how it was produced');
    assert.deepEqual(screen.properties.subReferenceKind.enum, ['', 'crop', 'split', 'restored', 'regenerated', 'figma-export']);
    const list = DECOMPOSER_SCHEMA.properties.subReferences;
    assert.equal(list.items.required.join(','), 'path,screen,kind,source,note');
    assert.ok(list.items.properties.kind.enum.includes('restored'));
});

test('decomposition: a read-access stage may generate only inside .tmp', async () => {
    const root = await rootFor('guard');
    const client = { images: { generate: async () => [TINY_PNG], edit: async () => [TINY_PNG] } };
    const toolset = createToolset({
        root, client, config: defaults, approvalLevel: 'read',
        names: ['generate_image', 'edit_image', 'crop_image'],
        allowWrite: ['crop_image', 'generate_image', 'edit_image'],
    });
    try {
        await writeFile(path.join(root, 'src.png'), png());
        const outside = await toolset.execute({
            name: 'generate_image', call_id: 'g1',
            arguments: JSON.stringify({ prompt: 'p', path: 'assets/screen.png', size: '', quality: '', reference: '', extra_images: '', background: '', to_svg: false }),
        });
        assert.equal(outside.ok, false);
        assert.match(outside.output, /только в \.tmp/);

        const unnamed = await toolset.execute({
            name: 'edit_image', call_id: 'g2',
            arguments: JSON.stringify({ prompt: 'flat front view', image: 'src.png', path: '', size: '', background: '', extra_images: '', to_svg: false }),
        });
        assert.equal(unnamed.ok, false);
        assert.match(unnamed.output, /path внутри \.tmp/);

        const inside = await toolset.execute({
            name: 'generate_image', call_id: 'g3',
            arguments: JSON.stringify({ prompt: 'p', path: '.tmp/w3/decomposition/01-home.png', size: '', quality: '', reference: '', extra_images: '', background: '', to_svg: false }),
        });
        assert.equal(inside.ok, true, inside.output);
        assert.match(inside.output, /\.tmp\/w3\/decomposition\/01-home\.png/);
        assert.ok((await readFile(path.join(root, '.tmp', 'w3', 'decomposition', '01-home.png'))).length);

        const written = await toolset.execute({
            name: 'crop_image', call_id: 'g4',
            arguments: JSON.stringify({ path: 'src.png', x: 0, y: 0, width: 4, height: 4, trim: false, output: 'assets/crop.png', reason: 'r' }),
        });
        assert.equal(written.ok, false);
        assert.match(written.output, /только в \.tmp/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
