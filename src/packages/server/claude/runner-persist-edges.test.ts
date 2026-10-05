/**
 * Turn/session-id edge persistence for the claude runner ledger.
 *
 * The runner also persists on a 10s timer; these edges shrink the crash
 * window in which an in-flight agent is invisible on disk (and therefore
 * silently dropped by orphan recovery on the next boot).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';

const mockSaveRunningProcesses = vi.hoisted(() => vi.fn());
const mockLoadRunningProcesses = vi.hoisted(() => vi.fn(() => []));
const mockUpdateAgent = vi.hoisted(() => vi.fn());
const mockGetAgent = vi.hoisted(() => vi.fn(() => ({ status: 'working' })));
const mockIsSameProcess = vi.hoisted(() => vi.fn(async () => true));
const mockIsProcessRunning = vi.hoisted(() => vi.fn(() => true));
const mockGetProjectDir = vi.hoisted(() => vi.fn((cwd: string) => `/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}`));
const mockWatcherInstances = vi.hoisted(
  () => [] as Array<{ opts: any; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>,
);

vi.mock('../data/index.js', () => ({
  saveRunningProcesses: mockSaveRunningProcesses,
  loadRunningProcesses: mockLoadRunningProcesses,
  isProcessRunning: mockIsProcessRunning,
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

// The adoption path mounts a transcript watcher for claude orphans; stub the
// class so tests observe mount options / start / stop without a real tailer.
vi.mock('./interactive/interactive-jsonl-watcher.js', () => {
  class MockInteractiveJsonlWatcher {
    start = vi.fn();
    stop = vi.fn();
    drain = vi.fn();
    constructor(public opts: any) {
      mockWatcherInstances.push(this);
    }
  }
  return { InteractiveJsonlWatcher: MockInteractiveJsonlWatcher };
});

// Resolve the transcript path without depending on a real HOME/projects layout.
vi.mock('./session-loader.js', () => ({
  getProjectDir: mockGetProjectDir,
}));

vi.mock('../services/activity-log.js', () => ({
  logProcess: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations, including mockReturnValue overrides.
  mockIsProcessRunning.mockReturnValue(true);
  mockWatcherInstances.length = 0;
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
    return new ClaudeRunner({
      onEvent: vi.fn(),
      onOutput: vi.fn(),
      onSessionId: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
    } as any) as any;
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

  it('re-sources the orphan from its session transcript via a JSONL watcher', async () => {
    const anyRunner = await buildRunner();
    mockIsSameProcess.mockResolvedValueOnce(true);

    const ok = await anyRunner.reconnectDetachedProcess('a2', saved);

    expect(ok).toBe(true);
    expect(mockGetProjectDir).toHaveBeenCalledWith('C:/work');
    expect(mockWatcherInstances).toHaveLength(1);
    const watcher = mockWatcherInstances[0];
    expect(watcher.opts.agentId).toBe('a2');
    expect(watcher.opts.jsonlPath).toBe(path.join(mockGetProjectDir('C:/work'), 'sess-9.jsonl'));
    // Only lines appended from now on — history replay would flood the UI.
    expect(watcher.opts.startAtEnd).toBe(true);
    expect(watcher.start).toHaveBeenCalledTimes(1);
  });

  it('routes transcript events through the stdout pipeline (turn end flips state and persists)', async () => {
    const anyRunner = await buildRunner();
    mockIsSameProcess.mockResolvedValueOnce(true);
    await anyRunner.reconnectDetachedProcess('a2', saved);
    const tracked = anyRunner.activeProcesses.get('a2');
    expect(tracked.turnState).toBe('waiting_for_input');

    const watcher = mockWatcherInstances[0];
    mockSaveRunningProcesses.mockClear();

    // Mid-turn evidence flips the conservative park back to processing...
    watcher.opts.onEvent({ type: 'text', text: 'hi' });
    expect(tracked.turnState).toBe('processing');

    // ...and the transcript's turn boundary flips it back + refreshes the ledger.
    watcher.opts.onEvent({ type: 'step_complete' });
    expect(tracked.turnState).toBe('waiting_for_input');
    expect(mockSaveRunningProcesses).toHaveBeenCalled();
  });

  it('keeps the activity clock fresh from transcript writes', async () => {
    const anyRunner = await buildRunner();
    mockIsSameProcess.mockResolvedValueOnce(true);
    await anyRunner.reconnectDetachedProcess('a2', saved);
    const tracked = anyRunner.activeProcesses.get('a2');
    tracked.lastActivityTime = 0;

    mockWatcherInstances[0].opts.onActivity();

    expect(tracked.lastActivityTime).toBeGreaterThan(0);
  });

  it('stops the transcript watcher via sideChannelStop', async () => {
    const anyRunner = await buildRunner();
    mockIsSameProcess.mockResolvedValueOnce(true);
    await anyRunner.reconnectDetachedProcess('a2', saved);
    const tracked = anyRunner.activeProcesses.get('a2');
    expect(typeof tracked.sideChannelStop).toBe('function');

    tracked.sideChannelStop();

    expect(mockWatcherInstances[0].stop).toHaveBeenCalledTimes(1);
  });

  it('stops the transcript watcher when isRunning reaps a dead adopted orphan', async () => {
    // A 20s status poll can beat the 5s watchdog to a dead PID; dropping the
    // record there must not strand the watcher's 100ms tailer.
    const anyRunner = await buildRunner();
    mockIsSameProcess.mockResolvedValueOnce(true);
    await anyRunner.reconnectDetachedProcess('a2', saved);
    mockWatcherInstances[0].stop.mockClear();

    mockIsProcessRunning.mockReturnValue(false);
    expect(anyRunner.isRunning('a2')).toBe(false);

    expect(mockWatcherInstances[0].stop).toHaveBeenCalledTimes(1);
    expect(anyRunner.activeProcesses.has('a2')).toBe(false);
  });

  it('does not mount a watcher without a session id or a working directory', async () => {
    const r1 = await buildRunner();
    mockIsSameProcess.mockResolvedValueOnce(true);
    expect(await r1.reconnectDetachedProcess('a2', { ...saved, sessionId: undefined })).toBe(true);
    expect(mockWatcherInstances).toHaveLength(0);

    const r2 = await buildRunner();
    mockIsSameProcess.mockResolvedValueOnce(true);
    expect(
      await r2.reconnectDetachedProcess('a2', { ...saved, lastRequest: { agentId: 'a2', prompt: 'x' } }),
    ).toBe(true);
    expect(mockWatcherInstances).toHaveLength(0);
  });

  it('does not mount the claude transcript watcher for a non-claude backend', async () => {
    const { ClaudeRunner } = await import('./runner.js');
    const anyRunner = new ClaudeRunner(
      { onSessionId: vi.fn(), onComplete: vi.fn(), onError: vi.fn() } as any,
      { name: 'grok' } as any,
    ) as any;
    mockIsSameProcess.mockResolvedValueOnce(true);

    expect(await anyRunner.reconnectDetachedProcess('a2', saved)).toBe(true);
    expect(mockWatcherInstances).toHaveLength(0);
  });
});
