import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Create an empty .env in cwd so resolveRuntimeEnv stops upward search there
 * and does not fall back to a package-level .env.
 * @param {string} cwd
 * @returns {Promise<void>}
 */
export async function ensureLocalEnv(cwd) {
    await writeFile(path.join(cwd, '.env'), '');
}
