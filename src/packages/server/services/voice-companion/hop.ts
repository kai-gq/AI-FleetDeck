/**
 * 语音伙伴服务 — 记忆感知回合(2026-10-11 自 voice-companion-service.ts 拆分,行为不变)。
 * 世界状态 → hop1 系统提示词(快照/项目/人格/记忆)与常驻预热;hop1 契约解析/--resume 被拒重试;
 * hop2 二跳总结。进程管理全在 claude-call/companion-runner,本模块只管回合。
 */
import { logger } from '../../utils/index.js';
import * as agentService from '../agent-service.js';
import { loadAreas } from '../../data/index.js';
import { isProjectRoutingEnabled } from '../../jarvis-core/projects/types.js';
import { buildPersonaInjection, isPersonaEnabled, recordPersonaSession } from '../../jarvis-core/persona/index.js';
import {
  isCompanionResidentEnabled,
  prewarmCompanionProcess,
  stopCompanionProcess,
  type CompanionContextUsage,
} from '../../voice/companion-runner.js';
import type { DrawingArea } from '../../../shared/common-types.js';
import { logSession } from '../activity-log.js';
import { buildAgentSnapshotLines, collectDelegationHistory } from './snapshot.js';
import { MEMORY_WARN_CHARS } from './constants.js';
import { isBossLikeAgent } from './agents.js';
import { loadServerConfig } from './config.js';
import { loadCompanionState } from './state.js';
import { parseContractJson, stripCodeFences, truncate } from './contract.js';
import { buildProjectRoutingSnapshotLines, buildProjectRoutingWorld } from './project-routing.js';
import { buildCompanionSystemPrompt, formatMemory, HOP2_SYSTEM_PROMPT } from './prompt.js';
import { callClaudeHop1, callClaudeOnce, isResumeRejection, type ClaudeHop1Result } from './claude-call.js';
import type {
  CompanionMemory,
  VoiceCompanionServerConfig,
  VoiceCompanionState,
  VoiceContract,
  VoicePersonaConfig,
} from './types.js';

const log = logger.server;

export interface Hop1Outcome {
  contract: VoiceContract;
  degraded: boolean;
  newSessionId: string | null;
  /** 任务18:本回合 result 的上下文占用(回退路径为 null)。 */
  context: CompanionContextUsage | null;
  /** W6 观测:本回合常驻进程复用/新建。 */
  reused: boolean;
  elapsedMs: number;
}

export function buildSystemPromptFromWorld(memory: CompanionMemory, persona: VoicePersonaConfig, currentSessionId: string | null): string {
  const agents = agentService.getAllAgents();
  let areas: DrawingArea[] = [];
  try {
    areas = loadAreas();
  } catch (err) {
    log.warn(`[VoiceCompanion] loadAreas 失败: ${(err as Error).message}`);
  }
  const delegationHistory = collectDelegationHistory(agents);
  // 任务14·⑪ 快照注入：开关缺省开；开关关 / 无项目卡 → 不注块（与旧版逐字一致）。
  let projectLines: string[] = [];
  if (isProjectRoutingEnabled()) {
    try {
      projectLines = buildProjectRoutingSnapshotLines(buildProjectRoutingWorld({
        loadAreasFn: () => areas,
        getAllAgents: () => agents,
        delegationHistory,
      }));
    } catch (err) {
      log.warn(`[VoiceCompanion] 项目快照构建失败(不注块): ${(err as Error).message}`);
    }
  }
  const { lines, total, truncated } = buildAgentSnapshotLines(agents, areas, delegationHistory, projectLines);
  // 体积告警(P9):记忆是仅次于 agent 快照的 prompt 变项,超阈值先提示清理。
  const memoryChars = formatMemory(memory, { currentSessionId }).length;
  if (memoryChars > MEMORY_WARN_CHARS) {
    log.warn(`[VoiceCompanion] 记忆注入体积偏大:${memoryChars} 字符 / ${memory.notes.length} 条笔记(阈值 ${MEMORY_WARN_CHARS}),建议清理`);
  }
  const bossNames = new Map<string, string>(agents.filter(isBossLikeAgent).map((a): [string, string] => [a.id, a.name]));
  // 任务32 人格层:开关缺省开;开关关 / 构建失败 → 不注段(与旧版逐字一致)。
  // 会话计数幂等(sessionId null 不计数):同一会话的预热/每回合重复构词不重复计。
  let personaCoreBlock: string | undefined;
  let relationshipBlock: string | undefined;
  if (isPersonaEnabled()) {
    try {
      const injection = buildPersonaInjection();
      personaCoreBlock = injection.coreBlock;
      relationshipBlock = injection.relationshipBlock;
      recordPersonaSession(currentSessionId);
    } catch (err) {
      log.warn(`[VoiceCompanion] 人格层注入构建失败(不注段): ${(err as Error).message}`);
    }
  }
  return buildCompanionSystemPrompt({ agentLines: lines, totalAgents: total, truncated, memory, persona, delegationHistory, bossNames, currentSessionId, personaCoreBlock, relationshipBlock });
}

/**
 * W3 预热点火(服务侧入口):按当前世界状态提前建好常驻进程 —— 系统提示词与
 * runHop1 同源同刻构建,resumeId 取当前 state.sessionId。
 *
 * 调用点:① 流式通道首个音频帧(用户开口,见 voice-companion-stream.ts);
 * ② 回合收尾且常驻进程已不在(超时/中止/崩溃被杀后的补建,见下方 disposeTurn)。
 * 全程静默:任何失败返回 false,绝不影响主链路;幂等判定在 companion-runner 内。
 */
