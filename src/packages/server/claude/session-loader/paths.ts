/**
 * 路径与日志基座:log 与 Claude/Codex/OpenCode/Grok/Pi 的会话目录常量。
 *
 * 自 session-loader.ts 按主题拆出(2026-10-11 W3);块级逐行原样搬移。
 */

import * as path from 'path';
import * as os from 'os';
import { createLogger } from '../../utils/logger.js';

export const log = createLogger('Session');

// Claude's project directory
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

const CODEX_DIR = path.join(os.homedir(), '.codex');

export const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');

// OpenCode storage. Current versions keep session metadata + messages + parts
// in a SQLite database (opencode.db). Older versions used a filesystem layout
// (session/<project-id>/ses_<id>.json, message/ses_<id>/..., part/msg_<id>/...)
// which we still read as a fallback for legacy sessions.
const OPENCODE_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');

export const OPENCODE_DB_PATH = path.join(OPENCODE_DIR, 'opencode.db');

const OPENCODE_STORAGE_DIR = path.join(OPENCODE_DIR, 'storage');

export const OPENCODE_SESSION_DIR = path.join(OPENCODE_STORAGE_DIR, 'session');

export const OPENCODE_MESSAGE_DIR = path.join(OPENCODE_STORAGE_DIR, 'message');

export const OPENCODE_PART_DIR = path.join(OPENCODE_STORAGE_DIR, 'part');

const GROK_DIR = path.join(os.homedir(), '.grok');

export const GROK_SESSIONS_DIR = path.join(GROK_DIR, 'sessions');

// Pi coding agent session storage: ~/.pi/agent/sessions/--<cwd with / → ->--/<timestamp>_<uuid>.jsonl
const PI_DIR = path.join(os.homedir(), '.pi');

export const PI_SESSIONS_DIR = path.join(PI_DIR, 'agent', 'sessions');
