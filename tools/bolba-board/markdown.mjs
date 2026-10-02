/**
 * bolba-board — bidirectional Markdown mirror ("Tareas.md").
 *
 * Export: full rewrite after every mutation (all tasks except discarded,
 * in board order). Import: lazy — checked against the file mtime on every
 * request, or forced via POST /sync.
 *
 * Import rules:
 *  - `id::` matches an existing task -> apply changed fields / status only
 *  - no `id::` or unknown id          -> create a new task
 *  - block removed from the file      -> NOT deleted, reported in `drift`
 *                                        (delete via the `[-]` checkbox or API)
 *  - timeline lines                   -> appended, deduped on (ts, text)
 *  - `[x]` checked / unchecked / `[-]` drive done / reopen / discard
 *  - multi-line notes travel as the two-character escape \n
 *
 * Zero imports from sibling board modules — store/text/validate are injected
 * by server.mjs so each file can be hot-reloaded individually.
 */

import fs from 'node:fs';
import path from 'node:path';

const BLOCK_START_RE = /^-\s+\[(.)\]\s+(.*)$/;
const FIELD_RE = /^\s+-\s+([A-Za-z_][A-Za-z0-9_]*)::\s?(.*)$/;
const TIMELINE_RE = /^\s+-\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s+(.+)$/;
const ERROR_CAP = 20;
const DRIFT_CAP = 30;

function escapeNewlines(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/\n/g, '\\n');
}

function unescapeNewlines(value) {
  return String(value ?? '').replace(/\\n/g, '\n');
}

function stripLeadingEmoji(value) {
  const chars = Array.from(String(value ?? ''));
  const isEmojiChar = (ch) => ch === '️' || ch === '‍' || ch === '⃣'
    || /[☀-➿⬀-⯿]/u.test(ch)
    || /\p{Extended_Pictographic}/u.test(ch);
  let i = 0;
  while (i < chars.length && (isEmojiChar(chars[i]) || chars[i] === ' ')) i += 1;
  return chars.slice(i).join('');
}

/** Extract the title from a block's checkbox line. */
function extractTitle(headerRest) {
  const s = String(headerRest ?? '').trim();
  const first = s.indexOf('**');
  const last = s.lastIndexOf('**');
  if (first !== -1 && last > first + 1) return s.slice(first + 2, last).trim();
  let t = stripLeadingEmoji(s);
  const dash = t.lastIndexOf(' — ');
  if (dash !== -1) t = t.slice(dash + 3);
  return stripLeadingEmoji(t).trim();
}

