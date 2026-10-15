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

import { parseBatch, executeBatch } from '../src/interact/batch.js';

test('parseBatch accepts TOON and rejects an unknown action', () => {
  const text = [
    'summary: click Save',
    'actions[1]{type,mode,x,y,button,clicks,text,title,control,image,script}:',
    '  click,coord,3,4,left,1,null,null,null,null,null',
  ].join('\n');
  const batch = parseBatch(text);
  assert.equal(batch.actions[0].x, 3);
  assert.equal(batch.actions[0].button, 'Left');
  assert.throws(() => parseBatch('{"summary":"x","actions":[{"type":"dance"}]}'), /type/);
});

test('executeBatch asks before each action and stops on denial', async () => {
  const seen = [];
  await assert.rejects(executeBatch({
    batch: { summary: 'two', actions: [
      { type: 'screenshot', mode: null, x: null, y: null, button: null, clicks: null, text: null, title: null, control: null, image: null, script: null },
      { type: 'click', mode: 'coord', x: 1, y: 1, button: 'left', clicks: 1, text: null, title: null, control: null, image: null, script: null },
    ] },
    approveAction: async (action) => action.type === 'screenshot',
    perform: async (action) => { seen.push(action.type); return { message: 'ok' }; },
  }), /отклонено/);
  assert.deepEqual(seen, ['screenshot']);
});

import { enabledToolNames, createToolset } from '../src/agent/tools.js';
import { defaults } from '../src/core/config.js';

test('desktop tools follow the exec approval gate', async () => {
  assert.equal(enabledToolNames({ ...defaults.tools, desktop: false }).includes('click'), false);
  const names = enabledToolNames({ ...defaults.tools, desktop: true });
  for (const name of ['screenshot', 'click', 'type', 'run_ahk', 'run_batch', 'delegate_role']) assert.equal(names.includes(name), true);
  const toolset = createToolset({
    root: os.tmpdir(), config: defaults, names: ['click'], approvalLevel: 'read', approve: async () => 'yes',
  });
  const denied = await toolset.execute({ name: 'click', arguments: JSON.stringify({ mode: 'coord', x: 1, y: 2, button: 'left', clicks: 1, title: '', control: '', image: '' }) });
  assert.match(denied.output, /отклонена/);
  let performed = 0;
  const allowed = createToolset({
    root: os.tmpdir(), config: defaults, names: ['screenshot'], approvalLevel: 'all', approve: async () => 'no',
    performDesktop: async () => { performed += 1; return { message: 'ok', screenshotAbs: null, screenshotRel: null }; },
  });
  const shot = await allowed.execute({ name: 'screenshot', arguments: '{}' });
  assert.equal(performed, 1);
  assert.match(shot.output, /ok/);
});
