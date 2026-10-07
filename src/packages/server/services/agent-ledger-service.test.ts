/**
 * 任务22·编制台账测试（L1）。
 *
 * 覆盖四层：
 *   1) 纯聚合矩阵：窗口口径 / 终态三分类 / 连续失败（打断与未终态语义）/
 *      失败率（>50% 严格比较 + 最小终态样本） / 闲置天数（边界 ≥30 天 /
 *      roster 与委派史取较新 / 无来源 null） / 建议优先级（观察中 > 归档候选）;
 *   2) 契约：无证据不出建议（advice ≠ keep ⟺ reasons 非空）;
 *   3) 渲染：buildRosterNote 短句 + renderAgentLedgerSection 段格式（空 / 全保留 / 混合）;
 *   4) 采集层：collectLiveRosterLedger 过滤 boss、数据源异常 → 空台账不抛。
 *
 * 数据源 mock：agent 花名册 / 委派史（均为读取转发，逻辑全走真实实现）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  roster: [] as unknown[],
  histories: new Map<string, unknown[]>(),
  loadShouldThrow: { value: false },
  getAllShouldThrow: { value: false },
}));

vi.mock('./agent-service.js', () => ({
  getAllAgents: vi.fn(() => {
    if (mocks.getAllShouldThrow.value) throw new Error('roster unavailable');
    return mocks.roster;
  }),
}));

vi.mock('../data/index.js', () => ({
  loadDelegationHistory: vi.fn(() => {
    if (mocks.loadShouldThrow.value) throw new Error('history unavailable');
    return mocks.histories;
  }),
}));

import type { DelegationDecision } from '../../shared/types.js';
import {
  computeAgentLedger,
  buildRosterNote,
  renderAgentLedgerSection,
  collectLiveRosterLedger,
  DEFAULT_LEDGER_WINDOW_MS,
  CONSECUTIVE_FAILURE_THRESHOLD,
  FAILURE_RATE_THRESHOLD,
  MIN_TERMINAL_FOR_FAILURE_RATE,
  IDLE_DAYS_THRESHOLD,
  type AgentLedgerEntry,
  type LedgerAgentRef,
} from './agent-ledger-service.js';

// ============================================================================
// 夹具
// ============================================================================

/** 固定 now（时区无关的断言只依赖相对距离；日期渲染用本地日）。 */
const NOW = Date.parse('2026-10-07T12:00:00+08:00');
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;

interface DecisionOpts {
  at: number;
  agentId?: string;
  agentName?: string;
  /** 病历终态（completion.result）。 */
  result?: 'completed' | 'failed';
  durationMs?: number;
  /** 撤回（taskCard.status === 'cancelled'）。 */
  cancelledCard?: boolean;
  /** 旧记录兜底状态。 */
  status?: DelegationDecision['status'];
}

function decision(opts: DecisionOpts): DelegationDecision {
  const { at, agentId = 'w1', agentName = 'W1', result, durationMs, cancelledCard, status = 'pending' } = opts;
  return {
    id: `d-${++seq}`,
    timestamp: at,
    bossId: 'boss-1',
    userCommand: 'cmd',
    selectedAgentId: agentId,
    selectedAgentName: agentName,
    reasoning: 'r',
    status,
    ...(result ? { completion: { completedAt: at, durationMs: durationMs ?? 0, result } } : {}),
    ...(cancelledCard ? { taskCard: { status: 'cancelled' } } : {}),
  } as unknown as DelegationDecision;
}

function agent(id: string, name = id, lastAssignedTaskTime?: number): LedgerAgentRef {
  return {
    id,
    name,
    ...(typeof lastAssignedTaskTime === 'number' ? { lastAssignedTaskTime } : {}),
  };
}

function only<T>(list: T[]): T {
  expect(list).toHaveLength(1);
  return list[0];
}

beforeEach(() => {
  mocks.roster = [];
  mocks.histories = new Map();
  mocks.loadShouldThrow.value = false;
  mocks.getAllShouldThrow.value = false;
});

