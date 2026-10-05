/**
 * env-prep —— C3 多项目环境的一次性布置与还原（用户裁决①：自动布置 + 测后还原）
 *
 * 复刻链（与 jarvis-core/projects/cards.ts:5 口径逐字一致）：
 *   workspace(areaIds) → DrawingArea(assignedAgentIds) → boss-like agent
 * 因此"一个可路由项目" = 一个 workspace + 至少一个区域，区域内恰有一个 boss-like 主管。
 *
 * 布置动作（全部真实写入，先 snapshot 后 setup）：
 *   A = 现有工作区（优先 name==='test'，否则 active，否则首个）+ 为现有主管补区域；
 *   B/C = 新建 workspace『项目B』『项目C』（名字即口称别名——aliases.ts 自动种子，
 *         resolve.ts 子串匹配要求话术含完整别名，故名字必须精确为 项目B/项目C）
 *         + 各自新下属（POST /api/agents）与新主管（WS spawn_boss_agent，唯一路径）。
 *
 * 还原（teardown）：active 还原 → areas 整表回写快照 → A 的 areaIds 还原 → 删除 B/C
 * workspace → 停止并删除本次新建的 4 个 agent → 计数复核。
 *
 * 幂等性：setup/teardown 均可重跑（已存在同名 agent/workspace 时复用或容忍 404）。
 * 状态文件 tools/human-campaign/.env-prep-state.json（gitignored）保存全量快照；
 * setup 拒绝在未 teardown 的旧 setup 上重跑（防快照被半成品状态覆盖）。
 */

import crypto from 'node:crypto';
import type { ProbeContext } from './types.js';
import {
  deleteStateFile, discoverProjects, fetchActiveWorkspace, fetchAgents, findBoss,
  nowIso, rawFetch, readStateFile, scratchDir, sleep, writeStateFile, bodyString,
} from './runner.js';
import { spawnBossAgent, stopAgent, syncAreas } from './ws-client.js';

// ─── 常量 ───

export const CAMPAIGN_WORKSPACE_NAMES = { B: '项目B', C: '项目C' } as const;
export const CAMPAIGN_SUB_NAMES = { B: '战役·下属B1', C: '战役·下属C1' } as const;
export const CAMPAIGN_BOSS_NAMES = { B: '战役·主管B', C: '战役·主管C' } as const;
/** A 项目的口称名 = 其 workspace 的实际名字（env-prep 会在报告里打印） */

export interface EnvPrepProject {
  key: 'A' | 'B' | 'C';
  name: string;
  workspaceId: string;
  bossId: string;
  bossName: string;
  areaId: string;
  subIds: string[];
}

export interface EnvPrepState {
  savedAt: string;
  setupAt?: string;
  teardownAt?: string;
  pre: {
    workspaces: unknown[];
    areas: unknown[];
    active: string | null;
    agents: Array<{ id: string; name: string; class?: string; isBoss?: boolean }>;
  };
  projects?: EnvPrepProject[];
  createdAgentIds?: string[];
  createdAreaIds?: string[];
  createdWorkspaceIds?: string[];
}

// ─── 原始读取助手（env-prep 必须拿全量行，不能用 canary 的窄字段映射） ───

function unwrapArray(raw: unknown, key: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  const wrapped = (raw as { value?: unknown })?.value ?? (raw as Record<string, unknown>)?.[key];
  return Array.isArray(wrapped) ? wrapped : [];
}

interface HttpJson { ok: boolean; status: number; json: Record<string, unknown>; error?: string }

async function getJson(ctx: ProbeContext, pathName: string): Promise<HttpJson> {
  const res = await ctx.transport.httpGet(pathName);
  return { ok: res.ok, status: res.status, json: (res.json ?? {}) as Record<string, unknown>, error: res.error };
}

async function readRawAreas(ctx: ProbeContext): Promise<{ ok: boolean; areas: Array<Record<string, unknown>>; error?: string }> {
  const res = await getJson(ctx, '/api/areas');
  if (!res.ok) return { ok: false, areas: [], error: res.error ?? `HTTP ${res.status}` };
  return { ok: true, areas: unwrapArray(res.json, 'areas') as Array<Record<string, unknown>> };
}

