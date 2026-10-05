/**
 * 语音伙伴 · 分钟级提醒服务(存储 + 服务端定时器 + 到点 WS 广播)。
 *
 * 背景(2026-10-05 23:56 事故):「两分钟后叫我一下」被 hop1(42s 后)路由到
 * 天级 bolba 板,到点全链路寂静。本服务是修复的承重件:解析(reminder-parse,
 * pre-hop1 毫秒)之后,注册即落盘 + setTimeout,到点转 due + 广播推送,
 * 客户端(语音页 leader)播报后回执 ack。
 *
 * 生命周期(与「不承诺必响」的诚实边界一致):
 *   register → pending(setTimeout)
 *   到点     → due(广播;页面不在线则挂起)
 *   ack      → done(播报完成;幂等)
 *   cancel   → cancelled(pending/due 一并撤)
 *   boot rearm: pending 未到点 → 重设定时;已过期 ≤1h → 立即 due(补播);
 *               更久 → cancelled(如实放弃,日志留痕)
 *
 * 持久化:jarvis-reminders/reminders.json(XDG 数据目录,同 jarvis-morning 规),
 * 原子写(tmp + rename),损坏容错为初始态(绝不抛、绝不阻断主链路)。
 * 开关:TC_VOICE_REMINDER=0 关(路由层回落普通回合)。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { logger } from '../utils/index.js';
import { buildReminderFirePhrase, type ReminderCreateCommand } from '../voice/reminder-parse.js';
import type { ServerMessage } from '../../shared/types.js';

// ============================================================================
// 类型与常量
// ============================================================================

export type VoiceReminderStatus = 'pending' | 'due' | 'done' | 'cancelled';

export interface VoiceReminder {
  id: string;
  /** 事项文本(可能空串 → 到点只报「到点了」)。 */
  itemText: string;
  /** 注册原话(排障用;onSentence 不进日志)。 */
  sourceText: string;
  createdAt: number;
  fireAt: number;
  status: VoiceReminderStatus;
  /** ack 时间(播报完成回执)。 */
  deliveredAt?: number;
  /** 终态时间(done/cancelled)。 */
  closedAt?: number;
}

/** pending 上限(防无界堆积;到点拒绝时路由换话术)。 */
export const REMINDER_MAX_PENDING = 10;

/** boot rearm:已过期但在此窗口内 → 立即 due 补播;更久 → 取消(不骚扰)。 */
export const REMINDER_LATE_DELIVER_WINDOW_MS = 60 * 60_000;

/** 终态记录保留期(超过则在下次持久化时清理;done/cancelled 只作排障)。 */
export const REMINDER_TERMINAL_KEEP_MS = 7 * 24 * 60 * 60_000;

const TERMINAL_STATUSES: ReadonlySet<VoiceReminderStatus> = new Set(['done', 'cancelled']);

/** 开关:TC_VOICE_REMINDER=0 → 关(路由层判定)。 */
export function isVoiceReminderEnabled(): boolean {
  return process.env.TC_VOICE_REMINDER !== '0';
}

/** 默认存储路径(生产;测试必须显式注入临时文件)。 */
export function defaultVoiceReminderPath(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'tide-commander', 'jarvis-reminders', 'reminders.json');
}

/** 到点下发的播报载荷(客户端直接播,不自行拼话术)。 */
export interface DueReminderPayload {
  id: string;
  itemText: string;
  fireAt: number;
  /** 到点话术(「老大,到点了:喝水。」)。 */
  say: string;
}

/** 记录 → 下发载荷。 */
export function toDuePayload(reminder: VoiceReminder): DueReminderPayload {
  return {
    id: reminder.id,
    itemText: reminder.itemText,
    fireAt: reminder.fireAt,
    say: buildReminderFirePhrase(reminder.itemText),
  };
}

/** 提醒推送的合成发送者标识(agent_notification 复用;客户端按此识别提醒)。 */
export const VOICE_REMINDER_AGENT_ID = 'voice-reminder';

/**
 * due 载荷 → agent_notification 广播(复用既有消息类型与客户端回调,
 * 不新增 WS 协议;到点顺带弹 toast/提示音,语音页 leader 另走播报+ack)。
 */
