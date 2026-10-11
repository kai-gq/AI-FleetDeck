/**
 * Shared output rendering utilities for ClaudeOutputPanel (Guake) and CommanderView
 * This file contains common functions for displaying Claude output, tool calls, etc.
 * 实现已拆入 ./outputRendering/ 子模块(2026-10-11 W2 拆分);本文件只作对外唯一门面
 * (re-export),历史 import 路径与导出名保持不变。
 */

// ============================================================================
// 模块拆分(W2,2026-10-11):实现已按主题拆入 outputRendering/ 子模块;
// 本文件只作对外唯一门面(re-export),历史 import 路径与导出名保持不变
// (含私有块的模块列显式名单,避免内部助手顺带泄漏)。
// ============================================================================
export { TOOL_ICONS, TOOL_ICON_NAMES, getToolIcon, getToolIconName, prettifyToolName, getLocalizedToolName, getTrackingStatusIcon, getTrackingStatusIconName } from './outputRendering/tool-icons';
export { shortenId, getTodoStatusIcon, formatTimestamp, truncateString, truncateFilePath } from './outputRendering/format';
export * from './outputRendering/codex';
export { type CodexGrepMatch, type CodexGrepResults, parseCodexGrepResults } from './outputRendering/codex-grep';
export * from './outputRendering/read-targets';
export { type ShellWriteSummary, getShellWriteSummary, formatShellWriteFollowUp, getShellCommandPresentation, normalizeShellCommand } from './outputRendering/shell';
export { type BashRowStep, type BashRowSummary, getBashRowSummary } from './outputRendering/bash-row';
export { shellSplitWords, extractExecPayloadCommand, isCurlCommandTo, BASH_COMMAND_DISPLAY_MAX, bashCommandDisplaySlice, extractExecWrappedCommand, findExecTaskForCurlRow } from './outputRendering/exec-payload';
export { getFileToolDetail, isSimpleViewOutput, type CommandTextSegment, splitCommandForFileLinks, isHumanReadableOutput, isChatViewOutput, isErrorResult, formatToolInput, parseToolName, parseToolResult, parseToolInput } from './outputRendering/output-classify';
export { linkifyFilePathsForMarkdown, extractFilePathTokens, decodeTideFileHref } from './outputRendering/file-links';
export { type BashSearchCommandInfo, type BashNotificationCommandInfo, parseBashSearchCommand, parseBashNotificationCommand, type BashTaskLabelCommandInfo, parseBashTaskLabelCommand, type BashReportTaskCommandInfo, type TrackingStatusValue, type BashTrackingStatusCommandInfo, parseBashTrackingStatusCommand, parseBashReportTaskCommand, type BashMemoryKind, type BashMemoryCommandInfo, type BashMemoryResponseInfo, parseBashMemoryCommand, parseMemoryResponseInfo } from './outputRendering/bash-parsers';
export * from './outputRendering/tool-key-param';
