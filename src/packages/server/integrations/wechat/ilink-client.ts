/**
 * WeChat ClawBot (iLink protocol) thin client — server edition.
 *
 * Tencent's official personal-WeChat bot channel ("ClawBot") speaks plain
 * HTTP/JSON against `ilinkai.weixin.qq.com`. This client wraps the five
 * endpoints TC needs:
 *   - GET  /ilink/bot/get_bot_qrcode?bot_type=3   (unauthenticated)
 *   - GET  /ilink/bot/get_qrcode_status?qrcode=   (unauthenticated)
 *   - POST /ilink/bot/getupdates                  (long-poll, hold ≤35s)
 *   - POST /ilink/bot/sendmessage                 (text)
 *   - (getconfig / sendtyping exist but are not used in phase 1)
 *
 * Field spellings were verified against the S0 probe tool
 * (tools/wechat-link/ilink.ts, same multi-candidate pickers) — after S0 the
 * README conclusion table tightens them; until then every unknown keeps its
 * candidate list so a spelling drift degrades gracefully.
 */

export const WECHAT_BOT_BASE = 'https://ilinkai.weixin.qq.com';

/** base_info.channel_version — S0 观察服务端是否校验；要调整只改这一处。 */
export const WECHAT_CHANNEL_VERSION = '1.0.0';

/** Thrown when the transport reports HTTP >= 400 or the payload carries ret !== 0. */
export class ILinkError extends Error {
  constructor(
    public readonly ret: number,
    message: string,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'ILinkError';
  }
}

// ---------------------------------------------------------------------------
// Multi-candidate pickers (unknown-spelling tolerant; S0 tightens)
// ---------------------------------------------------------------------------

export function pickRaw(raw: unknown, keys: string[]): unknown {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

export function pickString(raw: unknown, keys: string[]): string | undefined {
  const value = pickRaw(raw, keys);
  return typeof value === 'string' ? value : undefined;
}

export function pickNumber(raw: unknown, keys: string[]): number | undefined {
  const value = pickRaw(raw, keys);
  return typeof value === 'number' ? value : undefined;
}

// ---------------------------------------------------------------------------
// Auth / transport helpers
// ---------------------------------------------------------------------------

/** X-WECHAT-UIN = base64(随机 uint32 的十进制字符串)，每次请求随机。 */
export function makeWechatUin(): string {
  const n = Math.floor(Math.random() * 0x100000000) >>> 0;
  return Buffer.from(String(n), 'utf8').toString('base64');
}

/** token 脱敏：只显示首尾各 6 位，任何日志都不得出现完整值。 */
export function maskWechatToken(token?: string): string {
  if (!token) return '(空)';
  if (token.length <= 14) return `${token.slice(0, 3)}…`;
  return `${token.slice(0, 6)}…${token.slice(-6)}`;
}

export function wechatAuthHeaders(botToken: string, uin?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': uin ?? makeWechatUin(),
    Authorization: `Bearer ${botToken}`,
  };
}

interface RawRequestOptions {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ILinkClientOptions {
  /** Defaults to WECHAT_BOT_BASE; the confirmed login response may override. */
  baseUrl?: string;
  /** Absent for the unauthenticated QR endpoints. */
  botToken?: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable UIN source for tests. */
  uinFactory?: () => string;
}

export interface BotQrcodeResult {
  qrcode: string;
  imgContent: string;
  raw: unknown;
}

export interface QrcodeStatusResult {
  ret?: number;
  status: string;
  botToken?: string;
  baseUrl?: string;
  botUserId?: string;
  raw: unknown;
}

export interface UpdatesResult {
  msgs: unknown[];
  cursor?: string;
  raw: unknown;
}

export class ILinkClient {
  private readonly opts: ILinkClientOptions;

  constructor(opts: ILinkClientOptions = {}) {
    this.opts = opts;
  }

  get baseUrl(): string {
    return this.opts.baseUrl || WECHAT_BOT_BASE;
  }

