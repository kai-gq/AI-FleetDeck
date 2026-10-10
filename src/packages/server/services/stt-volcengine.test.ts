/**
 * 火山批量识别服务单测:
 *  - decideSttEngine / hasVolcengineCreds 决策矩阵(纯函数)
 *  - loadSttCloudMode 解析(TC_STT_CLOUD_CONFIG 指向沙箱,绝不碰真实 cloud.json)
 *  - transcribeViaVolcengine 全链路:fake ffmpeg(child_process)+ fake 会话管道,
 *    覆盖 成功/声纹判拒/链路报错/超时/空音频 五条分支。
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../voice/volcengine-asr-client.js', () => {
  class FakeSession {
    static instances: FakeSession[] = [];
    static behavior: 'ok' | 'rejected' | 'error' | 'silent' = 'ok';
    opts: {
      onFinal?: (text: string, meta?: { voiceprint?: string }) => void;
      onError?: (err: Error) => void;
    };
    sentBytes = 0;
    finished = false;
    closed = false;
    constructor(opts: FakeSession['opts']) {
      this.opts = opts;
      FakeSession.instances.push(this);
    }
    sendAudio(chunk: Buffer): void {
      this.sentBytes += chunk.length;
    }
    finish(): void {
      this.finished = true;
      if (FakeSession.behavior === 'ok') this.opts.onFinal?.('你好世界', {});
      else if (FakeSession.behavior === 'rejected') this.opts.onFinal?.('不该出现', { voiceprint: 'rejected' });
      else if (FakeSession.behavior === 'error') this.opts.onError?.(new Error('boom'));
      // silent:什么都不回,交给超时
    }
    close(): void {
      this.closed = true;
    }
  }
  return { VolcengineAsrSession: FakeSession };
});

import { spawn } from 'child_process';
import { VolcengineAsrSession } from '../voice/volcengine-asr-client.js';
import {
  buildFfmpegPcmArgs,
  decideSttEngine,
  hasVolcengineCreds,
  loadSttCloudMode,
  transcribeViaVolcengine,
} from './stt-volcengine.js';
import type { VolcengineSttConfig } from './voice-companion-service.js';

const spawnMock = vi.mocked(spawn);
const FakeSessions = VolcengineAsrSession as unknown as {
  instances: Array<{ sentBytes: number; finished: boolean; closed: boolean }>;
  behavior: 'ok' | 'rejected' | 'error' | 'silent';
};

function creds(over: Partial<VolcengineSttConfig> = {}): VolcengineSttConfig {
  return { apiKey: 'k', appId: '', accessToken: '', resourceId: '', endpoint: 'bigmodel_async', ...over };
}

/** fake ffmpeg:下一拍吐出 pcm 并以 code 关闭。 */
function ffmpegResponds(pcm: Buffer, code = 0): void {
  spawnMock.mockImplementation(() => {
    const p = new FakeProc();
    setTimeout(() => {
      if (pcm.length) p.stdout.emit('data', pcm);
      p.emit('close', code);
    }, 0);
    return p as unknown as ReturnType<typeof spawn>;
  });
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-volc-test-'));
afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
});
beforeEach(() => {
  spawnMock.mockReset();
  FakeSessions.instances.length = 0;
  FakeSessions.behavior = 'ok';
});

describe('decideSttEngine', () => {
  it.each([
    ['auto', true, 'cloud-first'],
    ['auto', false, 'local-only'],
    ['local', true, 'local-only'],
    ['local', false, 'local-only'],
    ['cloud', true, 'cloud-only'],
    // 仅云端但没凭据 = 退化本地(与旧垫片语义一致),而不是必然失败
    ['cloud', false, 'local-only'],
  ] as const)('mode=%s creds=%s → %s', (mode, hasCreds, expected) => {
    expect(decideSttEngine(mode, hasCreds)).toBe(expected);
  });
});

