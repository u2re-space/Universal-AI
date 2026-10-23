/**
 * @file src/core/runtime-env.js
 * @module core/runtime-env
 * @purpose Load a project .env and keep an API key with the base URL that belongs to it.
 * @depends node:child_process, node:fs/promises, node:path
 * @usedBy cli, commands/serve, openai/client, openai/fallback, complete/channels
 * @exports parseEnvFile, applyEnvFile, reconcileCredentialScopes, readWindowsEnvValue, resolveRuntimeEnv,
 *   setLiveEnv, liveEnv, envValue, refreshRuntimeEnv, resetLiveEnv
 * @ai.tags config, env
 * @ai.hint io
 * @changed 2026-10-23 Live environment: modules read the merged .env instead of the process snapshot,
 *           and refreshRuntimeEnv re-reads the file so an edited .env is not stale.
 */
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const CREDENTIALS = ['OPENAI_API_KEY', 'OPENAI_BASE_URL'];
const ENV_FILE_LIMIT = 256 * 1024;
const REGISTRY = {
    user: 'HKCU\Environment',
    machine: 'HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment',
};

/**
 * The environment merged by the last resolve or refresh. `process.env` is a snapshot taken at
 * process start, so a value that came from `.env` is invisible there; every module that needs a
 * credential or a provider key reads this store instead.
 * @type {Record<string, string>|null}
 */
let live = null;
/** File signature of the `.env` that produced `live`, so a changed file forces a re-read. */
let liveSignature = null;

/**
 * A non-empty credential string, or null.
 * @param {string|null|undefined} value
 * @returns {string|null}
 * @ai.hint pure
 */
function present(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Which store produced this process value: user, machine, both, process, or missing.
 * @param {string|null|undefined} value
 * @param {string|null|undefined} userValue
 * @param {string|null|undefined} machineValue
 * @returns {'missing'|'user'|'machine'|'both'|'process'}
 * @ai.hint pure
 */
function scopeOf(value, userValue, machineValue) {
    const current = present(value);
    if (!current) return 'missing';
    const user = present(userValue);
    const machine = present(machineValue);
    if (user && current === user && machine && current === machine) return 'both';
    if (user && current === user) return 'user';
    if (machine && current === machine) return 'machine';
    return 'process';
}

/**
 * Parse KEY=VALUE lines. Comments and blank lines are ignored. export and matching quotes are stripped.
 * @param {string} text
 * @returns {Record<string, string>}
 * @exports
 * @ai.hint pure
 */
export function parseEnvFile(text) {
    const body = String(text).replace(/^\uFEFF/, '');
    if (Buffer.byteLength(body) > ENV_FILE_LIMIT) throw new Error('Файл .env больше 256 KiB.');
    const result = {};
    for (const line of body.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
        const eq = normalized.indexOf('=');
        if (eq <= 0) continue;
        const key = normalized.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        let value = normalized.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
            value = value.slice(1, -1);
        }
        result[key] = value;
    }
    return result;
}

/**
 * Copy env and replace keys that the .env text defines.
 * @param {object} env
 * @param {string} text
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function applyEnvFile(env, text) {
    return { ...env, ...parseEnvFile(text) };
}

/**
 * Stop a user-level key from being sent to a system-level base URL, and the reverse.
 * A value set only in this process is left as it is. When both stores define a full pair, the process value stays.
 * @param {{ env: object, user?: object, machine?: object }} scopes
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function reconcileCredentialScopes({ env, user = {}, machine = {} }) {
    const next = { ...env };
    const keyScope = scopeOf(env.OPENAI_API_KEY, user.OPENAI_API_KEY, machine.OPENAI_API_KEY);
    const urlScope = scopeOf(env.OPENAI_BASE_URL, user.OPENAI_BASE_URL, machine.OPENAI_BASE_URL);
    if (!((keyScope === 'user' && urlScope === 'machine') || (keyScope === 'machine' && urlScope === 'user'))) return next;
    const userComplete = present(user.OPENAI_API_KEY) && present(user.OPENAI_BASE_URL);
    const machineComplete = present(machine.OPENAI_API_KEY) && present(machine.OPENAI_BASE_URL);
    const source = machineComplete && !userComplete ? machine : userComplete && !machineComplete ? user : null;
    if (!source) return next;
    next.OPENAI_API_KEY = source.OPENAI_API_KEY;
    next.OPENAI_BASE_URL = source.OPENAI_BASE_URL;
    return next;
}

/**
 * Read one environment value from the Windows user and machine stores.
 * A missing value is null. Registry failures are treated as missing so the process environment still works.
 * @param {string} name
 * @returns {Promise<{ user: string|null, machine: string|null }>}
 * @exports
 * @ai.hint io
 */
