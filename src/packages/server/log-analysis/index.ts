/**
 * 日志分析智能体（⑮ P1）模块入口 —— 新增独立模块，不注册路由、不改 index.ts。
 *
 * 接线尾（03·尾，由主脑在 vcs 空闲窗口派发）预期接两处：
 *   1) 自留区查询入口（voice-companion 的查询动作处理，类似 list_agents/query）：
 *      识别"查日志"意图后调用 runLogAnalysis({ preset: 'yesterday' }) 并用
 *      renderLogAnalysisReport() 产出文本；
 *   2) 报告推送（⑥ 播报分级，任务 09 后）：把渲染文本交给既有播报出口。
 */

export { runLogAnalysis, type RunLogAnalysisOptions } from './service.js';
export { renderLogAnalysisReport } from './render.js';
export { resolveTimeWindow, localMidnight, type TimeWindowInput, type TimeWindowPreset } from './time-window.js';
export {
  collectLogs,
  createDefaultDeps,
  readServerLogWindow,
  type CollectedLogs,
  type CollectLimits,
  type LogAnalysisDeps,
  type ServerLogLine,
  type ServerLogReadOptions,
  type ServerLogReadResult,
} from './collect.js';
export {
  buildEvidenceIndex,
  coerceLogId,
  enrichEvidence,
  filterRecommendations,
  parseFindings,
  validateEvidenceList,
  validateEvidenceRef,
  type LogEvidenceIndex,
} from './evidence.js';
export { extractJsonObject, parseAnalysisOutput, type ParsedAnalysisOutput } from './parse.js';
export { buildLogStats } from './stats.js';
export {
  LOG_ANALYSIS_AGENT_ID,
  LOG_ANALYSIS_AGENT_NAME,
  LOG_ANALYSIS_SYSTEM_PROMPT,
  buildLogAnalysisUserContent,
  selectPromptSystemRows,
  type BuildUserContentInput,
  type PromptInputBudget,
} from './prompt.js';
export { createClaudeCliInvoker, parseClaudeJsonOutput, type ClaudeCliInvokerOptions } from './claude-invoker.js';
export type {
  AnalysisFinding,
  AnalysisRecommendation,
  DroppedRecommendation,
  LLMInvoker,
  LLMInvokerRequest,
  LLMInvokerResult,
  LogAnalysisDegradeReason,
  LogAnalysisReport,
  LogEvidenceRef,
  LogStats,
  LogWindow,
} from './types.js';
