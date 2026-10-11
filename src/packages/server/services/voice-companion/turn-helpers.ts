/**
 * 语音伙伴服务 — 回合外辅助接线(2026-10-11 自 voice-companion-service.ts 拆分,行为不变)。
 * 任务27·尾 秘书个人记忆栈懒加载单例 + 任务03·尾 日志时间窗预置 + 任务39·F3 交接笔记预生成
 * (内存态 handoffRuntime 供轮换点认领;清空入口 clearHandoffRuntime)。
 */
import { logger } from '../../utils/index.js';
import { createMemoryStack, type MemoryStack } from '../../jarvis-core/memory/index.js';
import { logEvent } from '../../data/system-log.js';
import {
  buildHandoffUserContent,
  cleanHandoffText,
  shouldPregenHandoff,
  HANDOFF_PREGEN_TIMEOUT_MS,
  HANDOFF_SYSTEM_PROMPT,
  type HandoffPregenRuntime,
} from '../../voice/handoff.js';
import { loadCompanionState } from './state.js';
import { callClaudeOnce } from './claude-call.js';
import type { VoiceCompanionServerConfig, VoiceCompanionState } from './types.js';

const log = logger.server;

// 任务 27·尾：秘书个人记忆栈（JARVIS vault 四层,懒加载单例;观测经 logEvent 落 ⑭ system_log）。
let jarvisMemory: MemoryStack | undefined;
export function getJarvisMemory(): MemoryStack {
  if (!jarvisMemory) jarvisMemory = createMemoryStack({ logEvent, channel: 'voice' });
  return jarvisMemory;
}

/** 任务 03·尾:从口语里挑日志分析时间窗(缺省昨天——P1「查一下昨天的日志」的典型口径)。 */
export function pickLogWindowPreset(text: string): 'today' | 'yesterday' | 'last24h' | 'last7d' {
  if (/今天|今日/.test(text)) return 'today';
  if (/七天|7\s*天|一周|本周/.test(text)) return 'last7d';
  if (/24\s*小时|最近一天|近一天/.test(text)) return 'last24h';
  return 'yesterday';
}

// ----------------------------------------------------------------------------
// 任务39·F3:交接笔记预生成(内存态 + 后台生成;F4 在轮换点认领)
// ----------------------------------------------------------------------------

/** 预生成内存态(只存内存不落盘;设计理由见 voice/handoff.ts 的 HandoffPregenRuntime)。 */
export const handoffRuntime: HandoffPregenRuntime = { pending: null, inFlight: null, lastPregen: null };

/** 清空预生成内存态(resetCompanion 与测试用;认领/丢弃在正常路径自然清)。 */
export function clearHandoffRuntime(): void {
  handoffRuntime.pending = null;
  handoffRuntime.inFlight = null;
  handoffRuntime.lastPregen = null;
}

/** 测试/观测只读入口(断言 pending 落地与否,不参与生产逻辑)。 */
export function getHandoffRuntime(): Readonly<HandoffPregenRuntime> {
  return handoffRuntime;
}

/**
 * 任务39·F3:跨过预备线即后台预生成一张交接便签(fire-and-forget,不进回合
 * 关键路径)。完成回调重新读状态核对会话未变才落 pending;失败/超时/清洗失败
 * → 降级现状(日志如实,轮换照常走 summarizeSession 旧文案)。
 */
export function maybePregenHandoff(state: VoiceCompanionState, cfg: VoiceCompanionServerConfig): void {
  if (!shouldPregenHandoff(state, cfg, handoffRuntime)) return;
  const forSessionId = state.sessionId;
  if (!forSessionId) return;
  const material = buildHandoffUserContent(state.recentTurns ?? [], state.memory);
  handoffRuntime.inFlight = forSessionId;
  handoffRuntime.lastPregen = { sessionId: forSessionId, turns: state.turns };
  const startedAt = Date.now();
  log.log(
    `[VoiceCompanion] 交接预生成 触发(session=${forSessionId.slice(0, 8)} turns=${state.turns} 材料=${material.length}字)`,
  );
  void (async () => {
    try {
      const result = await callClaudeOnce(HANDOFF_SYSTEM_PROMPT, material, {
        model: cfg.model,
        resumeId: null,
        timeoutMs: HANDOFF_PREGEN_TIMEOUT_MS,
        skipMcp: true,
      });
      const text = cleanHandoffText(result.text);
      if (!text) {
        log.log('[VoiceCompanion] 交接预生成 失败(清洗后无有效内容),降级现状');
        return;
      }
      const current = loadCompanionState();
      if (current.sessionId !== forSessionId) {
        log.log(
          `[VoiceCompanion] 交接预生成 跳过(已轮换 ${forSessionId.slice(0, 8)} → ${(current.sessionId ?? 'null').slice(0, 8)})`,
        );
        return;
      }
      handoffRuntime.pending = { forSessionId, text, at: Date.now() };
      log.log(`[VoiceCompanion] 交接预生成 完成(字节=${text.length}, 用时=${Date.now() - startedAt}ms)`);
    } catch (err) {
      log.log(`[VoiceCompanion] 交接预生成 失败(${(err as Error).message ?? String(err)}),降级现状`);
    } finally {
      if (handoffRuntime.inFlight === forSessionId) handoffRuntime.inFlight = null;
    }
  })();
}