export function readWindowsEnvValue(name) {
    /**
     * @param {string} key
     * @returns {Promise<string|null>}
     * @ai.hint io
     */
    const query = (key) => new Promise((resolve) => {
        execFile('reg.exe', ['query', key, '/v', name], { windowsHide: true, timeout: 5000, encoding: 'utf8' }, (error, stdout) => {
            if (error || !stdout || /ERROR:/i.test(stdout)) { resolve(null); return; }
            const match = stdout.match(new RegExp(`^\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+REG_\\w+\\s+(.*)$`, 'im'));
            resolve(match ? present(match[1].replace(/\r$/, '')) : null);
        });
    });
    return Promise.all([query(REGISTRY.user), query(REGISTRY.machine)]).then(([user, machine]) => ({ user, machine }));
}

/**
 * Environment for one command. On Windows, a split user/machine credential pair is repaired.
 * A .env file in cwd then overrides those values. process.env is not modified.
 * @param {{ cwd: string, env?: object, platform?: string, readScope?: (name: string) => Promise<{ user: string|null, machine: string|null }>|({ user: string|null, machine: string|null }) }} options
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function resolveRuntimeEnv({ cwd, env = process.env, platform = process.platform, readScope = readWindowsEnvValue } = {}) {
    let next = { ...env };
    if (platform === 'win32') {
        const user = {};
        const machine = {};
        await Promise.all(CREDENTIALS.map(async (name) => {
            const scope = await readScope(name);
            user[name] = scope?.user ?? null;
            machine[name] = scope?.machine ?? null;
        }));
        next = reconcileCredentialScopes({ env: next, user, machine });
    }
    const file = path.join(cwd, '.env');
    try {
        return applyEnvFile(next, await readFile(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return next;
        throw new Error(`Не удалось прочитать ${file}: ${error.message}`);
    }
}

/**
 * Publish the environment a command resolved, so every module reads the same values — including
 * the ones that came from `.env` and therefore never reached `process.env`.
 * @param {object|null} env
 * @returns {void}
 * @exports
 * @ai.hint pure
 */
export function setLiveEnv(env) {
    live = env ? { ...env } : null;
    liveSignature = null;
}

/**
 * The published environment, or `process.env` when nothing was published yet.
 * @param {object} [fallback]
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function liveEnv(fallback = process.env) {
    return live ?? fallback;
}

/**
 * One value from the published environment, falling back to `process.env` and then to a default.
 * @param {string} name
 * @param {string|null} [fallback]
 * @param {object|null} [env] Explicit environment, used by tests.
 * @returns {string|null}
 * @exports
 * @ai.hint pure
 */
export function envValue(name, fallback = null, env = null) {
    const value = (env ?? liveEnv())?.[name];
    if (typeof value === 'string' && value.trim()) return value;
    const inherited = process.env?.[name];
    return typeof inherited === 'string' && inherited.trim() ? inherited : fallback;
}

/**
 * Re-read `.env` for `cwd` and publish the result. A file whose size and modification time did not
 * change reuses the published environment, so a per-request call is cheap; an edited file is picked
 * up without restarting the process.
 * @param {{ cwd?: string, env?: object, platform?: string, readScope?: Function, force?: boolean }} [options]
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function refreshRuntimeEnv({ cwd = process.cwd(), env = process.env, platform = process.platform, readScope = readWindowsEnvValue, force = false } = {}) {
    const file = path.join(cwd, '.env');
    const info = await stat(file).catch(() => null);
    const signature = info ? `${file}|${info.mtimeMs}|${info.size}` : `${file}|absent`;
    const inherited = env === process.env;
    if (!force && inherited && live && signature === liveSignature) return live;
    const next = await resolveRuntimeEnv({ cwd, env, platform, readScope });
    live = next;
    liveSignature = signature;
    return next;
}

/**
 * Drop the published environment. Used by tests so one case cannot leak into the next.
 * @returns {void}
 * @exports
 * @ai.hint pure
 */
/**
 * Whether a runtime environment has been published by the CLI (or a test).
 * Used by serve to decide whether to re-read `.env` per run.
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function hasLiveEnv() {
    return live !== null;
}

/**
 * Drop the published environment. Used by tests so one case cannot leak into the next.
 * @returns {void}
 * @exports
 * @ai.hint pure
 */
export function resetLiveEnv() {
    live = null;
    liveSignature = null;
}
