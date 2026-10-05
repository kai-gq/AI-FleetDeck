/**
 * C1 · 对话与判断层（HC-01..14）——真人语言形态逐一真跑，零环境写入
 *
 * 目的：验证「秘书双跳」在真实人话（模糊/指代/错字/情绪/否定/跨话题/空指令/
 * 乱码/超长/记忆/闲聊）下的判断质量与"不凭空派活"硬边界。
 * 唯一例外：HC-04 按计划产生 1 次无害派活（零工具「只回复收到」），善后走 --cleanup。
 *
 * 脚本外真相修正（写进 HC-13 备注，避免误报）：
 *   服务端**每个正常回应**都会同时落 dialog(out) + broadcast(server-sent) 同一 taskId
 *   （voice-companion-service.ts:2258-2280 finish()）。故"窗口内 broadcast=0"不可作断言；
 *   正确口径 = 除本回合 taskId 外无他人播报（不是 proactive 就说明闲聊没有触发主动播报）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ProbeContext, ProbeDef, ProbeOutcome } from '../types.js';
import {
  assertThat, blockedRows, bodyString, bossIdSet, dialogRows, dispatchedRows,
  entryById, entryEvidence, fetchAgents, observedSummary, repoRoot, sendTurn, sleep, truncate,
  broadcastRows, waitDispatched,
} from '../runner.js';

const ZERO_DISPATCH_SETTLE_MS = 4000;

interface ZeroDispatchCheck { ok: boolean; count: number; evidence: ReturnType<typeof entryEvidence>[] }

async function assertNoDispatch(ctx: ProbeContext, since: number, anchorId: number): Promise<ZeroDispatchCheck> {
  await sleep(ZERO_DISPATCH_SETTLE_MS); // 给潜在派活留出发起时间，避免"断言早于行为"
  const rows = dispatchedRows(ctx, since, anchorId);
  return {
    ok: rows.length === 0,
    count: rows.length,
    evidence: rows.slice(0, 3).map((e) => entryEvidence(e, ['phase', 'toAgentId', 'channel', 'message'], 80)),
  };
}

/** 公共：一个"应只答不做"的回合（答复存在 + 无派活） */
async function replyOnlyProbe(
  ctx: ProbeContext,
  ids: { http: string; reply: string; nodispatch: string },
  text: string,
  opts?: { sampleForReview?: boolean },
): Promise<ProbeOutcome> {
  const t = await sendTurn(ctx, text);
  const a1 = assertThat(ids.http, 'HTTP 200', t.res.ok, '200', `${t.res.status}${t.res.error ? ` ${t.res.error}` : ''}`);
  const a2 = assertThat(ids.reply, '有 dialog out 回复', !!t.out, 'out 行存在',
    t.out ? `id=${t.out.id} action=${bodyString(t.out, 'action') ?? '—'}` : '无',
    t.out ? [entryEvidence(t.out, ['action', 'text'])] : []);
  const z = await assertNoDispatch(ctx, t.since, t.anchorId);
  const a3 = assertThat(ids.nodispatch, '窗口内无派活', z.ok, 'dispatched=0', `dispatched=${z.count}`, z.evidence);
  const notes: string[] = [];
  if (t.anchorNote) notes.push(t.anchorNote);
  if (opts?.sampleForReview) notes.push(`人工抽验样本（回复原文截断）：${truncate(bodyString(t.out, 'text'), 160) || '（无）'}`);
  if (t.out && (bodyString(t.out, 'action') === 'delegate_to_boss' || bodyString(t.out, 'action') === 'send_to_agent')) {
    notes.push(`⚠ 回复 action=${bodyString(t.out, 'action')}（任务类）——本条期望纯对话，请人工复核语义`);
  }
  return { assertions: [a1, a2, a3], notes, observed: observedSummary(dialogRows(ctx, t.since, t.anchorId)) };
}

// ─── HC-01 ───

