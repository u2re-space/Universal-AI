import assert from 'node:assert/strict';
import { reindentSource } from './reindent.mjs';

const a = reindentSource('export function f() {\n  return `hi\n  there`;\n}\n');
assert.equal(a, 'export function f() {\n    return `hi\n  there`;\n}\n');

const b = reindentSource('const PROTECTED = /^(?:\\.env(?:\\..*)?|.*\\.(?:pem|key))$/i;\nfunction x() {\n  return 1;\n}\n');
assert.match(b, /^const PROTECTED = \/\^\(\?:\\\.env/);
assert.match(b, /\n    return 1;\n/);

const c = reindentSource('const x = `a${1 + 2}\n  tail`;\n  const y = 1;\n');
assert.equal(c, 'const x = `a${1 + 2}\n  tail`;\n    const y = 1;\n');

const d = reindentSource('export const HELP = `ai\n  usage\n`;\n\nexport function main() {\n  return 1;\n}\n');
assert.equal(d, 'export const HELP = `ai\n  usage\n`;\n\nexport function main() {\n    return 1;\n}\n');

const e = reindentSource('function html(html) {\n  return html\n    .replace(/<script[\\s\\S]*?<\\/script>/gi, \' \')\n    .replace(/&quot;/g, \'"\');\n}\n');
assert.match(e, /\n        \.replace/);

const nested = reindentSource('const x = `pre ${`in\n  side`} post\n  end`;\n  const z = 2;\n');
assert.match(nested, /  side/);
assert.match(nested, /  end/);
assert.match(nested, /\n    const z = 2;/);

const patterns = reindentSource(`function jsImportSpecs(text) {
  const patterns = [
    /\\bfrom\\s+(['"])(\\.[^'"]*)\\1/g,
    /\\bimport\\s+(['"])(\\.[^'"]*)\\1/g,
    /\\brequire\\(\\s*(['"])(\\.[^'"]*)\\1\\s*\\)/g,
  ];
  return patterns;
}
`);
assert.match(patterns, /\n        \/\\bimport/);
assert.match(patterns, /\n        \/\\brequire/);
assert.match(patterns, /\n    \];/);

console.log('reindent checks ok');
