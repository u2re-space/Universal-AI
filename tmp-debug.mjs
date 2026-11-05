import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { runProgram } from './src/agent/shell.js';
import { detectMagick, magickIsOpaque, magickAlphaShare, magickAlphaSoftShare } from './src/agent/image-magick.js';
import { hasRealAlpha } from './src/agent/image-alpha.js';

const exe = await detectMagick();
const dir = await mkdtemp(path.join(os.tmpdir(), 'dbg-'));

// The exact fixture the failing test writes.
const { TINY_PNG } = await import('./test/helpers/mock-server.js');
await writeFile(path.join(dir, 'tiny.png'), Buffer.from(TINY_PNG, 'base64'));

console.log('isOpaque:', await magickIsOpaque({ exe, input: 'tiny.png', cwd: dir }));
console.log('alphaShare:', await magickAlphaShare({ exe, input: 'tiny.png', cwd: dir }));
console.log('softShare:', await magickAlphaSoftShare({ exe, input: 'tiny.png', cwd: dir }));
console.log('hasRealAlpha:', await hasRealAlpha({ file: path.join(dir, 'tiny.png'), cwd: dir }));