export function buildReminderNotificationMessage(payload: DueReminderPayload): ServerMessage {
  return {
    type: 'agent_notification',
    payload: {
      id: `voice-reminder-${payload.id}`,
      agentId: VOICE_REMINDER_AGENT_ID,
      agentName: '语音提醒',
      agentClass: 'support',
      title: '到点了',
      message: payload.say,
      timestamp: Date.now(),
    },
  } as ServerMessage;
}

// ============================================================================
// 话术构建(确定性)
// ============================================================================

/** 距到点的口语化时长(播报用;<60s 秒、<90min 分钟、其余小时;已过 → 已到点)。 */
export function formatReminderDelayText(ms: number): string {
  if (ms <= 0) return '已到点';
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)} 分钟`;
  const hours = ms / 3_600_000;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时`;
}

/** 列表回执:编号 + 还有多久 + 事项。 */
export function buildReminderListSay(reminders: readonly VoiceReminder[], now: number): string {
  if (reminders.length === 0) return '现在没有挂着的提醒。';
  const items = reminders.map((r, i) => {
    const delay = r.fireAt - now;
    if (delay <= 0) return `${i + 1})已到点${r.itemText ? `:${r.itemText}` : ''}`;
    const tail = r.itemText ? `提醒你${r.itemText}` : '喊你';
    return `${i + 1})${formatReminderDelayText(delay)}后${tail}`;
  });
  return `有 ${reminders.length} 条:${items.join(';')}。`;
}

/** 上限拒绝话术(路由用)。 */
export function buildReminderCapSay(): string {
  return `手上挂的提醒到上限了(${REMINDER_MAX_PENDING} 条),先消掉几条再记。`;
}

// ============================================================================
// 文件存储(load 缓存 + 原子写 + 损坏容错)
// ============================================================================

const STATUSES: ReadonlySet<string> = new Set(['pending', 'due', 'done', 'cancelled']);

interface ReminderFileState {
  version: 1;
  reminders: VoiceReminder[];
}

/** 逐条校验:字段不正的记录直接丢弃(损坏文件不让服务带病运行)。 */
function sanitizeReminder(raw: unknown): VoiceReminder | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<VoiceReminder>;
  if (typeof r.id !== 'string' || !r.id) return null;
  if (typeof r.fireAt !== 'number' || !Number.isFinite(r.fireAt)) return null;
  if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) return null;
  if (typeof r.status !== 'string' || !STATUSES.has(r.status)) return null;
  const reminder: VoiceReminder = {
    id: r.id,
    itemText: typeof r.itemText === 'string' ? r.itemText : '',
    sourceText: typeof r.sourceText === 'string' ? r.sourceText : '',
    createdAt: r.createdAt,
    fireAt: r.fireAt,
    status: r.status as VoiceReminderStatus,
  };
  if (typeof r.deliveredAt === 'number') reminder.deliveredAt = r.deliveredAt;
  if (typeof r.closedAt === 'number') reminder.closedAt = r.closedAt;
  return reminder;
}

export class FileVoiceReminderStore {
  readonly filePath: string;
  private cache: VoiceReminder[] | null = null;

  constructor(options: { filePath?: string } = {}) {
    this.filePath = options.filePath ?? defaultVoiceReminderPath();
  }

  load(): VoiceReminder[] {
    if (this.cache) return this.cache;
    let content: string;
    try {
      content = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      this.cache = []; // 首次运行/文件不存在:无声初始态(不是错误)
      return this.cache;
    }
    try {
      const parsed = JSON.parse(content) as Partial<ReminderFileState>;
      const list = Array.isArray(parsed.reminders) ? parsed.reminders : [];
      this.cache = list.map(sanitizeReminder).filter((r): r is VoiceReminder => r !== null);
    } catch (error) {
      logger.server.warn(`[VoiceReminder] 存储文件损坏(按空处理): ${this.filePath} ${(error as Error)?.message}`);
      this.cache = [];
    }
    return this.cache;
  }

