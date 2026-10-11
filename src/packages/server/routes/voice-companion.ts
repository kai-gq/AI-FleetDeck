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
 *   GET  /api/voice-companion/hotwords                   ASR 热词快照(面板展示)
 *   POST /api/voice-companion/hotwords/refresh           智能更新(增量读对话 → 筛选 → 合并)
 *   POST /api/voice-companion/hotwords/add    { word }   手动添加
 *   POST /api/voice-companion/hotwords/remove { word }   删除(= 拉黑,管家今后不再收录)
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
  callClaudeForHotwordCurator,
  VoiceCompanionAbortedError,
  type VoiceMemoryOp,
} from '../services/voice-companion-service.js';
import {
  AGENT_NAME_WEIGHT,
  addManualWord,
  buildEffectiveWords,
  getAgentNames,
  pickInjectionWords,
  readHotwordsFile,
  removeWord,
  resolveInjectTopN,
  writeHotwordsFile,
  type InjectionWord,
  type WordSource,
} from '../voice/asr-hotwords.js';
import { createAgentHotwordSync } from '../voice/agent-hotword-sync.js';
import { getAllAgents, subscribe as subscribeAgents } from '../services/agent-service.js';
import { refreshHotwords } from '../voice/hotword-curator.js';
import { evaluateVoiceEventGate, logSuppressedVoiceEvent } from '../services/sentinel-service.js';
import { buildReminderCancelSay, matchReminderCommand } from '../voice/reminder-parse.js';
import {
  buildReminderCapSay,
  buildReminderListSay,
  getVoiceReminderService,
  isVoiceReminderEnabled,
  toDuePayload,
} from '../services/voice-reminder-service.js';
import { initNdjson, writeNdjsonLine, endNdjson } from '../voice/ndjson.js';
import { noteUserActivity } from '../services/user-activity-service.js';
// W13：PREPARE 攒批开口点 flush（用户刚开口 = 最强自然开口点；fire-and-forget，永不上抛）
import { flushPreparedAtOpeningPoint } from '../jarvis-core/prepare-flush.js';
import { logger } from '../utils/index.js';

const router = Router();

const MAX_TEXT_LENGTH = 4_000;

/**
 * 稳定错误码(P8):客户端按 code 做中文映射;error 保留英文原文兼容旧客户端。
 *   400 TEXT_REQUIRED / TEXT_TOO_LONG / OPS_NOT_ARRAY / ID_REQUIRED / WORD_REQUIRED / SINCE_INVALID
 *   500 CLAUDE_NOT_FOUND / PROCESS_FAILED / INTERNAL
 */
const ERROR_CODE = {
  TEXT_REQUIRED: 'TEXT_REQUIRED',
  TEXT_TOO_LONG: 'TEXT_TOO_LONG',
  OPS_NOT_ARRAY: 'OPS_NOT_ARRAY',
  ID_REQUIRED: 'ID_REQUIRED',
  WORD_REQUIRED: 'WORD_REQUIRED',
  SINCE_INVALID: 'SINCE_INVALID',
  CLAUDE_NOT_FOUND: 'CLAUDE_NOT_FOUND',
  PROCESS_FAILED: 'PROCESS_FAILED',
  INTERNAL: 'INTERNAL',
} as const;

