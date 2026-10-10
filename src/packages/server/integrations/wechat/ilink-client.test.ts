import { describe, it, expect } from 'vitest';
import {
  ILinkClient,
  ILinkError,
  WECHAT_CHANNEL_VERSION,
  extractWeChatText,
  makeWechatUin,
  normalizeWeChatTimestamp,
  parseWeChatMessage,
} from './ilink-client.js';

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(payload: unknown, status = 200, captured: CapturedCall[] = []): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured.push({ url: String(input), init: init ?? {} });
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return new Response(body, { status });
  };
  return impl as unknown as typeof fetch;
}

const BASE = 'https://ilink.example.test';

function headersOf(call: CapturedCall): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

describe('ILinkClient — unauthenticated QR endpoints', () => {
  it('getBotQrcode hits bot_type=3 and sends no Authorization header', async () => {
    const captured: CapturedCall[] = [];
    const client = new ILinkClient({
      baseUrl: BASE,
      fetchImpl: fakeFetch({ qrcode: 'QRID', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/abc' }, 200, captured),
    });
    const result = await client.getBotQrcode();
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(`${BASE}/ilink/bot/get_bot_qrcode?bot_type=3`);
    expect(captured[0].init.method).toBe('GET');
    expect(headersOf(captured[0]).Authorization).toBeUndefined();
    expect(result.qrcode).toBe('QRID');
    expect(result.imgContent).toBe('https://liteapp.weixin.qq.com/q/abc');
  });

  it('getQrcodeStatus parses confirmed fields (multi-candidate) and sends no Authorization', async () => {
    const captured: CapturedCall[] = [];
    const client = new ILinkClient({
      baseUrl: BASE,
      fetchImpl: fakeFetch(
        { ret: 0, status: 'confirmed', bot_token: 'TOK-1', baseurl: 'https://alt.example', bot_user_id: 'bot@im.bot' },
        200,
        captured,
      ),
    });
    const result = await client.getQrcodeStatus('QR ID');
    expect(captured[0].url).toBe(`${BASE}/ilink/bot/get_qrcode_status?qrcode=QR%20ID`);
    expect(headersOf(captured[0]).Authorization).toBeUndefined();
    expect(result.status).toBe('confirmed');
    expect(result.botToken).toBe('TOK-1');
    expect(result.baseUrl).toBe('https://alt.example');
    expect(result.botUserId).toBe('bot@im.bot');
  });
});

describe('ILinkClient — authenticated endpoints', () => {
  it('getUpdates sends the auth header trio + cursor body, returns msgs/cursor', async () => {
    const captured: CapturedCall[] = [];
    const client = new ILinkClient({
      baseUrl: BASE,
      botToken: 'TOKEN-X',
      uinFactory: () => 'UIN-FIXED',
      fetchImpl: fakeFetch({ ret: 0, msgs: [{ message_id: 'm1' }], get_updates_buf: 'NEXT' }, 200, captured),
    });
    const round = await client.getUpdates('CUR-0');
    const headers = headersOf(captured[0]);
    expect(captured[0].url).toBe(`${BASE}/ilink/bot/getupdates`);
    expect(captured[0].init.method).toBe('POST');
    expect(headers.Authorization).toBe('Bearer TOKEN-X');
    expect(headers.AuthorizationType).toBe('ilink_bot_token');
    expect(headers['X-WECHAT-UIN']).toBe('UIN-FIXED');
    expect(JSON.parse(String(captured[0].init.body))).toEqual({
      get_updates_buf: 'CUR-0',
      base_info: { channel_version: WECHAT_CHANNEL_VERSION },
    });
    expect(round.msgs).toHaveLength(1);
    expect(round.cursor).toBe('NEXT');
    expect(captured[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sendText builds the msg envelope and includes context_token only when provided', async () => {
    const captured: CapturedCall[] = [];
    const client = new ILinkClient({
      baseUrl: BASE,
      botToken: 'TLK',
      fetchImpl: fakeFetch({ ret: 0 }, 200, captured),
    });

    await client.sendText({ toUserId: 'u1@im.wechat', text: '你好', contextToken: 'ctx-1' });
    const withCtx = JSON.parse(String(captured[0].init.body));
    expect(withCtx.msg).toEqual({
      to_user_id: 'u1@im.wechat',
      message_type: 2,
      message_state: 2,
      context_token: 'ctx-1',
      item_list: [{ type: 1, text_item: { text: '你好' } }],
    });

    await client.sendText({ toUserId: 'u1@im.wechat', text: 'proactive' });
    const withoutCtx = JSON.parse(String(captured[1].init.body));
    expect(withoutCtx.msg.context_token).toBeUndefined();
  });

  it('getUpdates without a bot token fails fast', async () => {
    const client = new ILinkClient({ baseUrl: BASE, fetchImpl: fakeFetch({ ret: 0 }) });
    await expect(client.getUpdates('x')).rejects.toMatchObject({ name: 'ILinkError', ret: -1 });
  });
});

describe('ILinkClient — failure mapping', () => {
  it('ret !== 0 in the payload raises ILinkError carrying ret and raw', async () => {
    const client = new ILinkClient({
      baseUrl: BASE,
      botToken: 'TLK',
      fetchImpl: fakeFetch({ ret: 40001, errmsg: 'invalid token' }),
    });
    const err = await client.getUpdates('x', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ILinkError);
    expect((err as ILinkError).ret).toBe(40001);
    expect((err as Error).message).toContain('invalid token');
    expect((err as ILinkError).raw).toMatchObject({ ret: 40001 });
  });

  it('HTTP >= 400 raises ILinkError with the HTTP status when the body has no ret', async () => {
    const client = new ILinkClient({
      baseUrl: BASE,
      fetchImpl: fakeFetch('boom', 500),
    });
    const err = await client.getBotQrcode().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ILinkError);
    expect((err as ILinkError).ret).toBe(500);
  });
});

describe('makeWechatUin', () => {
  it('encodes the decimal string of a random uint32 in base64', () => {
    const uin = makeWechatUin();
    const decoded = Buffer.from(uin, 'base64').toString('utf8');
    expect(decoded).toMatch(/^\d+$/);
    const n = Number(decoded);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThan(2 ** 32);
  });
});

describe('parseWeChatMessage', () => {
  it('extracts sender, ids, context token, item types, text and voice transcription', () => {
    const parsed = parseWeChatMessage({
      from_user_id: 'wxid_x@im.wechat',
      to_user_id: 'bot@im.bot',
      message_type: 1,
      msg_id: 'mid-1',
      context_token: 'ctx-9',
      create_time: 1780000000,
      item_list: [
        { type: 1, text_item: { text: '你好' } },
        { type: 3, voice_item: { text: '语音转写' } },
      ],
    });
    expect(parsed.fromUserId).toBe('wxid_x@im.wechat');
    expect(parsed.toUserId).toBe('bot@im.bot');
    expect(parsed.messageType).toBe(1);
    expect(parsed.messageId).toBe('mid-1');
    expect(parsed.contextToken).toBe('ctx-9');
    expect(parsed.createTime).toBe(1780000000);
    expect(parsed.itemTypes).toEqual([1, 3]);
    expect(parsed.text).toBe('你好');
    expect(parsed.voiceText).toBe('语音转写');
  });

  it('falls back to seq / id for the message id and tolerates junk input', () => {
    expect(parseWeChatMessage({ seq: 987 }).messageId).toBe('987');
    expect(parseWeChatMessage({ id: 'abc' }).messageId).toBe('abc');
    const junk = parseWeChatMessage(null);
    expect(junk.itemTypes).toEqual([]);
    expect(junk.text).toBe('');
  });
});

describe('extractWeChatText / normalizeWeChatTimestamp', () => {
  it('typed text wins over voice transcription; voice is the fallback', () => {
    const base = parseWeChatMessage({});
    expect(extractWeChatText({ ...base, text: 'typed', voiceText: 'spoken' })).toBe('typed');
    expect(extractWeChatText({ ...base, text: '', voiceText: 'spoken' })).toBe('spoken');
    expect(extractWeChatText(base)).toBe('');
  });

  it('normalizes seconds vs milliseconds vs missing', () => {
    expect(normalizeWeChatTimestamp(1780000000)).toBe(1780000000000);
    expect(normalizeWeChatTimestamp(1780000000000)).toBe(1780000000000);
    const before = Date.now();
    const fallback = normalizeWeChatTimestamp(undefined);
    expect(fallback).toBeGreaterThanOrEqual(before);
  });
});
