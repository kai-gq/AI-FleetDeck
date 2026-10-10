/**
 * STT (Speech-to-Text) Route
 * Uses Whisper for speech recognition
 */

import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import { writeFile, unlink, mkdir } from 'fs/promises';
import os from 'os';
import path from 'path';
import { logger } from '../utils/logger.js';
import { logVoiceAsr } from '../services/activity-log.js';
import { loadVolcengineSttConfig } from '../services/voice-companion-service.js';
import {
  decideSttEngine,
  hasVolcengineCreds,
  loadSttCloudMode,
  transcribeViaVolcengine,
} from '../services/stt-volcengine.js';

const router = Router();

// Temp directory for audio files
const TEMP_DIR = path.join(os.tmpdir(), 'tide-commander-stt');

// Ensure temp directory exists
mkdir(TEMP_DIR, { recursive: true }).catch(() => {});

/**
 * POST /api/stt/transcribe
 * Transcribes audio using Whisper
 * Expects audio data as base64 in request body
 */
router.post('/transcribe', async (req: Request, res: Response) => {
  const { audio, language = 'Spanish', model = 'medium' } = req.body;

  if (!audio || typeof audio !== 'string') {
    return res.status(400).json({ error: 'Audio data is required (base64 encoded)' });
  }

  // Generate unique filename
  const filename = `audio_${Date.now()}.webm`;
  const filepath = path.join(TEMP_DIR, filename);
  // 任务 02 语音链路埋点：ASR 耗时（批量兜底通道；流式通道见 voice-companion-stream）
  const startedAt = Date.now();

  try {
    // Decode base64 audio and save to temp file
    const audioBuffer = Buffer.from(audio, 'base64');
    await writeFile(filepath, audioBuffer);

    logger.server.log(`[STT] Transcribing audio file: ${filepath} (${audioBuffer.length} bytes)`);

    // 云通道(2026-10-10 起 = 火山引擎,复用语音伙伴凭据;详见 services/stt-volcengine.ts):
    // auto=云优先失败回退本地,cloud=仅云端失败即报错,local=跳过。日志绝不落密钥。
    const cloudMode = loadSttCloudMode();
    const cloudCreds = loadVolcengineSttConfig();
    const plan = decideSttEngine(cloudMode, hasVolcengineCreds(cloudCreds));

    if (plan !== 'local-only') {
      try {
        const { text: cloudText, durationMs } = await transcribeViaVolcengine(filepath, cloudCreds);
        unlink(filepath).catch(() => {});
        logVoiceAsr({
          channel: 'volcengine-batch', text: cloudText, cached: false, ok: true,
          durationMs, audioFile: filename, model: 'volcengine-bigmodel', language,
        });
        logger.server.log(`[STT] 火山识别完成: "${cloudText.substring(0, 100)}..." (${durationMs}ms)`);
        return res.json({ success: true, text: cloudText, engine: 'volcengine' });
      } catch (err) {
        const detail = String(err).slice(0, 300);
        if (plan === 'cloud-only') {
          unlink(filepath).catch(() => {});
          logVoiceAsr({
            channel: 'volcengine-batch', text: '', ok: false, error: detail.slice(0, 200),
            durationMs: Date.now() - startedAt, audioFile: filename, model: 'volcengine-bigmodel', language,
          });
          logger.server.error(`[STT] 火山识别失败(仅云端模式,不回退): ${detail}`);
          return res.status(500).json({ error: 'Cloud transcription failed', details: detail });
        }
        logger.server.log(`[STT] 火山识别失败,回退本地 whisper: ${detail}`);
      }
    }

    // Run whisper
    const transcription = await new Promise<string>((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const whisper = spawn('whisper', [
        filepath,
        '--model', model,
        '--language', language,
        '--output_format', 'txt',
        '--output_dir', TEMP_DIR,
      ]);

      whisper.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      whisper.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
        // Whisper outputs progress to stderr
        const msg = data.toString();
        if (msg.includes('Error') || msg.includes('error')) {
          logger.server.error(`[STT] Whisper stderr: ${msg}`);
        }
      });

      whisper.on('error', (err) => {
        reject(new Error(`Whisper spawn error: ${err.message}`));
      });

      whisper.on('close', async (code) => {
        if (code === 0) {
          // Read the output txt file
          try {
            const { readFile } = await import('fs/promises');
            const txtPath = filepath.replace(/\.[^.]+$/, '.txt');
            const text = await readFile(txtPath, 'utf-8');
            // Clean up txt file
            unlink(txtPath).catch(() => {});
            resolve(text.trim());
          } catch {
            // If txt file not found, try to parse from stdout
            const match = stdout.match(/\[\d+:\d+\.\d+ --> \d+:\d+\.\d+\]\s*(.+)/g);
            if (match) {
              const text = match.map(line => line.replace(/\[\d+:\d+\.\d+ --> \d+:\d+\.\d+\]\s*/, '')).join(' ');
              resolve(text.trim());
            } else {
              reject(new Error('Could not parse transcription output'));
            }
          }
        } else {
          reject(new Error(`Whisper exited with code ${code}: ${stderr}`));
        }
      });
    });

    // Clean up audio file
    unlink(filepath).catch(() => {});

    // 任务 02 埋点：系统活动 1 —— ASR 文本与耗时
    logVoiceAsr({
      channel: 'whisper', text: transcription, cached: false, ok: true,
      durationMs: Date.now() - startedAt, audioFile: filename, model, language,
    });

    logger.server.log(`[STT] Transcription complete: "${transcription.substring(0, 100)}..."`);

    res.json({ success: true, text: transcription });

  } catch (err) {
    // Clean up on error
    unlink(filepath).catch(() => {});

    logVoiceAsr({
      channel: 'whisper', text: '', ok: false,
      error: String(err).slice(0, 200),
      durationMs: Date.now() - startedAt, audioFile: filename, model, language,
    });

    logger.server.error(`[STT] Error transcribing audio: ${err}`);
    res.status(500).json({ error: 'Failed to transcribe audio', details: String(err) });
  }
});

export default router;
