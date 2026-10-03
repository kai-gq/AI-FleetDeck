import { describe, it, expect } from 'vitest';
import { gzipSync, gunzipSync } from 'node:zlib';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  VolcengineAsrSession,
  MSG_TYPE,
  FLAGS,
  SERIALIZATION,
  COMPRESSION,
  buildHeader,
  buildFullClientRequest,
  buildAudioOnlyRequest,
  parseServerFrame,
  describeVolcError,
} from './volcengine-asr-client.js';
import { DEFAULT_VOLCENGINE_STT_CONFIG } from '../services/voice-companion-service.js';

/** 手工拼一个服务端结果帧(与实现无关,按文档逐字节写)。 */
function serverFrame(
  payload: unknown,
  flags: number,
  seq: number | null,
  compression: number = COMPRESSION.GZIP,
): Buffer {
  const body =
    compression === COMPRESSION.GZIP
      ? gzipSync(Buffer.from(JSON.stringify(payload), 'utf-8'))
      : Buffer.from(JSON.stringify(payload), 'utf-8');
  const parts: Buffer[] = [
    buildHeader(MSG_TYPE.SERVER_FULL_RESPONSE, flags, SERIALIZATION.JSON, compression),
  ];
  if (seq !== null) {
    const seqBuf = Buffer.alloc(4);
    seqBuf.writeInt32BE(seq, 0);
    parts.push(seqBuf);
  }
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(body.length, 0);
  parts.push(sizeBuf, body);
  return Buffer.concat(parts);
}

/** 手工拆一个客户端帧(与实现无关,按文档逐字节读)。 */
function splitClientFrame(frame: Buffer) {
  const headerSize = frame[0] & 0x0f;
  const messageType = frame[1] >> 4;
  const flags = frame[1] & 0x0f;
  const serialization = frame[2] >> 4;
  const compression = frame[2] & 0x0f;
  let offset = headerSize * 4;
  let seq: number | null = null;
  if (flags & 0x01) {
    seq = frame.readInt32BE(offset);
    offset += 4;
  }
  const size = frame.readUInt32BE(offset);
  offset += 4;
  const payload = frame.subarray(offset, offset + size);
  return { messageType, flags, serialization, compression, seq, payload };
}

describe('buildHeader', () => {
  it('lays out version/size/type/flags/serialization/compression bytes', () => {
    const header = buildHeader(MSG_TYPE.CLIENT_FULL_REQUEST, FLAGS.POS_SEQUENCE, SERIALIZATION.JSON, COMPRESSION.GZIP);
    expect(header).toHaveLength(4);
    expect(header[0]).toBe(0b0001_0001); // version 1 | header size 1
    expect(header[1]).toBe(0b0001_0001); // full request | pos sequence
    expect(header[2]).toBe(0b0001_0001); // JSON | gzip
    expect(header[3]).toBe(0x00);
  });
});

describe('buildFullClientRequest', () => {
  it('serializes seq + gzip(JSON) with POS_SEQUENCE flag', () => {
    const payload = {
      user: { uid: 'tide-commander' },
      audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
      request: { model_name: 'bigmodel', enable_itn: true, show_utterances: true, result_type: 'full' },
    };
    const frame = buildFullClientRequest(1, payload);
    const parts = splitClientFrame(frame);
    expect(parts.messageType).toBe(MSG_TYPE.CLIENT_FULL_REQUEST);
    expect(parts.flags).toBe(FLAGS.POS_SEQUENCE);
    expect(parts.serialization).toBe(SERIALIZATION.JSON);
    expect(parts.compression).toBe(COMPRESSION.GZIP);
    expect(parts.seq).toBe(1);
    expect(JSON.parse(gunzipSync(parts.payload).toString('utf-8'))).toEqual(payload);
  });
});

