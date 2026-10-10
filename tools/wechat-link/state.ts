/**
 * S0 工具本地状态：tools/wechat-link/.state.json（gitignored）。
 * 保存 bot_token / 游标 / baseurl / 最近一条入站消息 —— token 是凭据，绝不入库。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BASE } from './ilink';

const STATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '.state.json');

export interface LastInbound {
  userId: string;
  contextToken?: string;
  text?: string;
  at: number;
}

export interface LinkState {
  botToken?: string;
  cursor?: string;
  baseUrl?: string;
  botUserId?: string;
  loginAt?: number;
  lastInbound?: LastInbound;
}

export function loadState(): LinkState {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as LinkState;
  } catch {
    console.error(`⚠ .state.json 解析失败（忽略旧状态）：${STATE_PATH}`);
    return {};
  }
}

export function saveState(patch: Partial<LinkState>): LinkState {
  const next = { ...loadState(), ...patch };
  writeFileSync(STATE_PATH, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** 需要登录态的命令统一入口。 */
export function requireLogin(): LinkState & { botToken: string; baseUrl: string } {
  const state = loadState();
  if (!state.botToken) {
    console.error('未登录：先跑 npx tsx tools/wechat-link/login.ts 完成扫码。');
    process.exit(1);
  }
  return { ...state, botToken: state.botToken, baseUrl: state.baseUrl ?? DEFAULT_BASE };
}
