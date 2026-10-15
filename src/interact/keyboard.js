import { ahkString } from './filesystem.js';

/** AutoHotkey v2 statement for one normalized type action. */
export function typeBody(action) {
  const text = ahkString(action.text);
  if (action.mode === 'text') return `SendText(${text})`;
  if (action.mode === 'keys') return `Send(${text})`;
  throw new Error(`unknown type mode: ${action.mode}`);
}
