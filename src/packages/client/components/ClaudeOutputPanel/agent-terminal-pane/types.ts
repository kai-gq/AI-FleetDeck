/**
 * AgentTerminalPane 的类型定义(props / 命令式句柄)。
 *
 * 自 AgentTerminalPane.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import React from 'react';
import { type ClaudeOutput } from '../../../store';
import { type Agent } from '../../../../shared/types';
import { type AttachedFile } from '../../shared/outputTypes';
import { type ViewMode, type EnrichedHistoryMessage } from '../types';
import { type UseSearchHistoryReturn } from '../useSearchHistory';
import { SearchBar } from '../TerminalHeader';
import { TerminalInputArea } from '../TerminalInputArea';

export interface AgentTerminalPaneProps {
  /** The agent ID this pane displays */
  agentId: string;
  /** The agent object (resolved by parent) */
  agent: Agent;
  /** View mode (simple/chat/advanced) */
  viewMode: ViewMode;
  /** Whether the terminal is open/visible */
  isOpen: boolean;
  /** Show structured output cards produced by plugin slash commands. */
  showSlashCommandOutputs?: boolean;

  // ── Modal callbacks (parent owns modals) ──
  onImageClick: (url: string, name: string) => void;
  onFileClick: (path: string, editData?: { oldString?: string; newString?: string; operation?: string; unifiedDiff?: string; highlightRange?: { offset: number; limit: number }; targetLine?: number }) => void;
  onBashClick: (command: string, output: string) => void;
  onViewMarkdown: (content: string) => void;
  /**
   * Fired when a Bash tool_use in dedupedHistory becomes linked to its
   * tool_result for the first time. The parent uses this to resolve a
   * currently-open "Running..." bash modal whose live look-ahead window
   * has already passed by the time the tool_result lands in the JSONL.
   */
  onLiveBashResultLinked?: (command: string, output: string) => void;

  // ── Keyboard height handler (parent owns, shared) ──
  keyboard: {
    handleInputFocus: () => void;
    handleInputBlur: () => void;
    keyboardScrollLockRef: React.MutableRefObject<boolean>;
    cleanup: () => void;
  };

  // ── Mobile swipe close (for TerminalInputArea) ──
  canSwipeClose?: boolean;
  onSwipeCloseOffsetChange?: (offset: number) => void;
  onSwipeClose?: () => void;

  /** Whether any modal is open in the parent (disables message navigation) */
  hasModalOpen?: boolean;
}

/**
 * Imperative handle exposed to parent for cross-component interactions
 * (swipe navigation, search-from-header, file drag-drop, etc.)
 */
export interface AgentTerminalPaneHandle {
  /** Scroll container ref — used by parent for swipe navigation */
  outputScrollRef: React.RefObject<HTMLDivElement | null>;
  /** Input refs — used by parent for focus management */
  inputRef: React.RefObject<HTMLInputElement | null>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** History loader — used by parent header for load-more button */
  historyLoader: {
    loadingHistory: boolean;
    fetchingHistory: boolean;
    historyLoadVersion: number;
    loadingMore: boolean;
    hasMore: boolean;
    totalCount: number;
    loadMoreHistory: () => Promise<void>;
    clearHistory: () => void;
    hasCachedHistory: (agentId: string) => boolean;
    history: Array<{ type: string; content: string; timestamp: string }>;
  };
  /** Search state — used by parent header for SearchBar */
  search: UseSearchHistoryReturn;
  /** Terminal input — used by parent for file drag-drop */
  terminalInput: {
    uploadFile: (
      file: File | Blob,
      filename?: string,
      onProgress?: (percentage: number) => void,
    ) => Promise<AttachedFile | null>;
    setAttachedFiles: (value: AttachedFile[] | ((prev: AttachedFile[]) => AttachedFile[])) => void;
    useTextarea: boolean;
  };
  /** Combined deduped data — used by parent for search all items */
  getDedupedHistory: () => EnrichedHistoryMessage[];
  getDedupedOutputs: () => ClaudeOutput[];
  /** Output count for header display */
  outputsLength: number;
}

// ─── Component ──────────────────────────────────────────────────────────────
