/**
 * 语音伙伴 · 分钟级提醒取件(客户端半边;2026-10-05 事故修复链路上游见 server/voice/reminder-parse.ts)
 *
 * 服务端到点后 status=due 并广播(复用 agent_notification 形态,带标记);本模块负责:
 *   1. 主通道:链式包装 cb.onAgentNotification(**绝不覆盖既有 toast 消费**,
 *      stop 时若仍是我们包的则还原),认出标记后仅 leader 页处理;
 *   2. 兜底轮询:每 pollIntervalMs(默认 5s)GET /reminders/due —— WS 断线、
 *      页面刚开、包装被后挂载组件顶掉(下一跳自愈重包),都由此补上;
 *   3. 播报与回执:入 SpeechQueue 播报,**播完(或被打断)再 POST /reminders/ack**
 *      (幂等);崩溃/断网未 ack → 服务端仍 due,下回进页补播,不丢。
 * 忙碌(聆听/转写/思考/播报中)不插话:挂起,由下一 tick 的轮询顺带重试。
 * 去重:WS 与轮询同一条可能都到 → seen 按提醒 id 一次消费;已 ack 的重复下发同样被拦。
 * 非 leader 页收到一概不认领(不标记,接管为 leader 后由轮询补播)。
 *
 * 标记约定的另一端在 server/services/voice-reminder-service.ts:
 *   VOICE_REMINDER_AGENT_ID='voice-reminder';通知 id 前缀 'voice-reminder-{提醒id}';
 *   播报文本取通知 message(服务端确定性话术,客户端不自行拼)。
 */

import { cb } from '../websocket/callbacks';
import type { AgentNotification } from '../../shared/types';

/** 与 server/services/voice-reminder-service.ts 的 VOICE_REMINDER_AGENT_ID 对齐(客户端不 import 服务端). */
export const VOICE_REMINDER_AGENT_ID = 'voice-reminder';
/** 与 buildReminderNotificationMessage 的通知 id 前缀对齐:`voice-reminder-{提醒id}`. */
export const VOICE_REMINDER_ID_PREFIX = 'voice-reminder-';

/** 无事项提醒的兜底话术(服务端总会带 say;缺字段时才用)。 */
const FALLBACK_SAY = '老大,到点了。';

/** 已认领 id 上限(防无界;提醒本就近百量级,够拦重复)。 */
const MAX_SEEN = 200;

/** 一条待播提醒(两条通道归一后的最小形态)。 */
export interface DueReminder {
  id: string;
  say: string;
}

/**
 * 纯函数:agent_notification → 提醒取件;非提醒通知(或无有效 id)返回 null。
 * 判据:agentId 命中且 id 带前缀(前缀后必须还有提醒 id 本体)。
 */
export function parseReminderNotification(notification: {
  id?: string;
  agentId?: string;
  message?: string;
}): DueReminder | null {
  if (!notification || notification.agentId !== VOICE_REMINDER_AGENT_ID) return null;
  const id = typeof notification.id === 'string' ? notification.id : '';
  if (!id.startsWith(VOICE_REMINDER_ID_PREFIX)) return null;
  const reminderId = id.slice(VOICE_REMINDER_ID_PREFIX.length);
  if (!reminderId) return null;
  const say = typeof notification.message === 'string' && notification.message.trim()
    ? notification.message.trim()
    : FALLBACK_SAY;
  return { id: reminderId, say };
}

export interface ReminderWatcherDeps {
  /** 本页是否 leader(多标签页只让 leader 出声)。 */
  isLeader: () => boolean;
  /** 忙碌(聆听/转写/思考/播报中):挂起,下一 tick 再试。 */
  isBusy: () => boolean;
  /** 播报一句(入 SpeechQueue 并等到播完/被打断;失败请 reject)。 */
  speak: (text: string) => Promise<void>;
  /** 播报完成回执(POST /reminders/ack;幂等)。 */
  ack: (id: string) => Promise<void>;
  /** GET /reminders/due(按到点时间升序;失败请 reject)。 */
  fetchDue: () => Promise<DueReminder[]>;
  /** 轮询间隔(ms);默认 5000(VoiceCompanion 的 leader tick 同频)。 */
  pollIntervalMs?: number;
  /** 异常留痕(默认 console.warn);测试可注入收集。 */
  log?: (message: string) => void;
}

export interface ReminderWatcherHandle {
  start(): void;
  stop(): void;
  /**
   * WS 通知入口(链式包装内调用;也供测试/其它通道注入)。
   * 返回 true = 是提醒类通知(是否认领播报另由 leader/去重/开关决定)。
   */
  ingestNotification: (notification: AgentNotification | { id?: string; agentId?: string; message?: string }) => boolean;
  /** 立即跑一次「自愈包装 + 拉取 due + 推进播报」(测试;start 后另有定时轮询)。 */
  pollNow: () => Promise<void>;
  /** 待播条数(测试/观测)。 */
  pendingCount: () => number;
}

