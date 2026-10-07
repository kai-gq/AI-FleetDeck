/**
 * 任务10 未覆盖项①（入口 B）+ 任务08② 接线回归：
 * runtime 'complete' 事件 → 委派终结（completeDelegation reason 'turn-complete'）
 *   → 回执订阅播报统一入口 notifyTaskCompletion（source 'runtime'，无委派也走——防漏报）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/index.js', () => ({
  agentService: {
    getAgent: vi.fn(),
    updateAgent: vi.fn(),
  },
  runtimeService: {
    on: vi.fn(),
    setCommandStartedCallback: vi.fn(),
    setSessionUpdateCallback: vi.fn(),
    getTurnStateForAgent: vi.fn(() => 'waiting_for_input'),
  },
}));

vi.mock('../../utils/index.js', () => ({
  logger: {
    ws: { log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
  },
  formatToolActivity: vi.fn(() => ''),
}));

vi.mock('../../services/activity-log.js', () => ({
  logDelegation: vi.fn(),
  logResourceUsage: vi.fn(),
  logSecurity: vi.fn(),
  logSkill: vi.fn(),
  previewToolInput: vi.fn(() => ''),
}));

vi.mock('../handlers/boss-response-handler.js', () => ({
  parseBossDelegation: vi.fn(),
  parseBossSpawn: vi.fn(),
  getBossForSubordinate: vi.fn(),
  completeDelegation: vi.fn(),
  // 任务40：registry 的 collectBossUplinkState 读在飞委派列表（测试默认无在飞）
  listActiveDelegations: vi.fn(() => []),
}));

vi.mock('../handlers/task-receipt-notifier.js', () => ({
  notifyTaskCompletion: vi.fn(() => ({
    matched: false,
    duplicate: false,
    tier: 'SILENT',
    reason: 'low_relevance',
    score: 0,
    forwarded: false,
  })),
  // 任务40：上行回执交付（断言见「任务40」describe）
  notifyBossUplinkCompletion: vi.fn(() => ({
    matched: true,
    duplicate: false,
    tier: 'PREPARE',
    reason: 'batched',
    score: 70,
    forwarded: true,
  })),
}));

vi.mock('../handlers/agent-handler.js', () => ({
  parseAllFormats: vi.fn(() => []),
}));

vi.mock('../../claude/backend.js', () => ({
  parseContextOutput: vi.fn(() => null),
}));

vi.mock('../../../shared/model-fallback.js', () => ({
  detectModelFallback: vi.fn(() => null),
  formatModelName: vi.fn((m: string) => m),
}));

vi.mock('../../../shared/shell-file-writes.js', () => ({
  getShellFileWrites: vi.fn(() => []),
}));

vi.mock('../../services/subagent-jsonl-watcher.js', () => ({
  startWatching: vi.fn(),
  stopWatching: vi.fn(),
  isWatching: vi.fn(() => false),
  getSubagentsDir: vi.fn(() => '/tmp/subagents'),
}));

vi.mock('../../services/background-tasks.js', () => ({
  getBackgroundTasksForAgent: vi.fn(() => []),
  onBackgroundTasksChanged: vi.fn(),
}));

vi.mock('../../services/bash-toolcall-registry.js', () => ({
  registerBashToolCall: vi.fn(),
  completeBashToolCall: vi.fn(),
  clearBashToolCalls: vi.fn(),
}));

import { setupRuntimeListeners } from './runtime-listeners.js';
import { agentService, runtimeService } from '../../services/index.js';
import { getBossForSubordinate, completeDelegation, listActiveDelegations } from '../handlers/boss-response-handler.js';
import { notifyTaskCompletion, notifyBossUplinkCompletion } from '../handlers/task-receipt-notifier.js';
import {
  hasBossUplinkReceipt,
  registerBossUplinkReceipt,
  resetBossUplinksForTests,
} from '../handlers/boss-uplink-receipt-registry.js';
import { registerPendingReceipt, resetPendingReceiptsForTests } from '../handlers/pending-receipt-registry.js';
import { logSkill, logDelegation } from '../../services/activity-log.js';
import { getBackgroundTasksForAgent } from '../../services/background-tasks.js';

/** 取 setupRuntimeListeners 注册到 runtimeService 的 'complete' 回调。 */
function completeListener(): (agentId: string, success: boolean) => void {
  const call = vi.mocked(runtimeService.on).mock.calls.find(([event]) => event === 'complete');
  expect(call, 'runtimeService.on("complete") 应已注册').toBeTruthy();
  return call![1] as (agentId: string, success: boolean) => void;
}

