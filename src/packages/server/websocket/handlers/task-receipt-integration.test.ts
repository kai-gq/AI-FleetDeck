/**
 * 任务08② 回执订阅播报集成链路（验收 ⑥1 进程内代理 + ⑥3 服务端半边 + 🔴② 埋点）。
 *
 * 真实：parseBossDelegation（登记待回执）→ pending-receipt-registry（匹配/去重/过期）
 *   → task-receipt-notifier（组 Signal → 09 判断层 → 广播 task_receipt + system_log 埋点）；
 * 仅 mock：services/index（不真跑下属进程）、utils/index（logger）、command-handler、
 *   custom-class-service（与 boss-response-handler.test.ts 同装置）。
 *
 * 真 LLM E2E 由 W6 金丝雀/L2 沙箱承接（另一 agent 建），本测试为进程内链路代理。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/index.js', () => ({
  agentService: {
    // 派发守卫（待岗/不存在）会解析目标 agent：默认给良性桩，按 id 区分。
    getAgent: vi.fn((id: string) => ({ id, name: id, class: 'builder' })),
  },
  runtimeService: {
    sendCommand: vi.fn(() => Promise.resolve()),
  },
  bossService: {
    addDelegationToHistory: vi.fn(),
    updateDelegationTaskCardStatus: vi.fn(),
  },
  workPlanService: {
    parseWorkPlanBlock: vi.fn(),
    createWorkPlan: vi.fn(),
    parseAnalysisRequestBlock: vi.fn(() => []),
    createAnalysisRequest: vi.fn(),
    startAnalysisRequest: vi.fn(),
  },
}));

// 任务15·B：handler 静态 import 播报出口（voice-companion-service）后，模块图会带上
// utils 的真实消费者（createLogger/generateId 等）——partial mock 保真，仅静音 ws 通道。
vi.mock('../../utils/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/index.js')>();
  return {
    ...actual,
    logger: {
      ...actual.logger,
      ws: {
        log: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      },
    },
    getCommanderBaseUrl: vi.fn(() => 'http://localhost:6200'),
  };
});

vi.mock('./command-handler.js', () => ({
  getLastBossCommand: vi.fn(() => 'fallback delegated task'),
  buildCustomAgentConfig: vi.fn(() => undefined),
}));

vi.mock('../../services/custom-class-service.js', () => ({
  getAllCustomClasses: vi.fn(() => []),
}));

// ⑥3 接缝：spy 保留真实实现，单测里 mockReturnValueOnce 让判断层返回「沉默」
vi.mock('../../../shared/broadcast-gates.js', { spy: true });

import { parseBossDelegation, resetBossDelegationStateForTests, clearDelegation } from './boss-response-handler.js';
import { notifyTaskCompletion, notifyBossUplinkCompletion, resetTaskReceiptNotifierForTests, MAX_TURN_FULL_LENGTH } from './task-receipt-notifier.js';
import { registerPendingReceipt, pendingReceiptCount, resetPendingReceiptsForTests } from './pending-receipt-registry.js';
import {
  canFireBossUplink,
  collectBossUplinkState,
  consumeBossUplinkReceipt,
  hasBossUplinkReceipt,
  registerBossUplinkReceipt,
  resetBossUplinksForTests,
} from './boss-uplink-receipt-registry.js';
import { REQUESTED_RECEIPT_SCORE, decideBroadcast } from '../../../shared/broadcast-gates.js';
import { closeEventDb, initEventDb } from '../../data/event-db.js';
import { querySystemLog } from '../../data/system-log.js';
import { bossService } from '../../services/index.js';
import * as fs from 'node:fs';
import { defaultAliasTablePath, saveAliasTable } from '../../jarvis-core/projects/aliases.js';

/** 固定判定时刻：本地 15:00（不在深夜/focus 窗口），测试可复现。 */
const AT = new Date(2026, 9, 4, 15, 0).getTime();

