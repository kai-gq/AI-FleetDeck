/**
 * End-to-end (no live CLI) for adopted-orphan output re-sourcing:
 * adoption mounts the REAL transcript watcher over a temp session JSONL and
 * lines appended after adoption flow through the REAL tailer → translator →
 * stdout pipeline → runner turn-state machine. Only the process-identity
 * probe, the data layer, agent-service and the cwd→project-dir mapping are
 * stubbed.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockSaveRunningProcesses = vi.hoisted(() => vi.fn());
const mockUpdateAgent = vi.hoisted(() => vi.fn());
const mockGetAgent = vi.hoisted(() => vi.fn(() => ({ status: 'working' })));
const mockIsSameProcess = vi.hoisted(() => vi.fn(async () => true));
const mockProjectDirState = vi.hoisted(() => ({ dir: '' }));

vi.mock('../data/index.js', () => ({
  saveRunningProcesses: mockSaveRunningProcesses,
  loadRunningProcesses: () => [],
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

vi.mock('../services/activity-log.js', () => ({ logProcess: vi.fn() }));

// Point the transcript path at a real temp dir instead of the HOME layout.
vi.mock('./session-loader.js', () => ({
  getProjectDir: () => mockProjectDirState.dir,
}));

const assistantLine = (uuid: string, sessionId: string, text: string, stopReason: string | null) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    sessionId,
    message: {
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text }],
      stop_reason: stopReason,
    },
  }) + '\n';

afterEach(() => {
  vi.clearAllMocks();
});

describe('adopted orphan — real transcript re-sourcing', () => {
  it('streams only post-adoption lines and flips turn state at the transcript turn boundary', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-adopt-'));
    mockProjectDirState.dir = tmpDir;
    const sessionId = 'sess-e2e';
    const jsonlPath = path.join(tmpDir, `${sessionId}.jsonl`);

    // Pre-adoption history on disk BEFORE the watcher starts: startAtEnd must
    // keep it out of the UI (history is loaded separately by the client).
    fs.writeFileSync(jsonlPath, assistantLine('old', sessionId, 'OLD HISTORY', 'end_turn'));

    const onOutput = vi.fn();
    const onEvent = vi.fn();
    const { ClaudeRunner } = await import('./runner.js');
    const runner = new ClaudeRunner({
      onEvent,
      onOutput,
      onSessionId: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
    } as any) as any;

    const ok = await runner.reconnectDetachedProcess('a9', {
      agentId: 'a9',
      pid: 4242,
      sessionId,
      startTime: Date.now() - 60_000,
      lastRequest: { agentId: 'a9', prompt: 'work', workingDir: 'C:/any' },
      agentStatus: 'working',
      provider: 'claude',
    });
    expect(ok).toBe(true);

    const tracked = runner.activeProcesses.get('a9');
    expect(tracked.turnState).toBe('waiting_for_input');

    try {
      // Mid-turn activity lands on disk (as a live CLI would append it).
      tracked.lastActivityTime = 0;
      fs.appendFileSync(jsonlPath, assistantLine('live', sessionId, 'LIVE OUTPUT', null));
      await vi.waitFor(() => expect(tracked.turnState).toBe('processing'), { timeout: 3000 });
      expect(tracked.lastActivityTime).toBeGreaterThan(0);

      // Transcript turn boundary: end_turn assistant record.
      mockSaveRunningProcesses.mockClear();
      fs.appendFileSync(jsonlPath, assistantLine('done', sessionId, 'LIVE OUTPUT', 'end_turn'));
      await vi.waitFor(() => expect(tracked.turnState).toBe('waiting_for_input'), { timeout: 3000 });
      // Turn boundary refreshes the on-disk ledger (crash-window shrink).
      expect(mockSaveRunningProcesses).toHaveBeenCalled();

      const texts = onOutput.mock.calls.map((c) => c[1]).join('|');
      expect(texts).toContain('LIVE OUTPUT');
      expect(texts).not.toContain('OLD HISTORY');
      expect(onEvent).toHaveBeenCalled();
    } finally {
      tracked.sideChannelStop?.();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 15_000);
});