describe('buildAudioOnlyRequest', () => {
  it('keeps positive sequence and raw serialization for a normal chunk', () => {
    const audio = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const parts = splitClientFrame(buildAudioOnlyRequest(7, audio, false));
    expect(parts.messageType).toBe(MSG_TYPE.CLIENT_AUDIO_ONLY_REQUEST);
    expect(parts.flags).toBe(FLAGS.POS_SEQUENCE);
    expect(parts.serialization).toBe(SERIALIZATION.NONE);
    expect(parts.seq).toBe(7);
    expect(gunzipSync(parts.payload)).toEqual(audio);
  });

  it('writes a negative sequence and the last-packet flag for the final chunk', () => {
    const parts = splitClientFrame(buildAudioOnlyRequest(3, Buffer.alloc(0), true));
    expect(parts.flags).toBe(FLAGS.NEG_WITH_SEQUENCE);
    expect(parts.seq).toBe(-3);
    expect(gunzipSync(parts.payload)).toEqual(Buffer.alloc(0));
  });
});

describe('parseServerFrame', () => {
  it('decodes a gzip JSON result frame with sequence', () => {
    const frame = serverFrame({ result: { text: '这是字节跳动' } }, FLAGS.POS_SEQUENCE, 2);
    const parsed = parseServerFrame(frame);
    expect(parsed.messageType).toBe(MSG_TYPE.SERVER_FULL_RESPONSE);
    expect(parsed.sequence).toBe(2);
    expect(parsed.isLast).toBe(false);
    expect((parsed.payload as { result: { text: string } }).result.text).toBe('这是字节跳动');
  });

  it('marks the last frame (flags 0b0011) and reads the negative sequence', () => {
    const frame = serverFrame({ result: { text: '完整结果' } }, FLAGS.NEG_WITH_SEQUENCE, -3);
    const parsed = parseServerFrame(frame);
    expect(parsed.sequence).toBe(-3);
    expect(parsed.isLast).toBe(true);
  });

  it('handles frames without sequence (flags 0b0010 last, no seq)', () => {
    const frame = serverFrame({ result: { text: '无序号' } }, FLAGS.NEG_SEQUENCE, null);
    const parsed = parseServerFrame(frame);
    expect(parsed.sequence).toBeNull();
    expect(parsed.isLast).toBe(true);
  });

  it('handles uncompressed JSON payloads', () => {
    const frame = serverFrame({ result: { text: '未压缩' } }, FLAGS.POS_SEQUENCE, 1, COMPRESSION.NONE);
    const parsed = parseServerFrame(frame);
    expect((parsed.payload as { result: { text: string } }).result.text).toBe('未压缩');
  });

  it('parses an error frame: code + message, no sequence', () => {
    const body = Buffer.from(JSON.stringify({ message: 'invalid params' }), 'utf-8');
    const header = buildHeader(MSG_TYPE.SERVER_ERROR_RESPONSE, FLAGS.NO_SEQUENCE, SERIALIZATION.JSON, COMPRESSION.NONE);
    const codeBuf = Buffer.alloc(4);
    codeBuf.writeInt32BE(45000001, 0);
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32BE(body.length, 0);
    const parsed = parseServerFrame(Buffer.concat([header, codeBuf, sizeBuf, body]));
    expect(parsed.messageType).toBe(MSG_TYPE.SERVER_ERROR_RESPONSE);
    expect(parsed.errorCode).toBe(45000001);
    expect(parsed.errorMessage).toContain('invalid params');
  });

  it('rejects frames shorter than the header', () => {
    expect(() => parseServerFrame(Buffer.from([0x11, 0x21]))).toThrow();
  });
});