// ============================================================================
// 1) 纯聚合矩阵
// ============================================================================

describe('computeAgentLedger · 统计口径', () => {
  it('空历史 + 空花名册 → 空台账', () => {
    expect(computeAgentLedger([], [], NOW)).toEqual([]);
  });

  it('无委派史 → 全零、null 字段、keep、无建议（无证据）', () => {
    const entry = only(computeAgentLedger([], [agent('w1', 'W1')], NOW));
    expect(entry).toMatchObject({
      agentId: 'w1',
      agentName: 'W1',
      windowDelegations: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      terminal: 0,
      consecutiveFailures: 0,
      lastDelegationAt: null,
      idleDays: null,
      avgDurationMs: null,
      advice: 'keep',
      reasons: [],
    });
  });

  it('混合窗口：终态三分类 / 未终态计入委派数 / 窗口外记录不入统计 / 平均耗时', () => {
    const decisions = [
      decision({ at: NOW - 1 * DAY, result: 'completed', durationMs: 1000 }),
      decision({ at: NOW - 2 * DAY, result: 'failed', durationMs: 3000 }),
      decision({ at: NOW - 3 * DAY, cancelledCard: true }),
      decision({ at: NOW - 0.5 * DAY }), // pending：未终态
      decision({ at: NOW - 20 * DAY, result: 'failed' }), // 窗口外（14 天）
    ];
    const entry = only(computeAgentLedger(decisions, [agent('w1', 'W1')], NOW));
    expect(entry).toMatchObject({
      windowDelegations: 4, // 含 pending，不含窗口外
      completed: 1,
      failed: 1,
      cancelled: 1,
      terminal: 3,
      avgDurationMs: 2000, // (1000 + 3000) / 2
      lastDelegationAt: NOW - 0.5 * DAY, // 最后委派不限窗口
      idleDays: 0, // floor(0.5) = 0
      advice: 'keep',
      reasons: [],
    });
  });

  it('姓名兜底匹配：旧记录 selectedAgentId 为空时按 selectedAgentName 命中', () => {
    const legacy = decision({ at: NOW - DAY, agentId: '', agentName: 'W1', status: 'completed' });
    const entry = only(computeAgentLedger([legacy], [agent('w1', 'W1')], NOW));
    expect(entry).toMatchObject({ windowDelegations: 1, completed: 1, terminal: 1 });
  });

  it('旧记录 status 兜底：无 completion 时 completed/failed 计入终态', () => {
    const entry = only(
      computeAgentLedger(
        [decision({ at: NOW - DAY, status: 'failed' }), decision({ at: NOW - 2 * DAY, status: 'completed' })],
        [agent('w1', 'W1')],
        NOW,
      ),
    );
    expect(entry).toMatchObject({ failed: 1, completed: 1, terminal: 2 });
  });

  it('窗口参数可覆盖（默认 14 天）', () => {
    expect(DEFAULT_LEDGER_WINDOW_MS).toBe(14 * DAY);
    const decisions = [decision({ at: NOW - 10 * DAY, result: 'failed' })];
    const inWindow = only(computeAgentLedger(decisions, [agent('w1')], NOW));
    expect(inWindow.windowDelegations).toBe(1);
    const outWindow = only(computeAgentLedger(decisions, [agent('w1')], NOW, { windowMs: 5 * DAY }));
    expect(outWindow.windowDelegations).toBe(0);
    expect(outWindow.lastDelegationAt).toBe(NOW - 10 * DAY);
  });
});