const hc01: ProbeDef = {
  id: 'HC-01', wave: 1, title: '模糊指代「那个弄好了没？」', dim: '真人语言·模糊指代', effect: 'none',
  utterance: '那个弄好了没？',
  steps: ['发送模糊指代问题', '等回复', '确认窗口内无派活'],
  assertionDocs: ['HTTP 200', '有 dialog out 回复', '窗口内 dispatched=0（不凭空派活）'],
  prereqIds: ['serverReachable', 'companionAvailable'],
  run: (ctx) => replyOnlyProbe(ctx, { http: 'hc01-http', reply: 'hc01-reply', nodispatch: 'hc01-nodispatch' }, '那个弄好了没？', { sampleForReview: true }),
};

// ─── HC-02 ───

const hc02: ProbeDef = {
  id: 'HC-02', wave: 1, title: '续问「就是昨天说的那个，现在咋样了？」', dim: '真人语言·上下文指认', effect: 'none',
  utterance: '就是昨天说的那个，现在咋样了？',
  steps: ['发送含"昨天那个"的续问', '等回复', '确认无派活；回复文本留人工抽验'],
  assertionDocs: ['HTTP 200', '有 dialog out 回复', '窗口内 dispatched=0'],
  prereqIds: ['serverReachable', 'companionAvailable'],
  run: (ctx) => replyOnlyProbe(ctx, { http: 'hc02-http', reply: 'hc02-reply', nodispatch: 'hc02-nodispatch' }, '就是昨天说的那个，现在咋样了？', { sampleForReview: true }),
};

// ─── HC-03 ───

const hc03: ProbeDef = {
  id: 'HC-03', wave: 1, title: '错字·查询「帮我看下丈家年这会儿在干嘛」', dim: '真人语言·错字容错', effect: 'none',
  utterance: '帮我看下丈家年这会儿在干嘛',
  steps: ['发送含错字人名的查询', '等回复', '确认无派活且 agent 名单不变'],
  assertionDocs: ['HTTP 200', '有 dialog out 回复', '窗口内 dispatched=0', 'agent 计数不变'],
  prereqIds: ['serverReachable', 'companionAvailable'],
  run: async (ctx) => {
    const before = await fetchAgents(ctx.transport);
    const outcome = await replyOnlyProbe(ctx, { http: 'hc03-http', reply: 'hc03-reply', nodispatch: 'hc03-nodispatch' }, '帮我看下丈家年这会儿在干嘛', { sampleForReview: true });
    const after = await fetchAgents(ctx.transport);
    outcome.assertions.push(assertThat('hc03-agents', 'agent 总数不变（无新建/删除）',
      before.ok && after.ok && before.agents.length === after.agents.length,
      `前后一致（${before.agents.length}）`, `${before.agents.length} → ${after.agents.length}`));
    return outcome;
  },
};

// ─── HC-04（本波唯一派活探针） ───

const hc04Text = '让团对把刚才那个小认务收个尾，只回复收到，别的啥也别干';

const hc04: ProbeDef = {
  id: 'HC-04', wave: 1, title: '错字·派活「让团对…小认务…只回复收到」', dim: '真人语言·错字指令', effect: 'delegation',
  utterance: hc04Text,
  steps: ['发送含错字的派活指令', '等待 dispatched', '确认恰 1 条且只到主管'],
  assertionDocs: ['HTTP 200', 'dispatched 恰 1 条', '全部 dispatched 只到 Boss', '无 blocked 违规告警'],
  prereqIds: ['serverReachable', 'companionAvailable', 'bossExists'],
  run: async (ctx) => {
    const t = await sendTurn(ctx, hc04Text);
    const a1 = assertThat('hc04-http', 'HTTP 200', t.res.ok, '200', `${t.res.status}`);
    const rows = await waitDispatched(ctx, t.since, t.anchorId, ctx.options.bossWaitMs);
    const dispatched = rows ?? dispatchedRows(ctx, t.since, t.anchorId);
    const bosses = await bossIdSet(ctx);
    const a2 = assertThat('hc04-dispatch-1', 'dispatched 恰 1 条', dispatched.length === 1, '1', String(dispatched.length),
      dispatched.slice(0, 3).map((e) => entryEvidence(e, ['phase', 'toAgentId', 'toAgentName', 'channel', 'message'], 80)));
    const bad = dispatched.filter((e) => { const to = e.agentId ?? bodyString(e, 'toAgentId'); return to === undefined || !bosses.has(to); });
    const a3 = assertThat('hc04-boss-only', 'dispatched 全部只到 Boss', bad.length === 0, '非 Boss 目标=0', `非 Boss=${bad.length}`,
      bad.slice(0, 3).map((e) => entryEvidence(e, ['phase', 'toAgentId', 'channel'])));
    const blocked = blockedRows(ctx, t.since, t.anchorId);
    const a4 = assertThat('hc04-no-blocked', '无 blocked 违规告警', blocked.length === 0, '0', String(blocked.length));
    return {
      assertions: [a1, a2, a3, a4],
      notes: [
        '本探针产生 1 次无害派活（零工具「只回复收到」）；收口用 --cleanup 停 agent',
        ...(t.anchorNote ? [t.anchorNote] : []),
      ],
      observed: observedSummary(dispatched),
    };
  },
};

