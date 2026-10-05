/**
 * human-campaign 共享类型 —— 真人化全系统真链路测试战役（W12 · 任务19·B 主体）
 *
 * 与 jarvis-canary 的关系：战役工具**独立成目录**（canary 冻结不扰动），只**导入** canary
 * 已导出的原语（types/client/log-query/scenarios 的导出常量与助手）。canary 未导出的
 * 内部助手（findOwnDialogIn / assertThat / bodyString / phaseOf / ANCHOR_FALLBACK_NOTE）
 * 在 runner.ts 中镜像并注明来源行号。
 *
 * 设计口径（与计划逐字对应）：
 *   - 探针 = 一次"真人会问的真实问题" + 真链路发送 + 锚点纪律断言 + 证据抽取；
 *   - effect 标注该探针的运行面：none=零环境写入 / env=写环境(需 env-prep) /
 *     delegation=产生真实派活(有 LLM 消耗) / restart=需要重启服务端(分段执行) /
 *     manual=人工抽验(MANUAL.md 回填)；
 *   - optional=true 的探针允许"如实自跳过"（如非冷环境、配额未排队），不计波次失败；
 *     非 optional 探针 SKIP = 前置缺失，默认阻塞该波（--allow-skip 可放行）。
 */

import type {
  AssertionResult, CanaryTransport, Evidence, LogQueryFn, PrereqResult,
} from '../jarvis-canary/types.js';

export type WaveId = 1 | 2 | 3 | 4 | 5;

export type ProbeEffect = 'none' | 'env' | 'delegation' | 'restart' | 'manual';

/** pass=全断言过；fail=有断言红；skip=前置缺失或如实自跳过；planned=dry-run；manual=人工抽验待回填 */
export type ProbeStatus = 'pass' | 'fail' | 'skip' | 'planned' | 'manual';

/** WS 观测到的单帧消息 */
export interface WsMsg {
  ts: number;
  type: string;
  payload: unknown;
  raw: string;
}

/** 主 WS 会话的探针侧接口（ws-observer.ts 实现；结构化类型避免循环依赖） */
export interface WsObserverLike {
  readonly messages: WsMsg[];
  send(type: string, payload: unknown): void;
  waitFor(pred: (m: WsMsg) => boolean, opts: { timeoutMs: number; pollMs?: number; sinceTs?: number }): Promise<WsMsg | undefined>;
  waitForType(type: string, opts: { timeoutMs: number; pollMs?: number; sinceTs?: number }): Promise<WsMsg | undefined>;
  receivedSince(ts: number, type?: string): WsMsg[];
  close(): void;
}

export interface HumanOptions {
  baseUrl: string;
  token?: string;
  dbPath?: string;
  wave?: WaveId;
  probeFilter: string[];
  dryRun: boolean;
  reportPath?: string;
  allowSkip: boolean;
  verbose: boolean;
  httpTimeoutMs: number;
  wsTimeoutMs: number;
  /** 单探针总超时（含 LLM 等待） */
  probeTimeoutMs: number;
  /** 发消息后等待 dialog out 的窗口 */
  logWaitMs: number;
  pollMs: number;
  /** 等待 dispatched（秘书→Boss 出站）的窗口 */
  bossWaitMs: number;
  /** 等待回执（reported/closed）的窗口 */
  reportWaitMs: number;
  /** 分段探针（HC-37/HC-40）的执行段：prep | verify | cleanup */
  stage?: string;
  /** 季度 opt-in：对抗包（HC-43） */
  includeAdversarial: boolean;
  /** env-prep：调试用，跳过 teardown */
  keepEnv: boolean;
}

export interface ProbeContext {
  transport: CanaryTransport;
  /** 主 WS 常连会话（spawn_boss_agent / sync_areas / stop_agent + 广播观测） */
  ws: WsObserverLike;
  query: LogQueryFn;
  options: HumanOptions;
  /** 探针间传递的临时上下文（如 HC-25 登记的 taskId 给 HC-29/32 用） */
  shared: Record<string, unknown>;
  dbStats: { totalRows: number; rows24h: number; latestTs?: number; dbPath: string };
  log: (msg: string) => void;
}

export interface ProbeOutcome {
  assertions: AssertionResult[];
  notes: string[];
  /** 失败诊断用的窗口内事件（已截断） */
  observed?: Array<Record<string, unknown>>;
  /** 非空 = 如实 SKIP（optional 探针不阻塞波次；非 optional 默认阻塞） */
  skipReason?: string;
}

export interface ProbeDef {
  /** 稳定 ID：HC-01 … HC-43 */
  id: string;
  wave: WaveId;
  title: string;
  /** 维度标签（真人语言形态/路由/配额/语音/机器面…） */
  dim: string;
  effect: ProbeEffect;
  /** 探针逐字话术（进报告与 MANUAL 对照） */
  utterance?: string;
  steps: string[];
  assertionDocs: string[];
  prereqIds: string[];
  /** 人工抽验探针：真跑时恒 manual 状态，等待 MANUAL.md 回填 */
  manualOnly?: boolean;
  /** 允许自跳过（如非冷环境）——skip 不计波次失败 */
  optional?: boolean;
  /** 执行顺序提示（同波内小者先行；HC-28 用） */
  order?: number;
  run(ctx: ProbeContext): Promise<ProbeOutcome>;
}

export interface ProbeResult {
  id: string;
  wave: WaveId;
  title: string;
  dim: string;
  effect: ProbeEffect;
  status: ProbeStatus;
  startedAt: string;
  elapsedMs: number;
  prereqs: PrereqResult[];
  assertions: AssertionResult[];
  notes: string[];
  observed: Array<Record<string, unknown>>;
  skipReason?: string;
  /** 从 ProbeDef 透传：optional 探针的 SKIP 不阻塞波次（见 gateVerdict） */
  optional?: boolean;
}

export interface CampaignReport {
  tool: 'human-campaign';
  version: 1;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  wave?: WaveId;
  dryRun: boolean;
  baseUrl: string;
  dbPath?: string;
  environment: { node: string; platform: string };
  globalErrors: string[];
  results: ProbeResult[];
  summary: { total: number; pass: number; fail: number; skip: number; planned: number; manual: number };
}

/** 便于探针模块引用证据类型 */
export type { AssertionResult, CanaryTransport, Evidence, LogQueryFn, PrereqResult };
