/**
 * Voice Companion Service
 *
 * 「语音伙伴」的服务端大脑:持续聆听模式下,客户端把每一段最终转写文本
 * (或合并后的 agent 事件)发到这里,由本服务完成:
 *
 *   1. 调用 claude(headless,haiku/sonnet,--resume 持久会话)理解意图;
 *   2. 模型按要求只输出一份 JSON 契约(action / targetAgentId / delivery /
 *      responseToUser / memoryOps …);
 *   3. 按契约执行:任务一律 delegate_to_boss 交团队主管(改①;委托消息复用
 *      buildBossMessage 注入团队上下文,默认排队、急迫语义才打断)、查询 agent
 *      最近输出(第二跳 claude 总结)、列 agent、纯聊天;
 *   4. 维护跨会话的持久记忆(notes + summary),每轮注入系统提示词;
 *   5. 团队认知(改③):只读注入委派史摘要(Boss→下属→任务→状态),agent 快照的
 *      Boss 行展开下属结构/忙闲/最近委派(delegation-history 永不写)。
 *
 * 设计要点:
 * - 会话状态与记忆落盘 ~/.local/share/tide-commander/voice-companion.json(tmp+rename);
 * - 超时**不**重置会话(新会话由轮数/天数轮换;旧 voice-assistant 路由已移除);
 * - --resume 被拒(session 文件丢失)→ 清会话重试一次;
 * - 打断走 runtimeService.stopAgent + sendCommand(Claude 无 interruptTurn,
 *   forceInterrupt 对其无效);
 * - 单一互斥队列:主动汇报与用户语音不会并发两次 claude 调用。
 *
 * 纯函数(parseContractJson / applyMemoryOps / buildAgentSnapshotLines /
 * buildDelegationSummaryLines / shouldRotateSession)导出以便单测;IO 部分保持薄。
 */

import { spawn, type ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ClaudeBackend } from '../claude/index.js';
import * as agentService from './agent-service.js';
import * as bossService from './boss-service.js';
import { formatTimeSince } from './subordinate-context-service.js';
import { loadAreas } from '../data/index.js';
import { logger, sanitizeUnicode } from '../utils/index.js';
import { findStringField, createJsonStringStream, type JsonStringStream } from '../voice/contract-stream.js';
import { SpeechGate } from '../voice/speech-gate.js';
import type { GateAction } from '../voice/speech-gate.js';
import type { Agent, DelegationDecision } from '../../shared/agent-types.js';
import type { DrawingArea } from '../../shared/common-types.js';
import { DEFAULT_PERSONA_ID, personaKeyOf, resolvePersonaStyle, sanitizePersonaCustom, sanitizePersonaId, VOICE_LENGTH_RULES } from '../../shared/voice-personas.js';
import {
  logDialogMessage,
  logBroadcast,
  logDelegation,
  logMemoryOps,
  type MemoryOpDetail,
} from './activity-log.js';
import { ensureTaskId, runWithTrace, updateTraceContext } from '../utils/trace-context.js';
import { createMemoryStack, type MemoryStack } from '../jarvis-core/memory/index.js';
import { runLogAnalysis, renderLogAnalysisReport } from '../log-analysis/index.js';
import { logEvent } from '../data/system-log.js';
// 任务13·⑩ 秘书 Bolba 桥：业务待办（报价/付款/会议…）的只读查询与创建/完成/重开。
// 两本账边界：本文件里这四动作只碰 Bolba 账本，绝不进 ① 委派通道。
import {
  BOLBA_CONTRACT_ACTIONS,
  handleBolbaContractAction,
  type BolbaContractAction,
} from './bolba-bridge-service.js';
// 任务07·④ 查进度走下属:query 目标为 Boss 时的委派树解析/材料拼接/观测点④字段(纯逻辑在 voice/ 下)
import {
  buildDelegationQueryMaterial,
  buildNoDelegationResponse,
  buildQueryChainLogBody,
  pickRecentDelegations,
  planQueryRoute,
  type QueryChainLogInput,
  type SubordinateQueryEntry,
} from '../voice/delegation-query.js';

const log = logger.server;

// ============================================================================
// Types
// ============================================================================

export interface CompanionMemoryNote {
  id: string;
  text: string;
  createdAt: number;
  source: 'user' | 'auto';
}

export interface CompanionMemory {
  summary: string;
  notes: CompanionMemoryNote[];
  updatedAt: number;
  droppedCount: number;
}

export interface VoiceCompanionState {
  sessionId: string | null;
  sessionStartedAt: number | null;
  turns: number;
  lastUsedAt: number | null;
  /** 上次使用的人设键(shared/voice-personas 的 personaKeyOf);变化 → 轮换会话。null = 旧状态。 */
  personaKey: string | null;
  memory: CompanionMemory;
}

export type CompanionAction =
  | 'general_response'
  /** 任务语义的唯一出口(改①):目标由系统解析为团队主管(Boss),模型不选执行人。 */
  | 'delegate_to_boss'
  | 'send_to_agent'
  | 'list_agents'
  | 'query_agent_output'
  /** 任务03·尾：⑮ P1 只读日志分析（秘书自留区：不派活、不计 ⑫ 配额）。 */
  | 'analyze_logs'
  /** 任务13·⑩ 秘书 Bolba 桥:业务待办(报价/付款/会议/证书…)四动作,只碰 Bolba 账本。 */
  | 'query_bolba_tasks'
  | 'create_bolba_task'
  | 'complete_bolba_task'
  | 'reopen_bolba_task'
  | 'noop';

/**
 * 契约 action 全集——模板字符串 / 解析白名单 / 流式 GATE_ACTIONS 同源,防多处漂移
 * (改① 新增 delegate_to_boss 时只需改这里与 CompanionAction)。
 */
export const COMPANION_ACTIONS: readonly CompanionAction[] = [
  'general_response', 'delegate_to_boss', 'send_to_agent', 'list_agents', 'query_agent_output', 'analyze_logs',
  'query_bolba_tasks', 'create_bolba_task', 'complete_bolba_task', 'reopen_bolba_task', 'noop',
];

export type CompanionDelivery = 'queue' | 'interrupt';

export interface VoiceMemoryOp {
  op: 'add' | 'remove' | 'setSummary';
  text?: string;
  id?: string;
  summary?: string;
}

export interface VoiceContract {
  action: CompanionAction;
  targetAgentId: string | null;
  targetAgentName: string | null;
  messageToAgent: string;
  delivery: CompanionDelivery;
  query: string;
  /** 任务13·⑩：Bolba 动作的指代/事项（create 填去时间词的事项；complete/reopen 填编号或标题）。 */
  bolbaTask: string;
  responseToUser: string;
  memoryOps: VoiceMemoryOp[];
}

export interface VoiceProcessOptions {
  /** true = 由客户端主动汇报模块送来的 [系统事件] 文本(noop 时保持安静)。 */
  isEvent?: boolean;
  /**
   * 分句流式播报:模型边生成,responseToUser 里每完成一句就回调一次
   * (已经过 action 语义门控:noop 不出声、send_to_agent 等派发成功才放行)。
   * 不传则完全走旧的整段返回路径。
   */
  onSentence?: (sentence: string) => void;
  /** 客户端断开时中止本轮 claude 调用(否则废弃请求会占着互斥队列)。 */
  signal?: AbortSignal;
}

export interface VoiceProcessResult {
  action: CompanionAction;
  response: string;
  targetAgent?: { id: string; name: string };
  messageSent?: string;
  delivery?: CompanionDelivery;
  interrupted?: boolean;
  secondHopMs?: number;
  memoryOpsApplied?: number;
  /** 模型超时/输出无法解析时的兜底标记。 */
  degraded?: boolean;
  /** 已通过 onSentence 播报过(客户端据此决定是否整段补播 response)。 */
  spoke?: boolean;
  elapsedMs: number;
}

/** callClaudeOnce 被 opts.signal 中止时抛出的错误(name 供路由识别后静默收尾)。 */
export class VoiceCompanionAbortedError extends Error {
  constructor() {
    super('VoiceCompanion call aborted');
    this.name = 'VoiceCompanionAborted';
  }
}

export interface VoicePersonaConfig {
  preset: string;
  custom: string;
}

export interface VoiceCompanionServerConfig {
  model: 'haiku' | 'sonnet';
  persona: VoicePersonaConfig;
  hop1TimeoutMs: number;
  hop2TimeoutMs: number;
  maxTurns: number;
  sessionMaxAgeDays: number;
  maxNotes: number;
}

export const DEFAULT_SERVER_CONFIG: VoiceCompanionServerConfig = {
  model: 'haiku',
  persona: { preset: DEFAULT_PERSONA_ID, custom: '' },
  hop1TimeoutMs: 60_000,
  hop2TimeoutMs: 45_000,
  maxTurns: 120,
  sessionMaxAgeDays: 7,
  maxNotes: 40,
};

const DEFAULT_MEMORY: CompanionMemory = {
  summary: '',
  notes: [],
  updatedAt: 0,
  droppedCount: 0,
};

const DEFAULT_STATE: VoiceCompanionState = {
  sessionId: null,
  sessionStartedAt: null,
  turns: 0,
  lastUsedAt: null,
  personaKey: null,
  memory: DEFAULT_MEMORY,
};

/** Agent 状态里算「正在干活」(打断有代价)的三种。 */
export const ACTIVE_AGENT_STATUSES = new Set(['working', 'waiting', 'waiting_permission']);

