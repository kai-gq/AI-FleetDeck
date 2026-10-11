/**
 * 会话头读取与全局列表:头部缓存、extractClaudeMessageText、readSessionHeader、listAllSessions。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import { PROJECTS_DIR, CODEX_SESSIONS_DIR, GROK_SESSIONS_DIR, PI_SESSIONS_DIR } from './paths.js';
import { isObject, truncate } from './message-utils.js';
import { type GlobalSessionInfo, FIRST_PROMPT_MAX_LEN } from './search-types.js';
import { extractCodexMessageText, stripCodexInjectedUserMessage } from './parse-codex.js';
import { extractGrokUserDisplayText } from './parse-grok.js';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

export function extractClaudeMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const m = message as { content?: unknown };
  const content = m.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object' && 'type' in block && (block as { type: string }).type === 'text') {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

/**
 * Header cache for listAllSessions/searchAllSessions. A COMPLETE header
 * (cwd + first prompt) lives in the first lines of the session file, which
 * never change once written — reuse it forever. Incomplete headers (fresh
 * session whose prompt hasn't flushed yet) are re-read only when the file has
 * grown since the last look. Without this, every Session Finder search
 * re-opened ~1000 files just to recover data that was identical every time.
 */
interface SessionHeaderCacheEntry {
  cwd: string;
  firstPrompt: string;
  sizeAtRead: number;
}

const sessionHeaderCache = new Map<string, SessionHeaderCacheEntry>();

const SESSION_HEADER_CACHE_MAX = 8000;

async function readSessionHeaderCached(filePath: string, sizeBytes: number): Promise<{ cwd: string; firstPrompt: string }> {
  const cached = sessionHeaderCache.get(filePath);
  if (cached && ((cached.cwd && cached.firstPrompt) || cached.sizeAtRead === sizeBytes)) {
    return cached;
  }
  const header = await readSessionHeader(filePath);
  if (sessionHeaderCache.size >= SESSION_HEADER_CACHE_MAX) sessionHeaderCache.clear();
  sessionHeaderCache.set(filePath, { ...header, sizeAtRead: sizeBytes });
  return header;
}

/**
 * Read the first up-to-`maxLines` JSONL records of a session file. Used to
 * cheaply recover `cwd` and the first user prompt without parsing the whole
 * conversation. Falls back to a single readFileSync slice for very small files.
 */
async function readSessionHeader(filePath: string, maxLines = 20): Promise<{ cwd: string; firstPrompt: string }> {
  let cwd = '';
  let firstPrompt = '';
  try {
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineCount = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      lineCount += 1;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd as string;
        // queue-operation enqueue rows carry the user's prompt as `content`
        if (!firstPrompt && obj.type === 'queue-operation' && (obj as { operation?: string }).operation === 'enqueue') {
          const content = (obj as { content?: unknown }).content;
          if (typeof content === 'string') firstPrompt = content;
        }
        if (!firstPrompt && obj.type === 'user') {
          const text = extractClaudeMessageText(obj.message);
          if (text) firstPrompt = text;
        }
        // Grok chat_history rows: content at top level (no `message`), real
        // prompt possibly wrapped in <user_query> (unwrapped by the helper).
        // Scaffolding-only rows (<user_info> / system reminders) are skipped.
        if (
          !firstPrompt && obj.type === 'user' && obj.message === undefined && obj.content !== undefined
          && (obj as { synthetic_reason?: unknown }).synthetic_reason !== 'system_reminder'
        ) {
          const text = extractGrokUserDisplayText(obj.content);
          if (
            text
            && !text.startsWith('<user_info>')
            && !text.startsWith('<system-reminder>')
            && !(text.includes('<system-reminder>') && !text.includes('<user_query>'))
          ) {
            firstPrompt = text;
          }
        }
        // Codex session_meta (new format) carries the cwd in its payload.
        if (!cwd && obj.type === 'session_meta' && isObject(obj.payload) && typeof obj.payload.cwd === 'string') {
          cwd = obj.payload.cwd;
        }
        // Codex message rows: top level (old format) or response_item-wrapped
        // (new format). The injected wrappers (<environment_context>, AGENTS.md)
        // strip to '' and are skipped — but the environment_context text is the
        // ONLY cwd source in old-format files, so mine it first.
        const codexRec = obj.type === 'response_item' && isObject(obj.payload) ? obj.payload : obj;
        if (codexRec.type === 'message' && (codexRec as { role?: unknown }).role === 'user') {
          const raw = extractCodexMessageText((codexRec as { content?: unknown }).content);
          if (!cwd) {
            const envMatch = /Current working directory:\s*([^\n<]+)/.exec(raw);
            if (envMatch) cwd = envMatch[1].trim();
          }
          if (!firstPrompt) {
            const text = stripCodexInjectedUserMessage(raw);
            if (text) firstPrompt = text;
          }
        }
        if (!firstPrompt && obj.type === 'event_msg' && isObject(obj.payload)
          && obj.payload.type === 'user_message' && typeof obj.payload.message === 'string') {
          const text = stripCodexInjectedUserMessage(obj.payload.message);
          if (text) firstPrompt = text;
        }
        // Pi rows: {type:'message', message:{role, content:[{type:'text'}]}}.
        if (!firstPrompt && obj.type === 'message' && isObject(obj.message) && obj.message.role === 'user') {
          const text = extractClaudeMessageText(obj.message);
          if (text) firstPrompt = text;
        }
        if (cwd && firstPrompt) break;
      } catch {
        // ignore malformed lines
      }
      if (lineCount >= maxLines) break;
    }
    rl.close();
    stream.destroy();
  } catch {
    // unreadable file — return empty defaults
  }
  return { cwd, firstPrompt: truncate(firstPrompt, FIRST_PROMPT_MAX_LEN) };
}

