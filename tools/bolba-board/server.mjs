/**
 * bolba-board — HTTP server (127.0.0.1 only, default port 7492).
 *
 * Sibling modules are loaded with an mtime-busting dynamic import and get
 * their dependencies injected, so nothing imports anyone: touching any file
 * + disable/enable of the TC plugin reloads the whole board.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = 1024 * 1024;

const ROUTES = [
  { method: 'GET', re: /^\/tasks$/, handler: 'listTasks' },
  { method: 'POST', re: /^\/tasks$/, handler: 'createTask' },
  { method: 'GET', re: /^\/tasks\/(\d+)$/, handler: 'getTask' },
  { method: 'PATCH', re: /^\/tasks\/(\d+)$/, handler: 'updateTask' },
  { method: 'PUT', re: /^\/tasks\/(\d+)$/, handler: 'updateTask' },
  { method: 'DELETE', re: /^\/tasks\/(\d+)$/, handler: 'deleteTask' },
  { method: 'POST', re: /^\/tasks\/(\d+)\/timeline$/, handler: 'addTimeline' },
  { method: 'POST', re: /^\/tasks\/(\d+)\/close$/, handler: 'closeTask' },
  { method: 'POST', re: /^\/tasks\/(\d+)\/reopen$/, handler: 'reopenTask' },
  { method: 'GET', re: /^\/search$/, handler: 'searchTasks' },
  { method: 'GET', re: /^\/duplicates$/, handler: 'duplicates' },
  { method: 'GET', re: /^\/stats$/, handler: 'statsTask' },
  { method: 'GET', re: /^\/health$/, handler: 'health', noAuth: true },
  { method: 'GET', re: /^\/render$/, handler: 'render' },
  { method: 'POST', re: /^\/sync$/, handler: 'syncNow' },
  { method: 'GET', re: /^\/config$/, handler: 'configInfo' },
];

async function loadModule(name) {
  const stamp = fs.statSync(path.join(HERE, name)).mtimeMs;
  return import(new URL(`./${name}?v=${stamp}`, import.meta.url).href);
}

/**
 * @param {{
 *   port?: number, token?: string, dbPath?: string, mdPath?: string,
 *   autosync?: boolean, projEmojis?: Record<string,string>,
 *   counterPrefix?: string, version?: string, log?: object
 * }} options
 * @returns {Promise<{ url: string, port: number, dbPath: string, mdPath: string, store: object, close: () => Promise<void> }>}
 */