  /** 原子写(tmp + rename);写失败降级为内存态(不阻断注册/播报)。 */
  save(reminders: readonly VoiceReminder[]): void {
    const state: ReminderFileState = { version: 1, reminders: [...reminders] };
    this.cache = state.reminders;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      logger.server.warn(`[VoiceReminder] 写入失败(降级内存态): ${this.filePath} ${(error as Error)?.message}`);
    }
  }
}

// ============================================================================
// 服务(存储 + 定时器 + 推送)
// ============================================================================

export interface VoiceReminderServiceOptions {
  filePath?: string;
  /** 时钟注入(测试);缺省 Date.now。 */
  now?: () => number;
  /** 到点推送(生产由 websocket/handler 接线 broadcast;缺省 = 不推,靠轮询兜底)。 */
  push?: (payload: DueReminderPayload) => void;
}

export type RegisterResult =
  | { ok: true; reminder: VoiceReminder }
  | { ok: false; reason: 'cap' };

let idSeq = 0;

export class VoiceReminderService {
  private readonly store: FileVoiceReminderStore;
  private readonly now: () => number;
  private readonly push: (payload: DueReminderPayload) => void;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(options: VoiceReminderServiceOptions = {}) {
    this.store = new FileVoiceReminderStore({ filePath: options.filePath });
    this.now = options.now ?? (() => Date.now());
    this.push = options.push ?? (() => {});
  }

  /** 注册一条提醒(解析已完成,此处只做上限与调度)。 */
  register(create: ReminderCreateCommand, sourceText: string): RegisterResult {
    const all = this.store.load();
    const pending = all.filter((r) => r.status === 'pending');
    if (pending.length >= REMINDER_MAX_PENDING) {
      logger.server.log(`[VoiceReminder] 注册被拒(上限 ${REMINDER_MAX_PENDING}): "${sourceText.slice(0, 60)}"`);
      return { ok: false, reason: 'cap' };
    }
    const now = this.now();
    const reminder: VoiceReminder = {
      id: `vr-${now.toString(36)}-${(idSeq++).toString(36)}`,
      itemText: create.itemText,
      sourceText: sourceText.slice(0, 200),
      createdAt: now,
      fireAt: create.fireAt,
      status: 'pending',
    };
    all.push(reminder);
    this.persist(all);
    this.schedule(reminder);
    logger.server.log(
      `[VoiceReminder] 注册 id=${reminder.id} 延迟=${create.delayMs}ms 事项="${reminder.itemText}" 原话="${reminder.sourceText.slice(0, 60)}"`,
    );
    return { ok: true, reminder };
  }

  /** 取消全部在挂(pending + 未回执 due);返回取消条数。 */
  cancelActive(): number {
    const all = this.store.load();
    const now = this.now();
    let count = 0;
    for (const r of all) {
      if (r.status === 'pending' || r.status === 'due') {
        r.status = 'cancelled';
        r.closedAt = now;
        this.clearTimer(r.id);
        count++;
      }
    }
    if (count > 0) this.persist(all);
    logger.server.log(`[VoiceReminder] 取消 ${count} 条`);
    return count;
  }

  /** 在挂(pending + due)按到点时间升序(列表播报用)。 */
  listActive(): VoiceReminder[] {
    return this.store
      .load()
      .filter((r) => r.status === 'pending' || r.status === 'due')
      .sort((a, b) => a.fireAt - b.fireAt);
  }

  /** 待播(due)记录,按到点时间升序(客户端轮询兜底用)。 */
  listDue(): VoiceReminder[] {
    return this.store
      .load()
      .filter((r) => r.status === 'due')
      .sort((a, b) => a.fireAt - b.fireAt);
  }

  /** 播报完成回执:due → done;已 done 幂等 true;pending/cancelled/未知 → false。 */
  ack(id: string): boolean {
    const all = this.store.load();
    const record = all.find((r) => r.id === id);
    if (!record) return false;
    if (record.status === 'done') return true;
    if (record.status !== 'due') return false;
    const now = this.now();
    record.status = 'done';
    record.deliveredAt = now;
    record.closedAt = now;
    this.persist(all);
    logger.server.log(`[VoiceReminder] 回执 id=${id} 晚到=${now - record.fireAt}ms`);
    return true;
  }

