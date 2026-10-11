/**
 * 进程管理:provider 进程快照/匹配/终止与各 provider 的便捷封装。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { log } from './paths.js';
import { type SessionProvider } from './session-types.js';
import * as fs from 'fs';
import { spawn } from 'child_process';

const PROVIDER_PROCESS_PATTERNS: Record<SessionProvider, string> = {
  claude: '(claude$|/claude( |$)|claude\\.cmd|claude\\.exe)',
  codex: '(codex($| )|/codex( |$)|codex\\.cmd|codex\\.exe|codex\\.js|@openai/codex)',
  opencode: '(opencode($| )|/opencode( |$)|opencode\\.cmd|opencode\\.exe)',
  // Match `grok` CLI but not unrelated tools with "grok" in the path/name as a substring of a longer token.
  grok: '(^|/)grok($| )|grok\\.cmd|grok\\.exe',
  // pi sets process.title='pi' (cli.js), so ps shows a bare `pi` command with
  // NO argv — match a line ENDING in `pi` (padded argv leaves trailing spaces).
  // Bare-name matches can collide with unrelated `pi` binaries (anaconda ships
  // a python packaging tool named pi); the cwd filter downstream disambiguates.
  pi: '( |/)pi *$|pi-coding-agent|(^|/)pi (.* )?--mode (json|rpc)',
};

function providerDisplayName(provider: SessionProvider): string {
  if (provider === 'codex') return 'Codex';
  if (provider === 'opencode') return 'OpenCode';
  if (provider === 'grok') return 'Grok';
  if (provider === 'pi') return 'Pi';
  return 'Claude';
}

/** A live provider CLI process found by `ps`, with its working directory when readable. */
export interface ProviderProcessInfo {
  pid: number;
  provider: SessionProvider;
  /** null when the cwd could not be resolved (process exited, or owned by another user). */
  cwd: string | null;
}

const PROVIDER_PROCESS_REGEXES: Array<{ provider: SessionProvider; regex: RegExp }> =
  (Object.keys(PROVIDER_PROCESS_PATTERNS) as SessionProvider[]).map((provider) => ({
    provider,
    regex: new RegExp(PROVIDER_PROCESS_PATTERNS[provider]),
  }));

/**
 * How long a process snapshot is reused by callers that don't ask for a fresh
 * one. The snapshot is what every per-agent lookup (orphan polling, perf
 * metrics, PID resolution) needs, and those lookups come in bursts of one per
 * agent — with hundreds of agents that used to mean hundreds of blocking
 * `ps aux | grep` + `readlink` spawns back-to-back. One second of staleness is
 * harmless for all of them (a process that just died fails `process.kill(pid, 0)`
 * downstream anyway); kill paths pass `fresh: true`.
 */
const PROCESS_SNAPSHOT_TTL_MS = 1000;

let processSnapshotCache: { takenAt: number; processes: ProviderProcessInfo[] } | null = null;

let processSnapshotInFlight: Promise<ProviderProcessInfo[]> | null = null;

function normalizeCwd(cwd: string): string {
  return cwd.replace(/\/+$/, '');
}

