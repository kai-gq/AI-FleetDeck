/**
 * WeChat (ClawBot) Settings API Client
 * Wraps /api/wechat/* endpoints for the server-side iLink (ClawBot) integration.
 * The bot token never leaves the server — status/config payloads are token-free.
 */

import { apiUrl, authFetch } from '../utils/storage';

export type WeChatConnectionState = 'disabled' | 'disconnected' | 'qr_pending' | 'connected' | 'needs_reauth';

export interface WeChatStatus {
  state: WeChatConnectionState;
  hasToken: boolean;
  enabled: boolean;
  botUserId?: string;
  connectedAt?: number;
  lastPollAt?: number;
  lastMessageAt?: number;
  lastError?: string;
  needsReauth: boolean;
  recentInboundCount?: number;
}

export interface WeChatConfigValues {
  enabled: boolean;
  baseUrl: string;
  botUserId: string;
  connectedAt: number;
  needsReauth: boolean;
  lastError: string;
  sendRateLimitPerMinute: number;
  aliases: Record<string, string>;
}

export interface WeChatLoginSession {
  status: string;
  error: string | null;
  confirmed: boolean;
  imgContent: string;
  startedAt: number;
  deadlineAt: number;
  remainingMs: number;
}

export interface WeChatLoginStatus {
  state: WeChatConnectionState;
  login: WeChatLoginSession | null;
}

export interface WeChatRecentInboundEntry {
  userId: string;
  displayName: string;
  preview: string;
  at: number;
  hasContextToken: boolean;
}

async function parseError(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json();
    if (data && typeof data.error === 'string') return data.error;
  } catch {
    /* ignore parse errors */
  }
  return `${fallback}: ${response.statusText}`;
}

async function requestJson<T>(path: string, init?: RequestInit, fallback = 'Request failed'): Promise<T> {
  const response = await authFetch(apiUrl(path), init);
  if (!response.ok) {
    throw new Error(await parseError(response, fallback));
  }
  return response.json();
}

export function fetchWeChatStatus(): Promise<WeChatStatus> {
  return requestJson<WeChatStatus>('/api/wechat/status', undefined, '获取微信状态失败');
}

export function fetchWeChatConfig(): Promise<WeChatConfigValues> {
  return requestJson<WeChatConfigValues>('/api/wechat/config', undefined, '获取微信配置失败');
}

export function updateWeChatConfig(partial: Partial<WeChatConfigValues>): Promise<WeChatConfigValues> {
  return requestJson<WeChatConfigValues>(
    '/api/wechat/config',
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    },
    '保存微信配置失败',
  );
}

export async function startWeChatLogin(): Promise<WeChatLoginSession> {
  const data = await requestJson<{ login: WeChatLoginSession }>(
    '/api/wechat/login/start',
    { method: 'POST' },
    '启动扫码登录失败',
  );
  return data.login;
}

export function fetchWeChatLoginStatus(): Promise<WeChatLoginStatus> {
  return requestJson<WeChatLoginStatus>('/api/wechat/login/status', undefined, '获取扫码状态失败');
}

export async function cancelWeChatLogin(): Promise<void> {
  await requestJson<{ success: boolean }>('/api/wechat/login/cancel', { method: 'POST' }, '取消扫码登录失败');
}

export async function logoutWeChat(): Promise<void> {
  await requestJson<{ success: boolean }>('/api/wechat/logout', { method: 'POST' }, '断开微信连接失败');
}

export async function fetchWeChatRecentInbound(): Promise<WeChatRecentInboundEntry[]> {
  const data = await requestJson<{ items: WeChatRecentInboundEntry[] }>(
    '/api/wechat/recent-inbound',
    undefined,
    '获取最近来消息失败',
  );
  return Array.isArray(data.items) ? data.items : [];
}

export async function sendWeChatMessage(to: string, text: string): Promise<void> {
  await requestJson<{ success: boolean }>(
    '/api/wechat/send-message',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, text }),
    },
    '发送微信消息失败',
  );
}
