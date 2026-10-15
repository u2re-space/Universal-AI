import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ahkString, scriptFor, wrapScript } from '../src/interact/filesystem.js';

const base = { type: 'click', mode: 'coord', x: 10, y: 20, button: 'Left', clicks: 1, text: null, title: null, control: null, image: null, script: null };

test('ahkString escapes quotes and newlines', () => {
  assert.equal(ahkString('a"b'), '"a`"b"');
  assert.match(ahkString('a\nb'), /`n/);
});

test('coord click and wrap include v2 and a screenshot call', () => {
  const wrapped = wrapScript(scriptFor(base));
  assert.match(wrapped, /#Requires AutoHotkey v2\.0/);
  assert.match(wrapped, /Click\(10, 20, "Left", 1\)/);
  assert.match(wrapped, /SaveScreenshot\(shotPath\)/);
  assert.match(wrapped, /557CF406/);
});

test('type, title, and image bodies', () => {
  assert.match(scriptFor({ ...base, type: 'type', mode: 'text', text: 'hi' }), /SendText\("hi"\)/);
  assert.match(scriptFor({ ...base, type: 'type', mode: 'keys', text: '^s' }), /Send\("\^s"\)/);
  assert.match(scriptFor({ ...base, mode: 'title', title: 'Note"pad', x: null, y: null }), /WinActivate\("Note`"pad"\)/);
  assert.match(scriptFor({ ...base, mode: 'image', image: 'C:\\btn.png' }), /ImageSearch\(/);
});
