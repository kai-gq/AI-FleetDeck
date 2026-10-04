import { describe, it, expect } from 'vitest';
import {
  stripCodeFences,
  parseContractJson,
  applyMemoryOps,
  buildAgentSnapshotLines,
  buildCompanionSystemPrompt,
  resolveDispatchRoute,
  isBossLikeAgent,
  shouldRotateSession,
  shouldRotateForPersona,
  DEFAULT_SERVER_CONFIG,
  type CompanionMemory,
  type VoiceCompanionState,
} from './voice-companion-service.js';
import { VOICE_PERSONAS } from '../../shared/voice-personas.js';

function emptyMemory(): CompanionMemory {
  return { summary: '', notes: [], updatedAt: 0, droppedCount: 0 };
}

function emptyState(): VoiceCompanionState {
  return { sessionId: null, sessionStartedAt: null, turns: 0, lastUsedAt: null, personaKey: null, memory: emptyMemory() };
}

describe('stripCodeFences', () => {
  it('removes ```json fences', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('removes bare fences', () => {
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
});

describe('parseContractJson', () => {
  it('parses a clean contract', () => {
    const c = parseContractJson(JSON.stringify({
      action: 'send_to_agent',
      targetAgentId: 'a1',
      targetAgentName: '小美',
      messageToAgent: '修登录页',
      delivery: 'queue',
      responseToUser: '好的',
      memoryOps: [{ op: 'add', text: '叫我老板' }],
    }));
    expect(c.action).toBe('send_to_agent');
    expect(c.targetAgentId).toBe('a1');
    expect(c.messageToAgent).toBe('修登录页');
    expect(c.delivery).toBe('queue');
    expect(c.memoryOps).toEqual([{ op: 'add', text: '叫我老板' }]);
  });

  it('tolerates prose around the JSON and code fences', () => {
    const c = parseContractJson('好的,这是结果:\n```json\n{"action":"noop","responseToUser":""}\n```\n谢谢');
    expect(c.action).toBe('noop');
    expect(c.responseToUser).toBe('');
  });

  it('falls back to general_response for unknown actions and invalid delivery', () => {
    const c = parseContractJson('{"action":"destroy","delivery":"now"}');
    expect(c.action).toBe('general_response');
    expect(c.delivery).toBe('queue');
    expect(c.targetAgentId).toBeNull();
    expect(c.memoryOps).toEqual([]);
  });

  it('drops malformed memoryOps entries', () => {
    const c = parseContractJson('{"memoryOps":[{"op":"add"},{"op":"remove"},{"op":"add","text":"ok"},{"op":"remove","id":"x"}]}');
    expect(c.memoryOps).toEqual([
      { op: 'add', text: 'ok' },
      { op: 'remove', id: 'x' },
    ]);
  });

  it('throws when there is no JSON object', () => {
    expect(() => parseContractJson('抱歉,我听不懂')).toThrow();
  });

  // ---- 改① 任务只走 Boss:契约解析 ----

  it('解析「任务」语义的 delegate_to_boss 契约(改①)', () => {
    const c = parseContractJson(JSON.stringify({
      action: 'delegate_to_boss',
      targetAgentId: null,
      messageToAgent: '把登录页重构成 React 18 并补测试',
      responseToUser: '已交给主管安排。',
    }));
    expect(c.action).toBe('delegate_to_boss');
    expect(c.messageToAgent).toBe('把登录页重构成 React 18 并补测试');
    expect(c.targetAgentId).toBeNull();
  });

  it('「聊天/查询/列人」语义的契约不会解析成 delegate_to_boss(改①)', () => {
    const chat = parseContractJson(JSON.stringify({ action: 'general_response', responseToUser: '在的。' }));
    const query = parseContractJson(JSON.stringify({ action: 'query_agent_output', targetAgentId: 'a1', query: '进度' }));
    const list = parseContractJson(JSON.stringify({ action: 'list_agents', responseToUser: '都在忙。' }));
    expect([chat.action, query.action, list.action])
      .toEqual(['general_response', 'query_agent_output', 'list_agents']);
    expect([chat, query, list].some((c) => c.action === 'delegate_to_boss')).toBe(false);
  });

  it('delegate_to_boss 是白名单动作,未知 action 仍回退 general_response', () => {
    expect(parseContractJson('{"action":"delegate_to_boss"}').action).toBe('delegate_to_boss');
    expect(parseContractJson('{"action":"delegate_to_agent"}').action).toBe('general_response');
  });
});

// ============================================================================
// 改① 派发路由:任务只走 Boss(决策观测点①)
// ============================================================================

describe('resolveDispatchRoute — 全走 Boss 不变式(改①)', () => {
  const world = [
    { id: 'a1', name: '小美', class: 'builder' },
    { id: 'b1', name: '大当家', class: 'boss', isBoss: true },
  ];

  it('isBossLikeAgent 与 boss-service 判定一致(isBoss 或 class==="boss")', () => {
    expect(isBossLikeAgent({ isBoss: true })).toBe(true);
    expect(isBossLikeAgent({ class: 'boss' })).toBe(true);
    expect(isBossLikeAgent({ class: 'builder', isBoss: false })).toBe(false);
  });

  it('delegate_to_boss 留空目标 → 落到主管', () => {
    const route = resolveDispatchRoute('delegate_to_boss', null, world);
    expect(route).toEqual({ route: 'boss', agent: world[1] });
  });

  it('delegate_to_boss 模型误填普通 agent → 仍改道主管并记违规', () => {
    const route = resolveDispatchRoute('delegate_to_boss', 'a1', world);
    expect(route.route).toBe('boss');
    if (route.route !== 'boss') throw new Error('unreachable');
    expect(route.agent.id).toBe('b1');
    expect(route.violation).toEqual({ requestedAgentId: 'a1', requestedAgentName: '小美' });
  });

  it('send_to_agent 指向主管 → 合法直达(Boss 仍可达)', () => {
    expect(resolveDispatchRoute('send_to_agent', 'b1', world)).toEqual({ route: 'boss', agent: world[1] });
  });

  it('send_to_agent 指向普通 agent → 违规标记并改道主管', () => {
    const route = resolveDispatchRoute('send_to_agent', 'a1', world);
    expect(route.route).toBe('boss');
    if (route.route !== 'boss') throw new Error('unreachable');
    expect(route.agent.id).toBe('b1');
    expect(route.violation).toEqual({ requestedAgentId: 'a1', requestedAgentName: '小美' });
  });

  it('目标不存在 → missing;团队没主管 → no_boss(违规也如实记录)', () => {
    expect(resolveDispatchRoute('send_to_agent', 'nope', world)).toEqual({ route: 'missing' });
    const noBossWorld = [{ id: 'a1', name: '小美', class: 'builder' }];
    expect(resolveDispatchRoute('delegate_to_boss', null, noBossWorld)).toEqual({ route: 'no_boss' });
    expect(resolveDispatchRoute('send_to_agent', 'a1', noBossWorld)).toEqual({
      route: 'no_boss',
      violation: { requestedAgentId: 'a1', requestedAgentName: '小美' },
    });
  });
});

describe('applyMemoryOps', () => {
  it('adds a note and dedupes identical text', () => {
    const { memory, applied } = applyMemoryOps(emptyMemory(), [
      { op: 'add', text: '叫我老板' },
      { op: 'add', text: '叫我老板' },
    ], 40, 1000);
    expect(applied).toBe(1);
    expect(memory.notes).toHaveLength(1);
    expect(memory.notes[0].source).toBe('user');
    expect(memory.notes[0].id).toMatch(/^m/);
  });

  it('ignores too-short notes', () => {
    const { applied } = applyMemoryOps(emptyMemory(), [{ op: 'add', text: ' ' }, { op: 'add', text: 'x' }], 40);
    expect(applied).toBe(0);
  });

  it('removes by id', () => {
    const first = applyMemoryOps(emptyMemory(), [{ op: 'add', text: '喜好A' }], 40, 1000).memory;
    const { memory, applied } = applyMemoryOps(first, [{ op: 'remove', id: first.notes[0].id }], 40, 2000);
    expect(applied).toBe(1);
    expect(memory.notes).toHaveLength(0);
  });

  it('caps notes at maxNotes, dropping the oldest auto entry first', () => {
    let memory = emptyMemory();
    memory.notes.push({ id: 'auto-old', text: '自动旧条', createdAt: 1, source: 'auto' });
    for (let i = 0; i < 4; i++) {
      memory = applyMemoryOps(memory, [{ op: 'add', text: `笔记${i}` }], 5, 100 + i).memory;
    }
    // 现在 5 条(容量),再加一条应挤掉 auto-old
    const { memory: capped } = applyMemoryOps(memory, [{ op: 'add', text: '新笔记' }], 5, 999);
    expect(capped.notes).toHaveLength(5);
    expect(capped.notes.some((n) => n.id === 'auto-old')).toBe(false);
    expect(capped.droppedCount).toBe(1);
  });

  it('sets summary', () => {
    const { memory, applied } = applyMemoryOps(emptyMemory(), [{ op: 'setSummary', summary: '  老板喜欢简洁汇报  ' }], 40);
    expect(applied).toBe(1);
    expect(memory.summary).toBe('老板喜欢简洁汇报');
  });

  it('returns the same object when nothing applied', () => {
    const memory = emptyMemory();
    const { memory: out, applied } = applyMemoryOps(memory, [{ op: 'remove', id: 'nope' }], 40);
    expect(applied).toBe(0);
    expect(out).toBe(memory);
  });

  it('reports per-op details（任务 02：生效/未生效逐条列出）', () => {
    const { details } = applyMemoryOps(emptyMemory(), [
      { op: 'add', text: '喜好A' },
      { op: 'add', text: '喜好A' }, // 重复 → 未生效
      { op: 'add', text: ' ' },     // 过短 → 未生效
      { op: 'remove', id: 'nope' }, // 未找到 → 未生效
      { op: 'setSummary', summary: '喜欢简洁' },
    ], 40, 1000);
    expect(details).toEqual([
      { op: 'add', applied: true, droppedCount: 0 },
      { op: 'add', applied: false },
      { op: 'add', applied: false },
      { op: 'remove', applied: false },
      { op: 'setSummary', applied: true },
    ]);
  });

  it('reports droppedCount per add when the cap evicts notes（任务 02：裁剪计入明细）', () => {
    const memory = emptyMemory();
    memory.notes.push({ id: 'auto-a', text: 'A', createdAt: 1, source: 'auto' });
    memory.notes.push({ id: 'auto-b', text: 'B', createdAt: 2, source: 'auto' });
    const { details, memory: out } = applyMemoryOps(memory, [{ op: 'add', text: '新笔记' }], 2, 999);
    expect(details).toEqual([{ op: 'add', applied: true, droppedCount: 1 }]);
    expect(out.droppedCount).toBe(1);
    expect(out.notes).toHaveLength(2);
  });
});

describe('shouldRotateSession', () => {
  it('never rotates without a session', () => {
    expect(shouldRotateSession(emptyState(), DEFAULT_SERVER_CONFIG, 10_000_000)).toBe(false);
  });
  it('rotates on turn cap', () => {
    const state = { ...emptyState(), sessionId: 's1', turns: DEFAULT_SERVER_CONFIG.maxTurns };
    expect(shouldRotateSession(state, DEFAULT_SERVER_CONFIG)).toBe(true);
  });
  it('rotates on age cap', () => {
    const state = { ...emptyState(), sessionId: 's1', sessionStartedAt: 0 };
    const now = DEFAULT_SERVER_CONFIG.sessionMaxAgeDays * 86_400_000 + 1;
    expect(shouldRotateSession(state, DEFAULT_SERVER_CONFIG, now)).toBe(true);
  });
  it('keeps a young session', () => {
    const state = { ...emptyState(), sessionId: 's1', turns: 5, sessionStartedAt: 1000 };
    expect(shouldRotateSession(state, DEFAULT_SERVER_CONFIG, 2000)).toBe(false);
  });
});

describe('shouldRotateForPersona', () => {
  it('rotates once for legacy state (personaKey missing)', () => {
    expect(shouldRotateForPersona({ ...emptyState(), sessionId: 's1' }, 'doubao')).toBe(true);
  });
  it('keeps the session while the persona is unchanged', () => {
    const state = { ...emptyState(), sessionId: 's1', personaKey: 'butler' };
    expect(shouldRotateForPersona(state, 'butler')).toBe(false);
  });
  it('rotates when the persona changed', () => {
    const state = { ...emptyState(), sessionId: 's1', personaKey: 'butler' };
    expect(shouldRotateForPersona(state, 'sharp')).toBe(true);
  });
});

describe('buildAgentSnapshotLines', () => {
  it('renders id/status/task and areas, sorted by recent activity', () => {
    const agents = [
      { id: 'a1', name: '小美', class: 'builder', status: 'working', taskLabel: '修登录页', lastWorkedAt: 100 },
      { id: 'a2', name: '老王', class: 'boss', status: 'idle', isBoss: true, lastWorkedAt: 200 },
    ];
    const areas = [
      { id: 'ar1', name: '前端区', archived: false, assignedAgentIds: ['a1'] },
    ] as never;
    const { lines, total, truncated } = buildAgentSnapshotLines(agents, areas);
    expect(total).toBe(2);
    expect(truncated).toBe(false);
    expect(lines[0]).toContain('老王');
    expect(lines[0]).toContain('[BOSS]');
    expect(lines[1]).toContain('小美');
    expect(lines[1]).toContain('id: a1');
    expect(lines[1]).toContain('任务: 修登录页');
    expect(lines[1]).toContain('区域: 前端区');
  });

  it('truncates long task/error text and caps at 60 agents', () => {
    const agents = Array.from({ length: 70 }, (_, i) => ({
      id: `a${i}`, name: `agent${i}`, status: 'idle', lastWorkedAt: i,
      taskLabel: 'x'.repeat(200), lastError: 'e'.repeat(200),
    }));
    const { lines, truncated } = buildAgentSnapshotLines(agents, []);
    expect(lines).toHaveLength(60);
    expect(truncated).toBe(true);
    // 最热(lastWorkedAt 最大)的排最前
    expect(lines[0]).toContain('agent69');
    expect(lines[0]).toContain('…');
  });

  it('bounds snapshot and prompt size for a worst-case 60-agent world(P5 体积护栏)', () => {
    const agents = Array.from({ length: 60 }, (_, i) => ({
      id: `agent-${i}-0123456789`, name: `写代码的${i}号`, class: 'builder', status: 'working',
      lastWorkedAt: i,
      taskLabel: '把登录页重构成 React 18 并发模式并补齐测试'.repeat(3),
      lastError: 'Error: connect ECONNREFUSED 127.0.0.1:7433'.repeat(3),
    }));
    const areas = [{ id: 'ar1', name: '前端开发区', archived: false, assignedAgentIds: agents.map((a) => a.id) }] as never;
    const { lines } = buildAgentSnapshotLines(agents, areas);
    const joined = lines.join('\n');
    expect(joined.length).toBeLessThan(60 * 260); // 每行 ≤ ~260 字符,快照整体有界
    expect(joined).toContain('…'); // 长字段确实被截断

    const prompt = buildCompanionSystemPrompt({
      agentLines: lines, totalAgents: 60, truncated: false,
      memory: { ...emptyMemory(), notes: Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, text: '偏好笔记'.repeat(10), createdAt: 0, source: 'auto' as const })) },
      nowText: '2026-10-03 12:00',
    });
    expect(prompt.length).toBeLessThan(20_000); // 整体 prompt 体积护栏(实测远低于此)
  });
});

