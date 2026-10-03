/**
 * Voice Companion Service
 *
 * 「语音伙伴」的服务端大脑:持续聆听模式下,客户端把每一段最终转写文本
 * (或合并后的 agent 事件)发到这里,由本服务完成:
 *
 *   1. 调用 claude(headless,haiku/sonnet,--resume 持久会话)理解意图;
 *   2. 模型按要求只输出一份 JSON 契约(action / targetAgentId / delivery /
 *      responseToUser / memoryOps …);
 *   3. 按契约执行:派活给 agent(默认排队,急迫语义才打断)、查询 agent 最近
 *      输出(第二跳 claude 总结)、列 agent、纯聊天;
 *   4. 维护跨会话的持久记忆(notes + summary),每轮注入系统提示词。
 *
 * 设计要点:
 * - 会话状态与记忆落盘 ~/.local/share/tide-commander/voice-companion.json(tmp+rename);
 * - 超时**不**重置会话(与作者旧 voice-assistant 路由相反,新会话由轮数/天数轮换);
 * - --resume 被拒(session 文件丢失)→ 清会话重试一次;
 * - 打断走 runtimeService.stopAgent + sendCommand(Claude 无 interruptTurn,
 *   forceInterrupt 对其无效);
 * - 单一互斥队列:主动汇报与用户语音不会并发两次 claude 调用。
 *
 * 纯函数(parseContractJson / applyMemoryOps / buildAgentSnapshotLines /
 * shouldRotateSession)导出以便单测;IO 部分保持薄。
 */

import { spawn, type ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ClaudeBackend } from '../claude/index.js';
import * as agentService from './agent-service.js';
import { loadAreas } from '../data/index.js';
import { logger, sanitizeUnicode } from '../utils/index.js';
import type { Agent } from '../../shared/agent-types.js';
import type { DrawingArea } from '../../shared/common-types.js';

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
  memory: CompanionMemory;
}

export type CompanionAction =
  | 'general_response'
  | 'send_to_agent'
  | 'list_agents'
  | 'query_agent_output'
  | 'noop';

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
  responseToUser: string;
  memoryOps: VoiceMemoryOp[];
}

export interface VoiceProcessOptions {
  /** true = 由客户端主动汇报模块送来的 [系统事件] 文本(noop 时保持安静)。 */
  isEvent?: boolean;
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
  elapsedMs: number;
}

export interface VoiceCompanionServerConfig {
  model: 'haiku' | 'sonnet';
  hop1TimeoutMs: number;
  hop2TimeoutMs: number;
  maxTurns: number;
  sessionMaxAgeDays: number;
  maxNotes: number;
}

export const DEFAULT_SERVER_CONFIG: VoiceCompanionServerConfig = {
  model: 'haiku',
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
  memory: DEFAULT_MEMORY,
};

/** Agent 状态里算「正在干活」(打断有代价)的三种。 */
export const ACTIVE_AGENT_STATUSES = new Set(['working', 'waiting', 'waiting_permission']);

const NOTES_MAX_TEXT = 300;
const SUMMARY_MAX_TEXT = 1500;
const MAX_SNAPSHOT_AGENTS = 60;
const TASK_TRUNCATE = 60;
const ERROR_TRUNCATE = 80;
const HISTORY_MESSAGES = 30;
const HISTORY_EXCERPT_COUNT = 6;
const HISTORY_ITEM_CHARS = 400;
const HISTORY_TOTAL_CHARS = 1500;

const STATE_FILE = path.join(os.homedir(), '.local/share/tide-commander/voice-companion.json');
const CONFIG_FILE = path.join(process.cwd(), 'tools/voice-companion/config.json');

const DEGRADED_RESPONSE = '抱歉,我这会儿没听清,请再说一遍。';