describe('computeAgentLedger · 连续失败', () => {
  it('最近连续 3 次 failed → observe，证据首选连续失败', () => {
    const decisions = [
      decision({ at: NOW - 1 * DAY, result: 'failed' }),
      decision({ at: NOW - 2 * DAY, result: 'failed' }),
      decision({ at: NOW - 3 * DAY, result: 'failed' }),
      decision({ at: NOW - 4 * DAY, result: 'completed' }),
    ];
    const entry = only(computeAgentLedger(decisions, [agent('w1', 'W1')], NOW));
    expect(entry.consecutiveFailures).toBe(3);
    expect(entry.advice).toBe('observe');
    expect(entry.reasons[0]).toBe('连续失败 3 次');
  });

  it('连续 2 次（阈值 3）→ keep', () => {
    const decisions = [
      decision({ at: NOW - 1 * DAY, result: 'failed' }),
      decision({ at: NOW - 2 * DAY, result: 'failed' }),
      decision({ at: NOW - 3 * DAY, result: 'completed' }),
      decision({ at: NOW - 4 * DAY, result: 'completed' }),
    ];
    const entry = only(computeAgentLedger(decisions, [agent('w1')], NOW));
    expect(entry.consecutiveFailures).toBe(2);
    expect(entry.advice).toBe('keep');
    expect(CONSECUTIVE_FAILURE_THRESHOLD).toBe(3);
  });

  it('cancelled 打断连败链（失败率稀释至不触发，专测打断语义）', () => {
    const decisions = [
      decision({ at: NOW - 1 * DAY, result: 'failed' }),
      decision({ at: NOW - 2 * DAY, cancelledCard: true }),
      decision({ at: NOW - 3 * DAY, result: 'failed' }),
      decision({ at: NOW - 4 * DAY, result: 'completed' }),
      decision({ at: NOW - 5 * DAY, result: 'completed' }),
      decision({ at: NOW - 6 * DAY, result: 'completed' }),
    ];
    const entry = only(computeAgentLedger(decisions, [agent('w1')], NOW));
    expect(entry.consecutiveFailures).toBe(1);
    expect(entry.advice).toBe('keep'); // 失败率 2/6 = 33%
  });

  it('更新的未终态记录不打断连败链（pending 无结果语义）', () => {
    const decisions = [
      decision({ at: NOW - 0.1 * DAY }), // pending
      decision({ at: NOW - 1 * DAY, result: 'failed' }),
      decision({ at: NOW - 2 * DAY, result: 'failed' }),
      decision({ at: NOW - 3 * DAY, result: 'failed' }),
    ];
    const entry = only(computeAgentLedger(decisions, [agent('w1')], NOW));
    expect(entry.consecutiveFailures).toBe(3);
    expect(entry.advice).toBe('observe');
  });

  it('窗口外连败不计入（统计窗口限定）', () => {
    const decisions = [
      decision({ at: NOW - 20 * DAY, result: 'failed' }),
      decision({ at: NOW - 21 * DAY, result: 'failed' }),
      decision({ at: NOW - 22 * DAY, result: 'failed' }),
    ];
    const entry = only(computeAgentLedger(decisions, [agent('w1')], NOW));
    expect(entry.consecutiveFailures).toBe(0);
    expect(entry.advice).toBe('keep'); // 闲置 20 天 < 30 天
  });

  it('阈值可覆盖（隔离失败率路径：默认档 keep，阈值降为 2 → observe）', () => {
    const decisions = [
      decision({ at: NOW - 1 * DAY, result: 'failed' }),
      decision({ at: NOW - 2 * DAY, result: 'failed' }),
      decision({ at: NOW - 3 * DAY, result: 'completed' }),
      decision({ at: NOW - 4 * DAY, result: 'completed' }), // 失败率 2/4=50%，不触发
    ];
    const def = only(computeAgentLedger(decisions, [agent('w1')], NOW));
    expect(def.consecutiveFailures).toBe(2);
    expect(def.advice).toBe('keep');
    const entry = only(computeAgentLedger(decisions, [agent('w1')], NOW, { consecutiveFailureThreshold: 2 }));
    expect(entry.advice).toBe('observe');
    expect(entry.reasons).toEqual(['连续失败 2 次']);
  });
});

