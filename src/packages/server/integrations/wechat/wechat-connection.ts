/**
 * WeChat ClawBot connection — state machine + long-poll loop.
 *
 * There is no external bridge process: this module IS the iLink client host.
 * The loop runs getupdates (hold ≤35s) inside the TC server, persists the
 * cursor BEFORE dispatching messages, and mirrors WhatsApp's filter chain
 * (bot echo → self-loop → dedupe → empty content).
 *
 * Shutdown contract: `stop()` is synchronous — it flips `running` and aborts
 * the in-flight long poll — because the core server force-kills integrations
 * after 4500ms (server/index.ts FORCE_SHUTDOWN_TIMEOUT_MS). Never await the
 * in-flight poll during shutdown.
 *
 * States: disabled / disconnected / qr_pending / connected / needs_reauth.
 */

import type { IntegrationContext } from '../../../shared/integration-types.js';
import { createLogger } from '../../utils/logger.js';
import {
  ILinkClient,
  ILinkError,
  extractWeChatText,
  maskWechatToken,
  normalizeWeChatTimestamp,
  parseWeChatMessage,
} from './ilink-client.js';
import {
  loadConfig,
  updateConfig,
  WECHAT_BOT_TOKEN_SECRET,
  type WeChatConfig,
} from './wechat-config.js';
import {
  humanizeWeChatId,
  notifyWeChatSubscribers,
  resolveWeChatDisplayName,
  type NormalizedWeChatMessage,
} from './wechat-trigger-handler.js';
import { MessageDedupeCache } from './message-dedupe.js';

const log = createLogger('WeChatConnection');

export type WeChatConnectionState = 'disabled' | 'disconnected' | 'qr_pending' | 'connected' | 'needs_reauth';

/** Long-poll request budget: server holds ≤35s, 45s leaves margin. */
export const LONG_POLL_TIMEOUT_MS = 45_000;

/** QR login: server-side poll cadence + overall deadline (mirrors the S0 tool). */
const DEFAULT_QR_POLL_INTERVAL_MS = 2_000;
const DEFAULT_QR_TIMEOUT_MS = 120_000;

/** Backoff ladder for consecutive poll failures (trial run saw ~1/2/5/15/30s in S0 tooling). */
const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

/**
 * iLink ret values that mean "credentials are dead, rescan required".
 * TODO(S0): pin the real expiry/revocation ret codes from the p6 long run —
 * until then these are the transcribed guesses (HTTP-style auth codes).
 */
const AUTH_FAILURE_RET = new Set([401, 403]);

/** Non-auth errors must fail 3× AND span this window before we demand a rescan. */
const AUTH_FAILURE_WINDOW_MS = 5 * 60_000;

/** Status spellings for the QR poll — S0 定案后在这里收紧（集中一处）。 */
const CONFIRMED_STATUSES = new Set(['confirmed', 'confirm', 'success', 'logged_in', 'bound']);
const DEAD_STATUSES = new Set(['expired', 'expire', 'canceled', 'cancelled', 'invalid', 'timeout']);

const DEDUPE_MAX_ENTRIES = 256;
const DEDUPE_TTL_MS = 60_000;

const RECENT_INBOUND_MAX = 64;
const RECENT_INBOUND_TTL_MS = 24 * 60 * 60_000;

// ─── Public shapes ───

export interface WeChatConnectionErrorCode {
  code: 'already_connected' | 'qr_unavailable' | 'not_connected' | 'no_context_token' | 'rate_limited';
}

export class WeChatConnectionError extends Error {
  constructor(
    public readonly code: WeChatConnectionErrorCode['code'],
    message: string,
  ) {
    super(message);
    this.name = 'WeChatConnectionError';
  }
}

export interface LoginSession {
  imgContent: string;
  startedAt: number;
  deadlineAt: number;
  status: string;
  error?: string;
  confirmed: boolean;
}

export interface RecentInboundEntry {
  userId: string;
  displayName: string;
  preview: string;
  at: number;
  hasContextToken: boolean;
}

export interface WeChatConnectionInfo {
  state: WeChatConnectionState;
  hasToken: boolean;
  enabled: boolean;
  botUserId?: string;
  connectedAt?: number;
  lastPollAt?: number;
  lastMessageAt?: number;
  lastError?: string;
  needsReauth: boolean;
}

