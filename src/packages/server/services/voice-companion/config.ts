/**
 * 语音伙伴服务 — config.json 读取(2026-10-11 自 voice-companion-service.ts 拆分,行为不变)。
 * 读 tools/voice-companion/config.json 的 brain.* 与 stt.volcengine 节;缺失一律回默认。
 */
import fs from 'fs';
import { logger } from '../../utils/index.js';
import { sanitizePersonaCustom, sanitizePersonaId } from '../../../shared/voice-personas.js';
import { CONFIG_FILE, DEFAULT_SERVER_CONFIG } from './constants.js';
import type { SlowFillerTiming, VoiceCompanionServerConfig } from './types.js';

const log = logger.server;

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 小数版钳制(任务18:压缩阈值 0-1 不能被 Math.round 取整)。 */
function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** W5:垫话参数解析(brain.slowFiller;env TC_VOICE_SLOW_FILLER=0 为硬回退开关)。 */
function slowFillerConfigFrom(brain: Record<string, unknown> | undefined): SlowFillerTiming {
  const sf = brain?.slowFiller as Record<string, unknown> | undefined;
  const envOff = process.env.TC_VOICE_SLOW_FILLER === '0';
  return {
    enabled: !envOff && sf?.enabled !== false,
    armMs: clampNumber(sf?.armMs, 500, 10_000, DEFAULT_SERVER_CONFIG.slowFiller.armMs),
    emitMs: clampNumber(sf?.emitMs, 1_000, 30_000, DEFAULT_SERVER_CONFIG.slowFiller.emitMs),
    pregenEmitMs: clampNumber(sf?.pregenEmitMs, 300, 10_000, DEFAULT_SERVER_CONFIG.slowFiller.pregenEmitMs),
  };
}

/** 读取 tools/voice-companion/config.json(服务端只关心 model / persona / brain.*);缺失回默认。 */
export function loadServerConfig(): VoiceCompanionServerConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return {
        ...DEFAULT_SERVER_CONFIG,
        persona: { ...DEFAULT_SERVER_CONFIG.persona },
        slowFiller: slowFillerConfigFrom(undefined),
      };
    }
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    const brain = raw?.brain ?? {};
    return {
      model: raw?.model === 'sonnet' ? 'sonnet' : 'haiku',
      persona: {
        preset: sanitizePersonaId(raw?.persona?.preset),
        custom: sanitizePersonaCustom(raw?.persona?.custom),
      },
      hop1TimeoutMs: clampNumber(brain.hop1TimeoutMs, 5_000, 180_000, DEFAULT_SERVER_CONFIG.hop1TimeoutMs),
      hop2TimeoutMs: clampNumber(brain.hop2TimeoutMs, 5_000, 180_000, DEFAULT_SERVER_CONFIG.hop2TimeoutMs),
      maxTurns: clampNumber(brain.maxTurns, 10, 2_000, DEFAULT_SERVER_CONFIG.maxTurns),
      sessionMaxAgeDays: clampNumber(brain.sessionMaxAgeDays, 1, 365, DEFAULT_SERVER_CONFIG.sessionMaxAgeDays),
      maxNotes: clampNumber(brain.maxNotes, 5, 200, DEFAULT_SERVER_CONFIG.maxNotes),
      // 任务18:可配置压缩阈值/窗口;任务39:百分比缺省 0.3、下限放宽到 0.1(上限原样),
      // 并新增绝对 token 闸口(0 = 关;上限 1M 与窗口上限对齐)。
      contextCompactPercent: clampFloat(brain.contextCompactPercent, 0.1, 0.95, DEFAULT_SERVER_CONFIG.contextCompactPercent),
      contextWindowTokens: clampNumber(brain.contextWindowTokens, 50_000, 1_000_000, DEFAULT_SERVER_CONFIG.contextWindowTokens),
      contextCompactTokens: clampNumber(brain.contextCompactTokens, 0, 1_000_000, DEFAULT_SERVER_CONFIG.contextCompactTokens),
      firstSentenceMaxChars: clampNumber(brain.firstSentenceMaxChars, 0, 60, DEFAULT_SERVER_CONFIG.firstSentenceMaxChars),
      slowFiller: slowFillerConfigFrom(brain),
    };
  } catch (err) {
    log.warn(`[VoiceCompanion] config.json 读取失败,用默认配置: ${(err as Error).message}`);
    return {
      ...DEFAULT_SERVER_CONFIG,
      persona: { ...DEFAULT_SERVER_CONFIG.persona },
      slowFiller: slowFillerConfigFrom(undefined),
    };
  }
}

// ----------------------------------------------------------------------------
// 流式转写(火山引擎)凭据 —— 与上同文件(config.json 的 stt.volcengine 节)
// ----------------------------------------------------------------------------

export type VolcengineEndpoint = 'bigmodel_async' | 'bigmodel' | 'bigmodel_nostream';

export interface VolcengineSttConfig {
  /** 新版控制台 ApiKey(优先);为空则用旧版 appId + accessToken。 */
  apiKey: string;
  appId: string;
  accessToken: string;
  resourceId: string;
  endpoint: VolcengineEndpoint;
}

export const DEFAULT_VOLCENGINE_STT_CONFIG: VolcengineSttConfig = {
  apiKey: '',
  appId: '',
  accessToken: '',
  resourceId: 'volc.bigasr.sauc.duration',
  endpoint: 'bigmodel_async',
};

const VOLC_ENDPOINTS: VolcengineEndpoint[] = ['bigmodel_async', 'bigmodel', 'bigmodel_nostream'];
const CREDENTIAL_MAX_CHARS = 512;

/** 凭据字符串清洗:去空白、限长;绝不写日志。 */
function sanitizeCredential(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, CREDENTIAL_MAX_CHARS) : '';
}

/** 读取 config.json 的 stt.volcengine 节;缺失回默认(空凭据 = 客户端走批量回退)。 */
export function loadVolcengineSttConfig(): VolcengineSttConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_VOLCENGINE_STT_CONFIG };
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    const volc = raw?.stt?.volcengine ?? {};
    const endpoint = VOLC_ENDPOINTS.includes(volc?.endpoint)
      ? (volc.endpoint as VolcengineEndpoint)
      : DEFAULT_VOLCENGINE_STT_CONFIG.endpoint;
    return {
      apiKey: sanitizeCredential(volc?.apiKey),
      appId: sanitizeCredential(volc?.appId),
      accessToken: sanitizeCredential(volc?.accessToken),
      // 显式留空 = 握手时不发送 X-Api-Resource-Id(平台预置模型);未配置才回默认
      resourceId: typeof volc?.resourceId === 'string'
        ? sanitizeCredential(volc.resourceId)
        : DEFAULT_VOLCENGINE_STT_CONFIG.resourceId,
      endpoint,
    };
  } catch (err) {
    log.warn(`[VoiceCompanion] 读取火山凭据失败,视为未配置: ${(err as Error).message}`);
    return { ...DEFAULT_VOLCENGINE_STT_CONFIG };
  }
}
