/**
 * GuakeGitPanel 的纯助手(语言与二进制判定 / 坐标命中 / 路径与文件收集)。
 *
 * 自 GuakeGitPanel.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { type BinaryPreviewKind } from './types';
import { GIT_BINARY_EXTENSIONS } from './constants';
import { ARCHIVE_EXTENSIONS } from '../../../../shared/archive-types';
import { SPREADSHEET_BINARY_EXTENSIONS } from '../../../../shared/spreadsheet-types';
import { DOCUMENT_EXTENSIONS } from '../../../../shared/document-types';
import { getLanguageForExtension } from '../../FileExplorerPanel/syntaxHighlighting';
import { type GitTreeNode } from '../../FileExplorerPanel/fileUtils';
import { type GitFileStatus, type GitFileStatusType, type TreeNode } from '../../FileExplorerPanel/types';

export function getLanguageForFile(filename: string): string {
  const ext = filename.lastIndexOf('.') >= 0 ? filename.substring(filename.lastIndexOf('.')) : '';
  return getLanguageForExtension(ext);
}

export function getBinaryPreviewKind(filename: string): BinaryPreviewKind | null {
  const dot = filename.lastIndexOf('.');
  const extension = dot >= 0 ? filename.slice(dot).toLowerCase() : '';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico'].includes(extension)) return 'image';
  if (extension === '.pdf') return 'pdf';
  if (extension === '.stl') return 'stl';
  if (extension === '.fcstd') return 'fcstd';
  if (extension === '.glb' || extension === '.gbl') return 'glb';
  if (extension === '.gcode' || extension === '.gco') return 'gcode';
  // Compressed containers get a browsable entry tree instead of "binary".
  if (ARCHIVE_EXTENSIONS.includes(extension)) return 'archive';
  // Workbooks get the sheet grid (legacy .xls/.ods explain themselves inside it).
  if (SPREADSHEET_BINARY_EXTENSIONS.includes(extension)) return 'spreadsheet';
  // Word-processing documents get the reading page.
  if (DOCUMENT_EXTENSIONS.includes(extension)) return 'document';
  return GIT_BINARY_EXTENSIONS.has(extension) ? 'binary' : null;
}

export function isPositionInArea(pos: { x: number; z: number }, area: { center: { x: number; z: number }; width: number; height: number; type: string }): boolean {
  if (area.type === 'circle') {
    const dx = pos.x - area.center.x;
    const dz = pos.z - area.center.z;
    const r = Math.max(area.width, area.height) / 2;
    return dx * dx + dz * dz <= r * r;
  }
  const halfW = area.width / 2;
  const halfH = area.height / 2;
  return pos.x >= area.center.x - halfW && pos.x <= area.center.x + halfW
    && pos.z >= area.center.z - halfH && pos.z <= area.center.z + halfH;
}

/** Returns true for statuses that have a previous git version to diff against */
export function hasDiff(status: GitFileStatusType): boolean {
  return status === 'modified' || status === 'renamed' || status === 'deleted' || status === 'conflict';
}

/** Parent path for deleted git entries that no longer exist on disk. */
export function parentPath(filePath: string): string {
  const clean = filePath.replace(/[\\/]+$/, '');
  const separator = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return separator > 0 ? clean.slice(0, separator) : clean;
}

/** Recursively collect every changed file under a git-tree (Changes tab) directory node. */
export function collectFilesFromGitNode(node: GitTreeNode): GitFileStatus[] {
  if (!node.isDirectory) return node.file ? [node.file] : [];
  const out: GitFileStatus[] = [];
  for (const child of node.children) out.push(...collectFilesFromGitNode(child));
  return out;
}

/** Recursively collect git-changed files under an explorer (Files tab) directory node. */
export function collectGitFilesFromExplorerNode(node: TreeNode): Array<{ path: string; status: GitFileStatusType }> {
  if (!node.isDirectory) {
    return node.gitStatus ? [{ path: node.path, status: node.gitStatus as GitFileStatusType }] : [];
  }
  const out: Array<{ path: string; status: GitFileStatusType }> = [];
  for (const child of node.children || []) out.push(...collectGitFilesFromExplorerNode(child));
  return out;
}

// ==========================================================================
// FILTER MATCH HIGHLIGHT
// ==========================================================================
