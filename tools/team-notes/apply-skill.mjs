#!/usr/bin/env node
/**
 * 把 skill-content.md 以自定义技能的形式推送给正在运行的 TC 服务端
 * (POST /api/skills 按 slug upsert,数据层操作,不动任何源码/不触发重启)。
 *
 * 挂载策略(2026-10-07):`assignedAgentClasses: ['*']` 覆盖全部 agent 类
 * (含主管未来新建的任何角色);推送后把「主管(boss 类)」逐个排除
 * (excludedAgentIds)——主管的读由 customInstructions 的
 * 「派活前先扫团队笔记」句承担,不重复注入技能全文。
 *
 * 用法:
 *   node tools/team-notes/apply-skill.mjs           # 新建或更新技能(启用 + 排除主管)
 *   node tools/team-notes/apply-skill.mjs --disable # 更新为禁用(试点暂停)
 *
 * 回退(彻底删除):
 *   curl -X DELETE http://localhost:6200/api/skills/team-project-notes
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = process.env.TC_API_BASE || 'http://localhost:6200';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const content = readFileSync(path.join(HERE, 'skill-content.md'), 'utf8');
const disable = process.argv.includes('--disable');

const payload = {
  slug: 'team-project-notes',
  name: '团队项目笔记',
  description: '仓库根 .team-notes/ 目录的团队共享经验:动手前读、收尾时一条主题一个文件写(坑/约定/产出位置)',
  content,
  assignedAgentClasses: ['*'],
  enabled: !disable,
};

const res = await fetch(`${BASE}/api/skills`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

const body = await res.text();
if (!res.ok) {
  console.error(`POST /api/skills -> ${res.status}: ${body}`);
  process.exit(1);
}

const skill = JSON.parse(body);
console.log(
  `ok ${res.status}: slug=${skill.slug} id=${skill.id} enabled=${skill.enabled} ` +
  `classes=[${(skill.assignedAgentClasses || []).join(',')}] content=${content.length}ch`,
);

// 主管排除:按 boss 类找人(不写死 id,换人/重建后重跑即重排);幂等
// (已排除时 remove 接口返回 didNotHave,不报错)。
const agentsRes = await fetch(`${BASE}/api/agents`);
const agentsJson = await agentsRes.json();
const bosses = (agentsJson.agents || agentsJson).filter((a) => a.class === 'boss' || a.isBoss === true);
if (bosses.length === 0) {
  console.log('no boss agent found; nothing to exclude');
} else {
  const rr = await fetch(`${BASE}/api/agents/bulk/skills/remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentIds: bosses.map((b) => b.id), skillIds: [skill.id] }),
  });
  const rrBody = await rr.text();
  if (!rr.ok) {
    console.error(`POST /api/agents/bulk/skills/remove -> ${rr.status}: ${rrBody}`);
    process.exit(1);
  }
  const r0 = JSON.parse(rrBody).results?.[0] ?? {};
  console.log(
    `boss excluded: updated=[${(r0.updated || []).join(',')}] ` +
    `alreadyExcluded=[${(r0.didNotHave || []).join(',')}] failed=[${(r0.failed || []).join(',')}]`,
  );
}