/** 回执埋点行（system_log delegation / phase 'receipt'），带行 id 供基线隔离。 */
function receiptRows(): Array<{ id: number; body: Record<string, unknown> }> {
  return querySystemLog({ category: 'delegation', limit: 500, order: 'asc' })
    .flatMap((row) => {
      if (!row.body || row.id === undefined) return [];
      try {
        return [{ id: row.id, body: JSON.parse(row.body) as Record<string, unknown> }];
      } catch {
        return []; // 非 JSON 正文的 delegation 行不参与回执断言
      }
    })
    .filter(({ body }) => body.phase === 'receipt');
}

/**
 * 本用例新增的埋点行。
 * 注意：querySystemLog 按 ts/id 排序，而本测试跨用例固定复用 AT 时刻，计数差值不可靠；
 * 行 id 单调递增（autoincrement），以「本用例前的最大 id」为基线过滤才稳定。
 */
let receiptBaselineId = 0;
function newReceiptRows(): Array<Record<string, unknown>> {
  return receiptRows()
    .filter(({ id }) => id > receiptBaselineId)
    .map(({ body }) => body);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 真 parseBossDelegation 派活（mock 服务），登记待回执。返回 decisionId。传 projectId 时附任务卡。 */
async function delegateViaBoss(
  taskCommand: string,
  agentId = 'agent-1',
  agentName = 'Builder One',
  projectId?: string,
): Promise<string> {
  const item: Record<string, unknown> = {
    selectedAgentId: agentId,
    selectedAgentName: agentName,
    taskCommand,
    reasoning: 'builder 空闲',
    confidence: 'high',
  };
  // 任务14·B：项目归属来源 = TaskCard.projectId（随派活登记带入待回执）
  if (projectId) item.taskCard = { objective: taskCommand, acceptanceCriteria: ['完成'], projectId };
  const resultText = `\`\`\`delegation\n[${JSON.stringify(item)}]\n\`\`\``;
  parseBossDelegation('boss-1', 'Boss', resultText, vi.fn());
  await tick();
  const decision = vi.mocked(bossService.addDelegationToHistory).mock.calls.at(-1)![1];
  return decision.id;
}

function lastReceiptBroadcast(broadcast: ReturnType<typeof vi.fn>): any {
  const calls = broadcast.mock.calls.filter((c) => c[0]?.type === 'task_receipt');
  return calls.at(-1)?.[0];
}

describe('任务08② 回执订阅播报：登记 → 匹配 → 判断层 → task_receipt + 🔴② 埋点', () => {
  beforeAll(() => {
    initEventDb();
  });

  afterAll(() => {
    closeEventDb();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetBossDelegationStateForTests();
    resetTaskReceiptNotifierForTests(AT);
    receiptBaselineId = Math.max(0, ...receiptRows().map(({ id }) => id));
  });

  it('⑥1 代理：派活登记 → 完成回执 → 命中匹配 → 过判断层 → task_receipt（带任务摘要与稳定键）+ 埋点', async () => {
    const decisionId = await delegateViaBoss('实现登录页');
    expect(pendingReceiptCount()).toBe(1);

    const broadcast = vi.fn();
    const outcome = notifyTaskCompletion({
      subordinateId: 'agent-1',
      agentName: 'Builder One',
      success: true,
      source: 'report-task',
      at: AT,
      broadcast,
    });

    // 匹配命中 + completed=70 分 → PREPARE（攒批档），非 SILENT 转发
    expect(outcome).toMatchObject({ matched: true, duplicate: false, tier: 'PREPARE', forwarded: true });

    const message = lastReceiptBroadcast(broadcast);
    expect(message).toBeTruthy();
    expect(message.payload).toMatchObject({
      agentId: 'agent-1',
      agentName: 'Builder One',
      success: true,
      matched: true,
      source: 'report-task',
    });
    expect(message.payload.decisionId).toBe(decisionId);
    expect(message.payload.taskId).toBeTruthy();
    expect(message.payload.text).toContain('Builder One');
    expect(message.payload.text).toContain('完成任务');
    expect(message.payload.text).toContain('实现登录页');
    // 稳定去重键：agent-completed:{agentId}:{taskId}（06-11 §11.1）
    expect(message.payload.dedupeKey).toBe(`agent-completed:agent-1:${message.payload.taskId}`);
    expect(message.payload.observed).toMatchObject({ tier: 'PREPARE', reason: 'batched' });

    // 🔴② 观测点：回执事件 → 匹配 → 是否触发播报（全量落盘）
    const rows = newReceiptRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ matched: true, duplicate: false, forwarded: true, tier: 'PREPARE', entry: 'report-task' });
  });

  it('双入口同键去重：runtime 先到已转发，report-task 第二入口不再转发（同一事件不重复播）', async () => {
    await delegateViaBoss('实现登录页');
    const broadcast = vi.fn();

    const first = notifyTaskCompletion({ subordinateId: 'agent-1', agentName: 'Builder One', success: true, source: 'runtime', at: AT, broadcast });
    const second = notifyTaskCompletion({
      subordinateId: 'agent-1',
      agentName: 'Builder One',
      success: true,
      summary: '已完成并通过测试',
      source: 'report-task',
      at: AT + 1000,
      broadcast,
    });

    expect(first).toMatchObject({ matched: true, forwarded: true });
    expect(second).toMatchObject({ matched: true, duplicate: true, forwarded: false, tier: 'SILENT' });
    expect(broadcast).toHaveBeenCalledTimes(1); // 仅第一入口转发

    const rows = newReceiptRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ entry: 'runtime', forwarded: true });
    expect(rows[1]).toMatchObject({ entry: 'report-task', forwarded: false, duplicate: true, reason: 'duplicate' });
  });

  it('⑥3 服务端：mock 判断层返回「沉默」→ 无 task_receipt 广播、埋点留证 forwarded:false', async () => {
    await delegateViaBoss('实现登录页');
    const broadcast = vi.fn();
    vi.mocked(decideBroadcast).mockReturnValueOnce({
      tier: 'SILENT',
      reason: 'low_relevance',
      score: 40,
      disruption: 20,
      budget: 10,
      duplicate: false,
      delta: { seenKeysToAdd: [], dailySpokenDelta: 0, instantSpeechDelta: 0 },
    });

    const outcome = notifyTaskCompletion({ subordinateId: 'agent-1', agentName: 'Builder One', success: true, source: 'report-task', at: AT, broadcast });

    expect(outcome).toMatchObject({ matched: true, tier: 'SILENT', forwarded: false });
    expect(broadcast).not.toHaveBeenCalled(); // 无客户消息 ⇒ 客户端无音频路径
    const rows = newReceiptRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tier: 'SILENT', forwarded: false, matched: true });
  });

  it('防漏报：无登记（未匹配）完成同样过判断层并转发，文本退化为通用完成句 + 埋点 matched:false', () => {
    const broadcast = vi.fn();
    const outcome = notifyTaskCompletion({
      subordinateId: 'agent-9',
      agentName: 'Flyer Nine',
      success: false,
      source: 'runtime',
      at: AT,
      broadcast,
    });

    // failed=87 分 → urgent SPEAK；未匹配不静默
    expect(outcome).toMatchObject({ matched: false, forwarded: true, tier: 'SPEAK' });
    const message = lastReceiptBroadcast(broadcast);
    expect(message.payload).toMatchObject({ agentId: 'agent-9', matched: false, success: false });
    expect(message.payload.text).toBe('Flyer Nine 任务失败');
    expect(message.payload.dedupeKey).toBe(`agent-failed:agent-9@${AT}`); // 无 taskId 回退唯一键

    const rows = newReceiptRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ matched: false, forwarded: true, success: false });
  });

  it('过期登记不命中：退化为未匹配完成（仍过判断层，不静默丢弃）', () => {
    registerPendingReceipt({
      targetAgentId: 'agent-7',
      bossId: 'boss-1',
      taskId: 't-expired',
      taskSummary: '很久以前的派活',
      registeredAt: AT - 3 * 60 * 60 * 1000, // 3 小时前 > 默认 TTL 2 小时
    });
    const broadcast = vi.fn();
    const outcome = notifyTaskCompletion({ subordinateId: 'agent-7', agentName: 'Slow Seven', success: true, source: 'runtime', at: AT, broadcast });

    expect(outcome.matched).toBe(false);
    expect(outcome.forwarded).toBe(true);
    expect(lastReceiptBroadcast(broadcast).payload.text).toBe('Slow Seven 完成任务');
    expect(pendingReceiptCount()).toBe(0); // 惰性清扫
  });
});

