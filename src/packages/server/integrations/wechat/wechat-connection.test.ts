import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../../data/index.js';
import { ILinkError, type ILinkClient } from './ilink-client.js';
import { WECHAT_BOT_TOKEN_SECRET, loadConfig, resetConfigCacheForTests, updateConfig } from './wechat-config.js';
import {
  createWeChatConnection,
  WeChatConnectionError,
  type WeChatConnectionHandle,
} from './wechat-connection.js';
import { wechatTriggerHandler, type NormalizedWeChatMessage } from './wechat-trigger-handler.js';

// ─── Harness ───

type Scripted = (() => Promise<unknown>) | Record<string, unknown> | Error;

class FakeClient {
  updatesScript: Scripted[] = [];
  callCount = 0;
  sent: Array<{ toUserId: string; text: string; contextToken?: string }> = [];
  abortSignals: AbortSignal[] = [];
  qrStatuses: Array<Record<string, unknown>> = [];
  qrStatusCount = 0;

  async getUpdates(_cursor: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    this.callCount += 1;
    if (options.signal) this.abortSignals.push(options.signal);
    const next = this.updatesScript.shift();
    if (next === undefined) return this.hang(options.signal);
    if (typeof next === 'function') return next();
    if (next instanceof Error) throw next;
    return next;
  }

  private hang(signal?: AbortSignal): Promise<never> {
    return new Promise((_resolve, reject) => {
      if (!signal) return; // never resolves — test must stop() to release
      if (signal.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  }

  async sendText(input: { toUserId: string; text: string; contextToken?: string }): Promise<{ raw: unknown }> {
    this.sent.push(input);
    return { raw: { ret: 0 } };
  }

  async getBotQrcode(): Promise<{ qrcode: string; imgContent: string; raw: unknown }> {
    return { qrcode: 'QR-ID-1', imgContent: 'https://liteapp.weixin.qq.com/q/test', raw: {} };
  }

  async getQrcodeStatus(_qrcode: string): Promise<Record<string, unknown>> {
    this.qrStatusCount += 1;
    return this.qrStatuses.shift() ?? { status: 'waiting', raw: {} };
  }
}

function makeSecrets(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: (key: string) => store.get(key),
    set: (key: string, value: string) => {
      if (value) store.set(key, value);
      else store.delete(key);
    },
  };
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

function makeHandle(fake: FakeClient, secrets: ReturnType<typeof makeSecrets>, overrides: Record<string, unknown> = {}): WeChatConnectionHandle {
  return createWeChatConnection({
    secrets,
    log: silentLog,
    createClient: () => fake as unknown as ILinkClient,
    backoffMs: [5, 5, 5, 5, 5],
    qrPollIntervalMs: 5,
    ...overrides,
  });
}

async function waitUntil(fn: () => boolean, label = 'condition', timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`waitUntil timeout: ${label}`);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function inboundRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from_user_id: 'wxid_tester12345@im.wechat',
    to_user_id: 'bot@im.bot',
    message_type: 1,
    msg_id: 'm1',
    context_token: 'ctx-1',
    create_time: 1780000000,
    item_list: [{ type: 1, text_item: { text: '你好' } }],
    ...overrides,
  };
}

describe('wechat-connection', () => {
  let fake: FakeClient;
  let secrets: ReturnType<typeof makeSecrets>;
  let handle: WeChatConnectionHandle | null = null;
  let received: NormalizedWeChatMessage[];
  let cursorSeenInListener: string | undefined;

  beforeEach(async () => {
    fs.rmSync(path.join(getDataDir(), 'wechat-config.json'), { force: true });
    resetConfigCacheForTests();
    updateConfig({ enabled: true });
    fake = new FakeClient();
    secrets = makeSecrets({ [WECHAT_BOT_TOKEN_SECRET]: 'T-1' });
    handle = null;
    received = [];
    cursorSeenInListener = undefined;
    await wechatTriggerHandler.startListening((event) => {
      cursorSeenInListener = loadConfig().cursor;
      received.push(event.data as NormalizedWeChatMessage);
    });
  });

  afterEach(async () => {
    handle?.stop();
    await wechatTriggerHandler.stopListening();
    fs.rmSync(path.join(getDataDir(), 'wechat-config.json'), { force: true });
    resetConfigCacheForTests();
    await delay(10);
  });

  it('dispatches normalized inbound with the cursor persisted BEFORE notify', async () => {
    fake.updatesScript = [{ msgs: [inboundRaw()], cursor: 'CUR-2', raw: { ret: 0 } }];
    handle = makeHandle(fake, secrets);
    handle.sync();
    await waitUntil(() => received.length === 1, 'first dispatch');

    const msg = received[0];
    expect(msg.fromUserId).toBe('wxid_tester12345@im.wechat');
    expect(msg.body).toBe('你好');
    expect(msg.contextToken).toBe('ctx-1');
    expect(msg.messageId).toBe('m1');
    expect(msg.timestamp).toBe(1780000000000);
    // Cursor was persisted before the subscriber saw the message.
    expect(cursorSeenInListener).toBe('CUR-2');
    expect(loadConfig().cursor).toBe('CUR-2');
    expect(loadConfig().lastMessageAt).toBe(1780000000000);

    const recent = handle.getRecentInbound();
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ userId: 'wxid_tester12345@im.wechat', hasContextToken: true, preview: '你好' });
  });