async function readRawWorkspaces(ctx: ProbeContext): Promise<{ ok: boolean; workspaces: Array<Record<string, unknown>>; error?: string }> {
  const res = await getJson(ctx, '/api/workspaces');
  if (!res.ok) return { ok: false, workspaces: [], error: res.error ?? `HTTP ${res.status}` };
  return { ok: true, workspaces: unwrapArray(res.json, 'workspaces') as Array<Record<string, unknown>> };
}

function rawId(row: unknown): string { return String((row as { id?: unknown })?.id ?? ''); }
function rawName(row: unknown): string { return String((row as { name?: unknown })?.name ?? ''); }
function rawAreaIds(row: unknown): string[] {
  const v = (row as { areaIds?: unknown })?.areaIds;
  return Array.isArray(v) ? v.map(String) : [];
}

function makeArea(id: string, name: string, x: number, z: number, bossId: string): Record<string, unknown> {
  return {
    id,
    name,
    type: 'rectangle',
    center: { x, z },
    width: 520,
    height: 520,
    color: '#64748b',
    zIndex: 1,
    assignedAgentIds: [bossId],
    directories: [],
  };
}

// ─── snapshot ───

export async function envSnapshot(ctx: ProbeContext): Promise<{ ok: boolean; error?: string; detail: string }> {
  const ws = await readRawWorkspaces(ctx);
  if (!ws.ok) return { ok: false, error: ws.error, detail: '' };
  const areas = await readRawAreas(ctx);
  if (!areas.ok) return { ok: false, error: areas.error, detail: '' };
  const active = await fetchActiveWorkspace(ctx.transport);
  if (!active.ok) return { ok: false, error: active.error, detail: '' };
  const ag = await fetchAgents(ctx.transport);
  if (!ag.ok) return { ok: false, error: ag.error, detail: '' };

  const state: EnvPrepState = {
    savedAt: nowIso(),
    pre: {
      workspaces: ws.workspaces,
      areas: areas.areas,
      active: active.workspaceId,
      agents: ag.agents.map((a) => ({ id: a.id, name: a.name, class: a.class, isBoss: a.isBoss })),
    },
  };
  writeStateFile(state as unknown as Record<string, unknown>);
  const detail = `快照：workspaces=${ws.workspaces.length} areas=${areas.areas.length} agents=${ag.agents.length} active=${active.workspaceId ?? 'null'}`;
  ctx.log(detail);
  return { ok: true, detail };
}

// ─── setup ───

export interface EnvSetupResult { ok: boolean; error?: string; projects?: EnvPrepProject[]; detail: string }