// ─── HC-05 ───

const hc05: ProbeDef = {
  id: 'HC-05', wave: 1, title: '情绪「怎么这么久还没好啊？！我都等半天了」', dim: '真人语言·情绪', effect: 'none',
  utterance: '怎么这么久还没好啊？！我都等半天了',
  steps: ['发送抱怨/催促', '等回复', '确认无派活'],
  assertionDocs: ['HTTP 200', '有 dialog out 回复', '窗口内 dispatched=0'],
  prereqIds: ['serverReachable', 'companionAvailable'],
  run: (ctx) => replyOnlyProbe(ctx, { http: 'hc05-http', reply: 'hc05-reply', nodispatch: 'hc05-nodispatch' }, '怎么这么久还没好啊？！我都等半天了', { sampleForReview: true }),
};

// ─── HC-06 ───

const hc06Text = '算了别派了……哎等等，还是派吧，就刚说的那个';

const hc06: ProbeDef = {
  id: 'HC-06', wave: 1, title: '否定改口「算了别派了……还是派吧」', dim: '真人语言·否定与改口', effect: 'delegation',
  utterance: hc06Text,
  steps: ['发送"先取消又改口要派"的矛盾指令', '等待可能的派活/撤回', '确认无 cancel+dispatch 双执行同一任务'],
  assertionDocs: ['HTTP 200', 'dispatched ≤ 1', 'cancelled ≤ 1', '若两者都有：撤回的不是刚派出的那个 taskId'],
  prereqIds: ['serverReachable', 'companionAvailable', 'bossExists'],
  run: async (ctx) => {
    const t = await sendTurn(ctx, hc06Text);
    await sleep(ZERO_DISPATCH_SETTLE_MS);
    const bosses = await bossIdSet(ctx);
    const dispatched = dispatchedRows(ctx, t.since, t.anchorId);
    const cancelled = ctx.query({ category: 'delegation', since: t.since, order: 'asc' }).filter((e) => bodyString(e, 'phase') === 'cancelled' && e.id > t.anchorId);
    const a1 = assertThat('hc06-http', 'HTTP 200', t.res.ok, '200', `${t.res.status}`);
    const a2 = assertThat('hc06-dispatch-le-1', 'dispatched ≤ 1', dispatched.length <= 1, '≤1', String(dispatched.length),
      dispatched.slice(0, 2).map((e) => entryEvidence(e, ['phase', 'toAgentId', 'message'], 80)));
    const a3 = assertThat('hc06-cancel-le-1', 'cancelled ≤ 1', cancelled.length <= 1, '≤1', String(cancelled.length),
      cancelled.slice(0, 2).map((e) => entryEvidence(e, ['phase', 'status', 'message'], 80)));
    const newTaskIds = new Set(dispatched.map((e) => e.taskId).filter(Boolean));
    const cancelledFresh = cancelled.filter((e) => e.taskId && newTaskIds.has(e.taskId));
    const a4 = assertThat('hc06-no-double', '撤回未命中刚派出的任务（无双执行）', cancelledFresh.length === 0,
      '0', String(cancelledFresh.length),
      cancelledFresh.map((e) => entryEvidence(e, ['phase', 'status'], 80)));
    const bad = dispatched.filter((e) => { const to = e.agentId ?? bodyString(e, 'toAgentId'); return to === undefined || !bosses.has(to); });
    const a5 = assertThat('hc06-boss-only', 'dispatched 只到 Boss', bad.length === 0, '0', String(bad.length));
    return { assertions: [a1, a2, a3, a4, a5], notes: t.anchorNote ? [t.anchorNote] : [], observed: observedSummary(ctx.query({ category: 'delegation', since: t.since, order: 'asc' }).filter((e) => e.id > t.anchorId)) };
  },
};