const NOTES_MAX_TEXT = 300;
const SUMMARY_MAX_TEXT = 1500;
const MAX_SNAPSHOT_AGENTS = 60;
const TASK_TRUNCATE = 60;
const ERROR_TRUNCATE = 80;
/** 🔴 决策观测点④ 查询链路:请求/返回摘要的截断长度(Spec §4.14「返回摘要(截断)」)。 */
const QUERY_LOG_PREVIEW_CHARS = 120;
/** 注入 prompt 的委派史条数上限:§8.1 已验证常量,镜像 subordinate-context-service.ts:135 的 slice(0,5),不改值。 */
const MAX_DELEGATION_INJECT = 5;
/** Boss 卡片最多展开的下属个数,超出只报「…另N人」——防单行随团队规模失控(60 快照上限之外的体积护栏)。 */
const MAX_SNAPSHOT_SUBORDINATES = 8;
const HISTORY_MESSAGES = 30;
const HISTORY_EXCERPT_COUNT = 6;
const HISTORY_ITEM_CHARS = 400;
const HISTORY_TOTAL_CHARS = 1500;
/** 记忆注入体积告警阈值(P9):笔记上限 40×300 + 总结 1500,超此值先看记忆该不该清。 */
const MEMORY_WARN_CHARS = 4_000;

// XDG-compliant(与 data/index.ts 惯例一致):测试沙箱靠 XDG_DATA_HOME 重定向,
// 避免测试进程误写真实状态文件。未设 XDG 的机器解析结果与旧路径完全相同。
const STATE_FILE = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  'tide-commander',
  'voice-companion.json',
);
const CONFIG_FILE = path.join(process.cwd(), 'tools/voice-companion/config.json');

const DEGRADED_RESPONSE = '抱歉,我这会儿没听清,请再说一遍。';

// ============================================================================
// Config / state IO
// ============================================================================

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 读取 tools/voice-companion/config.json(服务端只关心 model / persona / brain.*);缺失回默认。 */
export function loadServerConfig(): VoiceCompanionServerConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_SERVER_CONFIG, persona: { ...DEFAULT_SERVER_CONFIG.persona } };
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
    };
  } catch (err) {
    log.warn(`[VoiceCompanion] config.json 读取失败,用默认配置: ${(err as Error).message}`);
    return { ...DEFAULT_SERVER_CONFIG, persona: { ...DEFAULT_SERVER_CONFIG.persona } };
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

function sanitizeMemory(raw: unknown): CompanionMemory {
  const memory: CompanionMemory = { ...DEFAULT_MEMORY, notes: [] };
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.summary === 'string') memory.summary = obj.summary.slice(0, SUMMARY_MAX_TEXT);
    if (Array.isArray(obj.notes)) {
      for (const n of obj.notes) {
        if (!n || typeof n !== 'object') continue;
        const note = n as Record<string, unknown>;
        if (typeof note.id !== 'string' || typeof note.text !== 'string' || !note.text.trim()) continue;
        memory.notes.push({
          id: note.id,
          text: note.text.slice(0, NOTES_MAX_TEXT),
          createdAt: typeof note.createdAt === 'number' ? note.createdAt : 0,
          source: note.source === 'auto' ? 'auto' : 'user',
        });
      }
    }
    if (typeof obj.updatedAt === 'number') memory.updatedAt = obj.updatedAt;
    if (typeof obj.droppedCount === 'number') memory.droppedCount = obj.droppedCount;
  }
  return memory;
}

export function loadCompanionState(): VoiceCompanionState {
  try {
    if (!fs.existsSync(STATE_FILE)) return { ...structuredClone(DEFAULT_STATE) };
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    const state: VoiceCompanionState = {
      sessionId: typeof raw?.sessionId === 'string' ? raw.sessionId : null,
      sessionStartedAt: typeof raw?.sessionStartedAt === 'number' ? raw.sessionStartedAt : null,
      turns: typeof raw?.turns === 'number' ? raw.turns : 0,
      lastUsedAt: typeof raw?.lastUsedAt === 'number' ? raw.lastUsedAt : null,
      personaKey: typeof raw?.personaKey === 'string' ? raw.personaKey : null,
      memory: sanitizeMemory(raw?.memory),
    };
    return state;
  } catch (err) {
    log.error(`[VoiceCompanion] 状态文件读取失败:`, err);
    return { ...structuredClone(DEFAULT_STATE) };
  }
}

export function saveCompanionState(state: VoiceCompanionState): void {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    log.error(`[VoiceCompanion] 状态文件写入失败:`, err);
  }
}

// ============================================================================
// Pure helpers (unit-tested)
// ============================================================================

