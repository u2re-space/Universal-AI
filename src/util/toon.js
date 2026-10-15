/**
 * @file src/util/toon.js
 * @module util/toon
 * @purpose Public TOON subset codec. Encode and decode live in sibling modules.
 * @depends util/toon-encode, util/toon-decode
 * @usedBy interact/batch, agent/roles
 * @exports encodeToon, decodeDocument
 * @ai.tags toon
 * @ai.hint pure
 * @changed 2026-10-15 Facade after the codec was split.
 */
export { encodeToon } from './toon-encode.js';
export { decodeDocument } from './toon-decode.js';