// ─── HC-07 ───

const hc07Text = '对了先不说这个——昨天服务器日志里有没有报错？还有小陈在忙啥呢';

const hc07: ProbeDef = {
  id: 'HC-07', wave: 1, title: '跨话题「不提这个——日志报错？小陈在忙啥？」', dim: '真人语言·多话题', effect: 'none',
  utterance: hc07Text,
  steps: ['发送两话题混合问句', '等回复', '确认单契约动作且最多一次派活'],
  assertionDocs: ['HTTP 200', '有 dialog out 回复', 'dispatched ≤ 1 且只到 Boss'],
  prereqIds: ['serverReachable', 'companionAvailable'],
  run: async (ctx) => {
    const t = await sendTurn(ctx, hc07Text);
    await sleep(ZERO_DISPATCH_SETTLE_MS);
    const dispatched = dispatchedRows(ctx, t.since, t.anchorId);
    const bosses = await bossIdSet(ctx);
    const bad = dispatched.filter((e) => { const to = e.agentId ?? bodyString(e, 'toAgentId'); return to === undefined || !bosses.has(to); });
    const a1 = assertThat('hc07-http', 'HTTP 200', t.res.ok, '200', `${t.res.status}`);
    const a2 = assertThat('hc07-reply', '有 dialog out 回复', !!t.out, 'out 行存在', t.out ? `id=${t.out.id}` : '无');
    const a3 = assertThat('hc07-dispatch-le-1', 'dispatched ≤ 1', dispatched.length <= 1, '≤1', String(dispatched.length));
    const a4 = assertThat('hc07-boss-only', '只到 Boss', bad.length === 0, '0', String(bad.length));
    return { assertions: [a1, a2, a3, a4], notes: [`回复样本：${truncate(bodyString(t.out, 'text'), 160) || '（无）'}`, ...(t.anchorNote ? [t.anchorNote] : [])], observed: observedSummary(dispatched) };
  },
};

// ─── HC-08 / HC-09 ───

const hc08: ProbeDef = {
  id: 'HC-08', wave: 1, title: '空指令「嗯……那个……」', dim: '真人语言·空指令', effect: 'none',
  utterance: '嗯……那个……',
  steps: ['发送无内容话语', '等回复', '确认无派活'],
  assertionDocs: ['HTTP 200', '有 dialog out 回复', 'dispatched=0'],
  prereqIds: ['serverReachable', 'companionAvailable'],
  run: (ctx) => replyOnlyProbe(ctx, { http: 'hc08-http', reply: 'hc08-reply', nodispatch: 'hc08-nodispatch' }, '嗯……那个……'),
};

const hc09: ProbeDef = {
  id: 'HC-09', wave: 1, title: '乱码「？？？！！！😅 asdfgh ？？？」', dim: '真人语言·乱码/emoji', effect: 'none',
  utterance: '？？？！！！😅 asdfgh ？？？',
  steps: ['发送乱码/emoji', '等回复', '确认不 5xx 且无派活'],
  assertionDocs: ['HTTP 200（非 5xx）', '有 dialog out 回复', 'dispatched=0'],
  prereqIds: ['serverReachable', 'companionAvailable'],
  run: (ctx) => replyOnlyProbe(ctx, { http: 'hc09-http', reply: 'hc09-reply', nodispatch: 'hc09-nodispatch' }, '？？？！！！😅 asdfgh ？？？'),
};

// ─── HC-10 超长 ───

