/**
 * 任务18·B1 人事档案卡测试（L2）。
 *
 * 覆盖三层：
 *   1) 纯聚合矩阵：空历史 / 全成功 / 含取消 / 含失败 / 时间窗 / 旧记录 status 兜底 /
 *      姓名兜底匹配 / 技能摘要有界（前 K、去重、排序、截断）；
 *   2) 渲染有界：n/a 不硬造、整行硬上限；
 *   3) 端到端快照：真实 boss-service.gatherSubordinateContext + 真实
 *      subordinate-context-service.buildBossContext（数据源 mock：agent 表 / 技能表 /
 *      委派史内存实现），断言档案卡行进入 TEAM 段文本 + 技能库抛错时不炸快照。
 */

import { describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const now = Date.now();
  const boss = {
    id: 'boss-1',
    name: 'Boss',
    class: 'boss',
    isBoss: true,
    subordinateIds: ['w1', 'w2'],
    status: 'idle',
    cwd: '.',
    lastActivity: now,
    contextUsed: 0,
    contextLimit: 200000,
    tokensUsed: 0,
  };
  const w1 = {
    id: 'w1',
    name: 'Alpha Worker',
    class: 'builder',
    status: 'idle',
    cwd: '.',
    lastActivity: now,
    contextUsed: 1000,
    contextLimit: 200000,
    tokensUsed: 1000,
  };
  const w2 = {
    id: 'w2',
    name: 'Beta Worker',
    class: 'scout',
    status: 'idle',
    cwd: '.',
    lastActivity: now,
    contextUsed: 0,
    contextLimit: 200000,
    tokensUsed: 0,
  };
  const agents = new Map<string, unknown>([
    ['boss-1', boss],
    ['w1', w1],
    ['w2', w2],
  ]);
  const skillFixtures: Array<{ name: string }> = [
    { name: 'zeta-skill' },
    { name: 'alpha-skill' },
    { name: 'middle-skill' },
    { name: 'overflow-skill' },
  ];
  const getSkillsForAgent = vi.fn(() => skillFixtures);
  // F1 钉开关：为 true 时让「档案卡组装」抛错，从而走「缺卡（profile 省略）」降级路径。
  const failProfileBuild = { value: false };

  return { boss, w1, w2, agents, skillFixtures, getSkillsForAgent, failProfileBuild };
});

vi.mock('./agent-service.js', () => ({
  getAgent: vi.fn((id: string) => mocks.agents.get(id) ?? null),
  updateAgent: vi.fn(),
  getAllAgents: vi.fn(() => [...mocks.agents.values()]),
}));

vi.mock('./skill-service.js', () => ({
  getSkillsForAgent: mocks.getSkillsForAgent,
}));

// F1 钉：仅包装 buildAgentProfileCard（开关可控抛错），其余导出保持真实实现。
// 这样 gatherSubordinateContext 的「缺卡省略」与 buildBossContext 的「缺卡不输出行」
// 都走真实链路，可被测试直接钉住。
vi.mock('./agent-profile-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-profile-service.js')>();
  return {
    ...actual,
    buildAgentProfileCard: (...args: Parameters<typeof actual.buildAgentProfileCard>) => {
      if (mocks.failProfileBuild.value) throw new Error('forced profile build failure');
      return actual.buildAgentProfileCard(...args);
    },
  };
});

// 委派史存到 boss-service 自己的内存 map（addDelegationToHistory 传入），mock 只做读/写转发。
vi.mock('../data/index.js', () => ({
  loadDelegationHistory: () => new Map(),
  saveDelegationHistory: () => {},
  addDelegationDecision: (histories: Map<string, unknown[]>, bossId: string, decision: unknown) => {
    const list = histories.get(bossId) ?? [];
    list.unshift(decision);
    histories.set(bossId, list);
  },
  getDelegationHistory: (histories: Map<string, unknown[]>, bossId: string) => histories.get(bossId) ?? [],
  deleteDelegationHistory: (histories: Map<string, unknown[]>, bossId: string) => {
    histories.delete(bossId);
  },
}));

import type { AgentProfileCard, DelegationDecision, Skill } from '../../shared/types.js';
import {
  buildAgentProfileCard,
  formatProfileDuration,
  renderAgentProfileLine,
  resolveTaskOutcome,
  summarizeAgentHistory,
  DEFAULT_PROFILE_WINDOW_MS,
  MAX_PROFILE_LINE_CHARS,
  MAX_PROFILE_SKILL_NAMES,
} from './agent-profile-service.js';
import * as bossService from './boss-service.js';
import { buildBossContext } from './subordinate-context-service.js';

