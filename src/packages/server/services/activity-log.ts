/**
 * Activity Log 埋点门面（⑭ 日志地基②，任务 02）
 *
 * 把 Spec §4.14 的「基础四类 + 系统活动 1-4」收敛为薄封装：统一 source 常量
 * （dialog/broadcast/delegation 用各自 category；voice/memory/security/resource
 * 走 category:'system' + source 承载子类，主脑登记 2026-10-04）与 body 字段形态，
 * 便于 querySystemLog({category|source}) 筛选。字段命名对齐消费端（⑫ 配额、
 * 任务 17·A5 成本周报）。
 *
 * 本模块只做 logEvent 转发，不参与业务决策；写失败由 system-log.ts 静默降级，
 * 绝不抛异常、不影响主链路。append-only：调用方不得修改已落盘事件。
 */

import { logEvent, type SystemLogLevel } from '../data/system-log.js';
import type { TaskCardStatus } from '../../shared/agent-types.js';

// ─── 公共工具 ───

/** 工具入参摘要（截断 300 字符 + 防序列化异常；落盘时由 system-log 再做密钥脱敏）。 */
export function previewToolInput(toolInput: unknown): string | undefined {
  try {
    const s = JSON.stringify(toolInput);
    return s ? s.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

// ─── source 常量（查询/筛选一律以此为准） ───

/** 系统活动子类：category='system' 时由 source 承载 cat 语义 */
export const ACTIVITY_SOURCE = {
  dialog: 'voice-companion',
  broadcast: 'voice-companion',
  voice: 'voice',
  memory: 'memory',
  security: 'security',
  resource: 'resource',
  // 任务19·A（⑭ P2）：系统活动 5-8 —— 会话 / 进程 / 配置 / 技能
  session: 'session',
  process: 'process',
  config: 'config',
  skill: 'skill',
} as const;

// ─── 基础四类：对话 / 播报 / 委派 ───

export interface DialogLogFields {
  direction: 'in' | 'out';
  /** 转写文本（in）或秘书回应原文（out） */
  text: string;
  channel?: string;
  sessionId?: string;
  taskId?: string;
  agentId?: string;
  action?: string;
  degraded?: boolean;
  targetAgentId?: string;
  /** true = 本次输入是客户端合并上报的 ⟦系统事件⟧（主动汇报），非用户语音 */
  isEvent?: boolean;
  level?: SystemLogLevel;
}

/** 用户↔秘书对话（基础四类 ①）：每条消息落盘，含方向/文本/sessionId/时间戳。 */
export function logDialogMessage(f: DialogLogFields): number | undefined {
  return logEvent('dialog', {
    source: ACTIVITY_SOURCE.dialog,
    sessionId: f.sessionId,
    taskId: f.taskId,
    agentId: f.agentId,
    // 降级回合（兜底话术）按 warn 全量落盘
    level: f.level ?? (f.degraded ? 'warn' : undefined),
    body: {
      cat: 'dialog',
      direction: f.direction,
      text: f.text,
      channel: f.channel ?? 'voice-companion',
      action: f.action,
      degraded: f.degraded,
      targetAgentId: f.targetAgentId,
      isEvent: f.isEvent,
    },
  });
}

export interface BroadcastLogFields {
  /** 播报原文（responseToUser / hop2 总结 / 兜底话术） */
  text: string;
  /** server-sent = 已交给客户端播放链路；排队/丢弃/投递失败在客户端，见任务 02 缺口清单 */
  phase: 'server-sent' | string;
  action?: string;
  degraded?: boolean;
  sessionId?: string;
  taskId?: string;
  agentId?: string;
}

/** 秘书播报/反馈（基础四类 ②）：服务端可见的播报原文与出站时点。 */
export function logBroadcast(f: BroadcastLogFields): number | undefined {
  return logEvent('broadcast', {
    source: ACTIVITY_SOURCE.broadcast,
    sessionId: f.sessionId,
    taskId: f.taskId,
    agentId: f.agentId,
    body: { cat: 'broadcast', phase: f.phase, text: f.text, action: f.action, degraded: f.degraded },
  });
}

export interface DelegationLogFields {
  /**
   * dispatched=派活出站；delegated=Boss 拆解写入；reported=下属回执；closed=委派追踪关闭；
   * failed=派活抛错；blocked=违规直派被拦截（决策观测点① 告警，任务 05·改①）；
   * cancelled=⑬ 任务撤回（任务 16：谁发/原因/目标/通知投递，status 记撤回结论）
   */
  phase: 'dispatched' | 'delegated' | 'reported' | 'closed' | 'failed' | 'blocked' | 'cancelled';
  /** 来源渠道：voice-companion / boss / api / subordinate */
  channel: string;
  /** 路由判定（决策观测点①）：delegate_to_boss / send_to_agent / send_to_agent-rerouted 等 */
  routedBy?: string;
  /** 缺省 info；告警类（如 phase='blocked'）显式传 warn 保证全量落盘 */
  level?: SystemLogLevel;
  fromAgentId?: string;
  fromName?: string;
  toAgentId?: string;
  toAgentName?: string;
  message?: string;
  delivery?: string;
  interrupted?: boolean;
  status?: string;
  summary?: string;
  forwarded?: boolean;
  /** phase='failed' 时的错误摘要（sendCommand/deliverToAgent 抛错） */
  error?: string;
  /** 显式 taskId：跨进程/跨模块处由调用方透传（缺省跟随链路上下文） */
  taskId?: string;
  sessionId?: string;
  agentId?: string;
  /** ⑬ 撤回（phase='cancelled'）：发起方（user/boss/system）与原因摘要（最小加法，其余 phase 不落） */
  initiator?: string;
  reason?: string;
  /** ⑬ 撤回：是否已向下属投递取消通知（queued 撤回未派发 → false） */
  notified?: boolean;
  /** ⑬ 撤回：通知投递耗时（sendCommand 确认到达时刻 − 撤回开始；不可得 → 缺省不落） */
  notifyMs?: number;
}

/** 委派链路（基础四类 ③）：秘书派活 → Boss 拆解 → 下属回执 → 关闭（含违规直派拦截告警）。 */
export function logDelegation(f: DelegationLogFields): number | undefined {
  return logEvent('delegation', {
    source: f.channel,
    taskId: f.taskId,
    sessionId: f.sessionId,
    agentId: f.agentId,
    level: f.level,
    body: {
      cat: 'delegation',
      phase: f.phase,
      channel: f.channel,
      routedBy: f.routedBy,
      fromAgentId: f.fromAgentId,
      fromName: f.fromName,
      toAgentId: f.toAgentId,
      toAgentName: f.toAgentName,
      message: f.message,
      delivery: f.delivery,
      interrupted: f.interrupted,
      status: f.status,
      summary: f.summary,
      forwarded: f.forwarded,
      error: f.error,
      initiator: f.initiator,
      reason: f.reason,
      notified: f.notified,
      notifyMs: f.notifyMs,
    },
  });
}

// ─── 决策观测点⑦：任务卡状态机迁移 ───

export interface TaskCardStatusLogFields {
  /** 委派决策 id（delegation-history 记录主键） */
  decisionId: string;
  /** 'none' = 落卡（卡从无到有） */
  from: TaskCardStatus | 'none';
  to: TaskCardStatus;
  /** 迁移发生时刻（epoch 毫秒；⑧⑬ 按此排时间线） */
  at: number;
  bossId?: string;
  subordinateId?: string;
  projectId?: string;
  sourceProject?: string;
  /** 终态结果（完成入口写入），供 ⑧ 病历区分 completed/failed */
  result?: 'completed' | 'failed';
  /** 触发原因：delegated / dispatched / turn-complete / report-task 等 */
  reason?: string;
  taskId?: string;
}

/** 决策观测点⑦ 任务卡状态机（Spec §4.14）：pending → running → done 迁移 + 时间，走 delegation 通道。 */
export function logTaskCardStatus(f: TaskCardStatusLogFields): number | undefined {
  return logEvent('delegation', {
    source: 'boss',
    taskId: f.taskId,
    agentId: f.subordinateId ?? f.bossId,
    projectId: f.projectId,
    body: {
      cat: 'delegation',
      phase: 'task-card-status',
      decisionId: f.decisionId,
      from: f.from,
      to: f.to,
      at: f.at,
      bossId: f.bossId,
      subordinateId: f.subordinateId,
      projectId: f.projectId,
      sourceProject: f.sourceProject,
      result: f.result,
      reason: f.reason,
    },
  });
}

// ─── 系统活动 1：语音链路（ASR / TTS） ───

export interface VoiceAsrLogFields {
  /** whisper=批量转写；volcengine-stream=语音伙伴流式识别 */
  channel: 'whisper' | 'volcengine-stream' | string;
  text: string;
  durationMs: number;
  cached?: boolean;
  model?: string;
  language?: string;
  ok?: boolean;
  error?: string;
  /** 仅文件名，避免落盘完整本地路径（隐私） */
  audioFile?: string;
  sessionId?: string;
  agentId?: string;
}

/** 语音链路 · ASR：转写文本与耗时（Spec §4.14 系统活动 1）。 */
export function logVoiceAsr(f: VoiceAsrLogFields): number | undefined {
  return logEvent('system', {
    source: ACTIVITY_SOURCE.voice,
    sessionId: f.sessionId,
    agentId: f.agentId,
    level: f.ok === false ? 'warn' : 'info',
    body: {
      cat: 'voice',
      sub: 'asr',
      channel: f.channel,
      text: f.text,
      durationMs: f.durationMs,
      cached: f.cached,
      model: f.model,
      language: f.language,
      ok: f.ok !== false,
      error: f.error,
      audioFile: f.audioFile,
    },
  });
}

export interface VoiceTtsLogFields {
  channel?: string;
  voice?: string;
  textChars: number;
  durationMs: number;
  audioBytes?: number;
  ok?: boolean;
  error?: string;
  sessionId?: string;
  agentId?: string;
}

/** 语音链路 · TTS：服务端合成时长（播放时长在客户端，P2 上报，见缺口清单）。 */
export function logVoiceTts(f: VoiceTtsLogFields): number | undefined {
  return logEvent('system', {
    source: ACTIVITY_SOURCE.voice,
    sessionId: f.sessionId,
    agentId: f.agentId,
    level: f.ok === false ? 'warn' : 'info',
    body: {
      cat: 'voice',
      sub: 'tts',
      channel: f.channel ?? 'tts-route',
      voice: f.voice,
      textChars: f.textChars,
      durationMs: f.durationMs,
      audioBytes: f.audioBytes,
      ok: f.ok !== false,
      error: f.error,
    },
  });
}

// ─── 系统活动 2：记忆操作 ───

/** 单条 memoryOp 的生效明细（applied=false 表示重复/过短/未找到 id 等未生效）。 */
export interface MemoryOpDetail {
  op: 'add' | 'remove' | 'setSummary';
  applied: boolean;
  /** add 生效时，为腾位置裁剪掉的旧笔记条数（计入 droppedCount） */
  droppedCount?: number;
}

export interface MemoryOpsLogFields {
  applied: number;
  details: MemoryOpDetail[];
  notesTotal?: number;
  droppedTotal?: number;
  sessionId?: string;
  agentId?: string;
  /** voice=语音伙伴回合；settings=设置面板/接口 */
  channel?: string;
}

/** 系统活动 2 · 记忆操作：每次 add/remove/setSummary 与裁剪 droppedCount 落盘。 */
export function logMemoryOps(f: MemoryOpsLogFields): number | undefined {
  return logEvent('system', {
    source: ACTIVITY_SOURCE.memory,
    sessionId: f.sessionId,
    agentId: f.agentId,
    body: {
      cat: 'memory',
      channel: f.channel ?? 'voice',
      applied: f.applied,
      ops: f.details,
      notesTotal: f.notesTotal,
      droppedTotal: f.droppedTotal,
    },
  });
}

// ─── 系统活动 3：权限与安全 ───

export type SecurityPhase = 'request' | 'approved' | 'denied' | 'timeout' | 'cancelled' | 'bypass-tool-call';

export interface SecurityLogFields {
  phase: SecurityPhase;
  agentId?: string;
  sessionId?: string;
  requestId?: string;
  tool?: string;
  /** 工具入参摘要（落盘前由 system-log 做密钥脱敏） */
  toolInputPreview?: string;
  reason?: string;
  remember?: boolean;
  /** bypass 模式工具调用为高频通道，默认采样（1:10，初始值） */
  sampled?: boolean;
  level?: SystemLogLevel;
}

/** 系统活动 3 · 权限与安全：请求/批准/拒绝/超时/取消/bypass 工具调用。 */
export function logSecurity(f: SecurityLogFields): number | undefined {
  return logEvent('system', {
    source: ACTIVITY_SOURCE.security,
    agentId: f.agentId,
    sessionId: f.sessionId,
    level: f.level ?? (f.phase === 'timeout' ? 'warn' : 'info'),
    sampled: f.sampled,
    body: {
      cat: 'security',
      phase: f.phase,
      requestId: f.requestId,
      tool: f.tool,
      toolInputPreview: f.toolInputPreview,
      reason: f.reason,
      remember: f.remember,
    },
  });
}

// ─── 系统活动 4：资源与费用 ───

export interface ResourceTokens {
  input: number;
  output: number;
  cacheCreation?: number;
  cacheRead?: number;
}

export interface ResourceUsageLogFields {
  agentId?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  tokens?: ResourceTokens;
  /** provider 返回的真实费用（Claude result total_cost_usd → step_complete.cost） */
  costUsd?: number;
  durationMs?: number;
  contextPercent?: number;
  contextUsed?: number;
  contextLimit?: number;
  /** turn=每回合 step_complete；context=context_stats 轮询（高频，默认采样） */
  sub?: 'turn' | 'context';
  sampled?: boolean;
}

/**
 * 系统活动 4 · 资源与费用：每 agent token 用量/耗时/上下文占用/费用。
 * 真实 cost 优先（costSource='provider'）；缺失时按价格表 × tokens 估算
 * （costSource='estimated'，价格表见 ESTIMATED_PRICE_PER_MTOKENS，非实测最优）。
 */
export function logResourceUsage(f: ResourceUsageLogFields): number | undefined {
  const hasProviderCost = typeof f.costUsd === 'number' && Number.isFinite(f.costUsd);
  const tokens = f.tokens;
  const tokensTotal = tokens
    ? tokens.input + tokens.output + (tokens.cacheCreation ?? 0) + (tokens.cacheRead ?? 0)
    : undefined;
  const costUsd = hasProviderCost ? f.costUsd : estimateCostUsd(f.model, tokens);

  return logEvent('system', {
    source: ACTIVITY_SOURCE.resource,
    agentId: f.agentId,
    sessionId: f.sessionId,
    sampled: f.sampled ?? f.sub === 'context',
    body: {
      cat: 'resource',
      sub: f.sub ?? 'turn',
      provider: f.provider,
      model: f.model,
      tokens,
      tokensTotal,
      costUsd,
      costSource: hasProviderCost ? 'provider' : costUsd !== undefined ? 'estimated' : 'unavailable',
      durationMs: f.durationMs,
      contextPercent: f.contextPercent,
      contextUsed: f.contextUsed,
      contextLimit: f.contextLimit,
    },
  });
}

/**
 * 估算价格表（USD / 1M tokens，按模型族近似）。
 *
 * ⚠️ 常量非实测最优（Spec §8.2 标定项）：仅用于 provider 未返回真实 cost 的兜底，
 * 待 ⑫ 配额 / 任务 17·A5 成本周报拿到实测账单后回写标定。
 */
export const ESTIMATED_PRICE_PER_MTOKENS: Readonly<Record<string, { input: number; output: number; cacheRead: number; cacheCreation: number }>> = {
  opus: { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  haiku: { input: 0.8, output: 4, cacheRead: 0.08, cacheCreation: 1 },
  fable: { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  default: { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
};

/** 按模型名（含 opus/sonnet/haiku/fable 即命中）估费用；无 token 数据返回 undefined。 */
export function estimateCostUsd(model: string | undefined, tokens?: ResourceTokens): number | undefined {
  if (!tokens) return undefined;
  const key = String(model ?? '').toLowerCase();
  const family = ['opus', 'sonnet', 'haiku', 'fable'].find((f) => key.includes(f)) ?? 'default';
  const price = ESTIMATED_PRICE_PER_MTOKENS[family];
  const cost =
    (tokens.input / 1e6) * price.input +
    (tokens.output / 1e6) * price.output +
    ((tokens.cacheRead ?? 0) / 1e6) * price.cacheRead +
    ((tokens.cacheCreation ?? 0) / 1e6) * price.cacheCreation;
  return Math.round(cost * 1e6) / 1e6;
}

// ════════════════════════════════════════════════════════════════════════════
// 系统活动 5-8（⑭ P2，任务19·A）
//
// 与 1-4 同形态：category='system' + source 常量承载子类 + body.cat 冗余可读。
// 除 logEvent 自身的静默降级外，四个 helper 再包一层 try/catch —— 埋点调用点
// （runner/restart-policy/recovery-store/routes/runtime-listeners）处于进程健康
// 与配置主链路，任何 helper 缺陷都绝不允许倒灌主流程（失败隔离硬口径）。
// ════════════════════════════════════════════════════════════════════════════

// ─── 系统活动 5：会话生命周期 ───

export interface SessionLogFields {
  /**
   * created=会话创建；rotated=轮换（sessionMaxAgeDays/人设切换）；
   * expired=超龄过期；resume-rejected=--resume 被拒；cleared=不可恢复会话被清（清会话重试）。
   */
  phase: 'created' | 'rotated' | 'expired' | 'resume-rejected' | 'cleared' | (string & {});
  agentId?: string;
  /** 被操作/新建的会话 id（cleared 时为被清掉的那个） */
  sessionId?: string;
  /** 轮换/清会话前的旧会话 id（时间线回溯用） */
  previousSessionId?: string;
  reason?: string;
  /** 会话存活时长（过期/清会话时可得，epoch ms） */
  ageMs?: number;
  /** 清会话后的重试结果 */
  retry?: 'succeeded' | 'failed';
  error?: string;
  level?: SystemLogLevel;
}

/** 系统活动 5 · 会话生命周期：sessionId 创建/轮换/过期、--resume 拒绝、清会话重试。 */
export function logSession(f: SessionLogFields): number | undefined {
  try {
    return logEvent('system', {
      source: ACTIVITY_SOURCE.session,
      agentId: f.agentId,
      sessionId: f.sessionId,
      level: f.level ?? (f.phase === 'resume-rejected' || f.retry === 'failed' ? 'warn' : 'info'),
      body: {
        cat: 'session',
        phase: f.phase,
        previousSessionId: f.previousSessionId,
        reason: f.reason,
        ageMs: f.ageMs,
        retry: f.retry,
        error: f.error,
      },
    });
  } catch {
    return undefined; // 失败隔离：埋点绝不打断会话生命周期主流程
  }
}

// ─── 系统活动 6：进程健康 ───

export interface ProcessLogFields {
  /**
   * spawned=进程拉起；spawn-error=拉起失败；exited=进程退出；
   * watchdog-missing=看门狗判定进程消失；restart=自动重启发起；
   * restart-ok=重启成功；restart-failed=重启抛错；restart-exhausted=重启次数耗尽；
   * orphan-killed=启动时清理孤儿 tmux 会话。
   */
  phase: 'spawned' | 'spawn-error' | 'exited' | 'watchdog-missing' | 'restart' | 'restart-ok' | 'restart-failed' | 'restart-exhausted' | 'orphan-killed' | (string & {});
  agentId?: string;
  sessionId?: string;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  runtimeMs?: number;
  /** 自动重启尝试序号（第 N 次） */
  attempt?: number;
  maxAttempts?: number;
  /** watchdog 判定时队列里待投递的消息数 */
  queuedCount?: number;
  turnState?: string;
  tmuxSession?: string;
  /** 本进程是否产出过 stdout（重启计数是否重置的判据） */
  producedOutput?: boolean;
  /** 处置动作：respawn / restart-policy / … */
  action?: string;
  wasTracked?: boolean;
  reason?: string;
  error?: string;
  level?: SystemLogLevel;
}

/** 系统活动 6 · 进程健康：runner 重启、watchdog、crash 原因、孤儿清理。 */
export function logProcess(f: ProcessLogFields): number | undefined {
  try {
    const defaultWarn =
      f.phase === 'spawn-error' || f.phase === 'restart-failed' || f.phase === 'restart-exhausted';
    return logEvent('system', {
      source: ACTIVITY_SOURCE.process,
      agentId: f.agentId,
      sessionId: f.sessionId,
      level: f.level ?? (defaultWarn ? 'warn' : 'info'),
      body: {
        cat: 'process',
        phase: f.phase,
        pid: f.pid,
        exitCode: f.exitCode,
        signal: f.signal,
        runtimeMs: f.runtimeMs,
        attempt: f.attempt,
        maxAttempts: f.maxAttempts,
        queuedCount: f.queuedCount,
        turnState: f.turnState,
        tmuxSession: f.tmuxSession,
        producedOutput: f.producedOutput,
        action: f.action,
        wasTracked: f.wasTracked,
        reason: f.reason,
        error: f.error,
      },
    });
  } catch {
    return undefined; // 失败隔离：埋点绝不打断进程管理主流程
  }
}

// ─── 系统活动 7：配置变更 ───

export interface ConfigLogFields {
  /** 配置项：'system-prompt' | 'tmux-mode' | 'pi-rpc-mode' | 'workspace' | … */
  key: string;
  /** set=设值；clear=清除；switch=切换 */
  action: 'set' | 'clear' | 'switch' | (string & {});
  /** 标量值（boolean/短字符串/null）；长文本用 valueLength 代替，不落全文 */
  value?: unknown;
  /** 长文本长度（如 system prompt 字符数） */
  valueLength?: number;
  reason?: string;
  agentId?: string;
  level?: SystemLogLevel;
}

/** 系统活动 7 · 配置变更：workspace 切换、prompt 修改、tmux/pi-rpc 开关（配合 ⑪ 回滚开关）。 */
export function logConfig(f: ConfigLogFields): number | undefined {
  try {
    return logEvent('system', {
      source: ACTIVITY_SOURCE.config,
      agentId: f.agentId,
      level: f.level,
      body: {
        cat: 'config',
        key: f.key,
        action: f.action,
        value: f.value,
        valueLength: f.valueLength,
        reason: f.reason,
      },
    });
  } catch {
    return undefined; // 失败隔离：埋点绝不打断配置变更主流程
  }
}

// ─── 系统活动 8：技能调用 ───

export interface SkillLogFields {
  /** invoked=发起调用；completed=返回；failed=返回且判定失败 */
  phase: 'invoked' | 'completed' | 'failed' | (string & {});
  /** skill 名（Skill 工具入参的 skill 字段） */
  skill: string;
  agentId?: string;
  sessionId?: string;
  /** 入参摘要（截断 300 字符，previewToolInput 产物） */
  argsPreview?: string;
  ok?: boolean;
  error?: string;
  level?: SystemLogLevel;
}

/** 系统活动 8 · 技能调用：agent 用了哪些 skill、成功/失败。 */
export function logSkill(f: SkillLogFields): number | undefined {
  try {
    return logEvent('system', {
      source: ACTIVITY_SOURCE.skill,
      agentId: f.agentId,
      sessionId: f.sessionId,
      level: f.level ?? (f.phase === 'failed' || f.ok === false ? 'warn' : 'info'),
      body: {
        cat: 'skill',
        phase: f.phase,
        skill: f.skill,
        argsPreview: f.argsPreview,
        ok: f.ok,
        error: f.error,
      },
    });
  } catch {
    return undefined; // 失败隔离：埋点绝不打断工具调用主流程
  }
}
