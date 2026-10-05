/**
 * Startup orphan recovery. The behavior under test:
 *  - a persisted entry whose PID is STILL ALIVE is adopted (async, off a 1s
 *    delay, behind an identity probe) instead of being silently dropped —
 *    the old code logged it and deleted the ledger entry, leaving the
 *    process running with no UI handle;
 *  - adoption failures clear a leftover isDetached badge;
 *  - dead entries keep the existing resume behavior;
 *  - `TIDE_RECOVER_LIVE_ORPHANS=0` restores the legacy drop-it behavior;
 *  - other providers' entries in the shared ledger are never touched;
 *  - tmux reconnection still works.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveProcess } from '../types.js';
import type { RunningProcessInfo } from '../../data/index.js';
import type { RunnerRequest } from '../types.js';

const mockSaveRunningProcesses = vi.hoisted(() => vi.fn());
const mockLoadRunningProcesses = vi.hoisted(() => vi.fn(() => [] as RunningProcessInfo[]));
const mockIsProcessRunning = vi.hoisted(() => vi.fn(() => false));
const mockClearRunningProcesses = vi.hoisted(() => vi.fn());
const mockGetAgent = vi.hoisted(() => vi.fn());
const mockUpdateAgent = vi.hoisted(() => vi.fn());
const mockLogProcess = vi.hoisted(() => vi.fn());
const mockIsTmuxEnabled = vi.hoisted(() => vi.fn(() => false));
const mockHasTmuxSession = vi.hoisted(() => vi.fn(() => false));
const mockListAgentTmuxSessions = vi.hoisted(() => vi.fn(() => [] as string[]));
const mockKillTmuxSession = vi.hoisted(() => vi.fn());

vi.mock('../../data/index.js', () => ({
  saveRunningProcesses: mockSaveRunningProcesses,
  loadRunningProcesses: mockLoadRunningProcesses,
  isProcessRunning: mockIsProcessRunning,
  clearRunningProcesses: mockClearRunningProcesses,
}));

vi.mock('../../services/agent-service.js', () => ({
  getAgent: mockGetAgent,
  updateAgent: mockUpdateAgent,
}));

vi.mock('../../services/activity-log.js', () => ({
  logProcess: mockLogProcess,
}));

vi.mock('./tmux-helper.js', () => ({
  hasTmuxSession: mockHasTmuxSession,
  isTmuxEnabled: mockIsTmuxEnabled,
  killTmuxSession: mockKillTmuxSession,
  listAgentTmuxSessions: mockListAgentTmuxSessions,
  tmuxLogPath: (agentId: string) => `/logs/${agentId}.log`,
  tmuxSessionName: (agentId: string) => `tc-${agentId}`,
}));

const AGENT = { id: 'a1', isDetached: false, provider: 'claude', cwd: '/work' };

function entry(over: Partial<RunningProcessInfo> = {}): RunningProcessInfo {
  return {
    agentId: 'a1',
    pid: 4242,
    sessionId: 'sess-1',
    startTime: Date.now() - 60_000,
    lastRequest: { agentId: 'a1', prompt: 'do the thing', workingDir: '/work' } as RunnerRequest,
    agentStatus: 'working',
    provider: 'claude',
    ...over,
  };
}

async function buildStore(over: {
  run?: (request: RunnerRequest) => Promise<void>;
  reconnectTmux?: (agentId: string, logFile: string, offset: number, saved?: RunningProcessInfo) => void;
  reconnectDetached?: (agentId: string, saved: RunningProcessInfo) => Promise<boolean>;
  activeProcesses?: Map<string, ActiveProcess>;
} = {}) {
  const { RunnerRecoveryStore } = await import('./recovery-store.js');
  return new RunnerRecoveryStore({
    backend: { name: 'claude', supportsSessionResume: () => true } as any,
    activeProcesses: over.activeProcesses ?? new Map<string, ActiveProcess>(),
    run: over.run ?? vi.fn(async () => {}),
    reconnectTmux: over.reconnectTmux,
    reconnectDetached: over.reconnectDetached,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockLoadRunningProcesses.mockReturnValue([]);
  mockIsProcessRunning.mockReturnValue(false);
  mockIsTmuxEnabled.mockReturnValue(false);
  mockHasTmuxSession.mockReturnValue(false);
  mockListAgentTmuxSessions.mockReturnValue([]);
  mockGetAgent.mockReturnValue(AGENT);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.TIDE_RECOVER_LIVE_ORPHANS;
});

describe('recoverOrphanedProcesses — live orphan adoption', () => {
  it('adopts a live orphan off the recovery delay and keeps it in the ledger meanwhile', async () => {
    const reconnectDetached = vi.fn(async () => true);
    mockLoadRunningProcesses.mockReturnValue([entry()]);
    mockIsProcessRunning.mockReturnValue(true);

    const store = await buildStore({ reconnectDetached });
    const persistSpy = vi.spyOn(store, 'persistRunningProcesses');

    store.recoverOrphanedProcesses();

    // Synchronous rewrite must PRESERVE the to-adopt entry on disk — if the
    // server dies again before the async adoption lands, the next boot can
    // still find it.
    expect(mockSaveRunningProcesses).toHaveBeenCalledWith([
      expect.objectContaining({ agentId: 'a1', pid: 4242 }),
    ]);
    expect(reconnectDetached).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);

    expect(reconnectDetached).toHaveBeenCalledWith('a1', expect.objectContaining({ agentId: 'a1', pid: 4242 }));
    expect(persistSpy).toHaveBeenCalled();
    // The agent now exists and was adopted — no cleanup allowed.
    expect(mockUpdateAgent).not.toHaveBeenCalled();
  });

  it('clears a leftover isDetached badge when adoption fails', async () => {
    const reconnectDetached = vi.fn(async () => false);
    mockLoadRunningProcesses.mockReturnValue([entry()]);
    mockIsProcessRunning.mockReturnValue(true);
    mockGetAgent.mockReturnValue({ ...AGENT, isDetached: true });

    const store = await buildStore({ reconnectDetached });
    store.recoverOrphanedProcesses();
    await vi.advanceTimersByTimeAsync(1000);

    expect(reconnectDetached).toHaveBeenCalledTimes(1);
    expect(mockUpdateAgent).toHaveBeenCalledWith('a1', { isDetached: false });
  });

  it('survives a throwing adoption hook', async () => {
    const reconnectDetached = vi.fn(async () => {
      throw new Error('probe exploded');
    });
    mockLoadRunningProcesses.mockReturnValue([entry()]);
    mockIsProcessRunning.mockReturnValue(true);

    const store = await buildStore({ reconnectDetached });
    store.recoverOrphanedProcesses();
    await vi.advanceTimersByTimeAsync(1000);

    // The throw is swallowed and treated as "not adopted" → badge cleanup.
    expect(mockUpdateAgent).not.toHaveBeenCalled(); // AGENT.isDetached === false
  });

  it('drops live orphans without adopting them when TIDE_RECOVER_LIVE_ORPHANS=0', async () => {
    process.env.TIDE_RECOVER_LIVE_ORPHANS = '0';
    const reconnectDetached = vi.fn(async () => true);
    mockLoadRunningProcesses.mockReturnValue([entry()]);
    mockIsProcessRunning.mockReturnValue(true);

    const store = await buildStore({ reconnectDetached });
    store.recoverOrphanedProcesses();
    await vi.advanceTimersByTimeAsync(3000);

    // Legacy behavior: the entry is consumed from the ledger, never adopted.
    expect(reconnectDetached).not.toHaveBeenCalled();
    expect(mockSaveRunningProcesses).not.toHaveBeenCalled();
    expect(mockClearRunningProcesses).toHaveBeenCalled();
  });

  it('never touches other providers’ ledger entries', async () => {
    const codexEntry = entry({ agentId: 'c1', provider: 'codex', pid: 5555 });
    mockLoadRunningProcesses.mockReturnValue([codexEntry, entry()]);
    mockIsProcessRunning.mockReturnValue(true);

    const store = await buildStore({ reconnectDetached: vi.fn(async () => true) });
    store.recoverOrphanedProcesses();

    expect(mockSaveRunningProcesses.mock.calls[0][0]).toEqual([
      expect.objectContaining({ agentId: 'c1', provider: 'codex' }),
      expect.objectContaining({ agentId: 'a1', provider: 'claude' }),
    ]);
  });
});

describe('recoverOrphanedProcesses — dead process resume (regression)', () => {
  it('resumes a session that was working when persisted', async () => {
    const run = vi.fn(async () => {});
    mockLoadRunningProcesses.mockReturnValue([entry()]);
    mockIsProcessRunning.mockReturnValue(false);

    const store = await buildStore({ run, reconnectDetached: vi.fn(async () => true) });
    store.recoverOrphanedProcesses();
    await vi.advanceTimersByTimeAsync(2000);

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'a1', sessionId: 'sess-1', prompt: 'continue' })
    );
  });

  it('does not resume an agent that was idle when persisted', async () => {
    const run = vi.fn(async () => {});
    mockLoadRunningProcesses.mockReturnValue([entry({ agentStatus: 'idle' })]);
    mockIsProcessRunning.mockReturnValue(false);

    const store = await buildStore({ run });
    store.recoverOrphanedProcesses();
    await vi.advanceTimersByTimeAsync(2000);

    expect(run).not.toHaveBeenCalled();
  });
});

describe('recoverOrphanedProcesses — tmux reconnection (regression)', () => {
  it('reconnects a live tmux session at the persisted offset', async () => {
    const reconnectTmux = vi.fn();
    mockIsTmuxEnabled.mockReturnValue(true);
    mockHasTmuxSession.mockReturnValue(true);
    mockLoadRunningProcesses.mockReturnValue([entry({ tmuxSession: 'tc-a1', tmuxLogOffset: 321 })]);

    const store = await buildStore({ reconnectTmux });
    store.recoverOrphanedProcesses();
    await vi.advanceTimersByTimeAsync(1000);

    expect(reconnectTmux).toHaveBeenCalledWith('a1', '/logs/a1.log', 321, expect.objectContaining({ agentId: 'a1' }));
  });
});