function mkLeg(prefix: string, total: number): string {
  if (prefix.length > total) throw new Error('prefix 过长');
  return prefix + '收'.repeat(total - prefix.length);
}
export const HC10_LEG_A = mkLeg('真人战役超长探针（腿A，3990 字符）：', 3990);
export const HC10_LEG_B = mkLeg('真人战役超长探针（腿B，4001 字符）：', 4001);

const hc10: ProbeDef = {
  id: 'HC-10', wave: 1, title: '边界长度：3990 字符落盘 / 4001 → TEXT_TOO_LONG', dim: '边界·文本上限', effect: 'none',
  utterance: '（3990 字符探针文本 / 4001 字符探针文本，见常量 HC10_LEG_A/B）',
  steps: ['腿A：发送 3990 字符 → 期望 200 且 dialog in 落盘', '腿B：发送 4001 字符 → 期望 400 TEXT_TOO_LONG 且无落盘'],
  assertionDocs: ['腿A HTTP 200 + in 行存在', '腿B HTTP 400 + code=TEXT_TOO_LONG', '腿B 窗口内无该文本的 dialog in 行'],
  prereqIds: ['serverReachable', 'companionAvailable'],
  run: async (ctx) => {
    const a: ProbeOutcome['assertions'] = [];
    const legA = await sendTurn(ctx, HC10_LEG_A, { outTimeoutMs: ctx.options.logWaitMs });
    const legAAnchor = entryById(ctx, legA.anchorId, legA.since);
    a.push(assertThat('hc10a-http', '腿A HTTP 200', legA.res.ok, '200', `${legA.res.status}`));
    a.push(assertThat('hc10a-persisted', '腿A dialog in 落盘（精确文本锚点命中）', legA.anchorId > 0,
      '锚点 id>0', `anchorId=${legA.anchorId}`, legAAnchor ? [entryEvidence(legAAnchor, ['text'], 60)] : []));
    a.push(assertThat('hc10a-reply', '腿A 有回复', !!legA.out, 'out 行存在', legA.out ? `id=${legA.out.id}` : '无'));

    const legB = await sendTurn(ctx, HC10_LEG_B, { waitOut: false });
    const bCode = String((legB.res.json as { code?: unknown } | undefined)?.code ?? '');
    a.push(assertThat('hc10b-http400', '腿B HTTP 400', legB.res.status === 400, '400', `${legB.res.status}`));
    a.push(assertThat('hc10b-code', '腿B code=TEXT_TOO_LONG', bCode === 'TEXT_TOO_LONG', 'TEXT_TOO_LONG', bCode || '(无 code)'));
    const leak = dialogRows(ctx, legB.since, 0).filter((e) => bodyString(e, 'text') === HC10_LEG_B);
    a.push(assertThat('hc10b-no-persist', '腿B 未落盘（超长在副作用之前拒绝）', leak.length === 0, '0 行', `${leak.length} 行`));
    return {
      assertions: a,
      notes: [`腿A 长度=${HC10_LEG_A.length} 腿B 长度=${HC10_LEG_B.length}`, ...(legA.anchorNote ? [legA.anchorNote] : [])],
      observed: [],
    };
  },
};

// ─── HC-11 记忆写 ───

interface MemoryRead { ok: boolean; memory: unknown; count: number; error?: string }

async function readMemory(ctx: ProbeContext): Promise<MemoryRead> {
  const res = await ctx.transport.httpGet('/api/voice-companion/memory');
  const memory = (res.json as { memory?: unknown } | undefined)?.memory;
  let count = 0;
  if (Array.isArray(memory)) count = memory.length;
  else if (memory && typeof memory === 'object') {
    const notes = (memory as { notes?: unknown }).notes;
    count = Array.isArray(notes) ? notes.length : Object.keys(memory as object).length;
  }
  return { ok: res.ok, memory, count, error: res.error };
}