describe('describeVolcError', () => {
  it('maps known codes to Chinese text', () => {
    expect(describeVolcError(45000001)).toContain('请求参数无效');
    expect(describeVolcError(45000151)).toContain('音频格式不正确');
    expect(describeVolcError(55000031)).toContain('繁忙');
  });
  it('summarizes unknown 55xxxxxx as server-side errors and keeps the raw code', () => {
    expect(describeVolcError(55099999)).toContain('55099999');
    expect(describeVolcError(55099999)).toContain('服务端内部处理错误');
    expect(describeVolcError(12345678)).toContain('未知错误');
  });
  it('appends a truncated detail', () => {
    const msg = describeVolcError(45000001, 'x'.repeat(500));
    expect(msg).toContain('x'.repeat(160));
    expect(msg).not.toContain('x'.repeat(161));
    expect(msg.length).toBeLessThan(260);
  });
});

// ============================================================================
// 会话行为(对着本地 mock SAUC 服务端跑完整生命周期)
// ============================================================================

interface MockSaucServer {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  close(): Promise<void>;
}

function startMockSaucServer(onFrame: (frame: Buffer, ws: WebSocket) => void): Promise<MockSaucServer> {
  return new Promise((resolve) => {
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });
    const mock: MockSaucServer = {
      url: '',
      headers: {},
      close: () =>
        new Promise<void>((done) => {
          for (const client of wss.clients) client.terminate();
          wss.close(() => httpServer.close(() => done()));
        }),
    };
    wss.on('connection', (ws, req) => {
      mock.headers = req.headers;
      ws.on('message', (data) =>
        onFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer), ws),
      );
    });
    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address() as AddressInfo;
      mock.url = `ws://127.0.0.1:${port}`;
      resolve(mock);
    });
  });
}

