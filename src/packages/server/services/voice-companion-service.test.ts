import { describe, it, expect } from 'vitest';
import {
  stripCodeFences,
  parseContractJson,
  applyMemoryOps,
  buildAgentSnapshotLines,
  buildCompanionSystemPrompt,
  COMPANION_ACTIONS,
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
// 任务36 · parseContractJson 模糊矩阵
//
// 不可信 LLM 输出的单点防御:类型混淆 / 截断 / 超长 / 多块选取 / 原型污染键。
// 期望值全部以产品代码现行为准(parseContractJson:首 { → 末 } 切段 + 白名单 +
// 逐字段 typeof 回退);「无 JSON 抛错后的调用方降级」是服务级行为,由
// voice-companion-service.integration.test.ts 的 G8 故障注入组断言。
// ============================================================================

describe('parseContractJson 模糊矩阵(任务36)', () => {
  it('非字符串 action:一律白名单回退 general_response', () => {
    expect(parseContractJson('{"action":123}').action).toBe('general_response');
    expect(parseContractJson('{"action":["delegate_to_boss"]}').action).toBe('general_response');
    expect(parseContractJson('{"action":{"$ref":"delegate_to_boss"}}').action).toBe('general_response');
    expect(parseContractJson('{"action":true}').action).toBe('general_response');
    expect(parseContractJson('{"action":null}').action).toBe('general_response');
  });

  it('字段类型混淆:目标/文本/数组字段按类型回退缺省,不抛', () => {
    const c = parseContractJson(JSON.stringify({
      action: 'send_to_agent',
      targetAgentId: 42,
      targetAgentName: { name: '小美' },
      messageToAgent: 123,
      delivery: 'now',
      query: ['进度'],
      bolbaTask: 9,
      responseToUser: { text: '你好' },
      memoryOps: 'not-an-array',
    }));
    expect(c).toEqual({
      action: 'send_to_agent',
      targetAgentId: null,
      targetAgentName: null,
      messageToAgent: '',
      delivery: 'queue',
      query: '',
      bolbaTask: '',
      responseToUser: '',
      memoryOps: [],
    });
  });

  it('字符串字段 trim;空串目标回退 null;delivery 只认精确 interrupt', () => {
    const c = parseContractJson('{"action":"send_to_agent","targetAgentId":"  a1  ","targetAgentName":"  小美 ","messageToAgent":"  干活  ","delivery":"INTERRUPT","query":"  进度  ","responseToUser":"  好的  "}');
    expect(c.targetAgentId).toBe('a1');
    expect(c.targetAgentName).toBe('小美');
    expect(c.messageToAgent).toBe('干活');
    expect(c.query).toBe('进度');
    expect(c.responseToUser).toBe('好的');
    expect(c.delivery).toBe('queue'); // 大小写不糊弄:非精确 'interrupt' 一律 queue
    expect(parseContractJson('{"action":"noop","targetAgentId":"   ","delivery":"interrupt"}').targetAgentId).toBeNull();
    expect(parseContractJson('{"action":"noop","delivery":"interrupt"}').delivery).toBe('interrupt');
  });

  it('memoryOps 里的非对象/类型不符条目逐条丢弃,不抛', () => {
    const c = parseContractJson(JSON.stringify({
      memoryOps: [
        null, 'add', 42, ['add'],
        { op: 'add', text: 5 },
        { op: 'remove', id: 7 },
        { op: 'setSummary', summary: false },
        { op: 'add', text: 'ok' },
      ],
    }));
    expect(c.memoryOps).toEqual([{ op: 'add', text: 'ok' }]);
  });

  it('截断 JSON(有首 { 无尾 }):抛 No JSON object,绝不吞成半个契约', () => {
    const truncated = [
      '{"action":"noop"',
      '{"action":"general_response","responseToUser":"你好',
      '前面 {"action":"noop" 后面(无闭合)',
      '{',
    ];
    for (const raw of truncated) {
      expect(() => parseContractJson(raw)).toThrow('No JSON object in response');
    }
  });

  it('空串/纯文本/只有右花括号:抛错;空对象 {} 则全字段取缺省', () => {
    for (const raw of ['', '   ', '抱歉,我听不懂', '}', '[]']) {
      expect(() => parseContractJson(raw)).toThrow();
    }
    const c = parseContractJson('{}');
    expect(c.action).toBe('general_response');
    expect(c.targetAgentId).toBeNull();
    expect(c.messageToAgent).toBe('');
    expect(c.delivery).toBe('queue');
    expect(c.memoryOps).toEqual([]);
  });

  it('超长输入(1MB 级)不抛、不截断响应字段;bolbaTask 仍按 200 字上限截断', () => {
    // 合理上限:百万字符级;解析只做首尾花括号切段,不做全文正则。
    const proseBefore = 'x'.repeat(500_000);
    const proseAfter = '尾'.repeat(200_000);
    const body = JSON.stringify({ action: 'general_response', responseToUser: '好'.repeat(100_000) });
    const c = parseContractJson(`${proseBefore}${body}${proseAfter}`);
    expect(c.action).toBe('general_response');
    expect(c.responseToUser).toHaveLength(100_000);

    const longAction = `{"action":"${'a'.repeat(200_000)}"}`;
    expect(parseContractJson(longAction).action).toBe('general_response');

    const longTask = parseContractJson(`{"action":"create_bolba_task","bolbaTask":"${'任'.repeat(300)}"}`);
    expect(longTask.bolbaTask).toHaveLength(201); // 200 字 + 省略号
    expect(longTask.bolbaTask.endsWith('…')).toBe(true);
  });

  it('多个完整 JSON 块:首 { → 末 } 切段后中间夹带文本,JSON.parse 必抛(不静默取首块)', () => {
    expect(() => parseContractJson('{"action":"noop"}\n{"action":"delegate_to_boss"}')).toThrow();
    expect(() => parseContractJson('{"action":"noop"} 中间说明 {"action":"delegate_to_boss"}')).toThrow();
  });

  it('首 { → 末 } 切段语义:段外干扰花括号破坏解析,段内字符串花括号无害', () => {
    // 干扰 { 在真 JSON 之前 → 切段起点错位 → 抛
    expect(() => parseContractJson('说明 { 干扰 {"action":"noop"}')).toThrow();
    // 干扰 } 在真 JSON 之后 → 切段终点错位 → 抛
    expect(() => parseContractJson('{"action":"noop"} 干扰 }')).toThrow();
    // 干扰 } 全部在真 JSON 之前 → 段正确 → 解析成功
    expect(parseContractJson('干扰 } 干扰 {"action":"noop"}').action).toBe('noop');
    // 字符串值内的花括号只是文本(切段不受字符串内括号影响)
    const c = parseContractJson('{"action":"noop","responseToUser":"花括号 { 和 } 都只是文本"}');
    expect(c.responseToUser).toBe('花括号 { 和 } 都只是文本');
  });

  it('数组外壳 [{...}] 仍按首 { → 末 } 取内层对象(容错现状锁定)', () => {
    expect(parseContractJson('[{"action":"list_agents"}]').action).toBe('list_agents');
  });

  it('__proto__/constructor 原型污染键:不污染全局原型,恶意键不得改变 action', () => {
    const viaProto = parseContractJson('{"__proto__":{"action":"delegate_to_boss","polluted":true},"action":"noop"}');
    expect(viaProto.action).toBe('noop'); // 自有 action 优先
    // JSON.parse 的 __proto__ 是自有属性(不触发原型赋值),不参与属性查找
    expect(parseContractJson('{"__proto__":{"action":"delegate_to_boss"}}').action).toBe('general_response');
    expect(parseContractJson('{"constructor":{"prototype":{"polluted":true}},"action":"noop"}').action).toBe('noop');

    expect(Object.getPrototypeOf(viaProto)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).action).toBeUndefined();
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

// ============================================================================
// 任务13·⑩ 秘书 Bolba 桥:契约动作 / bolbaTask 字段 / 提示词接线
// ============================================================================

describe('任务13·⑩ Bolba 契约动作', () => {
  const BOLBA_ACTIONS = ['query_bolba_tasks', 'create_bolba_task', 'complete_bolba_task', 'reopen_bolba_task'] as const;

  it('COMPANION_ACTIONS 收录四动作,且都能被 parseContractJson 解析为白名单动作', () => {
    for (const action of BOLBA_ACTIONS) {
      expect(COMPANION_ACTIONS).toContain(action);
      expect(parseContractJson(JSON.stringify({ action })).action).toBe(action);
    }
  });

  it('parseContractJson 解析 bolbaTask(trim;非字符串 → 空串)', () => {
    const c = parseContractJson('{"action":"create_bolba_task","bolbaTask":"  准备 BOL-4472 报价  ","query":"今天要盯的"}');
    expect(c.bolbaTask).toBe('准备 BOL-4472 报价');
    expect(c.query).toBe('今天要盯的');
    expect(parseContractJson('{"action":"create_bolba_task","bolbaTask":123}').bolbaTask).toBe('');
    expect(parseContractJson('{"action":"query_bolba_tasks"}').bolbaTask).toBe('');
  });

  it('契约模板含 bolbaTask 字段,说明区含四动作与两本账边界', () => {
    const prompt = buildCompanionSystemPrompt({
      agentLines: [], totalAgents: 0, truncated: false, memory: emptyMemory(), nowText: '2026-10-04 12:00',
    });
    expect(prompt).toContain('"query":"","bolbaTask":""');
    for (const action of BOLBA_ACTIONS) expect(prompt).toContain(`${action}: `);
    expect(prompt).toContain('业务待办(报价/付款/会议/证书/盯人盯事)走 Bolba 四动作');
    expect(prompt).toContain('绝不混账');
    // 业务动作不得写进派活说明区(两本账不混)
    expect(prompt).toContain('agent 的活(写代码/改 bug/推进项目)走 delegate_to_boss');
  });
});
