/**
 * C3 · 多项目 D3 五场景 + 红队①（HC-25..33）——19·B 主体波
 *
 * 环境：env-prep setup 后的 A/B/C 三项目（A=现有工作区+主管补区域；B/C=新建
 * 『项目B』『项目C』+ 新下属/新主管）。**HC-28（歧义反问冷腿）执行序最前**
 * （order=1）：它要求 active=null 且窗口内无项目名提及，必须先于任何点名话术。
 *
 * 路由证据面（任务14·P1）：category='system' / source='project-routing'，body:
 *   kind ∈ need-ask | route | clarify-resolved；route 行带 projectId/finalBossId/layer/source。
 * 口称名（任务14·⑪）：workspace 名自动种子为别名；resolve.ts 子串匹配要求话术含**完整**
 *   别名——所以本波所有点名话术一律用 `proj.name` 现场拼接（A 的真实名字以 env-prep 为准）。
 *
 * 恒定 SKIP 口径：场景③跨项目转交（未交付）——HC-31 做实际路由观察并如实登记，
 *   不冒充已交付（计划口径逐字）。
 */

import type { CanaryEntry, ProbeContext, ProbeDef, ProbeOutcome } from '../types.js';
import {
  assertCancelEvidence, assertThat, bodyString, bossIdSet, dispatchedRows, entryEvidence, observedSummary,
  queryRows, reportTask, routingRows, sendTurn, SIMULATED_COMPLETION, sleep, truncate,
  waitDelegationPhase, waitDispatched, waitRouting, fetchActiveWorkspace, setActiveWorkspace,
} from '../runner.js';

// ─── 环境读取 ───

export interface CampaignProject { key: 'A' | 'B' | 'C'; name: string; workspaceId: string; bossId: string; bossName: string }

function campaignProjects(ctx: ProbeContext): Record<'A' | 'B' | 'C', CampaignProject> | undefined {
  const st = ctx.shared.envPrep as { projects?: CampaignProject[] } | undefined;
  if (!st?.projects?.length) return undefined;
  const byKey = {} as Record<'A' | 'B' | 'C', CampaignProject>;
  for (const p of st.projects) byKey[p.key] = p;
  return byKey.A && byKey.B && byKey.C ? byKey : undefined;
}

function kindOf(e: CanaryEntry): string | undefined { return bodyString(e, 'kind'); }
function projectIdOf(e: CanaryEntry): string | undefined { return bodyString(e, 'projectId') ?? e.projectId; }

function routeRowsFor(ctx: ProbeContext, since: number, anchorId: number, projectId: string): CanaryEntry[] {
  return routingRows(ctx, since, anchorId).filter((e) => kindOf(e) === 'route' && projectIdOf(e) === projectId);
}

function routeText(projectName: string): string {
  return `让「${projectName}」项目的团队做一件路由验证任务：只回复"收到-${projectName}"，不要执行任何实际操作。`;
}

const SETTLE_MS = 5000; // 计划：串行多发间隔 ≥5s 防残留污染

interface ProjectTaskRecord { workspaceId: string; bossId: string; taskId?: string; text: string }

function saveTask(ctx: ProbeContext, key: 'A' | 'B' | 'C', rec: ProjectTaskRecord): void {
  const store = (ctx.shared['w3.tasks'] as Record<string, ProjectTaskRecord> | undefined) ?? {};
  store[key] = rec;
  ctx.shared['w3.tasks'] = store;
}
function loadTask(ctx: ProbeContext, key: 'A' | 'B' | 'C'): ProjectTaskRecord | undefined {
  return (ctx.shared['w3.tasks'] as Record<string, ProjectTaskRecord> | undefined)?.[key];
}

// ─── HC-28 场景②c 歧义反问（先行冷腿） ───

const HC28_TEXT = '让团队做件小事：只回我一句收到，别的不用干。';

