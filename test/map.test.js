import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm, stat, utimes } from 'node:fs/promises';
import { buildProjectMap, loadProjectMap, updateProjectMapPath, projectMapFile } from '../src/agent/map.js';

test('project map', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-map-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  await t.test('build indexes source symbols and imports, and skips binary files and node_modules', async () => {
    await mkdir(path.join(root, 'util'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(root, 'util', 'text.js'), 'export function clip() {}\n');
    await writeFile(path.join(root, 'lib.js'), "import { clip } from './util/text.js';\nexport function hello() {}\n");
    await writeFile(path.join(root, 'widget.py'), 'class Widget:\n    pass\n');
    await writeFile(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
    await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'function hidden() {}\n');
    const built = await buildProjectMap(root);
    assert.equal(built.files.has('lib.js'), true);
    assert.equal(built.files.has('widget.py'), true);
    assert.equal(built.files.has('blob.bin'), false);
    assert.equal(built.files.has('node_modules/pkg/index.js'), false);
    assert.deepEqual(built.files.get('lib.js').imports, ['util/text.js']);
    assert.ok(built.files.get('lib.js').symbols.some((symbol) => symbol.name === 'hello' && symbol.kind === 'export'));
    assert.ok(built.files.get('widget.py').symbols.some((symbol) => symbol.name === 'Widget' && symbol.kind === 'class'));
  });

  await t.test('a second load with the same modification time does not observe a rewritten map file', async () => {
    const first = await loadProjectMap(root);
    assert.equal(first.files.has('lib.js'), true);
    const file = projectMapFile(root);
    const before = await stat(file);
    await writeFile(file, '{"version":1,"builtAt":"x","files":{}}\n');
    await utimes(file, before.atime, before.mtime);
    const second = await loadProjectMap(root);
    assert.equal(second.files.has('lib.js'), true);
    assert.equal(second, first);
  });

  await t.test('updateProjectMapPath replaces one file and keeps the others', async () => {
    await writeFile(path.join(root, 'lib.js'), "import { clip } from './util/text.js';\nexport function goodbye() {}\n");
    await updateProjectMapPath(root, 'lib.js');
    const loaded = await loadProjectMap(root);
    assert.ok(loaded.files.get('lib.js').symbols.some((symbol) => symbol.name === 'goodbye'));
    assert.equal(loaded.files.get('lib.js').symbols.some((symbol) => symbol.name === 'hello'), false);
    assert.equal(loaded.files.has('widget.py'), true);
  });
});