export interface WeChatConnectionDeps {
  secrets: { get: (key: string) => string | undefined; set: (key: string, value: string) => void };
  log: IntegrationContext['log'];
  /** Injectable for tests; defaults to `new ILinkClient(opts)`. */
  createClient?: (opts: { baseUrl?: string; botToken?: string }) => ILinkClient;
  /** Injectable clock (tests). */
  now?: () => number;
  qrPollIntervalMs?: number;
  qrTimeoutMs?: number;
  backoffMs?: number[];
}

export interface WeChatConnectionHandle {
  /** Reconcile loop against persisted config + secrets. Idempotent. */
  sync(): void;
  startLogin(): Promise<LoginSession>;
  getLoginSession(): LoginSession | null;
  cancelLogin(): void;
  logout(): void;
  getInfo(): WeChatConnectionInfo;
  getRecentInbound(): RecentInboundEntry[];
  sendMessage(opts: { toUserId: string; text: string; contextToken?: string }): Promise<{ raw: unknown }>;
  /** Synchronous teardown: flips running + aborts the in-flight long poll. */
  stop(): void;
  isRunning(): boolean;
}

// ─── Helpers ───

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

// ─── Factory ───

export function createWeChatConnection(deps: WeChatConnectionDeps): WeChatConnectionHandle {
  const now = deps.now ?? Date.now;
  const qrPollIntervalMs = deps.qrPollIntervalMs ?? DEFAULT_QR_POLL_INTERVAL_MS;
  const qrTimeoutMs = deps.qrTimeoutMs ?? DEFAULT_QR_TIMEOUT_MS;
  const backoffMs = deps.backoffMs ?? DEFAULT_BACKOFF_MS;
  const createClient =
    deps.createClient ?? ((opts: { baseUrl?: string; botToken?: string }) => new ILinkClient(opts));

  const dedupe = new MessageDedupeCache({ maxEntries: DEDUPE_MAX_ENTRIES, ttlMs: DEDUPE_TTL_MS });
  const recentInbound = new Map<string, RecentInboundEntry & { contextToken?: string }>();
  const sendTimestamps: number[] = [];

  let running = false;
  let controller: AbortController | null = null;
  let activeToken: string | undefined;
  let cursor = '';

  let loginSession: LoginSession | null = null;
  /** Poll id for the in-flight QR session — private, never shipped to clients. */
  let loginQrcodeId: string | null = null;
  let loginTimer: ReturnType<typeof setInterval> | null = null;
  let loginPolling = false;

  // ── recent inbound (reply-token store for test sends / token backfill) ──

  function pruneRecentInbound(): void {
    const t = now();
    for (const [key, entry] of recentInbound) {
      if (t - entry.at > RECENT_INBOUND_TTL_MS) recentInbound.delete(key);
    }
    while (recentInbound.size > RECENT_INBOUND_MAX) {
      const oldest = recentInbound.keys().next().value;
      if (oldest === undefined) break;
      recentInbound.delete(oldest);
    }
  }

  // ── outbound rate limit (rolling 60s window) ──

  function checkRateLimit(): void {
    const limit = loadConfig().sendRateLimitPerMinute ?? 20;
    const t = now();
    while (sendTimestamps.length && t - sendTimestamps[0] > 60_000) sendTimestamps.shift();
    if (sendTimestamps.length >= limit) {
      throw new WeChatConnectionError('rate_limited', `微信出站限流：每分钟最多 ${limit} 条`);
    }
    sendTimestamps.push(t);
  }

  // ── dispatch ──

  function dispatchMessage(rawMsg: unknown): void {
    const parsed = parseWeChatMessage(rawMsg);
    if (parsed.messageType === 2) return; // bot's own outbound echo
    if (!parsed.fromUserId) return;
    if (parsed.fromUserId.endsWith('@im.bot')) return; // self-loop guard
    if (dedupe.isDuplicate('wechat', parsed.messageId)) {
      log.debug(`wechat.dispatch.skipped reason=duplicate id=${parsed.messageId ?? ''}`);
      return;
    }
    const body = extractWeChatText(parsed);
    const hasMedia = parsed.itemTypes.some((t) => t !== 1);
    if (!body.trim() && !hasMedia) return; // presence/typing/system events

    const timestamp = normalizeWeChatTimestamp(parsed.createTime);
    const msg: NormalizedWeChatMessage = {
      fromUserId: parsed.fromUserId,
      body,
      voiceTranscription: !parsed.text && parsed.voiceText ? parsed.voiceText : undefined,
      contextToken: parsed.contextToken,
      messageId: parsed.messageId,
      timestamp,
      itemTypes: parsed.itemTypes,
      direction: 'inbound',
      raw: parsed.raw,
    };
    const displayName = resolveWeChatDisplayName(msg);
    msg.fromName = displayName;

    // Refresh insertion order so the Map doubles as an LRU.
    recentInbound.delete(msg.fromUserId);
    recentInbound.set(msg.fromUserId, {
      userId: msg.fromUserId,
      displayName: displayName ?? humanizeWeChatId(msg.fromUserId),
      preview: body.slice(0, 120),
      at: now(),
      hasContextToken: !!msg.contextToken,
      contextToken: msg.contextToken,
    });
    pruneRecentInbound();

    updateConfig({ lastMessageAt: timestamp });
    notifyWeChatSubscribers(msg);
  }

  // ── loop ──

  function startLoop(): void {
    if (running) return;
    const token = deps.secrets.get(WECHAT_BOT_TOKEN_SECRET);
    if (!token) return;
    running = true;
    activeToken = token;
    controller = new AbortController();
    cursor = loadConfig().cursor ?? '';
    const signal = controller.signal;
    log.debug('wechat.poll loop started');
    void runLoop(signal).catch((err) => {
      running = false;
      deps.log.error(`wechat.poll loop crashed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  async function runLoop(signal: AbortSignal): Promise<void> {
    let consecutiveErrors = 0;
    let firstErrorAt: number | undefined;

    while (running) {
      const token = deps.secrets.get(WECHAT_BOT_TOKEN_SECRET);
      if (!token) break; // logged out mid-flight
      try {
        const client = createClient({ baseUrl: loadConfig().baseUrl, botToken: token });
        const round = await client.getUpdates(cursor, { timeoutMs: LONG_POLL_TIMEOUT_MS, signal });
        if (!running || signal.aborted) break;

        if (consecutiveErrors > 0 || firstErrorAt !== undefined) {
          consecutiveErrors = 0;
          firstErrorAt = undefined;
          if (loadConfig().lastError) updateConfig({ lastError: undefined });
        }
        // Cursor FIRST, dispatch second — a crash between the two must not replay.
        if (round.cursor && round.cursor !== cursor) {
          cursor = round.cursor;
          updateConfig({ cursor });
        }
        updateConfig({ lastPollAt: now() });
        // Raw-round audit: log every message the poll returns — including ones
        // the filter chain below drops (e.g. type=2 echoes) — so "API accepted
        // the send" vs "message is actually in the stream" is decidable from the
        // log alone. Ids masked, bodies log as length only.
        if (round.msgs.length > 0) {
          const masked = (s?: string): string => (s ? `${s.slice(0, 12)}…` : '(none)');
          const brief = round.msgs
            .map((m) => {
              try {
                const p = parseWeChatMessage(m);
                return `type=${p.messageType ?? '?'} from=${masked(p.fromUserId)} to=${masked(p.toUserId)} mid=${masked(p.messageId)} items=[${p.itemTypes.join(',')}] txt=${p.text.length} ctx=${p.contextToken ? p.contextToken.length : 0}`;
              } catch {
                return 'unparsed';
              }
            })
            .join(' | ');
          log.log(`wechat.poll.msgs n=${round.msgs.length} ${brief}`.slice(0, 800));
        }
        for (const rawMsg of round.msgs) {
          dispatchMessage(rawMsg);
        }
      } catch (err) {
        if (!running || signal.aborted) break;
        consecutiveErrors += 1;
        if (firstErrorAt === undefined) firstErrorAt = now();
        const message = err instanceof Error ? err.message : String(err);
        const ret = err instanceof ILinkError ? err.ret : undefined;
        log.warn(`wechat.poll error #${consecutiveErrors} ret=${ret ?? 'n/a'} ${message}`);
        updateConfig({ lastError: message });

        if (ret !== undefined && AUTH_FAILURE_RET.has(ret)) {
          markNeedsReauth(ret, message);
          break;
        }
        if (consecutiveErrors >= 3 && now() - (firstErrorAt ?? now()) > AUTH_FAILURE_WINDOW_MS) {
          markNeedsReauth(ret, message);
          break;
        }
        const wait = backoffMs[Math.min(consecutiveErrors - 1, backoffMs.length - 1)];
        await sleepAbortable(wait, signal);
      }
    }
    running = false;
    log.debug('wechat.poll loop stopped');
  }

  function markNeedsReauth(ret: number | undefined, message: string): void {
    running = false;
    updateConfig({ needsReauth: true, lastError: message });
    log.error(`wechat.poll needs_reauth ret=${ret ?? 'n/a'} ${message}`);
  }

  function stop(): void {
    running = false;
    if (controller) {
      controller.abort();
      controller = null;
    }
  }

  // ── QR login flow (server-side polling; one session shared by all panels) ──

  function clearLoginTimer(): void {
    if (loginTimer) {
      clearInterval(loginTimer);
      loginTimer = null;
    }
  }

  async function pollLogin(): Promise<void> {
    if (!loginSession || !loginQrcodeId || loginSession.confirmed || loginPolling) return;
    loginPolling = true;
    try {
      if (now() > loginSession.deadlineAt) {
        loginSession.status = 'expired';
        loginSession.error = '二维码已超时，请重新发起绑定';
        clearLoginTimer();
        return;
      }
      const client = createClient({ baseUrl: loadConfig().baseUrl });
      const status = await client.getQrcodeStatus(loginQrcodeId);
      loginSession.status = status.status || loginSession.status;
      if (loginSession.error) loginSession.error = undefined;
      if (CONFIRMED_STATUSES.has(status.status)) {
        if (!status.botToken) {
          loginSession.error = 'iLink 已确认扫码但响应缺少 bot_token';
          return;
        }
        deps.secrets.set(WECHAT_BOT_TOKEN_SECRET, status.botToken);
        updateConfig({
          baseUrl: status.baseUrl || loadConfig().baseUrl,
          botUserId: status.botUserId,
          connectedAt: now(),
          needsReauth: false,
          lastError: undefined,
          cursor: undefined,
          lastMessageAt: undefined,
        });
        recentInbound.clear();
        dedupe.clear();
        loginSession.confirmed = true;
        clearLoginTimer();
        log.debug(
          `wechat.login confirmed botUserId=${status.botUserId ?? '(未返回)'} token=${maskWechatToken(status.botToken)}`,
        );
        sync();
      } else if (DEAD_STATUSES.has(status.status)) {
        loginSession.error = '二维码已失效，请重新发起绑定';
        clearLoginTimer();
      }
    } catch (err) {
      // Transient poll failures keep the session alive until the deadline.
      if (loginSession) loginSession.error = err instanceof Error ? err.message : String(err);
    } finally {
      loginPolling = false;
    }
  }

  function sync(): void {
    const config = loadConfig();
    const token = deps.secrets.get(WECHAT_BOT_TOKEN_SECRET);
    if (!config.enabled) {
      stop();
      cancelLogin();
      return;
    }
    if (!token || config.needsReauth) {
      stop();
      return;
    }
    if (running && activeToken === token) return;
    stop(); // token rotated (re-scan) — restart with the fresh one
    startLoop();
  }

  async function startLogin(): Promise<LoginSession> {
    const config = loadConfig();
    if (running && !config.needsReauth) {
      throw new WeChatConnectionError('already_connected', '微信已连接，如需重新绑定请先断开');
    }
    if (loginSession && !loginSession.confirmed) return loginSession;
    stop(); // clear any needs_reauth remnant before re-binding
    const client = createClient({ baseUrl: config.baseUrl });
    const qr = await client.getBotQrcode();
    if (!qr.qrcode || !qr.imgContent) {
      throw new WeChatConnectionError('qr_unavailable', 'iLink 未返回二维码数据');
    }
    loginSession = {
      imgContent: qr.imgContent,
      startedAt: now(),
      deadlineAt: now() + qrTimeoutMs,
      status: 'waiting',
      confirmed: false,
    };
    loginQrcodeId = qr.qrcode; // private — never part of the public view
    clearLoginTimer();
    loginTimer = setInterval(() => {
      void pollLogin();
    }, qrPollIntervalMs);
    return loginSession;
  }

  function cancelLogin(): void {
    clearLoginTimer();
    loginSession = null;
    loginQrcodeId = null;
  }

  function logout(): void {
    stop();
    cancelLogin();
    deps.secrets.set(WECHAT_BOT_TOKEN_SECRET, '');
    activeToken = undefined;
    recentInbound.clear();
    dedupe.clear();
    updateConfig({
      botUserId: undefined,
      connectedAt: undefined,
      cursor: undefined,
      needsReauth: false,
      lastError: undefined,
      lastMessageAt: undefined,
    });
    log.debug('wechat.logout token cleared');
  }

  function getInfo(): WeChatConnectionInfo {
    const config = loadConfig();
    const hasToken = !!deps.secrets.get(WECHAT_BOT_TOKEN_SECRET);
    let state: WeChatConnectionState;
    if (!config.enabled) state = 'disabled';
    else if (loginSession && !loginSession.confirmed) state = 'qr_pending';
    else if (config.needsReauth) state = 'needs_reauth';
    else if (running && hasToken) state = 'connected';
    else state = 'disconnected';
    return {
      state,
      hasToken,
      enabled: config.enabled,
      botUserId: config.botUserId,
      connectedAt: config.connectedAt,
      lastPollAt: config.lastPollAt,
      lastMessageAt: config.lastMessageAt,
      lastError: config.lastError,
      needsReauth: config.needsReauth === true,
    };
  }

  function getRecentInbound(): RecentInboundEntry[] {
    pruneRecentInbound();
    return [...recentInbound.values()]
      .sort((a, b) => b.at - a.at)
      .map(({ userId, displayName, preview, at, hasContextToken }) => ({
        userId,
        displayName,
        preview,
        at,
        hasContextToken,
      }));
  }

  async function sendMessage(opts: {
    toUserId: string;
    text: string;
    contextToken?: string;
  }): Promise<{ raw: unknown }> {
    const config = loadConfig();
    const token = deps.secrets.get(WECHAT_BOT_TOKEN_SECRET);
    if (!token) {
      throw new WeChatConnectionError('not_connected', '微信未连接：请先在集成面板扫码绑定');
    }
    let contextToken = opts.contextToken?.trim() || undefined;
    if (!contextToken) {
      pruneRecentInbound();
      contextToken = recentInbound.get(opts.toUserId)?.contextToken;
    }
    if (!contextToken) {
      // TODO(S0 p1): if proactive sends prove deliverable, relax this path.
      throw new WeChatConnectionError(
        'no_context_token',
        `无法向 ${opts.toUserId} 主动发送：本会话尚无有效的 context_token（对方需先给机器人发过消息）`,
      );
    }
    checkRateLimit();
    const client = createClient({ baseUrl: config.baseUrl, botToken: token });
    const sent = await client.sendText({ toUserId: opts.toUserId, text: opts.text, contextToken });
    // Raw sendmessage response kept on the record: ensureOk() treats a missing
    // `ret` field as success (multi-candidate defensive parsing), so logging the
    // actual payload is the only way to tell "Tencent accepted" from "we misread".
    log.log(`wechat.send raw=${JSON.stringify(sent.raw).slice(0, 400)}`);
    return sent;
  }

  return {
    sync,
    startLogin,
    getLoginSession: () => loginSession,
    cancelLogin,
    logout,
    getInfo,
    getRecentInbound,
    sendMessage,
    stop,
    isRunning: () => running,
  };
}

// ─── Production singleton (routes + plugin talk to this; tests use the factory) ───

let singleton: WeChatConnectionHandle | null = null;

export function initWeChatConnection(ctx: IntegrationContext): WeChatConnectionHandle {
  if (!singleton) {
    singleton = createWeChatConnection({ secrets: ctx.secrets, log: ctx.log });
  }
  return singleton;
}

/**
 * Reconcile the loop against config + secrets. Safe to call before init —
 * it initializes the singleton on first use when a context is provided,
 * otherwise no-ops (nothing can be running yet).
 */
export function syncWeChatConnection(ctx?: IntegrationContext): void {
  if (!singleton) {
    if (!ctx) return;
    initWeChatConnection(ctx);
  }
  singleton?.sync();
}

export function getWeChatConnection(): WeChatConnectionHandle | null {
  return singleton;
}

/**
 * Synchronous — aborts the in-flight long poll without awaiting it, and kills
 * any in-flight QR login timer so no polling survives shutdown.
 */
export function stopWeChatConnection(): void {
  singleton?.stop();
  singleton?.cancelLogin();
  singleton = null;
}

/** Info for plugin.getStatus() — safe before initialization. */
export function describeWeChatConnection(): WeChatConnectionInfo {
  if (singleton) return singleton.getInfo();
  const config: WeChatConfig = loadConfig();
  return {
    state: config.enabled ? 'disconnected' : 'disabled',
    hasToken: false,
    enabled: config.enabled,
    botUserId: config.botUserId,
    connectedAt: config.connectedAt,
    lastPollAt: config.lastPollAt,
    lastMessageAt: config.lastMessageAt,
    lastError: config.lastError,
    needsReauth: config.needsReauth === true,
  };
}
