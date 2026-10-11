/**
 * FileViewerModal 的类型定义(props / 解析结果与策略 / 文件数据 / 未找到详情)。
 *
 * 自 FileViewerModal.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { type MissingFileDiagnosis } from '../shared/MissingFileView';

export interface FileViewerModalProps {
  isOpen: boolean;
  onClose: () => void;
  filePath: string;
  action: 'created' | 'modified' | 'deleted' | 'read';
  // Optional: edit data for showing diff view OR line highlight
  editData?: {
    oldString?: string;
    newString?: string;
    operation?: string;
    unifiedDiff?: string;
    /** Literal replacements a shell/script edit performed, newest state last. */
    replacements?: Array<{ oldText: string; newText: string }>;
    // For Read tool - highlight these lines
    highlightRange?: { offset: number; limit: number };
    // For direct file references like path/to/file.ts:16
    targetLine?: number;
  };
  // Optional: project root for fallback file search when file not found
  searchRoot?: string;
}

export interface ResolveResult {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  extension: string;
}

type ResolutionStrategy =
  | 'exact'
  | 'cached'
  | 'parent-walk'
  | 'git-root'
  | 'suffix-match'
  | 'node-modules-match'
  | 'area-root'
  | 'area-suffix-match'
  | 'child-anchor';

export interface FileData {
  path: string;
  filename: string;
  extension: string;
  content: string;
  size: number;
  modified: string;
  strategy?: ResolutionStrategy;
  areaId?: string;
  areaName?: string;
  /** Delimited file too large for the text pane — only the grid can show it. */
  gridOnly?: boolean;
}

export interface NotFoundDetail {
  message: string;
  triedRoots: string[];
  requested?: string;
  /** Server's explanation of the miss (deleted vs. folder gone, similar names, git). */
  diagnosis?: MissingFileDiagnosis;
}
