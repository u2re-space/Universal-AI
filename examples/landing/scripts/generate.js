import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, copyFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const command = typeof pkg.generate?.command === 'string' ? pkg.generate.command.trim() : '';
const protect = new Set([...(Array.isArray(pkg.generate?.protect) ? pkg.generate.protect : [])].map((item) => String(item).replace(/\\/g, '/')));
if (!command) {
    process.stdout.write('The skeleton is already written.\n');
    process.exit(0);
}
const temp = await mkdtemp(path.join(os.tmpdir(), 'scaffold-'));
let code = 1;
try {
    const child = spawn(command, { cwd: temp, shell: true, stdio: 'inherit', windowsHide: true });
    code = await new Promise((resolve) => child.once('close', resolve)) ?? 1;
    if (code !== 0) {
        /* a failed generator copies nothing */
    } else {
        const files = [];
        const walk = async (dir) => {
            for (const entry of await readdir(dir, { withFileTypes: true })) {
                if (entry.name === 'node_modules' || entry.name === '.git') continue;
                const abs = path.join(dir, entry.name);
                if (entry.isDirectory()) await walk(abs);
                else files.push(path.relative(temp, abs).replace(/\\/g, '/'));
            }
        };
        await walk(temp);
        for (const rel of files) {
            if (rel === 'package.json' || protect.has(rel)) continue;
            const dest = path.join(root, rel);
            if (await stat(dest).then(() => true).catch(() => false)) continue;
            await mkdir(path.dirname(dest), { recursive: true });
            await copyFile(path.join(temp, rel), dest);
        }
        const incomingPath = path.join(temp, 'package.json');
        if (await stat(incomingPath).then(() => true).catch(() => false) && !protect.has('package.json')) {
            const dest = path.join(root, 'package.json');
            const have = await stat(dest).then(() => true).catch(() => false);
            if (!have) await copyFile(incomingPath, dest);
            else {
                let current;
                try { current = JSON.parse(await readFile(dest, 'utf8')); } catch { current = null; }
                if (current && typeof current === 'object' && !Array.isArray(current)) {
                    const incoming = JSON.parse(await readFile(incomingPath, 'utf8'));
                    for (const section of ['scripts', 'dependencies', 'devDependencies']) {
                        const prior = current[section] && typeof current[section] === 'object' ? current[section] : {};
                        const extra = incoming[section] && typeof incoming[section] === 'object' ? incoming[section] : {};
                        current[section] = { ...prior };
                        for (const [key, value] of Object.entries(extra)) if (!(key in current[section])) current[section][key] = value;
                    }
                    await writeFile(dest, JSON.stringify(current, null, 2) + '\n');
                }
            }
        }
    }
} finally {
    await rm(temp, { recursive: true, force: true });
}
process.exit(code);
