/**
 * 会话文件定位:各 provider 的 session 文件查找与 resolveSessionFile/detectSessionProvider。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { CODEX_SESSIONS_DIR, OPENCODE_DB_PATH, OPENCODE_SESSION_DIR, GROK_SESSIONS_DIR, PI_SESSIONS_DIR } from './paths.js';
import { type SessionProvider, type ResolvedSessionFile } from './session-types.js';
import { codexSessionFileById, opencodeSessionFileById, piSessionFileById, findOpencodeDbSession } from './opencode-db.js';
import { getProjectDir } from './session-index.js';
import * as fs from 'fs';
import * as path from 'path';

function findCodexSessionFile(sessionId: string): string | null {
  const cached = codexSessionFileById.get(sessionId);
  if (cached && fs.existsSync(cached)) {
    return cached;
  }

  if (!fs.existsSync(CODEX_SESSIONS_DIR)) {
    return null;
  }

  const queue = [CODEX_SESSIONS_DIR];

  while (queue.length > 0) {
    const dir = queue.pop();
    if (!dir) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }

      if (!entry.name.includes(sessionId)) {
        continue;
      }

      codexSessionFileById.set(sessionId, fullPath);
      return fullPath;
    }
  }

  return null;
}

function findOpencodeSessionFile(sessionId: string): string | null {
  const cached = opencodeSessionFileById.get(sessionId);
  if (cached && fs.existsSync(cached)) {
    return cached;
  }

  if (!fs.existsSync(OPENCODE_SESSION_DIR)) {
    return null;
  }

  // Session ids are unique across projects, so scan each project-id directory
  // for ses_<id>.json. Caches the first hit.
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(OPENCODE_SESSION_DIR, { withFileTypes: true });
  } catch {
    return null;
  }

  const targetFile = `${sessionId}.json`;
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(OPENCODE_SESSION_DIR, entry.name, targetFile);
    if (fs.existsSync(candidate)) {
      opencodeSessionFileById.set(sessionId, candidate);
      return candidate;
    }
  }

  return null;
}

/**
 * Locate a Grok session directory for (cwd, sessionId).
 * Grok keys projects by encodeURIComponent(absolute cwd) under ~/.grok/sessions/.
 */
function findGrokSessionDir(cwd: string, sessionId: string): string | null {
  if (!sessionId) return null;

  const candidates = new Set<string>();
  try {
    candidates.add(path.resolve(cwd));
  } catch {
    // ignore
  }
  candidates.add(cwd.replace(/\/+$/, ''));
  candidates.add(cwd);

  for (const c of candidates) {
    if (!c) continue;
    const dir = path.join(GROK_SESSIONS_DIR, encodeURIComponent(c), sessionId);
    const chatPath = path.join(dir, 'chat_history.jsonl');
    if (fs.existsSync(chatPath)) {
      return dir;
    }
  }

  // Fallback: scan all project keys for this session id (slower, rare)
  if (!fs.existsSync(GROK_SESSIONS_DIR)) return null;
  try {
    for (const entry of fs.readdirSync(GROK_SESSIONS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(GROK_SESSIONS_DIR, entry.name, sessionId);
      if (fs.existsSync(path.join(dir, 'chat_history.jsonl'))) {
        return dir;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Encode a cwd to pi's project directory name:
 * /home/user/project → --home-user-project-- (slashes become dashes, wrapped in --).
 */
function encodePiProjectDir(cwd: string): string {
  const normalized = cwd.replace(/\/+$/, '');
  return `-${normalized.replace(/\//g, '-')}--`;
}

/**
 * Locate a pi session file for (cwd, sessionId).
 * Files are named <timestamp>_<sessionId>.jsonl inside the project dir.
 */
function findPiSessionFile(cwd: string, sessionId: string): string | null {
  if (!sessionId) return null;

  const cached = piSessionFileById.get(sessionId);
  if (cached && fs.existsSync(cached)) {
    return cached;
  }

  const suffix = `_${sessionId}.jsonl`;
  const scanDir = (dir: string): string | null => {
    try {
      for (const file of fs.readdirSync(dir)) {
        if (file.endsWith(suffix)) {
          const full = path.join(dir, file);
          piSessionFileById.set(sessionId, full);
          return full;
        }
      }
    } catch {
      // ignore unreadable dirs
    }
    return null;
  };

  const projectDir = path.join(PI_SESSIONS_DIR, encodePiProjectDir(cwd));
  const direct = scanDir(projectDir);
  if (direct) return direct;

  // Fallback: scan all project dirs for this session id (slower, rare)
  if (!fs.existsSync(PI_SESSIONS_DIR)) return null;
  try {
    for (const entry of fs.readdirSync(PI_SESSIONS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const found = scanDir(path.join(PI_SESSIONS_DIR, entry.name));
      if (found) return found;
    }
  } catch {
    // ignore
  }
  return null;
}

export function resolveSessionFile(cwd: string, sessionId: string): ResolvedSessionFile | null {
  const claudeFile = path.join(getProjectDir(cwd), `${sessionId}.jsonl`);
  if (fs.existsSync(claudeFile)) {
    return { provider: 'claude', filePath: claudeFile };
  }

  const codexFile = findCodexSessionFile(sessionId);
  if (codexFile && fs.existsSync(codexFile)) {
    return { provider: 'codex', filePath: codexFile };
  }

  const opencodeDbRow = findOpencodeDbSession(sessionId);
  if (opencodeDbRow) {
    return {
      provider: 'opencode',
      filePath: OPENCODE_DB_PATH,
      opencodeDbSessionId: opencodeDbRow.id,
    };
  }

  const opencodeFile = findOpencodeSessionFile(sessionId);
  if (opencodeFile && fs.existsSync(opencodeFile)) {
    return { provider: 'opencode', filePath: opencodeFile };
  }

  const grokDir = findGrokSessionDir(cwd, sessionId);
  if (grokDir) {
    return {
      provider: 'grok',
      filePath: path.join(grokDir, 'chat_history.jsonl'),
      grokSessionDir: grokDir,
    };
  }

  const piFile = findPiSessionFile(cwd, sessionId);
  if (piFile) {
    return { provider: 'pi', filePath: piFile };
  }

  return null;
}

/**
 * Which provider owns the session (cwd, sessionId), or null when no session
 * file exists. Used by restore flows so a grok/codex session is never
 * restored onto a Claude agent.
 */
export function detectSessionProvider(cwd: string, sessionId: string): SessionProvider | null {
  return resolveSessionFile(cwd, sessionId)?.provider ?? null;
}
