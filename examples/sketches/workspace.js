import path from 'node:path';
import os from 'node:os';
import { constants } from 'node:fs';
import { open, lstat, mkdir, mkdtemp, readdir, opendir, rename, unlink, link, rm, chmod, rmdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import ignore from 'ignore';

const hash = (data) => createHash('sha256').update(data).digest('hex');
const bytes = (value) => Buffer.byteLength(value, 'utf8');
const utf8 = new TextDecoder('utf-8', { fatal: true });
const aborted = (signal) => signal?.throwIfAborted();
const HARD_DIRECTORY = /^(?:\.git|\.ssh|\.gnupg|\.aws|\.azure|\.config|node_modules)$/i;
const SENSITIVE = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.agentignore|\.code-agent-apply\.lock|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i;
const PRIVATE_EXTENSION = /\.(?:pem|key|p12|pfx|jks|keystore)$/i;
const GUARDED = /(?:^|\/)(?:test|tests|__tests__|\.github)(?:\/|$)|(?:^|\/)(?:package\.json|.*lock.*|\.gitignore|.*(?:eslint|prettier|jest|vitest|tsconfig).*|Dockerfile|docker-compose.*)$|\.(?:test|spec)\.[^/]+$/i;

export function normalizePath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 ||
      /[\\:\x00-\x1f\x7f]/.test(value) || value.startsWith('/')) {
    throw new Error('Нужен относительный POSIX-путь без управляющих символов, обратных слешей и двоеточия.');
  }
  const parts = value.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || /[. ]$/.test(p))) {
    throw new Error(`Недопустимый путь: ${JSON.stringify(value)}`);
  }
  return parts.join('/');
}

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

async function statOrNull(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Every existing component is checked. This is not an OS sandbox or a defense against
// a hostile process racing filesystem operations. Do not concurrently modify either tree.
async function safePath(root, relative, { missing = false } = {}) {
  const rel = normalizePath(relative);
  const segments = rel.split('/');
  let current = root;
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Корень workspace подменён.');
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    const stat = await statOrNull(current);
    if (!stat) {
      if (!missing) throw new Error(`Файл отсутствует: ${rel}`);
      return path.join(root, ...segments);
    }
    if (stat.isSymbolicLink()) throw new Error(`Симлинки запрещены: ${rel}`);
    if (i < segments.length - 1 && !stat.isDirectory()) throw new Error(`Родитель не является каталогом: ${rel}`);
    if (i === segments.length - 1 && (!stat.isFile() || stat.nlink !== 1)) {
      throw new Error(`Нужен обычный файл без hard links: ${rel}`);
    }
  }
  return current;
}

async function readBounded(file, limit, signal) {
  aborted(signal);
  const prior = await lstat(file);
  if (!prior.isFile() || prior.isSymbolicLink() || prior.nlink !== 1 || prior.size > limit) {
    throw new Error('Чтение отклонено: тип файла или лимит размера.');
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const start = await handle.stat();
    if (!start.isFile() || start.nlink !== 1 || start.size > limit || start.ino !== prior.ino || start.dev !== prior.dev) {
      throw new Error('Файл изменился перед чтением.');
    }
    const chunks = [];
    let total = 0;
    for (;;) {
      aborted(signal);
      const buffer = Buffer.allocUnsafe(Math.min(32768, limit - total + 1));
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (!result.bytesRead) break;
      total += result.bytesRead;
      if (total > limit) throw new Error('Файл превысил лимит во время чтения.');
      chunks.push(buffer.subarray(0, result.bytesRead));
    }
    const finish = await handle.stat();
    const current = await lstat(file);
    if (start.size !== finish.size || start.mtimeMs !== finish.mtimeMs || start.ctimeMs !== finish.ctimeMs ||
        current.ino !== finish.ino || current.dev !== finish.dev || current.isSymbolicLink()) {
      throw new Error('Файл изменился во время чтения.');
    }
    return { buffer: Buffer.concat(chunks, total), stat: finish };
  } finally { await handle.close(); }
}