describe('computeAgentLedger · 失败率', () => {
  it('连败 3 + 失败率 75%（4 终态）双命中 → reasons 双证据', () => {
    const decisions = [
      decision({ at: NOW - 1 * DAY, result: 'failed' }),
      decision({ at: NOW - 2 * DAY, result: 'failed' }),
      decision({ at: NOW - 3 * DAY, result: 'failed' }),
      decision({ at: NOW - 4 * DAY, result: 'completed' }), // 更早的达标打断不了最近连败
    ];
    const entry = only(computeAgentLedger(decisions, [agent('w1', 'W1')], NOW));
    expect(entry.consecutiveFailures).toBe(3);
    expect(entry.advice).toBe('observe');
    expect(entry.reasons).toEqual(['连续失败 3 次', '失败率 75%（3/4 终态）']);
  });

  it('单样本 1/1 失败 → 不触发（最小终态样本防误报）', () => {
    const entry = only(computeAgentLedger([decision({ at: NOW - DAY, result: 'failed' })], [agent('w1')], NOW));
    expect(entry.terminal).toBe(1);
    expect(entry.advice).toBe('keep');
    expect(MIN_TERMINAL_FOR_FAILURE_RATE).toBe(2);
  });

  it('恰好 50% → 不触发（严格 >）', () => {
    const decisions = [
      decision({ at: NOW - 1 * DAY, result: 'failed' }),
      decision({ at: NOW - 2 * DAY, result: 'completed' }),
      decision({ at: NOW - 3 * DAY, result: 'failed' }),
      decision({ at: NOW - 4 * DAY, result: 'completed' }),
    ];
    const entry = only(computeAgentLedger(decisions, [agent('w1')], NOW));
    expect(entry.consecutiveFailures).toBeLessThan(3);
    expect(entry.advice).toBe('keep');
    expect(FAILURE_RATE_THRESHOLD).toBe(0.5);
  });

  it('2 终态全败（连败 2 < 3）→ 失败率 100% 触发，证据只含失败率', () => {
    const decisions = [
      decision({ at: NOW - 1 * DAY, result: 'failed' }),
      decision({ at: NOW - 2 * DAY, result: 'failed' }),
    ];
    const entry = only(computeAgentLedger(decisions, [agent('w1', 'W1')], NOW));
    expect(entry.advice).toBe('observe');
    expect(entry.reasons).toEqual(['失败率 100%（2/2 终态）']);
  });
});

describe('computeAgentLedger · 闲置', () => {
  it('roster lastAssignedTaskTime 35 天前 → archive-candidate（含最后委派日）', () => {
    const entry = only(computeAgentLedger([], [agent('w1', 'W1', NOW - 35 * DAY)], NOW));
    expect(entry.idleDays).toBe(35);
    expect(entry.advice).toBe('archive-candidate');
    expect(entry.reasons).toHaveLength(2);
    expect(entry.reasons[0]).toBe('闲置 35 天');
    expect(entry.reasons[1]).toMatch(/^最后委派 \d{4}-\d{2}-\d{2}$/);
    expect(IDLE_DAYS_THRESHOLD).toBe(30);
  });

  it('边界：29.5 天 → keep；恰好 30 天 → archive-candidate（≥ 语义）', () => {
    const under = only(computeAgentLedger([], [agent('w1', undefined, NOW - (29 * DAY + 12 * 60 * 60 * 1000))], NOW));
    expect(under.idleDays).toBe(29);
    expect(under.advice).toBe('keep');

    const exact30 = only(
      computeAgentLedger([decision({ at: NOW - 30 * DAY, result: 'completed' })], [agent('w1')], NOW),
    );
    expect(exact30.idleDays).toBe(30);
    expect(exact30.advice).toBe('archive-candidate');
  });

  it('委派史比 roster 时间新 → 取较新者（不误报闲置）', () => {
    const decisions = [decision({ at: NOW - 10 * DAY, result: 'completed' })];
    const entry = only(computeAgentLedger(decisions, [agent('w1', 'W1', NOW - 40 * DAY)], NOW));
    expect(entry.lastDelegationAt).toBe(NOW - 10 * DAY);
    expect(entry.idleDays).toBe(10);
    expect(entry.advice).toBe('keep');
  });

  it('无任何来源 → idleDays null，不出闲置建议', () => {
    const entry = only(computeAgentLedger([], [agent('w1')], NOW));
    expect(entry.idleDays).toBeNull();
    expect(entry.advice).toBe('keep');
  });

  it('观察中优先于归档候选（同一 agent 双命中时取观察中）', () => {
    // 60 天窗口下：35 天前连续 3 次失败（窗口内）+ 最后委派 35 天前（闲置 ≥30）
    const decisions = [
      decision({ at: NOW - 35 * DAY, result: 'failed' }),
      decision({ at: NOW - 36 * DAY, result: 'failed' }),
      decision({ at: NOW - 37 * DAY, result: 'failed' }),
    ];
    const entry = only(computeAgentLedger(decisions, [agent('w1', 'W1')], NOW, { windowMs: 60 * DAY }));
    expect(entry.idleDays).toBe(35); // 双条件都满足
    expect(entry.advice).toBe('observe');
    expect(entry.reasons).toEqual(['连续失败 3 次', '失败率 100%（3/3 终态）']);
  });
});

