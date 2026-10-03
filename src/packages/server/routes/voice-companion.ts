/**
 * Voice Companion Route
 *
 * 「语音伙伴」服务端接口(与作者既有的 /api/voice-assistant 并行,互不影响):
 *
 *   POST /api/voice-companion/process  { text, event? }  处理一段文本(语音转写或系统事件)
 *   GET  /api/voice-companion/status                     会话/记忆状态
 *   POST /api/voice-companion/reset    { keepMemory? }   重置会话(默认保留记忆)
 *   GET  /api/voice-companion/memory                     读取记忆
 *   POST /api/voice-companion/memory   { ops? , clear? } 修改记忆(单条删除/清空)
 *
 * 逻辑全部在 voice-companion-service;本文件只做参数校验与错误映射。
 */

import { Router, Request, Response } from 'express';
import {
  processVoiceInput,
  getCompanionStatus,
  resetCompanion,
  getCompanionMemory,
  updateCompanionMemory,
  type VoiceMemoryOp,
} from '../services/voice-companion-service.js';
import { logger } from '../utils/index.js';

const router = Router();

const MAX_TEXT_LENGTH = 4_000;

/**
 * POST /api/voice-companion/process
 */
router.post('/process', async (req: Request, res: Response) => {
  const { text, event } = req.body ?? {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Text is required' });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return res.status(400).json({ error: 'Text too long' });
  }

  logger.server.log(`[VoiceCompanion] Processing${event ? ' (event)' : ''}: "${text.slice(0, 120)}"`);

  try {
    const result = await processVoiceInput(text.trim(), { isEvent: !!event });
    return res.json({ success: true, ...result });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      logger.server.error(`[VoiceCompanion] Claude 可执行文件未找到: ${e.message}`);
      return res.status(500).json({ error: 'Claude CLI not found', details: e.message });
    }
    logger.server.error(`[VoiceCompanion] Error: ${(err as Error)?.message}`);
    return res.status(500).json({ error: 'Failed to process', details: (err as Error)?.message });
  }
});

/**
 * GET /api/voice-companion/status
 */
router.get('/status', (_req: Request, res: Response) => {
  try {
    res.json({ available: true, ...getCompanionStatus() });
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message });
  }
});

/**
 * POST /api/voice-companion/reset
 */
router.post('/reset', (req: Request, res: Response) => {
  try {
    const keepMemory = req.body?.keepMemory !== false; // 默认保留记忆
    resetCompanion({ keepMemory });
    res.json({ success: true, keepMemory });
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message });
  }
});

/**
 * GET /api/voice-companion/memory
 */
router.get('/memory', (_req: Request, res: Response) => {
  try {
    res.json({ success: true, memory: getCompanionMemory() });
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message });
  }
});

/**
 * POST /api/voice-companion/memory  { ops?: [...], clear?: boolean }
 */
router.post('/memory', (req: Request, res: Response) => {
  try {
    const { ops, clear } = req.body ?? {};
    if (ops !== undefined && !Array.isArray(ops)) {
      return res.status(400).json({ error: 'ops must be an array' });
    }
    const memory = updateCompanionMemory({
      ops: ops as VoiceMemoryOp[] | undefined,
      clear: clear === true,
    });
    res.json({ success: true, memory });
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message });
  }
});

export default router;