/** 取 setupRuntimeListeners 注册到 runtimeService 的 'event' 回调。 */
function eventListener(): (agentId: string, event: any) => void {
  const call = vi.mocked(runtimeService.on).mock.calls.find(([event]) => event === 'event');
  expect(call, 'runtimeService.on("event") 应已注册').toBeTruthy();
  return call![1] as (agentId: string, event: any) => void;
}

describe('runtime complete 入口：委派终结 + 回执订阅播报接线', () => {
  const broadcast = vi.fn();
  const sendActivity = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    setupRuntimeListeners({ broadcast, sendActivity });
  });

  it('有委派：广播 agent_task_completed + completeDelegation(turn-complete) + 回执通知 source:runtime', () => {
    vi.mocked(getBossForSubordinate).mockReturnValue({
      bossId: 'boss-1',
      taskDescription: '实现登录页',
      taskId: 't-1',
    } as any);
    vi.mocked(agentService.getAgent).mockReturnValue({ id: 'agent-1', name: 'Builder One' } as any);

    completeListener()('agent-1', true);

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent_task_completed',
        payload: { bossId: 'boss-1', subordinateId: 'agent-1', success: true },
      }),
    );
    expect(completeDelegation).toHaveBeenCalledWith('agent-1', { success: true, reason: 'turn-complete' });
    // 回执统一入口：复用同一 ctx.broadcast 出口，agentName 取自 agentService
    expect(notifyTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        subordinateId: 'agent-1',
        agentName: 'Builder One',
        success: true,
        source: 'runtime',
        broadcast,
      }),
    );
  });

  it('无委派但挂靠 boss（登记已清/过期）：不终结委派、不广播完成给 boss，但回执通知仍触发（防漏报）', () => {
    vi.mocked(getBossForSubordinate).mockReturnValue(undefined as any);
    vi.mocked(agentService.getAgent).mockReturnValue({ id: 'agent-9', name: 'Flyer Nine', bossId: 'boss-1' } as any);

    completeListener()('agent-9', false);

    expect(completeDelegation).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_task_completed' }));
    // 任务08②防漏报：未跟踪完成同样进回执管线（未匹配会退化为通用完成句，不静默）
    expect(notifyTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        subordinateId: 'agent-9',
        agentName: 'Flyer Nine',
        success: false,
        source: 'runtime',
      }),
    );
  });

  it('boss 自身回合 / 独立 agent（无委派无 bossId）：不进回执管线（避免每回合「完成任务」噪音）', () => {
    vi.mocked(getBossForSubordinate).mockReturnValue(undefined as any);
    vi.mocked(agentService.getAgent).mockReturnValue({ id: 'boss-1', name: 'Jarvis', isBoss: true } as any);

    completeListener()('boss-1', true);

    expect(completeDelegation).not.toHaveBeenCalled();
    expect(notifyTaskCompletion).not.toHaveBeenCalled();
  });
});

