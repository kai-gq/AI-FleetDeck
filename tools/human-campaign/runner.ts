/**
 * human-campaign 核心运行器 —— 锚点纪律 + 日志助手 + 前置检查
 *
 * 锚点纪律（沿用金丝雀 2026-10-04 L3 实测教训）：
 *   t0 = now - CLOCK_MARGIN_MS（5s）；每条消息逐字精确文本锚点；所有"本次链路"断言
 *   只认 id > 锚点 id 的行；探针间隔 ≥5s 防残留污染。
 *
 * 镜像说明（canary 未导出，逐行镜像并注来源；canary 侧改动时需人工同步）：
 *   - bodyString           ← tools/jarvis-canary/scenarios.ts:100
 *   - findOwnDialogIn      ← tools/jarvis-canary/scenarios.ts:113
 *   - ANCHOR_FALLBACK_NOTE ← tools/jarvis-canary/scenarios.ts:121
 *   - assertThat           ← tools/jarvis-canary/scenarios.ts:165
 *   - phaseOf/isDelegation ← tools/jarvis-canary/scenarios.ts:176-184
 *
 * 直连复用（canary 已导出）：CLOCK_MARGIN_MS / TASK_ACTIONS / projectRouteText /
 * quotaTaskText / SIMULATED_COMPLETION / CANCEL_TASK_TEXT / sleep / truncate /
 * waitFor / entryEvidence / observedSummary / assertCancelEvidence。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AssertionResult, CanaryEntry, CanaryTransport, Evidence, HttpResult, LogQueryFn, PrereqResult,
} from '../jarvis-canary/types.js';
import type { ReadOnlyLogQuery } from '../jarvis-canary/log-query.js';
import {
  CLOCK_MARGIN_MS, TASK_ACTIONS, CANCEL_TASK_TEXT, projectRouteText, quotaTaskText,
  SIMULATED_COMPLETION, sleep, truncate, waitFor, entryEvidence, observedSummary, assertCancelEvidence,
} from '../jarvis-canary/scenarios.js';
import {
  fetchActiveWorkspace, fetchAgents, fetchAreas, fetchWorkspaces, findBoss,
  probeHealth, reportTask, sendCompanionMessage, setActiveWorkspace,
} from '../jarvis-canary/client.js';
import type { HumanOptions, ProbeContext, ProbeDef, ProbeOutcome } from './types.js';

// ─── 再导出（探针统一从 runner 取原语，减少跨目录 import 面） ───

export {
  CLOCK_MARGIN_MS, TASK_ACTIONS, CANCEL_TASK_TEXT, projectRouteText, quotaTaskText,
  SIMULATED_COMPLETION, sleep, truncate, waitFor, entryEvidence, observedSummary, assertCancelEvidence,
};
export { fetchActiveWorkspace, fetchAgents, fetchAreas, fetchWorkspaces, findBoss, reportTask, sendCompanionMessage, setActiveWorkspace, probeHealth };
export type { CanaryEntry, Evidence, AssertionResult, HttpResult } from '../jarvis-canary/types.js';

// ─── 镜像助手（来源见文件头注释） ───

export function bodyString(e: CanaryEntry, key: string): string | undefined {
  const v = e.body?.[key];
  return typeof v === 'string' ? v : undefined;
}

export function bodyNumber(e: CanaryEntry, key: string): number | undefined {
  const v = e.body?.[key];
  return typeof v === 'number' ? v : undefined;
}

export function phaseOf(e: CanaryEntry): string | undefined {
  return bodyString(e, 'phase');
}

export function isDelegation(e: CanaryEntry): boolean {
  return e.category === 'delegation';
}

/** 定位"本次发送"的 dialog in 锚点：direction=in 且文本精确匹配（同文本重复取最新）。镜像自 scenarios.ts:113。 */
export function findOwnDialogIn(entries: CanaryEntry[], text: string): CanaryEntry | undefined {
  const target = text.trim();
  return entries
    .filter((e) => bodyString(e, 'direction') === 'in' && bodyString(e, 'text')?.trim() === target)
    .at(-1);
}

