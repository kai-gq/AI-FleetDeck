/**
 * W13 前置 · 用户活动账（时间感知 / 播报时机）
 *
 * 职责：记录「用户最近一次活动 / 最近一次说话」的时间点与粗粒度类别，
 * 供起床问候、主动汇报、播报时机等判断「用户是否在场 / 刚说过话」。
 * 三个消费口径：
 *   - lastActivityAt：任意一类活动（语音回合 / 前端页面活动 / 窗口聚焦 / 键鼠输入）；
 *   - lastSpeechAt：仅 voice-turn（用户对语音伙伴说过话），播报时机的主信号；
 *   - lastActivityKind：最后一次活动的类别（调试/展示用）。
 *
 * 隐私口径（硬边界）：只记时间点与粗粒度 kind，**绝不接受、绝不存储任何
 * 输入内容**（不落文本、不落按键、不落页面标题/URL）；快照只有三个字段，
 * 别处不得扩展本账的写入面。
 *
 * 持久化：XDG 数据目录 .../tide-commander/user-activity/activity.json（与
 * jarvis-morning/jarvis-memory 同规），原子写（tmp + rename）；读失败/损坏
 * → 归零不抛。写节流：默认 ≥10s 一次（minWriteIntervalMs，避免键鼠类的
 * 高频活动打爆磁盘），flush() 无视节流强制补写。构造时同步读一次。
 *
 * 纯观测类：任何函数不得上抛异常（内部 try/catch 或语义保证），登记绝不
 * 影响语音/提醒等主链路。测试一律显式注入临时文件，绝不碰真实数据目录。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { jarvisLogger } from '../jarvis-core/index.js';

// ─── 类型与常量 ───

export type UserActivityKind = 'voice-turn' | 'voice-page' | 'focus' | 'input';

export interface UserActivitySnapshot {
  /** 任一类活动的最新时间点（epoch ms）；从未有过 → null。 */
  lastActivityAt: number | null;
  /** 仅 voice-turn（用户说话）的最新时间点；从未说过 → null。 */
  lastSpeechAt: number | null;
  /** 最后一次活动的类别；从未有过 → null。 */
  lastActivityKind: UserActivityKind | null;
}

/** 全部合法 kind（运行时白名单兜底用；类型系统之外不接受未知值）。 */
const ACTIVITY_KINDS: readonly UserActivityKind[] = ['voice-turn', 'voice-page', 'focus', 'input'];

/** 写节流默认间隔：≥10s 一次（键鼠 input 类活动可能秒级高频）。 */
const DEFAULT_MIN_WRITE_INTERVAL_MS = 10_000;

function emptySnapshot(): UserActivitySnapshot {
  return { lastActivityAt: null, lastSpeechAt: null, lastActivityKind: null };
}

function toTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function toKind(value: unknown): UserActivityKind | null {
  return typeof value === 'string' && (ACTIVITY_KINDS as readonly string[]).includes(value)
    ? (value as UserActivityKind)
    : null;
}

// ─── 文件实现（构造读一次 + 内存账 + 原子写 + 节流 + 损坏容错） ───

export interface UserActivityStoreOptions {
  /** 写节流间隔（ms）；缺省 10_000。非法值（非有限数/负数）回落默认。 */
  minWriteIntervalMs?: number;
  /** 时钟（epoch ms）；缺省 Date.now（测试显式注入）。 */
  now?: () => number;
}

export class UserActivityStore {
  readonly filePath: string;
  private readonly minWriteIntervalMs: number;
  private readonly now: () => number;
  private state: UserActivitySnapshot;
  /** 内存态领先磁盘（被节流跳过或上次写失败）→ true；flush/persist 成功清零。 */
  private dirty = false;
  /** 上次尝试落盘的时刻（失败也计，避免坏盘时每条 note 都锤磁盘）；从未写 → null（首次 note 立即写）。 */
  private lastPersistedAt: number | null = null;

  constructor(filePath: string, opts: UserActivityStoreOptions = {}) {
    this.filePath = filePath;
    this.minWriteIntervalMs =
      typeof opts.minWriteIntervalMs === 'number' &&
      Number.isFinite(opts.minWriteIntervalMs) &&
      opts.minWriteIntervalMs >= 0
        ? opts.minWriteIntervalMs
        : DEFAULT_MIN_WRITE_INTERVAL_MS;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.state = this.readFromDisk();
  }

  /**
   * 登记一次活动（内存立即生效；落盘受节流）。
   * voice-turn（用户说话）同时刷新 lastSpeechAt；其它 kind 不动 lastSpeechAt。
   */
  note(kind: UserActivityKind, at?: number): void {
    try {
      if (!(ACTIVITY_KINDS as readonly string[]).includes(kind)) return; // 运行时兜底：未知 kind 一律忽略
      const ts = typeof at === 'number' && Number.isFinite(at) && at >= 0 ? at : this.now();
      this.state = {
        lastActivityAt: ts,
        lastSpeechAt: kind === 'voice-turn' ? ts : this.state.lastSpeechAt,
        lastActivityKind: kind,
      };
      this.dirty = true;
      this.maybePersist();
    } catch {
      // 观测绝不上抛：登记失败不影响调用方主链路
    }
  }

