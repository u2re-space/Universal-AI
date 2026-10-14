import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm, stat, utimes } from 'node:fs/promises';
import { buildProjectMap, loadProjectMap, updateProjectMapPath, projectMapFile, searchMapped } from '../src/agent/map.js';
import { createToolset } from '../src/agent/tools.js';

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

  await t.test('deleting an imported file removes it from other files\' imports', async () => {
    await rm(path.join(root, 'util', 'text.js'));
    await updateProjectMapPath(root, 'util/text.js');
    const loaded = await loadProjectMap(root);
    assert.equal(loaded.files.has('util/text.js'), false);
    assert.equal(loaded.files.get('lib.js').imports.includes('util/text.js'), false);
    for (const record of loaded.files.values()) {
      for (const imported of record.imports) assert.equal(loaded.files.has(imported), true);
    }
  });

  await t.test('a content search skips a map path whose file is gone and still returns other hits', async () => {
    await rm(path.join(root, 'widget.py'));
    const projectMap = await loadProjectMap(root);
    const result = await searchMapped(projectMap, { query: 'goodbye', scope: 'content' });
    assert.match(result.text, /lib\.js:\d+:/);
  });

  await t.test('a file under .ssh is not indexed', async () => {
    await mkdir(path.join(root, '.ssh'), { recursive: true });
    await writeFile(path.join(root, '.ssh', 'config'), 'Host example\n');
    const built = await buildProjectMap(root);
    assert.equal(built.files.has('.ssh/config'), false);
  });

  await t.test('searchMapped answers path and symbol from RAM and content from the file', async () => {
    const projectMap = await loadProjectMap(root);
    const byPath = await searchMapped(projectMap, { query: 'lib.js', scope: 'path' });
    assert.match(byPath.text, /^lib\.js$/m);
    const bySymbol = await searchMapped(projectMap, { query: 'goodbye', scope: 'symbol' });
    assert.match(bySymbol.text, /lib\.js:\d+: export goodbye/);
    const byContent = await searchMapped(projectMap, { query: 'clip', scope: 'content' });
    assert.match(byContent.text, /lib\.js:\d+:/);
    const again = await searchMapped(projectMap, { query: 'clip', scope: 'content' });
    assert.equal(again.text, byContent.text);
  });

  await t.test('write_file updates the map entry for that path only', async () => {
    const prior = await loadProjectMap(root);
    if (!prior?.files.has('widget.py')) {
      await writeFile(path.join(root, 'widget.py'), 'class Widget:\n    pass\n');
      await updateProjectMapPath(root, 'widget.py');
    }
    const events = [];
    const toolset = createToolset({
      root, config: { limits: { maxFileWriteBytes: 1024 * 1024, maxFileReadBytes: 1024 * 1024, maxSearchResults: 20, maxListEntries: 50, maxCommandOutputBytes: 1000, commandTimeoutMs: 1000, maxFetchBytes: 1000, maxImageBytes: 1000 }, tools: { fs: true }, shell: null, image: {} },
      names: ['write_file'], approvalLevel: 'all', emit: (event) => events.push(event),
    });
    const written = await toolset.execute({ name: 'write_file', arguments: JSON.stringify({ path: 'fresh.js', content: 'export function fresh() {}\n', overwrite: true }) });
    assert.equal(written.ok !== false, true);
    const loaded = await loadProjectMap(root);
    assert.ok(loaded.files.get('fresh.js').symbols.some((symbol) => symbol.name === 'fresh'));
    assert.equal(loaded.files.has('widget.py'), true);
    assert.equal(events.some((event) => event.type === 'warning'), false);
  });
});