/** Parse the file into task blocks + unrecognized-line errors. */
export function parseBlocks(content) {
  const lines = String(content ?? '').split(/\r?\n/);
  const blocks = [];
  const errors = [];
  let current = null;
  for (const line of lines) {
    const start = BLOCK_START_RE.exec(line);
    if (start) {
      current = { checkbox: start[1].trim() || ' ', headerRest: start[2], fields: {}, timeline: [] };
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    if (!line.trim()) continue;
    const field = FIELD_RE.exec(line);
    if (field) {
      current.fields[field[1].toLowerCase()] = field[2].trim();
      continue;
    }
    const event = TIMELINE_RE.exec(line);
    if (event) {
      current.timeline.push({ ts: `${event[1]}-${event[2]}-${event[3]} ${event[4]}:${event[5]}`, text: event[6].trim() });
      continue;
    }
    if (/^\s+-\s+/.test(line) && errors.length < ERROR_CAP) {
      errors.push(`línea no reconocida: ${line.trim().slice(0, 80)}`);
    }
  }
  return { blocks, errors };
}

export function createSync({ store, text, validate, mdPath, enabled = true, log = console }) {
  const basename = path.basename(mdPath);
  let drift = [];

  function pushDrift(message) {
    if (drift.length < DRIFT_CAP) drift.push(message);
  }

  function checkboxOf(block) {
    if (block.checkbox === 'x' || block.checkbox === 'X') return 'x';
    return block.checkbox === '-' ? '-' : ' ';
  }

  /** Decide the intended status for a block (checkbox edits win over status::). */
  function desiredStatus(block, current) {
    const cb = checkboxOf(block);
    if (current) {
      const currentCb = text.checkbox(current.status);
      if (cb !== currentCb) return cb === 'x' ? 'done' : cb === '-' ? 'discarded' : 'open';
    }
    const fromField = validate.normalizeStatus(block.fields.status);
    if (fromField) return fromField;
    return cb === 'x' ? 'done' : cb === '-' ? 'discarded' : 'open';
  }

  function applyStatus(id, block, current) {
    const desired = desiredStatus(block, current);
    if (!desired || desired === current.status) return false;
    const isClosed = current.status === 'done' || current.status === 'completed';
    if (desired === 'done' || desired === 'completed') {
      if (current.status === 'discarded') store.reopenTask(id, { actor: 'archivo' });
      store.closeTask(id, desired, { actor: 'archivo' });
    } else if (desired === 'discarded') {
      store.closeTask(id, 'discarded', { actor: 'archivo' });
    } else {
      if (isClosed || current.status === 'discarded') store.reopenTask(id, { actor: 'archivo' });
      if (desired !== 'open') store.updateTask(id, { status: desired }, { actor: 'archivo' });
    }
    return true;
  }

  /** Map block fields onto store columns (shared by patch + create). */
  function fieldPatch(block, { skipDone = false } = {}) {
    const patch = {};
    const title = extractTitle(block.headerRest);
    if (title) patch.title = title;
    for (const [key, value] of Object.entries(block.fields)) {
      switch (key) {
        case 'proj': patch.proj = value; break;
        case 'type': case 'tipo': patch.type = value; break;
        case 'due': {
          const normalized = value === '-' || !value ? '' : validate.normalizeDate(value);
          if (normalized !== undefined) patch.due = normalized;
          break;
        }
        case 'reg': {
          const normalized = validate.normalizeTs(value);
          if (normalized) patch.reg = normalized;
          break;
        }
        case 'done': {
          if (!skipDone) patch.done = value === '-' || !value ? '' : (validate.normalizeTs(value) || '');
          break;
        }
        case 'notes': case 'notas': patch.notes = unescapeNewlines(value); break;
        case 'priority': case 'prioridad': patch.priority = value; break;
        case 'section': case 'seccion': patch.section = value; break;
        case 'gmail': patch.gmail = value; break;
        case 'coti': patch.coti = value; break;
        case 'origen': patch.origen = value; break;
        case 'from': case 'desde': case 'from_person': patch.from_person = value; break;
        case 'real': case 'real_minutes': patch.real_minutes = Number.parseInt(value, 10) || 0; break;
        default: break; // id/status/timeline handled elsewhere
      }
    }
    return patch;
  }

  function createFromBlock(block) {
    const patch = fieldPatch(block);
    if (!patch.title) {
      pushDrift('bloque sin título ignorado');
      return undefined;
    }
    patch.status = desiredStatus(block, null);
    const row = store.createTask(patch, { actor: 'archivo' });
    if (block.timeline.length) store.addEvents(row.id, block.timeline, { actor: 'archivo' });
    return row;
  }

  /** Apply a parsed file. Returns true when anything changed. */
  function importBlocks(blocks, errors) {
    let changed = false;
    drift = errors.slice();
    const seenIds = new Set();

    for (const block of blocks) {
      const idRaw = block.fields.id;
      const id = idRaw !== undefined ? Number.parseInt(idRaw, 10) : Number.NaN;
      const current = Number.isFinite(id) ? store.getRawTask(id) : undefined;
      if (current) {
        seenIds.add(id);
        const statusChanged = applyStatus(id, block, current);
        if (statusChanged) changed = true;
        const result = store.updateTask(id, fieldPatch(block, { skipDone: statusChanged }), { actor: 'archivo' });
        if (result && result.changed.length) changed = true;
        if (block.timeline.length) {
          const added = store.addEvents(id, block.timeline, { actor: 'archivo' });
          if (added) changed = true;
        }
      } else {
        if (Number.isFinite(id)) pushDrift(`id ${id} no existe en el tablero; el bloque se crea como tarea nueva`);
        const created = createFromBlock(block);
        if (created) {
          seenIds.add(created.id);
          changed = true;
        }
      }
    }

    for (const row of store.listTasks({ limit: 2000 }).tasks) {
      if (row.status === 'discarded') continue;
      if (!seenIds.has(row.id)) {
        pushDrift(`id ${row.id} «${text.singleLine(row.title).slice(0, 40)}» no está en el archivo (no se elimina automáticamente)`);
      }
    }
    return changed;
  }

  function formatBlock(row, events) {
    const lines = [text.headFor(row)];
    const field = (key, value) => {
      if (value !== undefined && value !== null && String(value).length) lines.push(`  - ${key}:: ${text.singleLine(value)}`);
    };
    field('id', row.id);
    field('status', row.status);
    field('proj', row.proj);
    field('type', row.type);
    lines.push(`  - due:: ${row.due || '-'}`);
    field('reg', row.reg);
    lines.push(`  - done:: ${row.done || '-'}`);
    field('prioridad', row.priority);
    field('coti', row.coti);
    field('desde', row.from_person);
    field('section', row.section);
    field('gmail', row.gmail);
    field('origen', row.origen);
    if (row.real_minutes) lines.push(`  - real:: ${row.real_minutes}m`);
    if (row.notes) lines.push(`  - notas:: ${escapeNewlines(row.notes)}`);
    for (const event of events) lines.push(`  - ${event.ts} ${text.singleLine(event.text)}`);
    return lines.join('\n');
  }

  /** Full rewrite from the database. */
  function exportFile() {
    if (!enabled) return;
    const rows = store.listTasks({ limit: 2000 }).tasks.filter((row) => row.status !== 'discarded');
    const parts = ['# Tareas', ''];
    for (const row of rows) parts.push(formatBlock(row, store.eventsOf(row.id)));
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    const tmp = `${mdPath}.tmp`;
    fs.writeFileSync(tmp, `${parts.join('\n')}\n`, 'utf8');
    fs.renameSync(tmp, mdPath);
    try {
      store.setMeta('md_written_ms', String(Math.floor(fs.statSync(mdPath).mtimeMs)));
    } catch { /* stamp is best-effort */ }
  }

  /** Lazy import: only when the file changed since our last write (or forced). */
  function maybeImport({ force = false } = {}) {
    if (!enabled) return false;
    let stat;
    try {
      stat = fs.statSync(mdPath);
    } catch {
      if (!store.getMeta('md_written_ms')) {
        try { exportFile(); } catch (err) { if (log && log.warn) log.warn(`bolba-board: no se pudo crear ${basename}: ${err && err.message}`); }
      }
      return false;
    }
    const stamp = Number(store.getMeta('md_written_ms') || 0);
    if (!force && stat.mtimeMs <= stamp + 1) return false;

    let content;
    try {
      content = fs.readFileSync(mdPath, 'utf8');
    } catch (err) {
      drift = [`no se pudo leer el archivo: ${err && err.message}`];
      return false;
    }
    let changed = false;
    try {
      const { blocks, errors } = parseBlocks(content);
      changed = importBlocks(blocks, errors);
    } catch (err) {
      drift = [`error al importar: ${err && err.message}`];
      if (log && log.warn) log.warn(`bolba-board: error al importar ${basename}: ${err && err.message}`);
      return false;
    }
    if (changed) {
      try { exportFile(); } catch (err) { if (log && log.warn) log.warn(`bolba-board: no se pudo reescribir ${basename}: ${err && err.message}`); }
    } else {
      store.setMeta('md_written_ms', String(Math.floor(stat.mtimeMs)));
    }
    return changed;
  }

  return {
    basename,
    filePath: mdPath,
    enabled,
    maybeImport,
    exportFile,
    drift: () => drift.slice(),
  };
}
