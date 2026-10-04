/**
 * 日志分析智能体（⑮ P1，Spec §4.15）— 类型契约
 *
 * 本模块是「只读日志分析 + 证据强制过滤」的独立实现，不注册路由、不接委派通道、
 * 不计配额；由手动运行入口 runLogAnalysis() 驱动（后续 03·尾 再接自留区查询/报告推送）。
 *
 * 硬规则（Spec §4.15 行为定义 3）：优化建议必须 evidence-based —— 每条建议必须携带
 * 引用了真实存在的 system_log 记录的证据；无证据或引用不存在 id 的建议在代码层被
 * 过滤（不是提示词口头要求），被丢弃项记入 DroppedRecommendation 供审计。
 */

/** 报告四段中的前三段共用「发现」结构；建议段在此基础上扩展。 */
export interface AnalysisFinding {
  title: string;
  detail?: string;
  /** high / medium / low（模型输出，宽松透传，不强制枚举） */
  severity?: string;
  /**
   * 证据引用：过滤后仅保留「在本次数据窗内确实存在」的 system_log 行，
   * 且 ts/category/source/level 由代码按真实行回填（模型自报值不可信）。
   */
  evidence: LogEvidenceRef[];
}

/** 证据引用：logId 为强制校验锚点（system_log 行 id）。 */
export interface LogEvidenceRef {
  logId: number;
  /** 以下均为代码按真实行回填 */
  ts?: number;
  category?: string;
  source?: string;
  level?: string;
  /** 建议所依据的字段路径/片段标识，如 'body.durationMs'（模型可给，仅作注释） */
  field?: string;
  /** 从真实 body 截取的短引文（≤120 字符），便于拍板时核对 */
  quote?: string;
}

/** 优化建议：action 为可拍板动作；target 建议对齐 Spec §8.2 标定参数名。 */
export interface AnalysisRecommendation extends AnalysisFinding {
  /** 做什么（可拍板动作） */
  action: string;
  /** 关联参数/决策表条目，如 '§8.2 播报相关性阈值(60)' */
  target?: string;
  priority?: string;
  expectedEffect?: string;
}

/** 被证据硬规则拒绝的建议（审计用：证明过滤生效，而不是模型没提）。 */
export interface DroppedRecommendation {
  title: string;
  reason: 'no-evidence' | 'all-evidence-invalid' | 'malformed';
  /** 模型给出的原始引用（便于排查提示词/幻觉问题） */
  rawEvidence: unknown;
}

export interface LogWindow {
  from: number;
  /** 含右端点（查询用 ts <= to） */
  to: number;
  /** 人读标签，如 '昨天 2026-10-03 00:00 ~ 24:00' */
  label?: string;
}

/** 确定性统计（不依赖 LLM；LLM 失败时报告仍可用）。 */
export interface LogStats {
  total: number;
  byCategory: Record<string, number>;
  byLevel: Record<string, number>;
  bySource: Record<string, number>;
  errorRows: number;
  warnRows: number;
  /** body.cat='resource' 的资源聚合（⑭ 系统活动 4 落盘形态） */
  resource: {
    turns: number;
    tokensInput: number;
    tokensOutput: number;
    tokensTotal: number;
    costUsd: number;
    models: Record<string, number>;
  };
  /** body.durationMs 存在时的耗时分布（p50/p95 为近似，样本 <1 则 null） */
  durationMs: { count: number; p50: number; p95: number; max: number } | null;
  /** server.log 摘录中的 ERROR / WARN 行数 */
  serverLogErrors: number;
  serverLogWarns: number;
}

export type LogAnalysisDegradeReason = 'no-data' | 'collect-error' | 'llm-error' | 'parse-error';

export interface LogAnalysisReport {
  generatedAt: number;
  window: LogWindow;
  /** 数据源概况（收集后即可用，LLM 失败不影响） */
  source: {
    systemLogRows: number;
    auditLogRows: number;
    serverLogLines: number;
    warnings: string[];
  };
  stats: LogStats;
  /** 四段：异常 / 瓶颈 / 资源 / 优化建议清单 */
  anomalies: AnalysisFinding[];
  bottlenecks: AnalysisFinding[];
  resources: AnalysisFinding[];
  recommendations: AnalysisRecommendation[];
  /** 证据过滤丢弃项（可审计、可单测） */
  droppedRecommendations: DroppedRecommendation[];
  /** 降级原因：无数据 / 数据源全失败 / LLM 失败 / 输出不可解析 */
  degraded?: LogAnalysisDegradeReason;
  llm?: { model?: string; durationMs?: number };
}

/** 一次性 LLM 调用入口（注入点：测试传 stub；生产用 Claude CLI 垫片）。 */
export interface LLMInvokerRequest {
  systemPrompt: string;
  userContent: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LLMInvokerResult {
  text: string;
  durationMs?: number;
  model?: string;
}

export type LLMInvoker = (req: LLMInvokerRequest) => Promise<LLMInvokerResult>;