/**
 * 分句流式分支(body.stream === true):NDJSON 逐行下推。
 *   {"type":"sentence","text":"…","pre"?:true}  模型边生成边播的整句(可能 0..n 行);
 *                                     pre=true 的过渡/垫话句照播但不参与客户端最终对账
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

  let firstSentenceLogged = false;
  try {
    const result = await processVoiceInput(text, {
      isEvent,
      signal: controller.signal,
      onSentence: (sentence, meta) => {
        // tMs = 该句自请求受理起的服务端毫秒数(P5 延迟打点:配合客户端到达
        // 时间戳可拆分「服务端生成」与「网络+客户端」两段)。
        const tMs = Date.now() - startedAt;
        if (!firstSentenceLogged) {
          // W6 感知提速观测:首句到达打点(与同刻客户端锚点对表用)。
          firstSentenceLogged = true;
          logger.server.log(`[VoiceCompanion] 首句 tMs=${tMs} chars=${Array.from(sentence).length}${meta?.pre ? ' pre' : ''}`);
        }
        writeNdjsonLine(res, { type: 'sentence', text: sentence, tMs, ...(meta?.pre ? { pre: true } : {}) });
      },
    });
    if (!firstSentenceLogged) {
      logger.server.log(`[VoiceCompanion] 首句 无(未流式/整段补播) tMs=${Date.now() - startedAt} spoke=${!!result.spoke}`);
    }
    writeNdjsonLine(res, { type: 'final', result: { success: true, ...result }, spoke: !!result.spoke });
    endNdjson(res);
    // W13 用户活动账:用户说话成功完成(最终结果已写出)后登记;事件回合不登记
    if (!isEvent) {
      noteUserActivity('voice-turn');
      void flushPreparedAtOpeningPoint('user_turn_stream');
    }
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
 * 分钟级提醒确定性快通道(pre-hop1,毫秒应答;2026-10-05 事故修复):
 *   「N分钟后叫我」→ 秒回回执 + 服务端定时器(voice-reminder-service),
 *   到点走 WS 推送/轮询兜底 —— 不再依赖 hop1(实测 42s)也不落天级 bolba 板。
 * 只在老板说话(event 非系统事件)且开关(TC_VOICE_REMINDER)开启时生效;
 * 解析不命中 → 返回 false,走原链路(宁缺毋滥)。
 * 应答帧与事件闸口同形:sentence(回执)+ final(response=回执, spoke=true →
 * 客户端已随 sentence 播过、对账相等不会再补播)。
 */
function tryHandleReminderCommand(text: string, stream: boolean, res: Response): boolean {
  if (!isVoiceReminderEnabled()) return false;
  let command;
  try {
    command = matchReminderCommand(text);
  } catch (err) {
    // 纯函数理论上不抛;万一抛 = fail-open 走原链路,绝不因提醒通道阻断对话
    logger.server.warn(`[VoiceCompanion] 提醒解析异常(fail-open): ${(err as Error)?.message}`);
    return false;
  }
  if (!command) return false;

  const reminderService = getVoiceReminderService();
  let say: string;
  if (command.op === 'create') {
    const registered = reminderService.register(command, text);
    say = registered.ok ? command.say : buildReminderCapSay();
  } else if (command.op === 'cancel') {
    say = buildReminderCancelSay(reminderService.cancelActive());
  } else {
    say = buildReminderListSay(reminderService.listActive(), Date.now());
  }

  logger.server.log(`[VoiceCompanion] 提醒快通道 ${command.op}: "${say}"`);
  const result = { success: true, action: 'noop' as const, response: say, elapsedMs: 0 };
  // W13 用户活动账:快通道命中 = 用户回合成功(此分支必然返回 true),登记 voice-turn
  noteUserActivity('voice-turn');
  void flushPreparedAtOpeningPoint('user_turn_reminder');
  if (stream) {
    initNdjson(res);
    writeNdjsonLine(res, { type: 'sentence', text: say, tMs: 0 });
    writeNdjsonLine(res, { type: 'final', result, spoke: true });
    endNdjson(res);
    return true;
  }
  res.json({ ...result, spoke: true });
  return true;
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

  // 分钟级提醒快通道(确定性,pre-hop1;只拦老板说话,事件回合不注册提醒)
  if (event !== true && tryHandleReminderCommand(text.trim(), stream === true, res)) {
    return;
  }

  if (stream === true) {
    return handleStreamProcess(res, text.trim(), !!event);
  }

  try {
    const result = await processVoiceInput(text.trim(), { isEvent: !!event });
    // W13 用户活动账:用户说话成功完成后登记(event === true 为系统事件,不登记)
    if (event !== true) {
      noteUserActivity('voice-turn');
      void flushPreparedAtOpeningPoint('user_turn');
    }
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

/**
 * GET /api/voice-companion/reminders/due
 * 轮询兜底:待播(due)提醒(WS 推送为主通道;页面重开/断线/后台节流由此补)。
 */
router.get('/reminders/due', (_req: Request, res: Response) => {
  try {
    if (!isVoiceReminderEnabled()) {
      return res.json({ success: true, reminders: [] });
    }
    const reminders = getVoiceReminderService().listDue().map(toDuePayload);
    res.json({ success: true, reminders });
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message, code: ERROR_CODE.INTERNAL });
  }
});

