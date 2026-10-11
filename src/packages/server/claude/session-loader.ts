/**
 * Claude Session Loader
 * Loads conversation history from Claude Code's session files
 *
 * Claude stores sessions in ~/.claude/projects/<project-path-encoded>/
 * Each session is a JSONL file with user and assistant messages
 * 实现按主题拆入 ./session-loader/(2026-10-11 W3 拆分);本文件只作门面,
 * 再导出全部导出面(历史 import 路径 ./session-loader.js 不变)。
 */

// ============================================================================
// 模块拆分(W3,2026-10-11):实现按主题拆入 ./session-loader/,此处只作门面
// (再导出全部导出面;历史 import 路径 ./session-loader.js 不变)。
// ============================================================================


export type { SessionProvider, SessionMessage, SessionInfo, ConversationHistory, ToolExecution, FileChange } from './session-loader/session-types.js';
export { detectSessionProvider } from './session-loader/session-files.js';
export type { SessionRestoreMetadata } from './session-loader/restore-metadata.js';
export { extractSessionRestoreMetadata, getSessionRestoreMetadata } from './session-loader/restore-metadata.js';
export { encodeProjectPath, getProjectDir, listSessions } from './session-loader/session-index.js';
export { listAllSessions } from './session-loader/session-headers.js';
export type { GlobalSessionInfo, GlobalSessionSearchMatch, SessionExtractKind, SessionExtract } from './session-loader/search-types.js';
export { SNIPPETS_PER_SESSION } from './session-loader/search-types.js';
export type { SearchFileCacheEntry } from './session-loader/search-scan.js';
export type { FileSearchPlan } from './session-loader/search-plan.js';
export { planFileSearch, planTokenFileSearch, foldAccents, accentFoldPattern, nearbyTokensPattern } from './session-loader/search-plan.js';
export { pickExtractsFromLines, pickSnippetFromLines, scanSessionFileForQuery } from './session-loader/search-collect.js';
export { parseRgCounts, parseRgSampleLines, RG_USER_PROMPT_MARKER, userPromptWithNeedlePattern } from './session-loader/search-ripgrep.js';
export { sessionSearchScore, rankSessionMatches, searchAllSessions } from './session-loader/search-rank.js';
export { loadSession, loadSessionAroundMatch, searchSession, findLatestSession, loadSessionHistory, getSessionSummary, loadToolHistory } from './session-loader/parse-dispatch.js';
export type { SessionActivityStatus } from './session-loader/activity-status.js';
export { getSessionActivityStatus } from './session-loader/activity-status.js';
export type { ProviderProcessInfo } from './session-loader/processes.js';
export { snapshotProviderProcesses, isClaudeProcessRunningInCwd, isCodexProcessRunningInCwd, findClaudeProcessPidInCwd, findCodexProcessPidInCwd, killClaudeProcessInCwd, killCodexProcessInCwd, isOpencodeProcessRunningInCwd, findOpencodeProcessPidInCwd, killOpencodeProcessInCwd, isGrokProcessRunningInCwd, findGrokProcessPidInCwd, killGrokProcessInCwd, isPiProcessRunningInCwd, findPiProcessPidInCwd, killPiProcessInCwd } from './session-loader/processes.js';


