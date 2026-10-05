/**
 * Process identity for orphan adoption.
 *
 * A persisted PID alone cannot prove the process still alive is the one we
 * spawned — PIDs get recycled (aggressively on Windows). Before adopting a
 * live orphan we probe the actual process start time and compare it with the
 * persisted spawn time (±60s tolerance for shell-wrapper and clock skew).
 *
 * Probes fail open: when the platform cannot report a start time, or the
 * helper errors out, the PID is trusted rather than dropping a possibly-live
 * agent. `TIDE_RECOVER_PID_IDENTITY=0` disables the check entirely.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';

export const PID_IDENTITY_TOLERANCE_MS = 60_000;

/**
 * The PID to use for liveness checks and signaling. Adopted processes carry
 * the real PID in `recoveredPid`; their `process` field is only a
 * ChildProcess-shaped placeholder we never own.
 */
export function getEffectivePid(activeProcess: {
  process: { pid?: number };
  recoveredPid?: number;
}): number | undefined {
  return activeProcess.recoveredPid ?? activeProcess.process.pid;
}

export function isProcessIdentityCheckDisabled(): boolean {
  return process.env.TIDE_RECOVER_PID_IDENTITY === '0';
}

/**
 * Pure parser, exported for tests. `/proc/<pid>/stat` field 22 (starttime) is
 * in clock ticks since boot (USER_HZ, virtually always 100 on Linux);
 * `/proc/stat` `btime` is boot time in seconds since the epoch.
 */
export function parseLinuxStartTimeMs(statContent: string, btimeSeconds: number | null): number | null {
  const close = statContent.lastIndexOf(')');
  if (close < 0) return null;
  const fields = statContent.slice(close + 2).trim().split(/\s+/);
  const startTicks = parseInt(fields[19], 10); // field 22 overall; after ") " the slice starts at field 3
  if (!Number.isFinite(startTicks) || btimeSeconds === null) return null;
  return btimeSeconds * 1000 + Math.round((startTicks / 100) * 1000);
}

function probeLinuxStartTimeMs(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const procStat = fs.readFileSync('/proc/stat', 'utf8');
    const btimeMatch = procStat.match(/^btime (\d+)/m);
    const btimeSeconds = btimeMatch ? parseInt(btimeMatch[1], 10) : null;
    return parseLinuxStartTimeMs(stat, btimeSeconds);
  } catch {
    return null;
  }
}

/** win32: CIM CreationDate via PowerShell (wmic is absent on modern Windows). */
function probeWindowsStartTimeMs(pid: number): Promise<number | null> {
  const query =
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
    'if ($p -and $p.CreationDate) { [string][math]::Floor(($p.CreationDate.ToFileTimeUtc() - 116444736000000000) / 10000) }';
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', query],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const ms = parseInt(String(stdout).trim(), 10);
        resolve(Number.isFinite(ms) && ms > 0 ? ms : null);
      }
    );
  });
}

/** Process start time in ms since the epoch, or null when undeterminable. */
export async function probeProcessStartTimeMs(pid: number): Promise<number | null> {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (process.platform === 'linux') return probeLinuxStartTimeMs(pid);
  if (process.platform === 'win32') return probeWindowsStartTimeMs(pid);
  return null;
}

/**
 * Fail-open identity check: a null probe on either side means "cannot tell",
 * which must not drop a live agent.
 */
export async function isSameProcess(pid: number, expectedStartTimeMs: number | undefined): Promise<boolean> {
  if (isProcessIdentityCheckDisabled()) return true;
  // Nothing to compare against — don't pay for a probe (win32 shells out).
  if (!expectedStartTimeMs) return true;
  const actual = await probeProcessStartTimeMs(pid);
  if (actual === null) return true;
  return Math.abs(actual - expectedStartTimeMs) <= PID_IDENTITY_TOLERANCE_MS;
}

/**
 * Terminate a process and its tree — the only reliable signal for adopted
 * processes, which have no stdio channel for a graceful interrupt.
 * win32: `taskkill /T /F`; POSIX: signal the process group (adopted processes
 * were spawned detached, so the PID is its own group leader).
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (process.platform === 'win32') {
    try {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {
        // best effort — the process may already be gone
      });
    } catch {
      // ignore
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // ignore
    }
  }
}
