/**
 * HistoryLine 的类型定义(props)。
 *
 * 自 HistoryLine.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { type TestRunHandle, type HttpRunHandle } from '../../../store';
import { type EnrichedHistoryMessage, type EditData } from '../types';
import { type ExecTask, type Subagent } from '../../../../shared/types';

export interface HistoryLineProps {
  message: EnrichedHistoryMessage;
  agentId?: string | null;
  simpleView?: boolean;
  /** Row is the active find match: reveal searchable content the renderer
   *  normally hides (e.g. bash output when inline outputs are off). */
  searchReveal?: boolean;
  /**
   * Subagents map keyed by subagent id. Needed so that persisted Task/Agent
   * tool_use rows can render the inline activity + stream panel — the live
   * tool_use chip gets deduped against the JSONL once it flushes, leaving
   * HistoryLine as the sole renderer of the Task chip.
   */
  subagents?: Map<string, Subagent>;
  execTasks?: ExecTask[];
  testRunHandles?: TestRunHandle[];
  httpRunHandles?: HttpRunHandle[];
  onImageClick?: (url: string, name: string) => void;
  onFileClick?: (path: string, editData?: EditData | { highlightRange: { offset: number; limit: number } }) => void;
  onBashClick?: (command: string, output: string) => void;
  onViewMarkdown?: (content: string) => void;
}