const hc28: ProbeDef = {
  id: 'HC-28', wave: 3, title: '场景②c 歧义反问（冷腿：active=null + 无项目提及）→ 澄清「项目B」', dim: '路由·歧义反问', effect: 'env',
  utterance: `${HC28_TEXT} → 澄清回答=项目B`,
  steps: ['置 active=null（还原于 finally）', '冷检：24h 内无项目名提及（否则如实记录）', '发不含项目名的任务 → 等 need-ask', '回答「项目B」→ 等 clarify-resolved + dispatched→Boss-B'],
  assertionDocs: ['HTTP 200', 'routing 行 kind=need-ask（或如实记录被消解）', '澄清后 kind=clarify-resolved 且 projectId=项目B', 'dispatched→Boss-B'],
  prereqIds: ['serverReachable', 'companionAvailable', 'campaignEnv', 'multiProjectReady'],
  optional: true,
  order: 1,
  run: async (ctx) => {
    const P = campaignProjects(ctx);
    if (!P) return { assertions: [], notes: [], skipReason: 'env-prep 项目记录缺失（先 --env-prep=setup）' };
    const prevActive = await fetchActiveWorkspace(ctx.transport);
    const notes: string[] = [];
    const assertions: ProbeOutcome['assertions'] = [];
    try {
      const put = await setActiveWorkspace(ctx.transport, null);
      if (!put.ok) return { assertions: [], notes: [], skipReason: `active 置 null 失败 HTTP ${put.status}` };
      await sleep(1200);

      // 冷检：24h 内 dialog 文本是否提及任一项目名（desc 取最新，防窗口行数 > limit 时扫到旧段）
      const aliases = [P.A.name, P.B.name, P.C.name].map((n) => n.trim().toLowerCase());
      const recent = ctx.query({ category: 'dialog', since: Date.now() - 24 * 3600_000, order: 'desc', limit: 400 });
      const mentions = recent.filter((e) => {
        const t = (bodyString(e, 'text') ?? '').toLowerCase();
        return aliases.some((a) => a.length > 0 && t.includes(a));
      });
      if (mentions.length > 0) notes.push(`冷检：24h 内有 ${mentions.length} 条项目名提及（最近 log#${mentions[0].id}）——按计划口径登记，尝试继续`);

      const t = await sendTurn(ctx, HC28_TEXT);
      assertions.push(assertThat('hc28-http', 'HTTP 200', t.res.ok, '200', `${t.res.status}`));
      const routing = await waitRouting(ctx, t.since, t.anchorId, 60_000) ?? routingRows(ctx, t.since, t.anchorId);
      const ask = routing.filter((e) => kindOf(e) === 'need-ask');
      const resolved = routing.filter((e) => kindOf(e) === 'clarify-resolved');
      const routed = routing.filter((e) => kindOf(e) === 'route');
      if (ask.length > 0) {
        assertions.push(assertThat('hc28-need-ask', 'need-ask 反问行出现（冷腿成立）', true, '≥1', `${ask.length}`,
          ask.slice(0, 2).map((e) => entryEvidence(e, ['kind', 'layer', 'source'], 80))));
      } else {
        assertions.push(assertThat('hc28-need-ask', 'need-ask 反问行出现（冷腿成立）', false,
          '≥1', `ask=0 route=${routed.length}（冷腿未成立：被 ${routed.length > 0 ? '上下文/激活层' : '未知层'}消解）`,
          routed.slice(0, 2).map((e) => entryEvidence(e, ['kind', 'layer', 'projectId'], 80))));
      }

      if (ask.length > 0) {
        const t2 = await sendTurn(ctx, P.B.name); // 澄清回答=「项目B」（纯别名，非任务文本）
        await sleep(1500);
        const clarified = await (async () => {
          const deadline = Date.now() + ctx.options.bossWaitMs;
          for (;;) {
            const rows = routingRows(ctx, t2.since, t2.anchorId).filter((e) => kindOf(e) === 'clarify-resolved');
            if (rows.length > 0) return rows;
            if (Date.now() >= deadline) return [];
            await sleep(ctx.options.pollMs);
          }
        })();
        const d = await waitDispatched(ctx, t2.since, t2.anchorId, ctx.options.bossWaitMs) ?? dispatchedRows(ctx, t2.since, t2.anchorId);
        const toB = d.filter((e) => (bodyString(e, 'toAgentId') ?? e.agentId) === P.B.bossId);
        assertions.push(assertThat('hc28-clarified', '澄清后 kind=clarify-resolved 且指向项目B', clarified.some((e) => projectIdOf(e) === P.B.workspaceId),
          `projectId=${P.B.workspaceId}`, clarified.map((e) => `${kindOf(e)}:${projectIdOf(e) ?? '?'}`).join(',') || '（无行）',
          clarified.slice(0, 2).map((e) => entryEvidence(e, ['kind', 'projectId', 'finalBossId'], 80))));
        assertions.push(assertThat('hc28-dispatched-b', '澄清后 dispatched → Boss-B', toB.length >= 1, '≥1', String(toB.length),
          toB.slice(0, 2).map((e) => entryEvidence(e, ['phase', 'toAgentId', 'message'], 100))));
        const rec = d.find((e) => e.taskId);
        if (rec?.taskId) saveTask(ctx, 'B', { workspaceId: P.B.workspaceId, bossId: P.B.bossId, taskId: rec.taskId, text: HC28_TEXT });
        notes.push(`澄清回答用 L2 别名=${P.B.name}；dispatched taskId=${rec?.taskId ?? '—'}`);
      }
      if (mentions.length > 0) notes.push('冷腿披露：若 need-ask 未出现，可能与 24h 内提及有关（登记项）');
      return { assertions, notes, observed: observedSummary(routing) };
    } finally {
      await setActiveWorkspace(ctx.transport, prevActive.workspaceId);
    }
  },
};

// ─── HC-25 场景①并行隔离（串行三发） ───

