#!/usr/bin/env node
/**
 * bolba-board — standalone dev runner.
 *
 *   node tools/bolba-board/standalone.mjs [--port 7492] [--token abcd]
 *        [--db data/board.db] [--md data/Tareas.md] [--no-autosync] [--seed]
 *
 * Runs the exact same server.mjs the TC plugin starts, but in its own
 * process — use it while developing (disable the plugin or stop TC first,
 * port 7492 can only be bound once).
 */

import { loadConfig } from './config.mjs';
import { startBoard } from './server.mjs';

const USAGE = 'uso: node tools/bolba-board/standalone.mjs [--port N] [--token T] [--db RUTA] [--md RUTA] [--no-autosync] [--seed]';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=');
    const next = () => (inline !== undefined ? inline : argv[++i]);
    switch (flag) {
      case '--port': opts.port = Number.parseInt(next(), 10); break;
      case '--token': opts.token = next(); break;
      case '--db': opts.dbPath = next(); break;
      case '--md': opts.mdPath = next(); break;
      case '--no-autosync': opts.autosync = false; break;
      case '--seed': opts.seed = true; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (flag) {
          console.error(`opción desconocida: ${flag}`);
          opts.unknown = true;
        }
    }
  }
  return opts;
}

function datePlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function seedBoard(store, sync) {
  if (store.listTasks({ limit: 1 }).total > 0) return 0;
  const rows = [
    { title: 'Preparar cotización ALT-4412', proj: 'ALT', type: 'compra', due: datePlus(2), from_person: 'Marta', coti: 'ALT-4412' },
    { title: 'Llamar a Marta por el certificado', proj: 'ALT', type: 'llamada', due: datePlus(0), from_person: 'Marta' },
    { title: 'Revisar bug en el parser de fechas', proj: 'BOL', type: 'bug', due: datePlus(5) },
    { title: 'Enviar factura de septiembre', proj: 'BOL', type: 'pago', due: datePlus(-2) },
  ].map((fields) => store.createTask(fields, { actor: 'seed' }));
  store.addEvents(rows[1].id, ['Cliente pide respuesta antes del viernes'], { actor: 'seed' });
  store.closeTask(rows[3].id, 'done', { actor: 'seed' });
  sync.exportFile();
  return rows.length;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || opts.unknown) {
  console.log(USAGE);
  process.exit(opts.unknown ? 1 : 0);
}

const config = loadConfig();
const server = await startBoard({
  port: opts.port ?? config.port,
  token: opts.token ?? config.token,
  dbPath: opts.dbPath ?? config.dbPath,
  mdPath: opts.mdPath ?? config.mdPath,
  autosync: opts.autosync ?? config.autosync,
  projEmojis: config.projEmojis,
  counterPrefix: config.counterPrefix,
  version: 'dev',
});

if (opts.seed) {
  const seeded = seedBoard(server.store, server.sync);
  console.log(seeded ? `seed: ${seeded} tareas de ejemplo creadas` : 'seed: el tablero ya tiene tareas, sin cambios');
}

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n${signal}: cerrando bolba-board…`);
  await server.close();
  process.exit(0);
}
process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