const hc11: ProbeDef = {
  id: 'HC-11', wave: 1, title: '记忆写「记一下：以后汇报先给结论…」', dim: '记忆·写入链路', effect: 'none',
  utterance: '记一下：以后汇报先给结论，再讲细节，别绕',
  steps: ['读 /memory 基线', '发送记忆陈述', '等回复', '轮询 /memory 增量'],
  assertionDocs: ['HTTP 200', 'memory 条目数 +1 或内容含"结论"', '有 dialog out 回复'],
  prereqIds: ['serverReachable', 'companionAvailable'],
  run: async (ctx) => {
    const before = await readMemory(ctx);
    const t = await sendTurn(ctx, '记一下：以后汇报先给结论，再讲细节，别绕');
    const after = await (async () => {
      for (let i = 0; i < 20; i++) { // 最多 20s
        await sleep(1000);
        const cur = await readMemory(ctx);
        if (cur.count > before.count || JSON.stringify(cur.memory ?? '').includes('结论')) return cur;
      }
      return readMemory(ctx);
    })();
    const grew = after.count > before.count;
    const contains = JSON.stringify(after.memory ?? '').includes('结论');
    const a1 = assertThat('hc11-http', 'HTTP 200', t.res.ok, '200', `${t.res.status}`);
    const a2 = assertThat('hc11-memory', '记忆写入生效（条目 +1 或含"结论"）', grew || contains,
      'count+1 或内容含"结论"', `count ${before.count}→${after.count}；含结论=${contains}`);
    const a3 = assertThat('hc11-reply', '有 dialog out 回复', !!t.out, 'out 行存在', t.out ? `id=${t.out.id}` : '无');
    return {
      assertions: [a1, a2, a3],
      notes: ['记忆 +1 为真实变化、不回滚（用户裁决：reset 会清既有记忆，如实登记）', ...(t.anchorNote ? [t.anchorNote] : [])],
      observed: [],
    };
  },
};

// ─── HC-12 记忆读回 ───

const hc12: ProbeDef = {
  id: 'HC-12', wave: 1, title: '记忆读回「我之前交代过你汇报要怎么讲来着？」', dim: '记忆·读回一致性', effect: 'none',
  utterance: '我之前交代过你汇报要怎么讲来着？',
  steps: ['发送记忆追问', '等回复', '记录回复文本供人工抽验'],
  assertionDocs: ['HTTP 200', '有 dialog out 回复', '（人工抽验）回复应体现"先结论后细节"'],
  prereqIds: ['serverReachable', 'companionAvailable'],
  run: async (ctx) => {
    const outcome = await replyOnlyProbe(ctx, { http: 'hc12-http', reply: 'hc12-reply', nodispatch: 'hc12-nodispatch' }, '我之前交代过你汇报要怎么讲来着？');
    const t = await ctx.transport.httpGet('/api/voice-companion/memory');
    const memStr = JSON.stringify((t.json as { memory?: unknown } | undefined)?.memory ?? '');
    outcome.notes.push(`记忆当前含"结论"=${memStr.includes('结论')}（读回一致性的人工抽验参照）`);
    return outcome;
  },
};

// ─── HC-13 闸门低相关 ───

const hc13: ProbeDef = {
  id: 'HC-13', wave: 1, title: '闸门低相关「纯闲聊」→ 不外溢播报', dim: '闸门·闲聊低相关', effect: 'none',
  utterance: '哈哈哈哈今天天气真好，纯闲聊',
  steps: ['发送纯闲聊', '等回复拿到本回合 taskId', '扫描窗口内是否存在"他人"播报'],
  assertionDocs: ['HTTP 200', '有 dialog out 回复', '窗口内除本回合 taskId 外 broadcast=0'],
  prereqIds: ['serverReachable', 'companionAvailable'],
  run: async (ctx) => {
    const t = await sendTurn(ctx, '哈哈哈哈今天天气真好，纯闲聊');
    await sleep(2000);
    const anchor = entryById(ctx, t.anchorId, t.since);
    const myTaskId = anchor?.taskId;
    const mine = broadcastRows(ctx, t.since, t.anchorId).filter((e) => myTaskId !== undefined && e.taskId === myTaskId);
    const foreign = broadcastRows(ctx, t.since, t.anchorId).filter((e) => myTaskId === undefined || e.taskId !== myTaskId);
    const a1 = assertThat('hc13-http', 'HTTP 200', t.res.ok, '200', `${t.res.status}`);
    const a2 = assertThat('hc13-reply', '有 dialog out 回复', !!t.out, 'out 行存在', t.out ? `id=${t.out.id}` : '无');
    const a3 = assertThat('hc13-no-foreign-broadcast', '窗口内无"他人"播报（不含本回合）', foreign.length === 0,
      'foreign broadcast=0', `foreign=${foreign.length}（本回合 broadcast=${mine.length}）`,
      foreign.slice(0, 3).map((e) => entryEvidence(e, ['phase', 'action', 'text'], 60)));
    return {
      assertions: [a1, a2, a3],
      notes: [
        '口径修正（对照计划）：服务端每个回应都会落 dialog(out)+broadcast(server-sent, 同 taskId)（voice-companion-service.ts:2274）——',
        '闲聊"不外溢"的正确判据是：除本回合 taskId 外无其它播报行。',
        ...(t.anchorNote ? [t.anchorNote] : []),
      ],
      observed: observedSummary(broadcastRows(ctx, t.since, t.anchorId)),
    };
  },
};