  /**
   * boot/懒加载 rearm:未到点重设定时;已过期 ≤1h → 立即 due 并推送(页面在则补播);
   * 更久 → cancelled(如实放弃,日志留痕)。重复调用安全(幂等)。
   */
  rearm(): void {
    const all = this.store.load();
    const now = this.now();
    let scheduled = 0;
    let late = 0;
    let expired = 0;
    let changed = false;
    for (const r of all) {
      if (r.status !== 'pending') continue;
      if (r.fireAt > now) {
        this.schedule(r);
        scheduled++;
      } else if (now - r.fireAt <= REMINDER_LATE_DELIVER_WINDOW_MS) {
        r.status = 'due';
        changed = true;
        late++;
        logger.server.log(`[VoiceReminder] 补发(重启晚到 ${now - r.fireAt}ms) id=${r.id} 事项="${r.itemText}"`);
        this.emit(r);
      } else {
        r.status = 'cancelled';
        r.closedAt = now;
        changed = true;
        expired++;
        logger.server.log(`[VoiceReminder] 过期取消(晚 ${now - r.fireAt}ms > 1h) id=${r.id} 事项="${r.itemText}"`);
      }
    }
    if (changed) this.persist(all);
    if (scheduled || late || expired) {
      logger.server.log(`[VoiceReminder] rearm 定时=${scheduled} 补发=${late} 过期取消=${expired}`);
    }
  }

  /** 测试/关停:清空定时器。 */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  // ── 内部 ──

  private persist(reminders: VoiceReminder[]): void {
    const now = this.now();
    const pruned = reminders.filter(
      (r) => !(TERMINAL_STATUSES.has(r.status) && typeof r.closedAt === 'number' && now - r.closedAt > REMINDER_TERMINAL_KEEP_MS),
    );
    this.store.save(pruned);
  }

  private schedule(reminder: VoiceReminder): void {
    this.clearTimer(reminder.id);
    const delay = Math.max(0, reminder.fireAt - this.now());
    const timer = setTimeout(() => this.fire(reminder.id), delay);
    this.timers.set(reminder.id, timer);
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private fire(id: string): void {
    this.timers.delete(id);
    const all = this.store.load();
    const record = all.find((r) => r.id === id);
    if (!record || record.status !== 'pending') return; // 已被取消/替换
    record.status = 'due';
    this.persist(all);
    logger.server.log(`[VoiceReminder] 到点 id=${id} 偏差=${this.now() - record.fireAt}ms 事项="${record.itemText}"`);
    this.emit(record);
  }

  private emit(record: VoiceReminder): void {
    try {
      this.push(toDuePayload(record));
    } catch (error) {
      logger.server.warn(`[VoiceReminder] 推送失败(轮询兜底): ${(error as Error)?.message}`);
    }
  }
}

// ============================================================================
// 进程单例与推送接线(websocket/handler 初始化时 setVoiceReminderPush)
// ============================================================================

let pushHandler: ((payload: DueReminderPayload) => void) | null = null;

/** 接线到 websocket broadcast(生产);模块级以便 service 懒创建后也能取到。 */
export function setVoiceReminderPush(handler: ((payload: DueReminderPayload) => void) | null): void {
  pushHandler = handler;
}

let defaultService: VoiceReminderService | null = null;

/**
 * 进程单例(懒创建 + 一次 rearm)。boot 后首个触达(注册/轮询)时创建:
 * 此时推送接线已就位(websocket 初始化先于用户交互),补发即可广播;
 * 若补发时页面不在线,记录保持 due,由轮询取走 —— 不丢。
 */
export function getVoiceReminderService(): VoiceReminderService {
  if (!defaultService) {
    defaultService = new VoiceReminderService({ push: (payload) => pushHandler?.(payload) });
    defaultService.rearm();
  }
  return defaultService;
}

/** 测试专用:丢弃进程单例。 */
export function resetVoiceReminderServiceForTests(): void {
  defaultService?.dispose();
  defaultService = null;
}
