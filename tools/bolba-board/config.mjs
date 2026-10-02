/**
 * bolba-board — configuration resolution: env > config.local.json > defaults.
 *
 * Defaults: port 7492 (hard-coded in the TC client's curl-card regex — do NOT
 * change), token 'abcd' (matches the built-in bolba-tasks plugin default),
 * data/board.db + data/Tareas.md inside this folder.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  port: 7492,
  token: 'abcd',
  db: 'data/board.db',
  md: 'data/Tareas.md',
  autosync: true,
  counterPrefix: 'BOLBA',
};

function readLocalConfig(toolDir) {
  const file = path.join(toolDir, 'config.local.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw new Error(`config.local.json inválido: ${err.message}`);
  }
}

function envBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(value).toLowerCase());
}

function parseProjEmojis(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @returns {{ port:number, token:string, dbPath:string, mdPath:string,
 *             autosync:boolean, counterPrefix:string, projEmojis:object }}
 */
export function loadConfig({ toolDir = TOOL_DIR, env = process.env } = {}) {
  const local = readLocalConfig(toolDir);
  const pick = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

  const portRaw = Number.parseInt(pick(env.BOLBA_BOARD_PORT, local.port, DEFAULTS.port), 10);
  const resolve = (p) => (path.isAbsolute(p) ? p : path.resolve(toolDir, p));

  return {
    port: Number.isFinite(portRaw) && portRaw >= 0 ? portRaw : DEFAULTS.port,
    token: String(pick(env.BOLBA_BOARD_TOKEN, env.BOLBA_TASKS_TOKEN, local.token, DEFAULTS.token) ?? ''),
    dbPath: resolve(String(pick(env.BOLBA_BOARD_DB, local.db, DEFAULTS.db))),
    mdPath: resolve(String(pick(env.BOLBA_BOARD_MD, local.md, DEFAULTS.md))),
    autosync: envBool(env.BOLBA_BOARD_AUTOSYNC, local.autosync !== false),
    counterPrefix: String(pick(local.counterPrefix, DEFAULTS.counterPrefix)),
    projEmojis: { ...(local.projEmojis || {}), ...parseProjEmojis(env.BOLBA_BOARD_PROJ_EMOJIS) },
  };
}