describe('hasVolcengineCreds', () => {
  it('apiKey 优先;无 apiKey 时 appId+accessToken 齐全才算', () => {
    expect(hasVolcengineCreds(creds())).toBe(true);
    expect(hasVolcengineCreds(creds({ apiKey: '', appId: 'a', accessToken: 't' }))).toBe(true);
    expect(hasVolcengineCreds(creds({ apiKey: '', appId: 'a', accessToken: '' }))).toBe(false);
    expect(hasVolcengineCreds(creds({ apiKey: '' }))).toBe(false);
  });
});

describe('loadSttCloudMode', () => {
  function withConfig(content: string | null): string {
    const p = path.join(TMP, `cloud-${Math.random().toString(36).slice(2)}.json`);
    if (content !== null) fs.writeFileSync(p, content, 'utf-8');
    vi.stubEnv('TC_STT_CLOUD_CONFIG', p);
    return p;
  }

  it('读合法 mode;非法/损坏/缺失一律 auto', () => {
    withConfig('{"mode":"local"}');
    expect(loadSttCloudMode()).toBe('local');
    withConfig('{"mode":"cloud"}');
    expect(loadSttCloudMode()).toBe('cloud');
    withConfig('{"mode":"bogus"}');
    expect(loadSttCloudMode()).toBe('auto');
    withConfig('{not json');
    expect(loadSttCloudMode()).toBe('auto');
    withConfig(null);
    expect(loadSttCloudMode()).toBe('auto');
  });
});

describe('buildFfmpegPcmArgs', () => {
  it('转 16k 单声道 PCM16LE 到 stdout', () => {
    const args = buildFfmpegPcmArgs('E:/x/a.webm');
    expect(args).toContain('-i');
    expect(args[args.indexOf('-ar') + 1]).toBe('16000');
    expect(args[args.indexOf('-ac') + 1]).toBe('1');
    expect(args[args.indexOf('-f') + 1]).toBe('s16le');
    expect(args[args.length - 1]).toBe('pipe:1');
  });
});

describe('transcribeViaVolcengine', () => {
  it('成功:喂完音频 → finish → 返回文本;节流分片不丢字节', async () => {
    ffmpegResponds(Buffer.alloc(7000, 1));
    const r = await transcribeViaVolcengine('E:/x/a.webm', creds(), { timeoutMs: 2000 });
    expect(r.text).toBe('你好世界');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    const s = FakeSessions.instances[0];
    expect(s.sentBytes).toBe(7000);
    expect(s.finished).toBe(true);
  });

  it('声纹判拒 → 空结果(rejected 文本不外泄)', async () => {
    ffmpegResponds(Buffer.alloc(1000, 1));
    FakeSessions.behavior = 'rejected';
    const r = await transcribeViaVolcengine('E:/x/a.webm', creds(), { timeoutMs: 2000 });
    expect(r.text).toBe('');
  });

  it('会话报错 → reject(由调用方决定回退)', async () => {
    ffmpegResponds(Buffer.alloc(1000, 1));
    FakeSessions.behavior = 'error';
    await expect(transcribeViaVolcengine('E:/x/a.webm', creds(), { timeoutMs: 2000 })).rejects.toThrow('boom');
  });

  it('末包无应答 → 超时 reject 并关闭会话', async () => {
    ffmpegResponds(Buffer.alloc(1000, 1));
    FakeSessions.behavior = 'silent';
    await expect(transcribeViaVolcengine('E:/x/a.webm', creds(), { timeoutMs: 80 })).rejects.toThrow(/超时/);
    expect(FakeSessions.instances[0].closed).toBe(true);
  });

  it('转码为空 → reject,不建会话', async () => {
    ffmpegResponds(Buffer.alloc(0));
    await expect(transcribeViaVolcengine('E:/x/a.webm', creds())).rejects.toThrow(/为空/);
    expect(FakeSessions.instances).toHaveLength(0);
  });

  it('ffmpeg 失败 → reject(带退出码)', async () => {
    spawnMock.mockImplementation(() => {
      const p = new FakeProc();
      setTimeout(() => {
        p.stderr.emit('data', Buffer.from('Invalid data found'));
        p.emit('close', 1);
      }, 0);
      return p as unknown as ReturnType<typeof spawn>;
    });
    await expect(transcribeViaVolcengine('E:/x/a.webm', creds())).rejects.toThrow(/code=1/);
  });
});