// ============================================================================
// Config / state IO
// ============================================================================

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 读取 tools/voice-companion/config.json(服务端只关心 model / brain.*);缺失回默认。 */
export function loadServerConfig(): VoiceCompanionServerConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_SERVER_CONFIG };
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    const brain = raw?.brain ?? {};
    return {
      model: raw?.model === 'sonnet' ? 'sonnet' : 'haiku',
      hop1TimeoutMs: clampNumber(brain.hop1TimeoutMs, 5_000, 180_000, DEFAULT_SERVER_CONFIG.hop1TimeoutMs),
      hop2TimeoutMs: clampNumber(brain.hop2TimeoutMs, 5_000, 180_000, DEFAULT_SERVER_CONFIG.hop2TimeoutMs),
      maxTurns: clampNumber(brain.maxTurns, 10, 2_000, DEFAULT_SERVER_CONFIG.maxTurns),
      sessionMaxAgeDays: clampNumber(brain.sessionMaxAgeDays, 1, 365, DEFAULT_SERVER_CONFIG.sessionMaxAgeDays),
      maxNotes: clampNumber(brain.maxNotes, 5, 200, DEFAULT_SERVER_CONFIG.maxNotes),
    };
  } catch (err) {
    log.warn(`[VoiceCompanion] config.json 读取失败,用默认配置: ${(err as Error).message}`);
    return { ...DEFAULT_SERVER_CONFIG };
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
      resourceId: sanitizeCredential(volc?.resourceId) || DEFAULT_VOLCENGINE_STT_CONFIG.resourceId,
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

  const validActions: CompanionAction[] = [
    'general_response', 'send_to_agent', 'list_agents', 'query_agent_output', 'noop',
  ];
  const action = validActions.includes(obj.action as CompanionAction)
    ? (obj.action as CompanionAction)
    : 'general_response';

  const contract: VoiceContract = {
    action,
    targetAgentId: typeof obj.targetAgentId === 'string' && obj.targetAgentId.trim() ? obj.targetAgentId.trim() : null,
    targetAgentName: typeof obj.targetAgentName === 'string' && obj.targetAgentName.trim() ? obj.targetAgentName.trim() : null,
    messageToAgent: typeof obj.messageToAgent === 'string' ? obj.messageToAgent.trim() : '',
    delivery: obj.delivery === 'interrupt' ? 'interrupt' : 'queue',
    query: typeof obj.query === 'string' ? obj.query.trim() : '',
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
 */
export function applyMemoryOps(
  memory: CompanionMemory,
  ops: VoiceMemoryOp[] | undefined,
  maxNotes: number,
  now: number = Date.now(),
): { memory: CompanionMemory; applied: number } {
  if (!ops || ops.length === 0) return { memory, applied: 0 };

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
      if (text.length < 2) continue;
      const dup = next.notes.some((n) => n.text.toLowerCase() === text.toLowerCase());
      if (dup) continue;
      while (next.notes.length >= maxNotes) {
        const autoIdx = next.notes.findIndex((n) => n.source === 'auto');
        next.notes.splice(autoIdx === -1 ? 0 : autoIdx, 1);
        next.droppedCount++;
      }
      next.notes.push({ id: newNoteId(now), text, createdAt: now, source: 'user' });
      applied++;
    } else if (op.op === 'remove' && typeof op.id === 'string') {
      const before = next.notes.length;
      next.notes = next.notes.filter((n) => n.id !== op.id);
      if (next.notes.length !== before) applied++;
    } else if (op.op === 'setSummary' && typeof op.summary === 'string') {
      const summary = op.summary.trim().slice(0, SUMMARY_MAX_TEXT);
      if (summary !== next.summary) {
        next.summary = summary;
        applied++;
      }
    }
  }

  if (applied === 0) return { memory, applied: 0 };
  return { memory: next, applied };
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

/** 快照用的 agent 结构子集(Agent 天然满足,测试可造轻量对象)。 */
export interface SnapshotAgent {
  id: string;
  name: string;
  class?: string;
  status: string;
  isBoss?: boolean;
  taskLabel?: string;
  lastAssignedTask?: string;
  lastError?: string;
  lastWorkedAt?: number;
  lastActivity?: number;
}

/**
 * 把 agent 列表压缩成 prompt 里的一行一个:按最近活动排序、截断、上限 60。
 * 同时返回是否发生了截断(供 prompt 说明)。
 */
export function buildAgentSnapshotLines(
  agents: readonly SnapshotAgent[],
  areas: readonly DrawingArea[],
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

  const sorted = [...agents].sort((a, b) => {
    const at = a.lastWorkedAt ?? a.lastActivity ?? 0;
    const bt = b.lastWorkedAt ?? b.lastActivity ?? 0;
    if (bt !== at) return bt - at;
    return a.name.localeCompare(b.name);
  });

  const selected = sorted.slice(0, MAX_SNAPSHOT_AGENTS);
  const lines = selected.map((a) => {
    const parts = [`- ${a.name} | id: ${a.id} | ${a.class ?? 'unknown'} | ${a.status}`];
    if (a.isBoss) parts.push('[BOSS]');
    const agentAreas = areasByAgent.get(a.id);
    if (agentAreas?.length) parts.push(`[区域: ${agentAreas.join('、')}]`);
    const task = a.taskLabel || a.lastAssignedTask;
    if (task) parts.push(`| 任务: ${truncate(task, TASK_TRUNCATE)}`);
    if (a.lastError) parts.push(`| 最近错误: ${truncate(a.lastError, ERROR_TRUNCATE)}`);
    return parts.join(' ');
  });

  return { lines, total: sorted.length, truncated: sorted.length > selected.length };
}

function formatMemory(memory: CompanionMemory): string {
  const parts: string[] = [];
  if (memory.summary.trim()) parts.push(`总结: ${memory.summary.trim()}`);
  if (memory.notes.length > 0) {
    parts.push(memory.notes.map((n) => `- [${n.id}] ${n.text}`).join('\n'));
  }
  return parts.length > 0 ? parts.join('\n') : '(暂无)';
}

const CONTRACT_TEMPLATE = '{"action":"general_response|send_to_agent|list_agents|query_agent_output|noop",'
  + '"targetAgentId":null,"targetAgentName":null,"messageToAgent":"","delivery":"queue|interrupt",'
  + '"query":"","responseToUser":"","memoryOps":[]}';

/** 组装 hop1 系统提示词:角色 + 契约 + 规则 + 记忆 + agent 快照。 */
export function buildCompanionSystemPrompt(input: {
  agentLines: string[];
  totalAgents: number;
  truncated: boolean;
  memory: CompanionMemory;
  nowText: string;
}): string {
  const { agentLines, totalAgents, truncated, memory, nowText } = input;
  const agentsBlock = agentLines.length > 0
    ? agentLines.join('\n') + (truncated ? `\n(仅显示最近活动的 ${agentLines.length} 个,共 ${totalAgents} 个)` : '')
    : '(暂无 agent)';

  return `你是 Tide Commander(多 AI agent 指挥台)的语音伙伴,代号「小伴」。老板通过语音和你说话;你负责:聊天、把任务派给合适的 agent、查询 agent 的进展与产出、记住老板的长期偏好。

【输出格式】只输出一个 JSON 对象,不要 markdown、不要解释、不要代码块:
${CONTRACT_TEMPLATE}

上面的模板只是字段格式示意:其中 responseToUser 是给老板播报的实际句子,**除 noop 动作外绝不允许为空字符串**。

【action 说明】
- send_to_agent: 老板要求某个 agent 做事。targetAgentId 填下方列表里的 id;messageToAgent 写成给该 agent 的完整指令(写清要做什么、在哪个项目/目录);delivery 默认 "queue"。
- query_agent_output: 老板问某个 agent「最近做了什么/进展如何/结果是什么/输出了什么」。targetAgentId 填该 agent;query 填老板的原始问题。此动作下 responseToUser 可留空,系统会做第二跳总结。
- list_agents: 老板想了解有哪些 agent、谁在忙、某类状态如何。必须用 responseToUser 口头汇报概况(数量、谁在忙、谁空闲),不超过 60 字。
- general_response: 寒暄、问你自己、其它无需操作的对话。必须给出 responseToUser。
- noop: 输入以 [系统事件] 开头且没有值得汇报的内容时使用,responseToUser 留空字符串。

【打断规则(重要)】只有老板明确说出「马上/立刻/现在就/停下/别做了/改用/先别管这个」等急迫语义时,delivery 才填 "interrupt"——这会打断目标 agent 正在进行的工作,代价很大。其它一切情况(催促、补充、追问)都用 "queue"。目标不在 working/waiting 状态时也照填,系统会自行处理。若实际发生了打断,responseToUser 要说明「已打断 X」。

【记忆规则】memoryOps 数组,可多可空:
- {"op":"add","text":"…"}: 老板表达了稳定的偏好/称呼/习惯/长期规则(例如「叫我老板」「汇报先说结论」「以后用中文」)。只记长期信息,不要记一次性任务内容。
- {"op":"remove","id":"…"}: 老板要求忘记某条(用下方记忆列表里的 id)。
- {"op":"setSummary","summary":"…"}: 压缩重写记忆总结(很少用)。
没有新记忆时 memoryOps 为 []。

【说话风格】除 noop 和 query_agent_output 外,responseToUser 一律不能为空;用与老板相同的语言;1-2 句、口语化、不超过 60 字;不要 emoji、不要 markdown、不要列表。派活时说「已让 X …」。

【当前时间】${nowText}

【长期记忆】
${formatMemory(memory)}

【agent 列表】(共 ${totalAgents} 个)
${agentsBlock}`;
}

const HOP2_SYSTEM_PROMPT = `你是语音助手的结果查询模块。基于下方给出的 agent 输出记录,直接回答老板的问题。
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
  opts: { model: string; resumeId?: string | null; timeoutMs: number; reminder?: boolean },
): Promise<ClaudeCallResult> {
  return new Promise((resolve, reject) => {
    const executable = claudeBackend.getExecutablePath();
    const args = [
      '--print',
      '--verbose',
      '--model', opts.model,
      '--output-format', 'stream-json',
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
    let textOutput = '';
    let newSessionId: string | null = null;
    let stderrBuf = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, 5_000);
      killTimer.unref?.();
      cleanup();
      const err = new Error(`Claude timed out after ${opts.timeoutMs}ms`);
      err.name = 'VoiceCompanionTimeout';
      reject(err);
    }, opts.timeoutMs);

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
              if (block.type === 'text' && block.text) textOutput += block.text;
            }
          }
          if (event.type === 'stream_event' && event.event?.type === 'content_block_delta') {
            if (event.event.delta?.type === 'text_delta' && event.event.delta.text) {
              textOutput += event.event.delta.text;
            }
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
      clearTimeout(timeout);
      cleanup();
      const remaining = buffer + decoder.end();
      if (remaining.trim()) {
        try {
          const event = JSON.parse(remaining);
          if (event.type === 'system' && event.session_id) newSessionId = event.session_id;
        } catch { /* ignore */ }
      }
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
      clearTimeout(timeout);
      cleanup();
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

function buildSystemPromptFromWorld(memory: CompanionMemory): string {
  const agents = agentService.getAllAgents();
  let areas: DrawingArea[] = [];
  try {
    areas = loadAreas();
  } catch (err) {
    log.warn(`[VoiceCompanion] loadAreas 失败: ${(err as Error).message}`);
  }
  const { lines, total, truncated } = buildAgentSnapshotLines(agents, areas);
  const nowText = new Date().toLocaleString('zh-CN', { hour12: false });
  return buildCompanionSystemPrompt({ agentLines: lines, totalAgents: total, truncated, memory, nowText });
}

async function runHop1(
  userText: string,
  state: VoiceCompanionState,
  cfg: VoiceCompanionServerConfig,
  isEvent: boolean,
): Promise<Hop1Outcome> {
  const started = Date.now();
  const systemPrompt = buildSystemPromptFromWorld(state.memory);

  const attempt = (resumeId: string | null) => callClaudeOnce(systemPrompt, userText, {
    model: cfg.model,
    resumeId,
    timeoutMs: cfg.hop1TimeoutMs,
    reminder: !!resumeId || !isEvent,
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

  const contract = parseContractJson(result.text);
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
// Dispatch
// ============================================================================

async function deliverToAgent(agent: Agent, message: string, delivery: CompanionDelivery): Promise<boolean> {
  const { runtimeService, bossMessageService } = await import('./index.js');
  const { buildCustomAgentConfig } = await import('../websocket/handlers/command-handler.js');

  let interrupted = false;
  if (delivery === 'interrupt' && ACTIVE_AGENT_STATUSES.has(agent.status)) {
    log.log(`[VoiceCompanion] 打断 ${agent.name}(${agent.id}) 当前工作`);
    try {
      await runtimeService.stopAgent(agent.id);
      interrupted = true;
      // 给进程收尾留一点时间,避免旧进程未退干净时立刻拉起新回合。
      await new Promise((r) => setTimeout(r, 250));
    } catch (err) {
      log.error(`[VoiceCompanion] stopAgent 失败: ${(err as Error).message}`);
    }
  }

  if (agent.isBoss || agent.class === 'boss') {
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
// Main entry
// ============================================================================

/**
 * 处理一段最终文本(用户语音转写或 [系统事件])。返回给客户端用于播报的
 * response;模型超时/解析失败时降级为兜底话术(degraded=true),只有
 * spawn 失败(ENOENT 等)才抛出。
 */
export async function processVoiceInput(text: string, opts: VoiceProcessOptions = {}): Promise<VoiceProcessResult> {
  return withMutex(async () => {
    const started = Date.now();
    const cfg = loadServerConfig();
    const state = loadCompanionState();

    if (shouldRotateSession(state, cfg)) {
      log.log(`[VoiceCompanion] 会话轮换(turns=${state.turns}),保留记忆`);
      state.sessionId = null;
      state.sessionStartedAt = null;
      state.turns = 0;
    }

    let outcome: Hop1Outcome;
    try {
      outcome = await runHop1(text, state, cfg, !!opts.isEvent);
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { name?: string };
      if (e.code === 'ENOENT') throw err; // 服务器没装 claude —— 配置问题,交给路由 500
      const degradedMsg = e.name === 'VoiceCompanionTimeout' || /exited with code|No response from Claude/.test(e.message ?? '');
      if (!degradedMsg) throw err;
      log.error(`[VoiceCompanion] hop1 降级: ${e.message}`);
      // 注意:超时/失败**不**重置会话。
      state.lastUsedAt = Date.now();
      saveCompanionState(state);
      return { action: 'general_response', response: DEGRADED_RESPONSE, degraded: true, elapsedMs: Date.now() - started };
    }

    state.turns += 1;
    state.lastUsedAt = Date.now();

    const { contract } = outcome;
    let memoryOpsApplied = 0;
    if (contract.memoryOps.length > 0) {
      const { memory, applied } = applyMemoryOps(state.memory, contract.memoryOps, cfg.maxNotes);
      if (applied > 0) {
        state.memory = memory;
        memoryOpsApplied = applied;
        log.log(`[VoiceCompanion] 记忆更新 ${applied} 条(共 ${memory.notes.length} 条)`);
      }
    }
    saveCompanionState(state);

    const result: VoiceProcessResult = {
      action: contract.action,
      response: contract.responseToUser,
      memoryOpsApplied,
      elapsedMs: Date.now() - started,
    };

    if (contract.action === 'send_to_agent' && contract.targetAgentId) {
      const target = agentService.getAgent(contract.targetAgentId);
      if (!target) {
        result.response = contract.responseToUser || `没找到这个 agent(${contract.targetAgentName || contract.targetAgentId})。`;
        return result;
      }
      if (!contract.messageToAgent) {
        result.response = contract.responseToUser || '我没听清要让它做什么,请再说一遍。';
        return result;
      }
      const interrupted = await deliverToAgent(target, contract.messageToAgent, contract.delivery);
      result.targetAgent = { id: target.id, name: target.name };
      result.messageSent = contract.messageToAgent;
      result.delivery = contract.delivery;
      result.interrupted = interrupted;
      if (!result.response) {
        result.response = interrupted
          ? `已打断 ${target.name},改用新任务。`
          : `已让 ${target.name} 去做。`;
      }
      log.log(`[VoiceCompanion] → ${target.name}(${contract.delivery}${interrupted ? ',已打断' : ''}): ${contract.messageToAgent}`);
      return result;
    }

    if (contract.action === 'query_agent_output' && contract.targetAgentId) {
      const target = agentService.getAgent(contract.targetAgentId);
      if (!target) {
        result.response = contract.responseToUser || `没找到这个 agent(${contract.targetAgentName || contract.targetAgentId})。`;
        return result;
      }
      const excerpt = await fetchAgentOutputExcerpt(target.id);
      const hop2Started = Date.now();
      try {
        const answer = await runHop2(
          contract.query || text,
          target.name,
          target.status,
          target.taskLabel || target.lastAssignedTask,
          target.lastError,
          excerpt,
          cfg,
        );
        result.response = answer;
      } catch (err) {
        log.warn(`[VoiceCompanion] hop2 失败,用确定性摘要: ${(err as Error).message}`);
        result.response = `「${target.name}」最近的输出:${excerpt.slice(0, 160)}${excerpt.length > 160 ? '…' : ''}`;
        result.degraded = true;
      }
      result.secondHopMs = Date.now() - hop2Started;
      result.targetAgent = { id: target.id, name: target.name };
      return result;
    }

    if (contract.action === 'noop') {
      result.response = '';
      return result;
    }

    // list_agents / general_response:直接播报 responseToUser;
    // 模型偶尔会照抄模板留空 —— 用确定性摘要兜底,保证有话说。
    if (!result.response) {
      if (contract.action === 'list_agents') {
        result.response = buildAgentListFallback();
      } else {
        result.response = '嗯,我在。';
      }
    }
    return result;
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
    const { memory } = applyMemoryOps(state.memory, input.ops, cfg.maxNotes);
    state.memory = memory;
  }
  saveCompanionState(state);
  return state.memory;
}