export function stripCodeFences(s: string): string {
  let out = s.trim();
  if (out.startsWith('```json')) out = out.slice(7);
  else if (out.startsWith('```')) out = out.slice(3);
  if (out.endsWith('```')) out = out.slice(0, -3);
  return out.trim();
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 容忍模型输出前后夹带的解释文字:截取第一个 { 到最后一个 } 再解析。 */
export function parseContractJson(raw: string): VoiceContract {
  const stripped = stripCodeFences(raw);
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON object in response');
  const obj = JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;

  const action = COMPANION_ACTIONS.includes(obj.action as CompanionAction)
    ? (obj.action as CompanionAction)
    : 'general_response';

  const contract: VoiceContract = {
    action,
    targetAgentId: typeof obj.targetAgentId === 'string' && obj.targetAgentId.trim() ? obj.targetAgentId.trim() : null,
    targetAgentName: typeof obj.targetAgentName === 'string' && obj.targetAgentName.trim() ? obj.targetAgentName.trim() : null,
    messageToAgent: typeof obj.messageToAgent === 'string' ? obj.messageToAgent.trim() : '',
    delivery: obj.delivery === 'interrupt' ? 'interrupt' : 'queue',
    query: typeof obj.query === 'string' ? obj.query.trim() : '',
    bolbaTask: typeof obj.bolbaTask === 'string' ? truncate(obj.bolbaTask, 200) : '',
    responseToUser: typeof obj.responseToUser === 'string' ? obj.responseToUser.trim() : '',
    memoryOps: [],
  };

  if (Array.isArray(obj.memoryOps)) {
    for (const op of obj.memoryOps) {
      if (!op || typeof op !== 'object') continue;
      const o = op as Record<string, unknown>;
      if (o.op === 'add' && typeof o.text === 'string') {
        contract.memoryOps.push({ op: 'add', text: o.text });
      } else if (o.op === 'remove' && typeof o.id === 'string') {
        contract.memoryOps.push({ op: 'remove', id: o.id });
      } else if (o.op === 'setSummary' && typeof o.summary === 'string') {
        contract.memoryOps.push({ op: 'setSummary', summary: o.summary });
      }
    }
  }
  return contract;
}

function newNoteId(now: number): string {
  return `m${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 应用模型给出的 memoryOps:add 去重、上限裁剪(先裁最旧的 auto 条目);
 * remove 按 id;setSummary 覆盖总结。返回新 memory 与生效条数。
 * (任务 02 扩展:details 逐条记录每个 op 是否生效及 add 触发的 droppedCount,
 *  供 logMemoryOps 落盘;调用方解构 {memory, applied} 的现用法不受影响。)
 */
export function applyMemoryOps(
  memory: CompanionMemory,
  ops: VoiceMemoryOp[] | undefined,
  maxNotes: number,
  now: number = Date.now(),
): { memory: CompanionMemory; applied: number; details: MemoryOpDetail[] } {
  const details: MemoryOpDetail[] = [];
  if (!ops || ops.length === 0) return { memory, applied: 0, details };

  const next: CompanionMemory = {
    summary: memory.summary,
    notes: [...memory.notes],
    updatedAt: now,
    droppedCount: memory.droppedCount,
  };
  let applied = 0;

  for (const op of ops) {
    if (op.op === 'add' && typeof op.text === 'string') {
      const text = op.text.replace(/\s+/g, ' ').trim().slice(0, NOTES_MAX_TEXT);
      if (text.length < 2) {
        details.push({ op: 'add', applied: false });
        continue;
      }
      const dup = next.notes.some((n) => n.text.toLowerCase() === text.toLowerCase());
      if (dup) {
        details.push({ op: 'add', applied: false });
        continue;
      }
      const droppedBefore = next.droppedCount;
      while (next.notes.length >= maxNotes) {
        const autoIdx = next.notes.findIndex((n) => n.source === 'auto');
        next.notes.splice(autoIdx === -1 ? 0 : autoIdx, 1);
        next.droppedCount++;
      }
      next.notes.push({ id: newNoteId(now), text, createdAt: now, source: 'user' });
      applied++;
      details.push({ op: 'add', applied: true, droppedCount: next.droppedCount - droppedBefore });
    } else if (op.op === 'remove' && typeof op.id === 'string') {
      const before = next.notes.length;
      next.notes = next.notes.filter((n) => n.id !== op.id);
      const removed = next.notes.length !== before;
      if (removed) applied++;
      details.push({ op: 'remove', applied: removed });
    } else if (op.op === 'setSummary' && typeof op.summary === 'string') {
      const summary = op.summary.trim().slice(0, SUMMARY_MAX_TEXT);
      const changed = summary !== next.summary;
      if (changed) {
        next.summary = summary;
        applied++;
      }
      details.push({ op: 'setSummary', applied: changed });
    }
  }

  if (applied === 0) return { memory, applied: 0, details };
  return { memory: next, applied, details };
}

/** 会话轮换判定:轮数上限或存活天数上限。轮换 = 清 sessionId,保留记忆。 */
export function shouldRotateSession(
  state: VoiceCompanionState,
  cfg: VoiceCompanionServerConfig,
  now: number = Date.now(),
): boolean {
  if (state.sessionId) {
    if (state.turns >= cfg.maxTurns) return true;
    if (state.sessionStartedAt != null && now - state.sessionStartedAt > cfg.sessionMaxAgeDays * 86_400_000) return true;
  }
  return false;
}

/**
 * 人设变化判定:--resume 的历史会盖过新系统提示词,不换会话换人设就不生效。
 * personaKey 缺失(旧状态/首次)也算变化 → 一次性轮换到当前人设;记忆不受影响。
 */
export function shouldRotateForPersona(state: VoiceCompanionState, personaKey: string): boolean {
  return state.personaKey !== personaKey;
}

/** 快照用的 agent 结构子集(Agent 天然满足,测试可造轻量对象)。 */
export interface SnapshotAgent {
  id: string;
  name: string;
  class?: string;
  status: string;
  isBoss?: boolean;
  /** 直属主管 id(下属侧反向指针)。 */
  bossId?: string;
  /** 直管下属 id 列表(主管侧指针);与 agent.bossId 取并集,兼容两侧只填一边的数据。 */
  subordinateIds?: readonly string[];
  taskLabel?: string;
  lastAssignedTask?: string;
  lastError?: string;
  lastWorkedAt?: number;
  lastActivity?: number;
}

/**
 * Boss 卡片的「下属结构」摘要:人数 + 忙闲统计 + 逐个下属状态(带所属区域)。
 * 下属来源 = subordinateIds ∪ {bossId 指向本 Boss 的 agent};超出上限只报剩余人数。
 */
function formatSubordinateSummary(
  boss: SnapshotAgent,
  byId: ReadonlyMap<string, SnapshotAgent>,
  areasByAgent: ReadonlyMap<string, string[]>,
): string {
  const ids = new Set<string>(boss.subordinateIds ?? []);
  for (const agent of byId.values()) {
    if (agent.bossId === boss.id && agent.id !== boss.id) ids.add(agent.id);
  }
  const subs = [...ids]
    .map((id) => byId.get(id))
    .filter((s): s is SnapshotAgent => !!s && s.id !== boss.id);

  const busy = subs.filter((s) => ACTIVE_AGENT_STATUSES.has(s.status)).length;
  const ordered = [...subs].sort((a, b) => {
    const ab = ACTIVE_AGENT_STATUSES.has(a.status) ? 0 : 1;
    const bb = ACTIVE_AGENT_STATUSES.has(b.status) ? 0 : 1;
    if (ab !== bb) return ab - bb;
    return a.name.localeCompare(b.name);
  });
  const shown = ordered.slice(0, MAX_SNAPSHOT_SUBORDINATES).map((s) => {
    const areaNames = areasByAgent.get(s.id);
    const area = areaNames?.length ? `·${areaNames.join('、')}` : '';
    return `${s.name}(${s.status}${area})`;
  });
  const rest = ordered.length - shown.length;
  if (rest > 0) shown.push(`…另${rest}人`);

  return `下属(${subs.length}): ${busy}忙/${subs.length - busy}闲${shown.length ? ` — ${shown.join('、')}` : ''}`;
}

/**
 * 把 agent 列表压缩成 prompt 里的一行一个:按最近活动排序、截断、上限 60。
 * Boss 卡额外展开下属结构 / 忙闲 / 最近委派(改③,团队认知);委派史只读,可为空。
 * 同时返回是否发生了截断(供 prompt 说明)。
 */
export function buildAgentSnapshotLines(
  agents: readonly SnapshotAgent[],
  areas: readonly DrawingArea[],
  delegationHistory: readonly DelegationDecision[] = [],
): { lines: string[]; total: number; truncated: boolean } {
  const areasByAgent = new Map<string, string[]>();
  for (const area of areas) {
    if (area.archived) continue;
    for (const id of area.assignedAgentIds ?? []) {
      const list = areasByAgent.get(id) ?? [];
      list.push(area.name);
      areasByAgent.set(id, list);
    }
  }

  const byId = new Map(agents.map((a) => [a.id, a]));
  // 每个 Boss 只取最近一条委派(输入可能跨 Boss 交错,先按时间倒序再取首个)。
  const recentByBoss = new Map<string, DelegationDecision>();
  for (const d of [...delegationHistory].sort((a, b) => b.timestamp - a.timestamp)) {
    if (!recentByBoss.has(d.bossId)) recentByBoss.set(d.bossId, d);
  }

  const sorted = [...agents].sort((a, b) => {
    const at = a.lastWorkedAt ?? a.lastActivity ?? 0;
    const bt = b.lastWorkedAt ?? b.lastActivity ?? 0;
    if (bt !== at) return bt - at;
    return a.name.localeCompare(b.name);
  });

  const selected = sorted.slice(0, MAX_SNAPSHOT_AGENTS);
  const lines = selected.map((a) => {
    const parts = [`- ${a.name} | id: ${a.id} | ${a.class ?? 'unknown'} | ${a.status}`];
    const isBoss = isBossLikeAgent(a);
    if (isBoss) parts.push('[BOSS]');
    const agentAreas = areasByAgent.get(a.id);
    if (agentAreas?.length) parts.push(`[区域: ${agentAreas.join('、')}]`);
    if (isBoss) {
      parts.push(`| ${formatSubordinateSummary(a, byId, areasByAgent)}`);
      const recent = recentByBoss.get(a.id);
      if (recent) {
        parts.push(`| 最近委派: "${truncate(recent.userCommand, TASK_TRUNCATE)}" → ${recent.selectedAgentName} (${recent.status})`);
      }
    }
    const task = a.taskLabel || a.lastAssignedTask;
    if (task) parts.push(`| 任务: ${truncate(task, TASK_TRUNCATE)}`);
    if (a.lastError) parts.push(`| 最近错误: ${truncate(a.lastError, ERROR_TRUNCATE)}`);
    return parts.join(' ');
  });

  return { lines, total: sorted.length, truncated: sorted.length > selected.length };
}

/**
 * 委派史摘要(改③,镜像 subordinate-context-service.ts:135-137 的
 * `getDelegationHistory().slice(0,5)` 范式):按时间倒序取最近 MAX_DELEGATION_INJECT
 * 条,格式 Boss → 下属: 任务 [状态];空历史返回 []。
 */
export function buildDelegationSummaryLines(
  history: readonly DelegationDecision[],
  bossNames?: ReadonlyMap<string, string>,
): string[] {
  return [...history]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_DELEGATION_INJECT)
    .map((d) => {
      const boss = bossNames?.get(d.bossId) ?? d.bossId;
      return `- [${formatTimeSince(d.timestamp)}前] ${boss} → ${d.selectedAgentName}: "${truncate(d.userCommand, TASK_TRUNCATE)}" [状态: ${d.status}]`;
    });
}

/**
 * 汇总所有 Boss 的委派史(只读)。
 * 决策观测点③「委派史变更」通道预留(随任务 08 回执链路一起启用,本任务不实现):
 * 现有接缝是 boss-service.subscribe('delegation_decision'),但它只在
 * analyzeAndDelegate 路径 emit;回执链路真正写盘走 addDelegationToHistory
 * (boss-response-handler),写入侧不 emit —— 任务 08 需在写入侧补事件或改订阅,
 * 这里保持每次读实时 map、不做缓存。
 * 文件缺失/读取失败 → 返回空数组,不打断 hop1。
 */
export function collectDelegationHistory(agents: readonly SnapshotAgent[]): DelegationDecision[] {
  const merged: DelegationDecision[] = [];
  for (const agent of agents) {
    if (!isBossLikeAgent(agent)) continue;
    try {
      merged.push(...bossService.getDelegationHistory(agent.id));
    } catch (err) {
      log.warn(`[VoiceCompanion] 读取委派史失败(boss ${agent.id}),按空处理: ${(err as Error).message}`);
    }
  }
  // 各 Boss 内部已是新→旧;跨 Boss 合并后按时间倒序,保证「最近 5 条」是全局最近。
  return merged.sort((a, b) => b.timestamp - a.timestamp);
}

// ============================================================================
// 派发路由(改①:任务只走 Boss)——纯函数,单测覆盖
// ============================================================================

/** 派发目标结构子集(Agent 天然满足;测试可造轻量对象)。 */
export interface DispatchTargetAgent {
  id: string;
  name: string;
  class?: string;
  isBoss?: boolean;
}

/** 主管判定:与 boss-service / deliverToAgent 一致(isBoss 或 class==='boss')。 */
export function isBossLikeAgent(agent: { isBoss?: boolean; class?: string }): boolean {
  return agent.isBoss === true || agent.class === 'boss';
}

/** 违规直派记录:模型仍想把任务直接派给普通 agent 时,告警要落这份信息。 */
export interface DispatchViolation {
  requestedAgentId: string;
  requestedAgentName: string | null;
}

/**
 * 派发路由结果:
 * - boss    = 唯一合法目标(团队主管;Boss 仍可用 send_to_agent 直接对话);
 * - missing = send_to_agent 指定的目标不存在;
 * - no_boss = 团队里没有主管可转交(违规直派且无 Boss 时也会带 violation)。
 */
export type DispatchRoute<T extends DispatchTargetAgent = DispatchTargetAgent> =
  | { route: 'boss'; agent: T; violation?: DispatchViolation }
  | { route: 'missing' }
  | { route: 'no_boss'; violation?: DispatchViolation };

/**
 * 把契约意图解析成唯一合法的派发目标(改①,决策观测点①):
 * - delegate_to_boss:任务语义,目标固定为主管——模型给了主管 id 就尊重(多主管世界),
 *   给普通 agent id 或留空都改走第一位主管;给普通 agent id 记违规(观测用)。
 * - send_to_agent:仅主管可达;指向普通 agent = 违规直派 → 标记 violation 并改道主管,
 *   保住「全走 Boss」不变式(供 ⑮ 分析告警频率,而不是让任务丢失)。
 */
export function resolveDispatchRoute<T extends DispatchTargetAgent>(
  action: 'delegate_to_boss' | 'send_to_agent',
  requestedAgentId: string | null,
  agents: readonly T[],
): DispatchRoute<T> {
  const boss = agents.find((a) => isBossLikeAgent(a));
  const requested = requestedAgentId ? agents.find((a) => a.id === requestedAgentId) : undefined;

  if (action === 'send_to_agent') {
    if (!requested) return { route: 'missing' };
    if (isBossLikeAgent(requested)) return { route: 'boss', agent: requested };
    const violation: DispatchViolation = { requestedAgentId: requested.id, requestedAgentName: requested.name ?? null };
    return boss ? { route: 'boss', agent: boss, violation } : { route: 'no_boss', violation };
  }

  // delegate_to_boss:目标由系统解析,不选执行人。
  if (requested && isBossLikeAgent(requested)) return { route: 'boss', agent: requested };
  if (!boss) return { route: 'no_boss' };
  const violation: DispatchViolation | undefined = requested
    ? { requestedAgentId: requested.id, requestedAgentName: requested.name ?? null }
    : undefined;
  return violation ? { route: 'boss', agent: boss, violation } : { route: 'boss', agent: boss };
}

function formatMemory(memory: CompanionMemory): string {
  const parts: string[] = [];
  if (memory.summary.trim()) parts.push(`总结: ${memory.summary.trim()}`);
  if (memory.notes.length > 0) {
    parts.push(memory.notes.map((n) => `- [${n.id}] ${n.text}`).join('\n'));
  }
  return parts.length > 0 ? parts.join('\n') : '(暂无)';
}

// 字段顺序有讲究:action 与 responseToUser 放最前 —— 分句流式播报靠它们尽早
// 知道要不要出声、以及第一句是什么;长字段(messageToAgent / memoryOps)殿后,
// 不阻塞播报。
const CONTRACT_TEMPLATE = `{"action":"${COMPANION_ACTIONS.join('|')}",`
  + '"responseToUser":"",'
  + '"targetAgentId":null,"targetAgentName":null,"messageToAgent":"","delivery":"queue|interrupt",'
  + '"query":"","bolbaTask":"","memoryOps":[]}';

/** 组装 hop1 系统提示词:角色 + 人设 + 契约 + 规则 + 记忆 + agent 快照 + 委派史摘要。 */
export function buildCompanionSystemPrompt(input: {
  agentLines: string[];
  totalAgents: number;
  truncated: boolean;
  memory: CompanionMemory;
  nowText: string;
  persona?: VoicePersonaConfig;
  /** 团队委派史(只读注入;内部按时间倒序取最近 {@link MAX_DELEGATION_INJECT} 条,空/缺省输出「暂无委派记录」)。 */
  delegationHistory?: readonly DelegationDecision[];
  /** bossId → Boss 名,把委派史里的 bossId 显示成人名(缺省回退 bossId)。 */
  bossNames?: ReadonlyMap<string, string>;
}): string {
  const { agentLines, totalAgents, truncated, memory, nowText } = input;
  const agentsBlock = agentLines.length > 0
    ? agentLines.join('\n') + (truncated ? `\n(仅显示最近活动的 ${agentLines.length} 个,共 ${totalAgents} 个)` : '')
    : '(暂无 agent)';
  const delegationBlock = buildDelegationSummaryLines(input.delegationHistory ?? [], input.bossNames).join('\n')
    || '(暂无委派记录)';
  const personaStyle = resolvePersonaStyle(
    input.persona?.preset ?? DEFAULT_PERSONA_ID,
    input.persona?.custom,
  );

  return `你是 Tide Commander(多 AI agent 指挥台)的语音伙伴,代号「小伴」。老板通过语音和你说话;你负责:聊天、把任务交给团队主管(Boss)安排、查询 agent 的进展与产出、记住老板的长期偏好。

【人设】${personaStyle}

【输出格式】只输出一个 JSON 对象,不要 markdown、不要解释、不要代码块;严格按模板的字段顺序输出(action、responseToUser 在最前):
${CONTRACT_TEMPLATE}

上面的模板只是字段格式示意:其中 responseToUser 是给老板播报的实际句子,**除 noop 动作外绝不允许为空字符串**。

【action 说明】
- delegate_to_boss: 老板要「派人干活」时唯一的派活动作(新建/修改/修复/安排/推进/催办/停掉某人的活等)。targetAgentId 一律留 null;messageToAgent 写成给主管的完整指令(写清要做什么、在哪个项目/目录、验收要求)。系统会把任务转给团队主管(列表里标 [BOSS] 的那位)由它拆解选人——你不要自己挑执行的人。
- send_to_agent: 仅当老板明确要直接对主管([BOSS])本人说话时使用(补充说明、追问它的安排、对它提要求),targetAgentId 必须是 [BOSS] 的 id。**任何让普通 agent 干活的请求都不得用它**——一律走 delegate_to_boss。
- query_agent_output: 老板问某个 agent(主管或普通 agent 都行)「最近做了什么/进展如何/结果是什么/输出了什么」。只读查询,不派活。targetAgentId 填该 agent;query 填老板的原始问题。此动作下 responseToUser 可留空,系统会做第二跳总结。
- analyze_logs: 老板要看日志/分析日志/「查一下昨天的日志」「今天出了哪些错」。只读查询,不派活;query 填老板的原始问法(含时间词)。responseToUser 可留空,系统会跑完整分析并播报四段报告(耗时一两分钟属正常)。
- query_bolba_tasks: 老板问「业务待办/要盯的事/板上有什么/今天有什么要盯的/按项目看看」——Bolba 板是报价、付款、会议、证书这类 agent 干不了、需要人盯的业务清单。只读查询,不派活;query 填老板的原始问法(含项目名)。responseToUser 可留空,系统渲染实际情况。
- create_bolba_task: 老板说「记一下/加到待办/提醒我」且内容是业务事项 → bolbaTask 填事项本身,**去掉「周五前/明天/下周三」等时间词**(系统从原话解析日期);responseToUser 可留空。
- complete_bolba_task: 老板说「完成 X/X 做完了」且 X 是业务事项 → bolbaTask 填 X 的指代(编号或标题);responseToUser 可留空。
- reopen_bolba_task: 老板说「重开 X」且 X 是业务事项 → bolbaTask 填 X 的指代(编号或标题);responseToUser 可留空。
- list_agents: 老板想了解有哪些 agent、谁在忙、某类状态如何。必须用 responseToUser 口头汇报概况(数量、谁在忙、谁空闲)。
- general_response: 正常对话——寒暄、问你自己、闲聊、咨询建议、对老板想法的讨论,都走这条;对老板的决定有不同看法就直接说出来,该质疑质疑。必须给出 responseToUser。
- noop: 输入以 [系统事件] 开头且没有值得汇报的内容时使用,responseToUser 留空字符串。

【三态边界(重要,先判再答)】
- 「问情况」走查询:做到哪了/进展/结果/谁在做/为什么还没好/查一下/看一下 → query_agent_output 或 list_agents;看日志/查日志/日志里出了什么错 → analyze_logs。老板说「去查一下/问一下 XX」也是查询,不是让你派活。
- 「要人干活」才走派活:让 X 做/需要改成/安排/推进/催办/停掉某人的活/改用方案 → delegate_to_boss。
- 业务待办(报价/付款/会议/证书/盯人盯事)走 Bolba 四动作;agent 的活(写代码/改 bug/推进项目)走 delegate_to_boss。拿不准先问一句,绝不混账。
- 寒暄、闲聊、咨询建议、讨论想法 → general_response。
拿不准是不是任务时,先按查询/对话处理并向老板确认一句,绝不擅自派活。

【打断规则(重要)】只有老板明确说出「马上/立刻/现在就」等急迫语义、且希望打断主管当前协调的工作时,delivery 才填 "interrupt"——派活目标都是主管,打断它会停掉它正在进行的拆解/收口,代价很大。老板说「停下 X/别做了/改用」是对某个下属的工作说的,属于 delegate_to_boss:把要求写进 messageToAgent,delivery 仍填 "queue"。其它一切情况(催促、补充、追问)都用 "queue"。若实际发生了打断,responseToUser 要说明「已打断 X」。

【记忆规则】memoryOps 数组,可多可空:
- {"op":"add","text":"…"}: 老板表达了稳定的偏好/称呼/习惯/长期规则(例如「叫我老板」「汇报先说结论」「以后用中文」)。只记长期信息,不要记一次性任务内容。
- {"op":"remove","id":"…"}: 老板要求忘记某条(用下方记忆列表里的 id)。
- {"op":"setSummary","summary":"…"}: 压缩重写记忆总结(很少用)。
没有新记忆时 memoryOps 为 []。

【说话风格】除 noop 和 query_agent_output 外,responseToUser 一律不能为空;用与老板相同的语言;${VOICE_LENGTH_RULES}派活时说「已交给主管安排」。这是语音播报,写出来就要能直接念。

【当前时间】${nowText}

【长期记忆】
${formatMemory(memory)}

【agent 列表】(共 ${totalAgents} 个;其中标 [BOSS] 的才能用 send_to_agent 直接对话,其余 agent 仅供查询与状态了解,派活一律 delegate_to_boss;标 [BOSS] 的行内含其下属结构/忙闲与最近委派,团队整体忙不忙看这里)
${agentsBlock}

【最近委派】(只读团队委派史,最多 ${MAX_DELEGATION_INJECT} 条、新→旧;回答「谁在给谁干活」用它。status: sent 只表示已派出,执行进展以 agent 快照与查询为准)
${delegationBlock}`;
}

const HOP2_SYSTEM_PROMPT = `你是语音伙伴的结果查询模块。基于下方给出的 agent 输出记录,直接回答老板的问题。
要求:与老板提问相同的语言;1-3 句、口语化、无 emoji、无 markdown;只依据给出的记录,不要编造;记录里没有就直说。
只输出 JSON:{"responseToUser":"…"}`;

// ============================================================================
// Claude headless call (hop1 / hop2)
// ============================================================================

const claudeBackend = new ClaudeBackend();

interface ClaudeCallResult {
  text: string;
  sessionId: string | null;
  stderr: string;
}

function callClaudeOnce(
  systemPrompt: string,
  userContent: string,
  opts: {
    model: string;
    resumeId?: string | null;
    timeoutMs: number;
    reminder?: boolean;
    /** 增量文本(累计值):分句流式播报用它边生成边切句。 */
    onTextDelta?: (fullText: string) => void;
    /** 中止信号:abort 时 kill 子进程并以 VoiceCompanionAbortedError 拒绝。 */
    signal?: AbortSignal;
  },
): Promise<ClaudeCallResult> {
  if (opts.signal?.aborted) return Promise.reject(new VoiceCompanionAbortedError());
  return new Promise((resolve, reject) => {
    const executable = claudeBackend.getExecutablePath();
    const args = [
      '--print',
      '--verbose',
      '--model', opts.model,
      '--output-format', 'stream-json',
      // 增量事件(text_delta)——分句流水线的前提。
      '--include-partial-messages',
      '--input-format', 'stream-json',
    ];

    const systemPromptFile = path.join(os.tmpdir(), `voice-companion-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    fs.writeFileSync(systemPromptFile, systemPrompt);
    args.push('--system-prompt-file', systemPromptFile);
    if (opts.resumeId) args.push('--resume', opts.resumeId);

    let child: ChildProcess;
    try {
      child = spawn(executable, args, {
        env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
        // 主运行器在 Windows 用 shell:true 启动(cmd.exe 才能执行 .cmd 安装的 claude);
        // 参数均无空格/特殊字符,无需转义。
        shell: process.platform === 'win32',
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }

    const cleanup = () => {
      try {
        if (fs.existsSync(systemPromptFile)) fs.unlinkSync(systemPromptFile);
      } catch { /* ignore */ }
    };

    const decoder = new StringDecoder('utf8');
    let buffer = '';
    // 开 --include-partial-messages 后,同一段文本先以 text_delta 增量到达,
    // 随后又随完整 assistant 事件全量再来一遍。三个来源必须分开累加,否则
    // 文本翻倍、JSON 解析必炸;close 时按优先级取其一。
    let assistantText = '';
    let deltaText = '';
    let resultText = '';
    let newSessionId: string | null = null;
    let stderrBuf = '';
    let settled = false;

    const settleCleanup = () => {
      clearTimeout(timeout);
      cleanup();
      opts.signal?.removeEventListener('abort', onAbort);
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, 5_000);
      killTimer.unref?.();
      settleCleanup();
      const err = new Error(`Claude timed out after ${opts.timeoutMs}ms`);
      err.name = 'VoiceCompanionTimeout';
      reject(err);
    }, opts.timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, 5_000);
      killTimer.unref?.();
      settleCleanup();
      reject(new VoiceCompanionAbortedError());
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (data: Buffer) => {
      buffer += decoder.write(data);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'system' && event.session_id) newSessionId = event.session_id;
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) assistantText += block.text;
            }
          }
          if (event.type === 'stream_event' && event.event?.type === 'content_block_delta') {
            if (event.event.delta?.type === 'text_delta' && event.event.delta.text) {
              deltaText += event.event.delta.text;
              opts.onTextDelta?.(deltaText);
            }
          }
          if (event.type === 'result' && typeof event.result === 'string') {
            resultText = event.result;
          }
        } catch { /* ignore non-JSON */ }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderrBuf += decoder.write(data);
      if (stderrBuf.length > 4_000) stderrBuf = stderrBuf.slice(-4_000);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      settleCleanup();
      const remaining = buffer + decoder.end();
      if (remaining.trim()) {
        try {
          const event = JSON.parse(remaining);
          if (event.type === 'system' && event.session_id) newSessionId = event.session_id;
        } catch { /* ignore */ }
      }
      const textOutput = assistantText || deltaText || resultText;
      if (code !== 0 && !textOutput) {
        const err = new Error(`Claude exited with code ${code}`) as Error & { stderr?: string };
        err.stderr = stderrBuf;
        reject(err);
      } else if (!textOutput) {
        const err = new Error('No response from Claude') as Error & { stderr?: string };
        err.stderr = stderrBuf;
        reject(err);
      } else {
        resolve({ text: textOutput, sessionId: newSessionId, stderr: stderrBuf });
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      settleCleanup();
      reject(err);
    });

    child.on('spawn', () => {
      const reminder = opts.reminder ? '\n\n[REMINDER: Output ONLY the JSON object. No explanations.]' : '';
      const stdinMessage = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: sanitizeUnicode(userContent) + reminder },
      });
      child.stdin?.write(stdinMessage + '\n');
      child.stdin?.end();
    });
  });
}