describe('HC-B6：step_complete 延迟闭包（stdin 常驻模式回合结束补闭包）', () => {
  const broadcast = vi.fn();
  const sendActivity = vi.fn();
  const liveDelegation = { bossId: 'boss-1', taskDescription: '写周报', taskId: 't-b6', decisionId: 'del-1' };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(runtimeService.getTurnStateForAgent).mockReturnValue('waiting_for_input');
    vi.mocked(getBackgroundTasksForAgent).mockReturnValue([]);
    setupRuntimeListeners({ broadcast, sendActivity });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('回合真结束（waiting_for_input + idle + 无后台任务）→ 延迟后补走完成漏斗：广播 + closed 埋点 + completeDelegation + 回执', () => {
    vi.mocked(getBossForSubordinate).mockReturnValue(liveDelegation as any);
    vi.mocked(agentService.getAgent).mockReturnValue({ id: 'agent-1', name: 'Builder One', status: 'idle', provider: 'claude' } as any);

    eventListener()('agent-1', { type: 'step_complete' });
    expect(completeDelegation).not.toHaveBeenCalled(); // 延迟窗内不闭包

    vi.advanceTimersByTime(2500);

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent_task_completed',
        payload: { bossId: 'boss-1', subordinateId: 'agent-1', success: true },
      }),
    );
    expect(logDelegation).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'closed', toAgentId: 'agent-1', taskId: 't-b6', status: 'completed' }),
    );
    expect(completeDelegation).toHaveBeenCalledWith('agent-1', { success: true, reason: 'turn-complete' });
    expect(notifyTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ subordinateId: 'agent-1', success: true, source: 'runtime' }),
    );
  });

  it('排队消息被排干起了新回合（turnState=processing）→ 不闭包（B6 机理：不能把新回合误判为结束）', () => {
    vi.mocked(getBossForSubordinate).mockReturnValue(liveDelegation as any);
    vi.mocked(agentService.getAgent).mockReturnValue({ id: 'agent-1', name: 'Builder One', status: 'working', provider: 'claude' } as any);
    vi.mocked(runtimeService.getTurnStateForAgent).mockReturnValue('processing');

    eventListener()('agent-1', { type: 'step_complete' });
    vi.advanceTimersByTime(2500);

    expect(completeDelegation).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'agent_task_completed' }));
    expect(notifyTaskCompletion).not.toHaveBeenCalled();
  });

  it('后台任务未结束 → 不闭包（其 <task-notification> 会唤新回合）', () => {
    vi.mocked(getBossForSubordinate).mockReturnValue(liveDelegation as any);
    vi.mocked(agentService.getAgent).mockReturnValue({ id: 'agent-1', status: 'idle', provider: 'claude' } as any);
    vi.mocked(getBackgroundTasksForAgent).mockReturnValue([{ toolUseId: 'bg-1' }] as any);

    eventListener()('agent-1', { type: 'step_complete' });
    vi.advanceTimersByTime(2500);

    expect(completeDelegation).not.toHaveBeenCalled();
  });

  it('decisionId 已换（闭包前来了新委派）→ 旧判定退出，不误闭新委派', () => {
    vi.mocked(getBossForSubordinate)
      .mockReturnValueOnce(liveDelegation as any) // step_complete 调度时
      .mockReturnValue({ ...liveDelegation, decisionId: 'del-2' } as any); // 触发时已是新委派
    vi.mocked(agentService.getAgent).mockReturnValue({ id: 'agent-1', status: 'idle', provider: 'claude' } as any);

    eventListener()('agent-1', { type: 'step_complete' });
    vi.advanceTimersByTime(2500);

    expect(completeDelegation).not.toHaveBeenCalled();
  });

  it('codex 常驻跨回合换进程 → 由退出路径闭包，step_complete 不闭', () => {
    vi.mocked(getBossForSubordinate).mockReturnValue(liveDelegation as any);
    vi.mocked(agentService.getAgent).mockReturnValue({ id: 'agent-1', status: 'idle', provider: 'codex' } as any);

    eventListener()('agent-1', { type: 'step_complete' });
    vi.advanceTimersByTime(2500);

    expect(completeDelegation).not.toHaveBeenCalled();
  });

  it('error 态回合结束 → 按失败闭包（success=false）', () => {
    vi.mocked(getBossForSubordinate).mockReturnValue(liveDelegation as any);
    vi.mocked(agentService.getAgent).mockReturnValue({ id: 'agent-1', status: 'error', provider: 'claude' } as any);

    eventListener()('agent-1', { type: 'step_complete' });
    vi.advanceTimersByTime(2500);

    expect(completeDelegation).toHaveBeenCalledWith('agent-1', { success: false, reason: 'turn-complete' });
  });

  it('无 live 委派 → 不调度（调度期仅一次追踪读取，延迟后无动作）', () => {
    vi.mocked(getBossForSubordinate).mockReturnValue(undefined as any);
    vi.mocked(agentService.getAgent).mockReturnValue({ id: 'agent-9', status: 'idle' } as any);

    eventListener()('agent-9', { type: 'step_complete' });
    vi.advanceTimersByTime(2500);

    expect(vi.mocked(getBossForSubordinate)).toHaveBeenCalledTimes(1); // 仅调度期读取，未安排延迟复核
    expect(completeDelegation).not.toHaveBeenCalled();
    expect(notifyTaskCompletion).not.toHaveBeenCalled();
  });
});