/**
 * POST /api/voice-companion/reminders/ack  { id }
 * 播报完成回执(due → done;幂等,客户端崩溃未 ack → 仍 due,下回进页补播)。
 */
router.post('/reminders/ack', (req: Request, res: Response) => {
  try {
    const { id } = req.body ?? {};
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'id is required', code: ERROR_CODE.ID_REQUIRED });
    }
    const acked = getVoiceReminderService().ack(id);
    res.json({ success: true, acked });
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message, code: ERROR_CODE.INTERNAL });
  }
});

// ============================================================================
// ASR 热词(asr-hotwords / hotword-curator)
// ============================================================================

// agent 名 ↔ 热词同步:agent 新增/改名立即进有效词表(provider 实时读),
// 改名旧名/删除名 → 退役(移出池 + 拉黑)。订阅 agent CRUD 事件,零改动 agent-service。
createAgentHotwordSync({
  getAll: () => getAllAgents().map((a) => ({ id: a.id, name: a.name })),
  subscribe: (listener) => subscribeAgents((event, data) => listener(event, data)),
  log: (msg) => logger.server.log(`[hotwords] ${msg}`),
}).init();

interface HotwordSnapshotEntry {
  word: string;
  weight: number;
  count: number;
  source: WordSource;
  lastSeenAt: string;
  /** 是否在当前注入窗口内(有效词表按注入优先级排序取前 injectTopN)。 */
  injected: boolean;
}

function toEntry(w: InjectionWord, injectedKeys: ReadonlySet<string>): HotwordSnapshotEntry {
  return {
    word: w.word,
    weight: w.weight,
    count: w.count,
    source: w.source,
    lastSeenAt: w.lastSeenAt,
    injected: injectedKeys.has(w.word.toLowerCase()),
  };
}

/** 锁定词集(agent 名,忽略大小写):面板不可删改、手动添加直接判重;必进注入窗口。 */
function lockedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const n of getAgentNames()) keys.add(n.toLowerCase());
  return keys;
}

/**
 * 面板快照(分子表展示):
 *   agentNames agent 名(锁定;实时来自 agent-service;必进注入窗口)
 *   words      动态池(manual/agent;按注入优先级排序,可删)
 * injected 以「有效词表 + 注入窗口」统一计算(锁定层占窗口,动态词未必全进)。
 */
function hotwordsSnapshot() {
  const { file } = readHotwordsFile();
  const topN = resolveInjectTopN();
  const effective = buildEffectiveWords(file);
  const order = new Map(
    pickInjectionWords(effective, effective.length).map((w, i) => [w.toLowerCase(), i] as const),
  );
  const injectedKeys = new Set(
    pickInjectionWords(effective, topN).map((w) => w.toLowerCase()),
  );
  const rankOf = (w: string): number => order.get(w.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;

  const agentNames = getAgentNames().map((name) => ({
    word: name,
    weight: AGENT_NAME_WEIGHT,
    count: 0,
    source: 'agent-name' as const,
    lastSeenAt: '',
    injected: injectedKeys.has(name.toLowerCase()),
  }));
  const words = [...file.words]
    .sort((a, b) => rankOf(a.word) - rankOf(b.word))
    .map((e) => toEntry({ ...e, source: e.source }, injectedKeys));

  return {
    lastAnalyzedAt: file.lastAnalyzedAt,
    blockedCount: file.blocked.length,
    injectTopN: topN,
    agentNames,
    words,
  };
}

/**
 * GET /api/voice-companion/hotwords
 * 热词快照(面板展示;文件缺失/损坏 → 空表)。
 */
router.get('/hotwords', (_req: Request, res: Response) => {
  try {
    res.json({ success: true, hotwords: hotwordsSnapshot() });
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message, code: ERROR_CODE.INTERNAL });
  }
});