const hc25: ProbeDef = {
  id: 'HC-25', wave: 3, title: '场景①多项目并行隔离（串行三发 → 各中本项目 Boss）', dim: '路由·并行隔离', effect: 'delegation',
  utterance: '（逐字模板 routeText(项目名)，对 A/B/C 各一次，间隔 ≥5s）',
  steps: ['对三项目依次发送点名路由任务', '逐条核验 route.projectId 与 dispatched 目标', '登记各项目 taskId 供后续探针'],
  assertionDocs: ['3 条 route 各指本项目', '3 条 dispatched 各中本项目 Boss', '无串台（无 route 指向他人项目）'],
  prereqIds: ['serverReachable', 'companionAvailable', 'campaignEnv', 'multiProjectReady'],
  order: 5,
  run: async (ctx) => {
    const P = campaignProjects(ctx);
    if (!P) return { assertions: [], notes: [], skipReason: 'env-prep 项目记录缺失（先 --env-prep=setup）' };
    const assertions: ProbeOutcome['assertions'] = [];
    const notes: string[] = [];
    const observed: CanaryEntry[] = [];
    for (const key of ['A', 'B', 'C'] as const) {
      const proj = P[key];
      const text = routeText(proj.name);
      const t = await sendTurn(ctx, text);
      const route = await (async () => {
        const deadline = Date.now() + ctx.options.bossWaitMs;
        for (;;) {
          const rows = routeRowsFor(ctx, t.since, t.anchorId, proj.workspaceId);
          if (rows.length > 0) return rows;
          if (Date.now() >= deadline) return [];
          await sleep(ctx.options.pollMs);
        }
      })();
      const d = await waitDispatched(ctx, t.since, t.anchorId, ctx.options.bossWaitMs) ?? dispatchedRows(ctx, t.since, t.anchorId);
      const toThis = d.filter((e) => (bodyString(e, 'toAgentId') ?? e.agentId) === proj.bossId);
      const anyRoute = routingRows(ctx, t.since, t.anchorId).filter((e) => kindOf(e) === 'route');
      const strayRoute = anyRoute.filter((e) => projectIdOf(e) !== proj.workspaceId);
      const rec = d.find((e) => e.taskId);
      if (rec?.taskId) saveTask(ctx, key, { workspaceId: proj.workspaceId, bossId: proj.bossId, taskId: rec.taskId, text });
      observed.push(...route, ...d);
      assertions.push(assertThat(`hc25-${key}-http`, `${key} HTTP 200`, t.res.ok, '200', `${t.res.status}`));
      assertions.push(assertThat(`hc25-${key}-route`, `${key} route.projectId=本项目`, route.length > 0,
        proj.workspaceId, anyRoute.map((e) => projectIdOf(e) ?? '?').join(',') || '（无 route 行）',
        route.slice(0, 2).map((e) => entryEvidence(e, ['kind', 'projectId', 'finalBossId', 'layer'], 80))));
      assertions.push(assertThat(`hc25-${key}-dispatch`, `${key} dispatched → 本项目 Boss(${proj.bossName})`, toThis.length >= 1,
        proj.bossId, d.map((e) => bodyString(e, 'toAgentId') ?? e.agentId ?? '?').join(',') || '（无 dispatched）',
        toThis.slice(0, 2).map((e) => entryEvidence(e, ['phase', 'toAgentId', 'message'], 100))));
      assertions.push(assertThat(`hc25-${key}-no-stray`, `${key} 无串台 route（不指向他人项目）`, strayRoute.length === 0,
        '0', String(strayRoute.length)));
      notes.push(`${key}「${proj.name}」taskId=${rec?.taskId ?? '—'}`);
      if (key !== 'C') await sleep(SETTLE_MS);
    }
    notes.push('WS 回执前缀匹配口径由 HC-23 覆盖（本探针不重复消费完成事件）');
    return { assertions, notes, observed: observedSummary(observed) };
  },
};

// ─── HC-26 场景②a 激活工作区消歧 ───

const HC26_TEXT = '让团队把收尾验证跑一下，就回一句收到';

const hc26: ProbeDef = {
  id: 'HC-26', wave: 3, title: '场景②a 激活工作区=A：「让团队把收尾验证跑一下…」', dim: '路由·激活层', effect: 'env',
  utterance: HC26_TEXT,
  steps: ['置 active=A（finally 还原）', '发送不含项目名任务', '核验 route.projectId=A 且 dispatched→Boss-A'],
  assertionDocs: ['HTTP 200', 'route 指向 A', 'dispatched→Boss-A'],
  prereqIds: ['serverReachable', 'companionAvailable', 'campaignEnv', 'multiProjectReady'],
  order: 6,
  run: async (ctx) => {
    const P = campaignProjects(ctx);
    if (!P) return { assertions: [], notes: [], skipReason: 'env-prep 项目记录缺失（先 --env-prep=setup）' };
    const prevActive = await fetchActiveWorkspace(ctx.transport);
    try {
      const put = await setActiveWorkspace(ctx.transport, P.A.workspaceId);
      if (!put.ok) return { assertions: [], notes: [], skipReason: `active=A 失败 HTTP ${put.status}` };
      await sleep(1200);
      const t = await sendTurn(ctx, HC26_TEXT);
      const route = await waitRouting(ctx, t.since, t.anchorId, ctx.options.bossWaitMs) ?? routingRows(ctx, t.since, t.anchorId);
      const mine = route.filter((e) => kindOf(e) === 'route' && projectIdOf(e) === P.A.workspaceId);
      const d = await waitDispatched(ctx, t.since, t.anchorId, ctx.options.bossWaitMs) ?? dispatchedRows(ctx, t.since, t.anchorId);
      const toA = d.filter((e) => (bodyString(e, 'toAgentId') ?? e.agentId) === P.A.bossId);
      const rec = d.find((e) => e.taskId);
      if (rec?.taskId) saveTask(ctx, 'A', { workspaceId: P.A.workspaceId, bossId: P.A.bossId, taskId: rec.taskId, text: HC26_TEXT });
      return {
        assertions: [
          assertThat('hc26-http', 'HTTP 200', t.res.ok, '200', `${t.res.status}`),
          assertThat('hc26-route-a', 'route 指向 A（激活层消歧）', mine.length > 0, P.A.workspaceId,
            route.map((e) => `${kindOf(e)}:${projectIdOf(e) ?? '?'}`).join(',') || '（无 routing 行）',
            mine.slice(0, 2).map((e) => entryEvidence(e, ['kind', 'projectId', 'layer', 'source'], 80))),
          assertThat('hc26-dispatch-a', `dispatched → Boss-A(${P.A.bossName})`, toA.length >= 1, P.A.bossId,
            String(toA.length), toA.slice(0, 2).map((e) => entryEvidence(e, ['phase', 'toAgentId'], 80))),
        ],
        notes: [`A 的真实工作区名=${P.A.name}；taskId=${rec?.taskId ?? '—'}`],
        observed: observedSummary(route),
      };
    } finally {
      await setActiveWorkspace(ctx.transport, prevActive.workspaceId);
    }
  },
};