export function prewarmCompanion(): boolean {
  if (!isCompanionResidentEnabled()) return false;
  try {
    const cfg = loadServerConfig();
    const state = loadCompanionState();
    const systemPrompt = buildSystemPromptFromWorld(state.memory, cfg.persona, state.sessionId);
    return prewarmCompanionProcess({ systemPrompt, model: cfg.model, resumeId: state.sessionId });
  } catch (err) {
    log.warn(`[VoiceCompanion] 预热失败(静默): ${(err as Error).message}`);
    return false;
  }
}

export async function runHop1(
  userText: string,
  state: VoiceCompanionState,
  cfg: VoiceCompanionServerConfig,
  isEvent: boolean,
  stream?: { onTextDelta?: (fullText: string) => void; signal?: AbortSignal },
): Promise<Hop1Outcome> {
  const started = Date.now();
  // 任务39·F4:此处 state.sessionId 已是本回合实际会话(轮换后为 null)→ 交接
  // 便签只在新会话的提示词里渲染(本会话不看到描述自己的便签)。
  const systemPrompt = buildSystemPromptFromWorld(state.memory, cfg.persona, state.sessionId);
  // 体积打点(P5):agent 快照是 prompt 的最大变项,超预期先看这里。
  log.log(`[VoiceCompanion] system prompt ${systemPrompt.length} 字符`);

  // 当前时间随回合注入用户消息:resume 会话的系统提示词是「首建会话时记录、之后原样重发」
  // 的冻结语义(常驻进程也在 spawn 时固定),写进系统提示词的时间会在会话生命周期里停走
  // (真麦实测:20:33 问「现在几点了」答「晚上 8 点 12 分」)。放进每回合 userContent,
  // 一次性/常驻两条路径同源生效。
  const nowText = new Date().toLocaleString('zh-CN', { hour12: false });
  const userContent = `${userText}\n\n【当前时间】${nowText}`;

  const attempt = (resumeId: string | null) => callClaudeHop1(systemPrompt, userContent, {
    model: cfg.model,
    resumeId,
    timeoutMs: cfg.hop1TimeoutMs,
    reminder: !!resumeId || !isEvent,
    onTextDelta: stream?.onTextDelta,
    signal: stream?.signal,
  });

  let result: ClaudeHop1Result;
  try {
    result = await attempt(state.sessionId);
  } catch (err) {
    if (state.sessionId && isResumeRejection(err)) {
      log.warn(`[VoiceCompanion] --resume 被拒(session 已失效),清会话重试一次`);
      const rejectedSessionId = state.sessionId;
      state.sessionId = null;
      state.sessionStartedAt = null;
      // 任务18:常驻进程带着被拒的 --resume 建立过,重试前先停掉,下一次重试重新 spawn(不带 resume)。
      stopCompanionProcess('resume-rejected');
      // 系统活动 5：--resume 被拒 → 清会话重试（重试结果由后续 created/异常自然观测）
      logSession({ phase: 'resume-rejected', sessionId: rejectedSessionId, reason: 'stale-session-id' });
      result = await attempt(null);
    } else {
      throw err;
    }
  }

  // 会话记账:记住 sessionId(turns/时间戳由调用方统一落盘)
  if (result.sessionId) {
    if (!state.sessionId) {
      // 系统活动 5：会话创建（含 resume 被拒后清会话重试成功的新建）
      logSession({ phase: 'created', sessionId: result.sessionId });
    }
    state.sessionId = result.sessionId;
  }
  if (!state.sessionStartedAt) state.sessionStartedAt = Date.now();

  let contract: VoiceContract;
  try {
    contract = parseContractJson(result.text);
  } catch (err) {
    // 模型输出解析不出契约(非 JSON / JSON 残缺):带上截断原文抛出,
    // 由 processVoiceInput 统一按降级处理(不 500,不重置会话)——P4。
    const e = new Error(`contract parse failed: ${(err as Error).message}; raw=${truncate(result.text, 300)}`);
    e.name = 'VoiceCompanionParse';
    throw e;
  }
  log.log(`[VoiceCompanion] hop1 ${Date.now() - started}ms → ${JSON.stringify(contract).slice(0, 500)}`);
  return { contract, degraded: false, newSessionId: result.sessionId, context: result.context, reused: result.reused, elapsedMs: Date.now() - started };
}

export async function runHop2(
  question: string,
  agentName: string,
  agentStatus: string,
  agentTask: string | undefined,
  agentError: string | undefined,
  excerpt: string,
  cfg: VoiceCompanionServerConfig,
  stream?: { onTextDelta?: (fullText: string) => void; signal?: AbortSignal },
): Promise<string> {
  const userContent = [
    `老板的问题:${question || `看看 ${agentName} 最近做了什么`}`,
    '',
    `agent「${agentName}」当前状态:${agentStatus}${agentTask ? `,任务:${agentTask}` : ''}${agentError ? `,最近错误:${agentError}` : ''}`,
    '',
    '最近输出记录:',
    excerpt,
  ].join('\n');

  const result = await callClaudeOnce(HOP2_SYSTEM_PROMPT, userContent, {
    model: cfg.model,
    resumeId: null,
    timeoutMs: cfg.hop2TimeoutMs,
    onTextDelta: stream?.onTextDelta,
    signal: stream?.signal,
  });
  const parsed = JSON.parse(
    stripCodeFences(result.text).slice(
      Math.max(0, stripCodeFences(result.text).indexOf('{')),
      stripCodeFences(result.text).lastIndexOf('}') + 1,
    ),
  ) as { responseToUser?: unknown };
  if (typeof parsed.responseToUser !== 'string' || !parsed.responseToUser.trim()) {
    throw new Error('hop2 empty response');
  }
  return parsed.responseToUser.trim();
}