// ============================================================================
// 任务14·B：回执文本【项目别名】前缀（派活登记 projectId → 14·A 别名表映射）
// ============================================================================

describe('任务14·B 回执项目前缀：登记 projectId → 14·A 别名表 → 文本前缀', () => {
  const aliasFile = defaultAliasTablePath();

  /** 写入别名表（XDG 沙箱默认路径；表内 alias 为归一化口称名，同 14·A 存储口径）。 */
  function writeAliasTable(entries: Array<{ alias: string; projectId: string }>): void {
    saveAliasTable(
      {
        version: 1,
        updatedAt: AT,
        entries: entries.map((e) => ({ ...e, createdAt: AT, source: 'file' as const })),
      },
      aliasFile,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetBossDelegationStateForTests(); // 登记/追踪/配额跨测隔离
    resetTaskReceiptNotifierForTests(AT); // 判断层闸门（预算/幂等键）跨测隔离
    fs.rmSync(aliasFile, { force: true });
  });
  afterEach(() => fs.rmSync(aliasFile, { force: true }));

  it('已知项目：派活带 taskCard.projectId → 回执文本前缀【别名】（登记带入，非调用方兜底）', async () => {
    writeAliasTable([{ alias: '项目b组', projectId: 'proj-b' }]);
    const decisionId = await delegateViaBoss('实现登录页', 'agent-1', 'Builder One', 'proj-b');

    const broadcast = vi.fn();
    const outcome = notifyTaskCompletion({
      subordinateId: 'agent-1',
      agentName: 'Builder One',
      success: true,
      source: 'report-task',
      at: AT,
      broadcast,
    });

    expect(outcome).toMatchObject({ matched: true, duplicate: false, forwarded: true });
    const message = lastReceiptBroadcast(broadcast);
    expect(message.payload.decisionId).toBe(decisionId);
    expect(message.payload.text).toBe('【项目b组】Builder One 完成任务:实现登录页');
  });

  it('未知项目：别名表查不到 → 原样不加前缀（如实，不写「未知」）', async () => {
    writeAliasTable([{ alias: '项目b组', projectId: 'proj-b' }]);
    await delegateViaBoss('实现登录页', 'agent-1', 'Builder One', 'proj-unknown');

    const broadcast = vi.fn();
    notifyTaskCompletion({
      subordinateId: 'agent-1',
      agentName: 'Builder One',
      success: true,
      source: 'report-task',
      at: AT,
      broadcast,
    });
    expect(lastReceiptBroadcast(broadcast).payload.text).toBe('Builder One 完成任务:实现登录页');
  });

  it('无 projectId（旧路径）：别名表有条目也不加前缀、不占位', async () => {
    writeAliasTable([{ alias: '项目b组', projectId: 'proj-b' }]);
    await delegateViaBoss('实现登录页');

    const broadcast = vi.fn();
    notifyTaskCompletion({
      subordinateId: 'agent-1',
      agentName: 'Builder One',
      success: true,
      source: 'report-task',
      at: AT,
      broadcast,
    });
    expect(lastReceiptBroadcast(broadcast).payload.text).toBe('Builder One 完成任务:实现登录页');
  });

  it('未匹配登记（防漏报）：调用方透传 projectId 兜底 → 前缀仍生效', () => {
    writeAliasTable([{ alias: '项目b组', projectId: 'proj-b' }]);
    const broadcast = vi.fn();
    const outcome = notifyTaskCompletion({
      subordinateId: 'agent-9',
      agentName: 'Flyer Nine',
      success: true,
      source: 'report-task',
      projectId: 'proj-b',
      at: AT,
      broadcast,
    });

    expect(outcome).toMatchObject({ matched: false, forwarded: true });
    expect(lastReceiptBroadcast(broadcast).payload.text).toBe('【项目b组】Flyer Nine 完成任务');
  });

  it('任务40 上行回执（T2）：登记快照 projectId → 前缀【别名】', () => {
    writeAliasTable([{ alias: '项目b组', projectId: 'proj-b' }]);
    resetBossUplinksForTests();
    registerBossUplinkReceipt({ bossId: 'boss-1', taskSummary: '发布新版本', projectId: 'proj-b', taskId: 't-46', registeredAt: AT });
    const entry = consumeBossUplinkReceipt('boss-1', AT)!;

    const broadcast = vi.fn();
    notifyBossUplinkCompletion({
      bossId: 'boss-1',
      agentName: 'Jarvis',
      entry,
      trigger: 'subordinate-complete',
      at: AT,
      broadcast,
    });
    expect(lastReceiptBroadcast(broadcast).payload.text).toBe('【项目b组】Jarvis 已办结:发布新版本');
  });
});

