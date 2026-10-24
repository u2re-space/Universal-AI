/**
 * @file src/core/agents-md.js
 * @module core/agents-md
 * @purpose Discover, load, and merge AGENTS.md files across the project hierarchy.
 * @depends node:fs/promises, node:path
 * @usedBy agent/team, commands/run, commands/chat, commands/ask, complete/context, commands/agents
 * @exports discoverAgents, agentsMdTemplate
 * @ai.tags agents, discovery, config
 * @ai.hint io
 * @changed 2026-10-24 Initial implementation.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clipMiddle } from '../util/text.js';

const KiB = 1024;

/** Default filenames to search for, in precedence order (first found wins per directory). */
const DEFAULT_AGENT_FILES = ['AGENTS.md', 'agents.md'];

/**
 * Discover and load AGENTS.md files from the project hierarchy.
 *
 * Search strategy:
 * 1. Walk up from `cwd` toward the filesystem root (stop at `home` or filesystem root).
 * 2. In each directory, look for files matching `filenames` (default: AGENTS.md, agents.md).
 * 3. Collect nested files from subdirectories matching `nestedPatterns` (depth-limited).
 * 4. Read the global file from `~/.ai-agent/AGENTS.md` (or `globalFile` config).
 * 5. Merge all found files with precedence: global < ancestor files < nearest project root < nested files.
 *
 * @param {{ cwd: string, home?: string, config?: object }} options Working directory, agent home, and optional config overrides.
 * @returns {{ files: Array<{ path: string, content: string }>, text: string, source: string, found: number }}
 * @ai.hint io
 */
export async function discoverAgents({ cwd, home = null, config = {} } = {}) {
    const filenames = config.filenames ?? DEFAULT_AGENT_FILES;
    const maxBytes = (typeof config.maxBytes === 'number' && config.maxBytes > 0)
        ? Math.min(config.maxBytes, 64 * KiB)  // cap at 64 KB
        : 16 * KiB;
    const maxTotalBytes = (typeof config.maxTotalBytes === 'number' && config.maxTotalBytes > 0)
        ? Math.min(config.maxTotalBytes, 256 * KiB)
        : 64 * KiB;
    if (config.enabled === false) return { files: [], text: '', source: '', found: 0 };
    const discoverUpward = config.discoverUpward !== false;
    const nested = config.nested !== false;
    const agentHome = home ?? path.join(os.homedir(), '.ai-agent');
    const root = path.resolve(cwd);
    const globalFile = config.globalFile
        ? path.resolve(root, config.globalFile)
        : path.join(agentHome, 'AGENTS.md');
    const seen = new Set();
    const keyFor = (file) => {
        const key = path.resolve(file).split(path.sep).join('/');
        return process.platform === 'win32' ? key.toLowerCase() : key;
    };
    const allFiles = [];
    const addFiles = (files) => {
        for (const file of files) {
            const key = keyFor(file.abs);
            if (seen.has(key)) continue;
            seen.add(key);
            allFiles.push(file);
        }
    };

    if (discoverUpward) addFiles((await walkUp(root, os.homedir(), filenames, maxBytes)).reverse());
    if (nested) addFiles(await collectNested(root, filenames, maxBytes, 2));

    let globalContent = null;
    try {
        const globalStat = await stat(globalFile);
        if (globalStat.isFile() && globalStat.size > 0 && globalStat.size <= maxBytes) {
            globalContent = await readFile(globalFile, 'utf8');
            const key = keyFor(globalFile);
            if (!seen.has(key) && globalContent.trim()) {
                seen.add(key);
                allFiles.unshift({ abs: globalFile, rel: globalFile, content: globalContent, global: true });
            } else {
                globalContent = null;
            }
        }
    } catch {
        /* global file does not exist — not an error */
    }

    const parts = [];
    const sources = [];
    for (const file of allFiles) {
        if (!file.content?.trim()) continue;
        const label = file.global
            ? `Global instructions (${file.abs})`
            : `${path.relative(root, path.dirname(file.abs)) ? `Directory: ${path.relative(root, path.dirname(file.abs))}` : 'Project'} instructions (${file.rel})`;
        parts.push(`# ${label}\n\n${file.content.trim()}`);
        sources.push(file.abs);
    }

    const clipped = clipMiddle(parts.join('\n\n'), maxTotalBytes);
    return {
        files: allFiles.map((file) => ({ path: file.rel, content: file.content })),
        text: clipped,
        source: sources.join('\n'),
        found: allFiles.filter((file) => file.content?.trim()).length,
    };
}

