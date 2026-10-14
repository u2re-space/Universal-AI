import { buildProjectMap, loadProjectMap, projectMapFile, countProjectMap } from '../agent/map.js';
import { UsageError } from './shared.js';

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
