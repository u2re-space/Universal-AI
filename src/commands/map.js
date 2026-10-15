/**
 * @file src/commands/map.js
 * @module commands/map
 * @purpose Rebuild `.ai/map.json` or print its path and symbol counts.
 * @depends agent/map, commands/shared
 * @usedBy cli
 * @exports mapCommand
 * @ai.tags cli, index
 * @ai.hint io
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */
import { buildProjectMap, loadProjectMap, projectMapFile, countProjectMap } from '../agent/map.js';
import { UsageError } from './shared.js';

/**
 * `ai map` rebuilds the project map. `ai map path` prints the file and counts without writing.
 * @param {object} ctx Command context: renderer, positionals, and cwd.
 * @returns {Promise<number>} 0. Unknown arguments throw UsageError.
 * @exports
 * @ai.hint io
 */
export async function mapCommand(ctx) {
    const { renderer, positionals, cwd } = ctx;
    const sub = positionals[0] ?? '';
    if (positionals.length > 1 || (sub && sub !== 'path')) throw new UsageError('Доступно: ai map | ai map path');
    if (sub === 'path') {
        const projectMap = await loadProjectMap(cwd);
        const counts = projectMap ? countProjectMap(projectMap) : { files: 0, symbols: 0 };
        renderer.write(`${projectMapFile(cwd)}\nфайлов: ${counts.files}, символов: ${counts.symbols}\n`);
        return 0;
    }
    const projectMap = await buildProjectMap(cwd);
    const counts = countProjectMap(projectMap);
    renderer.write(`Карта записана: ${projectMapFile(cwd)}\nфайлов: ${counts.files}, символов: ${counts.symbols}\n`);
    return 0;
}
