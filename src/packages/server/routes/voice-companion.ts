/**
 * Voice Companion Route
 *
 * 「语音伙伴」服务端接口(统一语音入口;旧 /api/voice-assistant 路由已移除):
 *
 *   POST /api/voice-companion/process  { text, event? }  处理一段文本(语音转写或系统事件;
 *                                          系统事件经活动监视器闸口——任务33)
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
  VoiceCompanionAbortedError,
  type VoiceMemoryOp,
} from '../services/voice-companion-service.js';
import { evaluateVoiceEventGate, logSuppressedVoiceEvent } from '../services/sentinel-service.js';
import { initNdjson, writeNdjsonLine, endNdjson } from '../voice/ndjson.js';
import { logger } from '../utils/index.js';

const router = Router();

const MAX_TEXT_LENGTH = 4_000;

/**
 * 稳定错误码(P8):客户端按 code 做中文映射;error 保留英文原文兼容旧客户端。
 *   400 TEXT_REQUIRED / TEXT_TOO_LONG / OPS_NOT_ARRAY
 *   500 CLAUDE_NOT_FOUND / PROCESS_FAILED / INTERNAL
 */
const ERROR_CODE = {
  TEXT_REQUIRED: 'TEXT_REQUIRED',
  TEXT_TOO_LONG: 'TEXT_TOO_LONG',
  OPS_NOT_ARRAY: 'OPS_NOT_ARRAY',
  CLAUDE_NOT_FOUND: 'CLAUDE_NOT_FOUND',
  PROCESS_FAILED: 'PROCESS_FAILED',
  INTERNAL: 'INTERNAL',
} as const;

/**
 * 分句流式分支(body.stream === true):NDJSON 逐行下推。
 *   {"type":"sentence","text":"…"}   模型边生成边播的整句(可能 0..n 行)
 *   {"type":"final","result":{…},"spoke":bool}  最终结果;spoke=false 时客户端
 *                                     应按 result.response 整段补播
 *   {"type":"error","error":"…","code":"…","details":"…"}  失败
 * 客户端断开即 abort:kill claude 子进程,释放互斥队列。
 */
async function handleStreamProcess(res: Response, text: string, isEvent: boolean): Promise<void> {
  initNdjson(res);
  const startedAt = Date.now();

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const result = await processVoiceInput(text, {
      isEvent,
      signal: controller.signal,
      onSentence: (sentence) => {
        // tMs = 该句自请求受理起的服务端毫秒数(P5 延迟打点:配合客户端到达
        // 时间戳可拆分「服务端生成」与「网络+客户端」两段)。
        writeNdjsonLine(res, { type: 'sentence', text: sentence, tMs: Date.now() - startedAt });
      },
    });
    writeNdjsonLine(res, { type: 'final', result: { success: true, ...result }, spoke: !!result.spoke });
    endNdjson(res);
  } catch (err) {
    if (err instanceof VoiceCompanionAbortedError) {
      endNdjson(res); // 客户端已断开:静默收尾,不写不记
      return;
    }
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      logger.server.error(`[VoiceCompanion] Claude 可执行文件未找到: ${e.message}`);
      writeNdjsonLine(res, { type: 'error', error: 'Claude CLI not found', code: ERROR_CODE.CLAUDE_NOT_FOUND, details: e.message });
    } else {
      logger.server.error(`[VoiceCompanion] Error: ${(err as Error)?.message}`);
      writeNdjsonLine(res, { type: 'error', error: 'Failed to process', code: ERROR_CODE.PROCESS_FAILED, details: (err as Error)?.message });
    }
    endNdjson(res);
  }
}

/**
 * POST /api/voice-companion/process  { text, event?, stream? }
 */
router.post('/process', async (req: Request, res: Response) => {
  const { text, event, stream } = req.body ?? {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Text is required', code: ERROR_CODE.TEXT_REQUIRED });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return res.status(400).json({ error: 'Text too long', code: ERROR_CODE.TEXT_TOO_LONG });
  }

  logger.server.log(`[VoiceCompanion] Processing${event ? ' (event)' : ''}${stream ? ' (stream)' : ''}: "${text.slice(0, 120)}"`);

  // 任务33 事件闸口 v1(活动监视器降级指令落地;只拦 event=true,老板说话永不过闸):
  //   store-only(degraded 相位)→ 抑制不出声;throttle(warning/recovering)→ 确定性降频。
  // 抑制=落 dialog 日志(degraded 标记)+ 返回与 noop 同形应答(客户端本就按 noop 静默,
  // 零 client 改动);闸口自身异常 fail-open(见 sentinel-service)。
  if (event === true) {
    const gate = evaluateVoiceEventGate(text.trim());
    if (gate.decision !== 'pass') {
      logSuppressedVoiceEvent(text.trim(), gate);
      logger.server.log(
        `[VoiceCompanion] 事件闸口抑制(${gate.decision}${gate.directive ? `,phase=${gate.directive.phase}` : ''}): "${text.slice(0, 120)}"`,
      );
      const noopResult = { success: true, action: 'noop' as const, response: '', elapsedMs: 0 };
      if (stream === true) {
        initNdjson(res);
        writeNdjsonLine(res, { type: 'final', result: noopResult, spoke: false });
        endNdjson(res);
        return;
      }
      return res.json(noopResult);
    }
  }

  if (stream === true) {
    return handleStreamProcess(res, text.trim(), !!event);
  }

  try {
    const result = await processVoiceInput(text.trim(), { isEvent: !!event });
    return res.json({ success: true, ...result });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      logger.server.error(`[VoiceCompanion] Claude 可执行文件未找到: ${e.message}`);
      return res.status(500).json({ error: 'Claude CLI not found', code: ERROR_CODE.CLAUDE_NOT_FOUND, details: e.message });
    }
    logger.server.error(`[VoiceCompanion] Error: ${(err as Error)?.message}`);
    return res.status(500).json({ error: 'Failed to process', code: ERROR_CODE.PROCESS_FAILED, details: (err as Error)?.message });
  }
});

/**
 * GET /api/voice-companion/status
 */
router.get('/status', (_req: Request, res: Response) => {
  try {
    res.json({ available: true, ...getCompanionStatus() });
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message, code: ERROR_CODE.INTERNAL });
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
    res.status(500).json({ error: (err as Error)?.message, code: ERROR_CODE.INTERNAL });
  }
});

/**
 * GET /api/voice-companion/memory
 */
router.get('/memory', (_req: Request, res: Response) => {
  try {
    res.json({ success: true, memory: getCompanionMemory() });
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message, code: ERROR_CODE.INTERNAL });
  }
});

/**
 * POST /api/voice-companion/memory  { ops?: [...], clear?: boolean }
 */
router.post('/memory', (req: Request, res: Response) => {
  try {
    const { ops, clear } = req.body ?? {};
    if (ops !== undefined && !Array.isArray(ops)) {
      return res.status(400).json({ error: 'ops must be an array', code: ERROR_CODE.OPS_NOT_ARRAY });
    }
    const memory = updateCompanionMemory({
      ops: ops as VoiceMemoryOp[] | undefined,
      clear: clear === true,
    });
    res.json({ success: true, memory });
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message, code: ERROR_CODE.INTERNAL });
  }
});

export default router;
