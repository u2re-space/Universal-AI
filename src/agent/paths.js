import path from 'node:path';
import { realpath, lstat } from 'node:fs/promises';

/** Names that are never readable or writable by the model (secrets, keys). */
const PROTECTED_FILES = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i;
/** Directories that are never accessible at all. */
const FORBIDDEN_DIRS = /^(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker)$/i;
/** Directories that are read-only for the model and skipped by listing / search. */
export const NOISY_DIRS = /^(?:\.git|node_modules|\.hg|\.svn|dist|build|coverage|\.next|\.nuxt|\.cache|\.venv|venv|__pycache__|target|\.ai-agent)$/i;
const READ_ONLY_DIRS = /^(?:\.git|node_modules)$/i;

export function toPosix(relative) {
  return relative.split(path.sep).join('/');
}

export function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/**
 * Resolve a model-supplied path to an absolute path inside `root`.
 * Rejects escapes (including through symlinks of existing components), secrets and
 * writes into read-only directories. Returns { abs, rel } where rel is POSIX and root-relative.
 */
export async function resolveInside(root, relative, { forWrite = false, allowRoot = true } = {}) {
  if (typeof relative !== 'string') throw new Error('Путь должен быть строкой.');
  if (relative.includes('\0')) throw new Error('Путь содержит NUL.');
  const cleaned = relative.trim() === '' || relative.trim() === '.' ? '.' : relative.trim();
  const abs = path.resolve(root, cleaned);
  if (!isInside(root, abs)) throw new Error(`Путь вне рабочего каталога: ${relative}`);
  const rel = toPosix(path.relative(root, abs));
  if (rel === '' && !allowRoot) throw new Error('Нужен путь к файлу, а не к корню.');
  const segments = rel ? rel.split('/') : [];
  for (const [index, segment] of segments.entries()) {
    if (FORBIDDEN_DIRS.test(segment)) throw new Error(`Доступ запрещён: ${rel}`);
    if (index === segments.length - 1 && PROTECTED_FILES.test(segment)) throw new Error(`Файл с секретами недоступен: ${rel}`);
    if (forWrite && READ_ONLY_DIRS.test(segment)) throw new Error(`Запись в ${segment} запрещена: ${rel}`);
  }
  // Symlink escape check on the deepest existing component.
  let probe = abs;
  for (;;) {
    const stat = await lstat(probe).catch(() => null);
    if (stat) {
      const real = await realpath(probe).catch(() => probe);
      const realRoot = await realpath(root).catch(() => root);
      if (!isInside(realRoot, real)) throw new Error(`Путь через символическую ссылку выходит за рабочий каталог: ${rel}`);
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return { abs, rel: rel || '.' };
}
