import { readFile, writeFile } from 'node:fs/promises';

const [script, result, shot] = process.argv.slice(2);
const body = await readFile(script, 'utf8');
if (body.includes('FORCE_FAIL')) {
    await writeFile(result, 'forced failure', 'utf8');
    process.exit(2);
}
await writeFile(result, 'ok', 'utf8');
if (shot) await writeFile(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
process.exit(0);
