/**
 * 项目目录索引:项目路径编码、getProjectDir 与 listSessions。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { PROJECTS_DIR } from './paths.js';
import { type SessionInfo } from './session-types.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Encode a path to Claude's project directory format
 * /home/user/project -> -home-user-project
 * /home/user/project/ -> -home-user-project (trailing slash removed)
 * /home/user/my_project -> -home-user-my-project (underscores replaced)
 */
export function encodeProjectPath(cwd: string): string {
  // Claude Code 的编码规则:路径中 **所有** 非字母数字字符一律映射为 '-'(含 : \ . _ ~)。
  // 实测依据(2026-10-07):对本机 ~/.claude/projects 全部 19 个真实目录,用其内会话
  // 首行 cwd 反推编码,该规则 19/19 吻合。例:
  //   E:\tide-commander\tide-commander -> E--tide-commander-tide-commander
  //   C:\Users\Administrator\.local\share\tide-commander\voice-cwd
  //     -> C--Users-Administrator--local-share-tide-commander-voice-cwd
  // 旧实现只替换 / 和 _,Windows 绝对路径里的 ':' '\' '.' 原样幸存 ->
  // 目录永远不存在 -> 会话文件永远 not found(面板历史/语音查产出/会话搜索全失效)。
  const normalized = cwd.replace(/[\\/]+$/, '');
  return normalized.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Get the Claude projects directory for a given working directory
 */
export function getProjectDir(cwd: string): string {
  const encoded = encodeProjectPath(cwd);
  return path.join(PROJECTS_DIR, encoded);
}

/**
 * List all sessions for a project directory
 */
export async function listSessions(cwd: string): Promise<SessionInfo[]> {
  const projectDir = getProjectDir(cwd);

  if (!fs.existsSync(projectDir)) {
    return [];
  }

  const files = fs.readdirSync(projectDir);
  const sessions: SessionInfo[] = [];

  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;

    const sessionId = file.replace('.jsonl', '');
    const filePath = path.join(projectDir, file);
    const stats = fs.statSync(filePath);

    // Quick count of messages (approximate)
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const messageCount = lines.filter(l => {
      try {
        const parsed = JSON.parse(l);
        return parsed.type === 'user' || parsed.type === 'assistant';
      } catch {
        return false;
      }
    }).length;

    sessions.push({
      sessionId,
      projectPath: cwd,
      lastModified: stats.mtime,
      messageCount,
    });
  }

  // Sort by last modified, newest first
  sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

  return sessions;
}
