/**
 * bolba-board — Tide Commander server plugin entry.
 *
 * Activated in-process by the TC server (see src/packages/server/plugins/
 * manager.ts). It simply boots the same HTTP server standalone.mjs runs, so
 * the board's lifecycle follows TC: start with the server, stop on
 * disable/shutdown.
 *
 * Install: POST /api/plugins/install { sourcePath: "<abs path to this dir>" }
 * Update: disable -> enable in the Plugins panel (or restart TC) — there is
 * no uninstall endpoint to worry about.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let current;

function readableError(err) {
  const message = String((err && err.message) || err);
  if (/node:sqlite|DatabaseSync/i.test(message)) {
    return 'se requiere Node >= 22 con el módulo node:sqlite (probado en Node 22.23)';
  }
  return message;
}

export async function activate(api) {
  const log = (api && api.log) || console;
  const config = loadConfig();
  // mtime-busted so disable -> enable picks up edited server modules.
  const stamp = fs.statSync(path.join(HERE, 'server.mjs')).mtimeMs;
  const { startBoard } = await import(new URL(`./server.mjs?v=${stamp}`, import.meta.url).href);

  try {
    current = await startBoard({
      port: config.port,
      token: config.token,
      dbPath: config.dbPath,
      mdPath: config.mdPath,
      autosync: config.autosync,
      projEmojis: config.projEmojis,
      counterPrefix: config.counterPrefix,
      version: (api && api.manifest && api.manifest.version) || '1.0.0',
      log,
    });
  } catch (err) {
    log.error(`bolba-board: activación fallida — ${readableError(err)}`);
    throw new Error(`bolba-board: ${readableError(err)}`);
  }

  return {
    async deactivate() {
      if (!current) return;
      const server = current;
      current = undefined;
      try {
        await server.close();
      } catch (err) {
        log.warn(`bolba-board: error al cerrar — ${(err && err.message) || err}`);
      }
    },
  };
}

export default { activate };