/** --resume 指向的会话不存在时,claude CLI 的报错特征。 */
function isResumeRejection(err: unknown): boolean {
  const e = err as { message?: string; stderr?: string };
  const text = `${e?.message ?? ''}\n${e?.stderr ?? ''}`;
  return /No conversation found with session ID/i.test(text)
    || (/session/i.test(text) && /not found|invalid/i.test(text));
}

// ============================================================================
// Memory-aware Claude round (hop1)
// ============================================================================

interface Hop1Outcome {
  contract: VoiceContract;
  degraded: boolean;
  newSessionId: string | null;
  elapsedMs: number;
}

function buildSystemPromptFromWorld(memory: CompanionMemory, persona: VoicePersonaConfig): string {
  const agents = agentService.getAllAgents();
  let areas: DrawingArea[] = [];
  try {
    areas = loadAreas();
  } catch (err) {
    log.warn(`[VoiceCompanion] loadAreas 失败: ${(err as Error).message}`);
  }
  const delegationHistory = collectDelegationHistory(agents);
  const { lines, total, truncated } = buildAgentSnapshotLines(agents, areas, delegationHistory);
  const nowText = new Date().toLocaleString('zh-CN', { hour12: false });
  // 体积告警(P9):记忆是仅次于 agent 快照的 prompt 变项,超阈值先提示清理。
  const memoryChars = formatMemory(memory).length;
  if (memoryChars > MEMORY_WARN_CHARS) {
    log.warn(`[VoiceCompanion] 记忆注入体积偏大:${memoryChars} 字符 / ${memory.notes.length} 条笔记(阈值 ${MEMORY_WARN_CHARS}),建议清理`);
  }
  const bossNames = new Map<string, string>(agents.filter(isBossLikeAgent).map((a): [string, string] => [a.id, a.name]));
  return buildCompanionSystemPrompt({ agentLines: lines, totalAgents: total, truncated, memory, nowText, persona, delegationHistory, bossNames });
}

