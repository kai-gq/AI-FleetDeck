/**
 * STT 云通道服务:火山引擎批量识别(「语音转文字」的云端路径)。
 *
 * 背景:云识别原本写在 whisper 垫片(Python,硅基流动 SenseVoice)里,
 * 与语音伙伴的火山流式通道构成两家供应商/两套凭据;2026-10-10 统一到
 * 火山引擎 —— 本服务直接复用已验证的 WebSocket 协议客户端
 * VolcengineAsrSession(把一段音频全部喂完再收末包,当批量用),
 * 凭据取自语音伙伴的 config.json(stt.volcengine,单一来源)。
 *
 * 决策链(与 routes/stt.ts、services/audio-transcription.ts 共用):
 *   mode(cloud.json 的 {mode}) × 凭据是否可用 → 'cloud-first' | 'local-only' | 'cloud-only'
 *
 * 注意:VolcengineAsrSession 内部带声纹门禁(「只认主人」)与热词注入,
 * 听写会跟随「语音伙伴」的同一套判定(rejected → 空结果,unknown 放行)。
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createLogger } from '../utils/logger.js';
import { VolcengineAsrSession } from '../voice/volcengine-asr-client.js';
import type { VolcengineSttConfig } from './voice-companion-service.js';

const log = createLogger('SttVolcengine');

export type SttEngineMode = 'auto' | 'local' | 'cloud';
export type SttEnginePlan = 'cloud-first' | 'local-only' | 'cloud-only';

/** 决策矩阵:auto=云优先失败回退;cloud 仅云端(无凭据时退化为本地,与旧垫片语义一致);local 纯本地。 */
export function decideSttEngine(mode: SttEngineMode, hasCreds: boolean): SttEnginePlan {
  if (mode === 'local' || !hasCreds) return 'local-only';
  return mode === 'cloud' ? 'cloud-only' : 'cloud-first';
}

/** 与 voice-companion-stream.ts 的同名判定一致(apiKey 优先,否则 appId+accessToken)——本地重写 3 行避免把常驻链路模块拖进本服务。 */
export function hasVolcengineCreds(cfg: VolcengineSttConfig): boolean {
  return !!cfg.apiKey || (!!cfg.appId && !!cfg.accessToken);
}

/**
 * 读 tools/whisper/cloud.json 的 {mode} 开关(工具箱「语音转文字」在写)。
 * 文件缺失/损坏/字段非法 → auto,绝不抛出。测试可用 TC_STT_CLOUD_CONFIG 覆盖路径。
 */
export function loadSttCloudMode(): SttEngineMode {
  try {
    const p = process.env.TC_STT_CLOUD_CONFIG || path.join(process.cwd(), 'tools', 'whisper', 'cloud.json');
    if (!existsSync(p)) return 'auto';
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as { mode?: unknown };
    return raw?.mode === 'local' || raw?.mode === 'cloud' ? raw.mode : 'auto';
  } catch {
    return 'auto';
  }
}

// 单次云识别整体上限(含转码+连接+末包):超时抛错,由调用方按模式决定回退还是报错。
const DEFAULT_TIMEOUT_MS = 30_000;
// finish() 后等末包的上限;超时由会话内部用最后 partial 兜底。
const DEFAULT_FINISH_TIMEOUT_MS = 12_000;
// 转码上限
const DECODE_TIMEOUT_MS = 30_000;
// 喂音频节流:100ms/包 × 25 倍速 —— 连接未就绪时 sendAudio 会进有界队列(30s 上限),节流防丢弃
const FEED_CHUNK_BYTES = 3_200;
const FEED_GAP_MS = 4;

function ffmpegPath(): string {
  const local = path.join(process.cwd(), 'tools', 'whisper', 'ffmpeg', 'bin', 'ffmpeg.exe');
  if (existsSync(local)) return local;
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

/** 参数抽出成纯函数便于单测:任意输入 → 16kHz 单声道 PCM16LE 到 stdout。 */
export function buildFfmpegPcmArgs(input: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-i', input,
    '-vn', '-ac', '1', '-ar', '16000',
    '-f', 's16le', 'pipe:1',
  ];
}

/** ffmpeg 转码为 PCM16LE/16k/mono;失败/超时抛错。 */
export function decodeToPcm16k(audioPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(ffmpegPath(), buildFfmpegPcmArgs(audioPath), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`ffmpeg 启动失败:${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    const chunks: Buffer[] = [];
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      reject(new Error(`ffmpeg 转码超时(${DECODE_TIMEOUT_MS}ms)`));
    }, DECODE_TIMEOUT_MS);
    timer.unref?.();
    proc.stdout?.on('data', (c: Buffer) => chunks.push(c));
    proc.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
      if (stderr.length > 4096) stderr = stderr.slice(-2048);
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`ffmpeg 启动失败:${err.message}`));
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg 转码失败(code=${code}):${stderr.slice(0, 200)}`));
    });
  });
}

/**
 * 一段音频 → 火山引擎识别文本(text 可为空串 = 有效静音/被声纹门禁判拒)。
 * 抛错 = 链路失败(凭据/网络/超时),由调用方决定回退本地或上抛。
 * 日志绝不落 apiKey。
 */
export async function transcribeViaVolcengine(
  audioPath: string,
  credentials: VolcengineSttConfig,
  opts: { timeoutMs?: number; finishTimeoutMs?: number } = {},
): Promise<{ text: string; durationMs: number }> {
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const pcm = await decodeToPcm16k(audioPath);
  if (pcm.length === 0) throw new Error('转码结果为空(音频无有效内容)');

  const text = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const session = new VolcengineAsrSession({
      credentials,
      uid: 'tide-commander-stt',
      finishTimeoutMs: opts.finishTimeoutMs ?? DEFAULT_FINISH_TIMEOUT_MS,
      onFinal: (t, meta) => {
        // 声纹门禁判拒(非主人)= 空结果,与「只认主人」语义一致;unknown 照常放行
        if (meta?.voiceprint === 'rejected') {
          log.log('声纹门禁判拒:按空结果处理');
          settle(() => resolve(''));
          return;
        }
        settle(() => resolve(t));
      },
      onError: (err) => settle(() => reject(err)),
      onLog: (line) => log.debug(line),
    });

    const timer = setTimeout(() => {
      settle(() => {
        try { session.close(); } catch { /* ignore */ }
        reject(new Error(`火山识别超时(${timeoutMs}ms)`));
      });
    }, timeoutMs);
    timer.unref?.();

    void (async () => {
      try {
        for (let off = 0; off < pcm.length; off += FEED_CHUNK_BYTES) {
          if (settled) return;
          session.sendAudio(pcm.subarray(off, Math.min(off + FEED_CHUNK_BYTES, pcm.length)));
          await sleep(FEED_GAP_MS);
        }
        if (!settled) session.finish();
      } catch (err) {
        settle(() => {
          try { session.close(); } catch { /* ignore */ }
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      }
    })();
  });

  return { text, durationMs: Date.now() - startedAt };
}