// ============================================================================
// fixtures
// ============================================================================

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function decision(overrides: Partial<DelegationDecision> & { id: string }): DelegationDecision {
  return {
    timestamp: NOW - HOUR,
    bossId: 'boss-1',
    userCommand: 'task',
    selectedAgentId: 'w1',
    selectedAgentName: 'Alpha Worker',
    reasoning: 'test',
    alternativeAgents: [],
    confidence: 'high',
    status: 'sent',
    ...overrides,
  };
}

function skill(name: string): Skill {
  return { id: name, name } as Skill;
}

// ============================================================================
// 1) 纯聚合矩阵
// ============================================================================

describe('summarizeAgentHistory（B1 纯聚合）', () => {
  it('空历史：计数全 0、完成率/耗时均值为 null（n/a，不硬造 0）', () => {
    const s = summarizeAgentHistory([], 'w1', 'Alpha Worker', NOW);
    expect(s).toEqual({
      total: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      terminal: 0,
      completionRate: null,
      avgDurationMs: null,
    });
  });

  it('全成功：完成率 1、耗时均值取 completion.durationMs', () => {
    const s = summarizeAgentHistory([
      decision({ id: 'd1', completion: { completedAt: NOW - HOUR / 2, durationMs: 60_000, result: 'completed' } }),
      decision({ id: 'd2', completion: { completedAt: NOW - HOUR / 2, durationMs: 120_000, result: 'completed' } }),
    ], 'w1', 'Alpha Worker', NOW);
    expect(s.completed).toBe(2);
    expect(s.terminal).toBe(2);
    expect(s.completionRate).toBe(1);
    expect(s.avgDurationMs).toBe(90_000);
  });

  it('含取消（任务16·⑬ 撤回）：cancelled 进分母、不计耗时样本', () => {
    const s = summarizeAgentHistory([
      decision({ id: 'ok', completion: { completedAt: NOW, durationMs: 30_000, result: 'completed' } }),
      decision({
        id: 'cancelled',
        taskCard: {
          objective: 'x',
          acceptanceCriteria: [],
          dependencies: [],
          status: 'cancelled',
        },
      }),
    ], 'w1', 'Alpha Worker', NOW);
    expect(s.cancelled).toBe(1);
    expect(s.terminal).toBe(2);
    expect(s.completionRate).toBe(0.5);
    expect(s.avgDurationMs).toBe(30_000); // 取消记录无 completion，不进样本
  });

  it('含失败（⑧ 病历 result=failed）：failed 也算终态分母（done/(done+cancelled) 的等价可测口径）', () => {
    const s = summarizeAgentHistory([
      decision({ id: 'ok', completion: { completedAt: NOW, durationMs: 10_000, result: 'completed' } }),
      decision({ id: 'bad', completion: { completedAt: NOW, durationMs: 20_000, result: 'failed' } }),
    ], 'w1', 'Alpha Worker', NOW);
    expect(s.failed).toBe(1);
    expect(s.terminal).toBe(2);
    expect(s.completionRate).toBe(0.5);
    expect(s.avgDurationMs).toBe(15_000); // 失败记录也带耗时，同样进均值
  });

  it('旧记录只用 decision.status 兜底（任务11 前的落盘形态）；pending/sent 不算终态', () => {
    const s = summarizeAgentHistory([
      decision({ id: 'legacy-done', status: 'completed' }),
      decision({ id: 'legacy-failed', status: 'failed' }),
      decision({ id: 'pending', status: 'pending' }),
      decision({ id: 'sent', status: 'sent' }),
    ], 'w1', 'Alpha Worker', NOW);
    expect(s.total).toBe(4);
    expect(s.terminal).toBe(2);
    expect(s.completionRate).toBe(0.5);
    expect(s.avgDurationMs).toBeNull(); // 无 completion → 无耗时样本
  });

  it('时间窗：窗口外记录被剔除，边界时刻（timestamp === cutoff）保留', () => {
    const s = summarizeAgentHistory([
      decision({ id: 'inside', timestamp: NOW - DEFAULT_PROFILE_WINDOW_MS + 1, status: 'completed' }),
      decision({ id: 'boundary', timestamp: NOW - DEFAULT_PROFILE_WINDOW_MS, status: 'completed' }),
      decision({ id: 'outside', timestamp: NOW - DEFAULT_PROFILE_WINDOW_MS - 1, status: 'completed' }),
    ], 'w1', 'Alpha Worker', NOW);
    expect(s.total).toBe(2);
    expect(s.completionRate).toBe(1);

    const narrow = summarizeAgentHistory([
      decision({ id: 'inside', timestamp: NOW - HOUR, status: 'completed' }),
      decision({ id: 'outside', timestamp: NOW - 2 * HOUR, status: 'completed' }),
    ], 'w1', 'Alpha Worker', NOW, HOUR);
    expect(narrow.total).toBe(1);
  });

  it('匹配口径：按 selectedAgentId；旧记录 id 为空才退回姓名匹配（避免同名跨团队误配）', () => {
    const s = summarizeAgentHistory([
      decision({ id: 'other-id', selectedAgentId: 'w9', selectedAgentName: 'Alpha Worker', status: 'completed' }),
      decision({ id: 'legacy-name', selectedAgentId: '', selectedAgentName: 'Alpha Worker', status: 'completed' }),
    ], 'w1', 'Alpha Worker', NOW);
    expect(s.total).toBe(1); // 只有 id 为空的那条落进来
    expect(s.completed).toBe(1);
  });

  it('resolveTaskOutcome：撤回优先于病历；无终态 → null', () => {
    expect(resolveTaskOutcome(decision({
      id: 'both',
      completion: { completedAt: NOW, durationMs: 1, result: 'completed' },
      taskCard: { objective: 'x', acceptanceCriteria: [], dependencies: [], status: 'cancelled' },
    }))).toBe('cancelled');
    expect(resolveTaskOutcome(decision({ id: 'plain' }))).toBeNull();
  });
});