describe('任务40：上行回执链接线（T1 回合闭包 / T2 链路收口）', () => {
  const broadcast = vi.fn();
  const sendActivity = vi.fn();
  const bossAgent = { id: 'boss-1', name: 'Jarvis', isBoss: true, status: 'idle', provider: 'claude' };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(runtimeService.getTurnStateForAgent).mockReturnValue('waiting_for_input');
    vi.mocked(getBackgroundTasksForAgent).mockReturnValue([]);
    vi.mocked(listActiveDelegations).mockReturnValue([]);
    resetBossUplinksForTests();
    resetPendingReceiptsForTests();
    setupRuntimeListeners({ broadcast, sendActivity });
    registerBossUplinkReceipt({ bossId: 'boss-1', taskSummary: '把官网文案改好', taskId: 't-40', registeredAt: Date.now() });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetBossUplinksForTests();
    resetPendingReceiptsForTests();
  });

  it('T1 主管自办：回合闭包（2500ms 复核通过）→ 交付「已回复」上行回执（尾摘=回合末句）+ 消费即删', () => {
    vi.mocked(agentService.getAgent).mockReturnValue(bossAgent as any);

    eventListener()('boss-1', { type: 'step_complete', resultText: '文案已经改好了，等你验收' });
    expect(notifyBossUplinkCompletion).not.toHaveBeenCalled(); // 延迟窗内不交付

    vi.advanceTimersByTime(2500);

    expect(notifyBossUplinkCompletion).toHaveBeenCalledTimes(1);
    expect(notifyBossUplinkCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        bossId: 'boss-1',
        agentName: 'Jarvis',
        trigger: 'turn-close',
        turnTextTail: '文案已经改好了，等你验收',
        broadcast,
        entry: expect.objectContaining({ taskSummary: '把官网文案改好', taskId: 't-40' }),
      }),
    );
    expect(hasBossUplinkReceipt('boss-1')).toBe(false); // 消费即删
  });

  it('T1 链路有在飞委派 → 不消费不交付（留待 T2 收口）', () => {
    vi.mocked(agentService.getAgent).mockReturnValue(bossAgent as any);
    vi.mocked(listActiveDelegations).mockReturnValue([
      { subordinateId: 'agent-1', bossId: 'boss-1', taskDescription: 'x' },
    ] as any);

    eventListener()('boss-1', { type: 'step_complete', resultText: '我已经安排下去了' });
    vi.advanceTimersByTime(2500);

    expect(notifyBossUplinkCompletion).not.toHaveBeenCalled();
    expect(hasBossUplinkReceipt('boss-1')).toBe(true); // 未消费，留待收口/下次触发
  });

  it('T1 有未匹配下属回执 → 不消费（链路未收口）', () => {
    vi.mocked(agentService.getAgent).mockReturnValue(bossAgent as any);
    registerPendingReceipt({ targetAgentId: 'agent-2', bossId: 'boss-1', taskSummary: '别的活' });

    eventListener()('boss-1', { type: 'step_complete', resultText: 'ok' });
    vi.advanceTimersByTime(2500);

    expect(notifyBossUplinkCompletion).not.toHaveBeenCalled();
    expect(hasBossUplinkReceipt('boss-1')).toBe(true);
  });

  it('T1 复核时新回合已在跑（turnState=processing）→ 不交付（不能把新回合误判为结束）', () => {
    vi.mocked(agentService.getAgent).mockReturnValue(bossAgent as any);
    vi.mocked(runtimeService.getTurnStateForAgent).mockReturnValue('processing');

    eventListener()('boss-1', { type: 'step_complete', resultText: 'ok' });
    vi.advanceTimersByTime(2500);

    expect(notifyBossUplinkCompletion).not.toHaveBeenCalled();
    expect(hasBossUplinkReceipt('boss-1')).toBe(true);
  });

  it('T1 后台任务未结束 / error 态 → 不交付（宁缺勿误报）', () => {
    vi.mocked(agentService.getAgent).mockReturnValue(bossAgent as any);
    vi.mocked(getBackgroundTasksForAgent).mockReturnValue([{ toolUseId: 'bg-1' }] as any);

    eventListener()('boss-1', { type: 'step_complete', resultText: 'ok' });
    vi.advanceTimersByTime(2500);
    expect(notifyBossUplinkCompletion).not.toHaveBeenCalled();

    // 后台任务结束，但 agent 落 error 态：仍不交付（失败面由 09·B 播报覆盖）
    vi.mocked(getBackgroundTasksForAgent).mockReturnValue([]);
    vi.mocked(agentService.getAgent).mockReturnValue({ ...bossAgent, status: 'error' } as any);
    eventListener()('boss-1', { type: 'step_complete', resultText: 'ok' });
    vi.advanceTimersByTime(2500);
    expect(notifyBossUplinkCompletion).not.toHaveBeenCalled();
    expect(hasBossUplinkReceipt('boss-1')).toBe(true);
  });

  it('T1 闭包窗内新派活（registeredAt 刷新）→ 旧判定退出，不误消费新登记', () => {
    vi.mocked(agentService.getAgent).mockReturnValue(bossAgent as any);

    eventListener()('boss-1', { type: 'step_complete', resultText: 'ok' });
    registerBossUplinkReceipt({ bossId: 'boss-1', taskSummary: '新的派活', taskId: 't-41', registeredAt: Date.now() + 100 });
    vi.advanceTimersByTime(2500);

    expect(notifyBossUplinkCompletion).not.toHaveBeenCalled();
    expect(hasBossUplinkReceipt('boss-1')).toBe(true); // 新登记仍在，未被旧闭包消费
  });

  it('T1 开关 TC_VOICE_BOSS_RECEIPT=0 → 调度入口早退（零交付）', () => {
    vi.stubEnv('TC_VOICE_BOSS_RECEIPT', '0');
    vi.mocked(agentService.getAgent).mockReturnValue(bossAgent as any);

    eventListener()('boss-1', { type: 'step_complete', resultText: 'ok' });
    vi.advanceTimersByTime(2500);

    expect(notifyBossUplinkCompletion).not.toHaveBeenCalled();
    expect(hasBossUplinkReceipt('boss-1')).toBe(true); // 触发侧零消费（登记侧由 vcs 同开关挡）
  });

  it('T1 子代理 step_complete（parentToolUseId）→ 不调度（不代表父回合结束）', () => {
    vi.mocked(agentService.getAgent).mockReturnValue(bossAgent as any);

    eventListener()('boss-1', { type: 'step_complete', parentToolUseId: 'tu-1', resultText: '子代理输出' });
    vi.advanceTimersByTime(2500);

    expect(notifyBossUplinkCompletion).not.toHaveBeenCalled();
    expect(hasBossUplinkReceipt('boss-1')).toBe(true);
  });

  it('T2 转委派收口：下属完成（委派存在）→ 交付「已办结」+ 消费即删（重复完成不重播）', () => {
    vi.mocked(getBossForSubordinate).mockReturnValue({ bossId: 'boss-1', taskDescription: '发版', taskId: 't-1' } as any);
    vi.mocked(agentService.getAgent).mockImplementation((id: string) =>
      (id === 'boss-1' ? bossAgent : { id: 'agent-1', name: 'Builder One', status: 'idle' }) as any,
    );

    completeListener()('agent-1', true);

    expect(notifyBossUplinkCompletion).toHaveBeenCalledTimes(1);
    expect(notifyBossUplinkCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ bossId: 'boss-1', agentName: 'Jarvis', trigger: 'subordinate-complete', broadcast }),
    );
    expect(hasBossUplinkReceipt('boss-1')).toBe(false);

    // 重复完成事件（第二入口/重复触发）→ 消费即删，不再交付
    completeListener()('agent-1', true);
    expect(notifyBossUplinkCompletion).toHaveBeenCalledTimes(1);
  });

  it('T2 主管回合仍 processing → 不抢跑（留给 T1 收尾交付）', () => {
    vi.mocked(getBossForSubordinate).mockReturnValue({ bossId: 'boss-1', taskDescription: '发版', taskId: 't-1' } as any);
    vi.mocked(agentService.getAgent).mockReturnValue({ id: 'agent-1', name: 'Builder One' } as any);
    vi.mocked(runtimeService.getTurnStateForAgent).mockReturnValue('processing');

    completeListener()('agent-1', true);

    expect(notifyBossUplinkCompletion).not.toHaveBeenCalled();
    expect(hasBossUplinkReceipt('boss-1')).toBe(true); // 未消费，留待 T1
  });

  it('T2 无上行登记（boss 自办已交付/未派活）的下属完成 → 零交付（既有链路零感知）', () => {
    resetBossUplinksForTests(); // 清掉 beforeEach 的登记
    vi.mocked(getBossForSubordinate).mockReturnValue({ bossId: 'boss-1', taskDescription: '发版', taskId: 't-1' } as any);
    vi.mocked(agentService.getAgent).mockReturnValue({ id: 'agent-1', name: 'Builder One' } as any);

    completeListener()('agent-1', true);

    expect(notifyBossUplinkCompletion).not.toHaveBeenCalled();
  });
});

