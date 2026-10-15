import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeToon, decodeDocument } from '../src/util/toon.js';

const batch = {
  summary: 'click Save',
  actions: [
    { type: 'click', mode: 'coord', x: 10, y: 20, button: 'left', clicks: 1, text: null, title: null, control: null, image: null, script: null },
    { type: 'type', mode: 'text', x: null, y: null, button: null, clicks: null, text: 'a,b', title: null, control: null, image: null, script: null },
  ],
};

test('toon round-trips a batch', () => {
  const encoded = encodeToon(batch);
  assert.match(encoded, /actions\[2\]\{/);
  assert.deepEqual(decodeDocument(encoded), batch);
});

test('decodeDocument accepts JSON', () => {
  assert.deepEqual(decodeDocument(JSON.stringify(batch)), batch);
});

test('encodeToon rejects a non-uniform array', () => {
  assert.throws(() => encodeToon({ items: [{ a: 1 }, { a: 1, b: 2 }] }), /TOON:/);
});
