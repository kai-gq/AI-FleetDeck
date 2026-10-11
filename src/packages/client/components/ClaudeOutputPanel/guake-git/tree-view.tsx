/**
 * 树节点渲染与过滤命中高亮(自 GuakeGitPanel 迁出)。
 *
 * 自 GuakeGitPanel.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { type TreeNodeProps } from './types';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { GIT_STATUS_CONFIG } from '../../FileExplorerPanel/constants';
import { getIconForFileName } from '../../FileExplorerPanel/fileUtils';
import { highlightRanges } from '../gitFileFilter';
import { type ParsedFileFilter } from '../gitFileFilter';
import { Icon } from '../../Icon';

/** Renders `text` with the filter's matched characters wrapped in <mark>. */
export function HighlightedText({ text, filter }: { text: string; filter: ParsedFileFilter }) {
  const ranges = useMemo(() => highlightRanges(filter, text), [filter, text]);
  if (ranges.length === 0) return <>{text}</>;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark key={start} className="guake-git-filter-hit">{text.slice(start, end)}</mark>
    );
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export function TreeNodeView({ node, depth, expandedDirs, onToggleDir, onFileClick, onContextMenu, onFolderContextMenu, onDiscard, repoDir, filter }: TreeNodeProps) {
  const { t } = useTranslation('terminal');
  if (node.isDirectory) {
    const isExpanded = expandedDirs.has(node.path);
    const folderIconSrc = isExpanded
      ? `${import.meta.env.BASE_URL}assets/vscode-icons/default_folder_opened.svg`
      : `${import.meta.env.BASE_URL}assets/vscode-icons/default_folder.svg`;
    return (
      <>
        <div
          className="guake-git-file guake-git-tree-dir"
          style={{ paddingLeft: `${12 + depth * 20}px` }}
          onClick={() => onToggleDir(node.path)}
          onContextMenu={onFolderContextMenu ? (e) => onFolderContextMenu(e, node, repoDir) : undefined}
        >
          <span className="guake-git-repo-arrow" style={{ marginRight: 4 }}>
            <Icon name={isExpanded ? 'caret-down' : 'caret-right'} size={12} />
          </span>
          <img src={folderIconSrc} alt="" className="guake-git-file-icon guake-git-folder-icon" />
          <span className="guake-git-file-name"><HighlightedText text={node.name} filter={filter} /></span>
          <span className="guake-git-repo-count" style={{ marginLeft: 'auto' }}>{node.fileCount}</span>
        </div>
        {isExpanded && node.children.map((child) => (
          <TreeNodeView
            key={child.path}
            node={child}
            depth={depth + 1}
            expandedDirs={expandedDirs}
            onToggleDir={onToggleDir}
            onFileClick={onFileClick}
            onContextMenu={onContextMenu}
            onFolderContextMenu={onFolderContextMenu}
            onDiscard={onDiscard}
            repoDir={repoDir}
            filter={filter}
          />
        ))}
      </>
    );
  }

  // File node
  const file = node.file!;
  const cfg = GIT_STATUS_CONFIG[file.status];
  const iconSrc = getIconForFileName(file.name);
  return (
    <div
      className="guake-git-file"
      data-status={file.status}
      style={{ paddingLeft: `${28 + depth * 20}px` }}
      onClick={() => onFileClick(file, repoDir)}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, file, repoDir) : undefined}
      title={file.path}
    >
      {iconSrc && <img src={iconSrc} alt="" className="guake-git-file-icon" />}
      <span className="guake-git-file-name"><HighlightedText text={file.name} filter={filter} /></span>
      <span className="guake-git-file-status" style={{ color: cfg.color, marginLeft: 'auto' }} title={t(`terminal:fileExplorer.gitStatus.${file.status}`, { defaultValue: cfg.label })}>
        {cfg.icon}
      </span>
      {onDiscard && (
        <button
          className="guake-git-discard-btn"
          title={file.status === 'untracked' || file.status === 'added' ? t('gitPanel.discardBtnDeleteFile', { defaultValue: 'Delete file' }) : t('gitPanel.discardBtnDiscardChanges', { defaultValue: 'Discard changes' })}
          onClick={(e) => onDiscard(e, file, repoDir)}
        >
          <Icon name="revert" size={12} />
        </button>
      )}
    </div>
  );
}

// ==========================================================================
// MAIN COMPONENT
// ==========================================================================