/** 锚点缺失时的退回说明（随 notes 进报告，防静默降级）。镜像自 scenarios.ts:121。 */
export const ANCHOR_FALLBACK_NOTE =
  '未找到本次消息的 dialog in 锚点（文本精确匹配失败）——断言退回窗口全域判定；' +
  '若与上一次运行间隔不足 5s，残留行可能被误判成本次结果，建议拉开间隔复跑。';

/** 断言构造。镜像自 scenarios.ts:165（同签名同行为）。 */
export function assertThat(
  id: string,
  desc: string,
  ok: boolean,
  expected: string,
  actual: string,
  evidence: Evidence[] = [],
): AssertionResult {
  return { id, desc, ok, expected, actual, evidence };
}

// ─── 只读查询助手 ───

export function queryRows(
  ctx: ProbeContext,
  filter: { category?: string; source?: string; agentId?: string; projectId?: string; sessionId?: string; taskId?: string; level?: string; since?: number; until?: number; limit?: number; offset?: number },
  anchorId = 0,
): CanaryEntry[] {
  const rows = ctx.query({ ...filter, order: 'asc', limit: filter.limit ?? 200 });
  return anchorId > 0 ? rows.filter((e) => e.id > anchorId) : rows;
}

export function dialogRows(ctx: ProbeContext, since: number, anchorId = 0): CanaryEntry[] {
  return queryRows(ctx, { category: 'dialog', since }, anchorId);
}

export function dialogOutRows(ctx: ProbeContext, since: number, anchorId = 0): CanaryEntry[] {
  return dialogRows(ctx, since, anchorId).filter((e) => bodyString(e, 'direction') === 'out');
}

export function delegationRows(ctx: ProbeContext, since: number, anchorId = 0): CanaryEntry[] {
  return queryRows(ctx, { category: 'delegation', since }, anchorId);
}

export function dispatchedRows(ctx: ProbeContext, since: number, anchorId = 0): CanaryEntry[] {
  return delegationRows(ctx, since, anchorId).filter((e) => phaseOf(e) === 'dispatched');
}

/** 路由判定行（category=system / source=project-routing；任务14·P1 埋点） */
export function routingRows(ctx: ProbeContext, since: number, anchorId = 0): CanaryEntry[] {
  return queryRows(ctx, { category: 'system', source: 'project-routing', since }, anchorId);
}

/** 播报行（category=broadcast；activity-log.ts:99 logBroadcast） */
export function broadcastRows(ctx: ProbeContext, since: number, anchorId = 0): CanaryEntry[] {
  return queryRows(ctx, { category: 'broadcast', since }, anchorId);
}

/** 系统活动按 source 取行（config/voice/session…；activity-log.ts 九类） */
export function systemRowsBySource(ctx: ProbeContext, source: string, since: number, anchorId = 0): CanaryEntry[] {
  return queryRows(ctx, { category: 'system', source, since }, anchorId);
}

// ─── 等待助手 ───

export async function waitDialogOut(
  ctx: ProbeContext,
  since: number,
  anchorId: number,
  timeoutMs: number,
): Promise<CanaryEntry | undefined> {
  return waitFor(() => dialogOutRows(ctx, since, anchorId)[0], { timeoutMs, pollMs: ctx.options.pollMs });
}

export async function waitRows(
  ctx: ProbeContext,
  fetcher: () => CanaryEntry[],
  pred: (rows: CanaryEntry[]) => boolean,
  timeoutMs: number,
): Promise<CanaryEntry[] | undefined> {
  return waitFor(() => {
    const rows = fetcher();
    return rows.length > 0 && pred(rows) ? rows : undefined;
  }, { timeoutMs, pollMs: ctx.options.pollMs });
}

export function waitDispatched(ctx: ProbeContext, since: number, anchorId: number, timeoutMs: number): Promise<CanaryEntry[] | undefined> {
  return waitRows(ctx, () => dispatchedRows(ctx, since, anchorId), (rows) => rows.length > 0, timeoutMs);
}

