/**
 * jarvis-canary 共享类型
 *
 * 金丝雀真链路冒烟工具（00-README §5 第 7 条）：连真 dev server（默认
 * http://127.0.0.1:6200），走真实链路发消息，再用只读查询 system_log 断言
 * "事件链真的发生了"。
 *
 * 本文件只放类型定义，不产生任何副作用，便于 selftest 用 mock 注入。
 */

// ─── 日志条目（system_log 行 + 解析后的 body） ───

export interface CanaryEntry {
  id: number;
  /** epoch 毫秒（服务端写入时刻） */
  ts: number;
  category: string;
  source?: string;
  agentId?: string;
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  level: string;
  /** JSON.parse 后的 body；解析失败时保留 undefined，原文在 bodyRaw */
  body?: Record<string, unknown>;
  bodyRaw?: string;
}

/**
 * 只读查询过滤条件——语义与 src/packages/server/data/system-log.ts 的
 * SystemLogQuery 保持一致（镜像而非 import，见 log-query.ts 顶部说明）。
 */
export interface LogQueryFilter {
  category?: string;
  source?: string;
  agentId?: string;
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  level?: string;
  /** ts >= since */
  since?: number;
  /** ts <= until */
  until?: number;
  limit?: number;
  offset?: number;
  /** 链路时间线用 'asc'；默认 'desc' */
  order?: 'asc' | 'desc';
}

export type LogQueryFn = (filter: LogQueryFilter) => CanaryEntry[];

// ─── 传输层（HTTP/WS） ───

export interface HttpResult {
  ok: boolean;
  status: number;
  /** 解析后的 JSON（若可解析） */
  json?: Record<string, unknown>;
  error?: string;
  elapsedMs: number;
}

export interface WsProbeResult {
  ok: boolean;
  /** 收到的第一帧类型（正常应为 server_time / agents_update 等） */
  firstMessageType?: string;
  error?: string;
  elapsedMs: number;
}

export interface CanaryTransport {
  baseUrl: string;
  httpGet(path: string): Promise<HttpResult>;
  httpPost(path: string, body: unknown): Promise<HttpResult>;
  wsHandshake(): Promise<WsProbeResult>;
  close(): void;
}

export interface AgentInfo {
  id: string;
  name: string;
  isBoss?: boolean;
  class?: string;
  bossId?: string;
  status?: string;
}

// ─── 断言 / 证据 / 结果 ───

/** 单条证据：命中的 log id + 时间 + 关键字段（文本类字段截断，不回显全文） */
export interface Evidence {
  logId?: number;
  tsIso?: string;
  category?: string;
  source?: string;
  level?: string;
  /** 从 body 中抽取的关键字段（长文本已截断） */
  fields: Record<string, unknown>;
}

export interface AssertionResult {
  id: string;
  desc: string;
  ok: boolean;
  expected: string;
  actual: string;
  evidence: Evidence[];
}

export interface PrereqResult {
  id: string;
  desc: string;
  ok: boolean;
  detail: string;
  /** runtime 型前置在 --dry-run 下延后到真跑检查（env 型必须当场验证） */
  kind: 'env' | 'runtime';
  deferred?: boolean;
}

export type ScenarioStatus = 'pass' | 'fail' | 'skip' | 'planned';

export interface ScenarioResult {
  name: string;
  title: string;
  level: 'smoke' | 'full';
  status: ScenarioStatus;
  startedAt: number;
  elapsedMs: number;
  prereqs: PrereqResult[];
  assertions: AssertionResult[];
  notes: string[];
  /** 断言窗口内实际查到的事件（失败诊断用，已截断） */
  observed: Array<Record<string, unknown>>;
}

// ─── 场景定义 ───

export interface CanaryOptions {
  baseUrl: string;
  token?: string;
  /** 允许 --db= 覆盖 events.db 路径（测试/沙箱用） */
  dbPath?: string;
  level: 'smoke' | 'full';
  scenarioFilter: string[];
  dryRun: boolean;
  reportPath?: string;
  httpTimeoutMs: number;
  wsTimeoutMs: number;
  /** 单个场景的总超时（含 LLM 等待） */
  scenarioTimeoutMs: number;
  /** 发消息后轮询日志的窗口 */
  logWaitMs: number;
  pollMs: number;
  /** full：等待 Boss 拆解派活（delegated）的窗口；0=不等待 */
  bossWaitMs: number;
  /** full：等待下属回执（reported）的窗口 */
  reportWaitMs: number;
  dialogText: string;
  taskText: string;
  cancelText: string;
  /** full ④：用 report-task 接口模拟下属回执（半合成，默认关） */
  simulateReceipt: boolean;
  allowSkip: boolean;
  verbose: boolean;
}

export interface ScenarioContext {
  transport: CanaryTransport;
  query: LogQueryFn;
  options: CanaryOptions;
  /** 场景间传递的临时上下文（如③的 delegated 证据给④用） */
  shared: Record<string, unknown>;
  /** events.db 概况（连通性场景证据 / dry-run 埋点活跃度提示） */
  dbStats: { totalRows: number; rows24h: number; latestTs?: number; dbPath: string };
  log: (msg: string) => void;
}

export interface ScenarioOutcome {
  assertions: AssertionResult[];
  notes: string[];
  observed?: Array<Record<string, unknown>>;
}

export interface ScenarioDef {
  name: string;
  aliases?: string[];
  title: string;
  level: 'smoke' | 'full';
  /** 会产生真实 LLM 消耗 / 真实派活 */
  consumesLlm: boolean;
  description: string;
  /** 非空 = 该能力尚未落地，恒 SKIP 并给出原因（dry-run 同样跳过） */
  unsupported?: string;
  /**
   * true = 只读场景（不发消息/不触发 LLM），--dry-run 下也真正执行（作为连通性预检），
   * 而不是仅返回 planned。仅 connectivity 使用。
   */
  safeInDryRun?: boolean;
  /** 执行步骤（dry-run 打印用） */
  steps: string[];
  /** 断言清单（dry-run 打印用；真断言在 run 内实现） */
  assertionDocs: string[];
  prereqIds: string[];
  run(ctx: ScenarioContext): Promise<ScenarioOutcome>;
}

// ─── 报告 ───

export interface CanaryReport {
  tool: 'jarvis-canary';
  version: 1;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  level: 'smoke' | 'full';
  dryRun: boolean;
  scenarioFilter: string[];
  baseUrl: string;
  dbPath?: string;
  environment: { node: string; platform: string };
  /** 全局错误（如 DB 打不开），非空时退出码必为 1 */
  globalErrors: string[];
  results: ScenarioResult[];
  summary: { total: number; pass: number; fail: number; skip: number; planned: number };
}
