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

async function buildHarness() {
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

  const lifecycle = new RunnerProcessLifecycle({
    backend: {
      name: 'claude',
      buildArgs: () => [],
      getExecutablePath: () => 'claude',
      requiresStdinInput: () => false,
    } as any,
    callbacks: {
      onSessionId: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
    } as any,
    activeProcesses,
    lastStderr: new Map(),
    activityCallbacks: new Map(),
    bus: new RunnerInternalEventBus(),
    stdoutPipeline: stdoutPipeline as any,
    recoveryStore: { persistRunningProcesses: persistSpy } as any,
    onDisableAutoRestart: vi.fn(),
  });

  return { lifecycle, activeProcesses, persistCalls, persistSpy };
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
