/**
 * C4 · 机器面与长周期（HC-34..40）
 *
 * 覆盖：常驻化冷热（任务18）· 系统活动 config 行（19·A·⑭）· 日志分析日报
 * （19·A·⑮）· 哨兵事件闸口降级【分段+重启】(任务33) · 隔夜 cron 取证
 * （33/19·A/12/29）· Bolba 查询（13·⑩）· 孤儿恢复【分段+重启】(19·A·⑭P2)。
 *
 * 分段探针（HC-37/HC-40）用 `--stage=prep|verify|cleanup` 跨"服务端重启"执行；
 * 未给 stage 时如实 SKIP 并打印指引。重启动作由用户点头执行（战役裁决④）。
 *
 * 机制证据面（本波取证）：
 *   sentinel 抑制事件 → dialog in 行 action='sentinel-store-only'/'sentinel-throttle'、
 *     degraded=true，且 HTTP 应答 {success:true,action:'noop',response:''}（routes/
 *     voice-companion.ts:113-128；不调 LLM、不出声、无 broadcast）。
 *   config 切工作区 → system/source='config'，body {cat:'config',key:'workspace',
 *     action:'switch',value}（routes/workspaces.ts:53）。
 *   晨报 → source='boss-morning-report'，body.op='deliver'，含 dailyReport/bolbaDue
 *     （29 覆盖账字段）；日报 → source='daily-log-report'；哨兵 → source='sentinel'。
 *   phase-state.json = XDG_DATA_HOME||~/.local/share + tide-commander/jarvis-sentinel/
 *     phase-state.json，形状见 jarvis-core/sentinel/types.ts:454；评昨日 cron 00:10。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CanaryEntry, ProbeContext, ProbeDef, ProbeOutcome } from '../types.js';
import {
  assertThat, bodyNumber, bodyString, delegationRows, dialogRows, dialogOutRows,
  dispatchedRows, entryEvidence, fetchActiveWorkspace, fetchAgents, fetchWorkspaces,
  observedSummary, queryRows, rawFetch, scratchDir, sendTurn, setActiveWorkspace, sleep,
  systemRowsBySource, truncate, waitRows, BUSY_AGENT_STATUSES,
} from '../runner.js';
import { stopAgent } from '../ws-client.js';

// ─── 本地助手 ───

/** 镜像 jarvis-core/sentinel/stats.ts:50（本地日键 = YYYY-M-D，不补零） */
function localDayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function sentinelStateFile(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'tide-commander', 'jarvis-sentinel', 'phase-state.json');
}

function readFileText(p: string): { exists: boolean; text?: string } {
  try { return { exists: true, text: fs.readFileSync(p, 'utf8') }; } catch { return { exists: false }; }
}

function scratchFile(name: string): string {
  return path.join(scratchDir(), name);
}