// ============================================================================
// 任务40：上行回执链（登记 → 就绪判定 → 消费 → 「已回复/已办结」task_receipt）
// ============================================================================

describe('任务40 上行回执链：就绪判定 → 消费 → task_receipt + 🔴② 埋点（uplink:boss）', () => {
  beforeAll(() => {
    initEventDb();
  });

  afterAll(() => {
    closeEventDb();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetBossDelegationStateForTests(); // 含下属层待回执复位
    resetTaskReceiptNotifierForTests(AT);
    resetBossUplinksForTests();
    resetPendingReceiptsForTests();
    receiptBaselineId = Math.max(0, ...receiptRows().map(({ id }) => id));
  });

  it('T1 主管自办：无在飞无未匹配 → 消费交付「已回复:{摘要}——{尾摘}」+ 幂等键 + 埋点 + 消费即删', () => {
    registerBossUplinkReceipt({ bossId: 'boss-1', taskSummary: '把官网文案改好', taskId: 't-40', registeredAt: AT });

    // 就绪判定（链路真收口）→ 消费（触发侧语义 = maybeFireBossUplink 的同步核心）
    expect(canFireBossUplink(collectBossUplinkState('boss-1'))).toBe(true);
    const entry = consumeBossUplinkReceipt('boss-1', AT);
    expect(entry).toBeTruthy();

    const broadcast = vi.fn();
    const outcome = notifyBossUplinkCompletion({
      bossId: 'boss-1',
      agentName: 'Jarvis',
      entry: entry!,
      trigger: 'turn-close',
      turnTextTail: '文案已经改好了，等你验收',
      at: AT,
      broadcast,
    });

    expect(outcome).toMatchObject({ matched: true, duplicate: false, tier: 'PREPARE', forwarded: true });
    const message = lastReceiptBroadcast(broadcast);
    expect(message.payload).toMatchObject({
      agentId: 'boss-1',
      agentName: 'Jarvis',
      success: true,
      matched: true,
      taskId: 't-40',
      source: 'runtime',
    });
    expect(message.payload.text).toBe('Jarvis 已回复:把官网文案改好——文案已经改好了，等你验收');
    expect(message.payload.dedupeKey).toBe('boss-uplink:boss-1:t-40');

    const rows = newReceiptRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ uplink: 'boss', trigger: 'turn-close', matched: true, forwarded: true });
    expect(hasBossUplinkReceipt('boss-1', AT)).toBe(false); // 消费即删
  });

  it('T2 转委派收口：链路在飞时不交付不消费；委派清出 + 下属回执匹配后 → 「已办结:{摘要}」+ 消费一次性', async () => {
    registerBossUplinkReceipt({ bossId: 'boss-1', taskSummary: '发布新版本', taskId: 't-41', registeredAt: AT });
    await delegateViaBoss('发版任务'); // boss-1 → agent-1：在飞委派 + 未匹配下属回执

    // 链路未收口：不交付、不消费（留待收口/下次触发）
    expect(canFireBossUplink(collectBossUplinkState('boss-1'))).toBe(false);
    expect(hasBossUplinkReceipt('boss-1', AT)).toBe(true);

    // 下属完成：回执匹配 + 委派收口（完成漏斗 clearDelegation 环节的等价物）
    notifyTaskCompletion({
      subordinateId: 'agent-1',
      agentName: 'Builder One',
      success: true,
      source: 'runtime',
      at: AT,
      broadcast: vi.fn(),
    });
    clearDelegation('agent-1');

    expect(canFireBossUplink(collectBossUplinkState('boss-1'))).toBe(true);
    const entry = consumeBossUplinkReceipt('boss-1', AT)!;
    const broadcast = vi.fn();
    notifyBossUplinkCompletion({
      bossId: 'boss-1',
      agentName: 'Jarvis',
      entry,
      trigger: 'subordinate-complete',
      at: AT,
      broadcast,
    });

    expect(lastReceiptBroadcast(broadcast).payload.text).toBe('Jarvis 已办结:发布新版本');
    expect(consumeBossUplinkReceipt('boss-1', AT)).toBeUndefined(); // 第二次触发早退（消费即删）
  });

  it('⑥3 判断层沉默 → 无广播、埋点 forwarded:false（客户端无音频路径）', () => {
    registerBossUplinkReceipt({ bossId: 'boss-1', taskSummary: '改文案', taskId: 't-42', registeredAt: AT });
    const entry = consumeBossUplinkReceipt('boss-1', AT)!;
    const broadcast = vi.fn();
    vi.mocked(decideBroadcast).mockReturnValueOnce({
      tier: 'SILENT',
      reason: 'low_relevance',
      score: 40,
      disruption: 20,
      budget: 10,
      duplicate: false,
      delta: { seenKeysToAdd: [], dailySpokenDelta: 0, instantSpeechDelta: 0 },
    });

    const outcome = notifyBossUplinkCompletion({
      bossId: 'boss-1',
      agentName: 'Jarvis',
      entry,
      trigger: 'subordinate-complete',
      at: AT,
      broadcast,
    });

    expect(outcome).toMatchObject({ matched: true, tier: 'SILENT', forwarded: false });
    expect(broadcast).not.toHaveBeenCalled();
    const rows = newReceiptRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ uplink: 'boss', tier: 'SILENT', forwarded: false });
  });

  it('判断层异常 → FALLBACK_OUTCOME 静默降级（回执链路 best-effort，绝不打断主链路）', () => {
    registerBossUplinkReceipt({ bossId: 'boss-1', taskSummary: '改文案', taskId: 't-43', registeredAt: AT });
    const entry = consumeBossUplinkReceipt('boss-1', AT)!;
    vi.mocked(decideBroadcast).mockImplementationOnce(() => {
      throw new Error('boom');
    });

    const outcome = notifyBossUplinkCompletion({
      bossId: 'boss-1',
      agentName: 'Jarvis',
      entry,
      trigger: 'turn-close',
      at: AT,
      broadcast: vi.fn(),
    });
    expect(outcome).toMatchObject({ matched: false, tier: 'SILENT', forwarded: false });
  });

  it('T1 尾摘清洗：空白压缩 + >40 字取结尾（前缀 … 表明由来）；空白尾摘舍弃', () => {
    registerBossUplinkReceipt({ bossId: 'boss-1', taskSummary: '改文案', taskId: 't-44', registeredAt: AT });
    const entry = consumeBossUplinkReceipt('boss-1', AT)!;
    const broadcast = vi.fn();
    notifyBossUplinkCompletion({
      bossId: 'boss-1',
      agentName: 'Jarvis',
      entry,
      trigger: 'turn-close',
      turnTextTail: `多行\n文本   带空白${'末'.repeat(50)}`,
      at: AT,
      broadcast,
    });
    const text = lastReceiptBroadcast(broadcast).payload.text;
    expect(text).not.toContain('\n');
    expect(text).toContain('——…');
    expect(text.endsWith('末'.repeat(40))).toBe(true);

    // 空白尾摘（压缩后为空）→ 无 —— 段（另一 boss 登记，避免幂等键撞车）
    registerBossUplinkReceipt({ bossId: 'boss-2', taskSummary: '第二件', taskId: 't-45', registeredAt: AT });
    const entry2 = consumeBossUplinkReceipt('boss-2', AT)!;
    const broadcast2 = vi.fn();
    notifyBossUplinkCompletion({
      bossId: 'boss-2',
      agentName: 'Vision',
      entry: entry2,
      trigger: 'turn-close',
      turnTextTail: '   \n  ',
      at: AT,
      broadcast: broadcast2,
    });
    expect(lastReceiptBroadcast(broadcast2).payload.text).toBe('Vision 已回复:第二件');
  });

  // ---- 任务41 老板问的（登记带语音会话）：完整回复 + 提分过破例线 ----

  it('任务41 老板问的（T1，登记带会话）→ 文本带完整回复（非末句）+ requested 标记 + 提分 95（SPEAK）', () => {
    registerBossUplinkReceipt({
      bossId: 'boss-1',
      taskSummary: '看下手机验证码',
      taskId: 't-47',
      sessionId: 'sess-1',
      registeredAt: AT,
    });
    const entry = consumeBossUplinkReceipt('boss-1', AT)!;
    // 答案在开头、结尾是客套（2026-10-06 实况形态）；完整回复 > 40 字，末句摘录会丢答案
    const reply = `手机通知共 3 条:①健康提醒 ②掌上生活 ③未接电话，没有验证码。${'这只是一句收尾客套。'.repeat(4)}`;
    expect(reply.length).toBeGreaterThan(40);

    const broadcast = vi.fn();
    const outcome = notifyBossUplinkCompletion({
      bossId: 'boss-1',
      agentName: 'Jarvis',
      entry,
      trigger: 'turn-close',
      turnTextTail: reply,
      at: AT,
      broadcast,
    });

    expect(outcome).toMatchObject({ matched: true, tier: 'SPEAK', score: REQUESTED_RECEIPT_SCORE, forwarded: true });
    const message = lastReceiptBroadcast(broadcast);
    expect(message.payload.requested).toBe(true);
    expect(message.payload.text).toBe(`Jarvis 已回复:看下手机验证码——${reply}`); // 完整回复，不是末句 40 字
    expect(message.payload.observed).toMatchObject({ tier: 'SPEAK', score: REQUESTED_RECEIPT_SCORE });
    const rows = newReceiptRows();
    expect(rows[0]).toMatchObject({ requested: true, tier: 'SPEAK', score: REQUESTED_RECEIPT_SCORE });
  });

  it('任务41 老板问的：超长回复取开头 ≤800 字（安全帽，答案段保留、截断后缀 …）', () => {
    registerBossUplinkReceipt({
      bossId: 'boss-1',
      taskSummary: '写段长报告',
      taskId: 't-48',
      sessionId: 'sess-2',
      registeredAt: AT,
    });
    const entry = consumeBossUplinkReceipt('boss-1', AT)!;
    const reply = `答案开头:一切正常。${'补'.repeat(900)}`;
    const broadcast = vi.fn();
    notifyBossUplinkCompletion({
      bossId: 'boss-1',
      agentName: 'Jarvis',
      entry,
      trigger: 'turn-close',
      turnTextTail: reply,
      at: AT,
      broadcast,
    });
    const text = lastReceiptBroadcast(broadcast).payload.text;
    expect(text).toBe(`Jarvis 已回复:写段长报告——${reply.slice(0, MAX_TURN_FULL_LENGTH)}…`);
  });

  it('任务41 非老板问的（登记无会话）→ requested 缺省，普通回执零变化', () => {
    registerBossUplinkReceipt({ bossId: 'boss-1', taskSummary: '改文案', taskId: 't-49', registeredAt: AT });
    const entry = consumeBossUplinkReceipt('boss-1', AT)!;
    const broadcast = vi.fn();
    notifyBossUplinkCompletion({
      bossId: 'boss-1',
      agentName: 'Jarvis',
      entry,
      trigger: 'turn-close',
      turnTextTail: '已改好',
      at: AT,
      broadcast,
    });
    const message = lastReceiptBroadcast(broadcast);
    expect(message.payload.requested).toBeUndefined();
    expect(message.payload.text).toBe('Jarvis 已回复:改文案——已改好');
  });
});
