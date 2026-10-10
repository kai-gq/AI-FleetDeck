/**
 * 微信 ClawBot（iLink 协议）薄客户端 —— S0 裸调工具专用。
 *
 * 与 S1 服务端 src/packages/server/integrations/wechat/ilink-client.ts 同构：
 * 先把协议跑通、把字段名从"文档推测"变成"实测结论"，再移植进服务端。
 * 因此这里所有响应字段都走多候选取值器（pickRaw/pickString）——
 * 实测后以 README 的结论表为准收紧拼写。
 */

export const DEFAULT_BASE = 'https://ilinkai.weixin.qq.com';

/** base_info.channel_version —— S0 观察服务端是否校验；要调整只改这一处。 */
export const CHANNEL_VERSION = '1.0.0';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 基础工具
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

/** token 脱敏：只显示首尾各 6 位，任何日志/终端输出都不得出现完整值。 */
export function maskToken(token?: string): string {
  if (!token) return '(空)';
  if (token.length <= 14) return `${token.slice(0, 3)}…`;
  return `${token.slice(0, 6)}…${token.slice(-6)}`;
}

/** X-WECHAT-UIN = base64(随机 uint32 的十进制字符串)，每次请求随机。 */
export function makeUin(): string {
  const n = Math.floor(Math.random() * 0x100000000) >>> 0;
  return Buffer.from(String(n), 'utf8').toString('base64');
}

export function authHeaders(botToken: string, uin?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': uin ?? makeUin(),
    Authorization: `Bearer ${botToken}`,
  };
}

interface RequestOptions extends RequestInit {
  timeoutMs?: number;
}

async function request(url: string, init: RequestOptions = {}): Promise<{ httpStatus: number; raw: unknown }> {
  const { timeoutMs = 20_000, signal, ...rest } = init;
  const signals = signal ? [signal, AbortSignal.timeout(timeoutMs)] : [AbortSignal.timeout(timeoutMs)];
  const res = await fetch(url, { ...rest, signal: AbortSignal.any(signals) });
  const text = await res.text();
  let raw: unknown = text;
  try {
    raw = JSON.parse(text);
  } catch {
    // 非 JSON 响应，保留原文
  }
  return { httpStatus: res.status, raw };
}

// ---------------------------------------------------------------------------
// 端点
// ---------------------------------------------------------------------------

export interface BotQrcodeResult {
  httpStatus: number;
  qrcode: string;
  imgContent: string;
  ret?: number;
  raw: unknown;
}

/** GET /ilink/bot/get_bot_qrcode?bot_type=3 —— 未认证端点。 */
export async function getBotQrcode(baseUrl = DEFAULT_BASE, botType = 3): Promise<BotQrcodeResult> {
  const { httpStatus, raw } = await request(`${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${botType}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  return {
    httpStatus,
    qrcode: pickString(raw, ['qrcode', 'qr_code', 'qrcode_id']) ?? '',
    imgContent: pickString(raw, ['qrcode_img_content', 'qrcodeImgContent', 'img_content', 'qrcode_url']) ?? '',
    ret: pickNumber(raw, ['ret', 'errcode', 'code']),
    raw,
  };
}

export interface QrcodeStatusResult {
  httpStatus: number;
  ret?: number;
  status: string;
  botToken?: string;
  baseUrl?: string;
  botUserId?: string;
  raw: unknown;
}

/** GET /ilink/bot/get_qrcode_status?qrcode=xxx —— 未认证端点。confirmed 时返回 token。 */
export async function getQrcodeStatus(qrcode: string, baseUrl = DEFAULT_BASE): Promise<QrcodeStatusResult> {
  const { httpStatus, raw } = await request(
    `${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    { method: 'GET', headers: { 'Content-Type': 'application/json' } },
  );
  return {
    httpStatus,
    ret: pickNumber(raw, ['ret', 'errcode', 'code']),
    status: pickString(raw, ['status', 'state']) ?? '',
    botToken: pickString(raw, ['bot_token', 'botToken', 'token']),
    baseUrl: pickString(raw, ['baseurl', 'base_url', 'baseUrl']),
    botUserId: pickString(raw, ['bot_user_id', 'botUserId', 'user_id']),
    raw,
  };
}

export interface UpdatesResult {
  httpStatus: number;
  ret: number;
  errmsg?: string;
  msgs: unknown[];
  cursor?: string;
  elapsedMs: number;
  raw: unknown;
}

/** POST /ilink/bot/getupdates —— 长轮询收信（hold ≤35s）。 */
export async function getUpdates(input: {
  baseUrl: string;
  botToken: string;
  cursor: string;
  uin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<UpdatesResult> {
  const body = {
    get_updates_buf: input.cursor,
    base_info: { channel_version: CHANNEL_VERSION },
  };
  const startedAt = Date.now();
  const { httpStatus, raw } = await request(`${input.baseUrl}/ilink/bot/getupdates`, {
    method: 'POST',
    headers: authHeaders(input.botToken, input.uin),
    body: JSON.stringify(body),
    timeoutMs: input.timeoutMs ?? 45_000,
    signal: input.signal,
  });
  const msgsRaw = pickRaw(raw, ['msgs', 'messages', 'updates', 'update_list']);
  return {
    httpStatus,
    ret: pickNumber(raw, ['ret', 'errcode', 'code']) ?? 0,
    errmsg: pickString(raw, ['errmsg', 'err_msg']),
    msgs: Array.isArray(msgsRaw) ? msgsRaw : [],
    cursor: pickString(raw, ['get_updates_buf', 'getUpdatesBuf', 'buf', 'cursor']),
    elapsedMs: Date.now() - startedAt,
    raw,
  };
}

export interface SendResult {
  httpStatus: number;
  ret: number;
  errmsg?: string;
  raw: unknown;
}

/**
 * POST /ilink/bot/sendmessage —— 发文本。
 * contextToken 缺省时不塞字段（主动消息探测 p1 的变量之一）。
 */
export async function sendText(input: {
  baseUrl: string;
  botToken: string;
  toUserId: string;
  text: string;
  contextToken?: string;
  uin?: string;
  timeoutMs?: number;
}): Promise<SendResult> {
  const msg: Record<string, unknown> = {
    to_user_id: input.toUserId,
    message_type: 2,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text: input.text } }],
  };
  if (input.contextToken) msg.context_token = input.contextToken;
  const { httpStatus, raw } = await request(`${input.baseUrl}/ilink/bot/sendmessage`, {
    method: 'POST',
    headers: authHeaders(input.botToken, input.uin),
    body: JSON.stringify({ msg }),
    timeoutMs: input.timeoutMs ?? 20_000,
  });
  return {
    httpStatus,
    ret: pickNumber(raw, ['ret', 'errcode', 'code']) ?? 0,
    errmsg: pickString(raw, ['errmsg', 'err_msg']),
    raw,
  };
}

// ---------------------------------------------------------------------------
// 消息解析（防御性；S0 实测后在 README 结论表里写死真实拼写）
// ---------------------------------------------------------------------------

export interface ParsedMessage {
  fromUserId?: string;
  toUserId?: string;
  messageType?: number;
  messageId?: string;
  contextToken?: string;
  createTime?: number;
  itemTypes: number[];
  /** item.type === 1 的文本。 */
  text: string;
  /** item.type === 3 语音的云端转写（多候选字段名，S0 定案）。 */
  voiceText: string;
}

export function parseMessage(msg: unknown): ParsedMessage {
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
  };
}