export async function envSetup(ctx: ProbeContext): Promise<EnvSetupResult> {
  const loaded = readStateFile();
  if (!loaded.ok || !loaded.state?.pre) {
    return { ok: false, error: `先跑 --env-prep=snapshot（${loaded.error ?? 'pre 快照缺失'}）`, detail: '' };
  }
  const state = loaded.state as unknown as EnvPrepState;
  if (state.setupAt && !state.teardownAt) {
    return { ok: false, error: `检测到未 teardown 的旧 setup（setupAt=${state.setupAt}）——先 --env-prep=teardown 或手工清理状态文件`, detail: '' };
  }
  const notes: string[] = [];
  const scratch = scratchDir();
  ctx.log(`scratch 目录：${scratch}`);

  const ag = await fetchAgents(ctx.transport);
  if (!ag.ok) return { ok: false, error: `读取 agents 失败：${ag.error}`, detail: '' };
  const bossA = findBoss(ag.agents);
  if (!bossA) return { ok: false, error: '未找到现有 boss-like 主管（A 项目缺主管）', detail: '' };

  // 1) 下属（POST /api/agents；同名复用）
  const subIds: Record<'B' | 'C', string> = { B: '', C: '' };
  for (const key of ['B', 'C'] as const) {
    const name = CAMPAIGN_SUB_NAMES[key];
    const existing = ag.agents.find((a) => a.name === name);
    if (existing) { subIds[key] = existing.id; notes.push(`下属 ${name} 已存在 → 复用 ${existing.id}`); continue; }
    const res = await ctx.transport.httpPost('/api/agents', { name, class: 'scout', cwd: scratch });
    const id = String((res.json as { id?: unknown } | undefined)?.id ?? '');
    if (!res.ok || !id) return { ok: false, error: `创建下属 ${name} 失败：HTTP ${res.status} ${res.error ?? JSON.stringify(res.json ?? {})}`, detail: '' };
    subIds[key] = id;
    notes.push(`下属 ${name} 创建成功 ${id}`);
  }

  // 2) 主管（WS spawn_boss_agent；同名复用）
  const bossIds: Record<'B' | 'C', string> = { B: '', C: '' };
  for (const key of ['B', 'C'] as const) {
    const name = CAMPAIGN_BOSS_NAMES[key];
    const existing = ag.agents.find((a) => a.name === name);
    if (existing) { bossIds[key] = existing.id; notes.push(`主管 ${name} 已存在 → 复用 ${existing.id}`); continue; }
    const spawned = await spawnBossAgent(ctx.ws, { name, cwd: scratch, subordinateIds: [subIds[key]] });
    if (!spawned.ok || !spawned.agentId) return { ok: false, error: `spawn 主管 ${name} 失败：${spawned.error}`, detail: '' };
    bossIds[key] = spawned.agentId;
    notes.push(`主管 ${name} 创建成功 ${spawned.agentId}`);
  }

  // 3) A 工作区选择（优先 'test'，否则 active，否则首个）
  const wsRaw = await readRawWorkspaces(ctx);
  if (!wsRaw.ok) return { ok: false, error: `读取 workspaces 失败：${wsRaw.error}`, detail: '' };
  const active = await fetchActiveWorkspace(ctx.transport);
  const pickA = wsRaw.workspaces.find((w) => rawName(w) === 'test')
    ?? wsRaw.workspaces.find((w) => rawId(w) === active.workspaceId)
    ?? wsRaw.workspaces[0];
  if (!pickA) return { ok: false, error: '没有任何 workspace 可作为 A 项目容器', detail: '' };
  const nameA = rawName(pickA);
  const wsIdA = rawId(pickA);
  notes.push(`A 项目 = workspace「${nameA}」(${wsIdA})，主管=${bossA.name}(${bossA.id})`);

  // 4) 区域（追加进整表；幂等：同 id 已在表中则跳过）
  const areasNow = await readRawAreas(ctx);
  if (!areasNow.ok) return { ok: false, error: `读取 areas 失败：${areasNow.error}`, detail: '' };
  const haveIds = new Set(areasNow.areas.map(rawId));
  const areaDefs: Array<{ key: 'A' | 'B' | 'C'; name: string; bossId: string; x: number; z: number }> = [
    { key: 'A', name: `战役·项目A（${nameA}）`, bossId: bossA.id, x: -1600, z: -1600 },
    { key: 'B', name: '战役·项目B', bossId: bossIds.B, x: -1600, z: -2400 },
    { key: 'C', name: '战役·项目C', bossId: bossIds.C, x: -2400, z: -1600 },
  ];
  const areaIdByKey: Record<'A' | 'B' | 'C', string> = { A: '', B: '', C: '' };
  const createdAreaIds: string[] = [];
  for (const def of areaDefs) {
    const existing = areasNow.areas.find((a) => {
      const members = (a as { assignedAgentIds?: unknown }).assignedAgentIds;
      return rawName(a) === def.name && Array.isArray(members) && members.map(String).includes(def.bossId);
    });
    if (existing) { areaIdByKey[def.key] = rawId(existing); notes.push(`区域 ${def.name} 已存在 → 复用`); continue; }
    const id = `hc-area-${def.key}-${crypto.randomUUID().slice(0, 8)}`;
    areaIdByKey[def.key] = id;
    createdAreaIds.push(id);
    areasNow.areas.push(makeArea(id, def.name, def.x, def.z, def.bossId));
  }
  if (createdAreaIds.length > 0) {
    syncAreas(ctx.ws, areasNow.areas);
    await sleep(1200);
    const after = await readRawAreas(ctx);
    const afterIds = new Set((after.ok ? after.areas : []).map(rawId));
    const missing = createdAreaIds.filter((id) => !afterIds.has(id));
    if (missing.length > 0) return { ok: false, error: `sync_areas 后区域未落盘：${missing.join(', ')}（服务端未保存？）`, detail: '' };
    notes.push(`sync_areas 落盘复核通过（新增 ${createdAreaIds.length} 区域）`);
  }

  // 5) B/C workspace（POST；同名复用后 PUT areaIds）
  const createdWorkspaceIds: string[] = [];
  const wsIds: Record<'B' | 'C', string> = { B: '', C: '' };
  for (const key of ['B', 'C'] as const) {
    const name = CAMPAIGN_WORKSPACE_NAMES[key];
    const existing = wsRaw.workspaces.find((w) => rawName(w) === name);
    if (existing) {
      wsIds[key] = rawId(existing);
      const merged = [...new Set([...rawAreaIds(existing), areaIdByKey[key]])];
      const res = await ctx.transport.httpPut(`/api/workspaces/${encodeURIComponent(wsIds[key])}`, { areaIds: merged });
      if (!res.ok) return { ok: false, error: `复用 workspace ${name} 时 PUT 失败：HTTP ${res.status}`, detail: '' };
      notes.push(`workspace「${name}」已存在 → 复用并补齐 areaIds`);
      continue;
    }
    const res = await ctx.transport.httpPost('/api/workspaces', { name, areaIds: [areaIdByKey[key]] });
    const id = String((res.json as { id?: unknown } | undefined)?.id ?? '');
    if (!res.ok || !id) return { ok: false, error: `创建 workspace「${name}」失败：HTTP ${res.status}`, detail: '' };
    wsIds[key] = id;
    createdWorkspaceIds.push(id);
    notes.push(`workspace「${name}」创建成功 ${id}`);
  }

  // 6) A 的 areaIds 补齐
  {
    const merged = [...new Set([...rawAreaIds(pickA), areaIdByKey.A])];
    const res = await ctx.transport.httpPut(`/api/workspaces/${encodeURIComponent(wsIdA)}`, { areaIds: merged });
    if (!res.ok) return { ok: false, error: `A 工作区 areaIds 写入失败：HTTP ${res.status}`, detail: '' };
  }

  const projects: EnvPrepProject[] = [
    { key: 'A', name: nameA, workspaceId: wsIdA, bossId: bossA.id, bossName: bossA.name, areaId: areaIdByKey.A, subIds: [] },
    { key: 'B', name: CAMPAIGN_WORKSPACE_NAMES.B, workspaceId: wsIds.B, bossId: bossIds.B, bossName: CAMPAIGN_BOSS_NAMES.B, areaId: areaIdByKey.B, subIds: [subIds.B] },
    { key: 'C', name: CAMPAIGN_WORKSPACE_NAMES.C, workspaceId: wsIds.C, bossId: bossIds.C, bossName: CAMPAIGN_BOSS_NAMES.C, areaId: areaIdByKey.C, subIds: [subIds.C] },
  ];

  const nextState: EnvPrepState = {
    ...state,
    setupAt: nowIso(),
    teardownAt: undefined,
    pre: state.pre,
    projects,
    createdAgentIds: [subIds.B, subIds.C, bossIds.B, bossIds.C].filter(Boolean),
    createdAreaIds,
    createdWorkspaceIds,
  };
  writeStateFile(nextState as unknown as Record<string, unknown>);

  const verify = await envVerify(ctx);
  ctx.log(`setup 完成：${notes.join('；')}`);
  return { ok: verify.ok, projects, detail: verify.detail, error: verify.ok ? undefined : 'setup 后 verify 未通过（见 detail）' };
}