describe('computeAgentLedger · 契约（无证据不出建议）', () => {
  it('advice ≠ keep ⟺ reasons 非空（混合场景全量断言）', () => {
    const decisions = [
      // w1：连败触发 observe
      decision({ at: NOW - 1 * DAY, agentId: 'w1', agentName: 'W1', result: 'failed' }),
      decision({ at: NOW - 2 * DAY, agentId: 'w1', agentName: 'W1', result: 'failed' }),
      decision({ at: NOW - 3 * DAY, agentId: 'w1', agentName: 'W1', result: 'failed' }),
      // w2：正常达标
      decision({ at: NOW - 1 * DAY, agentId: 'w2', agentName: 'W2', result: 'completed' }),
    ];
    const entries = computeAgentLedger(
      decisions,
      [agent('w1', 'W1'), agent('w2', 'W2'), agent('w3', 'W3', NOW - 40 * DAY)],
      NOW,
    );
    expect(entries).toHaveLength(3);
    for (const e of entries) {
      if (e.advice === 'keep') expect(e.reasons).toEqual([]);
      else expect(e.reasons.length).toBeGreaterThan(0);
    }
    expect(entries.map((e) => e.advice)).toEqual(['observe', 'keep', 'archive-candidate']);
  });
});

// ============================================================================
// 3) 渲染
// ============================================================================

describe('buildRosterNote', () => {
  const base: AgentLedgerEntry = {
    agentId: 'w1',
    agentName: 'W1',
    windowDelegations: 3,
    completed: 0,
    failed: 3,
    cancelled: 0,
    terminal: 3,
    consecutiveFailures: 3,
    lastDelegationAt: NOW - DAY,
    idleDays: 1,
    avgDurationMs: null,
    advice: 'observe',
    reasons: ['连续失败 3 次'],
  };

  it('keep / null / 无证据 → null', () => {
    expect(buildRosterNote(null)).toBeNull();
    expect(buildRosterNote(undefined)).toBeNull();
    expect(buildRosterNote({ ...base, advice: 'keep', reasons: [] })).toBeNull();
    expect(buildRosterNote({ ...base, reasons: [] })).toBeNull(); // 防御：非 keep 但无证据也拒注记
  });

  it('observe → 观察中短句；archive-candidate → 归档候选短句', () => {
    expect(buildRosterNote(base)).toBe('观察中：连续失败 3 次');
    expect(
      buildRosterNote({ ...base, advice: 'archive-candidate', reasons: ['闲置 35 天', '最后委派 2026-09-02'] }),
    ).toBe('归档候选：闲置 35 天');
  });
});

