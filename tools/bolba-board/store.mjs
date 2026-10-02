/**
 * bolba-board — SQLite storage layer.
 *
 * Zero external dependencies; uses node:sqlite (Node >= 22, experimental but
 * stable enough for a local board). No imports from sibling board modules:
 * server.mjs loads every module with an mtime-busting dynamic import and
 * injects dependencies, so nothing here may import ./validate.mjs etc.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 1;
export const STATUS_VALUES = ['open', 'waiting', 'delegated', 'done', 'completed', 'discarded'];
export const PENDING_STATUSES = ['open', 'waiting', 'delegated'];
export const COMPLETED_STATUSES = ['done', 'completed'];
export const TASK_FIELDS = [
  'title', 'status', 'proj', 'type', 'due', 'reg', 'done', 'notes',
  'from_person', 'priority', 'section', 'gmail', 'coti', 'origen', 'real_minutes',
];

const OPEN_RANK = "CASE status WHEN 'open' THEN 0 WHEN 'waiting' THEN 1 WHEN 'delegated' THEN 2 WHEN 'done' THEN 3 WHEN 'completed' THEN 4 ELSE 5 END";
const SELECT_TASK = `
  SELECT t.*,
    (SELECT COUNT(*) FROM events e WHERE e.task_id = t.id) AS timeline_count,
    (SELECT e.text FROM events e WHERE e.task_id = t.id ORDER BY e.id DESC LIMIT 1) AS last_event
  FROM tasks t`;

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function formatTs(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function shiftDays(days, from = new Date()) {
  const d = new Date(from.getTime());
  d.setDate(d.getDate() + days);
  return todayStr(d);
}

function foldText(s) {
  return String(s ?? '')
    .normalize('NFD')
    .split('')
    .filter((ch) => {
      const code = ch.codePointAt(0);
      return !(code >= 0x300 && code <= 0x36f);
    })
    .join('')
    .toLowerCase();
}

function likeFold(s) {
  return foldText(s);
}

/**
 * @param {{ dbPath?: string, counterPrefix?: string, log?: {warn: Function} }} opts
 */
