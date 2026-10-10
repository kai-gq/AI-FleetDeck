/**
 * Audio Transcription Service
 *
 * Wraps the OpenAI `whisper` CLI when it's installed on the host, so inbound
 * audio attachments from integrations (WhatsApp voice notes, Slack audio
 * uploads, …) can be converted to text in addition to the file itself.
 *
 * Design constraints:
 *  - SAFE NO-OP when whisper is missing. The integration pipeline must keep
 *    working unchanged on machines without it — the only effect is that
 *    `audioTranscription` stays undefined.
 *  - NEVER THROWS. Errors are logged and surfaced as `null`.
 *  - Whisper detection is cached for the process lifetime; installing or
 *    removing whisper requires a server restart to re-detect (matches the
 *    behavior of every other CLI-probe we have).
 *  - We invoke whisper via `--output_format txt --output_dir <same dir as
 *    audio>` and read the resulting `<base>.txt` back. Stdout could be
 *    parsed instead but file-based is simpler and avoids buffering large
 *    progress logs in memory.
 */

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { logVoiceAsr } from './activity-log.js';
import { loadVolcengineSttConfig } from './voice-companion-service.js';
import {
  decideSttEngine,
  hasVolcengineCreds,
  loadSttCloudMode,
  transcribeViaVolcengine,
} from './stt-volcengine.js';

const log = createLogger('AudioTranscription');

let whisperAvailable: boolean | null = null;

/**
 * Probe for the `whisper` CLI. Cached after the first call.
 */
export async function isWhisperAvailable(): Promise<boolean> {
  if (whisperAvailable !== null) return whisperAvailable;
  whisperAvailable = await detectWhisper();
  return whisperAvailable;
}

function detectWhisper(): Promise<boolean> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('whisper', ['--help'], { stdio: 'ignore' });
    } catch {
      log.debug('whisper not found on PATH; audio transcription disabled');
      resolve(false);
      return;
    }
    proc.on('error', () => {
      log.debug('whisper not found on PATH; audio transcription disabled');
      resolve(false);
    });
    proc.on('exit', (code) => {
      const ok = code === 0;
      if (ok) {
        log.log('whisper detected on PATH; audio transcription enabled');
      } else {
        log.debug(`whisper --help exited ${code}; audio transcription disabled`);
      }
      resolve(ok);
    });
  });
}

export interface TranscribeOpts {
  /** Whisper `--language` value (e.g. "Spanish", "English"). Omit for auto-detect. */
  language?: string;
  /** Whisper `--model` value. Defaults to `medium`. */
  model?: string;
  /** Hard timeout in ms. Default 5 minutes — medium model on CPU can be slow. */
  timeoutMs?: number;
}

/**
 * 转写结果（任务 02 扩展）：文本 + 服务端耗时。
 * 原返回 `string | null`，为语音链路埋点（ASR 文本与耗时，Spec §4.14 系统活动 1）
 * 扩为对象；调用方取 `.text`。失败仍返回 null，绝不抛异常。
 */
export interface TranscribeResult {
  text: string;
  /** 本次调用服务端耗时（含缓存命中路径的极短耗时） */
  durationMs: number;
  /** true = 命中已有的 <base>.txt，未实际调用 whisper */
  cached: boolean;
}

/**
 * Transcribe an audio file via whisper. Returns the transcribed text (plus
 * server-side duration for logging), or `null` on any failure (whisper
 * missing, non-zero exit, timeout, missing file). Never throws.
 */
