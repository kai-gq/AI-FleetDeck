/**
 * OutputLine 的类型定义(props)。
 *
 * 自 OutputLine.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { ClaudeOutput, type TestRunHandle, type HttpRunHandle } from '../../../store';
import { type EditData } from '../types';
import { type ExecTask, type Subagent } from '../../../../shared/types';

export interface OutputLineProps {
  output: ClaudeOutput & { _toolKeyParam?: string; _editData?: EditData; _todoInput?: string; _bashOutput?: string; _bashCommand?: string; _isRunning?: boolean };
  agentId: string | null;
  execTasks?: ExecTask[];
  testRunHandles?: TestRunHandle[];
  httpRunHandles?: HttpRunHandle[];
  subagents?: Map<string, Subagent>;
  onImageClick?: (url: string, name: string) => void;
  onFileClick?: (path: string, editData?: EditData | { highlightRange: { offset: number; limit: number } }) => void;
  onBashClick?: (command: string, output: string) => void;
  onViewMarkdown?: (content: string) => void;
  /** Row is the active find match: reveal searchable content the renderer
   *  normally hides (e.g. bash output when inline outputs are off). */
  searchReveal?: boolean;
}