// ============================================================================
// 2) 档案卡组装 / 渲染有界
// ============================================================================

describe('buildAgentProfileCard（技能摘要 + 有界）', () => {
  it('技能名去重、码点序稳定排序、只取前 K、hiddenSkillCount 如实', () => {
    const card = buildAgentProfileCard({
      agentId: 'w1',
      agentName: 'Alpha Worker',
      skills: [skill('zeta'), skill('alpha'), skill('middle'), skill('overflow'), skill('alpha')],
      decisions: [],
      now: NOW,
    });
    expect(card.skillCount).toBe(4); // 去重后
    expect(card.skillNames).toEqual(['alpha', 'middle', 'overflow'].slice(0, MAX_PROFILE_SKILL_NAMES));
    expect(card.hiddenSkillCount).toBe(card.skillCount - card.skillNames.length);
  });

  it('长技能名截断；空名忽略；无技能 → Skills(0)', () => {
    const long = 'x'.repeat(80);
    const card = buildAgentProfileCard({
      agentId: 'w1',
      skills: [skill(long), skill('   '), skill('ok')],
      decisions: [],
      now: NOW,
    });
    expect(card.skillCount).toBe(2);
    expect(card.skillNames.every((n) => n.length <= 24)).toBe(true);

    const empty = buildAgentProfileCard({ agentId: 'w2', skills: [], decisions: [], now: NOW });
    expect(empty.skillNames).toEqual([]);
    expect(renderAgentProfileLine(empty)).toContain('Skills(0)');
    expect(renderAgentProfileLine(empty)).toContain('Done n/a');
    expect(renderAgentProfileLine(empty)).toContain('Avg n/a');
  });

  it('返工率无数据源 → 恒为 null（缺源登记，禁编造）', () => {
    const card = buildAgentProfileCard({ agentId: 'w1', skills: [], decisions: [], now: NOW });
    expect(card.reworkRate).toBeNull();
  });

  it('整行硬上限：技能名极长/极多也不超过 MAX_PROFILE_LINE_CHARS', () => {
    const card = buildAgentProfileCard({
      agentId: 'w1',
      skills: Array.from({ length: 20 }, (_, i) => skill(`skill-${'y'.repeat(40)}-${i}`)),
      decisions: [],
      now: NOW,
      maxSkillNames: 3,
    });
    const line = renderAgentProfileLine(card);
    expect(line.length).toBeLessThanOrEqual(MAX_PROFILE_LINE_CHARS);
  });

  it('整行硬上限（F2 钉·直测渲染层）：绕过逐名截断直构超长技能名 → 行被截到 MAX_PROFILE_LINE_CHARS', () => {
    // 走 buildAgentProfileCard 时技能名先被截到 24 字符、K=3，最长行 ~140，永远打不到
    // 220 硬上限（上线路径合理不可达）；此例直构卡片、绕过上游截断，钉住截断分支本身：
    // 变异「删掉 220 截断」→ 长度断言失败。
    const card: AgentProfileCard = {
      skillCount: 1,
      skillNames: ['x'.repeat(400)],
      hiddenSkillCount: 0,
      totalDelegations: 0,
      completedCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      terminalCount: 0,
      completionRate: null,
      avgDurationMs: null,
      reworkRate: null,
    };
    const line = renderAgentProfileLine(card);
    expect(line.startsWith('- **Profile**: Skills(1/1): xxx')).toBe(true);
    expect(line.endsWith('…')).toBe(true);
    expect(line.length).toBe(MAX_PROFILE_LINE_CHARS);
  });

  it('formatProfileDuration 分档（ms/s/m/h，非法值 n/a）', () => {
    expect(formatProfileDuration(850)).toBe('850ms');
    expect(formatProfileDuration(45_000)).toBe('45.0s');
    expect(formatProfileDuration(90_000)).toBe('1.5m');
    expect(formatProfileDuration(5_400_000)).toBe('1.5h');
    expect(formatProfileDuration(Number.NaN)).toBe('n/a');
    expect(formatProfileDuration(-1)).toBe('n/a');
  });

  it('渲染样例：完整一行含技能摘要/完成率/耗时均值', () => {
    const card: AgentProfileCard = {
      skillCount: 3,
      skillNames: ['alpha', 'middle'],
      hiddenSkillCount: 1,
      totalDelegations: 3,
      completedCount: 1,
      failedCount: 1,
      cancelledCount: 1,
      terminalCount: 3,
      completionRate: 1 / 3,
      avgDurationMs: 90_000,
      reworkRate: null,
    };
    const line = renderAgentProfileLine(card);
    expect(line).toContain('Skills(2/3): alpha, middle +1');
    expect(line).toContain('Done 1/3 (33%)');
    expect(line).toContain('Avg 1.5m');
  });
});

