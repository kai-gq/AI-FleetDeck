/**
 * TTS (Text-to-Speech) Route
 * Uses Piper for high-quality speech synthesis, returns audio to browser
 * Auto-detects language (Spanish/English) based on text content
 */

import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { logVoiceTts } from '../services/activity-log.js';
import { detectAudioMime } from '../voice/tts-audio-format.js';

const router = Router();

// Find project root (where package.json is), same idiom as app.ts
function findProjectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== '/') {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

// Locate the piper executable:
// PIPER_BIN env override -> project-local tools/piper -> PATH lookup ('piper')
function resolvePiperBin(): string {
  if (process.env.PIPER_BIN) {
    return process.env.PIPER_BIN;
  }
  const exe = process.platform === 'win32' ? 'piper.exe' : 'piper';
  const candidates = [
    path.join(findProjectRoot(), 'tools', 'piper', exe),
    path.join(process.cwd(), 'tools', 'piper', exe),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return 'piper';
}

// Locate voice models:
// PIPER_VOICES_DIR env override -> project-local tools/piper/voices
// -> legacy ~/.local/share/piper-voices
function resolveVoicesDir(): string {
  if (process.env.PIPER_VOICES_DIR) {
    return process.env.PIPER_VOICES_DIR;
  }
  const candidates = [
    path.join(findProjectRoot(), 'tools', 'piper', 'voices'),
    path.join(process.cwd(), 'tools', 'piper', 'voices'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(os.homedir(), '.local/share/piper-voices');
}

// Voice models by language
const VOICES = {
  es: 'es_MX-claude-high',   // Latin American Spanish (Mexican female - Claude voice)
  en: 'en_US-amy-medium',    // American English (female)
  zh: 'zh_CN-huayan-medium', // Mandarin Chinese (female)
};

// Common Spanish words for language detection
const SPANISH_INDICATORS = [
  // Common words
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
  'de', 'del', 'en', 'con', 'por', 'para', 'sin', 'sobre',
  'que', 'qué', 'como', 'cómo', 'cuando', 'cuándo', 'donde', 'dónde',
  'es', 'está', 'son', 'están', 'ser', 'estar', 'hay',
  'yo', 'tú', 'él', 'ella', 'nosotros', 'ellos', 'ellas',
  'mi', 'tu', 'su', 'nuestro', 'vuestro',
  'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas',
  'pero', 'porque', 'aunque', 'también', 'además', 'entonces',
  'puede', 'pueden', 'puedo', 'podemos', 'hacer', 'hecho',
  'muy', 'más', 'menos', 'bien', 'mal', 'sí', 'no',
  'ahora', 'aquí', 'allí', 'hoy', 'ayer', 'mañana',
  // Verbs
  'tiene', 'tienen', 'tengo', 'tenemos', 'quiero', 'quiere',
  'necesito', 'necesita', 'busco', 'busca', 'encuentro', 'encuentra',
  // Tech terms often used in Spanish
  'archivo', 'archivos', 'código', 'función', 'método', 'clase',
  'ejecutar', 'compilar', 'instalar', 'configurar',
];

// Common English words for language detection
const ENGLISH_INDICATORS = [
  // Common words
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'this', 'that', 'these', 'those', 'it', 'its',
  'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your', 'his', 'her', 'our', 'their',
  'and', 'or', 'but', 'if', 'then', 'else', 'when', 'where', 'how', 'what', 'which',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'about', 'from',
  'not', 'no', 'yes', 'can', 'cannot', "can't", "don't", "doesn't", "won't",
  'here', 'there', 'now', 'today', 'tomorrow', 'yesterday',
  // Tech terms
  'file', 'files', 'code', 'function', 'method', 'class',
  'run', 'execute', 'compile', 'install', 'configure', 'build',
  'error', 'warning', 'success', 'failed', 'complete',
];

/**
 * Detect language based on word frequency
 * Returns 'zh' for Chinese, 'es' for Spanish, 'en' for English
 */
function detectLanguage(text: string): 'es' | 'en' | 'zh' {
  // Chinese has no space-separated words: compare CJK ideograph count against
  // Latin letters so mixed CN/EN text (paths, identifiers) still picks zh.
  const cjkCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinCount = (text.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) || []).length;
  if (cjkCount > 0 && cjkCount >= latinCount) {
    logger.server.log(`[TTS] Language detection: CJK=${cjkCount}, Latin=${latinCount} -> zh`);
    return 'zh';
  }

  const words = text.toLowerCase().split(/\s+/);

  let spanishScore = 0;
  let englishScore = 0;

  for (const word of words) {
    // Clean punctuation from word
    const cleanWord = word.replace(/[.,!?;:'"()[\]{}]/g, '');

    if (SPANISH_INDICATORS.includes(cleanWord)) {
      spanishScore++;
    }
    if (ENGLISH_INDICATORS.includes(cleanWord)) {
      englishScore++;
    }
  }

  // Check for Spanish-specific characters (accents, ñ, ¿, ¡)
  if (/[áéíóúüñ¿¡]/.test(text)) {
    spanishScore += 3;
  }

  const detected = spanishScore > englishScore ? 'es' : 'en';
  logger.server.log(`[TTS] Language detection: Spanish=${spanishScore}, English=${englishScore} -> ${detected}`);

  return detected;
}

/**
 * 解析可选的 rate/volume(语速/音量百分比数字,-100..100):
 * 缺失/空串/null/非有限数 → undefined(不传,由垫片按配置/默认处理);
 * 越界钳到范围(垫片端同样钳一遍,双保险)。
 */
export function parseTuningValue(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(/%$/, ''));
  if (!Number.isFinite(n)) return undefined;
  return Math.max(-100, Math.min(100, n));
}

/** 组装 piper 参数:新参数只在显式给值时追加(不打扰未使用它的调用方)。 */
export function buildPiperArgs(
  modelPath: string,
  outputFile: string,
  tuning: { rate?: number; volume?: number } = {},
): string[] {
  const args = ['--model', modelPath, '--output_file', outputFile];
  if (tuning.rate !== undefined) args.push('--rate', String(tuning.rate));
  if (tuning.volume !== undefined) args.push('--volume', String(tuning.volume));
  return args;
}

/**
 * POST /api/tts/speak
 * Generates audio using Piper TTS and returns audio data
 * (W1:垫片默认直返 mp3,Content-Type 按魔数判型;EDGE_TTS_MP3=0 回退 wav)
 * Auto-detects language if not specified
 */
router.post('/speak', async (req: Request, res: Response) => {
  const { text, voice, lang, rate, volume } = req.body;
  // 任务 02 语音链路埋点：服务端合成耗时（播放时长在客户端，见缺口清单）。
  const startedAt = Date.now();

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Text is required' });
  }

  // Clean text for speech (remove markdown, etc.)
  const cleanedText = text
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`[^`]+`/g, ' code ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/^[-*_]{3,}$/gm, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleanedText) {
    return res.status(400).json({ error: 'No text to speak after cleaning' });
  }

  // Determine voice: explicit voice > explicit lang > auto-detect
  let selectedVoice: string;
  if (voice) {
    selectedVoice = voice;
  } else {
    const detectedLang = lang || detectLanguage(cleanedText);
    selectedVoice = VOICES[detectedLang as keyof typeof VOICES] || VOICES.en;
  }

  const tuning = { rate: parseTuningValue(rate), volume: parseTuningValue(volume) };
  const tuningLog = tuning.rate !== undefined || tuning.volume !== undefined
    ? ` (rate=${tuning.rate ?? 0}, volume=${tuning.volume ?? 0})`
    : '';
  logger.server.log(`[TTS] Generating audio with voice ${selectedVoice}${tuningLog}: ${cleanedText.substring(0, 50)}...`);

  const modelPath = path.join(resolveVoicesDir(), `${selectedVoice}.onnx`);

  if (!fs.existsSync(modelPath)) {
    logger.server.error(`[TTS] Voice model not found: ${modelPath}`);
    logVoiceTts({
      voice: selectedVoice, textChars: cleanedText.length,
      durationMs: Date.now() - startedAt, ok: false, error: 'model-not-found',
    });
    res.status(500).json({ error: 'TTS voice model not installed' });
    return;
  }

  const piperBin = resolvePiperBin();
  logger.server.log(`[TTS] Using piper binary: ${piperBin}`);

  try {
    // Generate WAV audio using piper.
    //
    // Write to a temp file rather than stdout: piper's Windows build writes
    // stdout in text mode, turning every 0x0a byte into 0x0d 0x0a. That
    // shifts the PCM data and the WAV plays back as pure static.
    const tmpFile = path.join(os.tmpdir(), `tide-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);

    const audioData = await new Promise<Buffer>((resolve, reject) => {
      const cleanup = () => {
        try {
          fs.unlinkSync(tmpFile);
        } catch {
          // best effort - file may not exist if spawn failed
        }
      };

      const piper = spawn(piperBin, buildPiperArgs(modelPath, tmpFile, tuning), { windowsHide: true });

      piper.stderr.on('data', (data: Buffer) => {
        // Piper outputs progress to stderr, ignore it
        const msg = data.toString();
        if (msg.includes('Error') || msg.includes('error')) {
          logger.server.error(`[TTS] Piper stderr: ${msg}`);
        }
      });

      piper.on('error', (err) => {
        cleanup();
        reject(new Error(`Piper spawn error: ${err.message}`));
      });

      piper.on('close', (code) => {
        if (code === 0) {
          try {
            const wav = fs.readFileSync(tmpFile);
            cleanup();
            resolve(wav);
          } catch (err) {
            cleanup();
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        } else {
          cleanup();
          reject(new Error(`Piper exited with code ${code}`));
        }
      });

      // Send text to piper
      if (piper.stdin) {
        piper.stdin.write(cleanedText);
        piper.stdin.end();
      }
    });

    // Send audio back to browser(W1:垫片默认直返 mp3,按魔数判 Content-Type;
    // EDGE_TTS_MP3=0 回退 wav——播放端 res.blob() 继承响应头,零改动)
    logVoiceTts({
      voice: selectedVoice, textChars: cleanedText.length,
      durationMs: Date.now() - startedAt, audioBytes: audioData.length, ok: true,
    });
    res.setHeader('Content-Type', detectAudioMime(audioData));
    res.setHeader('Content-Length', audioData.length);
    res.send(audioData);

  } catch (err) {
    logger.server.error(`[TTS] Error generating audio: ${err}`);
    logVoiceTts({
      voice: selectedVoice, textChars: cleanedText.length,
      durationMs: Date.now() - startedAt, ok: false, error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Failed to generate audio' });
  }
});

export default router;