/**
 * POST /api/voice-companion/hotwords/refresh  { since? }
 * 「智能更新」:增量读大脑对话 → 提示词筛选 → 硬校验 → 合并入库(同步等待 10~30s)。
 * since(可选,ISO)覆写分析起点(面板「上次分析时间」可改选);缺省 = 节点/首次回看 7 天。
 */
router.post('/hotwords/refresh', async (req: Request, res: Response) => {
  try {
    const sinceRaw = typeof req.body?.since === 'string' ? req.body.since.trim() : '';
    let sinceMs: number | undefined;
    if (sinceRaw) {
      const parsed = Date.parse(sinceRaw);
      if (!Number.isFinite(parsed)) {
        return res.status(400).json({ error: 'since must be an ISO date string', code: ERROR_CODE.SINCE_INVALID });
      }
      sinceMs = parsed;
    }
    const result = await refreshHotwords({
      callModel: callClaudeForHotwordCurator,
      sinceMs,
      log: (msg) => logger.server.log(`[hotwords] ${msg}`),
    });
    res.json({ success: true, result, hotwords: hotwordsSnapshot() });
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message, code: ERROR_CODE.INTERNAL });
  }
});

/**
 * POST /api/voice-companion/hotwords/add  { word }
 * 手动添加(manual:权重免疫、淘汰最后、注入窗口内优先;命中屏蔽名单则解除)。
 * 锁定词(内置/agent 名)已在窗口中 → added=false 且 locked=true(不落池)。
 */
router.post('/hotwords/add', (req: Request, res: Response) => {
  try {
    const word = typeof req.body?.word === 'string' ? req.body.word.trim() : '';
    if (!word || word.length > 40 || /\s/.test(word)) {
      return res.status(400).json({ error: 'word is required (no spaces, max 40 chars)', code: ERROR_CODE.WORD_REQUIRED });
    }
    if (lockedKeys().has(word.toLowerCase())) {
      return res.json({ success: true, added: false, locked: true, hotwords: hotwordsSnapshot() });
    }
    const { file } = readHotwordsFile();
    const added = addManualWord(file, word, new Date().toISOString());
    if (added) writeHotwordsFile(file);
    res.json({ success: true, added, hotwords: hotwordsSnapshot() });
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message, code: ERROR_CODE.INTERNAL });
  }
});

/**
 * POST /api/voice-companion/hotwords/remove  { word }
 * 删除 = 移出词表 + 屏蔽(管家今后提出即丢弃,不会「删了又回来」)。
 * 锁定词(内置/agent 名)拒绝删除(removed=false 且 locked=true;也不拉黑)。
 */
router.post('/hotwords/remove', (req: Request, res: Response) => {
  try {
    const word = typeof req.body?.word === 'string' ? req.body.word.trim() : '';
    if (!word) {
      return res.status(400).json({ error: 'word is required', code: ERROR_CODE.WORD_REQUIRED });
    }
    if (lockedKeys().has(word.toLowerCase())) {
      return res.json({ success: true, removed: false, locked: true, hotwords: hotwordsSnapshot() });
    }
    const { file } = readHotwordsFile();
    const removed = removeWord(file, word);
    if (removed) writeHotwordsFile(file);
    res.json({ success: true, removed, hotwords: hotwordsSnapshot() });
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message, code: ERROR_CODE.INTERNAL });
  }
});

export default router;