// ============================================================================
// 3) 端到端：档案卡进入 buildBossContext TEAM 段
// ============================================================================

describe('B1 端到端：gatherSubordinateContext → buildBossContext 快照', () => {
  it('每 agent 一行档案卡（技能 + 完成率 + 耗时均值）进入 TEAM 段', async () => {
    const now = Date.now();
    bossService.addDelegationToHistory('boss-1', decision({
      id: 'e2e-done',
      timestamp: now - 10 * 60_000,
      completion: { completedAt: now - 5 * 60_000, durationMs: 300_000, result: 'completed' },
    }));
    bossService.addDelegationToHistory('boss-1', decision({
      id: 'e2e-failed',
      timestamp: now - 9 * 60_000,
      completion: { completedAt: now - 4 * 60_000, durationMs: 60_000, result: 'failed' },
    }));
    bossService.addDelegationToHistory('boss-1', decision({
      id: 'e2e-cancelled',
      timestamp: now - 8 * 60_000,
      taskCard: { objective: 'x', acceptanceCriteria: [], dependencies: [], status: 'cancelled' },
    }));

    const contexts = await bossService.gatherSubordinateContext('boss-1');
    const w1ctx = contexts.find((c) => c.id === 'w1');
    expect(w1ctx?.profile).toBeDefined();
    expect(w1ctx?.profile?.skillCount).toBe(4);
    expect(w1ctx?.profile?.completedCount).toBe(1);
    expect(w1ctx?.profile?.failedCount).toBe(1);
    expect(w1ctx?.profile?.cancelledCount).toBe(1);
    expect(w1ctx?.profile?.completionRate).toBeCloseTo(1 / 3);
    expect(w1ctx?.profile?.avgDurationMs).toBe(180_000); // (300000 + 60000) / 2

    const text = await buildBossContext('boss-1');
    expect(text).toBeTruthy();
    expect(text).toContain('- **Profile**:');
    expect(text).toContain('Skills(3/4): alpha-skill, middle-skill, overflow-skill +1');
    expect(text).toContain('Done 1/3 (33%)');
    expect(text).toContain('Avg 3.0m');

    // 无历史的下属同样有卡（n/a），而不是缺行
    const lines = text!.split('\n').filter((l) => l.startsWith('- **Profile**:'));
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.includes('Done n/a'))).toBe(true);

    // 体积有界：每行 ≤ 硬上限
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(MAX_PROFILE_LINE_CHARS);
  });

  it('失败降级：技能库不可读时快照不炸（Skills(0)）', async () => {
    mocks.getSkillsForAgent.mockImplementation(() => {
      throw new Error('skills.json unreadable');
    });
    try {
      const contexts = await bossService.gatherSubordinateContext('boss-1');
      expect(contexts).toHaveLength(2);
      expect(contexts[0]?.profile?.skillCount).toBe(0);

      const text = await buildBossContext('boss-1');
      expect(text).toContain('- **Profile**: Skills(0)');
      expect(text).toContain('# TEAM:');
    } finally {
      mocks.getSkillsForAgent.mockImplementation(() => mocks.skillFixtures);
    }
  });

  it('缺卡不输出行（F1 钉）：档案卡组装失败 → profile 缺席，TEAM 段不出现 - **Profile**:', async () => {
    // 现有覆盖里每个下属都建卡成功（Skills(0) 是「有卡无技能」的另一条路）。
    // 此例用受控开关让卡组装抛错，走 gatherSubordinateContext 的「缺卡省略」降级，
    // 钉住 subordinate-context-service 的 `ctx.profile ? … : ''` 分支：
    // 变异「缺卡时输出默认 Skills(0) 行」→ 下面 not.toContain 断言失败。
    mocks.failProfileBuild.value = true;
    try {
      const contexts = await bossService.gatherSubordinateContext('boss-1');
      expect(contexts).toHaveLength(2);
      // 缺卡 = 属性缺席（不是 Skills(0) 的默认卡）
      expect(contexts.every((c) => c.profile === undefined)).toBe(true);

      const text = await buildBossContext('boss-1');
      expect(text).toBeTruthy();
      expect(text).toContain('# TEAM:');
      expect(text).toContain('## Alpha Worker');
      expect(text).not.toContain('- **Profile**:');
    } finally {
      mocks.failProfileBuild.value = false;
    }
  });

  it('任务22 编制注记（B1 扩展）：连续失败 3 次的 agent 行尾带「观察中」；无异常者不加注', async () => {
    const now = Date.now();
    // 三条最近连续失败（压过本文件此前累积的历史）→ w1 命中连败阈值
    for (let i = 0; i < 3; i++) {
      bossService.addDelegationToHistory('boss-1', decision({
        id: `e2e-ledger-fail-${i}`,
        timestamp: now - (i + 1) * 60_000,
        completion: { completedAt: now - (i + 1) * 60_000 + 30_000, durationMs: 30_000, result: 'failed' },
      }));
    }

    const contexts = await bossService.gatherSubordinateContext('boss-1');
    expect(contexts.find((c) => c.id === 'w1')?.profile?.rosterNote).toBe('观察中：连续失败 3 次');
    expect(contexts.find((c) => c.id === 'w2')?.profile?.rosterNote).toBeUndefined(); // 无证据不加注

    const text = await buildBossContext('boss-1');
    expect(text).toContain('| 观察中：连续失败 3 次');
    const noteLines = text!.split('\n').filter((l) => l.startsWith('- **Profile**:'));
    expect(noteLines.filter((l) => l.includes('观察中'))).toHaveLength(1); // 只标异常者
  });

  it('待岗 (standby) 快照：仅待岗成员追加 Standby 标注行，非待岗成员状态行逐字不变', async () => {
    // 用户在面板把 w1 设为待岗（mocks.agents 是 getSubordinates 的数据源，换引用即可）
    mocks.agents.set('w1', { ...mocks.w1, standby: true });
    try {
      const contexts = await bossService.gatherSubordinateContext('boss-1');
      expect(contexts.find((c) => c.id === 'w1')?.standby).toBe(true);
      expect(contexts.find((c) => c.id === 'w2')?.standby).toBeUndefined(); // 非待岗不带字段（快照不抖）

      const text = await buildBossContext('boss-1');
      expect(text).toBeTruthy();
      // 恰一行 Standby 标注，紧跟在待岗者的 Status 行之后
      const standbyLines = text!.split('\n').filter((l) => l.includes('**Standby (待岗)**'));
      expect(standbyLines).toHaveLength(1);
      expect(standbyLines[0]).toContain('do NOT delegate');
      expect(text).toContain('- **Status**: idle\n- **Standby (待岗)**:');

      const w1Block = text!.slice(text!.indexOf('## Alpha Worker'), text!.indexOf('## Beta Worker'));
      const w2Block = text!.slice(text!.indexOf('## Beta Worker'));
      expect(w1Block).toContain('**Standby (待岗)**');
      expect(w2Block).not.toContain('Standby');

      // 非待岗成员的状态行与基线形态逐字一致（标注进不了别人的行）
      const statusLines = text!.split('\n').filter((l) => l.startsWith('- **Status**:'));
      expect(statusLines).toHaveLength(2);
      expect(statusLines.every((l) => l === '- **Status**: idle')).toBe(true);
    } finally {
      mocks.agents.set('w1', mocks.w1);
    }
  });
});