export async function startBoard(options = {}) {
  const {
    port = 7492,
    token = 'abcd',
    dbPath = ':memory:',
    mdPath = '',
    autosync = true,
    projEmojis = {},
    counterPrefix = 'BOLBA',
    version = '1.0.0',
    log = console,
  } = options;
  const warn = (message) => { if (log && log.warn) log.warn(message); };
  const info = (message) => { if (log && log.info) log.info(message); };
  const error = (message) => { if (log && log.error) log.error(message); };

  const [storeMod, textMod, validateMod, dupMod, markdownMod, handlersMod] = await Promise.all([
    loadModule('store.mjs'),
    loadModule('text.mjs'),
    loadModule('validate.mjs'),
    loadModule('duplicates.mjs'),
    loadModule('markdown.mjs'),
    loadModule('handlers.mjs'),
  ]);

  const store = storeMod.openStore({ dbPath, counterPrefix, log });
  const text = textMod.createText({ projEmojis });
  const validate = validateMod;
  const dup = dupMod;
  const sync = markdownMod.createSync({ store, text, validate, mdPath, enabled: autosync, log });
  const config = { port, token, dbPath, mdPath, autosync, version };
  const handlers = handlersMod.createHandlers({ store, text, validate, dup, sync, config, log });

  function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body, null, 2));
  }

  function sendText(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  function authorized(req) {
    if (!token) return true;
    const header = req.headers['x-auth-token'];
    if (typeof header === 'string' && header === token) return true;
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) {
      return auth.replace(/^bearer\s+/i, '') === token;
    }
    return false;
  }

  function sanitizeActor(req) {
    const raw = req.headers['x-actor'];
    if (typeof raw !== 'string') return 'desconocido';
    const clean = raw.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 80);
    return clean || 'desconocido';
  }

  function readBody(req, limit = BODY_LIMIT) {
    return new Promise((resolve, reject) => {
      let size = 0;
      let overflowed = false;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          if (!overflowed) {
            overflowed = true;
            const err = new Error('too large');
            err.http = { status: 413, body: { error: 'cuerpo demasiado grande (máximo 1 MiB)' } };
            reject(err);
          }
          return; // drain the rest without buffering it
        }
        chunks.push(chunk);
      });
      req.on('end', () => { if (!overflowed) resolve(Buffer.concat(chunks)); });
      req.on('error', (err) => { if (!overflowed) reject(err); });
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') || '/' : url.pathname;

    const matching = ROUTES.filter((route) => route.re.test(pathname));
    if (!matching.length) return sendJson(res, 404, { error: 'ruta desconocida' });
    const route = matching.find((candidate) => candidate.method === req.method);
    if (!route) {
      return sendJson(res, 405, { error: 'método no permitido', allowed: Array.from(new Set(matching.map((r) => r.method))) });
    }
    if (!route.noAuth && !authorized(req)) {
      return sendJson(res, 401, { error: 'no autorizado: X-Auth-Token inválido o ausente' });
    }

    let body = null;
    if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
      let raw;
      try {
        raw = await readBody(req);
      } catch (err) {
        if (err && err.http) return sendJson(res, err.http.status, err.http.body);
        throw err;
      }
      if (raw.length) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          return sendJson(res, 400, { error: 'JSON inválido' });
        }
      }
    }

    let reimported = false;
    if (route.handler !== 'health' && route.handler !== 'configInfo' && route.handler !== 'syncNow') {
      try {
        reimported = !!sync.maybeImport();
      } catch (err) {
        warn(`bolba-board: import lazy de markdown falló: ${err && err.message}`);
      }
    }

    const reqCtx = {
      params: route.re.exec(pathname).slice(1),
      query: url.searchParams,
      body,
      actor: sanitizeActor(req),
      reimported,
      method: req.method,
      pathname,
    };

    try {
      const result = await handlers[route.handler](reqCtx);
      if (result && result.text !== undefined) return sendText(res, result.status || 200, result.text);
      return sendJson(res, (result && result.status) || 200, result ? result.body : {});
    } catch (err) {
      if (err && err.http) return sendJson(res, err.http.status, err.http.body);
      error(`bolba-board: error en ${req.method} ${pathname}: ${err && err.message}`);
      return sendJson(res, 500, { error: `error interno: ${err && err.message}` });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      error(`bolba-board: error no capturado: ${err && err.stack}`);
      try { sendJson(res, 500, { error: 'error interno' }); } catch { /* socket already gone */ }
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      if (err && err.code === 'EADDRINUSE') {
        reject(new Error(`Bolba board no pudo escuchar en 127.0.0.1:${port}: puerto ocupado por otro proceso (EADDRINUSE)`));
      } else {
        reject(err);
      }
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });

  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : port;
  config.port = actualPort;
  server.on('error', (err) => error(`bolba-board: error de servidor: ${err && err.message}`));
  info(`Bolba board escuchando en http://127.0.0.1:${actualPort} (db: ${dbPath}${mdPath ? `, md: ${mdPath}` : ''})`);

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    const finished = new Promise((resolve) => {
      try { server.close(() => resolve()); } catch { resolve(); }
    });
    try { server.closeAllConnections(); } catch { /* not listening */ }
    await finished;
    store.close();
  }

  return { url: `http://127.0.0.1:${actualPort}`, port: actualPort, dbPath, mdPath, store, sync, text, close };
}