describe('VolcengineAsrSession (mock SAUC server)', () => {
  it('queues pre-connect audio, streams partials, and emits the final after finish()', async () => {
    const seen: { full?: Record<string, unknown>; positiveSeqs: number[]; lastSeq?: number } = {
      positiveSeqs: [],
    };
    const mock = await startMockSaucServer((frame, ws) => {
      const f = splitClientFrame(frame);
      if (f.messageType === MSG_TYPE.CLIENT_FULL_REQUEST) {
        seen.full = JSON.parse(gunzipSync(f.payload).toString('utf-8'));
        ws.send(serverFrame({ result: { text: '你好' } }, FLAGS.POS_SEQUENCE, f.seq ?? 1));
      } else if (f.messageType === MSG_TYPE.CLIENT_AUDIO_ONLY_REQUEST) {
        if ((f.seq ?? 0) < 0) {
          seen.lastSeq = f.seq ?? 0;
          ws.send(serverFrame({ result: { text: '你好世界' } }, FLAGS.NEG_WITH_SEQUENCE, f.seq));
        } else {
          seen.positiveSeqs.push(f.seq ?? 0);
        }
      }
    });

    const events: string[] = [];
    const finalText = await new Promise<string>((resolve, reject) => {
      const session = new VolcengineAsrSession({
        credentials: { ...DEFAULT_VOLCENGINE_STT_CONFIG, apiKey: 'test-api-key' },
        wsUrl: mock.url,
        connectTimeoutMs: 3_000,
        finishTimeoutMs: 5_000,
        onPartial: (t) => events.push(`partial:${t}`),
        onFinal: (t) => resolve(t),
        onError: (e) => reject(e),
      });
      // 连接尚未建立:两段音频先进队列,finish 也在此之前
      session.sendAudio(Buffer.from('aaaa'));
      session.sendAudio(Buffer.from('bbbb'));
      session.finish();
    });

    expect(finalText).toBe('你好世界');
    // 末包响应先作为 partial 刷新上屏,再作为 final 交给客户端提交
    expect(events).toEqual(['partial:你好', 'partial:你好世界']);
    await mock.close();

    // 全量请求字段
    const full = seen.full as {
      audio: Record<string, unknown>;
      request: Record<string, unknown>;
      user: { uid: string };
    };
    expect(full.audio).toEqual({ format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 });
    expect(full.request).toMatchObject({
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      show_utterances: true,
      result_type: 'full',
    });
    // 鉴权头(新版 ApiKey 路径)
    expect(mock.headers['x-api-key']).toBe('test-api-key');
    expect(mock.headers['x-api-resource-id']).toBe(DEFAULT_VOLCENGINE_STT_CONFIG.resourceId);
    expect(mock.headers['x-api-connect-id']).toBeTruthy();
    // 音频序号:正数递增 + 末包负数
    expect(seen.positiveSeqs).toEqual([2, 3]);
    expect(seen.lastSeq).toBe(-4);
  });

  it('uses legacy appId/accessToken headers when no ApiKey is set', async () => {
    const mock = await startMockSaucServer((_frame, ws) => {
      ws.send(serverFrame({ result: { text: 'ok' } }, FLAGS.NEG_WITH_SEQUENCE, -1));
    });
    await new Promise<string>((resolve, reject) => {
      const session = new VolcengineAsrSession({
        credentials: { ...DEFAULT_VOLCENGINE_STT_CONFIG, appId: '123456', accessToken: 'tok' },
        wsUrl: mock.url,
        connectTimeoutMs: 3_000,
        finishTimeoutMs: 5_000,
        onFinal: (t) => resolve(t),
        onError: (e) => reject(e),
      });
      session.sendAudio(Buffer.from('zz'));
      session.finish();
    });
    expect(mock.headers['x-api-app-key']).toBe('123456');
    expect(mock.headers['x-api-access-key']).toBe('tok');
    expect(mock.headers['x-api-key']).toBeUndefined();
    await mock.close();
  });

  it('surfaces server error frames as descriptive Chinese errors', async () => {
    const mock = await startMockSaucServer((frame, ws) => {
      const f = splitClientFrame(frame);
      if (f.messageType !== MSG_TYPE.CLIENT_FULL_REQUEST) return;
      const body = Buffer.from(JSON.stringify({ message: 'invalid params' }), 'utf-8');
      const header = buildHeader(
        MSG_TYPE.SERVER_ERROR_RESPONSE,
        FLAGS.NO_SEQUENCE,
        SERIALIZATION.JSON,
        COMPRESSION.NONE,
      );
      const codeBuf = Buffer.alloc(4);
      codeBuf.writeInt32BE(45000001, 0);
      const sizeBuf = Buffer.alloc(4);
      sizeBuf.writeUInt32BE(body.length, 0);
      ws.send(Buffer.concat([header, codeBuf, sizeBuf, body]));
    });

    const err = await new Promise<Error>((resolve, reject) => {
      const session = new VolcengineAsrSession({
        credentials: { ...DEFAULT_VOLCENGINE_STT_CONFIG, apiKey: 'k' },
        wsUrl: mock.url,
        connectTimeoutMs: 3_000,
        finishTimeoutMs: 5_000,
        onFinal: (t) => reject(new Error(`不应有终稿:${t}`)),
        onError: (e) => resolve(e),
      });
      session.sendAudio(Buffer.from('audio'));
      session.finish();
    });

    expect(err.message).toContain('45000001');
    expect(err.message).toContain('请求参数无效');
    await mock.close();
  });

  it('reports failed handshakes (HTTP 401) as credential errors', async () => {
    const httpServer = createServer();
    httpServer.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
    });
    const url = await new Promise<string>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        const { port } = httpServer.address() as AddressInfo;
        resolve(`ws://127.0.0.1:${port}`);
      });
    });

    const err = await new Promise<Error>((resolve, reject) => {
      const session = new VolcengineAsrSession({
        credentials: { ...DEFAULT_VOLCENGINE_STT_CONFIG, apiKey: 'bad' },
        wsUrl: url,
        connectTimeoutMs: 3_000,
        finishTimeoutMs: 5_000,
        onFinal: (t) => reject(new Error(`不应有终稿:${t}`)),
        onError: (e) => resolve(e),
      });
      session.sendAudio(Buffer.from('audio'));
    });

    expect(err.message).toContain('HTTP 401');
    expect(err.message).toContain('凭据无效');
    httpServer.close();
  });
});