// ─── verify ───

export async function envVerify(ctx: ProbeContext): Promise<{ ok: boolean; detail: string }> {
  const loaded = readStateFile();
  const state = loaded.state as unknown as EnvPrepState | undefined;
  if (!state?.projects?.length) return { ok: false, detail: '状态文件无 projects（先 setup）' };
  const r = await discoverProjects(ctx);
  if (!r.ok) return { ok: false, detail: r.error ?? 'discoverProjects 失败' };
  const bad: string[] = [];
  const good: string[] = [];
  for (const p of state.projects) {
    const found = r.projects.find((x) => x.id === p.workspaceId && x.bossId === p.bossId);
    if (found) good.push(`${p.key}「${p.name}」→ ${found.bossName}(${found.bossId})`);
    else bad.push(`${p.key}「${p.name}」(ws=${p.workspaceId} boss=${p.bossId})`);
  }
  const detail = bad.length === 0
    ? `三项目可路由：${good.join('；')}`
    : `失联：${bad.join('；')}；当前可路由：${r.projects.map((x) => x.name).join('/') || '无'}；排除：${r.excluded.join('；')}`;
  return { ok: bad.length === 0, detail };
}

// ─── teardown ───

export async function envTeardown(ctx: ProbeContext): Promise<{ ok: boolean; detail: string; error?: string }> {
  const loaded = readStateFile();
  const state = loaded.state as unknown as EnvPrepState | undefined;
  if (!state?.pre) return { ok: false, detail: '', error: `状态文件缺失（${loaded.error}）` };
  const notes: string[] = [];

  // 1) active 还原
  const activeRes = await ctx.transport.httpPut('/api/workspaces/active', { workspaceId: state.pre.active });
  notes.push(activeRes.ok ? `active 还原为 ${state.pre.active ?? 'null'}` : `active 还原失败 HTTP ${activeRes.status}`);

  // 2) areas 整表回写快照
  syncAreas(ctx.ws, state.pre.areas);
  await sleep(1200);
  const areasAfter = await readRawAreas(ctx);
  notes.push(`areas 回写快照 ${state.pre.areas.length} 条（现值 ${areasAfter.areas.length} 条）`);

  // 3) A 的 areaIds 还原 + 删除 B/C workspace
  const preA = (state.pre.workspaces as Array<Record<string, unknown>>).find((w) => rawId(w) === (state.projects?.[0]?.workspaceId)) ;
  if (preA) {
    const res = await ctx.transport.httpPut(`/api/workspaces/${encodeURIComponent(rawId(preA))}`, { areaIds: rawAreaIds(preA) });
    notes.push(res.ok ? `A 工作区 areaIds 还原（${rawAreaIds(preA).length} 个）` : `A 工作区 areaIds 还原失败 HTTP ${res.status}`);
  }
  for (const id of state.createdWorkspaceIds ?? []) {
    const res = await rawFetch(ctx, `/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' });
    notes.push(res.ok ? `删除 workspace ${id}` : `删除 workspace ${id}：HTTP ${res.status} ${res.error ?? ''}`);
  }

  // 4) 停止并删除本次新建 agent
  for (const id of state.createdAgentIds ?? []) {
    await stopAgent(ctx.ws, id);
    await sleep(250);
    const res = await rawFetch(ctx, `/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
    notes.push(res.ok ? `删除 agent ${id}` : `删除 agent ${id}：HTTP ${res.status} ${res.error ?? ''}`);
  }

  // 5) 计数复核
  const agAfter = await fetchAgents(ctx.transport);
  const preIds = new Set(state.pre.agents.map((a) => a.id));
  const leftovers = agAfter.agents.filter((a) => !preIds.has(a.id)).map((a) => `${a.name}(${a.id})`);
  const wsAfter = await readRawWorkspaces(ctx);
  const preWsIds = new Set((state.pre.workspaces as Array<Record<string, unknown>>).map(rawId));
  const wsLeftovers = wsAfter.workspaces.filter((w) => !preWsIds.has(rawId(w))).map((w) => `${rawName(w)}(${rawId(w)})`);

  const nextState: EnvPrepState = { ...state, teardownAt: nowIso(), projects: undefined, createdAgentIds: undefined, createdAreaIds: undefined, createdWorkspaceIds: undefined };
  writeStateFile(nextState as unknown as Record<string, unknown>);

  const ok = leftovers.length === 0 && wsLeftovers.length === 0 && areasAfter.areas.length === state.pre.areas.length;
  const detail = [
    `agent 残留：${leftovers.join(', ') || '无'}`,
    `workspace 残留：${wsLeftovers.join(', ') || '无'}`,
    `areas 计数：快照 ${state.pre.areas.length} / 现 ${areasAfter.areas.length}`,
    ...notes,
  ].join('；');
  ctx.log(detail);
  return { ok, detail };
}

// ─── 波次善后：停止所有 running agent（C2/C4 用） ───

export async function stopAllRunning(ctx: ProbeContext): Promise<{ stopped: string[]; remaining: string[] }> {
  const ag = await fetchAgents(ctx.transport);
  const stopped: string[] = [];
  for (const a of ag.agents) {
    if (a.status !== 'running' && a.status !== 'processing') continue;
    await stopAgent(ctx.ws, a.id);
    stopped.push(`${a.name}(${a.id},${a.status})`);
    await sleep(250);
  }
  const after = await fetchAgents(ctx.transport);
  const remaining = after.agents.filter((a) => a.status === 'running' || a.status === 'processing').map((a) => `${a.name}(${a.status})`);
  ctx.log(`停止 ${stopped.length} 个 running agent；仍 busy：${remaining.join(', ') || '无'}`);
  return { stopped, remaining };
}

export { deleteStateFile, bodyString };