  /** 当前快照（深拷贝；任何情况下可调，不抛）。 */
  snapshot(): UserActivitySnapshot {
    try {
      return { ...this.state };
    } catch {
      return emptySnapshot();
    }
  }

  /**
   * lastActivityAt 是否落在 now 往前 ms 的窗口内（含边界）。
   * 无活动 → false；钟差/未来时间戳（其它进程时钟略快）→ 按「活跃」处理
   * （宁可信其有：误判活跃只是少一次主动播报，误判沉默会打扰用户）。
   */
  isActiveWithin(ms: number, now?: number): boolean {
    try {
      const last = this.state.lastActivityAt;
      if (last === null) return false;
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return false;
      const at = typeof now === 'number' && Number.isFinite(now) ? now : this.now();
      return at - last <= ms;
    } catch {
      return false;
    }
  }

  /** 立即落盘（无视节流；有未落盘的变更时补写）。写失败不抛、变更保留待下次。 */
  flush(): void {
    try {
      if (!this.dirty) return;
      this.persist();
    } catch {
      // 落盘失败不影响调用方
    }
  }

  // ─── 内部 ───

  /** 构造时同步读一次；读失败/损坏/形状不符 → 归零不抛。 */
  private readFromDisk(): UserActivitySnapshot {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      return emptySnapshot(); // 首次运行/文件不存在/读失败：无声归零（不是错误）
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown> | null;
      const lastActivityAt = toTimestamp(parsed?.['lastActivityAt']);
      const lastSpeechAt = toTimestamp(parsed?.['lastSpeechAt']);
      return {
        lastActivityAt,
        lastSpeechAt,
        // 时间戳缺失时 kind 不单独留存，避免「有 kind 无时间」的不一致快照
        lastActivityKind: lastActivityAt === null ? null : toKind(parsed?.['lastActivityKind']),
      };
    } catch {
      jarvisLogger.warn(`[UserActivity] 活动账文件损坏（按无活动处理）: ${this.filePath}`);
      return emptySnapshot();
    }
  }

  /** 节流闸门：脏且距上次落盘 ≥ 间隔（或从未写过）才写。 */
  private maybePersist(): void {
    if (!this.dirty) return;
    const at = this.now();
    if (this.lastPersistedAt !== null && at - this.lastPersistedAt < this.minWriteIntervalMs) return;
    this.persist();
  }

  /** 原子写（tmp + rename）；失败降级为仅内存（warn），dirty 保留待 flush 重试。 */
  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf-8');
      fs.renameSync(tmp, this.filePath);
      this.dirty = false;
    } catch (error) {
      jarvisLogger.warn(`[UserActivity] 活动账写入失败（降级，仅内存）: ${this.filePath}`, error);
    } finally {
      this.lastPersistedAt = this.now();
    }
  }
}

// ─── 默认路径与进程单例（生产共用；测试先重定向 XDG 再 reset） ───

/** 默认路径口径（与 jarvis-morning/jarvis-memory 同规）：XDG_DATA_HOME 优先，否则 ~/.local/share。 */
export function defaultUserActivityPath(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'tide-commander', 'user-activity', 'activity.json');
}

let defaultStore: UserActivityStore | null = null;

/** 懒创建进程单例。 */
export function getUserActivityStore(): UserActivityStore {
  if (!defaultStore) {
    let filePath: string;
    try {
      filePath = defaultUserActivityPath();
    } catch {
      // 极端环境（取不到家目录等）：降级到系统临时目录，活性观测绝不阻断主链路
      filePath = path.join(os.tmpdir(), 'tide-commander-user-activity', 'activity.json');
    }
    defaultStore = new UserActivityStore(filePath);
  }
  return defaultStore;
}

/** 登记一次活动（生产入口；服务内部已保证不上抛，此处双保险）。 */
export function noteUserActivity(kind: UserActivityKind, at?: number): void {
  try {
    getUserActivityStore().note(kind, at);
  } catch {
    // 观测绝不上抛
  }
}

/** 当前用户活动快照。 */
export function getUserActivitySnapshot(): UserActivitySnapshot {
  try {
    return getUserActivityStore().snapshot();
  } catch {
    return emptySnapshot();
  }
}

/** 用户是否在最近 ms 内有过活动。 */
export function isUserActiveWithin(ms: number, now?: number): boolean {
  try {
    return getUserActivityStore().isActiveWithin(ms, now);
  } catch {
    return false;
  }
}

/** 测试专用：丢弃进程内单例（不删文件）。 */
export function resetUserActivityForTests(): void {
  defaultStore = null;
}
