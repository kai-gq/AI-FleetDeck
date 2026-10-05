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
const mockUpdateAgent = vi.hoisted(() => vi.fn());
const mockGetAgent = vi.hoisted(() => vi.fn(() => ({ status: 'working' })));
const mockIsSameProcess = vi.hoisted(() => vi.fn(async () => true));

vi.mock('../data/index.js', () => ({
  saveRunningProcesses: mockSaveRunningProcesses,
  loadRunningProcesses: mockLoadRunningProcesses,
  isProcessRunning: () => true,
  clearRunningProcesses: vi.fn(),
}));

vi.mock('../services/agent-service.js', () => ({
  getAgent: mockGetAgent,
  updateAgent: mockUpdateAgent,
}));

// Partial mock: keep the real getEffectivePid; stub only the identity probe
// (which would otherwise shell out to PowerShell/CIM against a fake PID).
vi.mock('./runner/process-identity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./runner/process-identity.js')>()),
  isSameProcess: mockIsSameProcess,
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

  it('reports adopted orphans (recoveredPid) as unmanaged and normal processes as managed', async () => {
    const anyRunner = await buildRunnerWithAgent();

    expect(anyRunner.isAgentProcessUnmanaged('a1')).toBe(false);
    expect(anyRunner.isAgentProcessUnmanaged('unknown')).toBe(false);

    anyRunner.activeProcesses.get('a1').recoveredPid = 4242;

    expect(anyRunner.isAgentProcessUnmanaged('a1')).toBe(true);
  });
});

describe('ClaudeRunner — adopted orphan reconnect', () => {
  const saved = {
    agentId: 'a2',
    pid: 4242,
    sessionId: 'sess-9',
    startTime: Date.now() - 60_000,
    lastRequest: { agentId: 'a2', prompt: 'do the thing', workingDir: 'C:/work' },
    agentStatus: 'working',
    provider: 'claude',
  };

  async function buildRunner() {
    const { ClaudeRunner } = await import('./runner.js');
    return new ClaudeRunner({ onSessionId: vi.fn(), onComplete: vi.fn(), onError: vi.fn() } as any) as any;
  }

  it('tracks the orphan with recoveredPid, safe turn state and a detached badge', async () => {
    const anyRunner = await buildRunner();
    mockIsSameProcess.mockResolvedValueOnce(true);

    const ok = await anyRunner.reconnectDetachedProcess('a2', saved);

    expect(ok).toBe(true);
    const tracked = anyRunner.activeProcesses.get('a2');
    expect(tracked.recoveredPid).toBe(4242);
    expect(tracked.sessionId).toBe('sess-9');
    // 'waiting_for_input' + fresh lastActivityTime park the orphan so the
    // idle-watchdog cannot SIGKILL it as "stuck mid-turn" minutes after boot.
    expect(tracked.turnState).toBe('waiting_for_input');
    expect(tracked.isReconnected).toBe(true);
    expect(mockUpdateAgent).toHaveBeenCalledWith('a2', {
      status: 'working',
      currentTask: 'do the thing',
      isDetached: true,
    });
  });

  it('refuses to adopt when the identity probe rejects the PID', async () => {
    const anyRunner = await buildRunner();
    mockIsSameProcess.mockResolvedValueOnce(false);

    const ok = await anyRunner.reconnectDetachedProcess('a2', saved);

    expect(ok).toBe(false);
    expect(anyRunner.activeProcesses.has('a2')).toBe(false);
    expect(mockUpdateAgent).not.toHaveBeenCalled();
  });
});
