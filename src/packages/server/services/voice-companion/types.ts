/**
 * 语音伙伴服务 — 类型定义与契约常量(2026-10-11 自 voice-companion-service.ts 拆分,行为不变)。
 * 仅含类型/action 全集/中止错误;运行时默认值、上限与路径常量见 constants.ts。
 */
import type { RecentTurn, HandoffNote } from '../../voice/handoff.js';
import type { SentenceMeta } from '../../voice/speech-gate.js';

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
  /**
   * 任务39·F4:上段会话交接便签(轮换点认领时写入;渲染受「非本会话 + 72h」门控,
   * 见 formatMemory)。未验证内容**不自动晋升**为长期 notes,只渲染 + 一条工作记忆。
   */
  handoff?: HandoffNote | null;
}

/**
 * 任务18·上下文占用快照(callClaudeOnce 原先 usage 全丢;常驻化后采集自 result 事件)。
 * 观测点:⑭ 系统活动 4(context_stats)+ ⑮ 压缩触发率标定;压缩 v1 缺省 80%。
 */
export interface VoiceCompanionContextState {
  /** 最近一次 result 的输入侧用量(input + cache_read + cache_creation)。 */
  tokensUsed: number;
  /** 判定用窗口尺寸(CLI modelUsage.contextWindow 优先,缺失用配置缺省)。 */
  windowTokens: number;
  /** tokensUsed / windowTokens(可能 >1)。 */
  percent: number;
  updatedAt: number;
}

export interface VoiceCompanionState {
  sessionId: string | null;
  sessionStartedAt: number | null;
  turns: number;
  lastUsedAt: number | null;
  /** 上次使用的人设键(shared/voice-personas 的 personaKeyOf);变化 → 轮换会话。null = 旧状态。 */
  personaKey: string | null;
  memory: CompanionMemory;
  /** 任务18:上下文占用(可选——旧状态文件/测试内联构造无此字段)。 */
  context?: VoiceCompanionContextState | null;
  /** 任务39·F2:最近轮次环缓冲(交接材料源;旧状态文件缺字段 → [];轮换时清空)。 */
  recentTurns?: RecentTurn[];
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
  /** 任务16·⑬ 撤回:撤回/取消某个在办任务(独立于派活通道,系统负责定位目标)。 */
  | 'cancel_delegation'
  /** 任务16·⑬ 评价:对最近完成且未评价的任务回写满意/不满意(承接任务11 API)。 */
  | 'rate_delegation'
  | 'noop';

/**
 * 契约 action 全集——模板字符串 / 解析白名单 / 流式 GATE_ACTIONS 同源,防多处漂移
 * (改① 新增 delegate_to_boss 时只需改这里与 CompanionAction)。
 */
export const COMPANION_ACTIONS: readonly CompanionAction[] = [
  'general_response', 'delegate_to_boss', 'send_to_agent', 'list_agents', 'query_agent_output', 'analyze_logs',
  'query_bolba_tasks', 'create_bolba_task', 'complete_bolba_task', 'reopen_bolba_task',
  'cancel_delegation', 'rate_delegation', 'noop',
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
  /** true = 由客户端主动汇报模块送来的 ⟦系统事件⟧ 文本(noop 时保持安静)。 */
  isEvent?: boolean;
  /**
   * 分句流式播报:模型边生成,responseToUser 里每完成一句就回调一次
   * (已经过 action 语义门控:noop 不出声、send_to_agent 等派发成功才放行)。
   * meta.pre=true 的过渡/垫话句照播但不参与客户端最终对账(W4)。
   * 不传则完全走旧的整段返回路径。
   */
  onSentence?: (sentence: string, meta?: SentenceMeta) => void;
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
  /** 任务18:上下文压缩阈值(0-1;任务39 实测推导,缺省 0.3 = 60K@200K——见 06-10 §1e)。 */
  contextCompactPercent: number;
  /** 任务18:压缩判定窗口兜底(CLI modelUsage.contextWindow 缺失时用;缺省 200K)。 */
  contextWindowTokens: number;
  /** 任务39:绝对 token 闸口(>0 生效;与 percent 取或,缺省 0 = 关)。 */
  contextCompactTokens: number;
  /** W2 阶段2:首句机械上限(>0 生效;0 = 关,缺省)。建议开启值 24。 */
  firstSentenceMaxChars: number;
  /** W5 慢档续垫:等待超过阈值仍无声时,动态生成一句安抚垫话(≤10 字,pre 通道)。 */
  slowFiller: SlowFillerTiming;
}

/** W5 慢档续垫参数(armMs/emitMs 为未命中兜底档;W7 预生成命中时用 armMs=0 + pregenEmitMs)。 */
export interface SlowFillerTiming {
  enabled: boolean;
  /** 开始预生成的时间点(ms,自回合开始;预生成命中时不用,取 0 立即取用)。 */
  armMs: number;
  /** 允许吐出的最早时间点(ms,自回合开始)。 */
  emitMs: number;
  /** W7:预生成命中时的吐出底线(ms,自回合开始)——生成已在说话期间埋单,只需压过 TTS 合成。 */
  pregenEmitMs: number;
}