describe('任务19·A 埋点：Skill 技能调用（系统活动 8）', () => {
  const broadcast = vi.fn();
  const sendActivity = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    setupRuntimeListeners({ broadcast, sendActivity });
  });

  it('Skill tool_start → logSkill(invoked, 技能名/入参摘要)；tool_result 配对记 completed', () => {
    vi.mocked(agentService.getAgent).mockReturnValue({ id: 'ag-skill', sessionId: 'sess-skill' } as any);
    const onEvent = eventListener();

    onEvent('ag-skill', {
      type: 'tool_start',
      toolName: 'Skill',
      toolUseId: 'tu-skill-1',
      toolInput: { skill: 'video-extract', args: { url: 'https://x' } },
    });
    expect(logSkill).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'invoked',
      skill: 'video-extract',
      agentId: 'ag-skill',
      sessionId: 'sess-skill',
    }));

    onEvent('ag-skill', { type: 'tool_result', toolName: 'Skill', toolUseId: 'tu-skill-1', toolOutput: 'ok' });
    expect(logSkill).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'completed', skill: 'video-extract', agentId: 'ag-skill', ok: true,
    }));
    expect(logSkill).toHaveBeenCalledTimes(2);
  });

  it('结果带错误前缀 → best-effort 记 failed；name 字段兼容；子代理 Skill 事件不记', () => {
    vi.mocked(agentService.getAgent).mockReturnValue({ id: 'ag-skill', sessionId: 'sess-skill' } as any);
    const onEvent = eventListener();

    onEvent('ag-skill', { type: 'tool_start', toolName: 'Skill', toolInput: { name: 'bad-skill' } });
    onEvent('ag-skill', { type: 'tool_result', toolName: 'Skill', toolOutput: 'Error: skill not found' });
    expect(logSkill).toHaveBeenCalledWith(expect.objectContaining({ phase: 'failed', skill: 'bad-skill', ok: false }));

    const before = vi.mocked(logSkill).mock.calls.length;
    onEvent('ag-skill', {
      type: 'tool_start', toolName: 'Skill', parentToolUseId: 'tu-parent', toolInput: { skill: 'sub-skill' },
    });
    expect(vi.mocked(logSkill).mock.calls.length).toBe(before);
  });
});
