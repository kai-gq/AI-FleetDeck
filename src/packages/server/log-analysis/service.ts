/**
 * 日志分析服务（⑮ P1 手动运行入口）
 *
 * 用法（可编程调用，后续 03·尾 在自留区查询入口接到"秘书，查一下昨天的日志"）：
 *
 *   const report = await runLogAnalysis({ window: { preset: 'yesterday' } });
 *   console.log(renderLogAnalysisReport(report));
 *
 * 数据流：时间窗解析 → 只读收集（system_log/audit_log/server.log）→ 确定性统计 →
 * 只读 agent 提示词（四段契约 + 证据硬规则）→ 一次性 LLM 调用 → JSON 解析 →
 * 证据过滤（无证据建议丢弃）→ LogAnalysisReport。
 *
 * 降级：
 *   - 空窗（三源均无数据且无报错）→ 不发 LLM，degraded='no-data'（防凭空分析）；
 *   - 数据源全部报错且无数据 → degraded='collect-error'；
 *   - LLM 调用失败 → degraded='llm-error'（统计摘要仍在）；
 *   - LLM 输出无法解析出 JSON 对象 → degraded='parse-error'。
 *
 * 边界：只读；不注册路由；不接 ① 委派通道；不计 ⑫ 配额；任何建议都不自动执行。
 */

import type { SystemLogEntry } from '../data/system-log.js';
import type { LLMInvoker, LogAnalysisReport } from './types.js';
import { collectLogs, createDefaultDeps, type CollectLimits, type LogAnalysisDeps } from './collect.js';
import { buildLogStats } from './stats.js';
import { buildLogAnalysisUserContent, LOG_ANALYSIS_SYSTEM_PROMPT } from './prompt.js';
import { parseAnalysisOutput } from './parse.js';
import { buildEvidenceIndex } from './evidence.js';
import { resolveTimeWindow, type TimeWindowInput } from './time-window.js';
import { createClaudeCliInvoker, type ClaudeCliInvokerOptions } from './claude-invoker.js';

export interface RunLogAnalysisOptions {
  /** 时间窗预设：'yesterday'（"昨天"）/ 'today' / 'last24h' / 'last7d' */
  preset?: TimeWindowInput['preset'];
  /** 显式时间窗（epoch ms）；给定时覆盖 preset */
  from?: number;
  to?: number;
  /** 测试注入"当前时刻" */
  now?: number;
  /** LLM 模型（缺省 haiku）；同义传给默认 Claude CLI invoker */
  model?: string;
  timeoutMs?: number;
  /** 一次性 LLM 调用（测试传 stub；缺省 createClaudeCliInvoker） */
  invokeLLM?: LLMInvoker;
  /** 默认 invoker 覆盖项（如 executablePath，测试/特殊环境用） */
  invokerOptions?: ClaudeCliInvokerOptions;
  /** 数据源查询注入（测试模拟查询报错） */
  deps?: Partial<LogAnalysisDeps>;
  limits?: CollectLimits;
  /** server.log 路径覆盖（缺省 getLogFilePath()） */
  serverLogPath?: string;
  promptBudget?: { maxSystemRows?: number; maxAuditRows?: number };
  signal?: AbortSignal;
}

/** 收集结果是否"有数据"（含 audit/server.log —— 空 system_log 但有 audit 也要分析）。 */
function hasAnyData(systemLog: SystemLogEntry[], auditCount: number, serverLines: number): boolean {
  return systemLog.length > 0 || auditCount > 0 || serverLines > 0;
}

/**
 * 手动运行日志分析（P1）。不抛异常：数据源/LLM 失败一律降级为带说明的报告。
 */
export async function runLogAnalysis(opts: RunLogAnalysisOptions = {}): Promise<LogAnalysisReport> {
  const window = resolveTimeWindow({
    preset: opts.preset,
    from: opts.from,
    to: opts.to,
    now: opts.now,
  });

  const deps: LogAnalysisDeps = { ...createDefaultDeps(), ...opts.deps };
  const collected = collectLogs(window, opts.limits, deps, opts.serverLogPath);
  const stats = buildLogStats(collected.systemLog, collected.serverLog);

  const baseReport: LogAnalysisReport = {
    generatedAt: Date.now(),
    window,
    source: {
      systemLogRows: collected.systemLog.length,
      auditLogRows: collected.auditLog.length,
      serverLogLines: collected.serverLog.lines.length,
      warnings: collected.warnings,
    },
    stats,
    anomalies: [],
    bottlenecks: [],
    resources: [],
    recommendations: [],
    droppedRecommendations: [],
  };

  if (!hasAnyData(collected.systemLog, collected.auditLog.length, collected.serverLog.lines.length)) {
    const sourceError = collected.errors.systemLog || collected.errors.auditLog || collected.errors.serverLog;
    return { ...baseReport, degraded: sourceError ? 'collect-error' : 'no-data' };
  }

  const index = buildEvidenceIndex(collected.systemLog);
  const userContent = buildLogAnalysisUserContent({
    window,
    systemLog: collected.systemLog,
    auditLog: collected.auditLog,
    serverLogLines: collected.serverLog.lines,
    stats,
    warnings: collected.warnings,
    budget: opts.promptBudget,
  });

  const invoker = opts.invokeLLM ?? createClaudeCliInvoker({ ...opts.invokerOptions, model: opts.model });

  let llmText: string;
  let llmDurationMs: number | undefined;
  let llmModel: string | undefined;
  try {
    const result = await invoker({
      systemPrompt: LOG_ANALYSIS_SYSTEM_PROMPT,
      userContent,
      model: opts.model,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    llmText = result.text;
    llmDurationMs = result.durationMs;
    llmModel = result.model;
  } catch (err) {
    return {
      ...baseReport,
      degraded: 'llm-error',
      llm: { model: opts.model },
      source: {
        ...baseReport.source,
        warnings: [...collected.warnings, `LLM 调用失败：${(err as Error).message}`],
      },
    };
  }

  const parsed = parseAnalysisOutput(llmText, index);
  if (!parsed.ok) {
    return {
      ...baseReport,
      degraded: 'parse-error',
      llm: { model: llmModel ?? opts.model, durationMs: llmDurationMs },
      source: {
        ...baseReport.source,
        warnings: [...collected.warnings, 'LLM 输出未能解析出 JSON 对象（已保留统计摘要，四段为空）。'],
      },
    };
  }

  return {
    ...baseReport,
    anomalies: parsed.anomalies,
    bottlenecks: parsed.bottlenecks,
    resources: parsed.resources,
    recommendations: parsed.recommendations,
    droppedRecommendations: parsed.droppedRecommendations,
    llm: { model: llmModel ?? opts.model, durationMs: llmDurationMs },
  };
}