  private async request(pathname: string, options: RawRequestOptions): Promise<{ httpStatus: number; raw: unknown }> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? 20_000;
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const res = await fetchImpl(`${this.baseUrl}${pathname}`, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: AbortSignal.any(signals),
    });
    const text = await res.text();
    let raw: unknown = text;
    try {
      raw = JSON.parse(text);
    } catch {
      // Non-JSON response — keep the raw text for diagnostics.
    }
    return { httpStatus: res.status, raw };
  }

  /** Uniform failure path: HTTP >= 400 or payload ret !== 0 → ILinkError. */
  private ensureOk(httpStatus: number, raw: unknown): void {
    const ret = pickNumber(raw, ['ret', 'errcode', 'code']);
    const errmsg = pickString(raw, ['errmsg', 'err_msg', 'message']);
    if (httpStatus >= 400) {
      throw new ILinkError(ret ?? httpStatus, `iLink HTTP ${httpStatus}${errmsg ? `: ${errmsg}` : ''}`, raw);
    }
    if (ret !== undefined && ret !== 0) {
      throw new ILinkError(ret, `iLink ret=${ret}${errmsg ? `: ${errmsg}` : ''}`, raw);
    }
  }

  /** GET /ilink/bot/get_bot_qrcode?bot_type=3 — unauthenticated. */
  async getBotQrcode(botType = 3): Promise<BotQrcodeResult> {
    const { httpStatus, raw } = await this.request(`/ilink/bot/get_bot_qrcode?bot_type=${botType}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    this.ensureOk(httpStatus, raw);
    return {
      qrcode: pickString(raw, ['qrcode', 'qr_code', 'qrcode_id']) ?? '',
      imgContent: pickString(raw, ['qrcode_img_content', 'qrcodeImgContent', 'img_content', 'qrcode_url']) ?? '',
      raw,
    };
  }

  /** GET /ilink/bot/get_qrcode_status?qrcode=xxx — unauthenticated. */
  async getQrcodeStatus(qrcode: string): Promise<QrcodeStatusResult> {
    const { httpStatus, raw } = await this.request(
      `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      { method: 'GET', headers: { 'Content-Type': 'application/json' } },
    );
    this.ensureOk(httpStatus, raw);
    return {
      ret: pickNumber(raw, ['ret', 'errcode', 'code']),
      status: pickString(raw, ['status', 'state']) ?? '',
      botToken: pickString(raw, ['bot_token', 'botToken', 'token']),
      baseUrl: pickString(raw, ['baseurl', 'base_url', 'baseUrl']),
      botUserId: pickString(raw, ['bot_user_id', 'botUserId', 'user_id']),
      raw,
    };
  }

  /** POST /ilink/bot/getupdates — authenticated long-poll (server holds ≤35s). */
  async getUpdates(
    cursor: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<UpdatesResult> {
    const botToken = this.opts.botToken;
    if (!botToken) throw new ILinkError(-1, 'iLink client has no bot token');
    const body = JSON.stringify({
      get_updates_buf: cursor,
      base_info: { channel_version: WECHAT_CHANNEL_VERSION },
    });
    const { httpStatus, raw } = await this.request('/ilink/bot/getupdates', {
      method: 'POST',
      headers: wechatAuthHeaders(botToken, this.opts.uinFactory?.()),
      body,
      timeoutMs: options.timeoutMs ?? 45_000,
      signal: options.signal,
    });
    this.ensureOk(httpStatus, raw);
    const msgsRaw = pickRaw(raw, ['msgs', 'messages', 'updates', 'update_list']);
    return {
      msgs: Array.isArray(msgsRaw) ? msgsRaw : [],
      cursor: pickString(raw, ['get_updates_buf', 'getUpdatesBuf', 'buf', 'cursor']),
      raw,
    };
  }

  /**
   * POST /ilink/bot/sendmessage — authenticated text send.
   * `contextToken` comes from the inbound message being answered; omitting it
   * is the "proactive message" case, whose deliverability is S0 p1.
   */
  async sendText(input: {
    toUserId: string;
    text: string;
    contextToken?: string;
    timeoutMs?: number;
  }): Promise<{ raw: unknown }> {
    const botToken = this.opts.botToken;
    if (!botToken) throw new ILinkError(-1, 'iLink client has no bot token');
    const msg: Record<string, unknown> = {
      to_user_id: input.toUserId,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: input.text } }],
    };
    if (input.contextToken) msg.context_token = input.contextToken;
    const { httpStatus, raw } = await this.request('/ilink/bot/sendmessage', {
      method: 'POST',
      headers: wechatAuthHeaders(botToken, this.opts.uinFactory?.()),
      body: JSON.stringify({ msg }),
      timeoutMs: input.timeoutMs ?? 20_000,
    });
    this.ensureOk(httpStatus, raw);
    return { raw };
  }
}

