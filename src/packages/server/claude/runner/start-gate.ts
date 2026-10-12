/**
 * 进程启动闸门（唤醒节流）——限制「同时在冷启动中」的 agent 进程数。
 *
 * 背景（2026-10-12 14:12 群发唤醒风暴）：消息通道免配额，一次「让所有人回复」
 * 让 10 个 claude 进程冷启动。事后取证（logs/server.log + transcript cwd 字段）：
 * spawn 本身是错开的（14:12:11–31，约 2s 一个），但每个进程的「启动 + 首轮」
 * 阶段整体重叠，峰值资源压力下 6 秒内连崩 3 个（2×0xC0000409 原生崩溃 +
 * 1×exit 1），全靠自动重启兜住。所以节流不能按「固定小间隔」做（本来就有
 * 2s 间隔也照样崩），得按「同时在启动中的进程数」压峰。
 *
 * 闸门语义：进程在 spawn 之前先 acquire 一个槽位；槽位在进程产出**首个 stdout
 * 数据块**（启动完成，claude 会先发 system/init）或进程退出/出错时释放。
 * 因此并发上限约束的是「启动中」的进程数，不是存活数——进程起来之后不占
 * 槽位，正常多工不受影响。排队 FIFO，不拒绝、不丢消息：等待只发生在 spawn
 * 之前，消息照常在 spawn 时作为初始 prompt 送达（HTTP POST 的响应因此会等到
 * 放行才返回，这是有意的背压）。
 *
 * 兜底：持有超时（DEFAULT_LEASE_HOLD_MS）自动释放——某个进程既不产出也
 * 不退出（或 spawn 前路径异常退出）时，防止队列被永久卡死。
 *
 * 开关：
 *   TC_PROCESS_START_GATE=0/off/false  整体恢复旧行为（直通，不排队）
 *   TC_PROCESS_START_MAX=N             并发启动上限（默认 2；非法值回退默认）
 *   TC_PROCESS_START_HOLD_MS=N         槽位持有超时（默认 30000）
 *
 * 覆盖范围：所有 provider 的 RunnerProcessLifecycle.run()（claude 无头为主；
 * codex/opencode/grok/pi 共用同一个 ClaudeRunner 生命周期）。tmux 模式
 * （Linux 实验档）在会话拉起后短暂延迟即释放；interactive TUI 走独立 spawn
 * 路径，不在闸内。
 */

export const PROCESS_START_GATE_ENABLED_ENV = 'TC_PROCESS_START_GATE';
export const PROCESS_START_GATE_MAX_ENV = 'TC_PROCESS_START_MAX';
export const PROCESS_START_GATE_HOLD_MS_ENV = 'TC_PROCESS_START_HOLD_MS';

export const DEFAULT_MAX_CONCURRENT_STARTS = 2;
export const DEFAULT_LEASE_HOLD_MS = 30_000;

export interface StartGateLease {
  /** 幂等：重复调用只释放一次。 */
  release(): void;
}

/** 生命周期只依赖这个窄接口，便于测试注入。 */
export interface ProcessStartGateLike {
  acquire(agentId: string): Promise<StartGateLease>;
}

interface GateLogger {
  log(message: string): void;
  warn?(message: string): void;
}

export interface ProcessStartGateOptions {
  enabled?: boolean;
  maxConcurrent?: number;
  holdMs?: number;
  log?: GateLogger;
}

/** 开关判定（对齐 TC_JARVIS_DELEGATION_QUOTA 先例）：未设/空串 → 开；只有显式关闭值才关。 */
export function isProcessStartGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[PROCESS_START_GATE_ENABLED_ENV]?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === '0' || raw === 'off' || raw === 'false');
}

/** 非法原始值只警告一次（每个值各一次），避免每次启动都刷屏。 */
const warnedValues = new Set<string>();

function warnOnce(raw: string, envName: string, fallback: number, log?: GateLogger): void {
  const key = `${envName}=${raw}`;
  if (warnedValues.has(key)) return;
  warnedValues.add(key);
  log?.warn?.(`[StartGate] invalid ${envName}="${raw}" — falling back to ${fallback}`);
}

/**
 * 并发上限解析：空/未设 → 2；正整数 → 原值；其余（0/负数/NaN/小数）→ 兜底 2 + 警告一次。
 * 0 必须拒绝——max=0 会让任何进程都排不进去，等于把整个系统冻死。
 */