export async function transcribeAudio(
  audioPath: string,
  opts: TranscribeOpts = {},
): Promise<TranscribeResult | null> {
  const startedAt = Date.now();
  const audioFile = path.basename(audioPath);

  if (!(await isWhisperAvailable())) return null;

  try {
    await fs.access(audioPath);
  } catch {
    log.warn(`transcribeAudio: file not found ${audioPath}`);
    logVoiceAsr({
      channel: 'whisper', text: '', ok: false, error: 'file-not-found',
      durationMs: Date.now() - startedAt, audioFile, model: opts.model ?? 'medium', language: opts.language,
    });
    return null;
  }

  const outputDir = path.dirname(audioPath);
  const baseName = path.basename(audioPath, path.extname(audioPath));
  const txtPath = path.join(outputDir, `${baseName}.txt`);

  // Idempotent cache hit: if a previous run already produced the txt file,
  // skip the (slow) whisper invocation. Same dedup intent as the attachment
  // downloader's existingSizeMatches.
  try {
    const stat = await fs.stat(txtPath);
    if (stat.isFile() && stat.size > 0) {
      const cachedText = (await fs.readFile(txtPath, 'utf-8')).trim();
      if (cachedText) {
        const durationMs = Date.now() - startedAt;
        log.debug(`transcribeAudio: cache-hit ${txtPath}`);
        logVoiceAsr({
          channel: 'whisper', text: cachedText, cached: true, ok: true,
          durationMs, audioFile, model: opts.model ?? 'medium', language: opts.language,
        });
        return { text: cachedText, durationMs, cached: true };
      }
    }
  } catch { /* no cache, fall through */ }

  // 云通道优先(与 routes/stt.ts 同一决策):auto=火山优先失败回退本地,cloud=只走火山。
  // 结果写回 <base>.txt,与本地路径共享同一个幂等缓存。
  {
    const cloudCreds = loadVolcengineSttConfig();
    const plan = decideSttEngine(loadSttCloudMode(), hasVolcengineCreds(cloudCreds));
    if (plan !== 'local-only') {
      try {
        const { text: cloudText, durationMs } = await transcribeViaVolcengine(
          audioPath,
          cloudCreds,
          { timeoutMs: 60_000 },
        );
        try {
          await fs.writeFile(txtPath, cloudText, 'utf-8');
        } catch (err) {
          log.debug(`transcribeAudio: cloud txt cache write failed: ${err}`);
        }
        logVoiceAsr({
          channel: 'volcengine-batch', text: cloudText, cached: false, ok: true,
          durationMs, audioFile, model: 'volcengine-bigmodel', language: opts.language,
        });
        return cloudText ? { text: cloudText, durationMs, cached: false } : null;
      } catch (err) {
        const detail = String(err instanceof Error ? err.message : err).slice(0, 200);
        if (plan === 'cloud-only') {
          log.warn(`transcribeAudio: cloud-only mode failed: ${detail}`);
          logVoiceAsr({
            channel: 'volcengine-batch', text: '', ok: false, error: detail,
            durationMs: Date.now() - startedAt, audioFile, model: 'volcengine-bigmodel', language: opts.language,
          });
          return null;
        }
        log.debug(`transcribeAudio: cloud failed, falling back to local whisper: ${detail}`);
      }
    }
  }

  const model = opts.model ?? 'medium';
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const args: string[] = [
    audioPath,
    '--model', model,
    '--output_format', 'txt',
    '--output_dir', outputDir,
    '--verbose', 'False',
    // `--fp16 False` keeps the FP16-on-CPU UserWarning out of stderr and
    // matches what whisper itself falls back to on CPU-only hosts anyway.
    '--fp16', 'False',
  ];
  if (opts.language) {
    args.push('--language', opts.language);
  }

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('whisper', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      log.warn(`transcribeAudio: spawn threw: ${err}`);
      logVoiceAsr({
        channel: 'whisper', text: '', ok: false, error: 'spawn-threw',
        durationMs: Date.now() - startedAt, audioFile, model, language: opts.language,
      });
      resolve(null);
      return;
    }

    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      log.warn(`transcribeAudio: timeout after ${timeoutMs}ms for ${audioPath}`);
      logVoiceAsr({
        channel: 'whisper', text: '', ok: false, error: 'timeout',
        durationMs: Date.now() - startedAt, audioFile, model, language: opts.language,
      });
    }, timeoutMs);

    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-4096);
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      log.warn(`transcribeAudio: spawn error: ${err}`);
      logVoiceAsr({
        channel: 'whisper', text: '', ok: false, error: `spawn-error`,
        durationMs: Date.now() - startedAt, audioFile, model, language: opts.language,
      });
      resolve(null);
    });
    proc.on('exit', async (code) => {
      clearTimeout(timer);
      if (killed) { resolve(null); return; }
      if (code !== 0) {
        log.warn(`transcribeAudio: whisper exit ${code} for ${audioPath}: ${stderr.slice(-500)}`);
        logVoiceAsr({
          channel: 'whisper', text: '', ok: false, error: `exit-${code}`,
          durationMs: Date.now() - startedAt, audioFile, model, language: opts.language,
        });
        resolve(null);
        return;
      }
      try {
        const raw = await fs.readFile(txtPath, 'utf-8');
        const text = raw.trim();
        const durationMs = Date.now() - startedAt;
        const tookSec = (durationMs / 1000).toFixed(1);
        log.log(`transcribed ${audioPath} in ${tookSec}s (${text.length} chars, model=${model}${opts.language ? ` lang=${opts.language}` : ''})`);
        logVoiceAsr({
          channel: 'whisper', text, cached: false, ok: true,
          durationMs, audioFile, model, language: opts.language,
        });
        resolve(text ? { text, durationMs, cached: false } : null);
      } catch (err) {
        log.warn(`transcribeAudio: failed to read ${txtPath}: ${err}`);
        logVoiceAsr({
          channel: 'whisper', text: '', ok: false, error: 'read-output-failed',
          durationMs: Date.now() - startedAt, audioFile, model, language: opts.language,
        });
        resolve(null);
      }
    });
  });
}
