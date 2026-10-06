import { afterEach, describe, it, expect, vi } from 'vitest';
import { HANDOFF_TTL_MS, type HandoffNote } from '../voice/handoff.js';
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
  isContextCompactionDue,
  DEFAULT_SERVER_CONFIG,
  type CompanionMemory,
  type VoiceCompanionServerConfig,
  type VoiceCompanionState,
} from './voice-companion-service.js';
import { VOICE_PERSONAS } from '../../shared/voice-personas.js';

function emptyMemory(): CompanionMemory {
  return { summary: '', notes: [], updatedAt: 0, droppedCount: 0 };
}

function emptyState(): VoiceCompanionState {
  return { sessionId: null, sessionStartedAt: null, turns: 0, lastUsedAt: null, personaKey: null, memory: emptyMemory() };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

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
  /** 直插既有笔记(绕过 add 的时间戳/上限逻辑,便于构造匹配矩阵)。 */
  function seedNotes(entries: Array<{ id: string; text: string }>): CompanionMemory {
    return {
      summary: '',
      notes: entries.map((e, i) => ({ ...e, createdAt: i + 1, source: 'user' as const })),
      updatedAt: 0,
      droppedCount: 0,
    };
  }

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
      // A13/H6-1:remove 明细扩展 id/reason(可选字段);add/setSummary 明细逐字不变。
      { op: 'remove', applied: false, id: 'nope', reason: 'not_found' },
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

  // ==========================================================================
  // A13/H6-1 · remove.id 未命中时的文本兜底
  //
  // 事故形态:模型把笔记**文本**填进 remove.id → 按 id 严格过滤查无 → 静默不删,
  // 而同回合回话已说「已经撤了」= 假成功。兜底只在 id 未命中时生效,且宁缺毋滥
  // (仅唯一命中才删;多命中/0 命中都不删,并在 details 里给出 reason)。
  // ==========================================================================

  it('A13-1 id 精确命中 → 删,matchedBy=id(原路径行为不变)', () => {
    const memory = seedNotes([{ id: 'm1', text: '喜好A' }, { id: 'm2', text: '喜好B' }]);
    const { memory: out, applied, details } = applyMemoryOps(memory, [{ op: 'remove', id: 'm1' }], 40, 2000);
    expect(applied).toBe(1);
    expect(out.notes.map((n) => n.id)).toEqual(['m2']);
    expect(details).toEqual([{ op: 'remove', applied: true, id: 'm1', matchedBy: 'id' }]);
  });

  it('A13-2 id 未命中 + 文本精确唯一(归一化:空白折叠/大小写)→ 删,matchedBy=text', () => {
    const memory = seedNotes([{ id: 'm1', text: '老板喜欢简洁汇报' }, { id: 'm2', text: '以后用中文' }]);
    const { memory: out, applied, details } = applyMemoryOps(
      memory,
      [{ op: 'remove', id: '  老板喜欢简洁汇报  ' }],
      40,
      2000,
    );
    expect(applied).toBe(1);
    expect(out.notes.map((n) => n.id)).toEqual(['m2']);
    expect(details).toEqual([{ op: 'remove', applied: true, id: '  老板喜欢简洁汇报  ', matchedBy: 'text' }]);

    const latin = seedNotes([{ id: 'm1', text: 'Use JSON' }]);
    const { applied: a2 } = applyMemoryOps(latin, [{ op: 'remove', id: 'use   json' }], 40, 2000);
    expect(a2).toBe(1);
  });

  it('A13-3 id 未命中 + 双向包含唯一 → 删(两个方向都覆盖)', () => {
    // 方向一:笔记文本包含该串(模型截取片段)
    const a = seedNotes([{ id: 'm1', text: '老板要求汇报先说结论再展开' }, { id: 'm2', text: '无关条目' }]);
    const r1 = applyMemoryOps(a, [{ op: 'remove', id: '先说结论' }], 40, 2000);
    expect(r1.applied).toBe(1);
    expect(r1.memory.notes.map((n) => n.id)).toEqual(['m2']);
    expect(r1.details[0]).toMatchObject({ applied: true, matchedBy: 'text' });
    // 方向二:该串包含笔记文本(模型带上了前后缀)
    const b = seedNotes([{ id: 'm1', text: '先说结论' }, { id: 'm2', text: '无关条目' }]);
    const r2 = applyMemoryOps(b, [{ op: 'remove', id: '就是提醒你一下,先说结论,别的没了' }], 40, 2000);
    expect(r2.applied).toBe(1);
    expect(r2.memory.notes.map((n) => n.id)).toEqual(['m2']);
    expect(r2.details[0]).toMatchObject({ applied: true, matchedBy: 'text' });
  });

  it('A13-4 文本兜底 0 命中 → 不删,reason=not_found(原对象返回)', () => {
    const memory = seedNotes([{ id: 'm1', text: '老板喜欢简洁' }]);
    const { memory: out, applied, details } = applyMemoryOps(memory, [{ op: 'remove', id: '压根不存在的内容' }], 40, 2000);
    expect(applied).toBe(0);
    expect(out).toBe(memory);
    expect(details).toEqual([{ op: 'remove', applied: false, id: '压根不存在的内容', reason: 'not_found' }]);
  });

  it('A13-5 文本多命中(精确重复 / 包含多义)→ 都不删,reason=ambiguous', () => {
    // 两条完全同文 → 精确多命中
    const dup = seedNotes([{ id: 'm1', text: '叫我老板' }, { id: 'm2', text: '叫我老板' }]);
    const r1 = applyMemoryOps(dup, [{ op: 'remove', id: '叫我老板' }], 40, 2000);
    expect(r1.applied).toBe(0);
    expect(r1.memory.notes).toHaveLength(2);
    expect(r1.details).toEqual([{ op: 'remove', applied: false, id: '叫我老板', reason: 'ambiguous' }]);
    // 一个片段包含于多条 → 包含多命中
    const loose = seedNotes([{ id: 'm1', text: '老板喜欢简洁汇报' }, { id: 'm2', text: '老板喜欢用中文' }]);
    const r2 = applyMemoryOps(loose, [{ op: 'remove', id: '老板喜欢' }], 40, 2000);
    expect(r2.applied).toBe(0);
    expect(r2.memory.notes).toHaveLength(2);
    expect(r2.details[0]).toMatchObject({ applied: false, reason: 'ambiguous' });
  });

  it('A13-6 空串/纯空白 id → 不触发兜底,不动任何笔记,reason=empty_id', () => {
    const memory = seedNotes([{ id: 'm1', text: '老板喜欢简洁' }]);
    for (const id of ['', '   ']) {
      const { memory: out, applied, details } = applyMemoryOps(memory, [{ op: 'remove', id }], 40, 2000);
      expect(applied).toBe(0);
      expect(out).toBe(memory);
      expect(details).toEqual([{ op: 'remove', applied: false, id, reason: 'empty_id' }]);
    }
  });

  it('A13-7 极短 id(<2 字符)只做精确匹配,不做包含', () => {
    // 'a' 是 'a计划' 的子串,但短串禁用包含 → 不删
    const memory = seedNotes([{ id: 'm1', text: 'a计划' }]);
    const r1 = applyMemoryOps(memory, [{ op: 'remove', id: 'a' }], 40, 2000);
    expect(r1.applied).toBe(0);
    expect(r1.memory.notes).toHaveLength(1);
    expect(r1.details[0]).toMatchObject({ applied: false, reason: 'not_found' });
    // 精确匹配(归一化后相等)仍生效
    const exact = seedNotes([{ id: 'm1', text: 'A' }]);
    const r2 = applyMemoryOps(exact, [{ op: 'remove', id: 'a' }], 40, 2000);
    expect(r2.applied).toBe(1);
    expect(r2.details[0]).toMatchObject({ applied: true, matchedBy: 'text' });
  });

  it('A13-8 id 精确命中时绝不触发文本匹配(不误删同文本的其它条)', () => {
    const memory = seedNotes([{ id: 'alpha', text: '甲' }, { id: 'beta', text: 'alpha' }]);
    const { memory: out, applied, details } = applyMemoryOps(memory, [{ op: 'remove', id: 'alpha' }], 40, 2000);
    expect(applied).toBe(1);
    expect(out.notes.map((n) => n.id)).toEqual(['beta']); // 删的是 id=alpha,不是 text=alpha 的 beta
    expect(details[0]).toMatchObject({ applied: true, matchedBy: 'id' });
  });

  it('A13-9 整行「- [id] 文本」:[] 内是原 id → 按 id 删;[] 不是 id → 用剩余文本兜底', () => {
    const memory = seedNotes([{ id: 'm1', text: '老板喜欢简洁' }, { id: 'm2', text: '以后用中文' }]);
    const r1 = applyMemoryOps(memory, [{ op: 'remove', id: '- [m1] 老板喜欢简洁' }], 40, 2000);
    expect(r1.applied).toBe(1);
    expect(r1.memory.notes.map((n) => n.id)).toEqual(['m2']);
    expect(r1.details[0]).toMatchObject({ applied: true, matchedBy: 'id' });
    const r2 = applyMemoryOps(memory, [{ op: 'remove', id: '- [已失效的id] 以后用中文' }], 40, 2000);
    expect(r2.applied).toBe(1);
    expect(r2.memory.notes.map((n) => n.id)).toEqual(['m1']);
    expect(r2.details[0]).toMatchObject({ applied: true, matchedBy: 'text' });
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

describe('isContextCompactionDue — 任务39 轮换阈值提前', () => {
  function cfgWith(over: Partial<VoiceCompanionServerConfig>): VoiceCompanionServerConfig {
    return { ...DEFAULT_SERVER_CONFIG, ...over };
  }
  /** 造一个「窗口 200K、占用 proportional percent」的 context 快照。 */
  function stateAtPercent(percent: number, tokensUsed?: number): VoiceCompanionState {
    const windowTokens = 200_000;
    return {
      ...emptyState(),
      sessionId: 's1',
      context: {
        tokensUsed: tokensUsed ?? Math.round(windowTokens * percent),
        windowTokens,
        percent,
        updatedAt: 0,
      },
    };
  }

  it('缺省阈值钉死为 0.3 = 60K@200K,绝对闸口缺省关', () => {
    expect(DEFAULT_SERVER_CONFIG.contextCompactPercent).toBe(0.3);
    expect(DEFAULT_SERVER_CONFIG.contextCompactTokens).toBe(0);
  });

  it('无会话 / 无快照 → 不轮换(哪怕 percent 高)', () => {
    expect(isContextCompactionDue({ ...emptyState(), context: stateAtPercent(0.9).context }, DEFAULT_SERVER_CONFIG)).toBe(false);
    expect(isContextCompactionDue({ ...emptyState(), sessionId: 's1' }, DEFAULT_SERVER_CONFIG)).toBe(false);
  });

  it('percent 边界:0.29 不触发,0.30 触发(含等号)', () => {
    expect(isContextCompactionDue(stateAtPercent(0.29), DEFAULT_SERVER_CONFIG)).toBe(false);
    expect(isContextCompactionDue(stateAtPercent(0.3), DEFAULT_SERVER_CONFIG)).toBe(true);
  });

  it('实测事故档 55.8% 现在会触发(旧缺省 0.8 永远不会)', () => {
    const state = stateAtPercent(0.5583, 111_660);
    expect(isContextCompactionDue(state, DEFAULT_SERVER_CONFIG)).toBe(true);
    expect(isContextCompactionDue(state, cfgWith({ contextCompactPercent: 0.8 }))).toBe(false);
  });

  it('绝对闸口:>0 时按 tokensUsed 触发,与 percent 取或', () => {
    const cfg = cfgWith({ contextCompactTokens: 60_000 });
    // 大窗口(1M)下 percent 远不到 0.3,但绝对量越过 60K → 触发。
    const bigWindow: VoiceCompanionState = {
      ...emptyState(),
      sessionId: 's1',
      context: { tokensUsed: 60_000, windowTokens: 1_000_000, percent: 0.06, updatedAt: 0 },
    };
    expect(isContextCompactionDue(bigWindow, cfg)).toBe(true);
    expect(isContextCompactionDue({ ...bigWindow, context: { ...bigWindow.context!, tokensUsed: 59_999 } }, cfg)).toBe(false);
  });

  it('绝对闸口缺省 0 = 关(percent 未到就不触发)', () => {
    // 2M 窗口、99.9 万 token(percent 0.4995 < 0.95):percent 分支不触发。
    const state: VoiceCompanionState = {
      ...emptyState(),
      sessionId: 's1',
      context: { tokensUsed: 999_000, windowTokens: 2_000_000, percent: 0.4995, updatedAt: 0 },
    };
    expect(isContextCompactionDue(state, cfgWith({ contextCompactPercent: 0.95 }))).toBe(false);
    expect(isContextCompactionDue(state, cfgWith({ contextCompactPercent: 0.95, contextCompactTokens: 500_000 }))).toBe(true);
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

  it('注入首句短化条款(W2 感知提速:开口第一句 ≤12 字先应声)', () => {
    const prompt = buildCompanionSystemPrompt(base());
    expect(prompt).toContain('开口第一句必须短(≤12 字,先应声');
    expect(prompt).toContain('第二句起再展开');
  });

  it('时间不再写进系统提示词(resume 冻结会停走,真麦答错 20 分钟),改为回合注入用户消息', () => {
    const prompt = buildCompanionSystemPrompt(base());
    // 具体时间戳(/【当前时间】2026-…/)不得出现在系统提示词;注记里对该标记的引用不算
    expect(prompt).not.toMatch(/【当前时间】\s*\d/);
    expect(prompt).toContain('【时间注记】');
  });
});

describe('buildCompanionSystemPrompt — 任务39·F4 上段会话交接渲染(U4)', () => {
  const now = Date.now();
  const note: HandoffNote = { text: '在聊订单同步,等 A 方案结果', forSessionId: 's-old', at: now };
  const base = (memory: CompanionMemory, currentSessionId?: string | null) => ({
    agentLines: [] as string[], totalAgents: 0, truncated: false, memory, currentSessionId,
  });

  it('新会话(不同 sessionId)→ 渲染【上段会话交接】,文本原样', () => {
    const prompt = buildCompanionSystemPrompt(base({ ...emptyMemory(), handoff: note }, 's-new'));
    expect(prompt).toContain('【上段会话交接】(自动生成,可能不全)\n在聊订单同步,等 A 方案结果');
  });

  it('当前会话不渲染自己的笔记(forSessionId === currentSessionId)', () => {
    const prompt = buildCompanionSystemPrompt(base({ ...emptyMemory(), handoff: note }, 's-old'));
    expect(prompt).not.toContain('上段会话交接');
  });

  it('超过 72h 不渲染', () => {
    const stale = { ...note, at: now - HANDOFF_TTL_MS - 1 };
    const prompt = buildCompanionSystemPrompt(base({ ...emptyMemory(), handoff: stale }, 's-new'));
    expect(prompt).not.toContain('上段会话交接');
  });

  it('TC_VOICE_HANDOFF=0:有笔记也不渲染,且与无笔记提示词逐字节一致(回退档)', () => {
    vi.stubEnv('TC_VOICE_HANDOFF', '0');
    const withNote = buildCompanionSystemPrompt(base({ ...emptyMemory(), handoff: note }, 's-new'));
    const without = buildCompanionSystemPrompt(base(emptyMemory(), 's-new'));
    expect(withNote).not.toContain('上段会话交接');
    expect(withNote).toBe(without);
  });

  it('无 handoff(旧状态文件)时输出与接入前逐字节一致:显式 null 与缺字段同观感', () => {
    const missing = buildCompanionSystemPrompt(base(emptyMemory(), 's-new'));
    const explicitNull = buildCompanionSystemPrompt(base({ ...emptyMemory(), handoff: null }, 's-new'));
    expect(explicitNull).toBe(missing);
    expect(missing).toContain('【长期记忆】\n(暂无)'); // 空记忆仍是 '(暂无)' 分支
    expect(missing).not.toContain('上段会话交接');
  });
});

describe('buildCompanionSystemPrompt — 三态边界与派活路径(改①)', () => {
  const base = () => ({
    agentLines: ['- 大当家 | id: b1 | boss | idle [BOSS]', '- 小美 | id: a1 | builder | working'],
    totalAgents: 2,
    truncated: false,
    memory: emptyMemory(),
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

  it('指人容噪(真麦「主管 a」教训):近似名直接办,拿不准立即反问并列候选,禁止反复权衡', () => {
    const prompt = buildCompanionSystemPrompt(base());
    expect(prompt).toContain('【指人与转写噪声(重要)】');
    expect(prompt).toContain('按最接近的候选理解');
    expect(prompt).toContain('立即用一句话反问');
    expect(prompt).toContain('候选列出来让老板点');
  });

  it('裁决预算(C20 防过度思考):同一处歧义只裁决一次、禁止换角度复检;乱码一次成形;注入类一句拒绝不展开', () => {
    const prompt = buildCompanionSystemPrompt(base());
    expect(prompt).toContain('【裁决预算(重要)】');
    expect(prompt).toContain('只裁决一次');
    expect(prompt).toContain('重复琢磨');
    expect(prompt).toContain('一次性成形');
    expect(prompt).toContain('一句话拒绝或确认,不展开分析');
    // 噪声例补充:C20 加的句首噪声示例
    expect(prompt).toContain('多半是转写噪声,不是假设句');
    // C24 零对象指令(「看一下。」69s 事故):没对象就一句最短反问,不穷举
    expect(prompt).toContain('零对象指令');
    expect(prompt).toContain('立即用一句最短反问');
    expect(prompt).toContain('不猜、不穷举可能性');
    // HC-B1 无指认对象必须澄清(#1081/#1092 裸「收到。」):对象对不上号时不许空 ack 蒙混
    expect(prompt).toContain('对不上号');
    expect(prompt).toContain('不许用「收到。」「好。」这类空应声蒙混');
    expect(prompt).toContain('零动作的空 ack 最误导');
  });

  it('会话记忆如实(H6-2 防编造):「刚才说到哪了」只依据真实素材,无素材如实说没带上', () => {
    const prompt = buildCompanionSystemPrompt(base());
    expect(prompt).toContain('【会话记忆如实】');
    expect(prompt).toContain('如实说这轮没带上、请老板起个头');
    expect(prompt).toContain('绝不编造「最近话题」或没发生过的约定');
  });

  it('系统事件定界标记为不可口述的 ⟦系统事件⟧,且明示语音转写不会产生它(任务35 协议安全化)', () => {
    const prompt = buildCompanionSystemPrompt(base());
    expect(prompt).toContain('noop: 输入以 ⟦系统事件⟧ 开头');
    expect(prompt).toContain('语音转写永远不会产生它');
    // 旧普通文本标记不得回潮:它曾被老板口语命中即触发误判静默
    expect(prompt).not.toContain('[系统事件]');
  });

  it('派活话术不收事后回报空诺(W10 期中② 收口:完成提醒归主动汇报通道)', () => {
    const prompt = buildCompanionSystemPrompt(base());
    expect(prompt).toContain('不要追加「我盯着」「办好了马上回你」这类事后回报承诺');
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
      agentLines: [], totalAgents: 0, truncated: false, memory: emptyMemory(),
    });
    expect(prompt).toContain('"query":"","bolbaTask":""');
    for (const action of BOLBA_ACTIONS) expect(prompt).toContain(`${action}: `);
    expect(prompt).toContain('业务待办(报价/付款/会议/证书/盯人盯事)走 Bolba 四动作');
    expect(prompt).toContain('绝不混账');
    // 业务动作不得写进派活说明区(两本账不混)
    expect(prompt).toContain('agent 的活(写代码/改 bug/推进项目)走 delegate_to_boss');
  });
});