export function resolveProcessStartGateMax(env: NodeJS.ProcessEnv = process.env, log?: GateLogger): number {
  const raw = env[PROCESS_START_GATE_MAX_ENV]?.trim();
  if (!raw) return DEFAULT_MAX_CONCURRENT_STARTS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    warnOnce(raw, PROCESS_START_GATE_MAX_ENV, DEFAULT_MAX_CONCURRENT_STARTS, log);
    return DEFAULT_MAX_CONCURRENT_STARTS;
  }
  return parsed;
}

/** 持有超时解析：空/未设 → 30000；正数 → 原值；其余 → 兜底 30000 + 警告一次。 */
export function resolveProcessStartGateHoldMs(env: NodeJS.ProcessEnv = process.env, log?: GateLogger): number {
  const raw = env[PROCESS_START_GATE_HOLD_MS_ENV]?.trim();
  if (!raw) return DEFAULT_LEASE_HOLD_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    warnOnce(raw, PROCESS_START_GATE_HOLD_MS_ENV, DEFAULT_LEASE_HOLD_MS, log);
    return DEFAULT_LEASE_HOLD_MS;
  }
  return parsed;
}

interface Waiter {
  agentId: string;
  waitStart: number;
  resolve: (lease: StartGateLease) => void;
}

const NOOP_LEASE: StartGateLease = Object.freeze({ release: () => {} });

export class ProcessStartGate implements ProcessStartGateLike {
  private readonly enabled: boolean;
  private readonly maxConcurrent: number;
  private readonly holdMs: number;
  private readonly log: GateLogger;
  private active = 0;
  private waiters: Waiter[] = [];

  constructor(opts: ProcessStartGateOptions = {}) {
    this.enabled = opts.enabled ?? true;
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_STARTS;
    this.holdMs = opts.holdMs ?? DEFAULT_LEASE_HOLD_MS;
    this.log = opts.log ?? { log: () => {} };
  }

  async acquire(agentId: string): Promise<StartGateLease> {
    if (!this.enabled) return NOOP_LEASE;
    if (this.active < this.maxConcurrent) return this.admitNow(agentId);

    const waitStart = Date.now();
    this.log.log(
      `🚦 [START-GATE] Agent ${agentId} queued (starting=${this.active}/${this.maxConcurrent}, waiting=${this.waiters.length + 1})`
    );
    return new Promise<StartGateLease>((resolve) => {
      this.waiters.push({ agentId, waitStart, resolve });
    });
  }

  private admitNow(agentId: string, waitStart?: number): StartGateLease {
    this.active += 1;
    const waited = waitStart != null ? `, waited ${Date.now() - waitStart}ms` : '';
    this.log.log(`🚦 [START-GATE] Agent ${agentId} admitted (starting=${this.active}/${this.maxConcurrent}${waited})`);

    let released = false;
    let holdTimer: NodeJS.Timeout | undefined;
    const release = (): void => {
      if (released) return;
      released = true;
      if (holdTimer) clearTimeout(holdTimer);
      this.active -= 1;
      this.drain();
    };
    holdTimer = setTimeout(() => {
      this.log.warn?.(
        `🚦 [START-GATE] Agent ${agentId} lease held over ${this.holdMs}ms with no first output / exit — force-released`
      );
      release();
    }, this.holdMs);
    holdTimer.unref?.();

    return { release };
  }

  /** 逐槽放行排队者（release 之后每腾出一个槽位恰好放行一个）。 */
  private drain(): void {
    while (this.active < this.maxConcurrent && this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next.resolve(this.admitNow(next.agentId, next.waitStart));
    }
  }

  /** 观测用（测试断言 / 排查）。 */
  getActiveCount(): number {
    return this.active;
  }

  getWaitingCount(): number {
    return this.waiters.length;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

// ============================================================================
// 进程内单例：多个 ClaudeRunner 实例（claude 无头/交互、codex、opencode…）
// 共用同一个闸门——风暴护的是整机资源，不该按 runner 分账。
// ============================================================================

let sharedGate: ProcessStartGate | null = null;

export function getProcessStartGate(): ProcessStartGateLike {
  if (!sharedGate) {
    sharedGate = new ProcessStartGate({
      enabled: isProcessStartGateEnabled(),
      maxConcurrent: resolveProcessStartGateMax(),
      holdMs: resolveProcessStartGateHoldMs(),
    });
  }
  return sharedGate;
}

/** 测试专用：替换/重置单例。传 null 恢复惰性重建。 */
export function setProcessStartGateForTests(gate: ProcessStartGateLike | null): void {
  sharedGate = gate as ProcessStartGate | null;
  warnedValues.clear();
}
