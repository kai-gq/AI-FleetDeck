/**
 * Turn/session-id edge persistence for the claude runner ledger.
 *
 * The runner also persists on a 10s timer; these edges shrink the crash
 * window in which an in-flight agent is invisible on disk (and therefore
 * silently dropped by orphan recovery on the next boot).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockSaveRunningProcesses = vi.hoisted(() => vi.fn());
const mockLoadRunningProcesses = vi.hoisted(() => vi.fn(() => []));

vi.mock('../data/index.js', () => ({
  saveRunningProcesses: mockSaveRunningProcesses,
  loadRunningProcesses: mockLoadRunningProcesses,
  isProcessRunning: () => true,
  clearRunningProcesses: vi.fn(),
}));

vi.mock('../services/agent-service.js', () => ({
  getAgent: () => ({ status: 'working' }),
  updateAgent: vi.fn(),
}));

vi.mock('../services/activity-log.js', () => ({
  logProcess: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

async function buildRunnerWithAgent() {
  const { ClaudeRunner } = await import('./runner.js');
  const runner = new ClaudeRunner({
    onSessionId: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
  } as any);

  const anyRunner = runner as any;
  anyRunner.activeProcesses.set('a1', {
    agentId: 'a1',
    startTime: Date.now(),
    process: { pid: 777 },
    lastRequest: {},
    turnState: 'processing',
  });

  return anyRunner;
}

describe('ClaudeRunner — ledger persist on runner edges', () => {
  it('persists immediately when the session id arrives', async () => {
    const anyRunner = await buildRunnerWithAgent();

    anyRunner.bus.emit({ type: 'runner.session_id', agentId: 'a1', sessionId: 'sess-123' });

    expect(mockSaveRunningProcesses).toHaveBeenCalledTimes(1);
    expect(mockSaveRunningProcesses.mock.calls[0][0]).toContainEqual(
      expect.objectContaining({ agentId: 'a1', sessionId: 'sess-123', pid: 777 }),
    );
  });

  it('persists immediately at the step_complete turn boundary', async () => {
    const anyRunner = await buildRunnerWithAgent();
    anyRunner.activeProcesses.get('a1').sessionId = 'sess-123';
    mockSaveRunningProcesses.mockClear();

    anyRunner.bus.emit({ type: 'runner.event', agentId: 'a1', event: { type: 'step_complete' } });

    expect(anyRunner.activeProcesses.get('a1').turnState).toBe('waiting_for_input');
    expect(mockSaveRunningProcesses).toHaveBeenCalledTimes(1);
    expect(mockSaveRunningProcesses.mock.calls[0][0]).toContainEqual(
      expect.objectContaining({ agentId: 'a1', sessionId: 'sess-123' }),
    );
  });
});