describe('renderAgentLedgerSection', () => {
  it('空台账 → 段头 + 无数据行', () => {
    expect(renderAgentLedgerSection([])).toBe('## 编制\n\n- 无编制数据（agent 花名册为空或不可读）');
  });

  it('全员保留 → 只出汇总行', () => {
    const section = renderAgentLedgerSection([
      { agentId: 'w1', windowDelegations: 1, completed: 1, failed: 0, cancelled: 0, terminal: 1, consecutiveFailures: 0, lastDelegationAt: NOW, idleDays: 0, avgDurationMs: null, advice: 'keep', reasons: [] },
      { agentId: 'w2', windowDelegations: 0, completed: 0, failed: 0, cancelled: 0, terminal: 0, consecutiveFailures: 0, lastDelegationAt: NOW, idleDays: 1, avgDurationMs: null, advice: 'keep', reasons: [] },
    ]);
    expect(section.split('\n')).toEqual(['## 编制', '', '- 汇总：共 2 名（全部保留，无异常建议）']);
  });

  it('混合 → 汇总计数 + 非保留逐条（含证据、名称兜底 agentId）', () => {
    const section = renderAgentLedgerSection([
      { agentId: 'w1', agentName: 'W1', windowDelegations: 3, completed: 0, failed: 3, cancelled: 0, terminal: 3, consecutiveFailures: 3, lastDelegationAt: NOW, idleDays: 0, avgDurationMs: null, advice: 'observe', reasons: ['连续失败 3 次', '失败率 100%（3/3 终态）'] },
      { agentId: 'w2', windowDelegations: 0, completed: 0, failed: 0, cancelled: 0, terminal: 0, consecutiveFailures: 0, lastDelegationAt: NOW - 35 * DAY, idleDays: 35, avgDurationMs: null, advice: 'archive-candidate', reasons: ['闲置 35 天', '最后委派 2026-09-02'] },
      { agentId: 'w3', windowDelegations: 1, completed: 1, failed: 0, cancelled: 0, terminal: 1, consecutiveFailures: 0, lastDelegationAt: NOW, idleDays: 0, avgDurationMs: null, advice: 'keep', reasons: [] },
    ]);
    expect(section.split('\n')).toEqual([
      '## 编制',
      '',
      '- 汇总：共 3 名（保留 1 · 观察中 1 · 归档候选 1）',
      '- 观察中 · W1：连续失败 3 次；失败率 100%（3/3 终态）',
      '- 归档候选 · w2：闲置 35 天；最后委派 2026-09-02',
    ]);
  });
});

// ============================================================================
// 4) 采集层
// ============================================================================

describe('collectLiveRosterLedger', () => {
  it('过滤 boss 花名册、传递 lastAssignedTaskTime、委派史全量参与', () => {
    mocks.roster = [
      { id: 'boss-1', name: 'Boss', isBoss: true, lastAssignedTaskTime: NOW - DAY },
      { id: 'w1', name: 'W1', lastAssignedTaskTime: NOW - 40 * DAY },
      { id: 'w2', name: 'W2' },
    ];
    mocks.histories = new Map([
      [
        'boss-1',
        [
          decision({ at: NOW - 1 * DAY, agentId: 'w1', agentName: 'W1', result: 'completed' }),
          decision({ at: NOW - 2 * DAY, agentId: 'boss-1', agentName: 'Boss', result: 'completed' }),
        ],
      ],
    ]);
    const entries = collectLiveRosterLedger(NOW);
    expect(entries.map((e) => e.agentId)).toEqual(['w1', 'w2']); // boss 不在编制
    const w1 = entries[0];
    expect(w1.advice).toBe('keep');
    expect(w1.lastDelegationAt).toBe(NOW - 1 * DAY); // 委派史比 roster 时间新
    expect(w1.idleDays).toBe(1);
    expect(entries[1].advice).toBe('keep'); // w2 无来源 → 不出建议
  });

  it('花名册不可读 → 空台账不抛', () => {
    mocks.getAllShouldThrow.value = true;
    expect(collectLiveRosterLedger(NOW)).toEqual([]);
  });

  it('委派史不可读 → 空台账不抛', () => {
    mocks.loadShouldThrow.value = true;
    expect(collectLiveRosterLedger(NOW)).toEqual([]);
  });
});