// ---------------------------------------------------------------------------
// Message parsing (defensive; S0 实测后在 tools/wechat-link/README 结论表写死)
// ---------------------------------------------------------------------------

export interface ParsedWeChatMessage {
  fromUserId?: string;
  toUserId?: string;
  messageType?: number;
  messageId?: string;
  contextToken?: string;
  /** Epoch seconds OR ms (upstream unconfirmed) — normalizeWeChatTimestamp handles both. */
  createTime?: number;
  itemTypes: number[];
  /** item.type === 1 的文本。 */
  text: string;
  /** item.type === 3 语音的云端转写（多候选字段名，S0 定案）。 */
  voiceText: string;
  raw: Record<string, unknown>;
}

export function parseWeChatMessage(msg: unknown): ParsedWeChatMessage {
  const fromUserId = pickString(msg, ['from_user_id', 'fromUserId', 'from']);
  const toUserId = pickString(msg, ['to_user_id', 'toUserId', 'to']);
  const messageType = pickNumber(msg, ['message_type', 'messageType', 'msg_type']);
  const messageIdValue = pickRaw(msg, ['message_id', 'messageId', 'msg_id', 'id', 'seq']);
  const contextToken = pickString(msg, ['context_token', 'contextToken']);
  const createTime = pickNumber(msg, ['create_time', 'createTime', 'timestamp', 'ts']);

  const itemListRaw = pickRaw(msg, ['item_list', 'itemList', 'items']);
  const itemTypes: number[] = [];
  let text = '';
  let voiceText = '';
  if (Array.isArray(itemListRaw)) {
    for (const item of itemListRaw) {
      const type = pickNumber(item, ['type', 'item_type']);
      if (type !== undefined) itemTypes.push(type);
      if (type === 1) {
        const t = pickString(pickRaw(item, ['text_item', 'textItem']), ['text']) ??
          pickString(item, ['text']);
        if (t) text += t;
      }
      if (type === 3) {
        const voiceItem = pickRaw(item, ['voice_item', 'voiceItem']);
        const v = pickString(voiceItem, ['text', 'speech_text', 'voice_text', 'transcription', 'recognition']);
        if (v) voiceText += v;
      }
    }
  }

  return {
    fromUserId,
    toUserId,
    messageType,
    messageId: messageIdValue !== undefined ? String(messageIdValue) : undefined,
    contextToken,
    createTime,
    itemTypes,
    text,
    voiceText,
    raw: (msg && typeof msg === 'object' ? (msg as Record<string, unknown>) : {}),
  };
}

/** Body for triggers: typed text wins, voice transcription is the fallback. */
export function extractWeChatText(parsed: ParsedWeChatMessage): string {
  return parsed.text || parsed.voiceText;
}

/**
 * iLink timestamps may be epoch seconds or ms depending on the field —
 * anything below 1e12 is treated as seconds.
 */
export function normalizeWeChatTimestamp(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return Date.now();
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
}
