#!/usr/bin/env node
/**
 * bolba-board — install/update the agent skill in Tide Commander.
 *
 *   node tools/bolba-board/skill/apply-skill.mjs [--url http://127.0.0.1:6200]
 *        [--token <TC_TOKEN>] [--file skill/task-board.md] [--dry-run]
 *
 * POSTs /api/skills (upsert by slug: re-running updates the existing skill).
 * The skill teaches any agent the curl recipes for the local board, so
 * command output renders as task cards in the chat stream.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = {
  slug: 'bolba-task-board',
  name: 'Bolba 任务看板',
  description: '用 curl 操作本地 Bolba 任务看板（列表/建/改/关/重开/时间线），聊天流里渲染任务卡片。',
  allowedTools: ['Bash'],
  assignedAgentClasses: ['*'],
  enabled: true,
};

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=');
    const next = () => (inline !== undefined ? inline : argv[++i]);
    switch (flag) {
      case '--url': opts.url = next(); break;
      case '--token': opts.token = next(); break;
      case '--file': opts.file = next(); break;
      case '--dry-run': opts.dryRun = true; break;
      default:
        if (flag) {
          console.error(`opción desconocida: ${flag}`);
          process.exit(1);
        }
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const baseUrl = (opts.url || process.env.TIDE_COMMANDER_URL || 'http://127.0.0.1:6200').replace(/\/+$/, '');
const token = opts.token || process.env.TIDE_COMMANDER_TOKEN || '';
const file = opts.file ? path.resolve(opts.file) : path.join(HERE, 'task-board.md');
const content = fs.readFileSync(file, 'utf8');

const payload = { ...SKILL, content };
if (opts.dryRun) {
  console.log(`dry-run: POST ${baseUrl}/api/skills (${content.length} bytes de ${path.basename(file)})`);
  console.log(JSON.stringify({ ...SKILL, content: `«${content.length} bytes»` }, null, 2));
  process.exit(0);
}

const headers = { 'Content-Type': 'application/json' };
if (token) headers['X-Auth-Token'] = token;

const res = await fetch(`${baseUrl}/api/skills`, { method: 'POST', headers, body: JSON.stringify(payload) });
const text = await res.text();
if (!res.ok) {
  console.error(`error ${res.status} al instalar la skill: ${text.slice(0, 500)}`);
  if (res.status === 409) console.error('(slug reservado por una skill builtin — cambia SKILL.slug en apply-skill.mjs)');
  process.exit(1);
}
let body;
try { body = JSON.parse(text); } catch { body = undefined; }
console.log(`${res.status === 201 ? 'creada' : 'actualizada'}: skill '${(body && body.slug) || SKILL.slug}' (${(body && body.id) || '?'})`);
