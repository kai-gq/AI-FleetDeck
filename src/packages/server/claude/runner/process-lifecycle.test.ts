import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActiveProcess } from '../types.js';
import { RunnerInternalEventBus } from './internal-events.js';

const mockSpawn = vi.hoisted(() => vi.fn());
const mockIsTmuxEnabled = vi.hoisted(() => vi.fn(() => false));
const mockCheckTmuxAvailability = vi.hoisted(() => vi.fn());
const mockSpawnInTmux = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

vi.mock('./tmux-helper.js', () => ({
  isTmuxEnabled: mockIsTmuxEnabled,
  checkTmuxAvailability: mockCheckTmuxAvailability,
  spawnInTmux: mockSpawnInTmux,
  killTmuxSession: vi.fn(),
  interruptTmuxSession: vi.fn(),
}));

vi.mock('../../grok/session-watcher.js', () => ({
  startGrokSessionWatcher: vi.fn(),
}));

const mockKillProcessTree = vi.hoisted(() => vi.fn());

// Partial mock: keep the real getEffectivePid, stub only the tree-kill (which
// would otherwise shell out to taskkill against a fake PID in tests).
vi.mock('./process-identity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./process-identity.js')>()),
  killProcessTree: mockKillProcessTree,
}));

async function buildHarness(opts: { startGate?: { acquire: (agentId: string) => Promise<{ release: () => void }> } } = {}) {
  const { RunnerProcessLifecycle } = await import('./process-lifecycle.js');

  const activeProcesses = new Map<string, ActiveProcess>();
  const persistCalls: Array<{ agentTracked: boolean }> = [];

  const persistSpy = vi.fn(() => {
    persistCalls.push({ agentTracked: activeProcesses.has('a1') });
  });

  const stdoutPipeline = {
    handleStdout: vi.fn(() => Promise.resolve()),
    handleTmuxLog: vi.fn(() => ({ stop: vi.fn(), getOffset: vi.fn(() => 0) })),
  };

  const callbacks = {
    onSessionId: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
  };

  const lifecycle = new RunnerProcessLifecycle({
    backend: {
      name: 'claude',
      buildArgs: () => [],
      getExecutablePath: () => 'claude',
      requiresStdinInput: () => false,
    } as any,
    callbacks: callbacks as any,
    activeProcesses,
    lastStderr: new Map(),
    activityCallbacks: new Map(),
    bus: new RunnerInternalEventBus(),
    stdoutPipeline: stdoutPipeline as any,
    recoveryStore: { persistRunningProcesses: persistSpy } as any,
    onDisableAutoRestart: vi.fn(),
    // 直通闸门：既有用例不经过真实单例（否则进程内的排队会跨用例残留）。
    startGate: opts.startGate ?? { acquire: async () => ({ release: () => {} }) },
  });

  return { lifecycle, activeProcesses, persistCalls, persistSpy, callbacks };
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

afterEach(() => {
  // clearAllMocks (not just restoreAllMocks) — vitest 4's restore only
  // restores spyOn spies and leaves bare vi.fn() call history behind.
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', originalPlatform);
});

describe('RunnerProcessLifecycle — persist on spawn edge', () => {
  it('pipe mode: persists immediately after registering the spawned process', async () => {
    const harness = await buildHarness();
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdin: null,
      stdout: null,
      stderr: null,
    });
    mockSpawn.mockReturnValue(child);

    await harness.lifecycle.run({ agentId: 'a1', prompt: 'hi', workingDir: '/tmp/w' });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(harness.persistSpy).toHaveBeenCalledTimes(1);
    // The entry must already be tracked when persist runs (not a later tick).
    expect(harness.persistCalls).toEqual([{ agentTracked: true }]);
    expect(harness.activeProcesses.get('a1')?.process.pid).toBe(4242);
  });

  it('tmux mode: persists immediately after registering the tmux-backed process', async () => {
    vi.useFakeTimers();
    mockIsTmuxEnabled.mockReturnValue(true);
    // process.platform is a plain (non-getter) data property — spyOn can't
    // intercept it; redefine the property and restore in afterEach.
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const launcher = Object.assign(new EventEmitter(), { pid: 555, unref: vi.fn() });
    mockSpawnInTmux.mockReturnValue({
      launcherProcess: launcher,
      sessionName: 'tc-a1',
      logFile: '/tmp/tc-a1.log',
    });

    const harness = await buildHarness();
    await harness.lifecycle.run({ agentId: 'a1', prompt: 'hi', workingDir: '/tmp/w' });

    expect(mockSpawnInTmux).toHaveBeenCalledTimes(1);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(harness.persistSpy).toHaveBeenCalledTimes(1);
    expect(harness.persistCalls).toEqual([{ agentTracked: true }]);
    expect(harness.activeProcesses.get('a1')?.tmuxSession).toBe('tc-a1');
  });
});

