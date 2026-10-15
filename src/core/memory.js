/**
 * @file src/core/memory.js
 * @module core/memory
 * @purpose SQLite store for durable memories, file summaries, and finished tasks.
 * @depends node:path, node:crypto, node:fs, node:sqlite
 * @usedBy commands/shared, commands/memory, agent/team
 * @exports MEMORY_KINDS, MEMORY_SCOPES, projectKey, openMemory, renderMemories
 * @ai.tags memory, sqlite
 * @ai.hint io
 * @changed 2026-10-15 JSDoc card, 4-space indent.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const MEMORY_KINDS = ['fact', 'convention', 'decision', 'preference', 'pitfall', 'summary', 'note'];
export const MEMORY_SCOPES = ['global', 'project'];

/** Stable identifier of a project (its real root path). */
export function projectKey(root) {
    let real = path.resolve(root);
    try { real = realpathSync(real); } catch { /* keep the resolved path */ }
    if (process.platform === 'win32') real = real.toLowerCase();
    return createHash('sha1').update(real).digest('hex').slice(0, 16);
}

const now = () => new Date().toISOString();
const tagsToText = (tags) => (Array.isArray(tags) ? tags : String(tags ?? '').split(',')).map((t) => String(t).trim()).filter(Boolean).join(',');

/**
 * Build an FTS5 query: every word becomes a quoted prefix token joined with OR.
 * Longer words are shortened to a crude stem so inflected forms still match (тесты / тестом → "тест"*).
 */
function ftsQuery(text) {
    const words = String(text ?? '').toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [];
    const stems = words.map((w) => (w.length > 5 ? w.slice(0, Math.max(4, w.length - 2)) : w));
    const unique = [...new Set(stems)].slice(0, 24);
    return unique.map((w) => `"${w.replaceAll('"', '')}"*`).join(' OR ');
}

/**
 * Long-term memory in SQLite (node:sqlite, bundled with Node ≥ 22.5; no dependencies).
 *
 *   memories       — durable facts / conventions / decisions, global or per project, FTS5-searchable
 *   file_summaries — cache of model-written file summaries keyed by content hash
 *   tasks          — history of completed runs (task, status, summary, changes, usage)
 */