  it('applies the filter chain: bot echo, self-loop, empty, dedupe — media-only passes', async () => {
    fake.updatesScript = [
      {
        ret: 0,
        msgs: [
          inboundRaw({ from_user_id: 'wxid_tester12345@im.wechat', message_type: 2, msg_id: 'e1' }),
          inboundRaw({ from_user_id: 'other-bot@im.bot', msg_id: 'e2' }),
          inboundRaw({ msg_id: 'e3', item_list: [] }),
          inboundRaw({ msg_id: 'd1', item_list: [{ type: 1, text_item: { text: 'one' } }] }),
          inboundRaw({ msg_id: 'd1', item_list: [{ type: 1, text_item: { text: 'one' } }] }),
          inboundRaw({ msg_id: 'd2', context_token: undefined, item_list: [{ type: 2 }] }),
        ],
        cursor: 'CUR-F',
        raw: { ret: 0 },
      },
    ];
    handle = makeHandle(fake, secrets);
    handle.sync();
    await waitUntil(() => received.length === 2, 'two surviving messages');
    await delay(30);
    expect(received).toHaveLength(2);
    expect(received.map((m) => m.body)).toEqual(['one', '']);
    expect(received[1].itemTypes).toEqual([2]);
    expect(received[1].contextToken).toBeUndefined();
  });

  it('marks needs_reauth immediately on an explicit auth ret', async () => {
    fake.updatesScript = [() => Promise.reject(new ILinkError(401, 'iLink HTTP 401: unauthorized'))];
    handle = makeHandle(fake, secrets);
    handle.sync();
    await waitUntil(() => handle!.getInfo().needsReauth, 'needs_reauth flag');
    expect(handle.isRunning()).toBe(false);
    expect(handle.getInfo().state).toBe('needs_reauth');
    expect(loadConfig().needsReauth).toBe(true);
    expect(fake.callCount).toBe(1);
  });

  it('marks needs_reauth after 3 consecutive failures spanning >5min', async () => {
    let fakeNow = 0;
    fake.updatesScript = [
      () => {
        fakeNow += 200_000;
        return Promise.reject(new ILinkError(1001, 'boom'));
      },
      () => {
        fakeNow += 200_000;
        return Promise.reject(new ILinkError(1001, 'boom'));
      },
      () => {
        fakeNow += 200_000;
        return Promise.reject(new ILinkError(1001, 'boom'));
      },
    ];
    handle = makeHandle(fake, secrets, { now: () => fakeNow });
    handle.sync();
    await waitUntil(() => handle!.getInfo().needsReauth, 'needs_reauth after span');
    expect(fake.callCount).toBe(3);
    expect(handle.isRunning()).toBe(false);
  });

  it('does NOT mark needs_reauth for 3+ failures within a short window (network flap)', async () => {
    fake.updatesScript = [
      () => Promise.reject(new ILinkError(1001, 'boom')),
      () => Promise.reject(new ILinkError(1001, 'boom')),
      () => Promise.reject(new ILinkError(1001, 'boom')),
      () => Promise.reject(new ILinkError(1001, 'boom')),
      () => Promise.reject(new ILinkError(1001, 'boom')),
    ];
    handle = makeHandle(fake, secrets, { now: () => 0 });
    handle.sync();
    await waitUntil(() => fake.callCount >= 5, 'five failing rounds');
    expect(handle.getInfo().needsReauth).toBe(false);
    expect(handle.isRunning()).toBe(true);
  });

  it('stop() aborts the in-flight poll synchronously and is idempotent', async () => {
    fake.updatesScript = []; // first call hangs until abort
    handle = makeHandle(fake, secrets);
    handle.sync();
    await waitUntil(() => handle!.isRunning() && fake.abortSignals.length === 1, 'in-flight poll');
    const signal = fake.abortSignals[0];
    expect(signal.aborted).toBe(false);
    handle.stop();
    expect(signal.aborted).toBe(true);
    handle.stop(); // idempotent
    await waitUntil(() => !handle!.isRunning(), 'loop exit');
  });

  it('logout clears the token, cursor and loop', async () => {
    fake.updatesScript = [{ msgs: [], cursor: 'CUR-L', raw: { ret: 0 } }];
    handle = makeHandle(fake, secrets);
    handle.sync();
    await waitUntil(() => loadConfig().cursor === 'CUR-L', 'cursor persisted');

    handle.logout();
    expect(secrets.store.has(WECHAT_BOT_TOKEN_SECRET)).toBe(false);
    expect(loadConfig().cursor).toBeUndefined();
    expect(loadConfig().botUserId).toBeUndefined();
    expect(handle.getInfo().state).toBe('disconnected');
  });

