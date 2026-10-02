/**
 * bolba-board — endpoint handlers.
 *
 * Zero imports from sibling board modules: server.mjs hot-reloads each file
 * individually and injects { store, text, validate, dup, sync, config, log }.
 *
 * Every handler is `(req) => { status, body } | { status, text }`.
 * req = { params, query, body, actor, reimported, method, pathname }.
 * Errors are thrown as Error objects carrying `.http = { status, body }`.
 */

const CLOSE_STATUSES = ['done', 'completed', 'discarded'];

export function createHandlers(ctx) {
  const { store, text, validate, dup, sync, config, log } = ctx;

  function httpError(status, body) {
    const err = new Error(body && body.error ? body.error : `http error ${status}`);
    err.http = { status, body };
    return err;
  }

  function taskById(idRaw) {
    const id = Number.parseInt(idRaw, 10);
    const row = Number.isFinite(id) ? store.getTask(id) : undefined;
    if (!row) throw httpError(404, { error: `tarea ${idRaw} no encontrada` });
    return row;
  }

  function reimportedList(req) {
    return req.reimported ? [sync.basename] : [];
  }

  /** Mirror to disk after every mutation; a failing mirror must not break the API. */
  function safeExport() {
    try {
      sync.exportFile();
    } catch (err) {
      if (log && log.warn) log.warn(`bolba-board: export a markdown falló: ${err && err.message}`);
    }
  }

  function parseQuery(req) {
    const parsed = validate.normalizeQuery(req.query, { actor: req.actor });
    if (parsed.error) throw httpError(400, { error: parsed.error, valid: parsed.valid });
    return parsed;
  }

  function listTasks(req, { forceText = false } = {}) {
    const { filters, asText } = parseQuery(req);
    const { total, tasks, truncated } = store.listTasks(filters);
    if (asText || forceText) return { status: 200, text: text.tableText(tasks) };
    const body = { count: total, tasks: tasks.map((row) => text.toApiTask(row)), total };
    if (truncated) body.truncated = true;
    return { status: 200, body };
  }

  function getTask(req) {
    const row = taskById(req.params[0]);
    const events = store.eventsOf(row.id);
    if (req.query.get('as') === 'text') return { status: 200, text: text.taskText(row, events) };
    return {
      status: 200,
      body: {
        ...text.toApiTask(row),
        timeline: events.map((event) => `${event.ts} ${event.text}`),
        timeline_events: events.map((event) => ({ ts: event.ts, text: event.text, actor: event.actor, kind: event.kind })),
      },
    };
  }

  function createTask(req) {
    const body = validate.isRecord(req.body) ? req.body : {};
    const forceFlag = String(req.query.get('force') ?? '').toLowerCase();
    const force = forceFlag === 'true' || forceFlag === '1' || body.force === true;
    const normalized = validate.normalizeBody(body);
    if (normalized.error) throw httpError(400, { error: normalized.error, valid: normalized.valid });
    const warnings = normalized.warnings.slice();

    if (!force) {
      const candidates = dup.rankCandidates(normalized.fields.title, store.allLight());
      if (candidates.length) {
        throw httpError(409, {
          error: 'posible duplicado; revisa y reintenta con force=true o usa PATCH',
          candidates: candidates.map((c) => ({
            id: c.task.id,
            title: c.task.title,
            proj: c.task.proj,
            status: c.task.status,
            similarity: c.similarity,
            jaccard: c.jaccard,
            containment: c.containment,
          })),
        });
      }
    }

    const row = store.createTask(normalized.fields, { actor: req.actor });
    const timeline = validate.parseTimeline(body.timeline);
    warnings.push(...timeline.warnings);
    if (timeline.entries.length) store.addEvents(row.id, timeline.entries, { actor: req.actor });
    safeExport();
    return {
      status: 201,
      body: { id: row.id, task: text.toApiTask(store.getTask(row.id)), warnings, reimported: reimportedList(req) },
    };
  }

  function updateTask(req) {
    const row = taskById(req.params[0]);
    const body = validate.isRecord(req.body) ? req.body : {};
    const normalized = validate.normalizeBody(body, { partial: true });
    if (normalized.error) throw httpError(400, { error: normalized.error, valid: normalized.valid });
    const warnings = normalized.warnings.slice();

    const timeline = validate.parseTimeline(body.timeline);
    warnings.push(...timeline.warnings);
    const updated = store.updateTask(row.id, normalized.fields, { actor: req.actor });
    let added = 0;
    if (timeline.entries.length) added = store.addEvents(row.id, timeline.entries, { actor: req.actor });
    if (!updated.changed.length && !added) warnings.push('sin cambios');
    if (updated.changed.length || added) safeExport();
    return {
      status: 200,
      body: { task: text.toApiTask(store.getTask(row.id)), warnings, reimported: reimportedList(req) },
    };
  }

  function addTimeline(req) {
    const row = taskById(req.params[0]);
    const raw = Array.isArray(req.body) ? req.body : (validate.isRecord(req.body) ? req.body.timeline : undefined);
    if (raw === undefined) {
      throw httpError(400, { error: 'timeline es obligatorio (array de strings o {ts,text})', valid: ['timeline'] });
    }
    const timeline = validate.parseTimeline(raw);
    if (!timeline.entries.length) {
      throw httpError(400, { error: 'timeline no contiene entradas válidas', valid: ['timeline'] });
    }
    const added = store.addEvents(row.id, timeline.entries, { actor: req.actor });
    if (added) safeExport();
    const body = { task: text.toApiTask(store.getTask(row.id)), added, reimported: reimportedList(req) };
    if (timeline.warnings.length) body.warnings = timeline.warnings;
    return { status: 200, body };
  }

  function closeTask(req) {
    const row = taskById(req.params[0]);
    const body = validate.isRecord(req.body) ? req.body : {};
    const raw = body.status ?? req.query.get('status') ?? 'done';
    const status = validate.normalizeStatus(raw);
    if (!status || !CLOSE_STATUSES.includes(status)) {
      throw httpError(400, { error: `estado inválido para cerrar: ${raw}`, valid: CLOSE_STATUSES });
    }
    const result = store.closeTask(row.id, status, { actor: req.actor });
    safeExport();
    return {
      status: 200,
      body: {
        task: text.toApiTask(result.task),
        warnings: result.warning ? [result.warning] : [],
        reimported: reimportedList(req),
      },
    };
  }

  function reopenTask(req) {
    const row = taskById(req.params[0]);
    const result = store.reopenTask(row.id, { actor: req.actor });
    if (result.warning) return { status: 200, body: { task: text.toApiTask(result.task), warnings: [result.warning], reimported: reimportedList(req) } };
    safeExport();
    return { status: 200, body: { task: text.toApiTask(result.task), warnings: [], reimported: reimportedList(req) } };
  }

  function deleteTask(req) {
    const id = Number.parseInt(req.params[0], 10);
    const changes = Number.isFinite(id) ? store.deleteTask(id) : 0;
    if (!changes) throw httpError(404, { error: `tarea ${req.params[0]} no encontrada` });
    safeExport();
    return { status: 200, body: { deleted: id } };
  }

  function duplicates(req) {
    const title = req.query.get('title') ?? req.query.get('q');
    if (!title || !title.trim()) throw httpError(400, { error: 'title es obligatorio', valid: ['title'] });
    const candidates = dup.rankCandidates(title, store.allLight(), { limit: 8 });
    const tasks = [];
    for (const candidate of candidates) {
      const full = store.getTask(candidate.task.id);
      if (!full) continue;
      tasks.push({
        ...text.toApiTask(full),
        similarity: candidate.similarity,
        jaccard: candidate.jaccard,
        containment: candidate.containment,
      });
    }
    return { status: 200, body: { count: tasks.length, tasks, total: tasks.length } };
  }

  function statsTask() {
    return { status: 200, body: store.stats() };
  }

  function health() {
    return {
      status: 200,
      body: {
        ok: true,
        db: store.dbPath,
        drift: sync.drift(),
        stats: store.stats(),
        version: config.version,
        now: text.formatTs(),
      },
    };
  }

  function syncNow(req) {
    const force = String(req.query.get('force') ?? '').toLowerCase() !== '0';
    let imported = false;
    try {
      imported = sync.maybeImport({ force });
    } catch (err) {
      if (log && log.warn) log.warn(`bolba-board: sync falló: ${err && err.message}`);
    }
    return { status: 200, body: { ok: true, reimported: imported ? [sync.basename] : [], drift: sync.drift() } };
  }

  function configInfo() {
    return {
      status: 200,
      body: {
        ok: true,
        port: config.port,
        db: store.dbPath,
        md: config.mdPath,
        autosync: config.autosync,
        token_configured: !!config.token,
        version: config.version,
      },
    };
  }

  return {
    listTasks,
    searchTasks: listTasks,
    getTask,
    createTask,
    updateTask,
    addTimeline,
    closeTask,
    reopenTask,
    deleteTask,
    duplicates,
    statsTask,
    health,
    syncNow,
    configInfo,
    render: (req) => listTasks(req, { forceText: true }),
  };
}
