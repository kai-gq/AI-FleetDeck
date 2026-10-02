/**
 * bolba-board — contract self-test (zero dependencies).
 *
 *   node --test tools/bolba-board/test.mjs
 *
 * Boots the real server on an ephemeral port (port 0) over a throwaway
 * SQLite file + Tareas.md, and drives it over real HTTP.
 */

import test, { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { startBoard } from './server.mjs';

// The TC client (bolbaTasksOutput.ts) parses `as=text` with exactly these.
const HEADER_RE = /^id\s+proj\s+status\s+due/;
const ROW_RE = /^(\d+)\s+(\S+)\s+(\S+)\s+(\S+(?:\s\d{2}:\d{2})?|-)\s+(\S+)\s+(.*)$/;
const CLIENT_STATUSES = new Set(['open', 'waiting', 'delegated', 'done', 'discarded']);

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeClient(base, { token = 'abcd', actor = 'test' } = {}) {
  return async function call(method, url, { body, raw, skipAuth = false, bearer, token: tokenOverride } = {}) {
    const headers = { 'X-Actor': actor };
    if (!skipAuth) headers['X-Auth-Token'] = tokenOverride === undefined ? token : tokenOverride;
    if (bearer) headers.Authorization = bearer;
    if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + url, {
      method,
      headers,
      body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, text, type: res.headers.get('content-type') || '' };
  };
}

const silent = { info() {}, warn() {}, error() {} };

describe('bolba-board HTTP contract', () => {
  const dir = tempDir('bolba-test-');
  const dbPath = path.join(dir, 'board.db');
  const mdPath = path.join(dir, 'Tareas.md');
  let server;
  let call;

  before(async () => {
    server = await startBoard({ port: 0, token: 'abcd', dbPath, mdPath, log: silent });
    call = makeClient(server.url);
  });

  after(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('GET /health responde sin token', async () => {
    const r = await fetch(`${server.url}/health`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.db, dbPath);
    assert.ok(Array.isArray(body.drift));
    assert.ok(body.stats.by_status);
  });

  it('rechaza token ausente o inválido y acepta bearer', async () => {
    assert.equal((await call('GET', '/tasks', { skipAuth: true })).status, 401);
    assert.equal((await call('GET', '/tasks', { token: 'nope' })).status, 401);
    const r = await call('GET', '/stats', { skipAuth: true, bearer: 'Bearer abcd' });
    assert.equal(r.status, 200);
  });

  it('tablero vacío: JSON y tabla solo cabecera', async () => {
    const r = await call('GET', '/tasks');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { count: 0, tasks: [], total: 0 });
    const table = await call('GET', '/tasks?as=text');
    assert.equal(table.type.startsWith('text/plain'), true);
    const lines = table.text.split('\n');
    assert.equal(lines.length, 1);
    assert.match(lines[0].trim(), HEADER_RE);
  });

  it('POST /tasks crea y refleja en markdown', async () => {
    const r = await call('POST', '/tasks', { body: { title: 'Revisar certificado ALT-19309', proj: 'ALT', due: '2026-10-10' } });
    assert.equal(r.status, 201);
    assert.equal(r.json.id, 1);
    assert.equal(r.json.task.proj, 'ALT');
    assert.match(r.json.task.head, /^- \[ \] /);
    assert.deepEqual(r.json.reimported, []);
    assert.ok(fs.existsSync(mdPath));
  });

  it('duplicado: 409 con candidatos, force lo salta', async () => {
    const conflict = await call('POST', '/tasks', { body: { title: 'revisar certificado alt-19309' } });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.candidates[0].id, 1);
    assert.equal(typeof conflict.json.candidates[0].similarity, 'number');
    const forced = await call('POST', '/tasks?force=true', { body: { title: 'revisar certificado alt-19309' } });
    assert.equal(forced.status, 201);
    assert.equal(forced.json.id, 2);
  });

  it('PATCH aplica campos, normaliza fecha y avisa sin cambios', async () => {
    const r = await call('PATCH', '/tasks/1', { body: { status: 'esperando', due: '2026/11/03', notas: 'linea1\nlinea2' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.task.status, 'waiting');
    assert.equal(r.json.task.due, '2026-11-03');
    assert.equal(r.json.task.notes, 'linea1\nlinea2');
    const same = await call('PATCH', '/tasks/1', { body: {} });
    assert.ok(same.json.warnings.includes('sin cambios'));
  });

  it('timeline: agrega con dedupe y exige el campo', async () => {
    const r = await call('POST', '/tasks/1/timeline', {
      body: { timeline: ['nota manual', { ts: '2026-10-01 10:00', text: 'evento con fecha' }, 'nota manual'] },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.added, 2);
    const missing = await call('POST', '/tasks/1/timeline', { body: {} });
    assert.equal(missing.status, 400);
    assert.ok(Array.isArray(missing.json.valid));
  });

  it('GET /tasks/:id incluye timeline y timeline_events', async () => {
    const r = await call('GET', '/tasks/1');
    assert.equal(r.status, 200);
    assert.equal(r.json.timeline.length, 4);
    assert.equal(r.json.timeline_events.length, 4);
    assert.equal(r.json.timeline_events[1].kind, 'updated');
  });

  it('close/reopen con sus avisos y validación de estado', async () => {
    const done = await call('POST', '/tasks/1/close', { body: {} });
    assert.equal(done.json.task.status, 'done');
    assert.match(done.json.task.done, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    const again = await call('POST', '/tasks/1/close', { body: {} });
    assert.ok(again.json.warnings.includes('la tarea ya estaba cerrada'));
    const reopened = await call('POST', '/tasks/1/reopen', { body: {} });
    assert.equal(reopened.json.task.status, 'open');
    assert.equal(reopened.json.task.done, '');
    const twice = await call('POST', '/tasks/1/reopen', { body: {} });
    assert.ok(twice.json.warnings.includes('la tarea no estaba cerrada'));
    const bad = await call('POST', '/tasks/1/close', { body: { status: 'basura' } });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json.valid, ['done', 'completed', 'discarded']);
    const alias = await call('POST', '/tasks/1/close', { body: { status: 'descartada' } });
    assert.equal(alias.json.task.status, 'discarded');
    const done2 = await call('POST', '/tasks/2/close', { body: {} });
    assert.equal(done2.json.task.status, 'done');
  });

  it('404 en toda acción sobre ids inexistentes', async () => {
    const cases = [
      ['GET', '/tasks/999'], ['PATCH', '/tasks/999', { title: 'x' }], ['DELETE', '/tasks/999'],
      ['POST', '/tasks/999/close', {}], ['POST', '/tasks/999/reopen'], ['POST', '/tasks/999/timeline', { timeline: ['x'] }],
    ];
    for (const [method, url, body] of cases) {
      const r = await call(method, url, { body });
      assert.equal(r.status, 404, `${method} ${url}`);
      assert.match(r.json.error, /no encontrada/);
    }
  });

  it('DELETE responde {deleted:id} y luego 404', async () => {
    const r = await call('DELETE', '/tasks/2');
    assert.deepEqual(r.json, { deleted: 2 });
    assert.equal((await call('DELETE', '/tasks/2')).status, 404);
  });

  it('status=done&limit=8 devuelve los 8 últimos cierres (orden done DESC)', async () => {
    for (let i = 0; i < 9; i += 1) {
      const created = await call('POST', '/tasks?force=true', { body: { title: `tarea vieja ${i}`, proj: 'BOL' } });
      assert.equal(created.status, 201);
      await call('POST', `/tasks/${created.json.id}/close`, { body: {} });
    }
    const r = await call('GET', '/tasks?status=done&limit=8');
    assert.equal(r.json.tasks.length, 8);
    assert.ok(r.json.count > 8);
    assert.ok(r.json.tasks.every((t) => t.status === 'done'));
    const ids = r.json.tasks.map((t) => t.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
  });

  it('completed expande a done; status inválido da 400 + valid[]', async () => {
    const r = await call('GET', '/tasks?status=completed');
    assert.equal(r.json.count, r.json.tasks.length);
    assert.ok(r.json.count >= 9);
    const bad = await call('GET', '/tasks?status=basura');
    assert.equal(bad.status, 400);
    assert.ok(bad.json.valid.includes('open'));
  });

  it('filtros: scope, proj, búsqueda sin diacríticos, due', async () => {
    const pending = await call('GET', '/tasks?scope=pending');
    assert.ok(pending.json.tasks.every((t) => ['open', 'waiting', 'delegated'].includes(t.status)));
    const proj = await call('GET', '/tasks?proj=bol&scope=pending');
    assert.ok(proj.json.tasks.every((t) => t.proj === 'BOL'));
    const search = await call('GET', '/search?q=VIEJA%201');
    assert.equal(search.json.count, 1);
    assert.equal((await call('GET', '/tasks?due=overdue&scope=pending')).status, 200);
    assert.equal((await call('GET', '/tasks?due=9999-99-99')).status, 400);
  });

  it('as=text: cabecera y filas parseables por las regex del cliente', async () => {
    const r = await call('GET', '/tasks?as=text&limit=50');
    const lines = r.text.split('\n');
    assert.match(lines[0].trim(), HEADER_RE);
    for (const line of lines.slice(1)) {
      const m = ROW_RE.exec(line);
      assert.ok(m, `fila no parseable: ${line}`);
      assert.ok(CLIENT_STATUSES.has(m[3]), `status fuera del contrato: ${m[3]}`);
      assert.equal(m[1], String(Number(m[1])));
    }
  });

  it('GET /tasks/:id?as=text devuelve un bloque markdown', async () => {
    const r = await call('GET', '/tasks/1?as=text');
    assert.equal(r.status, 200);
    assert.match(r.text, /^- \[-\] /);
    assert.match(r.text, /\n\s+- id:: 1/);
  });

  it('duplicates exige title y puntúa candidatos', async () => {
    const r = await call('GET', '/duplicates?title=tarea%20vieja%205');
    assert.ok(r.json.count >= 1);
    assert.equal(typeof r.json.tasks[0].similarity, 'number');
    const missing = await call('GET', '/duplicates');
    assert.equal(missing.status, 400);
  });

  it('stats, render y config', async () => {
    const stats = await call('GET', '/stats');
    assert.equal(stats.json.by_status.done >= 9, true);
    assert.match(stats.json.counter, /^BOLBA-\d{6}$/);
    assert.equal(typeof stats.json.due_today_or_overdue, 'number');
    const render = await call('GET', '/render?scope=pending');
    assert.match(render.text.split('\n')[0].trim(), HEADER_RE);
    const config = await call('GET', '/config');
    assert.equal(config.json.port, server.port);
    assert.equal(config.json.token_configured, true);
    assert.equal('token' in config.json, false);
  });

  it('errores de ruta/cuerpo: 404, 405, JSON inválido, title obligatorio, 413', async () => {
    assert.equal((await call('GET', '/nope')).status, 404);
    const method = await call('PUT', '/tasks', { body: {} });
    assert.equal(method.status, 405);
    assert.deepEqual(method.json.allowed.sort(), ['GET', 'POST']);
    assert.equal((await call('POST', '/tasks', { raw: '{oops' })).status, 400);
    const missing = await call('POST', '/tasks', { body: {} });
    assert.equal(missing.status, 400);
    assert.ok(missing.json.valid.includes('title'));
    assert.equal((await call('POST', '/tasks', { raw: 'x'.repeat(1100000) })).status, 413);
  });

  it('markdown: exporta bloques, reimporta ediciones de campos y estado', async () => {
    const md = fs.readFileSync(mdPath, 'utf8');
    assert.match(md, /^# Tareas$/m);
    assert.match(md, /^\s+- id:: \d+$/m);
    assert.ok(!/\n\s+- id:: 1\n/.test(md), 'una tarea descartada no debe exportarse');

    const taskBefore = (await call('GET', '/tasks/3')).json;
    assert.equal(taskBefore.status, 'done');
    const edited = md
      .replace(/(\s+- id:: 3\n\s+- status:: )done/, '$1waiting')
      .replace('**tarea vieja 0**', '**tarea vieja 0 EDITADA**');
    fs.writeFileSync(mdPath, edited, 'utf8');
    fs.utimesSync(mdPath, new Date(Date.now() + 5000), new Date(Date.now() + 5000));

    const sync = await call('POST', '/sync');
    assert.equal(sync.status, 200);
    assert.deepEqual(sync.json.reimported, ['Tareas.md']);
    const taskAfter = (await call('GET', '/tasks/3')).json;
    assert.equal(taskAfter.status, 'waiting');
    assert.equal(taskAfter.title, 'tarea vieja 0 EDITADA');
  });

  it('markdown: marcar [x] cierra la tarea', async () => {
    const created = await call('POST', '/tasks', { body: { title: 'tarea pendiente global' } });
    assert.equal(created.status, 201);
    const pending = created.json.task;
    const md = fs.readFileSync(mdPath, 'utf8');
    const checked = md.replace(/^- \[ \] 🛠️ \*\*tarea pendiente global\*\*$/m, '- [x] 🛠️ **tarea pendiente global**');
    assert.notEqual(checked, md, 'no se encontró el bloque pendiente');
    fs.writeFileSync(mdPath, checked, 'utf8');
    fs.utimesSync(mdPath, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    await call('POST', '/sync');
    const after = (await call('GET', `/tasks/${pending.id}`)).json;
    assert.equal(after.status, 'done');
    assert.match(after.done, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('markdown: un bloque escrito a mano con proj solo en el head', async () => {
    const before = (await call('GET', '/tasks?q=manual%20head%20proj')).json.count;
    assert.equal(before, 0);
    fs.appendFileSync(mdPath, '\n- [ ] 🚀 XYZ — 🛠️ **tarea manual head proj**\n  - due:: 2026-12-01\n', 'utf8');
    fs.utimesSync(mdPath, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    await call('POST', '/sync');
    const found = (await call('GET', '/tasks?q=manual%20head%20proj')).json.tasks[0];
    assert.equal(found.proj, 'XYZ');
    assert.equal(found.due, '2026-12-01');
    return found.id;
  });

  it('markdown: borrar un bloque solo genera drift, no borra', async () => {
    const doomed = (await call('GET', '/search?q=vieja%202')).json.tasks[0];
    const lines = fs.readFileSync(mdPath, 'utf8').split('\n');
    const idLine = lines.findIndex((l) => new RegExp(`^\\s+- id:: ${doomed.id}$`).test(l));
    assert.notEqual(idLine, -1);
    let start = idLine;
    while (start > 0 && !lines[start].startsWith('- [')) start -= 1;
    let end = start + 1;
    while (end < lines.length && !lines[end].startsWith('- [')) end += 1;
    fs.writeFileSync(mdPath, lines.slice(0, start).concat(lines.slice(end)).join('\n'), 'utf8');
    fs.utimesSync(mdPath, new Date(Date.now() + 5000), new Date(Date.now() + 5000));

    await call('GET', '/stats'); // dispara el import perezoso
    const health = await fetch(`${server.url}/health`).then((r) => r.json());
    assert.ok(health.drift.some((d) => d.includes(`id ${doomed.id}`)));
    const still = await call('GET', `/tasks/${doomed.id}`);
    assert.equal(still.status, 200);
  });
});

describe('bolba-board ciclo de vida', () => {
  it('los datos sobreviven a un reinicio y close() es idempotente', async () => {
    const dir = tempDir('bolba-life-');
    const dbPath = path.join(dir, 'board.db');
    const mdPath = path.join(dir, 'Tareas.md');
    const first = await startBoard({ port: 0, dbPath, mdPath, log: silent });
    const created = await makeClient(first.url)('POST', '/tasks', { body: { title: 'sobrevive al reinicio' } });
    assert.equal(created.status, 201);
    await first.close();
    await first.close();

    const second = await startBoard({ port: 0, dbPath, mdPath, log: silent });
    const list = await makeClient(second.url)('GET', '/tasks');
    assert.equal(list.json.count, 1);
    assert.equal(list.json.tasks[0].id, created.json.id);
    await second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('puerto ocupado da un error legible (EADDRINUSE)', async () => {
    const first = await startBoard({ port: 0, log: silent });
    await assert.rejects(() => startBoard({ port: first.port, log: silent }), /puerto ocupado/);
    await first.close();
  });
});

describe('bolba-board configuración', () => {
  it('env > config.local.json > defaults', () => {
    const dir = tempDir('bolba-cfg-');
    fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify({
      port: 8888, token: 'localtoken', md: 'sub/T.md', counterPrefix: 'LOC',
    }), 'utf8');
    const fromLocal = loadConfig({ toolDir: dir, env: {} });
    assert.equal(fromLocal.port, 8888);
    assert.equal(fromLocal.token, 'localtoken');
    assert.equal(fromLocal.mdPath, path.join(dir, 'sub', 'T.md'));
    assert.equal(fromLocal.dbPath, path.join(dir, 'data', 'board.db'));
    assert.equal(fromLocal.autosync, true);
    assert.equal(fromLocal.counterPrefix, 'LOC');

    const fromEnv = loadConfig({ toolDir: dir, env: { BOLBA_BOARD_PORT: '9999', BOLBA_BOARD_TOKEN: 'envtok', BOLBA_BOARD_AUTOSYNC: 'off' } });
    assert.equal(fromEnv.port, 9999);
    assert.equal(fromEnv.token, 'envtok');
    assert.equal(fromEnv.autosync, false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('BOLBA_TASKS_TOKEN sirve de respaldo y los defaults se mantienen', () => {
    const dir = tempDir('bolba-cfg2-');
    const config = loadConfig({ toolDir: dir, env: { BOLBA_TASKS_TOKEN: 'plugintoken' } });
    assert.equal(config.token, 'plugintoken');
    assert.equal(config.port, 7492);
    assert.equal(config.dbPath, path.join(dir, 'data', 'board.db'));
    assert.equal(config.mdPath, path.join(dir, 'data', 'Tareas.md'));
    assert.deepEqual(config.projEmojis, {});
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('la versión de esquema queda registrada en meta', async () => {
  const dir = tempDir('bolba-meta-');
  const server = await startBoard({ port: 0, dbPath: path.join(dir, 'board.db'), log: silent });
  assert.equal(server.store.getMeta('schema_version'), '1');
  assert.match(server.store.counter(), /^BOLBA-0{5}0$/);
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