describe('buildCompanionSystemPrompt — persona & 自适应长度', () => {
  const base = () => ({
    agentLines: ['- 小美 (id: a1, idle)'],
    totalAgents: 1,
    truncated: false,
    memory: emptyMemory(),
    nowText: '2026-10-03 12:00',
  });

  it('injects the default persona (豆包风) and dropped the 60-char caps', () => {
    const prompt = buildCompanionSystemPrompt(base());
    const doubao = VOICE_PERSONAS.find((p) => p.id === 'doubao')!;
    expect(prompt).toContain(doubao.stylePrompt);
    expect(prompt).not.toContain('不超过 60 字');
  });

  it('honors a preset id and a custom persona', () => {
    const butler = VOICE_PERSONAS.find((p) => p.id === 'butler')!;
    expect(buildCompanionSystemPrompt({ ...base(), persona: { preset: 'butler', custom: '' } }))
      .toContain(butler.stylePrompt);
    expect(buildCompanionSystemPrompt({ ...base(), persona: { preset: 'custom', custom: '你是个海盗船长。' } }))
      .toContain('你是个海盗船长。');
  });
});

describe('buildCompanionSystemPrompt — 三态边界与派活路径(改①)', () => {
  const base = () => ({
    agentLines: ['- 大当家 | id: b1 | boss | idle [BOSS]', '- 小美 | id: a1 | builder | working'],
    totalAgents: 2,
    truncated: false,
    memory: emptyMemory(),
    nowText: '2026-10-04 12:00',
  });

  it('契约模板与说明收录 delegate_to_boss', () => {
    const prompt = buildCompanionSystemPrompt(base());
    expect(prompt).toContain('general_response|delegate_to_boss|send_to_agent');
    expect(prompt).toContain('delegate_to_boss: 老板要「派人干活」时唯一的派活动作');
  });

  it('prompt 中不再存在向普通 agent 派活的路径(验收 3)', () => {
    const prompt = buildCompanionSystemPrompt(base());
    // 旧文案(把任意 agent id 填进 send_to_agent 派活)必须消失
    expect(prompt).not.toContain('老板要求某个 agent 做事');
    expect(prompt).not.toContain('targetAgentId 填下方列表里的 id');
    // send_to_agent 被限定为主管专用;普通 agent 只能查
    expect(prompt).toContain('任何让普通 agent 干活的请求都不得用它');
    expect(prompt).toContain('其中标 [BOSS] 的才能用 send_to_agent 直接对话');
  });

  it('强化 query/send/delegate 三态边界,防「问进度」被误判成派活(Spec §2.4.1 环1)', () => {
    const prompt = buildCompanionSystemPrompt(base());
    expect(prompt).toContain('【三态边界');
    expect(prompt).toContain('老板说「去查一下/问一下 XX」也是查询,不是让你派活');
    expect(prompt).toContain('绝不擅自派活');
  });
});