async function runHop1(
  userText: string,
  state: VoiceCompanionState,
  cfg: VoiceCompanionServerConfig,
  isEvent: boolean,
  stream?: { onTextDelta?: (fullText: string) => void; signal?: AbortSignal },
): Promise<Hop1Outcome> {
  const started = Date.now();
  const systemPrompt = buildSystemPromptFromWorld(state.memory, cfg.persona);
  // 体积打点(P5):agent 快照是 prompt 的最大变项,超预期先看这里。
  log.log(`[VoiceCompanion] system prompt ${systemPrompt.length} 字符`);

  const attempt = (resumeId: string | null) => callClaudeOnce(systemPrompt, userText, {
    model: cfg.model,
    resumeId,
    timeoutMs: cfg.hop1TimeoutMs,
    reminder: !!resumeId || !isEvent,
    onTextDelta: stream?.onTextDelta,
    signal: stream?.signal,
  });

  let result: ClaudeCallResult;
  try {
    result = await attempt(state.sessionId);
  } catch (err) {
    if (state.sessionId && isResumeRejection(err)) {
      log.warn(`[VoiceCompanion] --resume 被拒(session 已失效),清会话重试一次`);
      state.sessionId = null;
      state.sessionStartedAt = null;
      result = await attempt(null);
    } else {
      throw err;
    }
  }

  // 会话记账:记住 sessionId(turns/时间戳由调用方统一落盘)
  if (result.sessionId) {
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
  return { contract, degraded: false, newSessionId: result.sessionId, elapsedMs: Date.now() - started };
}

async function runHop2(
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

// ============================================================================
// Agent history excerpt (two-hop source material)
// ============================================================================

export async function fetchAgentOutputExcerpt(agentId: string): Promise<string> {
  const history = await agentService.getAgentHistory(agentId, HISTORY_MESSAGES, 0, false, 0);
  if (!history || history.messages.length === 0) return '(没有可用的会话记录)';
  const assistantTexts = history.messages
    .filter((m) => m.type === 'assistant' && typeof m.content === 'string' && m.content.trim())
    .slice(-HISTORY_EXCERPT_COUNT);
  if (assistantTexts.length === 0) return '(最近没有助手输出)';

  const parts: string[] = [];
  let total = 0;
  for (const m of assistantTexts) {
    let text = m.content.replace(/\s+/g, ' ').trim();
    if (text.length > HISTORY_ITEM_CHARS) text = `${text.slice(0, HISTORY_ITEM_CHARS)}…`;
    if (total + text.length > HISTORY_TOTAL_CHARS) break;
    parts.push(text);
    total += text.length;
  }
  return parts.join('\n---\n');
}

// ============================================================================
// 任务07·④ 委派树查询(query 目标为 Boss)
// ============================================================================

/** 读单个 Boss 的委派史:文件缺失/读取失败按空处理,不打断查询链路(与 collectDelegationHistory 同一降级口径)。 */
function readBossDelegationHistory(bossId: string): DelegationDecision[] {
  try {
    return bossService.getDelegationHistory(bossId);
  } catch (err) {
    log.warn(`[VoiceCompanion] 读取委派史失败(boss ${bossId}),按空处理: ${(err as Error).message}`);
    return [];
  }
}

/**
 * 把一条委派决策转成 hop2 材料的下属条目:
 * agent 已不在快照(被删/未加载)→ 名字回退委派记录、状态未知;
 * 历史读取失败 → 按「无产出」处理(材料会如实说暂无进展,不编造)。
 */
async function buildSubordinateQueryEntry(decision: DelegationDecision): Promise<SubordinateQueryEntry> {
  const subordinate = agentService.getAgent(decision.selectedAgentId);
  let excerpt: string;
  try {
    excerpt = await fetchAgentOutputExcerpt(decision.selectedAgentId);
  } catch (err) {
    log.warn(`[VoiceCompanion] 读取下属产出失败(${decision.selectedAgentId}),按无产出处理: ${(err as Error).message}`);
    excerpt = '';
  }
  // ⑦ 任务卡为可选字段(旧委派记录无卡) → 按无卡处理,绝不假定存在。
  const objective = decision.taskCard?.objective;
  return {
    agentId: decision.selectedAgentId,
    agentName: subordinate?.name ?? decision.selectedAgentName,
    status: subordinate?.status,
    taskCardObjective: typeof objective === 'string' && objective.trim() ? objective.trim() : undefined,
    userCommand: decision.userCommand,
    excerpt,
  };
}

/**
 * 🔴 决策观测点④ 查询链路:落一条 system_log(category='system' + source='voice-companion' +
 * body.cat='query-chain')。phase='request' 在请求入口即写,保证 hop2 卡住/中止时也有「查过谁」
 * 的证据(「查一下→没下文」复现依据);phase='failed' 走 warn 全量落盘。
 */
function logQueryChain(input: QueryChainLogInput, ctx: { sessionId?: string; taskId?: string }): void {
  logEvent('system', {
    source: 'voice-companion',
    sessionId: ctx.sessionId,
    taskId: ctx.taskId,
    level: input.phase === 'failed' ? 'warn' : 'info',
    body: buildQueryChainLogBody(input),
  });
}

// ============================================================================
// Dispatch
// ============================================================================

async function deliverToAgent(agent: Agent, message: string, delivery: CompanionDelivery): Promise<boolean> {
  const { runtimeService, bossMessageService } = await import('./index.js');
  const { buildCustomAgentConfig } = await import('../websocket/handlers/command-handler.js');

  let interrupted = false;
  if (delivery === 'interrupt' && ACTIVE_AGENT_STATUSES.has(agent.status)) {
    log.log(`[VoiceCompanion] 打断 ${agent.name}(${agent.id}) 当前工作`);
    try {
      // stopAgent 返回即该 agent 的进程槽已清、状态已置 idle(runner 内部负责
      // SIGINT → 500ms SIGTERM → 1500ms SIGKILL 的升级链),紧随其后的
      // sendCommand 直接拉起新回合,不再等固定 250ms(P9:打断延迟专项)。
      await runtimeService.stopAgent(agent.id);
      interrupted = true;
    } catch (err) {
      log.error(`[VoiceCompanion] stopAgent 失败: ${(err as Error).message}`);
    }
  }

  if (isBossLikeAgent(agent)) {
    // 委托消息带完整任务上下文:复用 buildBossMessage(团队快照 + Boss 指令注入)。
    const { message: bossMessage, systemPrompt } = await bossMessageService.buildBossMessage(agent.id, message);
    await runtimeService.sendCommand(agent.id, bossMessage, systemPrompt);
  } else {
    const customAgentConfig = buildCustomAgentConfig(agent.id, agent.class);
    await runtimeService.sendCommand(agent.id, message, undefined, undefined, customAgentConfig);
  }
  return interrupted;
}

/** list_agents 且模型没说人话时的确定性兜底汇报(不依赖模型)。 */
function buildAgentListFallback(): string {
  const agents = agentService.getAllAgents();
  if (agents.length === 0) return '现在还没有任何 agent。';
  const working = agents.filter((a) => ACTIVE_AGENT_STATUSES.has(a.status));
  const idleCount = agents.length - working.length;
  const names = working.slice(0, 4).map((a) => a.name).join('、');
  if (working.length === 0) return `现有 ${agents.length} 个 agent,都在空闲。`;
  const more = working.length > 4 ? '等' : '';
  return `现有 ${agents.length} 个 agent;${working.length} 个在忙:${names}${more};其余 ${idleCount} 个空闲。`;
}

// ============================================================================
// Mutex — serialize brain calls (user voice + proactive events)
// ============================================================================

let tail: Promise<unknown> = Promise.resolve();

function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  const result = tail.then(fn, fn);
  tail = result.catch(() => undefined);
  return result;
}

// ============================================================================
// Streaming speech pipeline (incremental responseToUser → gated sentences)
// ============================================================================

interface SpeechPipeline {
  onHop1Delta: (fullText: string) => void;
  onHop2Delta: (fullText: string) => void;
  setHop1Action: (action: CompanionAction) => void;
  releaseHop1: () => void;
  discardHop1: () => void;
  /** 收尾:取消宽限 flush 定时器(避免请求结束后残留计时器)。 */
  dispose: () => void;
  readonly spoke: boolean;
}

const GATE_ACTIONS = new Set<string>(COMPANION_ACTIONS);

/**
 * 悬尾标点宽限 flush(P5,180ms):模型把「第一句。」写完后若在句号处停顿
 * (继续写别的字段),正常切句会等下一个字符才吐句 —— 白白拖慢首句合成。
 * 每次增量后若没有新句产出就重新计时,静默满 180ms 才强吐「已带终结符」
 * 的悬尾句;未终结的余量不受影响(切句语义不变)。
 */
const GRACE_FLUSH_MS = 180;

/**
 * 分句流式播报管线:把 hop1/hop2 的文本增量变成「可播报的整句」,
 * 经 action 语义门控(SpeechGate)后逐句回调。无 onSentence 时返回全套
 * no-op —— 旧的整段返回路径零开销、行为不变。
 */
function createSpeechPipeline(onSentence?: (sentence: string) => void): SpeechPipeline {
  if (!onSentence) {
    return {
      onHop1Delta: () => {},
      onHop2Delta: () => {},
      setHop1Action: () => {},
      releaseHop1: () => {},
      discardHop1: () => {},
      dispose: () => {},
      get spoke() { return false; },
    };
  }

  const gate = new SpeechGate(onSentence);
  const hop1Stream = createJsonStringStream('responseToUser');
  let actionSeen = false;

  // hop2 的回复没有 action 字段(答案即可播内容):独立闸门,直接放行。
  const hop2Gate = new SpeechGate(onSentence);
  hop2Gate.setAction('general_response');
  const hop2Stream = createJsonStringStream('responseToUser');

  /** 给一条流挂宽限 flush 计时器(见 GRACE_FLUSH_MS 注释)。 */
  const makeGraceFlusher = (stream: JsonStringStream, emit: (s: string) => void) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    return {
      afterPush(sentences: string[]) {
        cancel();
        if (sentences.length > 0) return; // 已有整句吐出:余量必然无「可切终结符」
        timer = setTimeout(() => {
          timer = null;
          for (const s of stream.flushTerminated()) emit(s);
        }, GRACE_FLUSH_MS);
      },
      cancel,
    };
  };
  const hop1Grace = makeGraceFlusher(hop1Stream, (s) => gate.push(s));
  const hop2Grace = makeGraceFlusher(hop2Stream, (s) => hop2Gate.push(s));

  return {
    onHop1Delta(fullText: string) {
      if (!actionSeen) {
        // action 在契约最前面、枚举又短,通常第一句句号落下前就已确定;
        // 它没确定前句子先被 gate 缓冲,不会抢跑。
        const hit = findStringField(fullText, 'action');
        if (hit?.complete && GATE_ACTIONS.has(hit.value)) {
          actionSeen = true;
          gate.setAction(hit.value as GateAction);
        }
      }
      const sentences = hop1Stream.pushRaw(fullText);
      for (const s of sentences) gate.push(s);
      hop1Grace.afterPush(sentences);
    },
    onHop2Delta(fullText: string) {
      const sentences = hop2Stream.pushRaw(fullText);
      for (const s of sentences) hop2Gate.push(s);
      hop2Grace.afterPush(sentences);
    },
    setHop1Action(action: CompanionAction) {
      actionSeen = true;
      gate.setAction(action);
    },
    releaseHop1() {
      gate.release();
    },
    discardHop1() {
      gate.discard();
    },
    dispose() {
      hop1Grace.cancel();
      hop2Grace.cancel();
    },
    get spoke() {
      return gate.spoke || hop2Gate.spoke;
    },
  };
}

