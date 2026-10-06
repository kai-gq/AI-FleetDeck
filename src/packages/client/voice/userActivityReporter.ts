/**
 * 语音伙伴 · 用户活跃上报(客户端半边;服务端端点 POST /api/user-activity/report,契约已冻结)
 *
 * 只报「发生过输入 / 焦点变化」这件事本身,不含任何内容:
 *   - 监听器零读事件(不看 key / 坐标 / 目标),只做节流判定 → 上报;
 *   - 三类 kind:'voice-page'(start 立即一次,force)/ 'focus'(window focus +
 *     document 变可见)/ 'input'(keydown / pointerdown / wheel);
 *   - 全部 kind 共享一个 leading-edge 节流窗口(默认 60s):窗口内首次触发即上报,
 *     其余丢弃;reportNow(kind,{force:true}) 无视节流。不进队列、不重试;
 *   - 服务端自己取时不信任客户端时间戳,故请求体只带 kind;
 *   - 失败一律静默(dev 下 console.debug 留痕),绝不上抛、绝不影响页面。
 *
 * 挂接见 components/VoiceCompanion.tsx:ref + useEffect(create → start;cleanup → stop),
 * 与 voice/reminderWatcher 同一套模块风格(可注入 now/post/target 便于单测)。
 */

import { apiUrl, authFetch } from '../utils/storage';

export type UserActivityKind = 'voice-page' | 'focus' | 'input';

/** 默认节流窗口(ms):窗口内多次活动只上报一次(leading edge)。 */
export const DEFAULT_USER_ACTIVITY_THROTTLE_MS = 60_000;

export interface UserActivityReporterOptions {
  /** 节流窗口(ms),默认 60_000:窗口内多次活动只上报一次(leading edge)。 */
  throttleMs?: number;
  /** 取时注入(测试用,不用真 sleep)。 */
  now?: () => number;
  /** 上报注入;缺省 POST /api/user-activity/report。 */
  post?: (kind: UserActivityKind) => void | Promise<void>;
  /** 事件目标注入;缺省全局 document/window(两者都缺 → start no-op)。 */
  target?: { document?: Document; window?: Window };
}

export interface UserActivityReporterHandle {
  start(): void;
  stop(): void;
  /** 立即按节流规则上报一次(force 无视节流)。start 前/stop 后 no-op。 */
  reportNow(kind: UserActivityKind, opts?: { force?: boolean }): void;
}

/** 输入类监听:passive + 捕获(不读内容,只为「发生过输入」计数)。 */
const INPUT_LISTENER_OPTS: AddEventListenerOptions = { passive: true, capture: true };

/** dev 留痕(生产静默;失败绝不上抛)。 */
function devLog(message: string): void {
  if (import.meta.env.DEV) console.debug(`[用户活跃] ${message}`);
}

/** 缺省上报:POST /api/user-activity/report(与 ackVoiceReminder 同一套 authFetch/apiUrl)。 */
async function postUserActivity(kind: UserActivityKind): Promise<void> {
  try {
    const res = await authFetch(apiUrl('/api/user-activity/report'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind }),
    });
    if (!res.ok) devLog(`上报未成功(${res.status})`);
  } catch (err) {
    devLog(`上报失败(静默): ${(err as Error)?.message}`);
  }
}

export function createUserActivityReporter(
  options: UserActivityReporterOptions = {},
): UserActivityReporterHandle {
  const throttleMs = options.throttleMs ?? DEFAULT_USER_ACTIVITY_THROTTLE_MS;
  const now = options.now ?? (() => Date.now());
  const post = options.post ?? postUserActivity;

  // 防御式取 DOM:纯 node 环境无全局 document/window → start 直接 no-op;
  // 注入 target 时只用注入的目标、不回落全局(测试可确定性断言)。
  const doc = options.target
    ? options.target.document
    : typeof document !== 'undefined'
      ? document
      : undefined;
  const win = options.target
    ? options.target.window
    : typeof window !== 'undefined'
      ? window
      : undefined;

  let running = false;
  let listening = false;
  /** 上一次实际上报时刻(null = 尚未报过);全部 kind 共享同一窗口。 */
  let lastReportAt: number | null = null;

  /** 落地一次上报:post 同步抛错 / 异步 reject 一律静默吞掉,不进队列、不重试。 */
  function emit(kind: UserActivityKind): void {
    try {
      const result = post(kind);
      if (result && typeof (result as Promise<void>).then === 'function') {
        void (result as Promise<void>).then(undefined, (err: unknown) => {
          devLog(`上报失败(静默): ${(err as Error)?.message}`);
        });
      }
    } catch (err) {
      devLog(`上报失败(静默): ${(err as Error)?.message}`);
    }
  }

  function reportNow(kind: UserActivityKind, opts: { force?: boolean } = {}): void {
    if (!running) return;
    const at = now();
    if (!opts.force && lastReportAt !== null && at - lastReportAt < throttleMs) return;
    lastReportAt = at; // force 同样重开窗口,后续非 force 从此刻重新计时
    emit(kind);
  }

  // 监听器引用固定(挂/卸同一函数,避免泄漏);零读事件内容。
  const onInput = (): void => reportNow('input');
  const onFocus = (): void => reportNow('focus');
  const onVisibilityChange = (): void => {
    if (doc?.visibilityState === 'visible') reportNow('focus'); // 只在「变可见」时算一次活跃
  };

  function start(): void {
    if (running) return;
    if (!doc && !win) return; // 无 DOM(纯 node):no-op
    running = true;
    reportNow('voice-page', { force: true }); // 进页即算一次活跃,不受节流
    listening = true;
    doc?.addEventListener('keydown', onInput, INPUT_LISTENER_OPTS);
    doc?.addEventListener('pointerdown', onInput, INPUT_LISTENER_OPTS);
    doc?.addEventListener('wheel', onInput, INPUT_LISTENER_OPTS);
    doc?.addEventListener('visibilitychange', onVisibilityChange);
    win?.addEventListener('focus', onFocus);
  }

  function stop(): void {
    running = false; // stop 后不再上报(含 reportNow)
    if (!listening) return;
    listening = false;
    doc?.removeEventListener('keydown', onInput, INPUT_LISTENER_OPTS);
    doc?.removeEventListener('pointerdown', onInput, INPUT_LISTENER_OPTS);
    doc?.removeEventListener('wheel', onInput, INPUT_LISTENER_OPTS);
    doc?.removeEventListener('visibilitychange', onVisibilityChange);
    win?.removeEventListener('focus', onFocus);
  }

  return { start, stop, reportNow };
}