// ─── HC-14 红队②（机制级替代） ───

const hc14: ProbeDef = {
  id: 'HC-14', wave: 1, title: '红队②·用户发言永不过闸（真跑 14a + 机制证据 14b）', dim: '红队·夜间闸门边界', effect: 'none',
  utterance: '在吗？',
  steps: ['14a：真跑任一时刻用户发言 → 必答且非事件（isEvent!=true）', '14b：机制证据链——闸门代码/单测目检（真夜窗 23:00–07:00 不实跑，如实登记）'],
  assertionDocs: ['14a HTTP 200 + 有回复 + in 行 isEvent!=true', '14b 源码含 deep_night 相位与用户开口豁免路径'],
  prereqIds: ['serverReachable', 'companionAvailable'],
  run: async (ctx) => {
    const t = await sendTurn(ctx, '在吗？');
    const anchor = entryById(ctx, t.anchorId, t.since);
    const isEvent = anchor?.body?.isEvent;
    const a1 = assertThat('hc14a-http', 'HTTP 200', t.res.ok, '200', `${t.res.status}`);
    const a2 = assertThat('hc14a-reply', '用户发言必答（out 存在）', !!t.out, 'out 行存在', t.out ? `id=${t.out.id}` : '无');
    const a3 = assertThat('hc14a-not-event', '本次 in 行 isEvent!=true（用户开口非事件通道）', isEvent !== true, 'isEvent!=true', `isEvent=${String(isEvent)}`);

    // 14b 机制证据：读源码关键锚点
    const root = repoRoot();
    const gateFile = path.join(root, 'src/packages/server/services/broadcast-gates.ts');
    const reporterFile = path.join(root, 'src/packages/client/voice/proactiveReporter.ts');
    const gateSrc = fs.existsSync(gateFile) ? fs.readFileSync(gateFile, 'utf8') : '';
    const reporterSrc = fs.existsSync(reporterFile) ? fs.readFileSync(reporterFile, 'utf8') : '';
    const gateHit = /deep_night/.test(gateSrc) && /23|7\b/.test(gateSrc);
    const reporterHit = /quiet|静默|夜间/.test(reporterSrc);
    const a4 = assertThat('hc14b-mechanism', '机制证据链在位（deep_night 闸门 + quiet-hours 客户端挂起）',
      gateHit && reporterHit,
      'broadcast-gates.ts 含 deep_night；proactiveReporter.ts 含 quiet/夜间 处理',
      `gateHit=${gateHit} reporterHit=${reporterHit}（${gateFile.replace(root, '')} / ${reporterFile.replace(root, '')}）`);
    return {
      assertions: [a1, a2, a3, a4],
      notes: [
        '欠账登记：真夜间窗口（23:00–07:00）L3 未跑（用户裁决②：机制级替代+如实登记）——真夜验证留待后续专项。',
        '用户开口永不过闸的依据：routes/voice-companion.ts:109-129（event=true 才过闸口）。',
        ...(t.anchorNote ? [t.anchorNote] : []),
      ],
      observed: [],
    };
  },
};

export const W1_PROBES: ProbeDef[] = [hc01, hc02, hc03, hc04, hc05, hc06, hc07, hc08, hc09, hc10, hc11, hc12, hc13, hc14];