async function parents(root, relative, created = []) {
  const segments = normalizePath(relative).split('/').slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const st = await statOrNull(current);
    if (!st) {
      try { await mkdir(current, { mode: 0o700 }); created.push(current); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const checked = await lstat(current);
    if (!checked.isDirectory() || checked.isSymbolicLink()) throw new Error('Небезопасный родительский каталог.');
  }
}

async function writeNew(file, buffer, mode = 0o600) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
  try { await handle.writeFile(buffer); await handle.sync(); }
  finally { await handle.close(); }
  await chmod(file, mode);
}

function linesOf(text) { return text.match(/[^\n]*\n|[^\n]+$/g) ?? []; }
function diffHunk(before, after) {
  const a = linesOf(before), b = linesOf(after);
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const start = Math.max(0, prefix - 3), tail = Math.min(3, suffix);
  const aEnd = a.length - suffix + tail, bEnd = b.length - suffix + tail;
  const aCount = aEnd - start, bCount = bEnd - start;
  const render = (mark, line) => `${mark}${line.endsWith('\n') ? line : `${line}\n\\ No newline at end of file\n`}`;
  let result = `@@ -${aCount ? start + 1 : start},${aCount} +${bCount ? start + 1 : start},${bCount} @@\n`;
  for (let i = start; i < prefix; i++) result += render(' ', a[i]);
  for (let i = prefix; i < a.length - suffix; i++) result += render('-', a[i]);
  for (let i = prefix; i < b.length - suffix; i++) result += render('+', b[i]);
  for (let i = 0; i < tail; i++) result += render(' ', a[a.length - suffix + i]);
  return result;
}