export function waitDelegationPhase(ctx: ProbeContext, phase: string, since: number, anchorId: number, timeoutMs: number): Promise<CanaryEntry[] | undefined> {
  return waitRows(
    ctx,
    () => delegationRows(ctx, since, anchorId).filter((e) => phaseOf(e) === phase),
    (rows) => rows.length > 0,
    timeoutMs,
  );
}

export function waitRouting(ctx: ProbeContext, since: number, anchorId: number, timeoutMs: number): Promise<CanaryEntry[] | undefined> {
  return waitRows(ctx, () => routingRows(ctx, since, anchorId), (rows) => rows.length > 0, timeoutMs);
}

// ─── 发送回合（锚点纪律的唯一入口） ───

export interface TurnResult {
  res: HttpResult;
  since: number;
  anchorId: number;
  anchorNote?: string;
  out?: CanaryEntry;
}

export async function sendTurn(
  ctx: ProbeContext,
  text: string,
  opts?: { waitOut?: boolean; outTimeoutMs?: number; event?: boolean },
): Promise<TurnResult> {
  const sentAt = Date.now();
  const since = sentAt - CLOCK_MARGIN_MS;
  const res = await sendCompanionMessage(ctx.transport, text, { event: opts?.event ?? false });
  ctx.log(`→ 发送（HTTP ${res.status}${res.ok ? '' : ` ${res.error ?? ''}`}）：${truncate(text, 80)}`);

  // 锚点：等待 dialog in 落盘（写入延迟通常 <2s；10s 兜底）
  const anchor = await waitFor(
    () => findOwnDialogIn(dialogRows(ctx, since, 0), text),
    { timeoutMs: 10_000, pollMs: ctx.options.pollMs },
  );
  const anchorId = anchor?.id ?? 0;
  const anchorNote = anchor ? undefined : ANCHOR_FALLBACK_NOTE;
  if (anchorNote) ctx.log(`⚠ ${anchorNote}`);

  const result: TurnResult = { res, since, anchorId, anchorNote };
  if (opts?.waitOut !== false) {
    result.out = await waitDialogOut(ctx, since, anchorId, opts?.outTimeoutMs ?? ctx.options.logWaitMs);
    if (result.out) {
      ctx.log(`← 回复（id=${result.out.id}，action=${bodyString(result.out, 'action') ?? '—'}）：${truncate(bodyString(result.out, 'text'), 100)}`);
    } else {
      ctx.log(`⚠ ${ctx.options.logWaitMs}ms 内未见 dialog out（id>${anchorId}）`);
    }
  }
  return result;
}

/** 按 id 取回锚点行（锚点刚写入，用探针窗口 since 兜底查询；id 命中即返回） */
export function entryById(ctx: ProbeContext, id: number, since: number): CanaryEntry | undefined {
  if (id <= 0) return undefined;
  return ctx.query({ category: 'dialog', since, order: 'asc', limit: 200 }).find((e) => e.id === id);
}

export function decisionOf(out?: CanaryEntry): string | undefined {
  return out ? bodyString(out, 'action') : undefined;
}

export function isTaskDecision(out?: CanaryEntry): boolean {
  const action = decisionOf(out);
  return action !== undefined && (TASK_ACTIONS as readonly string[]).includes(action);
}

// ─── 违规判定 ───

/** 违规直派：dispatched 行目标不是任何 Boss（含 phase=blocked 视为告警行，另行收集） */
export function bossOnlyViolations(rows: CanaryEntry[], bossIds: Set<string>): CanaryEntry[] {
  return rows.filter((e) => {
    const to = e.agentId ?? bodyString(e, 'toAgentId');
    return to !== undefined && !bossIds.has(to);
  });
}

export function blockedRows(ctx: ProbeContext, since: number, anchorId = 0): CanaryEntry[] {
  return delegationRows(ctx, since, anchorId).filter((e) => phaseOf(e) === 'blocked');
}

// ─── 原始 HTTP（二进制端点 /tts/speak、/stt/transcribe 用；canary transport 只解析 JSON） ───

export interface RawResponse {
  ok: boolean;
  status: number;
  contentType?: string;
  text?: string;
  buffer?: Buffer;
  error?: string;
}