// ============================================================================
// 任务 27·尾 / 03·尾 接线（懒加载单例与入口辅助）
// ============================================================================

// 任务 27·尾：秘书个人记忆栈（JARVIS vault 四层,懒加载单例;观测经 logEvent 落 ⑭ system_log）。
let jarvisMemory: MemoryStack | undefined;
function getJarvisMemory(): MemoryStack {
  if (!jarvisMemory) jarvisMemory = createMemoryStack({ logEvent, channel: 'voice' });
  return jarvisMemory;
}

/** 任务 03·尾:从口语里挑日志分析时间窗(缺省昨天——P1「查一下昨天的日志」的典型口径)。 */
function pickLogWindowPreset(text: string): 'today' | 'yesterday' | 'last24h' | 'last7d' {
  if (/今天|今日/.test(text)) return 'today';
  if (/七天|7\s*天|一周|本周/.test(text)) return 'last7d';
  if (/24\s*小时|最近一天|近一天/.test(text)) return 'last24h';
  return 'yesterday';
}

// ============================================================================
// Main entry
// ============================================================================

/**
 * 处理一段最终文本(用户语音转写或 [系统事件])。返回给客户端用于播报的
 * response;模型超时/解析失败时降级为兜底话术(degraded=true),只有
 * spawn 失败(ENOENT 等)才抛出。
 */
