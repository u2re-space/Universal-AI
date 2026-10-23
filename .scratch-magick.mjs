import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { runProgram } from './src/agent/shell.js';
import { detectMagick, magickDetectFakeTransparency, magickContourAlphaMask, magickApplyAlphaMask, magickIsOpaque } from './src/agent/image-magick.js';

const exe = await detectMagick();
console.log('exe', exe);
const dir = await mkdtemp(path.join(os.tmpdir(), 'scratch-magick-'));
const run = (args) => runProgram({ file: exe, args, cwd: dir, timeoutMs: 15000, maxOutputBytes: 8192 });

// 1. checkerboard plate with a red subject
await run(['-size', '300x200', 'pattern:checkerboard', '-fill', 'red', '-draw', 'circle 150,100 150,160', 'checkers.png']);
console.log('checkerboard', await magickDetectFakeTransparency({ exe, input: 'checkers.png', cwd: dir }));

// 2. flat white plate
await run(['-size', '300x200', 'xc:white', '-fill', 'red', '-draw', 'circle 150,100 150,160', 'flat.png']);
console.log('flat white', await magickDetectFakeTransparency({ exe, input: 'flat.png', cwd: dir }));

// 3. colored photo-ish corner
await run(['-size', '300x200', 'xc:#3a7bd5', '-fill', '#ffd166', '-draw', 'roundrectangle 60,40 240,160 20,20', 'colored.png']);
console.log('colored', await magickDetectFakeTransparency({ exe, input: 'colored.png', cwd: dir }));

// 4. real alpha png
await run(['-size', '300x200', 'xc:none', '-fill', 'red', '-draw', 'circle 150,100 150,160', 'alpha.png']);
console.log('alpha opaque?', await magickIsOpaque({ exe, input: 'alpha.png', cwd: dir }));

// 5. contour matte from a flat plate
console.log('contour', await magickContourAlphaMask({ exe, input: 'flat.png', output: 'contour-mask.png', cwd: dir }));
// Debug: check mask pixels
const maskProbe = await run(['contour-mask.png', '-format', '%[fx:round(255*p{5,5}.r)],%[fx:round(255*p{150,100}.r)],%[fx:round(255*p{295,195}.r)]', 'info:']);
console.log('mask corner,center,corner:', maskProbe.stdout);
const merged = await magickApplyAlphaMask({ exe, input: 'flat.png', mask: 'contour-mask.png', output: 'contour-out.png', cwd: dir });
console.log('merged', merged);
console.log('out opaque?', await magickIsOpaque({ exe, input: 'contour-out.png', cwd: dir }));
const px = await run(['contour-out.png', '-format', '%[fx:round(255*p{150,100}.r)],%[fx:round(255*p{150,100}.a)],%[fx:round(255*p{5,5}.a)]', 'info:']);
console.log('pixels center,alpha / corner alpha:', px.stdout);

// 6. contour on a subject touching the frame (should degrade)
await run(['-size', '300x200', 'xc:white', '-fill', 'black', '-draw', 'rectangle 0,0 300,200', 'fullblack.png']);
console.log('contour full-black', await magickContourAlphaMask({ exe, input: 'fullblack.png', output: 'm2.png', cwd: dir }));
// 7. contour on an off-center subject (should work)
await run(['-size', '300x200', 'xc:white', '-fill', 'blue', '-draw', 'rectangle 50,30 250,170', 'offcenter.png']);
console.log('contour offcenter', await magickContourAlphaMask({ exe, input: 'offcenter.png', output: 'm3.png', cwd: dir }));
const merged2 = await magickApplyAlphaMask({ exe, input: 'offcenter.png', mask: 'm3.png', output: 'contour-out2.png', cwd: dir });
console.log('merged2', merged2);
console.log('out2 opaque?', await magickIsOpaque({ exe, input: 'contour-out2.png', cwd: dir }));

await rm(dir, { recursive: true, force: true });
