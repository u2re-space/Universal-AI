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

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAhk, performAction } from '../src/interact/filesystem.js';

const fakeAhk = fileURLToPath(new URL('./helpers/fake-ahk.js', import.meta.url));

test('findAhk uses an explicit path and rejects a missing file', async () => {
  await assert.rejects(findAhk({ ahkPath: path.join(os.tmpdir(), 'missing-ahk.exe'), env: {}, exists: async () => false }), /AutoHotkey v2/);
});

test('performAction runs the fake executable and records a screenshot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-desktop-'));
  try {
    const outcome = await performAction({
      root, executable: process.execPath, prefixArgs: [fakeAhk], shotAfterAction: true, timeoutMs: 10000,
      action: { type: 'click', mode: 'coord', x: 1, y: 2, button: 'Left', clicks: 1, text: null, title: null, control: null, image: null, script: null },
    });
    assert.equal(outcome.message, 'ok');
    assert.match(outcome.screenshotRel, /^\.ai\/desktop\/.+\.png$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