// ─── HC-27 场景②b 显式点名优先（active=A 时点名 B） ───

const hc27: ProbeDef = {
  id: 'HC-27', wave: 3, title: '场景②b 显式点名 B（active=A 时点名应压过激活层）', dim: '路由·显式优先', effect: 'delegation',
  utterance: '（routeText(项目B)）',
  steps: ['置 active=A', '发送点名项目B的任务', '核验 route=B（显式优先），finally 还原 active'],
  assertionDocs: ['HTTP 200', 'route 指向 B', 'dispatched→Boss-B'],
  prereqIds: ['serverReachable', 'companionAvailable', 'campaignEnv', 'multiProjectReady'],
  order: 7,
  run: async (ctx) => {
    const P = campaignProjects(ctx);
    if (!P) return { assertions: [], notes: [], skipReason: 'env-prep 项目记录缺失' };
    const prevActive = await fetchActiveWorkspace(ctx.transport);
    try {
      const put = await setActiveWorkspace(ctx.transport, P.A.workspaceId);
      if (!put.ok) return { assertions: [], notes: [], skipReason: `active=A 失败 HTTP ${put.status}` };
      await sleep(1200);
      const text = routeText(P.B.name);
      const t = await sendTurn(ctx, text);
      const route = await waitRouting(ctx, t.since, t.anchorId, ctx.options.bossWaitMs) ?? routingRows(ctx, t.since, t.anchorId);
      const toB = route.filter((e) => kindOf(e) === 'route' && projectIdOf(e) === P.B.workspaceId);
      const d = await waitDispatched(ctx, t.since, t.anchorId, ctx.options.bossWaitMs) ?? dispatchedRows(ctx, t.since, t.anchorId);
      const dispatchedB = d.filter((e) => (bodyString(e, 'toAgentId') ?? e.agentId) === P.B.bossId);
      const rec = d.find((e) => e.taskId);
      if (rec?.taskId) saveTask(ctx, 'B', { workspaceId: P.B.workspaceId, bossId: P.B.bossId, taskId: rec.taskId, text });
      return {
        assertions: [
          assertThat('hc27-http', 'HTTP 200', t.res.ok, '200', `${t.res.status}`),
          assertThat('hc27-route-b', 'route 指向 B（显式点名压过 active=A）', toB.length > 0, P.B.workspaceId,
            route.map((e) => `${kindOf(e)}:${projectIdOf(e) ?? '?'}`).join(',') || '（无 routing 行）',
            toB.slice(0, 2).map((e) => entryEvidence(e, ['kind', 'projectId', 'layer', 'source'], 80))),
          assertThat('hc27-dispatch-b', 'dispatched → Boss-B', dispatchedB.length >= 1, P.B.bossId, String(dispatchedB.length)),
        ],
        notes: [`taskId=${rec?.taskId ?? '—'}`],
        observed: observedSummary(route),
      };
    } finally {
      await setActiveWorkspace(ctx.transport, prevActive.workspaceId);
    }
  },
};

// ─── HC-29 场景④ 项目内撤回（B/C 不受影响） ───

