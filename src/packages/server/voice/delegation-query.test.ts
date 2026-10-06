/**
 * 任务07·④ 查进度走下属 —— query 链路纯函数单测(验收 ⑥1)。
 *
 * 覆盖:
 *   - 路由判定:目标为 Boss 触发委派树解析,普通 agent / 无目标行为边界;
 *   - 委派树解析:只取最近 N 条、同一下属去重;
 *   - 材料拼接三分支:有产出 / 无产出(working 与 idle)/ 无委派;
 *   - 体积护栏:多下属汇总不超预算;
 *   - 🔴观测点④ 查询链路事件字段;
 *   - excerpt 对下属取 assistant 产出的护栏行为(6 条 / 400 字每条 / 1500 字总量,§8.1)。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DELEGATION_MATERIAL_BUDGET,
  DELEGATION_QUERY_MAX,
  DELEGATION_SINGLE_AGENT_MAX,
  DELEGATION_TASK_TRUNCATE,
  buildDelegationQueryMaterial,
  buildNoDelegationResponse,
  buildQueryChainLogBody,
  buildSingleAgentQueryMaterial,
  formatDelegationDuration,
  hasSubstantiveOutput,
  pickRecentAgentDelegations,
  pickRecentDelegations,
  planQueryRoute,
  type SubordinateQueryEntry,
} from './delegation-query.js';
import type { DelegationCompletion, DelegationDecision, TaskCard } from '../../shared/agent-types.js';
// excerpt 护栏用例:mock agent-service(按 agentId 提供历史)后,复用 vcs 的真实取数护栏。
import { fetchAgentOutputExcerpt } from '../services/voice-companion-service.js';

const agentHistoryMock = vi.hoisted(() => ({
  byAgent: new Map<string, Array<{ type: string; content: string }>>(),
}));

vi.mock('../services/agent-service.js', () => ({
  getAgentHistory: async (id: string) => ({ messages: agentHistoryMock.byAgent.get(id) ?? [] }),
}));

let decisionSeq = 0;

function decision(overrides: {
  selectedAgentId?: string;
  selectedAgentName?: string;
  userCommand?: string;
  timestamp?: number;
  taskCard?: TaskCard;
} = {}): DelegationDecision {
  decisionSeq += 1;
  return {
    id: `del-${decisionSeq}`,
    timestamp: overrides.timestamp ?? 1_000,
    bossId: 'b1',
    userCommand: overrides.userCommand ?? '把登录页重构成 React 18',
    selectedAgentId: overrides.selectedAgentId ?? 'a1',
    selectedAgentName: overrides.selectedAgentName ?? '小美',
    reasoning: 'fixture',
    alternativeAgents: [],
    confidence: 'high',
    status: 'sent',
    taskCard: overrides.taskCard,
  };
}

function entry(overrides: Partial<SubordinateQueryEntry> = {}): SubordinateQueryEntry {
  return {
    agentId: 'a1',
    agentName: '小美',
    status: 'idle',
    userCommand: '把登录页重构成 React 18',
    excerpt: '完成了登录页,又修了一个 bug',
    ...overrides,
  };
}

// ============================================================================
// 路由判定(验收 ⑥1:目标是 Boss → 委派树)
// ============================================================================

describe('planQueryRoute — Boss 触发委派树', () => {
  it('Boss 类(isBoss 或 class==="boss")→ boss-tree', () => {
    expect(planQueryRoute({ isBoss: true })).toBe('boss-tree');
    expect(planQueryRoute({ class: 'boss' })).toBe('boss-tree');
  });

  it('普通 agent → single-agent(行为不变);目标缺失 → no-target', () => {
    expect(planQueryRoute({ class: 'builder', isBoss: false })).toBe('single-agent');
    expect(planQueryRoute({})).toBe('single-agent');
    expect(planQueryRoute(undefined)).toBe('no-target');
  });
});

// ============================================================================
// 委派树解析:只查最近委派
// ============================================================================

describe('pickRecentDelegations — 最近 N 条 + 按下属去重', () => {
  it('按时间倒序取最近 N 条(缺省口径与任务06一致)', () => {
    const history = Array.from({ length: 8 }, (_, i) => decision({
      selectedAgentId: `a${i}`,
      selectedAgentName: `下属${i}`,
      timestamp: 1_000 + i,
    }));
    const picked = pickRecentDelegations(history);
    expect(picked).toHaveLength(DELEGATION_QUERY_MAX);
    expect(picked[0]!.timestamp).toBe(1_007);
    expect(picked.map((d) => d.selectedAgentId)).toEqual(['a7', 'a6', 'a5', 'a4', 'a3']);
  });

  it('同一下属的多次委派只保留最近一条(更早任务已过时)', () => {
    const history = [
      decision({ selectedAgentId: 'a1', selectedAgentName: '小美', userCommand: '旧任务', timestamp: 1_000 }),
      decision({ selectedAgentId: 'a2', selectedAgentName: '阿强', userCommand: '阿强的活', timestamp: 2_000 }),
      decision({ selectedAgentId: 'a1', selectedAgentName: '小美', userCommand: '新任务', timestamp: 3_000 }),
    ];
    const picked = pickRecentDelegations(history);
    expect(picked.map((d) => d.userCommand)).toEqual(['新任务', '阿强的活']);
  });

  it('不修改输入数组(纯函数)', () => {
    const history = [
      decision({ selectedAgentId: 'a1', timestamp: 1_000 }),
      decision({ selectedAgentId: 'a2', timestamp: 2_000 }),
    ];
    const before = history.map((d) => d.id);
    pickRecentDelegations(history);
    expect(history.map((d) => d.id)).toEqual(before);
  });
});

// ============================================================================
// B(2026-10-07):单 agent 查询 —— 该 agent 自己的记录(不去重)+ 病历段材料
// ============================================================================

describe('pickRecentAgentDelegations — 单 agent 记录(新→旧,限 3,不去重)', () => {
  it('只取该 agent 的记录,按时间倒序,缺省最多 3 条', () => {
    const history = [
      decision({ selectedAgentId: 'a1', userCommand: '甲任务', timestamp: 1_000 }),
      decision({ selectedAgentId: 'a2', userCommand: '别人的活', timestamp: 2_000 }),
      decision({ selectedAgentId: 'a1', userCommand: '乙任务', timestamp: 3_000 }),
      decision({ selectedAgentId: 'a1', userCommand: '丙任务', timestamp: 4_000 }),
      decision({ selectedAgentId: 'a1', userCommand: '丁任务', timestamp: 5_000 }),
    ];
    const picked = pickRecentAgentDelegations(history, 'a1');
    expect(picked).toHaveLength(DELEGATION_SINGLE_AGENT_MAX);
    expect(picked.map((d) => d.userCommand)).toEqual(['丁任务', '丙任务', '乙任务']);
  });

  it('同一 agent 的连续任务不去重(与 pickRecentDelegations 的关键区别);不修改输入', () => {
    const history = [
      decision({ selectedAgentId: 'a1', userCommand: '旧活', timestamp: 1_000 }),
      decision({ selectedAgentId: 'a1', userCommand: '新活', timestamp: 2_000 }),
    ];
    const before = history.map((d) => d.id);
    const picked = pickRecentAgentDelegations(history, 'a1');
    expect(picked.map((d) => d.userCommand)).toEqual(['新活', '旧活']);
    expect(history.map((d) => d.id)).toEqual(before);
  });

  it('无该 agent 记录 → 空数组(调用方走原始 excerpt 兜底)', () => {
    expect(pickRecentAgentDelegations([decision({ selectedAgentId: 'a9' })], 'a1')).toEqual([]);
  });
});

// ============================================================================
// 材料拼接:三分支
// ============================================================================

describe('buildDelegationQueryMaterial — 下属行拼接', () => {
  it('有产出:任务取任务卡目标(优先),附该下属 excerpt', () => {
    const material = buildDelegationQueryMaterial({
      bossName: '大当家',
      entries: [entry({ taskCardObjective: '登录页重构', excerpt: '完成了登录页' })],
    });
    expect(material).toContain('主管「大当家」');
    expect(material).toContain('【小美】任务「登录页重构」');
    expect(material).toContain('完成了登录页');
  });

  it('无卡:任务回退委派原话;超长截断', () => {
    const longCommand = '把登录页重构成 React 18 并补齐测试'.repeat(5);
    const material = buildDelegationQueryMaterial({
      bossName: '大当家',
      entries: [entry({ userCommand: longCommand, excerpt: 'done' })],
    });
    expect(material).toContain(`「${longCommand.slice(0, DELEGATION_TASK_TRUNCATE)}…」`);
    expect(material).not.toContain(longCommand);
  });

  it('无产出 + working:输出「正在做 Y,暂无实质进展」(Y=任务卡目标)', () => {
    const material = buildDelegationQueryMaterial({
      bossName: '大当家',
      entries: [entry({ status: 'working', taskCardObjective: '改造接口层', excerpt: '(最近没有助手输出)' })],
    });
    expect(material).toContain('【小美】正在做「改造接口层」,暂无实质进展');
  });

  it('无产出 + working + 无卡:「正在做 Y」回退委派原话(占位串不当作产出)', () => {
    const material = buildDelegationQueryMaterial({
      bossName: '大当家',
      entries: [entry({ status: 'working', userCommand: '把接口层改一下', excerpt: '(没有可用的会话记录)' })],
    });
    expect(material).toContain('【小美】正在做「把接口层改一下」,暂无实质进展');
    expect(material).not.toContain('(没有可用的会话记录)');
  });

  it('无产出 + 非 working:如实说暂无实质产出记录', () => {
    const material = buildDelegationQueryMaterial({
      bossName: '大当家',
      entries: [entry({ status: 'idle', excerpt: '' })],
    });
    expect(material).toContain('状态 idle');
    expect(material).toContain('暂无实质产出记录');
    expect(material).not.toContain('正在做');
  });

  it('无委派记录(entries 为空):确定性「未找到对应委派」', () => {
    const expected = buildNoDelegationResponse('大当家');
    expect(buildDelegationQueryMaterial({ bossName: '大当家', entries: [] })).toBe(expected);
    expect(expected).toContain('未找到对应委派');
    expect(expected).toContain('大当家');
  });

  it('多下属汇总受总量护栏约束(每段 excerpt 按份额截断)', () => {
    const entries = Array.from({ length: DELEGATION_QUERY_MAX }, (_, i) => entry({
      agentId: `a${i}`,
      agentName: `下属${i}`,
      userCommand: `任务${i}`,
      excerpt: 'x'.repeat(1_500), // fetchAgentOutputExcerpt 单下属上限
    }));
    const material = buildDelegationQueryMaterial({ bossName: '大当家', entries });
    expect(material.length).toBeLessThanOrEqual(DELEGATION_MATERIAL_BUDGET);
    // 新→旧顺序即入参顺序,每段都保留(头部不下沉)
    for (let i = 0; i < entries.length; i++) expect(material).toContain(`下属${i}`);
  });
});

// ============================================================================
// B(2026-10-07):单 agent 查询材料 —— 病历段(条目格式与 boss-tree 同款)
// ============================================================================

describe('buildSingleAgentQueryMaterial — 单 agent 病历段', () => {
  it('有病历:完成行(执行者/耗时/产出);标题指向该 agent 的任务记录', () => {
    const material = buildSingleAgentQueryMaterial({
      agentName: '小刘',
      entries: [entry({
        agentName: '小刘',
        userCommand: '查一下服务器的系统情况',
        excerpt: '',
        completion: { completedAt: 2_000_000, durationMs: 91_612, result: 'completed', summary: 'CPU 正常,内存 62%' },
      })],
    });
    expect(material).toContain('以下为「小刘」最近被委派的任务记录(新→旧,共 1 条):');
    expect(material).toContain('【小刘】任务「查一下服务器的系统情况」已完成（耗时 1.5 分钟）');
    expect(material).toContain('产出: CPU 正常,内存 62%');
  });

  it('无病历:在办看进度(正在做行)、有产出看产出(与 boss-tree 同款三分支)', () => {
    const material = buildSingleAgentQueryMaterial({
      agentName: '小美',
      entries: [
        entry({ userCommand: '在办的任务', status: 'working', excerpt: '(没有可用的会话记录)' }),
        entry({ userCommand: '旧任务', excerpt: '登录页改成 React 18 了' }),
      ],
    });
    expect(material).toContain('【小美】正在做「在办的任务」,暂无实质进展');
    expect(material).toContain('【小美】任务「旧任务」');
    expect(material).toContain('登录页改成 React 18 了');
  });

  it('entries 为空 → 空串(调用方回退原始 excerpt 兜底,行为不变)', () => {
    expect(buildSingleAgentQueryMaterial({ agentName: '小美', entries: [] })).toBe('');
  });

  it('体积护栏:多条长产出不超 DELEGATION_MATERIAL_BUDGET,各段头保留', () => {
    const entries = Array.from({ length: DELEGATION_SINGLE_AGENT_MAX }, (_, i) => entry({
      userCommand: `任务${i}`,
      excerpt: 'x'.repeat(1_500),
    }));
    const material = buildSingleAgentQueryMaterial({ agentName: '小美', entries });
    expect(material.length).toBeLessThanOrEqual(DELEGATION_MATERIAL_BUDGET);
    for (let i = 0; i < entries.length; i++) expect(material).toContain(`任务${i}`);
  });
});

// ============================================================================
// ⑧ 病历完成行（任务11）：有 completion → 执行者/耗时/产出；无 → 原三分支不变
// ============================================================================

describe('buildDelegationQueryMaterial — ⑧ 病历完成行（任务11）', () => {
  const completion = (overrides: Partial<DelegationCompletion> = {}): DelegationCompletion => ({
    completedAt: 2_000_000,
    durationMs: 750_000, // 12.5 分钟
    result: 'completed',
    ...overrides,
  });

  it('已完成：执行者/耗时/产出/产出位置/评价齐全；优先于 excerpt 三分支（working 也不说「正在做」）', () => {
    const material = buildDelegationQueryMaterial({
      bossName: '大当家',
      entries: [entry({
        status: 'working',
        excerpt: '', // 无产出也不得回退「正在做」分支
        completion: completion({ summary: '登录页重构完成，测试全绿', outputLocation: '/reports/login.md' }),
        userRating: 'satisfied',
      })],
    });
    expect(material).toContain('【小美】任务「把登录页重构成 React 18」已完成（耗时 12.5 分钟）');
    expect(material).toContain('产出: 登录页重构完成，测试全绿');
    expect(material).toContain('产出位置: /reports/login.md');
    expect(material).toContain('评价: 满意');
    expect(material).not.toContain('正在做');
  });

  it('执行失败：明确说失败，不冒充已完成；不满意评价照常显示', () => {
    const material = buildDelegationQueryMaterial({
      bossName: '大当家',
      entries: [entry({
        completion: completion({ result: 'failed', durationMs: 30_000, summary: '接口联调未通过' }),
        userRating: 'unsatisfied',
      })],
    });
    expect(material).toContain('执行失败（耗时 30 秒）');
    expect(material).not.toContain('已完成');
    expect(material).toContain('评价: 不满意');
  });

  it('病历无摘要（runtime 入口先到）：回退该下属最近产出为产出', () => {
    const material = buildDelegationQueryMaterial({
      bossName: '大当家',
      entries: [entry({
        excerpt: '已经改完登录页并跑了测试',
        completion: completion(),
      })],
    });
    expect(material).toContain('已完成（耗时 12.5 分钟）');
    expect(material).toContain('产出:\n已经改完登录页并跑了测试');
  });

  it('病历无摘要且无产出：只报完成态，不编造产出、不显示「正在做」', () => {
    const material = buildDelegationQueryMaterial({
      bossName: '大当家',
      entries: [entry({
        status: 'working',
        excerpt: '(最近没有助手输出)',
        completion: completion(),
      })],
    });
    expect(material).toContain('已完成（耗时 12.5 分钟）');
    expect(material).not.toContain('产出:');
    expect(material).not.toContain('产出位置');
    expect(material).not.toContain('正在做');
  });

  it('无 completion 的旧记录：原三分支不变（负断言无完成话术）', () => {
    const material = buildDelegationQueryMaterial({
      bossName: '大当家',
      entries: [entry({ status: 'idle', excerpt: '' })],
    });
    expect(material).not.toContain('已完成');
    expect(material).not.toContain('耗时');
    expect(material).toContain('暂无实质产出记录');
  });

  it('完成行摘要受份额截断，多下属总量不超预算', () => {
    const entries = Array.from({ length: DELEGATION_QUERY_MAX }, (_, i) => entry({
      agentId: `a${i}`,
      agentName: `下属${i}`,
      userCommand: `任务${i}`,
      excerpt: '',
      completion: completion({ summary: 'x'.repeat(2_000) }),
    }));
    const material = buildDelegationQueryMaterial({ bossName: '大当家', entries });
    expect(material.length).toBeLessThanOrEqual(DELEGATION_MATERIAL_BUDGET);
    for (let i = 0; i < entries.length; i++) expect(material).toContain(`下属${i}`);
  });
});

describe('formatDelegationDuration — ⑧ 耗时展示口径', () => {
  it('小于 1 分钟用秒；其余保留 1 位小数分钟；负值（时钟回拨）钳 0', () => {
    expect(formatDelegationDuration(0)).toBe('0 秒');
    expect(formatDelegationDuration(45_000)).toBe('45 秒');
    expect(formatDelegationDuration(60_000)).toBe('1 分钟');
    expect(formatDelegationDuration(750_000)).toBe('12.5 分钟');
    // 注意用大负值：-5ms 会 Math.round 成 -0（模板串即 "0"），测不出钳位；-90_000 去钳位会得 '-90 秒'
    expect(formatDelegationDuration(-90_000)).toBe('0 秒');
  });
});

describe('hasSubstantiveOutput — 产出判定', () => {
  it('占位串/空白 = 无产出;真实文本 = 有产出', () => {
    expect(hasSubstantiveOutput('(没有可用的会话记录)')).toBe(false);
    expect(hasSubstantiveOutput('(最近没有助手输出)')).toBe(false);
    expect(hasSubstantiveOutput('  ')).toBe(false);
    expect(hasSubstantiveOutput('完成了登录页')).toBe(true);
  });
});

// ============================================================================
// 🔴 观测点④ 查询链路事件字段
// ============================================================================

describe('buildQueryChainLogBody — 🔴④ 查询链路字段', () => {
  it('Boss 树完成:请求/路由/下属/hop/耗时/摘要齐全', () => {
    const body = buildQueryChainLogBody({
      phase: 'completed',
      request: '团队那个任务到哪了',
      route: 'boss-tree',
      targetAgentId: 'b1',
      targetName: '大当家',
      subordinateIds: ['a1', 'a2'],
      hops: 2,
      durationMs: 1_234,
      responsePreview: '小美完成了登录页',
    });
    expect(body).toEqual({
      cat: 'query-chain',
      phase: 'completed',
      request: '团队那个任务到哪了',
      route: 'boss-tree',
      targetAgentId: 'b1',
      targetName: '大当家',
      subordinateIds: ['a1', 'a2'],
      subordinateCount: 2,
      hops: 2,
      durationMs: 1_234,
      responsePreview: '小美完成了登录页',
    });
  });

  it('降级路径:degraded + error 落盘;request 入口事件可只带路由字段', () => {
    const failed = buildQueryChainLogBody({
      phase: 'failed',
      request: '团队任务进展',
      route: 'single-agent',
      targetAgentId: 'a1',
      hops: 2,
      durationMs: 900,
      degraded: true,
      error: 'hop2 empty response',
    });
    expect(failed.phase).toBe('failed');
    expect(failed.degraded).toBe(true);
    expect(failed.error).toBe('hop2 empty response');

    const request = buildQueryChainLogBody({ phase: 'request', request: '查一下', route: 'no-target' });
    expect(request).toEqual({ cat: 'query-chain', phase: 'request', request: '查一下', route: 'no-target' });
  });
});

// ============================================================================
// excerpt 护栏(对下属取 assistant 产出的行为,§8.1:6 条 / 400 字每条 / 1500 字总量)
// ============================================================================

describe('fetchAgentOutputExcerpt — 下属产出的护栏行为', () => {
  it('只取 assistant 消息;条多时截取最近 6 条', async () => {
    agentHistoryMock.byAgent.set('sub-a', [
      ...Array.from({ length: 8 }, (_, i) => ({ type: 'assistant', content: `产出-${i}` })),
      { type: 'user', content: '用户消息不应出现' },
    ]);
    const excerpt = await fetchAgentOutputExcerpt('sub-a');
    expect(excerpt).toContain('产出-7');
    expect(excerpt).toContain('产出-2');
    expect(excerpt).not.toContain('产出-1'); // 第 7 新(上限 6 条)
    expect(excerpt).not.toContain('产出-0');
    expect(excerpt).not.toContain('用户消息不应出现');
  });

  it('总量 1500 字护栏:超出即停(未取满条数)', async () => {
    agentHistoryMock.byAgent.set('sub-b', Array.from({ length: 6 }, () => ({
      type: 'assistant',
      content: 'y'.repeat(400),
    })));
    const excerpt = await fetchAgentOutputExcerpt('sub-b');
    expect(excerpt.split('\n---\n')).toHaveLength(3); // 400×3=1200,第 4 条会超 1500
    expect(excerpt.length).toBeLessThanOrEqual(1_500 + 2 * '\n---\n'.length);
  });

  it('没有历史 / 没有 assistant 输出:返回占位串(材料层按无产出处理)', async () => {
    agentHistoryMock.byAgent.set('sub-empty', []);
    agentHistoryMock.byAgent.set('sub-user-only', [{ type: 'user', content: '只有用户消息' }]);
    expect(await fetchAgentOutputExcerpt('sub-empty')).toBe('(没有可用的会话记录)');
    expect(await fetchAgentOutputExcerpt('sub-user-only')).toBe('(最近没有助手输出)');
    expect(hasSubstantiveOutput(await fetchAgentOutputExcerpt('sub-user-only'))).toBe(false);
  });
});