export async function createWorkspace(config, { emit = () => {}, approve = async () => false, signal } = {}) {
  const limits = config.limits;
  const sessionDir = await mkdtemp(path.join(os.tmpdir(), 'code-agent-'));
  const root = path.join(sessionDir, 'work');
  const base = path.join(sessionDir, 'base');
  if (inside(config.root, sessionDir)) {
    await rm(sessionDir, { recursive: true, force: true });
    throw new Error('Временная копия должна находиться вне проекта. Выберите более узкий --root или внешний TMPDIR.');
  }
  await mkdir(root, { mode: 0o700 });
  await mkdir(base, { mode: 0o700 });
  const initial = new Map(), files = new Map(), readHashes = new Map(), approvals = new Set();
  const rules = [{ base: '', matcher: ignore().add(config.policy.exclusions) }];
  const stats = { visited: 0, excluded: 0, unavailable: 0, snapshotBytes: 0, scanTruncated: false };
  let stopScan = false, broken = false, published = false;

  function allowed(rel, directory = false) {
    const normalized = normalizePath(rel);
    const parts = normalized.split('/');
    if (parts.some((p) => HARD_DIRECTORY.test(p) || SENSITIVE.test(p) || PRIVATE_EXTENSION.test(p))) return false;
    for (const rule of rules) {
      if (rule.base && normalized !== rule.base && !normalized.startsWith(`${rule.base}/`)) continue;
      const scoped = rule.base ? normalized.slice(rule.base.length + 1) : normalized;
      if (scoped && rule.matcher.ignores(`${scoped}${directory ? '/' : ''}`)) return false;
    }
    return true;
  }

  async function loadRules(relative) {
    for (const name of ['.gitignore', '.agentignore']) {
      const rel = relative ? `${relative}/${name}` : name;
      const filename = path.join(config.root, ...rel.split('/'));
      const st = await statOrNull(filename);
      if (!st) continue;
      // Ignore-policy files are read locally, never sent via this bypass.
      if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) throw new Error(`Небезопасный файл правил: ${rel}`);
      const { buffer } = await readBounded(filename, 64 * 1024, signal);
      rules.push({ base: relative, matcher: ignore().add(utf8.decode(buffer)) });
    }
  }

  async function scan(relative = '') {
    aborted(signal);
    await loadRules(relative);
    const directory = await opendir(path.join(config.root, ...relative.split('/').filter(Boolean)));
    for await (const entry of directory) {
      aborted(signal);
      if (stopScan) return;
      if (++stats.visited > limits.maxScanEntries) { stats.scanTruncated = true; stopScan = true; return; }
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      try { normalizePath(rel); } catch { stats.excluded++; continue; }
      if (!allowed(rel, entry.isDirectory()) || entry.isSymbolicLink()) { stats.excluded++; continue; }
      const filename = path.join(config.root, ...rel.split('/'));
      const st = await lstat(filename);
      if (st.isSymbolicLink() || st.nlink !== 1 && !st.isDirectory()) { stats.excluded++; continue; }
      if (st.isDirectory()) {
        if (rel.split('/').length > 40) { stats.unavailable++; continue; }
        await scan(rel);
      } else if (st.isFile()) {
        if (initial.size >= limits.maxSnapshotFiles || st.size > limits.maxSnapshotFileBytes ||
            stats.snapshotBytes + st.size > limits.maxSnapshotBytes) { stats.unavailable++; continue; }
        if (st.size > limits.maxFileBytesWithoutApproval) {
          const accepted = await approve({ type: 'snapshot-large', path: rel, bytes: st.size,
            reason: 'Для рабочей копии потребуется полностью прочитать этот файл локально. Это ещё не отправка модели.' });
          aborted(signal);
          if (!accepted) { stats.unavailable++; continue; }
        }
        const safe = await safePath(config.root, rel);
        const readCap = Math.min(limits.maxSnapshotFileBytes, limits.maxSnapshotBytes - stats.snapshotBytes,
          st.size > limits.maxFileBytesWithoutApproval ? limits.maxSnapshotFileBytes : limits.maxFileBytesWithoutApproval);
        const { buffer, stat } = await readBounded(safe, readCap, signal);
        const meta = { path: rel, bytes: buffer.length, sha256: hash(buffer), mode: stat.mode & 0o777 };
        for (const target of [root, base]) {
          await parents(target, rel);
          await writeNew(path.join(target, ...rel.split('/')), buffer, 0o600 | (meta.mode & 0o111));
        }
        initial.set(rel, meta); files.set(rel, { ...meta }); stats.snapshotBytes += buffer.length;
      } else stats.excluded++;
    }
  }

  try { await scan(); }
  catch (error) { await rm(sessionDir, { recursive: true, force: true }); throw error; }
  emit({ type: 'workspace.created', files: files.size, ...stats });

  function ensureUsable() {
    aborted(signal);
    if (broken) throw new Error('Workspace повреждён после незавершённой операции. Требуется ручная проверка.');
    if (published) throw new Error('Изменения уже перенесены.');
  }

  function tree() {
    const entries = [];
    let used = 0;
    for (const meta of [...files.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      const item = { path: meta.path, bytes: meta.bytes, requiresApproval: meta.bytes > limits.maxFileBytesWithoutApproval };
      const size = bytes(JSON.stringify(item)) + 1;
      if (entries.length >= limits.maxTreeEntries || used + size > limits.maxTreeBytes) break;
      entries.push(item); used += size;
    }
    return { entries, totalAvailable: files.size, truncated: entries.length !== files.size || stats.scanTruncated,
      unavailableCount: stats.unavailable, note: 'Excluded paths are not available. Snapshot is local; file contents have not been sent.' };
  }

  async function read(request, { remainingBytes = limits.maxContextBytesPerCall } = {}) {
    ensureUsable();
    const rel = normalizePath(request.path);
    if (!allowed(rel) || !files.has(rel)) throw new Error(`Недоступный файл: ${rel}`);
    if (!Number.isSafeInteger(request.startLine) || request.startLine < 1 ||
        request.endLine !== null && (!Number.isSafeInteger(request.endLine) || request.endLine < request.startLine)) {
      throw new Error('Некорректный диапазон строк.');
    }
    const filename = await safePath(root, rel);
    const st = await lstat(filename);
    const approvalKey = `${rel}:${files.get(rel).sha256}`;
    if (st.size > limits.maxFileBytesWithoutApproval && !approvals.has(approvalKey)) {
      const accepted = await approve({ type: 'large-file', path: rel, bytes: st.size,
        startLine: request.startLine, endLine: request.endLine, reason: request.reason });
      if (!accepted) throw new Error(`Чтение большого файла отклонено: ${rel}`);
      approvals.add(approvalKey);
    }
    const cap = st.size > limits.maxFileBytesWithoutApproval ? limits.maxSnapshotFileBytes : limits.maxFileBytesWithoutApproval;
    const { buffer } = await readBounded(filename, cap, signal);
    const sha = hash(buffer);
    if (sha !== files.get(rel).sha256) throw new Error(`Workspace изменён посторонним процессом: ${rel}`);
    if (buffer.includes(0)) throw new Error(`Бинарный файл не передаётся: ${rel}`);
    let text;
    try { text = utf8.decode(buffer); } catch { throw new Error(`Не UTF-8: ${rel}`); }
    const all = text.split('\n');
    if (request.startLine > all.length) throw new Error(`Начальная строка вне файла: ${rel}`);
    const end = Math.min(request.endLine ?? all.length, all.length);
    const content = all.slice(request.startLine - 1, end).join('\n');
    const result = { path: rel, sha256: sha, fileBytes: buffer.length, totalLines: all.length,
      startLine: request.startLine, endLine: end, content };
    if (bytes(content) > limits.maxReadBytesPerRequest || bytes(JSON.stringify(result)) > remainingBytes) {
      throw new Error(`Фрагмент слишком велик: ${rel}; запросите более узкий диапазон.`);
    }
    readHashes.set(rel, sha);
    emit({ type: 'file.read', path: rel, bytes: bytes(content), startLine: request.startLine, endLine: end });
    return result;
  }

  async function search(request, { remainingBytes = limits.maxContextBytesPerCall } = {}) {
    ensureUsable();
    if (typeof request.query !== 'string' || !request.query || bytes(request.query) > 256 || /[\r\n\0]/.test(request.query)) {
      throw new Error('Поиск: нужна непустая буквальная строка длиной до 256 байт без переводов строки.');
    }
    const prefix = request.pathPrefix ? normalizePath(request.pathPrefix.replace(/\/$/, '')) : '';
    const matches = [];
    let scannedBytes = 0, truncated = false;
    for (const meta of [...files.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      aborted(signal);
      if (prefix && meta.path !== prefix && !meta.path.startsWith(`${prefix}/`)) continue;
      if (meta.bytes > Math.min(limits.maxFileBytesWithoutApproval, limits.maxReadBytesPerRequest)) continue;
      if (scannedBytes + meta.bytes > limits.maxSearchBytes) { truncated = true; break; }
      const { buffer } = await readBounded(await safePath(root, meta.path),
        Math.min(limits.maxFileBytesWithoutApproval, limits.maxReadBytesPerRequest), signal);
      scannedBytes += buffer.length;
      if (hash(buffer) !== meta.sha256) throw new Error(`Workspace изменён посторонним процессом: ${meta.path}`);
      if (buffer.includes(0)) continue;
      let text;
      try { text = utf8.decode(buffer); } catch { continue; }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const index = lines[i].indexOf(request.query);
        if (index < 0) continue;
        const snippet = lines[i].slice(Math.max(0, index - 80), index + request.query.length + 80);
        const item = { path: meta.path, line: i + 1, snippet };
        if (matches.length >= limits.maxSearchResults || bytes(JSON.stringify({ matches: [...matches, item] })) + 256 > remainingBytes) {
          truncated = true; break;
        }
        matches.push(item);
      }
      if (truncated) break;
    }
    const result = { query: request.query, pathPrefix: prefix, matches, truncated, scannedBytes,
      note: 'Only small UTF-8 files were searched; a search result does not authorize editing.' };
    if (bytes(JSON.stringify(result)) > remainingBytes) throw new Error('Нет места в контексте для результатов поиска.');
    emit({ type: 'file.search', query: request.query, matches: matches.length, truncated });
    return result;
  }

  async function apply(changes) {
    ensureUsable();
    if (!Array.isArray(changes) || changes.length > limits.maxChangedFilesPerAttempt ||
        bytes(JSON.stringify(changes)) > limits.maxPatchBytesPerAttempt) throw new Error('Превышен лимит изменений попытки.');
    const seen = new Set(), prepared = [];
    let total = [...files.values()].reduce((sum, m) => sum + m.bytes, 0);
    for (const change of changes) {
      const rel = normalizePath(change.path);
      if (!allowed(rel) || seen.has(rel)) throw new Error(`Запрещённый или повторяющийся путь: ${rel}`);
      seen.add(rel);
      const filename = await safePath(root, rel, { missing: true });
      const existing = await statOrNull(filename);
      let before = null, after = null;
      if (change.operation === 'create_file') {
        if (existing || files.has(rel) || typeof change.content !== 'string' ||
            change.baseSha256 !== null || change.search !== null || change.replacement !== null) throw new Error(`Некорректное создание: ${rel}`);
        after = Buffer.from(change.content);
      } else if (['replace_text', 'delete_file'].includes(change.operation)) {
        if (!existing || !files.has(rel) || change.baseSha256 !== readHashes.get(rel) || change.content !== null) {
          throw new Error(`Для изменения нужен прочитанный файл и его текущий хеш: ${rel}`);
        }
        before = (await readBounded(filename, limits.maxSnapshotFileBytes, signal)).buffer;
        if (hash(before) !== change.baseSha256 || hash(before) !== files.get(rel).sha256) throw new Error(`Конфликт версии: ${rel}`);
        if (before.includes(0)) throw new Error(`Бинарные изменения запрещены: ${rel}`);
        const text = utf8.decode(before);
        if (change.operation === 'delete_file') {
          if (!config.policy.allowDelete || change.search !== null || change.replacement !== null) throw new Error(`Удаление запрещено политикой: ${rel}`);
        } else {
          if (typeof change.search !== 'string' || !change.search || typeof change.replacement !== 'string') throw new Error(`Некорректная замена: ${rel}`);
          const index = text.indexOf(change.search);
          if (index < 0 || text.indexOf(change.search, index + 1) !== -1) throw new Error(`search должен встречаться ровно один раз: ${rel}`);
          after = Buffer.from(text.slice(0, index) + change.replacement + text.slice(index + change.search.length));
        }
      } else throw new Error('Неизвестная операция изменения.');
      if (after && (after.length > limits.maxSnapshotFileBytes || after.includes(0))) throw new Error(`Результат слишком велик или содержит NUL: ${rel}`);
      total += (after?.length ?? 0) - (before?.length ?? 0);
      prepared.push({ rel, filename, before, after, operation: change.operation,
        mode: files.get(rel)?.mode ?? 0o644 });
    }
    if (total > limits.maxSnapshotBytes) throw new Error('Изменения превысили общий размер workspace.');
    for (const item of prepared) {
      if (item.operation === 'delete_file' || GUARDED.test(item.rel)) {
        const preview = `--- ${JSON.stringify(item.rel)} (before)\n+++ ${JSON.stringify(item.rel)} (after)\n` +
          diffHunk(item.before ? utf8.decode(item.before) : '', item.after ? utf8.decode(item.after) : '');
        if (bytes(preview) > limits.maxDiffBytes) throw new Error(`Защищённая правка слишком велика для полного просмотра: ${item.rel}`);
        const accepted = await approve({ type: item.operation === 'delete_file' ? 'delete' : 'guarded-edit',
          path: item.rel, operation: item.operation, reason: 'Удаление либо изменение тестов/конфигурации требует отдельного согласия.',
          preview, beforeSha256: item.before ? hash(item.before) : null, afterSha256: item.after ? hash(item.after) : null });
        if (!accepted) throw new Error(`Изменение отклонено: ${item.rel}`);
      }
    }
    const committed = [];
    try {
      for (const item of prepared) {
        aborted(signal);
        await parents(root, item.rel);
        await safePath(root, item.rel, { missing: true });
        if (item.before) {
          const current = (await readBounded(item.filename, limits.maxSnapshotFileBytes, signal)).buffer;
          if (hash(current) !== hash(item.before)) throw new Error(`Конфликт при применении: ${item.rel}`);
        } else if (await statOrNull(item.filename)) throw new Error(`Файл уже создан: ${item.rel}`);
        if (item.after) {
          const temp = path.join(path.dirname(item.filename), `.agent-stage-${randomUUID()}`);
          try {
            await writeNew(temp, item.after, 0o600 | (item.mode & 0o111));
            if (item.before) await rename(temp, item.filename);
            else { await link(temp, item.filename); await unlink(temp); }
          } finally { await rm(temp, { force: true }); }
        } else await unlink(item.filename);
        committed.push(item);
      }
    } catch (error) {
      try {
        for (const item of committed.reverse()) {
          if (item.before) {
            const temp = path.join(path.dirname(item.filename), `.agent-rollback-${randomUUID()}`);
            await writeNew(temp, item.before, 0o600 | (item.mode & 0o111));
            await rename(temp, item.filename);
          } else await rm(item.filename, { force: true });
        }
      } catch (rollbackError) { broken = true; throw new AggregateError([error, rollbackError], 'Не удалось полностью откатить workspace.'); }
      throw error;
    }
    for (const item of prepared) {
      if (item.after) files.set(item.rel, { path: item.rel, bytes: item.after.length, sha256: hash(item.after), mode: item.mode });
      else files.delete(item.rel);
      readHashes.delete(item.rel);
    }
    emit({ type: 'patch.applied', files: prepared.length });
    return prepared.map((item) => item.rel);
  }

  async function diff() {
    ensureUsable();
    const changed = [], blocks = [];
    let used = 0, truncated = false;
    for (const rel of [...new Set([...initial.keys(), ...files.keys()])].sort()) {
      const original = initial.get(rel), current = files.get(rel);
      if (original?.sha256 === current?.sha256) continue;
      const before = original ? (await readBounded(await safePath(base, rel), limits.maxSnapshotFileBytes, signal)).buffer : Buffer.alloc(0);
      const after = current ? (await readBounded(await safePath(root, rel), limits.maxSnapshotFileBytes, signal)).buffer : Buffer.alloc(0);
      if (original && hash(before) !== original.sha256 || current && hash(after) !== current.sha256) throw new Error(`Версия diff изменена: ${rel}`);
      const record = { path: rel, operation: !original ? 'create_file' : !current ? 'delete_file' : 'replace_text',
        baseSha256: original?.sha256 ?? null, newSha256: current?.sha256 ?? null, beforeBytes: before.length, afterBytes: after.length };
      changed.push(record);
      let block = `diff --git ${JSON.stringify(`a/${rel}`)} ${JSON.stringify(`b/${rel}`)}\n`;
      if (!original) block += `new file mode 100${(current.mode & 0o111) ? '755' : '644'}\n`;
      if (!current) block += `deleted file mode 100${(original.mode & 0o111) ? '755' : '644'}\n`;
      block += `--- ${original ? JSON.stringify(`a/${rel}`) : '/dev/null'}\n+++ ${current ? JSON.stringify(`b/${rel}`) : '/dev/null'}\n`;
      block += diffHunk(utf8.decode(before), utf8.decode(after));
      if (used + bytes(block) > limits.maxDiffBytes) { truncated = true; continue; }
      blocks.push(block); used += bytes(block);
    }
    return { files: changed, text: blocks.join(''), truncated, bytes: used };
  }

  async function fingerprint() {
    ensureUsable();
    const digest = createHash('sha256');
    let count = 0, total = 0;
    async function visit(dir, prefix = '') {
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        aborted(signal);
        if (++count > limits.maxScanEntries) throw new Error('Workspace превысил лимит записей.');
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        normalizePath(rel);
        const filename = path.join(dir, entry.name), st = await lstat(filename);
        if (st.isSymbolicLink()) throw new Error('В workspace появился симлинк.');
        digest.update(JSON.stringify([rel, st.mode & 0o777, st.isDirectory() ? 'directory' : 'file']));
        if (st.isDirectory()) await visit(filename, rel);
        else if (st.isFile()) {
          const { buffer } = await readBounded(filename, limits.maxSnapshotFileBytes, signal);
          total += buffer.length;
          if (total > limits.maxSnapshotBytes) throw new Error('Workspace превысил лимит размера.');
          digest.update(hash(buffer));
        } else throw new Error('В workspace появился специальный файл.');
      }
    }
    await visit(root);
    return digest.digest('hex');
  }

  async function publish() {
    ensureUsable();
    const report = await diff();
    if (report.truncated) throw new Error('Нельзя переносить изменения с усечённым diff.');
    if (!report.files.length) return [];
    const lockName = path.join(config.root, '.code-agent-apply.lock');
    const lock = await open(lockName, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    const prepared = [], committed = [], createdDirs = [];
    let rollbackFailed = false;
    try {
      await lock.writeFile(`${process.pid}\n`);
      // Validate the complete set against the initial source before touching any target.
      for (const change of report.files) {
        if (!allowed(change.path)) throw new Error(`Политика запрещает перенос: ${change.path}`);
        const filename = await safePath(config.root, change.path, { missing: true });
        const st = await statOrNull(filename);
        const old = initial.get(change.path);
        let before = null;
        if (old) {
          if (!st) throw new Error(`Исходный файл удалён: ${change.path}`);
          before = (await readBounded(filename, limits.maxSnapshotFileBytes, signal)).buffer;
          if (hash(before) !== old.sha256 || (st.mode & 0o777) !== old.mode) throw new Error(`Исходный проект изменён: ${change.path}`);
        } else if (st) throw new Error(`Исходный файл уже существует: ${change.path}`);
        const after = files.has(change.path) ? (await readBounded(await safePath(root, change.path), limits.maxSnapshotFileBytes, signal)).buffer : null;
        if (after && hash(after) !== change.newSha256) throw new Error('Рабочая копия изменилась перед переносом.');
        prepared.push({ rel: change.path, filename, before, after, mode: old?.mode ?? 0o644 });
      }
      for (const item of prepared) {
        aborted(signal);
        await parents(config.root, item.rel, createdDirs);
        await safePath(config.root, item.rel, { missing: true });
        if (item.before) {
          if (hash((await readBounded(item.filename, limits.maxSnapshotFileBytes, signal)).buffer) !== hash(item.before)) {
            throw new Error(`Конфликт при переносе: ${item.rel}`);
          }
        } else if (await statOrNull(item.filename)) throw new Error(`Файл создан другим процессом: ${item.rel}`);
        if (item.after) {
          const temp = path.join(path.dirname(item.filename), `.agent-publish-${randomUUID()}`);
          try {
            await writeNew(temp, item.after, item.mode);
            if (item.before) await rename(temp, item.filename);
            else { await link(temp, item.filename); await unlink(temp); }
          } finally { await rm(temp, { force: true }); }
        } else await unlink(item.filename);
        committed.push(item);
      }
      published = true;
      emit({ type: 'workspace.published', files: committed.length });
      return committed.map((item) => item.rel);
    } catch (error) {
      try {
        for (const item of committed.reverse()) {
          if (item.before) {
            const temp = path.join(path.dirname(item.filename), `.agent-restore-${randomUUID()}`);
            await writeNew(temp, item.before, item.mode);
            await rename(temp, item.filename);
          } else await rm(item.filename, { force: true });
        }
        for (const dir of createdDirs.reverse()) { try { await rmdir(dir); } catch (e) { if (!['ENOENT', 'ENOTEMPTY'].includes(e.code)) throw e; } }
      } catch (restoreError) {
        rollbackFailed = true; broken = true;
        throw new AggregateError([error, restoreError], `Перенос и откат не завершены; резервная копия сохранена в ${sessionDir}`);
      }
      throw error;
    } finally {
      await lock.close();
      // A failed rollback leaves the lock to force manual reconciliation.
      if (!rollbackFailed) await rm(lockName, { force: true });
    }
  }

  return { root, sessionDir, tree, read, search, apply, diff, fingerprint, publish,
    get broken() { return broken; },
    async dispose({ keep = false } = {}) { if (!keep && !broken) await rm(sessionDir, { recursive: true, force: true }); },
  };
}
