/**
 * 语音伙伴服务 — 状态/重置/记忆管理(2026-10-11 自 voice-companion-service.ts 拆分,行为不变)。
 * 设置面板与路由读写的伴侣状态口;重置同时清会话/项目路由/撤回挂起/交接预生成。
 */
import { logger } from '../../utils/index.js';
import { getCompanionProcessInfo, stopCompanionProcess } from '../../voice/companion-runner.js';
import { logMemoryOps, logSession } from '../activity-log.js';
import { DEFAULT_MEMORY } from './constants.js';
import { loadServerConfig } from './config.js';
import { loadCompanionState, saveCompanionState } from './state.js';
import { applyMemoryOps, warnUnappliedMemoryRemoves } from './contract.js';
import { resetCancelClarificationSession } from './cancel.js';
import { resetProjectRoutingSession } from './project-routing.js';
import { clearHandoffRuntime } from './turn-helpers.js';
import type { CompanionMemory, CompanionMemoryNote, VoiceCompanionContextState, VoiceMemoryOp } from './types.js';

const log = logger.server;

export function getCompanionStatus(): {
  hasSession: boolean;
  turns: number;
  sessionStartedAt: number | null;
  lastUsedAt: number | null;
  model: 'haiku' | 'sonnet';
  memory: { summary: string; notes: CompanionMemoryNote[]; updatedAt: number; droppedCount: number };
  /** 任务18:最近一次 hop1 的上下文占用(无 → null);canary 冒烟/设置面板读它。 */
  context: VoiceCompanionContextState | null;
  /** 任务18:常驻子进程 pid(未常驻/已退出 → null);L3 冷热对比与运维判活读它。 */
  residentPid: number | null;
} {
  const state = loadCompanionState();
  const cfg = loadServerConfig();
  return {
    hasSession: !!state.sessionId,
    turns: state.turns,
    sessionStartedAt: state.sessionStartedAt,
    lastUsedAt: state.lastUsedAt,
    model: cfg.model,
    // 任务39·F4:memory.handoff 不出状态口(⑨ 兼容:响应不新增字段)。
    memory: {
      summary: state.memory.summary,
      notes: state.memory.notes,
      updatedAt: state.memory.updatedAt,
      droppedCount: state.memory.droppedCount,
    },
    context: state.context ?? null,
    residentPid: getCompanionProcessInfo()?.pid ?? null,
  };
}

export function resetCompanion(options: { keepMemory?: boolean } = {}): void {
  const state = loadCompanionState();
  const clearedSessionId = state.sessionId ?? undefined;
  state.sessionId = null;
  state.sessionStartedAt = null;
  state.turns = 0;
  state.context = null; // 任务18:占用快照随重置清零
  state.recentTurns = []; // 任务39·F2:环缓冲随重置清空(keepMemory 与否都清——它是会话素材,不是记忆)
  // 任务39·F4:预生成内存态必清(keepMemory 与否);memory.handoff 走记忆语义——
  // keepMemory=false 时随 DEFAULT_MEMORY 清空,true 时保留(72h 内继续兜底)。
  clearHandoffRuntime();
  if (!options.keepMemory) state.memory = { ...structuredClone(DEFAULT_MEMORY) };
  saveCompanionState(state);
  resetProjectRoutingSession(); // 任务14·⑪：项目路由内存态（最近提及/挂起反问）一并清空
  resetCancelClarificationSession(); // 任务16·⑬：撤回反问挂起一并清空
  // 任务18:重置后旧常驻进程(带旧会话/旧提示词)停掉,下回合重新 spawn。
  stopCompanionProcess('reset');
  log.log(`[VoiceCompanion] 会话重置(keepMemory=${options.keepMemory !== false})`);
  // 系统活动 5：整体重置 → cleared（旧会话留痕；无会话时不发噪音）
  if (clearedSessionId) {
    logSession({ phase: 'cleared', sessionId: clearedSessionId, reason: 'reset-companion' });
  }
}

export function getCompanionMemory(): CompanionMemory {
  return loadCompanionState().memory;
}

/** 设置面板用:op 数组或整体清空。返回更新后的记忆。 */
export function updateCompanionMemory(input: { ops?: VoiceMemoryOp[]; clear?: boolean }): CompanionMemory {
  const state = loadCompanionState();
  if (input.clear) {
    state.memory = { ...structuredClone(DEFAULT_MEMORY) };
  } else if (input.ops && input.ops.length > 0) {
    const cfg = loadServerConfig();
    const { memory, applied, details } = applyMemoryOps(state.memory, input.ops, cfg.maxNotes);
    state.memory = memory;
    // 任务 02 埋点：系统活动 2 —— 设置面板/接口渠道的记忆改动同样落盘
    logMemoryOps({
      applied,
      details,
      notesTotal: memory.notes.length,
      droppedTotal: memory.droppedCount,
      channel: 'settings',
    });
    // A13/H6-1:手动 API 路径同样要对未命中的删除如实告警(可见性与语音回合一致)。
    warnUnappliedMemoryRemoves(details, 'settings');
  }
  saveCompanionState(state);
  return state.memory;
}
