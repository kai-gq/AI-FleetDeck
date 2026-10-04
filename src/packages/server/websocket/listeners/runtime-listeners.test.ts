/**
 * 任务10 未覆盖项①（入口 B）+ 任务08② 接线回归：
 * runtime 'complete' 事件 → 委派终结（completeDelegation reason 'turn-complete'）
 *   → 回执订阅播报统一入口 notifyTaskCompletion（source 'runtime'，无委派也走——防漏报）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/index.js', () => ({
  agentService: {
    getAgent: vi.fn(),
    updateAgent: vi.fn(),
  },
  runtimeService: {
    on: vi.fn(),
    setCommandStartedCallback: vi.fn(),
    setSessionUpdateCallback: vi.fn(),
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
  previewToolInput: vi.fn(() => ''),
}));

vi.mock('../handlers/boss-response-handler.js', () => ({
  parseBossDelegation: vi.fn(),
  parseBossSpawn: vi.fn(),
  getBossForSubordinate: vi.fn(),
  completeDelegation: vi.fn(),
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
import { getBossForSubordinate, completeDelegation } from '../handlers/boss-response-handler.js';
import { notifyTaskCompletion } from '../handlers/task-receipt-notifier.js';

/** 取 setupRuntimeListeners 注册到 runtimeService 的 'complete' 回调。 */
function completeListener(): (agentId: string, success: boolean) => void {
  const call = vi.mocked(runtimeService.on).mock.calls.find(([event]) => event === 'complete');
  expect(call, 'runtimeService.on("complete") 应已注册').toBeTruthy();
  return call![1] as (agentId: string, success: boolean) => void;
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