export function openMemory({ file }) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
    db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY, scope TEXT NOT NULL, project TEXT, project_name TEXT, kind TEXT NOT NULL,
      content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', source TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 0,
      UNIQUE(scope, project, content)
    );
    CREATE TABLE IF NOT EXISTS file_summaries (
      project TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, summary TEXT NOT NULL, model TEXT,
      created_at TEXT NOT NULL, PRIMARY KEY (project, path)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY, project TEXT, project_name TEXT, task TEXT NOT NULL, status TEXT NOT NULL,
      summary TEXT, changes TEXT, usage TEXT, created_at TEXT NOT NULL
    );
  `);
    let fts = true;
    try {
        db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tags, content='memories', content_rowid='id', tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.id, old.content, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.id, old.content, old.tags);
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
      END;
    `);
    } catch { fts = false; }

    const statements = {
        insert: db.prepare(`INSERT INTO memories (scope, project, project_name, kind, content, tags, source, created_at, updated_at)
      VALUES ($scope, $project, $projectName, $kind, $content, $tags, $source, $now, $now)
      ON CONFLICT(scope, project, content) DO UPDATE SET kind = excluded.kind, tags = excluded.tags, updated_at = excluded.updated_at
      RETURNING id`),
        byId: db.prepare('SELECT * FROM memories WHERE id = ?'),
        forget: db.prepare('DELETE FROM memories WHERE id = ?'),
        touch: db.prepare('UPDATE memories SET uses = uses + 1 WHERE id = ?'),
        fileGet: db.prepare('SELECT * FROM file_summaries WHERE project = ? AND path = ?'),
        filePut: db.prepare(`INSERT INTO file_summaries (project, path, sha256, summary, model, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, path) DO UPDATE SET sha256 = excluded.sha256, summary = excluded.summary, model = excluded.model, created_at = excluded.created_at`),
        taskInsert: db.prepare('INSERT INTO tasks (project, project_name, task, status, summary, changes, usage, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    };

    /**
     * SQL fragment that limits rows to one project, global rows, or both.
     * @param {string|null} project
     * @param {{ includeGlobal?: boolean }} [options]
     * @returns {{ sql: string, params: object }}
     * @ai.hint pure
     */
    function scopeFilter(project, { includeGlobal = true } = {}) {
        if (!project) return { sql: includeGlobal ? "m.scope = 'global'" : '0', params: {} };
        return { sql: includeGlobal ? "(m.scope = 'global' OR (m.scope = 'project' AND m.project = $project))" : "(m.scope = 'project' AND m.project = $project)", params: { $project: project } };
    }

    /**
     * Insert a memory or refresh kind, tags, and updated_at when the same content already exists.
     * @param {{ scope?: string, project?: string|null, projectName?: string|null, kind?: string, content: string, tags?: string[]|string, source?: string|null }} entry
     * @returns {object}
     * @ai.hint io
     */
    function remember({ scope = 'project', project = null, projectName = null, kind = 'fact', content, tags = [], source = null }) {
        if (!MEMORY_SCOPES.includes(scope)) throw new Error(`scope: ${MEMORY_SCOPES.join(' | ')}`);
        if (!MEMORY_KINDS.includes(kind)) kind = 'note';
        const text = String(content ?? '').trim().replace(/\s+/g, ' ');
        if (!text) throw new Error('Пустая запись памяти.');
        if (text.length > 2000) throw new Error('Запись памяти длиннее 2000 символов.');
        if (scope === 'project' && !project) throw new Error('Для scope=project нужен идентификатор проекта.');
        const row = statements.insert.get({ $scope: scope, $project: scope === 'project' ? project : null, $projectName: projectName,
            $kind: kind, $content: text, $tags: tagsToText(tags), $source: source, $now: now() });
        return statements.byId.get(row.id);
    }

    /** Full-text (FTS5) or LIKE-based recall of memories relevant to a query. */
    function recall(query, { project = null, limit = 8, includeGlobal = true } = {}) {
        const filter = scopeFilter(project, { includeGlobal });
        let rows = [];
        const match = fts ? ftsQuery(query) : '';
        if (match) {
            try {
                rows = db.prepare(`SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts f JOIN memories m ON m.id = f.rowid
          WHERE memories_fts MATCH $match AND ${filter.sql} ORDER BY rank LIMIT $limit`).all({ ...filter.params, $match: match, $limit: limit });
            } catch { rows = []; }
        }
        if (!rows.length) {
            const words = [...new Set(String(query ?? '').toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [])].slice(0, 12);
            if (!words.length) return [];
            const score = words.map((_, i) => `(CASE WHEN instr(lower(m.content), $w${i}) > 0 THEN 1 ELSE 0 END)`).join(' + ');
            const params = Object.fromEntries(words.map((w, i) => [`$w${i}`, w]));
            rows = db.prepare(`SELECT m.*, (${score}) AS hits FROM memories m WHERE ${filter.sql} AND (${score}) > 0 ORDER BY hits DESC, uses DESC LIMIT $limit`)
                .all({ ...filter.params, ...params, $limit: limit });
        }
        for (const row of rows) statements.touch.run(row.id);
        return rows.map(({ rank, hits, ...row }) => row);
    }

    /**
     * Newest memories first, optionally filtered by project, scope, and kind.
     * @param {{ project?: string|null, scope?: string|null, kind?: string|null, limit?: number, includeGlobal?: boolean }} [options]
     * @returns {object[]}
     * @ai.hint io
     */
    function list({ project = null, scope = null, kind = null, limit = 200, includeGlobal = true } = {}) {
        const filter = scopeFilter(project, { includeGlobal });
        const where = [filter.sql];
        const params = { ...filter.params, $limit: limit };
        if (scope) { where.push('m.scope = $scope'); params.$scope = scope; }
        if (kind) { where.push('m.kind = $kind'); params.$kind = kind; }
        return db.prepare(`SELECT m.* FROM memories m WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT $limit`).all(params);
    }

    /**
     * Delete one memory by id. Returns false when no row matched.
     * @param {number|string} id
     * @returns {boolean}
     * @ai.hint io
     */
    function forget(id) { return statements.forget.run(Number(id)).changes > 0; }

    /**
     * Delete every global memory, or every memory of one project. Returns the row count.
     * @param {{ project?: string|null, scope?: string }} [options]
     * @returns {number}
     * @ai.hint io
     */
    function clear({ project = null, scope = 'project' } = {}) {
        if (scope === 'global') return db.prepare("DELETE FROM memories WHERE scope = 'global'").run().changes;
        if (!project) throw new Error('Для очистки памяти проекта нужен идентификатор проекта.');
        return db.prepare("DELETE FROM memories WHERE scope = 'project' AND project = ?").run(project).changes;
    }

    /**
     * Cached file summary when the stored hash still matches.
     * @param {string} project
     * @param {string} relPath
     * @param {string} sha256
     * @returns {object|null}
     * @ai.hint io
     */
    function getFileSummary(project, relPath, sha256) {
        const row = statements.fileGet.get(project, relPath);
        return row && row.sha256 === sha256 ? row : null;
    }
    /**
     * Store or replace the summary for one project path.
     * @param {string} project
     * @param {string} relPath
     * @param {string} sha256
     * @param {string} summary
     * @param {string|null} [model]
     * @returns {void}
     * @ai.hint io
     */
    function putFileSummary(project, relPath, sha256, summary, model = null) {
        statements.filePut.run(project, relPath, sha256, summary, model, now());
    }

    /**
     * Append one finished run. Changes and usage are stored as JSON text.
     * @param {{ project?: string|null, projectName?: string|null, task: string, status: string, summary?: string|null, changes?: object[], usage?: object|null }} entry
     * @returns {void}
     * @ai.hint io
     */
    function recordTask({ project = null, projectName = null, task, status, summary = null, changes = [], usage = null }) {
        statements.taskInsert.run(project, projectName, String(task).slice(0, 4000), status, summary ? String(summary).slice(0, 8000) : null,
            JSON.stringify(changes ?? []), usage ? JSON.stringify(usage) : null, now());
    }
    /**
     * Newest tasks first, optionally for one project.
     * @param {{ project?: string|null, limit?: number }} [options]
     * @returns {object[]}
     * @ai.hint io
     */
    function listTasks({ project = null, limit = 20 } = {}) {
        return project
            ? db.prepare('SELECT * FROM tasks WHERE project = ? ORDER BY id DESC LIMIT ?').all(project, limit)
            : db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT ?').all(limit);
    }

    /**
     * Row counts and whether the FTS5 index exists.
     * @returns {{ memories: number, global: number, projects: number, fileSummaries: number, tasks: number, fts: boolean, file: string }}
     * @ai.hint io
     */
    function stats() {
        return {
            memories: db.prepare('SELECT COUNT(*) AS n FROM memories').get().n,
            global: db.prepare("SELECT COUNT(*) AS n FROM memories WHERE scope = 'global'").get().n,
            projects: db.prepare("SELECT COUNT(DISTINCT project) AS n FROM memories WHERE scope = 'project'").get().n,
            fileSummaries: db.prepare('SELECT COUNT(*) AS n FROM file_summaries').get().n,
            tasks: db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,
            fts, file,
        };
    }

    return {
        remember, recall, list, forget, clear, getFileSummary, putFileSummary, recordTask, listTasks, stats,
        close: () => db.close(),
        /**
         * Whether the FTS5 index was created for this database.
         * @returns {boolean}
         * @ai.hint pure
         */
        get fts() { return fts; },
    };
}

/** Render memories as a compact bulleted block for prompts. */
export function renderMemories(rows) {
    return rows.map((row) => `- [${row.scope === 'global' ? 'global' : 'project'}/${row.kind}#${row.id}] ${row.content}${row.tags ? ` (теги: ${row.tags})` : ''}`).join('\n');
}