export async function processVoiceInput(text: string, opts: VoiceProcessOptions = {}): Promise<VoiceProcessResult> {
  // 任务 02：语音回合是链路起点，runWithTrace 让本回合所有埋点共享 taskId/sessionId。
  return withMutex(async () => runWithTrace({ source: 'voice-companion' }, async () => {
    const speech = createSpeechPipeline(opts.onSentence);

    const started = Date.now();
    const cfg = loadServerConfig();
    const state = loadCompanionState();
    const personaKey = personaKeyOf(cfg.persona.preset, cfg.persona.custom);

    if (shouldRotateSession(state, cfg) || shouldRotateForPersona(state, personaKey)) {
      // 任务 27·尾 挂点2(会话结束):旧会话摘要先落工作记忆 + 生命周期裁剪,再清 session。
      if (state.sessionId) {
        await getJarvisMemory().engine.summarizeSession({ sessionId: state.sessionId, summary: state.memory.summary });
      }
      await getJarvisMemory().engine.sweep();
      log.log(`[VoiceCompanion] 会话轮换(turns=${state.turns}),保留记忆`);
      state.sessionId = null;
      state.sessionStartedAt = null;
      state.turns = 0;
    }
    state.personaKey = personaKey;

    // 任务 27·尾 挂点1(先写后回应):用户陈述命中触发词先落工作记忆再进 hop1;系统事件不算用户陈述。
    if (!opts.isEvent) {
      await getJarvisMemory().engine.captureUserTurn(text, { sessionId: state.sessionId ?? undefined });
    }

    // 任务 02 埋点：本回合 taskId 在此生成一次（对话 in/out、播报、委派共用同一时间线）。
    // 「任务类」与否由 hop1 判定，taskId 仅作关联 ID，纯聊天回合多一个 ID 无副作用。
    const taskId = ensureTaskId();
    logDialogMessage({
      direction: 'in',
      text,
      sessionId: state.sessionId ?? undefined,
      taskId,
      isEvent: !!opts.isEvent,
    });

    const finish = (r: VoiceProcessResult): VoiceProcessResult => {
      speech.dispose(); // 取消悬尾宽限计时器(正常收尾时未被触发的那次)
      if (speech.spoke) r.spoke = true;
      // 任务 02 埋点：回合最终回应 = 对话(out) + 播报(phase=server-sent，实际播放链路在客户端)
      if (r.response) {
        logDialogMessage({
          direction: 'out',
          text: r.response,
          sessionId: state.sessionId ?? undefined,
          taskId,
          action: r.action,
          degraded: r.degraded,
          targetAgentId: r.targetAgent?.id,
        });
        logBroadcast({
          text: r.response,
          phase: 'server-sent',
          action: r.action,
          degraded: r.degraded,
          sessionId: state.sessionId ?? undefined,
          taskId,
        });
      }
      return r;
    };

    let outcome: Hop1Outcome;
    try {
      outcome = await runHop1(text, state, cfg, !!opts.isEvent, {
        onTextDelta: speech.onHop1Delta,
        signal: opts.signal,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { name?: string };
      if (e.code === 'ENOENT') {
        speech.dispose();
        throw err; // 服务器没装 claude —— 配置问题,交给路由 500
      }
      if (e.name === 'VoiceCompanionAborted') {
        speech.dispose();
        throw err; // 客户端已断开:交给路由静默收尾
      }
      const shouldDegrade = e.name === 'VoiceCompanionTimeout'
        || e.name === 'VoiceCompanionParse'
        || /exited with code|No response from Claude/.test(e.message ?? '');
      if (!shouldDegrade) throw err;
      log.error(`[VoiceCompanion] hop1 降级: ${e.message}`);
      // 注意:超时/失败**不**重置会话。
      state.lastUsedAt = Date.now();
      saveCompanionState(state);
      return finish({ action: 'general_response', response: DEGRADED_RESPONSE, degraded: true, elapsedMs: Date.now() - started });
    }

    state.turns += 1;
    state.lastUsedAt = Date.now();
    // 任务 02：hop1 成功后 sessionId 才就绪（含 resume），回填链路上下文供后续埋点复用。
    updateTraceContext({ sessionId: state.sessionId ?? undefined });

    const { contract } = outcome;
    // 任务 27·尾 挂点3(模型确认):契约 memoryOps 双写进 vault;下方 applyMemoryOps 块保持原样(旧 CompanionMemory 独立运转)。
    if (contract.memoryOps.length > 0) {
      await getJarvisMemory().engine.bridgeVoiceMemoryOps(contract.memoryOps, { sessionId: state.sessionId ?? undefined });
    }
    // 流式期间若 action 尚未解析出来,这里兜底补上(缓冲的句子按语义放行/丢弃)。
    speech.setHop1Action(contract.action);
    let memoryOpsApplied = 0;
    if (contract.memoryOps.length > 0) {
      const { memory, applied, details } = applyMemoryOps(state.memory, contract.memoryOps, cfg.maxNotes);
      if (applied > 0) {
        state.memory = memory;
        memoryOpsApplied = applied;
        log.log(`[VoiceCompanion] 记忆更新 ${applied} 条(共 ${memory.notes.length} 条)`);
      }
      // 任务 02 埋点：系统活动 2 —— 每个 op 的生效明细与裁剪 droppedCount 全量落盘
      logMemoryOps({
        applied,
        details,
        notesTotal: state.memory.notes.length,
        droppedTotal: state.memory.droppedCount,
        sessionId: state.sessionId ?? undefined,
        channel: 'voice',
      });
    }
    saveCompanionState(state);

    const result: VoiceProcessResult = {
      action: contract.action,
      response: contract.responseToUser,
      memoryOpsApplied,
      elapsedMs: Date.now() - started,
    };

    if (contract.action === 'delegate_to_boss'
      || (contract.action === 'send_to_agent' && contract.targetAgentId)) {
      // 改① 任务只走 Boss:delegate_to_boss 目标固定为主管;send_to_agent 仅主管可达,
      // 模型若仍指向普通 agent(旧会话/回归)→ 违规告警(决策观测点①)+ 改道主管,
      // 保住「全走 Boss」不变式,而不是静默直派或丢任务。
      const route = resolveDispatchRoute(contract.action, contract.targetAgentId, agentService.getAllAgents());

      if (route.route === 'missing') {
        // 没派出去就不能播「已让 X 去做」——丢弃缓冲,整段走 result.response 兜底。
        speech.discardHop1();
        result.response = contract.responseToUser || `没找到这个 agent(${contract.targetAgentName || contract.targetAgentId})。`;
        return finish(result);
      }

      if (route.violation) {
        // 🔴 决策观测点①:违规直派告警(warn 全量落盘,供 ⑮ 分析不变式是否被破)
        logDelegation({
          phase: 'blocked',
          level: 'warn',
          channel: 'voice-companion',
          toAgentId: route.violation.requestedAgentId,
          toAgentName: route.violation.requestedAgentName ?? undefined,
          message: contract.messageToAgent,
          delivery: contract.delivery,
          status: 'direct-dispatch-blocked',
          error: `violation: ${contract.action} 请求直派普通 agent(${route.violation.requestedAgentId}),已改道主管`,
          routedBy: contract.action,
          taskId,
          sessionId: state.sessionId ?? undefined,
        });
      }

      if (!contract.messageToAgent) {
        speech.discardHop1();
        result.response = contract.responseToUser || '我没听清要让它做什么,请再说一遍。';
        return finish(result);
      }
      if (route.route === 'no_boss') {
        // 任务语义但没有可转交的主管:如实告知,不派给任何普通 agent。
        speech.discardHop1();
        result.response = '团队里还没有主管(Boss),这事我暂时派不出去。先在团队里设一个主管,再让我派活吧。';
        logDelegation({
          phase: 'failed',
          channel: 'voice-companion',
          message: contract.messageToAgent,
          status: 'no-boss',
          error: 'no-boss-agent',
          routedBy: contract.action,
          taskId,
          sessionId: state.sessionId ?? undefined,
        });
        return finish(result);
      }

      const target = route.agent;
      // 违规改道不携带打断语义:打断决定是针对被请求的普通 agent 做的,转到主管一律 queue。
      const delivery: CompanionDelivery = route.violation ? 'queue' : contract.delivery;
      let interrupted: boolean;
      try {
        interrupted = await deliverToAgent(target, contract.messageToAgent, delivery);
      } catch (err) {
        // 任务 02 埋点：基础四类 ③ —— 派活失败行（channel 与成功行一致，原错误继续上抛）
        logDelegation({
          phase: 'failed',
          channel: 'voice-companion',
          toAgentId: target.id,
          toAgentName: target.name,
          message: contract.messageToAgent,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          routedBy: contract.action,
          taskId,
          sessionId: state.sessionId ?? undefined,
        });
        throw err;
      }
      result.targetAgent = { id: target.id, name: target.name };
      result.messageSent = contract.messageToAgent;
      result.delivery = delivery;
      result.interrupted = interrupted;
      // 任务 02 埋点：基础四类 ③ —— 派活出站（voice-companion 渠道）;
      // routedBy 记录路由判定(决策观测点①:请求 → 目标 Boss)。
      logDelegation({
        phase: 'dispatched',
        channel: 'voice-companion',
        toAgentId: target.id,
        toAgentName: target.name,
        message: contract.messageToAgent,
        delivery,
        interrupted,
        status: route.violation ? 'rerouted-to-boss' : undefined,
        routedBy: route.violation ? `${contract.action}-rerouted` : contract.action,
        taskId,
        sessionId: state.sessionId ?? undefined,
      });
      if (route.violation) {
        // 模型话术多半指名了被拒的普通 agent,不可信 → 丢弃缓冲,用确定性话术整段兜底。
        speech.discardHop1();
        result.response = `我只能把任务交给主管「${target.name}」安排,已经转过去了。`;
      } else if (!result.response) {
        result.response = interrupted
          ? `已打断 ${target.name},改用新任务。`
          : contract.action === 'delegate_to_boss'
            ? `已交给主管「${target.name}」安排。`
            : `已让 ${target.name} 去做。`;
      }
      // 派发成功,放行缓冲的确认话术(「已让 X …」/「已交给主管…」)。
      speech.releaseHop1();
      log.log(`[VoiceCompanion] → ${target.name}(${delivery}${interrupted ? ',已打断' : ''}${route.violation ? ',违规改道' : ''}): ${contract.messageToAgent}`);
      return finish(result);
    }

    if (contract.action === 'query_agent_output' && contract.targetAgentId) {
      const queryStartedAt = Date.now();
      const question = contract.query || text;
      const requestPreview = truncate(question, QUERY_LOG_PREVIEW_CHARS);
      const logCtx = { sessionId: state.sessionId ?? undefined, taskId };
      const target = agentService.getAgent(contract.targetAgentId);
      const route = planQueryRoute(target);

      // 🔴 决策观测点④:请求入口 + 路由判定先落一条 —— hop 卡住/中止时仍有「查过谁」的证据。
      logQueryChain({
        phase: 'request',
        request: requestPreview,
        route,
        targetAgentId: target?.id ?? contract.targetAgentId,
        targetName: target?.name ?? contract.targetAgentName ?? undefined,
      }, logCtx);

      if (!target) {
        speech.discardHop1();
        result.response = contract.responseToUser || `没找到这个 agent(${contract.targetAgentName || contract.targetAgentId})。`;
        logQueryChain({
          phase: 'completed',
          request: requestPreview,
          route: 'no-target',
          targetAgentId: contract.targetAgentId,
          targetName: contract.targetAgentName ?? undefined,
          hops: 1,
          durationMs: Date.now() - queryStartedAt,
          responsePreview: truncate(result.response, QUERY_LOG_PREVIEW_CHARS),
        }, logCtx);
        return finish(result);
      }

      // 任务07·④:目标是 Boss 时不再只取它自己的 excerpt(旧的 Boss 历史只有调度文本),
      // 改为解析委派树 —— 最近委派 → 每个下属的 assistant 产出 → 汇总材料(边界:只查最近委派)。
      let material: string | null = null;
      let subordinateIds: string[] | undefined;
      if (route === 'boss-tree') {
        const recent = pickRecentDelegations(readBossDelegationHistory(target.id));
        if (recent.length === 0) {
          // 行为定义 3:无委派记录 → 如实告知,不跑 hop2(确定性话术,防模型编造)。
          speech.discardHop1();
          result.response = buildNoDelegationResponse(target.name);
          result.targetAgent = { id: target.id, name: target.name };
          logQueryChain({
            phase: 'completed',
            request: requestPreview,
            route,
            targetAgentId: target.id,
            targetName: target.name,
            subordinateIds: [],
            hops: 1,
            durationMs: Date.now() - queryStartedAt,
            responsePreview: truncate(result.response, QUERY_LOG_PREVIEW_CHARS),
          }, logCtx);
          return finish(result);
        }
        const entries = await Promise.all(recent.map((d) => buildSubordinateQueryEntry(d)));
        material = buildDelegationQueryMaterial({ bossName: target.name, entries });
        subordinateIds = entries.map((e) => e.agentId);
      }

      const excerpt = material ?? await fetchAgentOutputExcerpt(target.id);
      const hop2Started = Date.now();
      try {
        const answer = await runHop2(
          question,
          target.name,
          target.status,
          target.taskLabel || target.lastAssignedTask,
          target.lastError,
          excerpt,
          cfg,
          { onTextDelta: speech.onHop2Delta, signal: opts.signal },
        );
        result.response = answer;
        logQueryChain({
          phase: 'completed',
          request: requestPreview,
          route,
          targetAgentId: target.id,
          targetName: target.name,
          subordinateIds,
          hops: 2,
          durationMs: Date.now() - queryStartedAt,
          responsePreview: truncate(answer, QUERY_LOG_PREVIEW_CHARS),
        }, logCtx);
      } catch (err) {
        if (err instanceof VoiceCompanionAbortedError) {
          speech.dispose();
          throw err;
        }
        log.warn(`[VoiceCompanion] hop2 失败,用确定性摘要: ${(err as Error).message}`);
        result.response = `「${target.name}」最近的输出:${excerpt.slice(0, 160)}${excerpt.length > 160 ? '…' : ''}`;
        result.degraded = true;
        // 🔴④ 降级路径也要留痕(否则「查一下→没下文」无从复现)。
        logQueryChain({
          phase: 'failed',
          request: requestPreview,
          route,
          targetAgentId: target.id,
          targetName: target.name,
          subordinateIds,
          hops: 2,
          durationMs: Date.now() - queryStartedAt,
          responsePreview: truncate(result.response, QUERY_LOG_PREVIEW_CHARS),
          degraded: true,
          error: (err as Error).message,
        }, logCtx);
      }
      result.secondHopMs = Date.now() - hop2Started;
      result.targetAgent = { id: target.id, name: target.name };
      return finish(result);
    }

    if (contract.action === 'analyze_logs') {
      // 任务 03·尾:⑮ P1 手动日志分析(秘书自留区只读查询;不走 ① 委派通道、不计 ⑫ 配额)。
      const analysisStarted = Date.now();
      try {
        const report = await runLogAnalysis({
          preset: pickLogWindowPreset(`${contract.query ?? ''} ${text}`),
          signal: opts.signal,
        });
        result.response = renderLogAnalysisReport(report);
      } catch (err) {
        if (err instanceof VoiceCompanionAbortedError) {
          speech.dispose();
          throw err;
        }
        log.warn(`[VoiceCompanion] 日志分析失败: ${(err as Error).message}`);
        result.response = '日志分析没能完成,过会儿再喊我查一次。';
        result.degraded = true;
      }
      result.secondHopMs = Date.now() - analysisStarted;
      return finish(result);
    }

    if (BOLBA_CONTRACT_ACTIONS.has(contract.action)) {
      // 任务13·⑩ 秘书 Bolba 桥:业务待办的查/建/完成/重开。
      // 两本账边界:这里只碰 Bolba 账本,绝不走 ① 委派通道。
      // hop1 话术由 SpeechGate 的显式 Bolba 门丢弃;结果由服务端确定性产出
      // (handleBolbaContractAction 内部兜底,永不抛),degraded 如实透传。
      const bolbaStartedAt = Date.now();
      speech.discardHop1();
      const outcome = await handleBolbaContractAction({
        action: contract.action as BolbaContractAction,
        userText: text,
        contract: { bolbaTask: contract.bolbaTask, query: contract.query },
        now: new Date(),
      });
      result.response = outcome.response;
      result.degraded = outcome.degraded;
      result.secondHopMs = Date.now() - bolbaStartedAt;
      return finish(result);
    }

    if (contract.action === 'noop') {
      result.response = '';
      return finish(result);
    }

    // list_agents / general_response:直接播报 responseToUser;
    // 模型偶尔会照抄模板留空 —— 用确定性摘要兜底,保证有话说。
    // (send/query 缺 targetAgentId 的畸形契约也会落到这里:缓冲丢弃,
    //  由 spoke=false 让客户端按 result.response 整段补播。)
    speech.discardHop1();
    if (!result.response) {
      if (contract.action === 'list_agents') {
        result.response = buildAgentListFallback();
      } else {
        result.response = '嗯,我在。';
      }
    }
    return finish(result);
  }));
}

/**
 * 任务13·⑩:非用户回合的主动播报出口(供 Bolba 到期提醒复用)。
 *
 * 复用回合出口 finish() 的同两条通道(dialog out + broadcast/server-sent),
 * 不新建队列、不碰客户端;action 字段供 ⑭ system_log 观测筛选。
 * 注意:服务端目前没有真正的「推送到客户端语音」通道,这里落的是与普通回合
 * 同形态的登记(客户端若接推送可从此通道消费)。
 */
export function logProactiveBroadcast(input: {
  text: string;
  action: string;
  degraded?: boolean;
  sessionId?: string;
  taskId?: string;
}): void {
  logDialogMessage({
    direction: 'out',
    text: input.text,
    sessionId: input.sessionId,
    taskId: input.taskId,
    action: input.action,
    degraded: input.degraded,
  });
  logBroadcast({
    text: input.text,
    phase: 'server-sent',
    action: input.action,
    degraded: input.degraded,
    sessionId: input.sessionId,
    taskId: input.taskId,
  });
}

// ============================================================================
// Status / reset / memory management (for the route + settings panel)
// ============================================================================

export function getCompanionStatus(): {
  hasSession: boolean;
  turns: number;
  sessionStartedAt: number | null;
  lastUsedAt: number | null;
  model: 'haiku' | 'sonnet';
  memory: { summary: string; notes: CompanionMemoryNote[]; updatedAt: number; droppedCount: number };
} {
  const state = loadCompanionState();
  const cfg = loadServerConfig();
  return {
    hasSession: !!state.sessionId,
    turns: state.turns,
    sessionStartedAt: state.sessionStartedAt,
    lastUsedAt: state.lastUsedAt,
    model: cfg.model,
    memory: state.memory,
  };
}

export function resetCompanion(options: { keepMemory?: boolean } = {}): void {
  const state = loadCompanionState();
  state.sessionId = null;
  state.sessionStartedAt = null;
  state.turns = 0;
  if (!options.keepMemory) state.memory = { ...structuredClone(DEFAULT_MEMORY) };
  saveCompanionState(state);
  log.log(`[VoiceCompanion] 会话重置(keepMemory=${options.keepMemory !== false})`);
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
  }
  saveCompanionState(state);
  return state.memory;
}