function runCommand(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${file} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${file} exited with code ${code}`));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
  });
}

/** Resolve a process's cwd without blocking: /proc readlink on Linux, lsof on macOS. */
async function readProcessCwd(pid: number): Promise<string | null> {
  try {
    if (process.platform === 'darwin') {
      const lsofOutput = await runCommand('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], 2000);
      const line = lsofOutput.split('\n').find((l) => l.startsWith('n'));
      return line ? line.substring(1).trim() : null;
    }
    return (await fs.promises.readlink(`/proc/${pid}/cwd`)).trim();
  } catch {
    return null;
  }
}

/**
 * List every running provider CLI process (claude/codex/opencode/grok/pi) with
 * its cwd, using ONE `ps aux` spawn plus one non-blocking cwd lookup per match.
 * Matching runs against the full `ps aux` line, exactly like the former
 * `ps aux | grep -E <pattern>` pipeline, so the provider patterns keep their
 * meaning. Snapshots are memoized for PROCESS_SNAPSHOT_TTL_MS and concurrent
 * callers share the in-flight promise; pass `fresh: true` to bypass both.
 */
export async function snapshotProviderProcesses(options: { fresh?: boolean } = {}): Promise<ProviderProcessInfo[]> {
  if (process.platform === 'win32') {
    return [];
  }

  const now = Date.now();
  if (!options.fresh) {
    if (processSnapshotCache && now - processSnapshotCache.takenAt < PROCESS_SNAPSHOT_TTL_MS) {
      return processSnapshotCache.processes;
    }
    if (processSnapshotInFlight) {
      return processSnapshotInFlight;
    }
  }

  const work = (async (): Promise<ProviderProcessInfo[]> => {
    let psOutput: string;
    try {
      psOutput = await runCommand('ps', ['aux'], 5000);
    } catch (err) {
      log.error(' Failed to list processes with ps:', err);
      return [];
    }

    const matches: Array<{ pid: number; provider: SessionProvider }> = [];
    for (const line of psOutput.split('\n')) {
      if (!line) continue;
      // A line may satisfy more than one provider pattern; keep it under each,
      // as the former one-grep-per-provider pipeline did.
      const providers = PROVIDER_PROCESS_REGEXES.filter(({ regex }) => regex.test(line));
      if (providers.length === 0) continue;
      // `ps aux` columns: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
      const pid = Number.parseInt(line.trim().split(/\s+/)[1] ?? '', 10);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      for (const { provider } of providers) {
        matches.push({ pid, provider });
      }
    }

    const processes = await Promise.all(
      matches.map(async ({ pid, provider }): Promise<ProviderProcessInfo> => ({
        pid,
        provider,
        cwd: await readProcessCwd(pid),
      }))
    );
    processSnapshotCache = { takenAt: Date.now(), processes };
    return processes;
  })();

  processSnapshotInFlight = work;
  try {
    return await work;
  } finally {
    if (processSnapshotInFlight === work) {
      processSnapshotInFlight = null;
    }
  }
}

/** First snapshot entry of `provider` whose cwd matches `cwd` (trailing slashes ignored). */
function findProviderProcessInSnapshot(
  processes: ProviderProcessInfo[],
  cwd: string,
  provider: SessionProvider
): ProviderProcessInfo | undefined {
  const normalizedCwd = normalizeCwd(cwd);
  return processes.find((p) => p.provider === provider && p.cwd !== null && normalizeCwd(p.cwd) === normalizedCwd);
}

async function isProviderProcessRunningInCwd(cwd: string, provider: SessionProvider): Promise<boolean> {
  // Only works on Linux/Unix/macOS
  if (process.platform === 'win32') {
    return false;
  }

  try {
    const match = findProviderProcessInSnapshot(await snapshotProviderProcesses(), cwd, provider);
    if (!match) {
      return false;
    }
    log.log(` Found ${providerDisplayName(provider)} process ${match.pid} running in ${cwd}`);
    return true;
  } catch (err) {
    log.error(` Error checking for ${providerDisplayName(provider)} processes:`, err);
    return false;
  }
}

async function findProviderProcessPidInCwd(cwd: string, provider: SessionProvider): Promise<number | undefined> {
  if (process.platform === 'win32') {
    return undefined;
  }

  try {
    return findProviderProcessInSnapshot(await snapshotProviderProcesses(), cwd, provider)?.pid;
  } catch (err) {
    log.error(` Error finding ${providerDisplayName(provider)} PID in ${cwd}:`, err);
    return undefined;
  }
}

async function killProviderProcessInCwd(cwd: string, provider: SessionProvider): Promise<boolean> {
  // Only works on Linux/Unix/macOS
  if (process.platform === 'win32') {
    return false;
  }

  try {
    // Always look at live state here: killing on a stale snapshot could target
    // a PID that was already reused.
    const processes = await snapshotProviderProcesses({ fresh: true });
    const normalizedCwd = normalizeCwd(cwd);
    const label = providerDisplayName(provider);

    for (const proc of processes) {
      if (proc.provider !== provider || proc.cwd === null || normalizeCwd(proc.cwd) !== normalizedCwd) {
        continue;
      }

      const pid = proc.pid;
      log.log(`🛑 Killing detached ${label} process ${pid} in ${cwd}`);

      try {
        process.kill(pid, 'SIGTERM');
        setTimeout(() => {
          try {
            process.kill(pid, 0);
            log.log(`🛑 Force killing ${label} process ${pid}`);
            process.kill(pid, 'SIGKILL');
          } catch {
            // Process already dead, good
          }
        }, 1000);
        return true;
      } catch (killErr) {
        log.error(`Failed to kill ${label} process ${pid}:`, killErr);
      }
    }

    return false;
  } catch (err) {
    log.error(`Error killing ${providerDisplayName(provider)} process:`, err);
    return false;
  }
}

/**
 * Check if there's a Claude process running in a specific directory
 * This uses OS-level process inspection to detect Claude processes
 * that survived a server restart
 */
export async function isClaudeProcessRunningInCwd(cwd: string): Promise<boolean> {
  return isProviderProcessRunningInCwd(cwd, 'claude');
}

/**
 * Check if there's a Codex process running in a specific directory.
 */
export async function isCodexProcessRunningInCwd(cwd: string): Promise<boolean> {
  return isProviderProcessRunningInCwd(cwd, 'codex');
}

export async function findClaudeProcessPidInCwd(cwd: string): Promise<number | undefined> {
  return findProviderProcessPidInCwd(cwd, 'claude');
}

export async function findCodexProcessPidInCwd(cwd: string): Promise<number | undefined> {
  return findProviderProcessPidInCwd(cwd, 'codex');
}

/**
 * Kill any Claude process running in the specified directory
 * Returns true if a process was found and killed
 */
export async function killClaudeProcessInCwd(cwd: string): Promise<boolean> {
  return killProviderProcessInCwd(cwd, 'claude');
}

/**
 * Kill any Codex process running in the specified directory.
 * Returns true if a process was found and killed.
 */
export async function killCodexProcessInCwd(cwd: string): Promise<boolean> {
  return killProviderProcessInCwd(cwd, 'codex');
}

/**
 * Check if there's an OpenCode process running in a specific directory.
 */
export async function isOpencodeProcessRunningInCwd(cwd: string): Promise<boolean> {
  return isProviderProcessRunningInCwd(cwd, 'opencode');
}

export async function findOpencodeProcessPidInCwd(cwd: string): Promise<number | undefined> {
  return findProviderProcessPidInCwd(cwd, 'opencode');
}

/**
 * Kill any OpenCode process running in the specified directory.
 * Returns true if a process was found and killed.
 */
export async function killOpencodeProcessInCwd(cwd: string): Promise<boolean> {
  return killProviderProcessInCwd(cwd, 'opencode');
}

/**
 * Check if there's a Grok process running in a specific directory.
 */
export async function isGrokProcessRunningInCwd(cwd: string): Promise<boolean> {
  return isProviderProcessRunningInCwd(cwd, 'grok');
}

export async function findGrokProcessPidInCwd(cwd: string): Promise<number | undefined> {
  return findProviderProcessPidInCwd(cwd, 'grok');
}

/**
 * Kill any Grok process running in the specified directory.
 * Returns true if a process was found and killed.
 */
export async function killGrokProcessInCwd(cwd: string): Promise<boolean> {
  return killProviderProcessInCwd(cwd, 'grok');
}

/**
 * Check if there's a Pi process running in a specific directory.
 */
export async function isPiProcessRunningInCwd(cwd: string): Promise<boolean> {
  return isProviderProcessRunningInCwd(cwd, 'pi');
}

export async function findPiProcessPidInCwd(cwd: string): Promise<number | undefined> {
  return findProviderProcessPidInCwd(cwd, 'pi');
}

/**
 * Kill any Pi process running in the specified directory.
 * Returns true if a process was found and killed.
 */
export async function killPiProcessInCwd(cwd: string): Promise<boolean> {
  return killProviderProcessInCwd(cwd, 'pi');
}