export function openStore({ dbPath = ':memory:', counterPrefix = 'BOLBA', log } = {}) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'open',
      proj         TEXT NOT NULL DEFAULT '',
      type         TEXT NOT NULL DEFAULT '',
      due          TEXT NOT NULL DEFAULT '',
      reg          TEXT NOT NULL,
      done         TEXT NOT NULL DEFAULT '',
      notes        TEXT NOT NULL DEFAULT '',
      from_person  TEXT NOT NULL DEFAULT '',
      priority     TEXT NOT NULL DEFAULT '',
      section      TEXT NOT NULL DEFAULT '',
      gmail        TEXT NOT NULL DEFAULT '',
      coti         TEXT NOT NULL DEFAULT '',
      origen       TEXT NOT NULL DEFAULT '',
      real_minutes INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_done   ON tasks(done DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_due    ON tasks(due);
    CREATE INDEX IF NOT EXISTS idx_tasks_proj   ON tasks(proj);
    CREATE INDEX IF NOT EXISTS idx_tasks_coti   ON tasks(coti);
    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      ts         TEXT NOT NULL,
      text       TEXT NOT NULL,
      actor      TEXT NOT NULL DEFAULT '',
      kind       TEXT NOT NULL DEFAULT 'note',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, id);
  `);
  if (!getMeta('schema_version')) {
    setMeta('schema_version', String(SCHEMA_VERSION));
    setMeta('created_at', formatTs());
    setMeta('board_seq', '0');
  }

  function one(sql, params = []) {
    return db.prepare(sql).get(...params);
  }

  function all(sql, params = []) {
    return db.prepare(sql).all(...params);
  }

  function run(sql, params = []) {
    return db.prepare(sql).run(...params);
  }

  function getMeta(key) {
    const row = one('SELECT value FROM meta WHERE key = ?', [key]);
    return row ? row.value : undefined;
  }

  function setMeta(key, value) {
    run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)]);
  }

  function nextCounter() {
    const seq = Number(getMeta('board_seq') || 0) + 1;
    setMeta('board_seq', String(seq));
    return `${counterPrefix}-${String(seq).padStart(6, '0')}`;
  }

  function counter() {
    const seq = Number(getMeta('board_seq') || 0);
    return `${counterPrefix}-${String(seq).padStart(6, '0')}`;
  }

  function insertEvent(taskId, { ts, text, actor = '', kind = 'note' }, nowMs = Date.now()) {
    run('INSERT INTO events (task_id, ts, text, actor, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [taskId, ts, text, actor, kind, nowMs]);
  }

  function getRawTask(id) {
    return one('SELECT * FROM tasks WHERE id = ?', [id]);
  }

  function getTask(id) {
    return one(`${SELECT_TASK} WHERE t.id = ?`, [id]);
  }

  function eventsOf(id) {
    return all('SELECT * FROM events WHERE task_id = ? ORDER BY id ASC', [id]);
  }

  function ensureStatus(status) {
    return STATUS_VALUES.includes(status) ? status : 'open';
  }

  /**
   * Create a task, allocate its board counter and write the 🆕 timeline event.
   * @param {object} fields canonical field names (see TASK_FIELDS)
   */
  function createTask(fields, { actor = 'desconocido', now = new Date() } = {}) {
    const ts = formatTs(now);
    const nowMs = now.getTime();
    const status = ensureStatus(fields.status || 'open');
    const done = fields.done || (COMPLETED_STATUSES.includes(status) ? ts : '');
    const values = [
      fields.title,
      status,
      fields.proj || '',
      fields.type || '',
      fields.due || '',
      fields.reg || ts,
      done,
      fields.notes || '',
      fields.from_person || '',
      fields.priority || '',
      fields.section || '',
      fields.gmail || '',
      fields.coti || '',
      fields.origen || '',
      Number(fields.real_minutes) || 0,
      nowMs,
      nowMs,
    ];
    const info = run(`INSERT INTO tasks
      (title, status, proj, type, due, reg, done, notes, from_person, priority, section, gmail, coti, origen, real_minutes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, values);
    const id = Number(info.lastInsertRowid);
    nextCounter();
    insertEvent(id, { ts, text: `🆕 **创建** por ${actor}`, actor, kind: 'created' }, nowMs);
    return getTask(id);
  }

  /** Whitelist a patch object to updatable columns. Returns only present keys. */
  function pickPatch(patch) {
    const out = {};
    for (const field of TASK_FIELDS) {
      if (patch[field] !== undefined) out[field] = patch[field];
    }
    if (out.real_minutes !== undefined) out.real_minutes = Number(out.real_minutes) || 0;
    return out;
  }

  /**
   * Apply a partial update. Handles the status/done interplay and writes an
   * ✏️ event listing the changed fields. Returns { task, changed: string[] }.
   */
  function updateTask(id, patch, { actor = 'desconocido', now = new Date() } = {}) {
    const current = getRawTask(id);
    if (!current) return undefined;
    const wanted = pickPatch(patch);
    const ts = formatTs(now);
    const sets = [];
    const params = [];
    const changed = [];

    for (const [field, value] of Object.entries(wanted)) {
      const next = field === 'real_minutes' ? value : String(value ?? '');
      const prev = field === 'real_minutes' ? current[field] : current[field];
      if (next === prev) continue;
      sets.push(`${field} = ?`);
      params.push(next);
      changed.push(field);
    }

    if (changed.includes('status')) {
      const status = ensureStatus(wanted.status);
      if (COMPLETED_STATUSES.includes(status) && !current.done) {
        sets.push('done = ?');
        params.push(ts);
        changed.push('done');
      } else if (!COMPLETED_STATUSES.includes(status) && !changed.includes('done')) {
        if (current.done) {
          sets.push("done = ''");
          changed.push('done');
        }
      }
    }

    if (!changed.length) return { task: getTask(id), changed };

    sets.push('updated_at = ?');
    params.push(now.getTime());
    params.push(id);
    run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, params);
    insertEvent(id, {
      ts,
      text: `✏️ **更新** por ${actor} — campos: ${changed.filter((c) => c !== 'done').join(', ') || 'done'}`,
      actor,
      kind: 'updated',
    }, now.getTime());
    return { task: getTask(id), changed };
  }

  /** Close: status 'done' | 'completed' | 'discarded'. Returns { task, warning? }. */
  function closeTask(id, status, { actor = 'desconocido', now = new Date() } = {}) {
    const current = getRawTask(id);
    if (!current) return undefined;
    const ts = formatTs(now);
    if (status === 'discarded') {
      if (current.status === 'discarded') return { task: getTask(id), warning: 'la tarea ya estaba descartada' };
      run("UPDATE tasks SET status = 'discarded', updated_at = ? WHERE id = ?", [now.getTime(), id]);
      insertEvent(id, { ts, text: `🗑 **已废弃** por ${actor}`, actor, kind: 'discarded' }, now.getTime());
      return { task: getTask(id) };
    }
    if (COMPLETED_STATUSES.includes(current.status)) {
      return { task: getTask(id), warning: 'la tarea ya estaba cerrada' };
    }
    const target = status === 'completed' ? 'completed' : 'done';
    run('UPDATE tasks SET status = ?, done = ?, updated_at = ? WHERE id = ?', [target, ts, now.getTime(), id]);
    insertEvent(id, { ts, text: `✅ **完成** por ${actor}`, actor, kind: 'closed' }, now.getTime());
    return { task: getTask(id) };
  }

  /** Reopen a closed/discarded task back to 'open'. Returns { task, warning? }. */
  function reopenTask(id, { actor = 'desconocido', now = new Date() } = {}) {
    const current = getRawTask(id);
    if (!current) return undefined;
    const ts = formatTs(now);
    if (PENDING_STATUSES.includes(current.status)) {
      return { task: getTask(id), warning: 'la tarea no estaba cerrada' };
    }
    run("UPDATE tasks SET status = 'open', done = '', updated_at = ? WHERE id = ?", [now.getTime(), id]);
    insertEvent(id, { ts, text: `↩ **重开** por ${actor}`, actor, kind: 'reopened' }, now.getTime());
    return { task: getTask(id) };
  }

  function deleteTask(id) {
    const info = run('DELETE FROM tasks WHERE id = ?', [id]);
    return info.changes;
  }

  /**
   * Append timeline entries. Deduplicates on (ts, text) so re-importing a
   * markdown file cannot double-post the same event.
   * @param {Array<{ts: string, text: string}>} entries
   */
  function addEvents(id, entries, { actor = 'desconocido', kind = 'note', now = new Date() } = {}) {
    const task = getRawTask(id);
    if (!task) return undefined;
    let added = 0;
    for (const entry of entries) {
      const text = typeof entry === 'string' ? entry : entry && entry.text;
      // Entries without an explicit ts (plain strings) are stamped `now`;
      // SQLite cannot bind undefined, and the (ts, text) dedupe needs both.
      const ts = (entry && entry.ts) || formatTs(now);
      if (!text) continue;
      const dup = one('SELECT id FROM events WHERE task_id = ? AND ts = ? AND text = ? LIMIT 1', [id, ts, text]);
      if (dup) continue;
      insertEvent(id, { ts, text, actor, kind }, now.getTime());
      added += 1;
    }
    if (added) run('UPDATE tasks SET updated_at = ? WHERE id = ?', [now.getTime(), id]);
    return added;
  }

  /** Fetch tasks with structured filters applied in SQL, then text filters in JS. */
  function listTasks(filters = {}) {
    const where = [];
    const params = [];
    const statuses = Array.isArray(filters.statuses) && filters.statuses.length ? filters.statuses : null;

    if (statuses) {
      where.push(`t.status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    if (filters.scope === 'pending' || filters.scope === 'active') {
      where.push(`t.status IN (${PENDING_STATUSES.map(() => '?').join(', ')})`);
      params.push(...PENDING_STATUSES);
    } else if (filters.scope === 'done') {
      where.push(`t.status IN (${COMPLETED_STATUSES.map(() => '?').join(', ')})`);
      params.push(...COMPLETED_STATUSES);
    }
    if (filters.proj) {
      where.push('LOWER(t.proj) = LOWER(?)');
      params.push(filters.proj);
    }
    if (filters.type) {
      where.push('LOWER(t.type) = LOWER(?)');
      params.push(filters.type);
    }
    const today = todayStr();
    if (filters.due && typeof filters.due === 'object') {
      if (filters.due.mode === 'overdue') {
        where.push(`t.status IN (${PENDING_STATUSES.map(() => '?').join(', ')})`);
        params.push(...PENDING_STATUSES);
        where.push("t.due != '' AND t.due < ?");
        params.push(today);
      } else if (filters.due.mode === 'today') {
        where.push(`t.status IN (${PENDING_STATUSES.map(() => '?').join(', ')})`);
        params.push(...PENDING_STATUSES);
        where.push('t.due = ?');
        params.push(today);
      } else if (filters.due.mode === 'week') {
        where.push(`t.status IN (${PENDING_STATUSES.map(() => '?').join(', ')})`);
        params.push(...PENDING_STATUSES);
        where.push('t.due != \'\' AND t.due >= ? AND t.due <= ?');
        params.push(today, shiftDays(7));
      } else if (filters.due.mode === 'date') {
        where.push('t.due = ?');
        params.push(filters.due.date);
      }
    }
    if (filters.staleDays && filters.staleDays > 0) {
      where.push(`t.status IN (${PENDING_STATUSES.map(() => '?').join(', ')})`);
      params.push(...PENDING_STATUSES);
      const cutoff = Date.now() - filters.staleDays * 86400000;
      where.push('COALESCE((SELECT MAX(e.created_at) FROM events e WHERE e.task_id = t.id), t.created_at) < ?');
      params.push(cutoff);
    }

    const allCompleted = (statuses && statuses.every((s) => COMPLETED_STATUSES.includes(s))) || filters.scope === 'done';
    const orderBy = allCompleted
      ? 't.done DESC, t.id DESC'
      : `${OPEN_RANK} ASC, CASE WHEN t.due = '' THEN 1 ELSE 0 END ASC, t.due ASC, t.id DESC`;
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    let rows = all(`${SELECT_TASK}${whereSql} ORDER BY ${orderBy}`, params);

    // Text-ish filters that need diacritic-insensitive matching run in JS.
    if (filters.q) {
      const needle = likeFold(filters.q);
      rows = rows.filter((t) => [t.title, t.notes, t.proj, t.coti, t.from_person, t.type, t.origen]
        .some((v) => likeFold(v).includes(needle)));
    }
    if (filters.from) {
      const needle = likeFold(filters.from);
      rows = rows.filter((t) => likeFold(t.from_person).includes(needle));
    }
    if (filters.coti) {
      const needle = likeFold(filters.coti);
      rows = rows.filter((t) => likeFold(t.coti).includes(needle));
    }
    if (filters.scope === 'mine' && filters.mineActor) {
      const actor = likeFold(filters.mineActor);
      const touched = new Set();
      for (const row of all('SELECT task_id, actor FROM events')) {
        if (likeFold(row.actor) === actor) touched.add(Number(row.task_id));
      }
      rows = rows.filter((t) => likeFold(t.from_person).includes(actor) || touched.has(Number(t.id)));
    }

    const total = rows.length;
    const limit = Math.min(Math.max(1, Number(filters.limit) || 1000), 2000);
    const tasks = rows.slice(0, limit);
    return { total, tasks, truncated: total > limit };
  }

  /** Light rows for duplicate detection. */
  function allLight() {
    return all('SELECT id, title, proj, status FROM tasks');
  }

  function stats() {
    const byStatus = {};
    for (const s of STATUS_VALUES) byStatus[s] = 0;
    for (const row of all('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status')) {
      byStatus[row.status] = Number(row.n);
    }
    const openByProj = {};
    for (const row of all(`SELECT proj, COUNT(*) AS n FROM tasks
        WHERE status IN (${PENDING_STATUSES.map(() => '?').join(', ')})
        GROUP BY proj ORDER BY n DESC`, PENDING_STATUSES)) {
      openByProj[row.proj || '(sin proyecto)'] = Number(row.n);
    }
    const dueRow = one(`SELECT COUNT(*) AS n FROM tasks
      WHERE status IN (${PENDING_STATUSES.map(() => '?').join(', ')}) AND due != '' AND due <= ?`, [...PENDING_STATUSES, todayStr()]);
    return {
      by_status: byStatus,
      open_by_proj: openByProj,
      due_today_or_overdue: Number(dueRow.n),
      counter: counter(),
    };
  }

  function close() {
    try { db.close(); } catch { /* idempotent */ }
  }

  return {
    dbPath,
    getMeta,
    setMeta,
    counter,
    createTask,
    getTask,
    getRawTask,
    updateTask,
    closeTask,
    reopenTask,
    deleteTask,
    addEvents,
    listTasks,
    eventsOf,
    allLight,
    stats,
    close,
  };
}
