/**
 * W3·C8 预热点火 · 流式通道首帧触发专测
 *
 * 覆盖 voice-companion-stream.handleConnection 的「用户开口」(首个二进制音频帧)
 * 预热点火:恰一次、空帧/超长帧不算开口、文本帧不触发、无凭据不预热。
 * ASR 会话与凭据读取全部替换为假件,不触网。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import { handleConnection, __resetVoiceDedupForTest } from './voice-companion-stream.js';

const h = vi.hoisted(() => ({
  loadVolcengineSttConfig: vi.fn(),
  prewarmCompanion: vi.fn(),
  logVoiceAsr: vi.fn(),
  noteFillerPartialForPregen: vi.fn(),
  sealFillerPartial: vi.fn(),
  dropFillerPregen: vi.fn(),
  dropFillerPregenWorking: vi.fn(),
}));

vi.mock('../services/voice-companion-service.js', () => ({
  loadVolcengineSttConfig: h.loadVolcengineSttConfig,
  prewarmCompanion: h.prewarmCompanion,
  noteFillerPartialForPregen: h.noteFillerPartialForPregen,
  sealFillerPartial: h.sealFillerPartial,
  dropFillerPregen: h.dropFillerPregen,
  dropFillerPregenWorking: h.dropFillerPregenWorking,
}));

vi.mock('../services/activity-log.js', () => ({
  logVoiceAsr: h.logVoiceAsr,
}));

// 进程卫生钩子只在 attach 里用;整模块假掉,避免带入真实常驻进程模块状态。
vi.mock('./companion-runner.js', () => ({
  initCompanionProcessHygiene: vi.fn(),
}));

vi.mock('../auth/index.js', () => ({
  validateWebSocketAuth: vi.fn(() => true),
}));

vi.mock('../utils/index.js', () => ({
  logger: { server: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

interface FakeAsrInstance {
  opts: Record<string, unknown>;
  sent: Buffer[];
  finished: boolean;
  closed: boolean;
}

const asrMock = vi.hoisted(() => ({
  instances: [] as FakeAsrInstance[],
}));

vi.mock('./volcengine-asr-client.js', () => {
  class VolcengineAsrSession implements FakeAsrInstance {
    opts: Record<string, unknown>;
    sent: Buffer[] = [];
    finished = false;
    closed = false;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      asrMock.instances.push(this);
    }
    sendAudio(chunk: Buffer): void {
      this.sent.push(chunk);
    }
    finish(): void {
      this.finished = true;
    }
    close(): void {
      this.closed = true;
    }
  }
  return { VolcengineAsrSession };
});

/** 假 WS:记录 send、捕获事件处理器(handleConnection 只用 on/send/close)。 */
class FakeWs {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  closed = false;
  handlers = new Map<string, (...args: unknown[]) => void>();

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  on(event: string, fn: (...args: unknown[]) => void): void {
    this.handlers.set(event, fn);
  }
  emit(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.(...args);
  }
  /** 模拟一帧二进制音频。 */
  feedAudio(chunk: Buffer): void {
    this.emit('message', chunk, true);
  }
  /** 模拟一帧文本 JSON。 */
  feedText(obj: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(obj)), false);
  }
  parsed(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const AUDIO_FRAME = Buffer.alloc(320, 1); // 10ms @16k/16bit/mono 量级

function openConnection(): FakeWs {
  const ws = new FakeWs();
  handleConnection(ws as unknown as WebSocket);
  return ws;
}

beforeEach(() => {
  vi.clearAllMocks();
  asrMock.instances.length = 0;
  // 去重环是模块级状态:跨用例清零,防上一条用例的终稿误伤下一条(测试毫秒级连跑,3s 窗口全覆盖)
  __resetVoiceDedupForTest();
  h.loadVolcengineSttConfig.mockReturnValue({
    apiKey: 'test-key',
    appId: '',
    accessToken: '',
    endpoint: 'wss://example.test/sauc',
  });
});

describe('W3-C8 流式通道首帧触发', () => {
  it('E1 首个音频帧 → 预热恰一次;第二帧与文本帧不重复触发', async () => {
    const ws = openConnection();
    expect(ws.parsed()[0]).toMatchObject({ type: 'ready' });
    expect(h.prewarmCompanion).not.toHaveBeenCalled(); // 建连本身不预热

    ws.feedAudio(AUDIO_FRAME);
    ws.feedAudio(AUDIO_FRAME);
    ws.feedText({ type: 'ping' });
    await tick();

    expect(h.prewarmCompanion).toHaveBeenCalledTimes(1);
    expect(ws.parsed().some((m) => m.type === 'pong')).toBe(true);
  });

  it('E2 空帧与超长帧不算"开口":不触发;此后正常帧仍触发', async () => {
    const ws = openConnection();

    ws.feedAudio(Buffer.alloc(0));
    ws.feedAudio(Buffer.alloc(512 * 1024 + 1)); // 超单帧上限
    await tick();
    expect(h.prewarmCompanion).not.toHaveBeenCalled();

    ws.feedAudio(AUDIO_FRAME);
    await tick();
    expect(h.prewarmCompanion).toHaveBeenCalledTimes(1);
  });

  it('E3 无凭据:回 error + close,且不预热(客户端走批量回退)', async () => {
    h.loadVolcengineSttConfig.mockReturnValue({ apiKey: '', appId: '', accessToken: '', endpoint: '' });
    const ws = openConnection();

    expect(ws.parsed()[0]).toMatchObject({ type: 'error', code: 'no_credentials' });
    expect(ws.closed).toBe(true);

    ws.feedAudio(AUDIO_FRAME); // 即便客户端硬发,连接已闭:closed 短路
    await tick();
    expect(h.prewarmCompanion).not.toHaveBeenCalled();
  });

  it('E4 预热旁路不干扰正常转发:帧照常建会话送 ASR(finish → final 空稿)', () => {
    const ws = openConnection();

    ws.feedAudio(AUDIO_FRAME);
    expect(asrMock.instances).toHaveLength(1);
    expect(asrMock.instances[0]!.sent).toHaveLength(1);
    expect(asrMock.instances[0]!.sent[0]!.length).toBe(AUDIO_FRAME.length);

    ws.feedText({ type: 'finish' });
    expect(asrMock.instances[0]!.finished).toBe(true);

    // 模拟 ASR 终稿回调 → 客户端收到 final
    const opts = asrMock.instances[0]!.opts as { onFinal: (t: string) => void };
    opts.onFinal('你好');
    expect(ws.parsed().some((m) => m.type === 'final' && m.text === '你好')).toBe(true);
  });
});

describe('W7 垫话预生成接线', () => {
  it('W7-1 partial → 触发预生成;onHint 回推 filler 消息', () => {
    const ws = openConnection();
    ws.feedAudio(AUDIO_FRAME);
    const opts = asrMock.instances[0]!.opts as { onPartial: (t: string) => void };

    opts.onPartial('查一下最近的天气');
    expect(ws.parsed().some((m) => m.type === 'partial' && m.text === '查一下最近的天气')).toBe(true);
    expect(h.noteFillerPartialForPregen).toHaveBeenCalledWith('查一下最近的天气', expect.any(Function));

    // 驱动 onHint(预生成就绪)→ 客户端收到 filler 预合成提示
    const onHint = h.noteFillerPartialForPregen.mock.calls[0]![1] as (t: string) => void;
    onHint('嗯,我在');
    expect(ws.parsed().some((m) => m.type === 'filler' && m.text === '嗯,我在')).toBe(true);
  });

  it('W7-2 final → 密封预生成槽', () => {
    const ws = openConnection();
    ws.feedAudio(AUDIO_FRAME);
    const opts = asrMock.instances[0]!.opts as { onFinal: (t: string) => void };
    opts.onFinal('你好');
    expect(h.sealFillerPartial).toHaveBeenCalledTimes(1);
  });

  it('W7-3 新 ASR 会话建立 → 清工作槽;同会话复用不重复清', () => {
    const ws = openConnection();
    ws.feedAudio(AUDIO_FRAME);
    expect(h.dropFillerPregenWorking).toHaveBeenCalledTimes(1);

    ws.feedAudio(AUDIO_FRAME); // 同会话第二帧:复用,不再清
    expect(h.dropFillerPregenWorking).toHaveBeenCalledTimes(1);

    const opts = asrMock.instances[0]!.opts as { onFinal: (t: string) => void };
    opts.onFinal('你好'); // final 拆除会话
    ws.feedAudio(AUDIO_FRAME); // 新会话 → 再清
    expect(h.dropFillerPregenWorking).toHaveBeenCalledTimes(2);
  });

  it('W7-4 连接关闭/错误/close 指令 → 连接级全清', () => {
    const ws = openConnection();
    ws.emit('close');
    expect(h.dropFillerPregen).toHaveBeenCalledTimes(1);

    const ws2 = openConnection();
    ws2.emit('error');
    expect(h.dropFillerPregen).toHaveBeenCalledTimes(2);

    const ws3 = openConnection();
    ws3.feedText({ type: 'close' });
    expect(h.dropFillerPregen).toHaveBeenCalledTimes(3);
  });
});

describe('声纹门禁 · 丢弃/放行分支', () => {
  type FinalOpts = { onFinal: (t: string, meta?: { voiceprint?: string }) => void };

  it('V1 rejected → 只回空 final(转写清零、不进回合);埋点带 voiceprint;垫话工作槽作废', () => {
    const ws = openConnection();
    ws.feedAudio(AUDIO_FRAME);
    const opts = asrMock.instances[0]!.opts as FinalOpts;

    opts.onFinal('今天下雨了', { voiceprint: 'rejected' });

    const finals = ws.parsed().filter((m) => m.type === 'final');
    expect(finals).toEqual([{ type: 'final', text: '' }]); // 丢弃 = 空 final,文本绝不外发
    expect(h.logVoiceAsr).toHaveBeenCalledWith(
      expect.objectContaining({ text: '今天下雨了', ok: true, voiceprint: 'rejected' }),
    );
    // 建会话 1 次 + 丢弃 1 次(drop 而非 seal:非本人内容永不进预生成密封槽)
    expect(h.dropFillerPregenWorking).toHaveBeenCalledTimes(2);
    expect(h.sealFillerPartial).not.toHaveBeenCalled();

    // 下一段音频 = 新会话(旧会话已拆除)
    ws.feedAudio(AUDIO_FRAME);
    expect(asrMock.instances).toHaveLength(2);
  });

  it('V2 matched → 照常放行;埋点带 matched;密封照旧', () => {
    const ws = openConnection();
    ws.feedAudio(AUDIO_FRAME);
    const opts = asrMock.instances[0]!.opts as FinalOpts;

    opts.onFinal('帮我查天气', { voiceprint: 'matched' });

    expect(ws.parsed().some((m) => m.type === 'final' && m.text === '帮我查天气')).toBe(true);
    expect(h.logVoiceAsr).toHaveBeenCalledWith(
      expect.objectContaining({ text: '帮我查天气', ok: true, voiceprint: 'matched' }),
    );
    expect(h.sealFillerPartial).toHaveBeenCalledTimes(1);
  });

  it('V3 无 meta(门禁未启用)→ 行为与旧逐字一致:final 带文本、埋点无 voiceprint 字段', () => {
    const ws = openConnection();
    ws.feedAudio(AUDIO_FRAME);
    const opts = asrMock.instances[0]!.opts as FinalOpts;

    opts.onFinal('你好');

    expect(ws.parsed().some((m) => m.type === 'final' && m.text === '你好')).toBe(true);
    const calls = h.logVoiceAsr.mock.calls;
    const lastArg = calls[calls.length - 1]![0] as Record<string, unknown>;
    expect('voiceprint' in lastArg).toBe(false);
    expect(h.sealFillerPartial).toHaveBeenCalledTimes(1);
  });
});

describe('跨连接去重护栏(多聆听端一话多回)', () => {
  type FinalOpts = { onFinal: (t: string, meta?: { voiceprint?: string }) => void };
  const finalsOf = (ws: FakeWs): Array<Record<string, unknown>> => ws.parsed().filter((m) => m.type === 'final');

  it('D1 两条连接先后同文本 → 第一条照常放行,第二条回空 final(静默复位不提交)', () => {
    const a = openConnection();
    a.feedAudio(AUDIO_FRAME);
    (asrMock.instances[0]!.opts as FinalOpts).onFinal('你好。你好。');

    const b = openConnection();
    b.feedAudio(AUDIO_FRAME);
    (asrMock.instances[1]!.opts as FinalOpts).onFinal('你好。你好。');

    expect(finalsOf(a)).toEqual([{ type: 'final', text: '你好。你好。' }]);
    expect(finalsOf(b)).toEqual([{ type: 'final', text: '' }]); // 文本绝不外发,客户端不 POST
    // 被抑制侧:不走 seal(垫话工作槽作废语义)、不落 ASR 埋点 —— 只有第一条算真实回合
    expect(h.sealFillerPartial).toHaveBeenCalledTimes(1);
    expect(h.logVoiceAsr).toHaveBeenCalledTimes(1);
  });

  it('D2 同一条连接连说两遍同文本 → 都放行(用户故意重复,必须"另一条连接"才算重复)', () => {
    const ws = openConnection();
    ws.feedAudio(AUDIO_FRAME);
    (asrMock.instances[0]!.opts as FinalOpts).onFinal('再说一遍');
    ws.feedAudio(AUDIO_FRAME); // final 已拆除会话 → 新会话(同一 WS 跨段复用)
    (asrMock.instances[1]!.opts as FinalOpts).onFinal('再说一遍');

    expect(finalsOf(ws)).toEqual([
      { type: 'final', text: '再说一遍' },
      { type: 'final', text: '再说一遍' },
    ]);
  });

  it('D3 不同文本互不影响;仅空白差异视为同一句', () => {
    const a = openConnection();
    a.feedAudio(AUDIO_FRAME);
    (asrMock.instances[0]!.opts as FinalOpts).onFinal('查 天气');

    const b = openConnection();
    b.feedAudio(AUDIO_FRAME);
    (asrMock.instances[1]!.opts as FinalOpts).onFinal('查天气'); // 去空白后相同 → 抑制
    expect(finalsOf(b)).toEqual([{ type: 'final', text: '' }]);

    const c = openConnection();
    c.feedAudio(AUDIO_FRAME);
    (asrMock.instances[2]!.opts as FinalOpts).onFinal('几点了'); // 不同文本照常放行
    expect(finalsOf(c)).toEqual([{ type: 'final', text: '几点了' }]);
  });

  it('D4 声纹 rejected 的终稿不占位:不影响后续同文本正常放行', () => {
    const a = openConnection();
    a.feedAudio(AUDIO_FRAME);
    (asrMock.instances[0]!.opts as FinalOpts).onFinal('你好', { voiceprint: 'rejected' });

    const b = openConnection();
    b.feedAudio(AUDIO_FRAME);
    (asrMock.instances[1]!.opts as FinalOpts).onFinal('你好');

    expect(finalsOf(b)).toEqual([{ type: 'final', text: '你好' }]);
  });
});
