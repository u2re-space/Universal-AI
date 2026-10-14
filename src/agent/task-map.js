/**
 * Draft and filter read, edit, and scan marks from a project map's RAM tables.
 * An empty map, or a task with no hits, produces an empty draft.
 */
import path from 'node:path';

const EDIT_CAP = 12;
const READ_CAP = 20;
const SCAN_CAP = 40;
const ROLES = new Set(['read', 'edit', 'scan']);

function taskWords(task) {
  if (typeof task !== 'string') return [];
  return task.toLowerCase().split(/[^0-9a-zа-яё]+/i).filter((word) => word.length >= 3);
}

function containsWord(text, words) {
  return words.some((word) => text.includes(word));
}

function fileEntries(projectMap) {
  const files = projectMap?.files;
  if (!files || typeof files.entries !== 'function') return [];
  return [...files.entries()];
}

function isEditHit(filePath, record, words, task) {
  if (typeof task === 'string' && task.includes(filePath)) return true;
  const lower = String(filePath).toLowerCase();
  if (containsWord(lower, words) || lower.split('/').some((segment) => containsWord(segment, words))) return true;
  const symbols = Array.isArray(record?.symbols) ? record.symbols : [];
  return symbols.some((symbol) => typeof symbol?.name === 'string' && containsWord(symbol.name.toLowerCase(), words));
}

function takeSorted(paths, cap) {
  return paths.sort().slice(0, cap);
}

function marked(paths, role, reason) {
  return paths.map((filePath) => ({ path: filePath, role, reason }));
}

export function draftTaskMap(task, projectMap) {
  const entries = fileEntries(projectMap);
  const words = taskWords(task);
  const editPaths = takeSorted(
    entries.filter(([filePath, record]) => isEditHit(filePath, record, words, task)).map(([filePath]) => filePath),
    EDIT_CAP,
  );
  const editSet = new Set(editPaths);
  const importedByEdit = new Set();
  for (const filePath of editPaths) {
    const imports = projectMap.files.get(filePath)?.imports;
    if (!Array.isArray(imports)) continue;
    for (const imported of imports) {
      if (typeof imported === 'string') importedByEdit.add(imported);
    }
  }
  const readPaths = takeSorted(
    entries.filter(([filePath, record]) => {
      if (editSet.has(filePath)) return false;
      const imports = Array.isArray(record?.imports) ? record.imports : [];
      return imports.some((imported) => editSet.has(imported)) || importedByEdit.has(filePath);
    }).map(([filePath]) => filePath),
    READ_CAP,
  );
  const readSet = new Set(readPaths);
  const editDirs = new Set(editPaths.map((filePath) => path.posix.dirname(filePath)));
  const scanPaths = takeSorted(
    entries
      .filter(([filePath]) => !editSet.has(filePath) && !readSet.has(filePath) && editDirs.has(path.posix.dirname(filePath)))
      .map(([filePath]) => filePath),
    SCAN_CAP,
  );
  return {
    edit: marked(editPaths, 'edit', 'совпадение с задачей'),
    read: marked(readPaths, 'read', 'импорт рядом с правкой'),
    scan: marked(scanPaths, 'scan', 'тот же каталог'),
  };
}

export function filterTaskMap(entries, projectMap) {
  if (projectMap == null || !Array.isArray(entries)) return [];
  const files = projectMap.files;
  if (!files || typeof files.has !== 'function') return [];
  const kept = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (!ROLES.has(entry.role)) continue;
    if (typeof entry.path !== 'string' || !files.has(entry.path)) continue;
    if (typeof entry.reason !== 'string') continue;
    kept.push({ path: entry.path, role: entry.role, reason: entry.reason });
  }
  return kept;
}

function bulletList(header, empty, items) {
  if (!items.length) return empty;
  return [header, ...items.map((item) => `- ${item.role} ${item.path} — ${item.reason}`)].join('\n');
}

export function formatDraft(draft) {
  const edit = Array.isArray(draft?.edit) ? draft.edit : [];
  const read = Array.isArray(draft?.read) ? draft.read : [];
  const scan = Array.isArray(draft?.scan) ? draft.scan : [];
  return bulletList('Task map draft:', 'Task map draft: (empty)', [...edit, ...read, ...scan]);
}

export function formatMarks(marks) {
  return bulletList('Task map:', 'Task map: (empty)', Array.isArray(marks) ? marks : []);
}

export function formatScan(projectMap, marks) {
  if (!projectMap?.files || typeof projectMap.files.get !== 'function' || !Array.isArray(marks)) return '';
  const lines = [];
  for (const item of marks) {
    if (item?.role !== 'scan' || typeof item.path !== 'string') continue;
    const symbols = projectMap.files.get(item.path)?.symbols;
    if (!Array.isArray(symbols)) continue;
    for (const symbol of symbols) {
      if (!symbol || typeof symbol.name !== 'string' || typeof symbol.kind !== 'string') continue;
      lines.push(`${item.path}:${symbol.line}: ${symbol.kind} ${symbol.name}`);
    }
  }
  return lines.join('\n');
}