/**
 * Walk up from `cwd` toward `home` (or filesystem root), collecting AGENTS.md files.
 * Returns files sorted nearest-first (the closest AGENTS.md takes highest precedence).
 * @param {string} cwd
 * @param {string} home
 * @param {string[]} filenames
 * @param {number} maxBytes
 * @returns {Array<{ abs: string, rel: string, content: string }>}
 * @ai.hint io
 */
async function walkUp(cwd, home, filenames, maxBytes) {
    const results = [];
    let dir = path.resolve(cwd);
    const homeResolved = path.resolve(home);

    while (true) {
        for (const fname of filenames) {
            const fpath = path.join(dir, fname);
            try {
                const s = await stat(fpath);
                if (s.isFile() && s.size > 0 && s.size <= maxBytes) {
                    const content = await readFile(fpath, 'utf8');
                    const rel = path.relative(cwd, fpath) || fname;
                    results.push({ abs: fpath, rel, content });
                    break;  // first matching filename wins per directory
                }
            } catch {
                /* file not found in this directory */
            }
        }

        // Stop when we reach home or the filesystem root.
        if (dir === homeResolved || dir === path.parse(dir).root) break;
        dir = path.dirname(dir);
    }

    return results;
}

/**
 * Collect AGENTS.md files from subdirectories up to `maxDepth`.
 * @param {string} root
 * @param {string[]} filenames
 * @param {number} maxBytes
 * @param {number} maxDepth
 * @returns {Promise<Array<{ abs: string, rel: string, content: string }>>}
 * @ai.hint io
 */
async function collectNested(root, filenames, maxBytes, maxDepth) {
    const results = [];

    async function scan(dir, depth) {
        if (depth > maxDepth) return;
        try {
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== '.git') {
                    const subDir = path.join(dir, entry.name);
                    for (const fname of filenames) {
                        const fpath = path.join(subDir, fname);
                        try {
                            const s = await stat(fpath);
                            if (s.isFile() && s.size > 0 && s.size <= maxBytes) {
                                const content = await readFile(fpath, 'utf8');
                                const rel = path.relative(root, fpath);
                                results.push({ abs: fpath, rel, content });
                                break;
                            }
                        } catch {
                            /* skip */
                        }
                    }
                    await scan(subDir, depth + 1);
                }
            }
        } catch {
            /* permission denied or other error — skip this directory */
        }
    }

    await scan(root, 1);
    return results;
}

/**
 * Default template for `ai agents init`.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function agentsMdTemplate() {
    return `# Project Instructions

## Tech Stack
- Node.js 26, ESM modules
- OpenAI Responses API (no SDK)
- No external dependencies

## Code Style
- Use 4-space indentation
- Prefer const over let; avoid var
- Use template literals for string concatenation
- Add JSDoc comments to exported functions
- Write Russian comments for domain logic

## Project Structure
- src/ — source code
- test/ — tests (node:test, assert)
- bin/ — CLI entry points
- docs/ — documentation

## Key Conventions
- All CLI commands go through src/cli.js
- Configuration lives in src/core/config.js and src/core/config-defaults.js
- Agent roles are in src/roles/ and src/agent/
- Memory is SQLite-backed (node:sqlite)
- Tests use node:test framework

## Important Notes
- Run tests with: npm test
- Start CLI with: node bin/ai.js
- Install globally: npm install -g .
`;
}
