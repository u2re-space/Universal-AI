import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftTaskMap, filterTaskMap } from '../src/agent/task-map.js';

function projectMap(files) {
  return { files: new Map(Object.entries(files)) };
}

test('draft caps edit, read, and scan and sorts paths', () => {
  const files = {};
  const imports = [];
  for (let i = 1; i <= 13; i++) {
    const name = `edit/a${String(i).padStart(2, '0')}-alpha.js`;
    files[name] = { imports: [], symbols: [] };
  }
  for (let i = 0; i < 21; i++) {
    const name = `read/r${String(i).padStart(2, '0')}.js`;
    files[name] = { imports: [], symbols: [] };
    imports.push(name);
  }
  files['edit/a01-alpha.js'].imports = imports;
  for (let i = 0; i < 41; i++) files[`edit/s${String(i).padStart(2, '0')}.js`] = { imports: [], symbols: [] };
  const draft = draftTaskMap('touch alpha', projectMap(files));
  assert.equal(draft.edit.length, 12);
  assert.deepEqual(draft.edit.map((item) => item.path), [...draft.edit.map((item) => item.path)].sort());
  assert.equal(draft.read.length, 20);
  assert.equal(draft.scan.length, 40);
  assert.equal(draft.scan.every((item) => item.path.startsWith('edit/')), true);
});

test('filterTaskMap drops a path that is not in the map', () => {
  const map = projectMap({ 'src/a.js': { imports: [], symbols: [{ name: 'a', kind: 'function', line: 1 }] } });
  const marks = filterTaskMap([
    { path: 'src/a.js', role: 'read', reason: 'called' },
    { path: 'missing.js', role: 'edit', reason: 'nope' },
    { path: 'src/a.js', role: 'other', reason: 'bad' },
  ], map);
  assert.deepEqual(marks, [{ path: 'src/a.js', role: 'read', reason: 'called' }]);
});