function writeJsonFile(p: string, value: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 原始 agent 行（带 isDetached/status 等 fetchAgents 未映射字段） */
async function rawAgents(ctx: ProbeContext): Promise<Array<Record<string, unknown>>> {
  const res = await ctx.transport.httpGet('/api/agents');
  const raw = res.json as unknown;
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  const v = (raw as { value?: unknown })?.value;
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

async function companionStatus(ctx: ProbeContext): Promise<Record<string, unknown> | undefined> {
  const res = await ctx.transport.httpGet('/api/voice-companion/status');
  return res.ok ? (res.json as Record<string, unknown>) : undefined;
}

// ─── HC-34 常驻化冷热 ───

const hc34: ProbeDef = {
  id: 'HC-34', wave: 4, title: '常驻化冷热：residentPid 非空 + 跨回合同 pid + turns 递增 + 时延记录', dim: '机器面·常驻化', effect: 'none',
  utterance: '在吗？ / 收到请说"在" / 再说一遍"在"',
  steps: ['读 status 基线', '热身回合（触发常驻 spawn）', '两回合实测并记录 HTTP 时延', '复读 status：同 pid + turns 递增'],
  assertionDocs: ['status 可读', '热身回合后 residentPid 非空（常驻已起）', '后续回合 residentPid 不变（同进程复用）', 'turns 至少 +3'],
  prereqIds: ['serverReachable', 'companionAvailable'],
  run: async (ctx) => {
    const s0 = await companionStatus(ctx);
    const assertions: ProbeOutcome['assertions'] = [];
    assertions.push(assertThat('hc34-status', 'GET /status 可读', !!s0, '200 JSON', s0 ? 'ok' : '不可读'));
    if (!s0) return { assertions, notes: [] };
    const t1 = await sendTurn(ctx, '在吗？');
    const s1 = await companionStatus(ctx);
    const t2 = await sendTurn(ctx, '收到请说"在"');
    const t3 = await sendTurn(ctx, '再说一遍"在"');
    const s2 = await companionStatus(ctx);
    const pid1 = s1?.residentPid ?? null;
    const pid2 = s2?.residentPid ?? null;
    const turns0 = Number(s0.turns ?? 0), turns2 = Number(s2?.turns ?? 0);
    const lat = [t1.res.elapsedMs, t2.res.elapsedMs, t3.res.elapsedMs];
    assertions.push(assertThat('hc34-resident', '热身回合后 residentPid 非空（常驻已起）', pid1 != null,
      'number', `${String(pid1)}（s1）`));
    assertions.push(assertThat('hc34-same-pid', '后续回合 residentPid 不变（同进程复用）', pid1 != null && pid2 === pid1,
      String(pid1), `${String(pid2)}`));
    assertions.push(assertThat('hc34-turns', 'turns 至少 +3（3 个真实回合）', turns2 - turns0 >= 3,
      `≥ ${turns0 + 3}`, String(turns2)));
    assertions.push(assertThat('hc34-http-ok', '3 回合均 HTTP 200', [t1, t2, t3].every((t) => t.res.ok),
      '全部 200', lat.map((_, i) => `t${i + 1}=${(lat[i] / 1000).toFixed(1)}s`).join(' ')));
    return {
      assertions,
      notes: [
        `时延（HTTP 全程，含 hop1 LLM）：${lat.map((ms) => `${(ms / 1000).toFixed(1)}s`).join(' / ')}`,
        `context=${truncate(JSON.stringify(s2?.context ?? null), 200)}`,
      ],
      observed: [],
    };
  },
};

// ─── HC-35 系统活动 config 行 ───

const hc35: ProbeDef = {
  id: 'HC-35', wave: 4, title: '系统活动：切 active 一次 → config(workspace switch) 行 + 还原', dim: '机器面·系统活动', effect: 'env',
  utterance: '（无对话；PUT /api/workspaces/active 两次）',
  steps: ['读当前 active 与工作区表', '切到另一个工作区', '断 config 行（key=workspace action=switch value=目标）', '还原并断还原行'],
  assertionDocs: ['切换 HTTP 200', 'config 行出现且 value=目标 id', '还原后 config 行 value=原 active'],
  prereqIds: ['serverReachable', 'dbReadable', 'bossExists'],
  run: async (ctx) => {
    const prev = await fetchActiveWorkspace(ctx.transport);
    const ws = await fetchWorkspaces(ctx.transport);
    if (!ws.ok || ws.workspaces.length < 2) {
      return { assertions: [], notes: [], skipReason: `工作区不足 2 个（${ws.workspaces.length} 个）——无法做还原式切换` };
    }
    const target = ws.workspaces.find((w) => w.id !== prev.workspaceId) ?? ws.workspaces[0];
    const since = Date.now() - 3000;
    const put1 = await setActiveWorkspace(ctx.transport, target.id);
    await sleep(1500);
    const rows1 = systemRowsBySource(ctx, 'config', since, 0)
      .filter((e) => bodyString(e, 'key') === 'workspace' && bodyString(e, 'action') === 'switch');
    const hit1 = rows1.filter((e) => (bodyString(e, 'value') ?? null) === target.id);
    const put2 = await setActiveWorkspace(ctx.transport, prev.workspaceId);
    await sleep(1500);
    const rows2 = systemRowsBySource(ctx, 'config', since, 0)
      .filter((e) => bodyString(e, 'key') === 'workspace' && bodyString(e, 'action') === 'switch');
    const restoredOk = prev.workspaceId === null
      ? rows2.some((e) => e.body?.value === null || e.body?.value === undefined)
      : rows2.some((e) => bodyString(e, 'value') === prev.workspaceId);
    return {
      assertions: [
        assertThat('hc35-http', '两次切换 HTTP 200', put1.ok && put2.ok, '200/200', `${put1.status}/${put2.status}`),
        assertThat('hc35-config-row', 'config 行 value=目标工作区', hit1.length >= 1, target.id,
          rows1.map((e) => bodyString(e, 'value') ?? '(null)').join(',') || '（无 config 行）',
          hit1.slice(0, 2).map((e) => entryEvidence(e, ['cat', 'key', 'action', 'value'], 80))),
        assertThat('hc35-restored', '还原行 value=原 active', restoredOk, `原 active=${String(prev.workspaceId)}`,
          rows2.map((e) => bodyString(e, 'value') ?? '(null)').join(',')),
      ],
      notes: [`目标工作区=${target.name}(${target.id})；原 active=${String(prev.workspaceId)}`],
      observed: observedSummary(rows2),
    };
  },
};

// ─── HC-36 日志分析 + 日报 ───

const hc36: ProbeDef = {
  id: 'HC-36', wave: 4, title: '日志分析：「帮我分析下昨天的日志」→ action=analyze_logs + 渲染报告落盘', dim: '机器面·日志分析', effect: 'none',
  utterance: '帮我分析下昨天的日志',
  steps: ['发送分析请求', '等 dialog out（长窗）', '断 action=analyze_logs + 报告文本长度信号'],
  assertionDocs: ['HTTP 200', '有 dialog out', "out.action='analyze_logs'", '报告文本非平凡（>200 字符，渲染报告而非寒暄）'],
  prereqIds: ['serverReachable', 'companionAvailable', 'dbReadable'],
  run: async (ctx) => {
    const t = await sendTurn(ctx, '帮我分析下昨天的日志', { outTimeoutMs: Math.max(ctx.options.logWaitMs, 150_000) });
    const outText = bodyString(t.out, 'text') ?? '';
    const action = t.out ? bodyString(t.out, 'action') : undefined;
    return {
      assertions: [
        assertThat('hc36-http', 'HTTP 200', t.res.ok, '200', `${t.res.status}`),
        assertThat('hc36-out', '有 dialog out', !!t.out, 'out 行存在', t.out ? `id=${t.out.id}` : '无'),
        assertThat('hc36-action', "out.action='analyze_logs'", action === 'analyze_logs', 'analyze_logs', String(action ?? '（无 action）'),
          t.out ? [entryEvidence(t.out, ['action', 'text', 'degraded'], 60)] : []),
        assertThat('hc36-rendered', '报告文本非平凡（>200 字符）', outText.length > 200, '>200', `${outText.length} 字符`),
      ],
      notes: [`报告文本样本：${truncate(outText, 200)}`],
      observed: [],
    };
  },
};

// ─── HC-37 哨兵降级闸口【分段 + 重启】 ───

const HC37_EVENT_TEXT = '战役哨兵闸口验证（事件探针）';

const hc37: ProbeDef = {
  id: 'HC-37', wave: 4, title: '哨兵事件闸口：degraded 相位 → event=true 被抑制 / event=false 必答', dim: '机器面·哨兵闸口', effect: 'restart',
  utterance: `（event=true）${HC37_EVENT_TEXT} / （event=false）在吗？报个平安`,
  steps: [
    '--stage=prep：快照 phase-state.json + 写 degraded（随后需重启）',
    '（用户点头）重启 dev server',
    '--stage=verify：event=true 断抑制（noop + sentinel-store-only 行）；event=false 断必答；然后还原文件',
    '（用户点头）再重启回 normal；--stage=cleanup：断文件还原',
  ],
  assertionDocs: ['prep：degraded 文件写入成功', 'verify：event=true 返 noop + 无 out + sentinel-store-only 行', 'verify：event=false 正常应答', 'verify：文件已还原', 'cleanup：文件与快照一致'],
  prereqIds: ['serverReachable', 'companionAvailable', 'dbReadable'],
  run: async (ctx) => {
    const stage = ctx.options.stage;
    const stFile = sentinelStateFile();
    const snapFile = scratchFile('hc37-sentinel.snapshot.json');
    if (!stage) {
      return { assertions: [], notes: [`phase-state：${stFile}`, `快照路径：${snapFile}`], skipReason: '分段探针：用 --stage=prep → 重启 → --stage=verify → 重启 → --stage=cleanup 执行' };
    }

    if (stage === 'prep') {
      const cur = readFileText(stFile);
      if (fs.existsSync(snapFile)) {
        return { assertions: [], notes: [], skipReason: '快照已存在（可能上次未 cleanup）——先 --stage=cleanup' };
      }
      writeJsonFile(snapFile, { existed: cur.exists, text: cur.text ?? null, savedAt: Date.now() });
      const now = Date.now();
      const deg = {
        phase: 'degraded', since: now, sinceDay: localDayKey(now),
        healthyStreakDays: 0, lastEvaluatedDay: localDayKey(now - 86_400_000),
        lastVerdict: 'critical', updatedAt: now,
      };
      writeJsonFile(stFile, deg);
      const check = readFileText(stFile);
      const parsed = check.text ? JSON.parse(check.text) as Record<string, unknown> : {};
      return {
        assertions: [
          assertThat('hc37-prep-snap', '原状态已快照', fs.existsSync(snapFile), '快照文件存在', snapFile),
          assertThat('hc37-prep-write', 'degraded 已写入', parsed.phase === 'degraded', 'degraded', String(parsed.phase ?? '解析失败')),
        ],
        notes: [`下一步（用户点头）：重启 dev server，然后 --stage=verify`, `相位在服务端进程内缓存——不重启则 verify 必红`],
      };
    }

    if (stage === 'verify') {
      const cur = readFileText(stFile);
      const assertions: ProbeOutcome['assertions'] = [];
      assertions.push(assertThat('hc37-verify-file', '重启后文件仍为 degraded', (cur.text ?? '').includes('"degraded"'),
        'degraded', truncate(cur.text ?? '(文件不存在)', 100)));
      // event=true → 抑制
      const evSince = Date.now() - 3000;
      const ev = await rawFetch(ctx, '/api/voice-companion/process', { body: { text: HC37_EVENT_TEXT, event: true } });
      let evJson: Record<string, unknown> = {};
      try { evJson = ev.text ? JSON.parse(ev.text) as Record<string, unknown> : {}; } catch { /* 保底 */ }
      await sleep(6000);
      const suppressRows = dialogRows(ctx, evSince, 0)
        .filter((e) => (bodyString(e, 'action') ?? '').startsWith('sentinel-'));
      const evOut = dialogOutRows(ctx, evSince, 0);
      const supAction = suppressRows[0] ? bodyString(suppressRows[0], 'action') : undefined;
      assertions.push(assertThat('hc37-suppress', 'event=true 被抑制（noop 应答）',
        ev.ok && evJson.action === 'noop' && evJson.response === '' && evJson.success === true,
        'HTTP200 {success:true,action:noop,response:""}', `HTTP ${ev.status} ${truncate(ev.text ?? '', 120)}`));
      assertions.push(assertThat('hc37-suppress-row', "抑制行落盘 action='sentinel-store-only'",
        suppressRows.length >= 1 && (supAction === 'sentinel-store-only' || supAction === 'sentinel-throttle'),
        'sentinel-store-only（或 throttle）', String(supAction ?? '（无 sentinel-* 行）'),
        suppressRows.slice(0, 2).map((e) => entryEvidence(e, ['action', 'direction', 'isEvent', 'degraded'], 80))));
      assertions.push(assertThat('hc37-suppress-silent', '抑制事件无 dialog out（没调 LLM、没出声）', evOut.length === 0,
        '0', String(evOut.length)));
      // event=false → 必答
      const t = await sendTurn(ctx, '在吗？报个平安');
      assertions.push(assertThat('hc37-non-event-answer', 'event=false（老板说话）正常应答', !!t.out, 'out 行存在', t.out ? `id=${t.out.id}` : '无'));
      // 还原文件
      const snap = fs.existsSync(snapFile) ? JSON.parse(fs.readFileSync(snapFile, 'utf8')) as { existed: boolean; text: string | null } : undefined;
      if (!snap) {
        assertions.push(assertThat('hc37-restore', '还原快照可用', false, '快照存在', '缺失'));
      } else if (snap.existed && snap.text !== null) {
        fs.writeFileSync(stFile, snap.text, 'utf8');
        assertions.push(assertThat('hc37-restore', 'phase-state 已字节级还原（原文件）',
          fs.readFileSync(stFile, 'utf8') === snap.text, '与快照全等', '已回写'));
      } else {
        try { fs.unlinkSync(stFile); } catch { /* 本来不存在 */ }
        assertions.push(assertThat('hc37-restore', 'phase-state 已还原（原本不存在→已删除）', !fs.existsSync(stFile), '文件不存在', '已删除'));
      }
      return {
        assertions,
        notes: ['下一步（用户点头）：再重启 dev server 让相位回 normal（进程内缓存），然后 --stage=cleanup 复核'],
        observed: observedSummary([...suppressRows, ...evOut]),
      };
    }

    if (stage === 'cleanup') {
      const snap = fs.existsSync(snapFile) ? JSON.parse(fs.readFileSync(snapFile, 'utf8')) as { existed: boolean; text: string | null } : undefined;
      if (!snap) return { assertions: [], notes: [], skipReason: '无快照可复核' };
      const nowText = readFileText(stFile);
      const same = snap.existed ? (nowText.exists && nowText.text === snap.text) : !nowText.exists;
      const assertions = [
        assertThat('hc37-cleanup-match', 'phase-state 与快照一致（字节级）', same,
          snap.existed ? '内容全等' : '不存在',
          nowText.exists ? truncate(nowText.text ?? '', 120) : '不存在'),
      ];
      fs.unlinkSync(snapFile);
      return {
        assertions,
        notes: ['快照已清理；相位若有缓存残留，重启一次即回文件态 normal'],
      };
    }

    return { assertions: [], notes: [], skipReason: `未知 stage=${stage}（合法：prep|verify|cleanup）` };
  },
};

// ─── HC-38 隔夜 cron 取证 ───

const hc38: ProbeDef = {
  id: 'HC-38', wave: 4, title: '隔夜 cron：00:10 哨兵 / 07:00 日报 / 08:00 晨报（+29 覆盖账字段）', dim: '机器面·长周期', effect: 'none',
  utterance: '（无对话；读 events.db + phase-state.json）',
  steps: ['取今日 00:00 起窗口', '扫 daily-log-report / boss-morning-report / sentinel 三类证据', '抽 29 覆盖账字段（dailyReport/bolbaDue）登记'],
  assertionDocs: ['≥08:10 才取证（更早 SKIP）', '日报行出现', '晨报行或播报出现', '哨兵：行或 phase-state 证据'],
  prereqIds: ['serverReachable', 'dbReadable'],
  run: async (ctx) => {
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    if (mins < 8 * 60 + 10) {
      return { assertions: [], notes: [`当前 ${now.toLocaleTimeString()}——今日 08:10 前，晨报/日报取证窗口未到`], skipReason: '早于 08:10，隔夜取证未到窗口（计划口径）' };
    }
    const since = startOfToday();
    const dailyRows = queryRows(ctx, { category: 'system', source: 'daily-log-report', since }, 0);
    const morningRows = queryRows(ctx, { category: 'system', source: 'boss-morning-report', since }, 0);
    const morningBroadcast = queryRows(ctx, { category: 'broadcast', since }, 0)
      .filter((e) => bodyString(e, 'action') === 'boss_morning_report');
    const sentinelRows = queryRows(ctx, { category: 'system', source: 'sentinel', since }, 0);
    const stFile = sentinelStateFile();
    const st = readFileText(stFile);
    let stJson: Record<string, unknown> = {};
    try { stJson = st.text ? JSON.parse(st.text) as Record<string, unknown> : {}; } catch { /* 保底 */ }
    const stUpdatedToday = typeof stJson.updatedAt === 'number' && stJson.updatedAt >= since;
    const deliver = morningRows.filter((e) => bodyString(e, 'op') === 'deliver');
    const deliverBody = deliver[0];
    return {
      assertions: [
        assertThat('hc38-daily', '07:00 日报已生成（daily-log-report 行）', dailyRows.length >= 1, '≥1', String(dailyRows.length),
          dailyRows.slice(0, 2).map((e) => entryEvidence(e, ['cat', 'sections', 'windowLabel', 'mdFile'], 120))),
        assertThat('hc38-morning', '08:00 晨报已生成（行或播报）', deliver.length >= 1 || morningBroadcast.length >= 1,
          'deliver≥1 或 broadcast≥1', `deliver=${deliver.length} broadcast=${morningBroadcast.length}`,
          deliver.slice(0, 2).map((e) => entryEvidence(e, ['op', 'yesterday', 'segments', 'tier', 'dailyReport', 'bolbaDue'], 120))),
        assertThat('hc38-sentinel', '00:10 哨兵评估有证据（行或 state.updatedAt 今日）', sentinelRows.length >= 1 || stUpdatedToday,
          'sentinel 行≥1 或 updatedAt≥今日0点', `rows=${sentinelRows.length} updatedAt=${String(stJson.updatedAt ?? '—')}（${stUpdatedToday ? '今日' : '非今日'}）`,
          sentinelRows.slice(0, 2).map((e) => entryEvidence(e, ['cat', 'kind', 'phase', 'verdict'], 120))),
      ],
      notes: [
        `29 覆盖账字段（晨报 deliver）：dailyReport=${String(deliverBody?.body?.dailyReport ?? '—')} bolbaDue=${String(deliverBody?.body?.bolbaDue ?? '—')} tier=${String(deliverBody?.body?.tier ?? '—')} dedupeKey=${String(deliverBody?.body?.dedupeKey ?? '—')}`,
        `哨兵相位state：phase=${String(stJson.phase ?? '—')} lastEvaluatedDay=${String(stJson.lastEvaluatedDay ?? '—')}`,
      ],
      observed: observedSummary([...dailyRows, ...deliver, ...sentinelRows]),
    };
  },
};

// ─── HC-39 Bolba 查询 ───

const hc39: ProbeDef = {
  id: 'HC-39', wave: 4, title: 'Bolba：「板上有没有到期的事？」→ query_bolba_tasks 契约', dim: '机器面·Bolba 桥', effect: 'none',
  utterance: 'Bolba 板上有没有到期的事？',
  steps: ['发送查询', '断 out.action=query_bolba_tasks', '登记渲染样本与 degraded 标记（真板建卡为欠账）'],
  assertionDocs: ['HTTP 200', '有 dialog out', "out.action='query_bolba_tasks'"],
  prereqIds: ['serverReachable', 'companionAvailable'],
  optional: true,
  run: async (ctx) => {
    const t = await sendTurn(ctx, 'Bolba 板上有没有到期的事？');
    const action = t.out ? bodyString(t.out, 'action') : undefined;
    const text = bodyString(t.out, 'text') ?? '';
    return {
      assertions: [
        assertThat('hc39-http', 'HTTP 200', t.res.ok, '200', `${t.res.status}`),
        assertThat('hc39-out', '有 dialog out', !!t.out, 'out 行存在', t.out ? `id=${t.out.id}` : '无'),
        assertThat('hc39-action', "out.action='query_bolba_tasks'", action === 'query_bolba_tasks', 'query_bolba_tasks', String(action ?? '（无）'),
          t.out ? [entryEvidence(t.out, ['action', 'text', 'degraded'], 60)] : []),
      ],
      notes: [
        `渲染样本：${truncate(text, 200)}`,
        '欠账登记（计划口径）：真板建卡闭环（create → query 可见 → complete）不在本战役范围；本条只验查询契约与渲染。',
      ],
      observed: [],
    };
  },
};

// ─── HC-40 孤儿恢复【分段 + 重启】 ───

function hc40Text(ctx: ProbeContext): string {
  const st = ctx.shared.envPrep as { projects?: Array<{ key: string; name: string }> } | undefined;
  const a = st?.projects?.find((p) => p.key === 'A');
  const who = a ? `让「${a.name}」项目的团队` : '让团队';
  return `${who}做一件重启恢复验证任务：执行下属运行命令「sleep 150」，等待结束后只回复"收到"，不要做其他任何操作。`;
}

const hc40: ProbeDef = {
  id: 'HC-40', wave: 4, title: '孤儿恢复：在办任务跨重启 → 收养/输出重接（reported 落盘）', dim: '机器面·孤儿恢复', effect: 'restart',
  utterance: '（现场拼）…下属运行命令 sleep 150…',
  steps: [
    '--stage=prep：派 T2 变体（sleep 150）→ 断 delegated + 未 reported → 存状态（随后需重启）',
    '（用户点头）重启 dev server',
    '--stage=verify：断 agent 存活 + isDetached!=true + 同 taskId reported/closed 落盘 + 无重复拆解',
    '--stage=cleanup：stop agent + 删状态',
  ],
  assertionDocs: ['prep：delegated 行 + 状态落盘 + 当时未 reported', 'verify：agent 存活且未被丢弃', 'verify：任务完成后 reported/closed 出现（机器层同 taskId + 消息层到达）', 'cleanup：状态删除'],
  prereqIds: ['serverReachable', 'companionAvailable', 'campaignEnv'],
  run: async (ctx) => {
    const stage = ctx.options.stage;
    const stFile = scratchFile('hc40-restart.state.json');
    interface Hc40State { taskId: string; subAgentId: string; bossId?: string; text: string; startedAt: number; prepDoneAt: number }
    if (!stage) {
      return { assertions: [], notes: [`状态路径：${stFile}`], skipReason: '分段探针：--stage=prep → 重启 → --stage=verify → --stage=cleanup' };
    }

    if (stage === 'prep') {
      if (fs.existsSync(stFile)) {
        return { assertions: [], notes: [], skipReason: '已有未清理状态——先 --stage=cleanup' };
      }
      const text = hc40Text(ctx);
      const t = await sendTurn(ctx, text);
      const delegated = await waitRows(
        ctx,
        () => delegationRows(ctx, t.since, t.anchorId)
          .filter((e) => bodyString(e, 'phase') === 'delegated' && !!bodyString(e, 'toAgentId')),
        (rows) => rows.length >= 1,
        ctx.options.bossWaitMs,
      );
      const row = delegated?.[0];
      if (!row?.taskId) {
        return {
          assertions: [assertThat('hc40-prep-delegated', 'Boss 已拆解派活（delegated 行）', false, '≥1', '0（未见 delegated）')],
          notes: [],
        };
      }
      const subAgentId = bodyString(row, 'toAgentId')!;
      const reported = delegationRows(ctx, t.since, 0).filter((e) => e.taskId === row.taskId)
        .some((e) => ['reported', 'closed'].includes(bodyString(e, 'phase') ?? ''));
      const st: Hc40State = { taskId: row.taskId, subAgentId, bossId: bodyString(row, 'bossId'), text: text, startedAt: t.since, prepDoneAt: Date.now() };
      writeJsonFile(stFile, st);
      return {
        assertions: [
          assertThat('hc40-prep-delegated', 'Boss 已拆解派活（delegated 行带 toAgentId/taskId）', true, '≥1', `taskId=${row.taskId}`,
            [entryEvidence(row, ['phase', 'status', 'toAgentId', 'taskId'], 100)]),
          assertThat('hc40-prep-not-done', '此刻尚未完成（reported/closed=0，保证跨重启仍在办）', !reported, '0', reported ? '已 reported' : '0'),
          assertThat('hc40-prep-state', '状态已落盘', fs.existsSync(stFile), stFile, 'ok'),
        ],
        notes: ['下一步（用户点头）：立刻重启 dev server（任务 sleep 150 秒内在办），然后 --stage=verify'],
        observed: observedSummary(delegated ?? []),
      };
    }

    if (stage === 'verify') {
      if (!fs.existsSync(stFile)) return { assertions: [], notes: [], skipReason: '无状态——先 --stage=prep' };
      const st = JSON.parse(fs.readFileSync(stFile, 'utf8')) as Hc40State;
      const agents = await rawAgents(ctx);
      const agent = agents.find((a) => a.id === st.subAgentId);
      const assertions: ProbeOutcome['assertions'] = [];
      assertions.push(assertThat('hc40-agent-alive', '重启后下属 agent 仍存在', !!agent, st.subAgentId, agent ? `status=${String(agent.status)}` : '不存在'));
      assertions.push(assertThat('hc40-not-detached', 'agent 未被丢弃（isDetached != true）', !!agent && agent.isDetached !== true,
        'isDetached!=true', String(agent?.isDetached ?? '（无）')));
      const done = await waitRows(
        ctx,
        () => delegationRows(ctx, st.startedAt, 0).filter((e) => e.taskId === st.taskId)
          .filter((e) => ['reported', 'closed'].includes(bodyString(e, 'phase') ?? '')),
        (rows) => rows.length >= 1,
        Math.max(ctx.options.reportWaitMs, 300_000),
      );
      const reportedRow = done?.[0];
      // 消息层重接（与 taskId 无关）：taskId/decisionId 仅派活进程内可达（任务 02 登记限制），
      // 跨重启行可能断链但仍到达——两层分开断言，避免「断链」被误读成「消息未重接」。
      const windowRows = delegationRows(ctx, st.startedAt, 0);
      const msgFlow = windowRows.filter((e) => ['reported', 'closed'].includes(bodyString(e, 'phase') ?? '')
        && (bodyString(e, 'fromAgentId') === st.subAgentId || bodyString(e, 'toAgentId') === st.subAgentId));
      assertions.push(assertThat('hc40-reconnected', '任务跨重启完成（reported/closed 落盘=输出重接，同 taskId）', !!reportedRow,
        '≥1', reportedRow ? `phase=${bodyString(reportedRow, 'phase')} id=${reportedRow.id}`
          : msgFlow.length > 0 ? `taskId 匹配 0；消息层到达 ${msgFlow.length} 行（taskId 断链，#${msgFlow[0]!.id}）` : '超时未见（输出未重接？）',
        reportedRow ? [entryEvidence(reportedRow, ['phase', 'status', 'taskId', 'summary'], 120)] : []));
      assertions.push(assertThat('hc40-msg-flow', '消息层重接（窗口内该下属 reported/closed 行，taskId 无关）', msgFlow.length >= 1,
        '≥1', msgFlow.length >= 1 ? `n=${msgFlow.length}（taskId 匹配 ${reportedRow ? 1 : 0}）` : '0',
        msgFlow.length > 0 ? [entryEvidence(msgFlow[msgFlow.length - 1]!, ['phase', 'status', 'fromAgentId', 'toAgentId'], 100)] : []));
      const allForTask = windowRows.filter((e) => e.taskId === st.taskId);
      const delegatedCount = allForTask.filter((e) => bodyString(e, 'phase') === 'delegated').length;
      assertions.push(assertThat('hc40-no-dup', '无重复拆解（同 taskId delegated 行 =1）', delegatedCount === 1, '1', String(delegatedCount)));
      const procRows = queryRows(ctx, { category: 'system', source: 'process', since: st.startedAt }, 0);
      const deltaMs = reportedRow ? reportedRow.ts - st.prepDoneAt : undefined;
      return {
        assertions,
        notes: [
          `时间线：prep 派活=${new Date(st.startedAt).toISOString()}；prep 结束=${new Date(st.prepDoneAt).toISOString()}；reported=${reportedRow ? new Date(reportedRow.ts).toISOString() : '—'}（prep 后 ${deltaMs !== undefined ? (deltaMs / 1000).toFixed(1) + 's' : '—'}）`,
          `process 行（重启面）：${procRows.length} 条；phases=${procRows.map((e) => String(e.body?.phase ?? '?')).slice(0, 8).join(',') || '（无）'}`,
          '口径说明：reported 在重启后的 verify 阶段观测；hc40-reconnected=机器层关联（同 taskId，taskId 仅派活进程内可达·任务 02 登记限制），hc40-msg-flow=消息层到达（与 taskId 无关）；若用户在 prep 后 >150s 才重启，任务可能先于重启完成（时间线留存备核）。',
        ],
        observed: observedSummary(allForTask),
      };
    }

    if (stage === 'cleanup') {
      const st = fs.existsSync(stFile) ? JSON.parse(fs.readFileSync(stFile, 'utf8')) as Hc40State : undefined;
      if (!st) return { assertions: [], notes: [], skipReason: '无状态可清理' };
      await stopAgent(ctx.ws, st.subAgentId);
      let status = '（未知）';
      for (let i = 0; i < 10; i++) {
        const agents = await rawAgents(ctx);
        const a = agents.find((x) => x.id === st.subAgentId);
        status = String(a?.status ?? '（不存在）');
        if (!BUSY_AGENT_STATUSES.has(status)) break;
        await sleep(2000);
      }
      fs.unlinkSync(stFile);
      return {
        assertions: [
          assertThat('hc40-stop', 'stop_agent 已发且下属不再 busy（working/waiting 等词表）', !BUSY_AGENT_STATUSES.has(status), 'idle/stopped', status),
          assertThat('hc40-state-removed', '状态文件已删除', !fs.existsSync(stFile), '不存在', '已删'),
        ],
        notes: [],
      };
    }

    return { assertions: [], notes: [], skipReason: `未知 stage=${stage}（合法：prep|verify|cleanup）` };
  },
};

export const W4_PROBES: ProbeDef[] = [hc34, hc35, hc36, hc37, hc38, hc39, hc40];