  describe('sendMessage', () => {
    it('rejects with not_connected when no token is stored', async () => {
      secrets = makeSecrets();
      handle = makeHandle(fake, secrets);
      const err = await handle.sendMessage({ toUserId: 'u1', text: 'x', contextToken: 'c' }).catch((e) => e);
      expect(err).toBeInstanceOf(WeChatConnectionError);
      expect((err as WeChatConnectionError).code).toBe('not_connected');
    });

    it('backfills the context token from recent inbound; errors when none exists', async () => {
      handle = makeHandle(fake, secrets);
      const err = await handle.sendMessage({ toUserId: 'nobody@im.wechat', text: 'x' }).catch((e) => e);
      expect((err as WeChatConnectionError).code).toBe('no_context_token');

      fake.updatesScript = [{ msgs: [inboundRaw()], cursor: 'CUR-S', raw: { ret: 0 } }];
      handle.sync();
      await waitUntil(() => received.length === 1, 'inbound for token');

      await handle.sendMessage({ toUserId: 'wxid_tester12345@im.wechat', text: 'reply' });
      expect(fake.sent).toHaveLength(1);
      expect(fake.sent[0]).toEqual({
        toUserId: 'wxid_tester12345@im.wechat',
        text: 'reply',
        contextToken: 'ctx-1',
      });
    });

    it('enforces the rolling outbound rate limit', async () => {
      updateConfig({ sendRateLimitPerMinute: 2 });
      handle = makeHandle(fake, secrets);
      await handle.sendMessage({ toUserId: 'u1', text: 'a', contextToken: 'c' });
      await handle.sendMessage({ toUserId: 'u1', text: 'b', contextToken: 'c' });
      const err = await handle.sendMessage({ toUserId: 'u1', text: 'c', contextToken: 'c' }).catch((e) => e);
      expect(err).toBeInstanceOf(WeChatConnectionError);
      expect((err as WeChatConnectionError).code).toBe('rate_limited');
      expect(fake.sent).toHaveLength(2);
    });
  });

  describe('QR login flow', () => {
    it('polls to confirmed, stores the token, resets stale session state and connects', async () => {
      updateConfig({ cursor: 'OLD-CURSOR' });
      secrets = makeSecrets(); // no token yet
      fake.qrStatuses = [
        { status: 'waiting', raw: {} },
        { status: 'confirmed', botToken: 'TOK-NEW', baseUrl: 'https://alt.example', botUserId: 'bot@im.bot', raw: {} },
      ];
      handle = makeHandle(fake, secrets);

      const session = await handle.startLogin();
      expect(session.confirmed).toBe(false);
      expect(handle.getInfo().state).toBe('qr_pending');

      await waitUntil(() => handle!.getLoginSession()?.confirmed === true, 'login confirmed');
      expect(secrets.store.get(WECHAT_BOT_TOKEN_SECRET)).toBe('TOK-NEW');
      const config = loadConfig();
      expect(config.baseUrl).toBe('https://alt.example');
      expect(config.botUserId).toBe('bot@im.bot');
      expect(config.cursor).toBeUndefined();
      expect(config.needsReauth).toBe(false);
      expect(handle.isRunning()).toBe(true);
      expect(handle.getInfo().state).toBe('connected');
    });

    it('expires the QR session at the deadline', async () => {
      let fakeNow = 0;
      secrets = makeSecrets();
      fake.qrStatuses = [{ status: 'waiting', raw: {} }];
      handle = makeHandle(fake, secrets, { now: () => fakeNow, qrTimeoutMs: 1_000 });
      await handle.startLogin();
      expect(handle.getLoginSession()?.deadlineAt).toBe(1_000);

      fakeNow = 2_000; // jump past the deadline
      await waitUntil(() => handle!.getLoginSession()?.status === 'expired', 'qr expired');
      expect(handle.getLoginSession()?.error).toContain('超时');
      // Timer stopped: no further getQrcodeStatus calls after expiry.
      const callsAtExpiry = fake.qrStatusCount;
      await delay(30);
      expect(fake.qrStatusCount).toBe(callsAtExpiry);
    });

    it('refuses startLogin while already connected', async () => {
      fake.updatesScript = [{ msgs: [], cursor: 'CUR-C', raw: { ret: 0 } }];
      handle = makeHandle(fake, secrets);
      handle.sync();
      await waitUntil(() => handle!.isRunning() && loadConfig().cursor === 'CUR-C', 'connected loop');
      const err = await handle.startLogin().catch((e) => e);
      expect(err).toBeInstanceOf(WeChatConnectionError);
      expect((err as WeChatConnectionError).code).toBe('already_connected');
    });
  });
});