describe('RunnerProcessLifecycle — adopted orphans have no stdio channel', () => {
  function adoptedProc(over: Partial<ActiveProcess> = {}): ActiveProcess {
    return {
      agentId: 'a1',
      startTime: Date.now(),
      // Placeholder child we never own — must never be signaled.
      process: { pid: 111, kill: vi.fn() } as any,
      recoveredPid: 4242,
      turnState: 'waiting_for_input',
      lastActivityTime: Date.now(),
      ...over,
    };
  }

  it('stops an adopted orphan by tree-killing the recovered PID', async () => {
    const harness = await buildHarness();
    const proc = adoptedProc();
    harness.activeProcesses.set('a1', proc);

    await harness.lifecycle.stop('a1');

    expect(mockKillProcessTree).toHaveBeenCalledWith(4242);
    expect((proc.process as any).kill).not.toHaveBeenCalled();
    expect(harness.activeProcesses.has('a1')).toBe(false);
    expect(harness.callbacks.onComplete).toHaveBeenCalledWith('a1', false);
  });

  it('interrupts an adopted orphan with a tree signal', async () => {
    const harness = await buildHarness();
    harness.activeProcesses.set('a1', adoptedProc());

    expect(harness.lifecycle.interrupt('a1')).toBe(true);

    expect(mockKillProcessTree).toHaveBeenCalledWith(4242, 'SIGINT');
  });

  it('returns false from interrupt when nothing is tracked', async () => {
    const harness = await buildHarness();

    expect(harness.lifecycle.interrupt('a1')).toBe(false);
    expect(mockKillProcessTree).not.toHaveBeenCalled();
  });

  it('stops side channels before dropping records on graceful restart (stopAll(false))', async () => {
    const harness = await buildHarness();
    const sideStop = vi.fn();
    harness.activeProcesses.set('a1', adoptedProc({ sideChannelStop: sideStop }));

    await harness.lifecycle.stopAll(false);

    expect(sideStop).toHaveBeenCalledTimes(1);
    expect(harness.activeProcesses.size).toBe(0);
    // The processes stay alive across a graceful restart — the ledger must
    // survive so the next boot can re-adopt them.
    expect(harness.persistSpy).toHaveBeenCalled();
  });

  it('takeover (run) stops the adopted orphan and its side channel before spawning', async () => {
    const harness = await buildHarness();
    const sideStop = vi.fn();
    harness.activeProcesses.set('a1', adoptedProc({ sideChannelStop: sideStop }));
    const child = Object.assign(new EventEmitter(), {
      pid: 999,
      stdin: null,
      stdout: null,
      stderr: null,
    });
    mockSpawn.mockReturnValue(child);

    await harness.lifecycle.run({ agentId: 'a1', prompt: 'continue', workingDir: '/tmp/w' });

    expect(mockKillProcessTree).toHaveBeenCalledWith(4242);
    expect(sideStop).toHaveBeenCalledTimes(1);
    // Ordering is what prevents double emission: the old watcher must be gone
    // before the resumed process starts appending to the same transcript.
    expect(sideStop.mock.invocationCallOrder[0]).toBeLessThan(
      mockSpawn.mock.invocationCallOrder[0],
    );
    expect(harness.activeProcesses.get('a1')?.process.pid).toBe(999);
  });
});

describe('RunnerProcessLifecycle — 启动闸门接线（唤醒节流）', () => {
  function fakeChild() {
    return Object.assign(new EventEmitter(), {
      pid: 777,
      stdin: null,
      stdout: new EventEmitter(),
      stderr: null,
    });
  }

  it('spawn 前先取槽位，首个 stdout 数据块到达时释放（幂等）', async () => {
    const release = vi.fn();
    const acquire = vi.fn(async () => ({ release }));
    const harness = await buildHarness({ startGate: { acquire } });
    const child = fakeChild();
    mockSpawn.mockReturnValue(child);

    await harness.lifecycle.run({ agentId: 'a1', prompt: 'hi', workingDir: '/tmp/w' });

    expect(acquire).toHaveBeenCalledWith('a1');
    // 槽位必须在 spawn 之前拿到。
    expect(acquire.mock.invocationCallOrder[0]).toBeLessThan(mockSpawn.mock.invocationCallOrder[0]);
    expect(release).not.toHaveBeenCalled();

    child.stdout.emit('data', Buffer.from('{"type":"system"}\n'));
    expect(release).toHaveBeenCalledTimes(1);

    // 幂等：随后的 close 不二次释放。
    child.emit('close', 0, null);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('排队中不 spawn：闸门放行前 run() 一直等待', async () => {
    let admit!: (lease: { release: () => void }) => void;
    const acquire = vi.fn(() => new Promise<{ release: () => void }>((resolve) => { admit = resolve; }));
    const harness = await buildHarness({ startGate: { acquire } });
    const child = fakeChild();
    mockSpawn.mockReturnValue(child);

    const runPromise = harness.lifecycle.run({ agentId: 'a1', prompt: 'hi', workingDir: '/tmp/w' });
    await new Promise((r) => setImmediate(r));
    expect(mockSpawn).not.toHaveBeenCalled();

    const release = vi.fn();
    admit({ release });
    await runPromise;

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    child.stdout.emit('data', Buffer.from('x'));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('启动期退出（close，0xC0000409 先例）释放槽位——崩溃不卡队列', async () => {
    const release = vi.fn();
    const harness = await buildHarness({ startGate: { acquire: async () => ({ release }) } });
    const child = fakeChild();
    mockSpawn.mockReturnValue(child);

    await harness.lifecycle.run({ agentId: 'a1', prompt: 'hi', workingDir: '/tmp/w' });
    expect(release).not.toHaveBeenCalled();

    child.emit('close', 3221226505, null);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('spawn 同步抛出时归还槽位并上抛', async () => {
    const release = vi.fn();
    const harness = await buildHarness({ startGate: { acquire: async () => ({ release }) } });
    mockSpawn.mockImplementation(() => {
      throw new Error('spawn boom');
    });

    await expect(
      harness.lifecycle.run({ agentId: 'a1', prompt: 'hi', workingDir: '/tmp/w' }),
    ).rejects.toThrow('spawn boom');

    expect(release).toHaveBeenCalledTimes(1);
  });
});
