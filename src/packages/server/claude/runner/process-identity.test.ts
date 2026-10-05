/**
 * Orphan-adoption identity probe. A persisted PID alone cannot prove the
 * process still alive is the one we spawned (Windows recycles PIDs fast), so
 * adoption compares the live process start time with the persisted spawn time.
 * Every probe failure path must fail OPEN — a possibly-live agent must never
 * be dropped because a platform helper was unavailable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFile: mockExecFile,
}));

import {
  getEffectivePid,
  isSameProcess,
  killProcessTree,
  parseLinuxStartTimeMs,
  PID_IDENTITY_TOLERANCE_MS,
} from './process-identity.js';

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.TIDE_RECOVER_PID_IDENTITY;
});

describe('getEffectivePid', () => {
  it('prefers recoveredPid over the placeholder process pid', () => {
    expect(getEffectivePid({ process: { pid: 111 }, recoveredPid: 4242 })).toBe(4242);
  });

  it('falls back to the owned process pid', () => {
    expect(getEffectivePid({ process: { pid: 111 } })).toBe(111);
  });

  it('returns undefined when neither is present', () => {
    expect(getEffectivePid({ process: {} })).toBeUndefined();
  });
});

describe('parseLinuxStartTimeMs', () => {
  // After ") " the slice starts at field 3; field 22 (starttime) is index 19.
  const STAT =
    '1234 (claude) S 1 1234 1234 0 -1 4194304 100 0 0 0 10 5 0 0 20 0 1 0 987654 123456 7890 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 8 0 0 0 0 0';

  it('converts starttime ticks + btime into epoch ms', () => {
    // 987654 ticks @ 100 Hz = 9876.54 s after boot at 1_700_000_000 s.
    expect(parseLinuxStartTimeMs(STAT, 1_700_000_000)).toBe(1_700_009_876_540);
  });

  it('handles comm containing spaces and parentheses', () => {
    const weird = STAT.replace('(claude)', '(my (weird) proc)');
    expect(parseLinuxStartTimeMs(weird, 1_700_000_000)).toBe(1_700_009_876_540);
  });

  it('returns null without btime', () => {
    expect(parseLinuxStartTimeMs(STAT, null)).toBeNull();
  });

  it('returns null for a malformed stat line', () => {
    expect(parseLinuxStartTimeMs('no parens here', 1_700_000_000)).toBeNull();
    const badTicks = STAT.replace(' 987654 ', ' abc ');
    expect(parseLinuxStartTimeMs(badTicks, 1_700_000_000)).toBeNull();
  });
});

// The probe shells out to PowerShell on win32; the tests stub execFile so no
// real shell is spawned. On other platforms the probe returns null (tested
// through the fail-open cases below).
describe.runIf(process.platform === 'win32')('isSameProcess (win32 CIM probe)', () => {
  function probeReturns(ms: number) {
    mockExecFile.mockImplementation((_file: any, _args: any, _opts: any, cb: any) => cb(null, String(ms), ''));
  }

  it('accepts the PID when the start time is within tolerance', async () => {
    const spawnedAt = 1_700_000_000_000;
    probeReturns(spawnedAt + 5_000);
    await expect(isSameProcess(4242, spawnedAt)).resolves.toBe(true);
  });

  it('rejects a recycled PID when the start time differs beyond tolerance', async () => {
    const spawnedAt = 1_700_000_000_000;
    probeReturns(spawnedAt + PID_IDENTITY_TOLERANCE_MS + 1);
    await expect(isSameProcess(4242, spawnedAt)).resolves.toBe(false);
  });

  it('fails open when the probe errors (process gone / powershell unavailable)', async () => {
    mockExecFile.mockImplementation((_file: any, _args: any, _opts: any, cb: any) => cb(new Error('boom'), '', ''));
    await expect(isSameProcess(4242, 1_700_000_000_000)).resolves.toBe(true);
  });

  it('fails open when the probe output is unparseable', async () => {
    mockExecFile.mockImplementation((_file: any, _args: any, _opts: any, cb: any) => cb(null, 'garbage', ''));
    await expect(isSameProcess(4242, 1_700_000_000_000)).resolves.toBe(true);
  });
});

describe('isSameProcess fail-open short-circuits', () => {
  it('trusts the PID when no expected start time was persisted', async () => {
    await expect(isSameProcess(4242, undefined)).resolves.toBe(true);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('trusts the PID when the identity check is disabled', async () => {
    process.env.TIDE_RECOVER_PID_IDENTITY = '0';
    await expect(isSameProcess(4242, 1_700_000_000_000)).resolves.toBe(true);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('fails open for an invalid pid', async () => {
    await expect(isSameProcess(0, 1_700_000_000_000)).resolves.toBe(true);
  });
});

describe.runIf(process.platform === 'win32')('killProcessTree', () => {
  it('terminates the whole tree via taskkill on win32', () => {
    killProcessTree(4242);
    expect(mockExecFile).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '4242', '/T', '/F'],
      { windowsHide: true },
      expect.any(Function)
    );
  });
});
