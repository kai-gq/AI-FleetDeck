/**
 * Voiceprint Route — 声纹门禁页面设置(工具箱 → 语音伙伴)
 *
 * 挂载:/api/voice-companion/voiceprint(routes/index.ts)
 *   GET  /status              本地配置 + 端点/凭据支持性
 *   POST /toggle  { enabled }  开关(未注册不给开)
 *   POST /enroll  { audioBase64, speakerName? }  录音注册(16k WAV base64)
 *   POST /delete              删除(云端尽力软删 + 本地必清)
 *
 * 逻辑全部在 voice/voiceprint-enroll-service;本文件只做参数校验与错误映射。
 * 隐私约束:日志绝不落 apiKey;服务层只落采样 URL。
 */

import { Router, Request, Response } from 'express';
import {
  getVoiceprintStatus,
  setVoiceprintEnabled,
  enrollVoiceprint,
  deleteVoiceprint,
  VoiceprintEnrollError,
  MAX_BASE64_CHARS,
  type VoiceprintEnrollErrorCode,
} from '../voice/voiceprint-enroll-service.js';
import { logger } from '../utils/index.js';

const router = Router();

/**
 * 稳定错误码(客户端按 code 展示;error 为中文可读信息):
 *   400 AUDIO_REQUIRED / AUDIO_TOO_LARGE / AUDIO_INVALID / NOT_CONFIGURED / NOT_REGISTERED / ENABLED_INVALID
 *   502 UPLOAD_FAILED / REGISTER_FAILED
 *   500 INTERNAL
 */
const ERROR_CODE = {
  AUDIO_REQUIRED: 'AUDIO_REQUIRED',
  AUDIO_TOO_LARGE: 'AUDIO_TOO_LARGE',
  AUDIO_INVALID: 'AUDIO_INVALID',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  NOT_REGISTERED: 'NOT_REGISTERED',
  ENABLED_INVALID: 'ENABLED_INVALID',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  REGISTER_FAILED: 'REGISTER_FAILED',
  INTERNAL: 'INTERNAL',
} as const;

const STATUS_BY_CODE: Record<VoiceprintEnrollErrorCode, number> = {
  AUDIO_REQUIRED: 400,
  AUDIO_TOO_LARGE: 400,
  AUDIO_INVALID: 400,
  NOT_CONFIGURED: 400,
  NOT_REGISTERED: 400,
  UPLOAD_FAILED: 502,
  REGISTER_FAILED: 502,
};

function fail(res: Response, err: unknown): Response {
  if (err instanceof VoiceprintEnrollError) {
    return res.status(STATUS_BY_CODE[err.code] ?? 400).json({ error: err.message, code: err.code });
  }
  logger.server.error(`[Voiceprint] 未预期错误:${(err as Error)?.message}`);
  return res.status(500).json({
    error: 'Voiceprint operation failed',
    code: ERROR_CODE.INTERNAL,
    details: (err as Error)?.message,
  });
}

/** GET /api/voice-companion/voiceprint/status */
router.get('/status', (_req: Request, res: Response) => {
  try {
    res.json({ success: true, status: getVoiceprintStatus() });
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/voice-companion/voiceprint/toggle  { enabled } */
router.post('/toggle', (req: Request, res: Response) => {
  try {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean', code: ERROR_CODE.ENABLED_INVALID });
    }
    res.json({ success: true, status: setVoiceprintEnabled(enabled) });
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/voice-companion/voiceprint/enroll  { audioBase64, speakerName? } */
router.post('/enroll', async (req: Request, res: Response) => {
  try {
    const { audioBase64, speakerName } = req.body ?? {};
    if (typeof audioBase64 !== 'string' || !audioBase64.trim()) {
      return res.status(400).json({ error: '缺少录音数据', code: ERROR_CODE.AUDIO_REQUIRED });
    }
    if (audioBase64.length > MAX_BASE64_CHARS) {
      return res.status(400).json({ error: '录音数据过大', code: ERROR_CODE.AUDIO_TOO_LARGE });
    }
    const result = await enrollVoiceprint({
      audioBase64,
      speakerName: typeof speakerName === 'string' ? speakerName : undefined,
    });
    res.json({ success: true, speakId: result.speakId, status: result.status });
  } catch (err) {
    fail(res, err);
  }
});

/** POST /api/voice-companion/voiceprint/delete */
router.post('/delete', async (_req: Request, res: Response) => {
  try {
    const result = await deleteVoiceprint();
    res.json({
      success: true,
      status: result.status,
      cloudDeleted: result.cloudDeleted,
      cloudError: result.cloudError,
    });
  } catch (err) {
    fail(res, err);
  }
});

export default router;
