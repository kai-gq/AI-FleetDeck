/**
 * FileViewerModal 的纯助手(统一 diff 还原 / 扩展名判定 / 代码文本提取)。
 *
 * 自 FileViewerModal.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import React from 'react';

/**
 * Reconstruct the original file content from the current (modified) content
 * and a unified diff. Reverses the diff: removes added lines, restores removed lines.
 */
export function reconstructOriginalFromUnifiedDiff(currentContent: string, diffText: string): string | null {
  try {
    if (/^\*\*\* (?:Update|Add|Delete) File:/m.test(diffText)) {
      const header = diffText.match(/^\*\*\* (Update|Add|Delete) File:/m)?.[1];
      if (header === 'Add') return '';
      let reconstructed = currentContent;
      const body = diffText.replace(/^\*\*\* (?:Update|Add|Delete) File:.*$/m, '');
      const hunks = body.split(/^@@.*$/m).filter((part) => part.trim());
      for (const hunk of hunks) {
        const oldLines: string[] = [];
        const newLines: string[] = [];
        for (const line of hunk.replace(/^\n/, '').split('\n')) {
          if (line.startsWith('***')) continue;
          if (line.startsWith('-')) oldLines.push(line.slice(1));
          else if (line.startsWith('+')) newLines.push(line.slice(1));
          else {
            const context = line.startsWith(' ') ? line.slice(1) : line;
            oldLines.push(context);
            newLines.push(context);
          }
        }
        const oldBlock = oldLines.join('\n');
        const newBlock = newLines.join('\n');
        if (!newBlock) continue;
        const index = reconstructed.indexOf(newBlock);
        if (index < 0) return null;
        reconstructed = reconstructed.slice(0, index) + oldBlock + reconstructed.slice(index + newBlock.length);
      }
      return reconstructed;
    }
    const currentLines = currentContent.split('\n');
    const diffLines = diffText.split('\n');
    const result: string[] = [];
    let currentIdx = 0; // 0-based index into currentLines

    for (let d = 0; d < diffLines.length; d++) {
      const line = diffLines[d];
      // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
      if (!hunkMatch) continue;

      const newStart = parseInt(hunkMatch[3], 10); // 1-based line in modified file
      const _newCount = parseInt(hunkMatch[4] ?? '1', 10);

      // Copy unchanged lines before this hunk
      const hunkStartIdx = newStart - 1; // 0-based
      while (currentIdx < hunkStartIdx && currentIdx < currentLines.length) {
        result.push(currentLines[currentIdx]);
        currentIdx++;
      }

      // Process hunk lines
      let _newLinesConsumed = 0;
      for (let h = d + 1; h < diffLines.length; h++) {
        const hLine = diffLines[h];
        if (hLine.startsWith('@@') || hLine.startsWith('diff ')) break;
        if (hLine.startsWith('---') || hLine.startsWith('+++') ||
            hLine.startsWith('index ') || hLine.startsWith('new file') ||
            hLine.startsWith('deleted file') || hLine.startsWith('\\')) continue;

        if (hLine.startsWith('-')) {
          // Removed line: add to original (restore it)
          result.push(hLine.slice(1));
        } else if (hLine.startsWith('+')) {
          // Added line: skip (don't include in original), consume from current
          _newLinesConsumed++;
          currentIdx++;
        } else {
          // Context line: include in original, consume from current
          result.push(hLine.startsWith(' ') ? hLine.slice(1) : hLine);
          _newLinesConsumed++;
          currentIdx++;
        }
      }
    }

    // Copy remaining unchanged lines after last hunk
    while (currentIdx < currentLines.length) {
      result.push(currentLines[currentIdx]);
      currentIdx++;
    }

    return result.join('\n');
  } catch {
    return null;
  }
}

export function hasFileExtension(extension: string | undefined, path: string, extensions: string[]): boolean {
  const normalizedExtension = extension?.toLowerCase();
  if (normalizedExtension && extensions.includes(normalizedExtension)) return true;
  const normalizedPath = path.toLowerCase().split(/[?#]/, 1)[0];
  return extensions.some((candidate) => normalizedPath.endsWith(candidate));
}

/** Flatten react-markdown code children into the raw fenced-block text. */
export function extractCodeText(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(extractCodeText).join('');
  return children == null ? '' : String(children);
}

export function getCodeLanguage(className: string | undefined): string | undefined {
  return /language-(\w+)/.exec(className || '')?.[1];
}
