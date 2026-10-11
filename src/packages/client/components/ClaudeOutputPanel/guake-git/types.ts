/**
 * GuakeGitPanel 的类型定义(props / 仓库与展示 / 过滤器与差异态 / 二进制预览 / 模态与面板模式 / 树节点)。
 *
 * 自 GuakeGitPanel.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import React from 'react';
import { type GitTreeNode } from '../../FileExplorerPanel/fileUtils';
import { type GitStatus, type GitFileStatus, type GitFileStatusType, type TreeNode } from '../../FileExplorerPanel/types';
import { type Agent } from '../../../../shared/types';
import { type ParsedFileFilter } from '../gitFileFilter';
import { type BranchInfo } from '../useGitBranch';

export interface GuakeGitPanelProps {
  agentId: string;
  agents: Map<string, Agent>;
  onClose: () => void;
  branchInfoMap: Map<string, BranchInfo>;
  fetchRemote: (dir: string) => Promise<void>;
  fetchingDirs: Set<string>;
  // When provided, renders a drag-to-resize handle glued to the panel's own
  // left edge. Used by surfaces (e.g. FlatView) where a sibling handle can't
  // reliably sit at the panel edge. Mouse-down starts the resize drag.
  onResizeStart?: (e: React.MouseEvent) => void;
}

export interface RepoStatus {
  dir: string;
  dirName: string;
  gitStatus: GitStatus;
  /** Real change count — `gitStatus.files` is capped by the server watcher. */
  totalFiles: number;
  /** True when `gitStatus.files` holds only the first slice of the changes. */
  truncated: boolean;
}

/** A repo with the filter applied: `files` is the ranked, capped match list. */
export interface DisplayRepo extends RepoStatus {
  /** Files to render — filter matches, ranked best-first and capped. */
  files: GitFileStatus[];
  /** How many files matched before the render cap was applied. */
  matchCount: number;
  /** Matches dropped by the render cap (0 when everything is shown). */
  hiddenMatches: number;
}

/** One filter hit in the Files tab — from the loaded tree or the server walk. */
export interface ExplorerMatch {
  /** Node to open on click; absolute path, git status attached when known. */
  node: TreeNode;
  /** Path relative to the explorer folder — what gets matched and displayed. */
  relPath: string;
  status?: GitFileStatusType;
}

interface DiffState {
  filePath: string;
  fileName: string;
  originalContent: string;
  modifiedContent: string;
  language: string;
}

interface ContentState {
  filePath: string;
  fileName: string;
  content: string;
  language: string;
}

export type BinaryPreviewKind = 'image' | 'pdf' | 'stl' | 'fcstd' | 'glb' | 'gcode' | 'archive' | 'spreadsheet' | 'document' | 'binary';

export interface BinaryState {
  filePath: string;
  fileName: string;
  previewKind: BinaryPreviewKind;
  isDeleted: boolean;
}

export type ModalState =
  | { type: 'diff'; data: DiffState }
  | { type: 'content'; data: ContentState; isNewFile?: boolean }
  | { type: 'binary'; data: BinaryState }
  | null;

export type ViewMode = 'flat' | 'tree';

export type PanelMode = 'changes' | 'explorer';

// ==========================================================================
// HELPERS
// ==========================================================================

export interface TreeNodeProps {
  node: GitTreeNode;
  depth: number;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onFileClick: (file: GitFileStatus, repoDir: string) => void;
  onContextMenu?: (e: React.MouseEvent, file: GitFileStatus, repoDir: string) => void;
  onFolderContextMenu?: (e: React.MouseEvent, node: GitTreeNode, repoDir: string) => void;
  onDiscard?: (e: React.MouseEvent, file: GitFileStatus, repoDir: string) => void;
  repoDir: string;
  filter: ParsedFileFilter;
}