/**
 * List every Claude session across every project directory.
 *
 * Cheap: only stats each .jsonl and reads the first few lines for cwd/firstPrompt.
 * Skips message-count computation by default to keep the operation fast even
 * across hundreds of sessions.
 */
export async function listAllSessions(options?: {
  limit?: number;             // cap how many sessions to return (newest first)
  includeMessageCount?: boolean; // when true, count user/assistant turns (slow)
}): Promise<GlobalSessionInfo[]> {
  const all: GlobalSessionInfo[] = [];

  // Claude: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
  if (fs.existsSync(PROJECTS_DIR)) {
    for (const projectDir of fs.readdirSync(PROJECTS_DIR)) {
      const fullProjectPath = path.join(PROJECTS_DIR, projectDir);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(fullProjectPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const sessionId = entry.name.replace(/\.jsonl$/, '');
        const filePath = path.join(fullProjectPath, entry.name);
        let stats: fs.Stats;
        try {
          stats = fs.statSync(filePath);
        } catch {
          continue;
        }
        all.push({
          sessionId,
          projectPath: '',
          projectDir,
          lastModified: stats.mtime,
          messageCount: 0,
          firstPrompt: '',
          sizeBytes: stats.size,
          filePath,
          provider: 'claude',
        });
      }
    }
  }

  // Grok: ~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/chat_history.jsonl
  // Without this, conversations held by grok-provider agents are invisible to
  // the global session search (Spotlight / Session Finder).
  if (fs.existsSync(GROK_SESSIONS_DIR)) {
    let grokProjects: fs.Dirent[] = [];
    try {
      grokProjects = fs.readdirSync(GROK_SESSIONS_DIR, { withFileTypes: true });
    } catch { /* unreadable — skip grok corpus */ }
    for (const proj of grokProjects) {
      if (!proj.isDirectory()) continue;
      let cwd = proj.name;
      try {
        cwd = decodeURIComponent(proj.name);
      } catch { /* keep the raw dir name */ }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(GROK_SESSIONS_DIR, proj.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const filePath = path.join(GROK_SESSIONS_DIR, proj.name, entry.name, 'chat_history.jsonl');
        let stats: fs.Stats;
        try {
          stats = fs.statSync(filePath);
        } catch {
          continue;
        }
        all.push({
          sessionId: entry.name,
          projectPath: cwd,
          projectDir: proj.name,
          lastModified: stats.mtime,
          messageCount: 0,
          firstPrompt: '',
          sizeBytes: stats.size,
          filePath,
          provider: 'grok',
        });
      }
    }
  }

  // Codex: ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl
  // The session id is the uuid embedded in the filename; cwd comes from the
  // session_meta header line (new format) or the <environment_context> user
  // message (old format) during enrichment.
  if (fs.existsSync(CODEX_SESSIONS_DIR)) {
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
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const idMatch = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(entry.name);
        if (!idMatch) continue;
        let stats: fs.Stats;
        try {
          stats = fs.statSync(fullPath);
        } catch {
          continue;
        }
        all.push({
          sessionId: idMatch[1],
          projectPath: '',
          projectDir: path.relative(CODEX_SESSIONS_DIR, dir),
          lastModified: stats.mtime,
          messageCount: 0,
          firstPrompt: '',
          sizeBytes: stats.size,
          filePath: fullPath,
          provider: 'codex',
        });
      }
    }
  }

  // Pi: ~/.pi/agent/sessions/<encoded-cwd>/<ts>_<sessionId>.jsonl
  // The first line is {type:'session', cwd} — enrichment recovers the cwd.
  if (fs.existsSync(PI_SESSIONS_DIR)) {
    let piProjects: fs.Dirent[] = [];
    try {
      piProjects = fs.readdirSync(PI_SESSIONS_DIR, { withFileTypes: true });
    } catch { /* unreadable — skip pi corpus */ }
    for (const proj of piProjects) {
      if (!proj.isDirectory()) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(PI_SESSIONS_DIR, proj.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const idMatch = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(entry.name);
        if (!idMatch) continue;
        const filePath = path.join(PI_SESSIONS_DIR, proj.name, entry.name);
        let stats: fs.Stats;
        try {
          stats = fs.statSync(filePath);
        } catch {
          continue;
        }
        all.push({
          sessionId: idMatch[1],
          projectPath: '',
          projectDir: proj.name,
          lastModified: stats.mtime,
          messageCount: 0,
          firstPrompt: '',
          sizeBytes: stats.size,
          filePath,
          provider: 'pi',
        });
      }
    }
  }

  all.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

  const limit = options?.limit ?? all.length;
  const limited = all.slice(0, limit);

  // Enrich with cwd + firstPrompt (and optionally messageCount). Run concurrently
  // but cap concurrency so we don't open hundreds of file handles at once.
  const concurrency = 8;
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push((async () => {
      while (cursor < limited.length) {
        const idx = cursor++;
        const item = limited[idx];
        const filePath = item.filePath;
        const header = await readSessionHeaderCached(filePath, item.sizeBytes);
        // Grok files carry no cwd field — their projectPath comes from the
        // directory name and must not be erased by the empty header value.
        if (header.cwd) item.projectPath = header.cwd;
        item.firstPrompt = header.firstPrompt;
        if (options?.includeMessageCount) {
          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n');
            let count = 0;
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const obj = JSON.parse(line) as { type?: string };
                if (obj.type === 'user' || obj.type === 'assistant') count++;
              } catch { /* ignore */ }
            }
            item.messageCount = count;
          } catch { /* ignore */ }
        }
      }
    })());
  }
  await Promise.all(workers);

  return limited;
}