export async function rawFetch(
  ctx: ProbeContext,
  pathName: string,
  opts: { method?: string; body?: unknown; timeoutMs?: number; binary?: boolean; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  const base = ctx.options.baseUrl.trim().replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) };
  if (ctx.options.token) headers['X-Auth-Token'] = ctx.options.token;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? ctx.options.httpTimeoutMs);
  try {
    const res = await fetch(`${base}${pathName}`, {
      method: opts.method ?? 'POST',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    });
    const contentType = res.headers.get('content-type') ?? undefined;
    if (opts.binary) {
      const buf = Buffer.from(await res.arrayBuffer());
      return { ok: res.ok, status: res.status, contentType, buffer: buf };
    }
    const text = await res.text();
    return { ok: res.ok, status: res.status, contentType, text };
  } catch (err) {
    const msg = err instanceof Error
      ? (err.name === 'AbortError' ? `请求超时（${opts.timeoutMs ?? ctx.options.httpTimeoutMs}ms）` : err.message)
      : String(err);
    return { ok: false, status: 0, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ─── 项目发现（复刻 canary scenarios.ts:212-265 的 workspace→area→唯一 Boss 链） ───

export interface DiscoveredProject { id: string; name: string; bossId: string; bossName: string }

function bossLike(a: { isBoss?: boolean; class?: string }): boolean {
  return a.isBoss === true || a.class === 'boss';
}

export async function discoverProjects(ctx: ProbeContext): Promise<{
  ok: boolean; projects: DiscoveredProject[]; excluded: string[]; error?: string;
}> {
  const ws = await fetchWorkspaces(ctx.transport);
  if (!ws.ok) return { ok: false, projects: [], excluded: [], error: `读取 /api/workspaces 失败：${ws.error}` };
  const areasRes = await fetchAreas(ctx.transport);
  if (!areasRes.ok) return { ok: false, projects: [], excluded: [], error: `读取 /api/areas 失败：${areasRes.error}` };
  const agRes = await fetchAgents(ctx.transport);
  if (!agRes.ok) return { ok: false, projects: [], excluded: [], error: `读取 /api/agents 失败：${agRes.error}` };

  const byId = new Map(agRes.agents.map((a) => [a.id, a]));
  const projects: DiscoveredProject[] = [];
  const excluded: string[] = [];
  for (const w of ws.workspaces) {
    const areaIds = new Set(w.areaIds ?? []);
    const memberIds = new Set<string>();
    const candidates: string[] = [];
    for (const area of areasRes.areas) {
      if (area.archived || !areaIds.has(area.id)) continue;
      for (const id of area.assignedAgentIds ?? []) {
        memberIds.add(id);
        const agent = byId.get(id);
        if (agent && bossLike(agent)) candidates.push(id);
      }
    }
    if (candidates.length === 0) {
      for (const id of memberIds) {
        const bossId = byId.get(id)?.bossId;
        const boss = bossId ? byId.get(bossId) : undefined;
        if (boss && bossLike(boss)) candidates.push(boss.id);
      }
    }
    const unique = [...new Set(candidates)];
    if (unique.length === 0) {
      excluded.push(`${w.name}（区域无成员或无 boss-like 主管）`);
      continue;
    }
    if (unique.length > 1) {
      excluded.push(`${w.name}（候选主管 ${unique.length} 个）`);
      continue;
    }
    const boss = byId.get(unique[0]);
    if (!boss) { excluded.push(`${w.name}（主管 ${unique[0]} 不在 agent 列表）`); continue; }
    projects.push({ id: w.id, name: w.name, bossId: boss.id, bossName: boss.name });
  }
  return { ok: true, projects, excluded };
}

/** 取全部 boss-like agent id 集合（违规直派判定的白名单） */
export async function bossIdSet(ctx: ProbeContext): Promise<Set<string>> {
  const ag = await fetchAgents(ctx.transport);
  return new Set(ag.agents.filter((a) => bossLike(a)).map((a) => a.id));
}

// ─── 落盘/杂项 ───

export function toolDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

export function scratchDir(): string {
  const dir = path.join(toolDir(), 'scratch');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ }
  return dir;
}

export function reportsDir(): string {
  const dir = path.join(toolDir(), 'reports');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ }
  return dir;
}

