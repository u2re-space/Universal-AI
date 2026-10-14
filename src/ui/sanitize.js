import { stripVTControlCharacters } from 'node:util';

/**
 * Model output is untrusted text. Before it reaches a terminal we strip terminal control
 * sequences, C0/C1 controls (except \n, \t), bidi overrides and Unicode line separators,
 * so model text can never re-style the terminal, hide text or spoof prompts.
 */
export function sanitizeTerminal(value, { keepNewlines = true } = {}) {
  const text = stripVTControlCharacters(String(value ?? ''));
  const pattern = keepNewlines
    ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g
    : /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g;
  return text.replace(pattern, '');
}

/** Recursively sanitize strings inside a JSON-like value (used for --json output). */
export function sanitizeValue(value, depth = 0) {
  if (depth > 32) return null;
  if (typeof value === 'string') return sanitizeTerminal(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [sanitizeTerminal(key, { keepNewlines: false }), sanitizeValue(item, depth + 1)]));
  }
  return value;
}