const hc29: ProbeDef = {
  id: 'HC-29', wave: 3, title: '场景④「项目A那个别做了」→ 恰 1 条 cancelled 属 A，B/C 不受影响', dim: '路由·项目内撤回', effect: 'delegation',
  utterance: '（现场拼 A 名）别做了，取消刚才那个',
  steps: ['总是布置 A 保活任务（sleep 120）并等 delegated 确认真在办（原「不足才补发」在短任务已闭环时会拿死任务当撤回目标——C3 首跑根因）', 'delegated 等待只用「窗口内任意 boss-channel delegated 行」——delegated 行 task_id 是下属侧新铸 id，与路由侧 id 不同（C3 复跑教训：按路由 id 过滤永假）', '发送含 A 名的撤回话术', '核验恰 1 条实撤（cancelled-*）且目标=A 本次承接人；B/C 任务未被误cancel；clarify-ask 仅澄清无实撤 → SKIP 登记'],
  assertionDocs: ['HTTP 200', '实撤 cancelled-* 行出现', '恰 1 条实撤（不误伤）', '实撤目标 = delegated 承接人（属 A）', '结论/通知核验（cancelled-* 且 notified=true）', 'B/C taskId 未被 cancel'],
  prereqIds: ['serverReachable', 'companionAvailable', 'campaignEnv', 'multiProjectReady'],
  optional: true,
  order: 8,
  run: async (ctx) => {
    const P = campaignProjects(ctx);
    if (!P) return { assertions: [], notes: [], skipReason: 'env-prep 项目记录缺失' };
    const notes: string[] = [];
    // C3 首跑修正（2026-10-05）：原「A 无任务记录才补发 routeText」在 HC-25 的短任务早已闭环时，
    // 会把已完成任务当撤回目标（撤回到达时 A 实无在办 → clarify-ask 假红）。现改为总是布置
    // 保活任务（sleep 120）并等 delegated 确认真在办后才撤回，消除对前序波次时序的假设。
    const armText = `让「${P.A.name}」项目的团队做一件在办保活任务：执行下属运行命令「sleep 120」，等待结束后只回复"收到"，不要做其他任何操作。`;
    const t0 = await sendTurn(ctx, armText);
    if (!t0.res.ok) return { assertions: [], notes, skipReason: `保活任务回合 HTTP ${t0.res.status}` };
    const d0 = await waitDispatched(ctx, t0.since, t0.anchorId, ctx.options.bossWaitMs) ?? dispatchedRows(ctx, t0.since, t0.anchorId);
    const rec = d0.find((e) => e.taskId);
    const recA: ProjectTaskRecord | undefined = rec?.taskId
      ? { workspaceId: P.A.workspaceId, bossId: P.A.bossId, taskId: rec.taskId, text: armText }
      : undefined;
    if (recA) saveTask(ctx, 'A', recA);
    const aTaskId = recA?.taskId;
    notes.push(`A 保活任务 taskId=${aTaskId ?? '—'}`);
    // delegated 等待：只看「窗口内任意 delegated 行（channel=boss）」，绝不按任务 id 过滤。
    // C3 复跑教训（2026-10-05，两跑各空耗 bossWaitMs 60–180s）：delegated 行的 task_id 列是
    // **下属侧新铸 id**（实证 #1703 task-muv0y1q0），与 dispatched/routing 行的路由侧 id
    // （#1699 task-muv0xxxg）不同——按 aTaskId 过滤 delegated 永假。金丝雀撤回链同口径
    // （scenarios.ts:909-914「任意 delegated」）。环境受控（善后已核空）下窗口内首条即本任务。
    const dlAll = d0.length > 0
      ? await waitDelegationPhase(ctx, 'delegated', t0.since, t0.anchorId, ctx.options.bossWaitMs) ?? []
      : [];
    const dl = dlAll.filter((e) => bodyString(e, 'channel') === 'boss');
    const dlTarget = dl.find((e) => bodyString(e, 'toAgentId'));
    const dlToId = dlTarget ? bodyString(dlTarget, 'toAgentId') : undefined;
    notes.push(dl.length > 0
      ? `delegated 已确认（#${dl[0]!.id} → ${bodyString(dl[0]!, 'toAgentName') ?? dlToId ?? '?'}，真在办）`
      : 'delegated 未在超时内出现——撤回将落在预派窗口（HC-B4 竞态样本，如实记录）');
    if (!aTaskId) notes.push('保活任务未取得路由侧 taskId（delegated 等待不受影响，仍按窗口口径）');
    await sleep(3000);
    const cancelText = `让「${P.A.name}」项目的团队停一下：别做了，取消刚才那个`;
    const t = await sendTurn(ctx, cancelText);
    const allCancelled = await waitDelegationPhase(ctx, 'cancelled', t.since, t.anchorId, ctx.options.bossWaitMs)
      ?? queryRows(ctx, { category: 'delegation', since: t.since }, t.anchorId).filter((e) => bodyString(e, 'phase') === 'cancelled');
    // clarify-ask 行本身即 phase=cancelled/status=clarify-ask（C3 首跑：曾被计成"实撤行"，
    // 使 cancelRows.length===0 的 SKIP 守卫永不触发）。实撤 = status 以 cancelled- 开头
    // （cancelled-running/queued/tracking）；not-found/rejected-done/already-cancelled 是
    // 「未撤销任何任务」的结论行，不计实撤（口径 scenarios.ts:841-849 a4）。
    const statusOf = (e: CanaryEntry): string => bodyString(e, 'status') ?? '';
    const realCancels = allCancelled.filter((e) => statusOf(e).startsWith('cancelled-'));
    const noopRows = allCancelled.filter((e) => !statusOf(e).startsWith('cancelled-') && statusOf(e) !== 'clarify-ask');
    const clarifyAsk = allCancelled.some((e) => statusOf(e) === 'clarify-ask');
    if (realCancels.length === 0 && clarifyAsk) {
      return {
        assertions: [],
        notes: [...notes, '撤回触发多候选反问（clarify-ask，多个在办任务待消歧）——非失败，按如实口径 SKIP 登记（环境非空闲）。'],
        skipReason: 'clarify-ask 多候选反问（环境存在多个在办任务）',
        observed: observedSummary(allCancelled),
      };
    }
    if (noopRows.length > 0) {
      notes.push(`撤回未命中结论行：${noopRows.map((e) => `${statusOf(e)}(#${e.id})`).join('、')}——目标不在办或已完成（非实撤，见 observed）`);
    }
    const bcTasks = ['B', 'C'].map((k) => loadTask(ctx, k as 'B' | 'C')).filter((r): r is NonNullable<typeof r> => !!r?.taskId);
    const bcCancelled = bcTasks.filter((r) => realCancels.some((e) => e.taskId === r.taskId));
    const single = realCancels.length === 1 ? realCancels[0] : undefined;
    const singleTo = single ? bodyString(single, 'toAgentId') : undefined;
    const verdict = assertCancelEvidence(realCancels);
    // 实撤归属判定：单条实撤行的 toAgentId == delegated 承接人（撤回审计行带 toAgentId/toAgentName，
    // scenarios.ts:846）。取不到 delegated 承接人时降级为「toAgentId 非空」（仅属 A 项目内某下属）。
    const aCancelled = !!single && (dlToId ? singleTo === dlToId : !!singleTo);
    return {
      assertions: [
        assertThat('hc29-http', 'HTTP 200（撤回回合）', t.res.ok, '200', `${t.res.status}`),
        assertThat('hc29-cancelled', '实撤 cancelled-* 行出现', realCancels.length >= 1, '≥1', String(realCancels.length),
          realCancels.slice(0, 3).map((e) => entryEvidence(e, ['phase', 'status', 'toAgentId', 'toAgentName', 'notified'], 100))),
        assertThat('hc29-single', '恰 1 条实撤（不误伤；金丝雀 a6 口径）', realCancels.length === 1, '1', String(realCancels.length)),
        assertThat('hc29-a-cancelled', '实撤目标 = A 保活承接人（delegated toAgentId）', aCancelled,
          `toAgentId=${dlToId ?? '（delegated 未取到；按 toAgentId 非空判定）'}`,
          realCancels.map((e) => `${bodyString(e, 'toAgentName') ?? '?'}(${bodyString(e, 'toAgentId') ?? '-'})`).join(',') || '（无实撤行）'),
        assertThat('hc29-verdict', '结论/通知核验（assertCancelEvidence）', verdict.ok,
          'status=cancelled-* 且 notified=true（queued 除外）', verdict.actual, verdict.evidence),
        assertThat('hc29-bc-safe', 'B/C 在办任务未被误取消（taskId 核）', bcCancelled.length === 0, '0', String(bcCancelled.length),
          bcCancelled.map((r) => r.taskId ?? '?').join(',')),
      ],
      notes: [
        ...notes,
        `撤回话术（现场拼名）：${cancelText}`,
        `A 路由侧 taskId=${aTaskId ?? '—'}；delegated 承接=${dlToId ?? '—'}；B/C=${bcTasks.map((r) => r.taskId ?? '—').join('/') || '（本跑无在办）'}`,
      ],
      observed: observedSummary(allCancelled.length > 0 ? allCancelled : dl),
    };
  },
};

// ─── HC-30 场景⑤ 配额排队 + 出队（FIFO） ───

export function quotaText(index: number, projectName: string): string {
  return `让「${projectName}」项目的团队做并发配额验证任务（第 ${index} 条）：执行下属运行命令「sleep 240」，等待结束后只回复"收到"，不要做其他任何操作。`;
}

const hc30: ProbeDef = {
  id: 'HC-30', wave: 3, title: '场景⑤配额：5 条并发 → quota-queued → 完成 1 出队（FIFO）', dim: '配额·排队与出队', effect: 'delegation',
  utterance: '（逐字模板 quotaText(i, A名)，5 条串行）',
  steps: ['对 A 串行发 5 条 sleep 240 任务', '等待 quota-queued（queuedCount≥1）', '对一条在办发半合成完成 → 等 quota-dequeued 且 FIFO'],
  assertionDocs: ['quota-queued 行出现', '完成 1 条后 quota-dequeued 行出现', 'dequeued taskId = 最早 queued taskId（FIFO）'],
  prereqIds: ['serverReachable', 'companionAvailable', 'campaignEnv', 'multiProjectReady'],
  optional: true,
  order: 9,
  run: async (ctx) => {
    const P = campaignProjects(ctx);
    if (!P) return { assertions: [], notes: [], skipReason: 'env-prep 项目记录缺失' };
    const notes: string[] = [];
    // 1) 串行发 5 条
    for (let i = 1; i <= 5; i++) {
      const text = quotaText(i, P.A.name);
      await sendTurn(ctx, text, { waitOut: false });
      ctx.log(`第 ${i} 条配额任务已发（不等回复，防互相干扰）`);
      await sleep(2500);
    }
    // 2) 等 quota-queued
    const queued = await (async () => {
      const deadline = Date.now() + Math.max(ctx.options.bossWaitMs, 120_000);
      for (;;) {
        const rows = queryRows(ctx, { category: 'delegation', since: Date.now() - 10 * 60_000 }, 0)
          .filter((e) => bodyString(e, 'phase') === 'quota-queued');
        if (rows.length > 0) return rows;
        if (Date.now() >= deadline) return [];
        await sleep(ctx.options.pollMs);
      }
    })();
    if (queued.length === 0) {
      return {
        assertions: [],
        notes: [
          '5 条全部直接派发、无 quota-queued 行——可能预算≥5（TC_JARVIS_QUOTA_BUDGET 缺省 3，来源如实标注），或任务未被判为并发配额对象。',
          '口径：SKIP 登记（计划：「若 5 条全派无排队则 SKIP 登记」）。',
        ],
        skipReason: '未观测到排队（预算≥5 或判定口径不同）',
        observed: [],
      };
    }
    const firstQueuedTaskId = queued[0].taskId;
    // 3) 找一条"已准入"在办任务完成（canary ⑨ 同口径：boss 拆解行 status ∉ {queued,dequeued}）
    const inFlight = queryRows(ctx, { category: 'delegation', since: Date.now() - 15 * 60_000 }, 0)
      .filter((e) => bodyString(e, 'phase') === 'delegated' && bodyString(e, 'channel') === 'boss')
      .filter((e) => !['queued', 'dequeued'].includes(bodyString(e, 'status') ?? ''));
    const target = [...inFlight].reverse().find((e) => e.taskId && e.taskId !== firstQueuedTaskId);
    const subId = target ? bodyString(target, 'toAgentId') ?? target.agentId : undefined;
    let reportOk = false;
    if (subId) {
      const res = await reportTask(ctx.transport, subId, '真人战役半合成回执（工具验证用，非真实验收）', 'completed', SIMULATED_COMPLETION);
      reportOk = res.ok;
    }
    const dequeued = await (async () => {
      const deadline = Date.now() + ctx.options.reportWaitMs;
      for (;;) {
        const rows = queryRows(ctx, { category: 'delegation', since: Date.now() - 10 * 60_000 }, 0)
          .filter((e) => bodyString(e, 'phase') === 'quota-dequeued');
        if (rows.length > 0) return rows;
        if (Date.now() >= deadline) return [];
        await sleep(ctx.options.pollMs);
      }
    })();
    const fifo = firstQueuedTaskId !== undefined && dequeued.some((e) => e.taskId === firstQueuedTaskId);
    return {
      assertions: [
        assertThat('hc30-queued', 'quota-queued 行出现（queuedCount≥1）', queued.length >= 1, '≥1', String(queued.length),
          queued.slice(0, 3).map((e) => entryEvidence(e, ['phase', 'queuedCount', 'taskId'], 80))),
        assertThat('hc30-report', '完成 1 条（半合成 report-task）成功', reportOk || subId === undefined,
          subId ? '200' : '（无可完成目标）', reportOk ? '200' : subId ? '失败' : '跳过'),
        assertThat('hc30-dequeued', 'quota-dequeued 行出现（槽位释放）', dequeued.length >= 1, '≥1', String(dequeued.length),
          dequeued.slice(0, 3).map((e) => entryEvidence(e, ['phase', 'taskId', 'queuedCount'], 80))),
        assertThat('hc30-fifo', 'FIFO：dequeued 命中最早 queued taskId', fifo || firstQueuedTaskId === undefined,
          `first=${firstQueuedTaskId ?? '?'}`, dequeued.map((e) => e.taskId ?? '(无)').join(',') || '（无出队）'),
      ],
      notes: [
        `queued=${queued.length} 条（含 queuedCount=${queued.map((e) => e.body?.queuedCount ?? '?').join(',')}）；dequeued=${dequeued.length} 条`,
        '预算来源：TC_JARVIS_QUOTA_BUDGET（缺省 3；本机未改则按缺省判定；改值需重启——本波未改）',
      ],
      observed: observedSummary([...queued, ...dequeued]),
    };
  },
};

// ─── HC-31 场景③跨项目转交（未交付：观察 + 恒 SKIP 登记） ───

const hc31: ProbeDef = {
  id: 'HC-31', wave: 3, title: '场景③跨项目转交（未交付 → 实际路由观察 + SKIP 登记）', dim: '路由·跨项目转交', effect: 'delegation',
  utterance: '（现场拼名）A 的活让 B 帮一下，做完报给 A',
  steps: ['发送跨项目转交话术', '观察实际路由/派发行为并登记', '按计划口径：未交付恒 SKIP（不冒充）'],
  assertionDocs: ['HTTP 200', '（观察）routing/dispatched 行为被如实登记', 'SKIP 口径登记'],
  prereqIds: ['serverReachable', 'companionAvailable', 'campaignEnv', 'multiProjectReady'],
  optional: true,
  order: 10,
  run: async (ctx) => {
    const P = campaignProjects(ctx);
    if (!P) return { assertions: [], notes: [], skipReason: 'env-prep 项目记录缺失' };
    const text = `让「${P.A.name}」项目的活让「${P.B.name}」的团队帮一下，做完报给「${P.A.name}」`;
    const t = await sendTurn(ctx, text);
    await sleep(SETTLE_MS);
    const route = routingRows(ctx, t.since, t.anchorId);
    const d = dispatchedRows(ctx, t.since, t.anchorId);
    const destinations = d.map((e) => bodyString(e, 'toAgentId') ?? e.agentId ?? '?');
    const toA = d.some((e) => (bodyString(e, 'toAgentId') ?? e.agentId) === P.A.bossId);
    const toB = d.some((e) => (bodyString(e, 'toAgentId') ?? e.agentId) === P.B.bossId);
    return {
      assertions: [
        assertThat('hc31-http', 'HTTP 200', t.res.ok, '200', `${t.res.status}`),
        assertThat('hc31-observed', '实际路由行为已观测登记（routing/dispatched 任一）', route.length > 0 || d.length > 0,
          '≥1 行', `route=${route.length} dispatched=${d.length}；去向=${destinations.join(',') || '（无派发）'}`,
          [...route, ...d].slice(0, 3).map((e) => entryEvidence(e, ['kind', 'projectId', 'toAgentId', 'message'], 100))),
      ],
      notes: [
        'SKIP 口径登记（任务14·P2 场景③未交付）：本条不判定通过/失败，仅登记实际行为；',
        `本回合实际去向：A=${toA} B=${toB}；回复样本：${truncate(bodyString(t.out, 'text'), 120) || '（无）'}`,
      ],
      observed: observedSummary([...route, ...d]),
    };
  },
};

// ─── HC-32 红队①：A 在办 → 切 active=B → B 任务正确 + 查询不派活 + A 不变 ───

const hc32: ProbeDef = {
  id: 'HC-32', wave: 3, title: '红队①·A 在办中切 active=B：新任务走 B、查询不派活、A 任务不变', dim: '红队·并发插话', effect: 'delegation',
  utterance: '让团队回我一句收到 / 现在几点',
  steps: ['确认 A 有在办任务', '置 active=B', '发 B 任务 → 核验走 B', '发查询「现在几点」→ 核验不派活', '核验 A taskId 未被取消（finally 还原 active）'],
  assertionDocs: ['B 任务 route=B + dispatched→Boss-B', '查询回合 dispatched=0', 'A taskId 未被 cancelled'],
  prereqIds: ['serverReachable', 'companionAvailable', 'campaignEnv', 'multiProjectReady'],
  optional: true,
  order: 11,
  run: async (ctx) => {
    const P = campaignProjects(ctx);
    if (!P) return { assertions: [], notes: [], skipReason: 'env-prep 项目记录缺失' };
    const recA = loadTask(ctx, 'A');
    const prevActive = await fetchActiveWorkspace(ctx.transport);
    try {
      const put = await setActiveWorkspace(ctx.transport, P.B.workspaceId);
      if (!put.ok) return { assertions: [], notes: [], skipReason: `active=B 失败 HTTP ${put.status}` };
      await sleep(1200);
      const t1 = await sendTurn(ctx, '让团队回我一句收到');
      const route1 = await waitRouting(ctx, t1.since, t1.anchorId, ctx.options.bossWaitMs) ?? routingRows(ctx, t1.since, t1.anchorId);
      const d1 = await waitDispatched(ctx, t1.since, t1.anchorId, ctx.options.bossWaitMs) ?? dispatchedRows(ctx, t1.since, t1.anchorId);
      const toB = d1.filter((e) => (bodyString(e, 'toAgentId') ?? e.agentId) === P.B.bossId);
      const routeB = route1.filter((e) => kindOf(e) === 'route' && projectIdOf(e) === P.B.workspaceId);
      await sleep(3000);
      const t2 = await sendTurn(ctx, '现在几点');
      await sleep(SETTLE_MS);
      const d2 = dispatchedRows(ctx, t2.since, t2.anchorId);
      // A 任务不变：扫描 B 切换后窗口内是否有 cancelled 命中 A
      const cancelledA = queryRows(ctx, { category: 'delegation', since: t1.since }, 0)
        .filter((e) => bodyString(e, 'phase') === 'cancelled' && recA?.taskId !== undefined && e.taskId === recA.taskId);
      return {
        assertions: [
          assertThat('hc32-route-b', 'B 任务 route=B（active=B 生效）', routeB.length > 0, P.B.workspaceId,
            route1.map((e) => `${kindOf(e)}:${projectIdOf(e) ?? '?'}`).join(',') || '（无）',
            routeB.slice(0, 2).map((e) => entryEvidence(e, ['kind', 'projectId', 'layer'], 80))),
          assertThat('hc32-dispatch-b', 'dispatched → Boss-B', toB.length >= 1, P.B.bossId, String(toB.length)),
          assertThat('hc32-query-nodispatch', '查询「现在几点」不派活', d2.length === 0, '0', String(d2.length)),
          assertThat('hc32-a-intact', 'A 在办任务未被取消', cancelledA.length === 0, '0', String(cancelledA.length),
            recA?.taskId ? [] : []),
        ],
        notes: [`A taskId=${recA?.taskId ?? '（未登记）'}`],
        observed: observedSummary([...route1, ...d1, ...d2]),
      };
    } finally {
      await setActiveWorkspace(ctx.transport, prevActive.workspaceId);
    }
  },
};

// ─── HC-33 多项目模糊指代 ───

const hc33: ProbeDef = {
  id: 'HC-33', wave: 3, title: '多项目模糊指代「那边那个弄得咋样了？」', dim: '路由·模糊指代', effect: 'none',
  utterance: '那边那个弄得咋样了？',
  steps: ['发送模糊指代', '等回复', '确认无派活；回复样本登记（不串台人工抽验）'],
  assertionDocs: ['HTTP 200', '有 dialog out 回复', 'dispatched=0 或只到 Boss'],
  prereqIds: ['serverReachable', 'companionAvailable', 'campaignEnv'],
  order: 12,
  run: async (ctx) => {
    const t = await sendTurn(ctx, '那边那个弄得咋样了？');
    await sleep(SETTLE_MS);
    const d = dispatchedRows(ctx, t.since, t.anchorId);
    const bosses = await bossIdSet(ctx);
    const bad = d.filter((e) => { const to = e.agentId ?? bodyString(e, 'toAgentId'); return to === undefined || !bosses.has(to); });
    return {
      assertions: [
        assertThat('hc33-http', 'HTTP 200', t.res.ok, '200', `${t.res.status}`),
        assertThat('hc33-reply', '有 dialog out 回复', !!t.out, 'out 行存在', t.out ? `id=${t.out.id}` : '无'),
        assertThat('hc33-boss-only', 'dispatched=0 或只到 Boss（不串台）', bad.length === 0, '0', String(bad.length)),
      ],
      notes: [`回复样本：${truncate(bodyString(t.out, 'text'), 160) || '（无）'}`],
      observed: observedSummary(routingRows(ctx, t.since, t.anchorId)),
    };
  },
};

export const W3_PROBES: ProbeDef[] = [hc28, hc25, hc26, hc27, hc29, hc30, hc31, hc32, hc33];