type NotificationHandler = (notification: AgentNotification) => void;
type WrappedHandler = NotificationHandler & { __tcVoiceReminderPrev?: NotificationHandler | null };

export function createReminderWatcher(deps: ReminderWatcherDeps): ReminderWatcherHandle {
  const pollMs = deps.pollIntervalMs ?? 5_000;
  const log = deps.log ?? ((message: string) => console.warn(`[语音提醒] ${message}`));

  /** 已认领提醒 id(一次消费;WS/轮询重复同一条在此拦掉)。 */
  const seen: string[] = [];
  /** 已认领待播(busy 时挂起)。 */
  const pending: DueReminder[] = [];
  let speakingNow = false;
  let polling = false;
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let hookWrapper: WrappedHandler | null = null;

  /** 认领一条:leader + 未见过才收;返回是否收到了 pending。 */
  function claim(reminder: DueReminder): boolean {
    if (!deps.isLeader()) return false; // 非 leader 不标记:接管后由轮询补
    if (!reminder.id || seen.includes(reminder.id)) return false;
    seen.push(reminder.id);
    if (seen.length > MAX_SEEN) seen.splice(0, seen.length - MAX_SEEN);
    pending.push(reminder);
    void pump();
    return true;
  }

  /** 串行播报:一次一条,播完 ack;busy/播报中则挂起,等下一 tick 触发。 */
  async function pump(): Promise<void> {
    if (speakingNow) return;
    const next = pending[0];
    if (!next) return;
    if (deps.isBusy()) return; // 挂起,下一 tick(pollNow 末尾)重试
    pending.shift();
    speakingNow = true;
    try {
      await deps.speak(next.say);
      try {
        await deps.ack(next.id); // 播完才回执;失败保持 due → 下回进页补播,但不在本页重播(seen)
      } catch (err) {
        log(`回执失败(服务端保持 due,下回补播): ${(err as Error)?.message}`);
      }
    } catch (err) {
      // 播报失败不 ack:保持 due,留给下一轮/下个页面补播
      log(`播报失败(保持 due): ${(err as Error)?.message}`);
    } finally {
      speakingNow = false;
      if (pending.length > 0) void pump();
    }
  }

  /** 链式包装:捕捉当前 handler 为 prev,转发后处理提醒;自愈重包(每次轮询调用)。 */
  function installHook(): void {
    const current = cb.onAgentNotification;
    // hookWrapper 判空必须先判:双方都是 null 时 current === hookWrapper 会误判「已安装」
    if (hookWrapper !== null && current === hookWrapper) return;
    const prev = current;
    const wrapper: WrappedHandler = (notification) => {
      try {
        prev?.(notification); // 既有消费(toast 等)先走,绝不顶掉
      } catch (err) {
        log(`既有通知消费回调出错(不阻断提醒): ${(err as Error)?.message}`);
      }
      try {
        ingestNotification(notification);
      } catch (err) {
        log(`提醒取件异常: ${(err as Error)?.message}`);
      }
    };
    wrapper.__tcVoiceReminderPrev = prev;
    hookWrapper = wrapper;
    cb.onAgentNotification = wrapper;
  }

  function uninstallHook(): void {
    if (hookWrapper && cb.onAgentNotification === hookWrapper) {
      cb.onAgentNotification = hookWrapper.__tcVoiceReminderPrev ?? null; // 还是我们包的才还原
    }
    hookWrapper = null;
  }

  function ingestNotification(
    notification: AgentNotification | { id?: string; agentId?: string; message?: string },
  ): boolean {
    const reminder = parseReminderNotification(notification);
    if (!reminder) return false;
    if (running) claim(reminder);
    return true;
  }

  async function pollNow(): Promise<void> {
    if (!running) return;
    installHook(); // 自愈:被后挂载组件顶掉时重新链接(幂等)
    if (!polling) {
      polling = true;
      try {
        const list = await deps.fetchDue();
        if (running) {
          for (const reminder of list) claim(reminder);
        }
      } catch (err) {
        log(`轮询失败(下一 tick 重试): ${(err as Error)?.message}`);
      } finally {
        polling = false;
      }
    }
    void pump(); // busy 挂起的条目由下一 tick 顺带重试
  }

  function start(): void {
    if (running) return;
    running = true;
    installHook();
    void pollNow(); // 页面刚开:立即补拉一次
    timer = setInterval(() => void pollNow(), pollMs);
  }

  function stop(): void {
    running = false;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    uninstallHook();
    // seen/pending 保留:leader 抖动后重启不重播已认领条目(服务端 ack 幂等兜底)
  }

  return {
    start,
    stop,
    ingestNotification,
    pollNow,
    pendingCount: () => pending.length,
  };
}