export function statePath(): string {
  return path.join(toolDir(), '.env-prep-state.json');
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 仓库根（tools/human-campaign/ 往上两级）——机制证据链读源码用 */
export function repoRoot(): string {
  return path.resolve(toolDir(), '..', '..');
}

// ─── 前置检查注册表 ───

export interface PrereqDef {
  id: string;
  desc: string;
  hint: string;
  kind: 'env' | 'runtime';
  check(ctx: ProbeContext): Promise<PrereqResult>;
}

function prereq(id: string, desc: string, ok: boolean, detail: string, kind: 'env' | 'runtime' = 'runtime'): PrereqResult {
  return { id, desc, ok, detail, kind };
}

export const PREREQS: ReadonlyMap<string, PrereqDef> = new Map<string, PrereqDef>([
  ['serverReachable', {
    id: 'serverReachable', desc: 'dev server 可达（GET /api/health）', hint: '启动 tc-dev 窗口后再跑', kind: 'env',
    check: async (ctx) => {
      const res = await probeHealth(ctx.transport);
      return prereq('serverReachable', 'dev server 可达', res.ok, res.ok ? `HTTP ${res.status}（${res.elapsedMs}ms）` : (res.error ?? `HTTP ${res.status}`), 'env');
    },
  }],
  ['dbReadable', {
    id: 'dbReadable', desc: 'events.db 只读可查', hint: '确认 dev server 已启动过（建库）且 XDG_DATA_HOME 一致', kind: 'env',
    check: async (ctx) => prereq('dbReadable', 'events.db 只读可查', ctx.dbStats.totalRows >= 0, `db=${ctx.dbStats.dbPath} rows=${ctx.dbStats.totalRows}`, 'env'),
  }],
  ['companionAvailable', {
    id: 'companionAvailable', desc: '语音伙伴可用（GET /api/voice-companion/status）', hint: '检查秘书配置与后端启动日志', kind: 'env',
    check: async (ctx) => {
      const res = await ctx.transport.httpGet('/api/voice-companion/status');
      const available = res.json?.available;
      const ok = res.ok && available !== false;
      return prereq('companionAvailable', '语音伙伴可用', ok, ok ? `HTTP ${res.status} available=${String(available ?? '(未标注)')}` : `HTTP ${res.status} ${res.error ?? ''}`, 'env');
    },
  }],
  ['bossExists', {
    id: 'bossExists', desc: '至少 1 个 boss-like 主管', hint: '在 UI 建立主管（Boss）', kind: 'env',
    check: async (ctx) => {
      const ag = await fetchAgents(ctx.transport);
      const boss = findBoss(ag.agents);
      return prereq('bossExists', '至少 1 个 boss-like 主管', !!boss, boss ? `boss=${boss.name}(${boss.id})` : '未找到 isBoss/class=boss 的 agent');
    },
  }],
  ['teamIdle', {
    id: 'teamIdle', desc: '全部 agent 空闲（无在办任务）', hint: '等任务收尾或先跑 --cleanup', kind: 'runtime',
    check: async (ctx) => {
      const ag = await fetchAgents(ctx.transport);
      const busy = ag.agents.filter((a) => a.status === 'running' || a.status === 'processing');
      return prereq('teamIdle', '全部 agent 空闲', busy.length === 0, busy.length === 0 ? `${ag.agents.length} 个 agent 均空闲` : `忙：${busy.map((a) => `${a.name}(${a.status})`).join(', ')}`);
    },
  }],
  ['multiProjectReady', {
    id: 'multiProjectReady', desc: '≥2 个可路由项目（workspace→区域→唯一 Boss）', hint: '先跑 --env-prep=setup 或按 UI 提示准备项目', kind: 'env',
    check: async (ctx) => {
      const r = await discoverProjects(ctx);
      return prereq('multiProjectReady', '≥2 个可路由项目', r.ok && r.projects.length >= 2,
        r.ok ? `projects=${r.projects.length}（${r.projects.map((p) => p.name).join('/') || '无'}）；排除：${r.excluded.join('；') || '无'}` : (r.error ?? ''));
    },
  }],
  ['campaignEnv', {
    id: 'campaignEnv', desc: '战役环境已布置（.env-prep-state.json + A/B/C 三项目在线）', hint: '跑 --env-prep=setup（会写环境，需用户确认）', kind: 'env',
    check: async (ctx) => {
      const st = ctx.shared.envPrep as { projects?: Array<{ key: string; workspaceId: string; bossId: string; name: string }> } | undefined;
      if (!st?.projects?.length) {
        return prereq('campaignEnv', '战役环境已布置', false, '未找到 .env-prep-state.json（或 projects 为空）——先跑 --env-prep=setup', 'env');
      }
      const r = await discoverProjects(ctx);
      if (!r.ok) return prereq('campaignEnv', '战役环境已布置', false, r.error ?? '', 'env');
      const bad: string[] = [];
      for (const p of st.projects) {
        const found = r.projects.find((x) => x.id === p.workspaceId && x.bossId === p.bossId);
        if (!found) bad.push(`${p.key}(${p.name})`);
      }
      return prereq('campaignEnv', '战役环境已布置', bad.length === 0,
        bad.length === 0 ? `A/B/C 在线：${st.projects.map((p) => `${p.key}=${p.name}→${p.bossId}`).join('；')}` : `失联项目：${bad.join(', ')}`, 'env');
    },
  }],
  ['ttsAvailable', {
    id: 'ttsAvailable', desc: 'TTS 可合成（POST /api/tts/speak 返回 WAV）', hint: '检查 tools/piper 垫片与 edge-tts 网络', kind: 'runtime',
    check: async (ctx) => {
      const res = await rawFetch(ctx, '/api/tts/speak', { body: { text: '测试' }, timeoutMs: 20_000, binary: true });
      const ok = res.ok && (res.buffer?.length ?? 0) > 0 && (res.contentType ?? '').includes('audio');
      return prereq('ttsAvailable', 'TTS 可合成', ok,
        ok ? `HTTP ${res.status} ${res.contentType} ${res.buffer?.length}B` : `HTTP ${res.status} ${res.error ?? res.contentType ?? ''}`);
    },
  }],
]);

export async function runPrereqs(def: ProbeDef, ctx: ProbeContext, dryRun: boolean): Promise<PrereqResult[]> {
  const out: PrereqResult[] = [];
  for (const id of def.prereqIds) {
    const p = PREREQS.get(id);
    if (!p) {
      out.push({ id, desc: id, ok: false, detail: `未知前置 id（注册表缺失）：${id}`, kind: 'env' });
      continue;
    }
    if (dryRun && p.kind === 'runtime') {
      out.push({ id, desc: p.desc, ok: true, detail: 'dry-run：runtime 前置延后到真跑检查', kind: 'runtime', deferred: true });
      continue;
    }
    const r = await p.check(ctx);
    out.push({ ...r, desc: p.desc });
    if (!r.ok) break; // 首个失败短路（与 canary runPrereqs 同型）
  }
  return out;
}

// ─── 报告辅助 ───

export function outcomeSummary(outcome: ProbeOutcome): string {
  const failed = outcome.assertions.filter((a) => !a.ok);
  if (outcome.skipReason) return `SKIP：${outcome.skipReason}`;
  if (failed.length === 0) return `${outcome.assertions.length} 条断言全过`;
  return `${failed.length}/${outcome.assertions.length} 条断言失败：${failed.map((a) => a.id).join(', ')}`;
}

export function readStateFile(): { ok: boolean; state?: Record<string, unknown>; error?: string } {
  const p = statePath();
  if (!fs.existsSync(p)) return { ok: false, error: `状态文件不存在：${p}` };
  try {
    return { ok: true, state: JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: `状态文件解析失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

export function writeStateFile(state: Record<string, unknown>): void {
  fs.writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function deleteStateFile(): void {
  try { fs.unlinkSync(statePath()); } catch { /* 忽略 */ }
}

/** 供 run.ts 使用的上下文构造类型收窄 */
export interface QueryHolder {
  lq: ReadOnlyLogQuery;
  query: LogQueryFn;
  transport: CanaryTransport;
  options: HumanOptions;
}
