/**
 * WeChat (ClawBot) Integration Configuration
 * Persists non-secret config to ~/.local/share/tide-commander/wechat-config.json.
 *
 * The bot token lives in the encrypted secrets store as `wechat.botToken`
 * (IntegrationContext.secrets) — it is intentionally absent from both the
 * config JSON and the ConfigField schema, which sidesteps the '********'
 * masking dance entirely.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ConfigField } from '../../../shared/integration-types.js';
import { getDataDir } from '../../data/index.js';
import { WECHAT_BOT_BASE } from './ilink-client.js';

// ─── Config Type ───

export interface WeChatConfig {
  enabled: boolean;
  /** Confirmed bot base URL from the login response (Tencent may switch domains). */
  baseUrl: string;
  /** Bot's own id (xxx@im.bot) as reported by the login/getupdates flow. */
  botUserId?: string;
  /** Persistent getupdates cursor — written BEFORE dispatching messages. */
  cursor?: string;
  connectedAt?: number;
  /** Epoch ms of the last successful poll round (diagnostics). */
  lastPollAt?: number;
  /** Epoch ms of the last inbound user message (diagnostics). */
  lastMessageAt?: number;
  lastError?: string;
  /** Credentials exist but iLink rejected them — user must rescan the QR. */
  needsReauth?: boolean;
  /** Outbound rate cap (rolling 60s window). Default 20. */
  sendRateLimitPerMinute?: number;
  /** Optional userId → display-name overrides (protocol may not carry nicknames). */
  aliases?: Record<string, string>;
  /**
   * 入站私聊交给「秘书大脑」（语音伙伴）处理，答复原样回发微信。
   * 与触发器互相独立——同时启用且消息命中触发器会双回复，配置上应二选一。
   */
  companionBridge?: boolean;
  updatedAt: number;
  version: '1';
}

const DEFAULT_CONFIG: WeChatConfig = {
  enabled: false,
  baseUrl: WECHAT_BOT_BASE,
  sendRateLimitPerMinute: 20,
  updatedAt: 0,
  version: '1',
};

// ─── Secret Keys ───

export const WECHAT_BOT_TOKEN_SECRET = 'wechat.botToken';

// ─── Config File Persistence ───

function getConfigPath(): string {
  return path.join(getDataDir(), 'wechat-config.json');
}

let cachedConfig: WeChatConfig | null = null;

export function loadConfig(): WeChatConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = getConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const result: WeChatConfig = { ...DEFAULT_CONFIG, ...data, version: '1' };
      cachedConfig = result;
      return result;
    }
  } catch {
    // Corrupted config, use defaults
  }

  const defaults: WeChatConfig = { ...DEFAULT_CONFIG };
  cachedConfig = defaults;
  return defaults;
}

export function saveConfig(config: WeChatConfig): void {
  const next: WeChatConfig = { ...config, updatedAt: Date.now(), version: '1' };
  cachedConfig = next;
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf-8');
}

export function updateConfig(updates: Partial<WeChatConfig>): WeChatConfig {
  const config = loadConfig();
  const updated: WeChatConfig = { ...config, ...updates };
  saveConfig(updated);
  return updated;
}

/** Test-only: drop the module cache so the next load re-reads from disk. */
export function resetConfigCacheForTests(): void {
  cachedConfig = null;
}

// ─── Config Schema (for the generic settings UI fallback) ───

export const wechatConfigSchema: ConfigField[] = [
  {
    key: 'enabled',
    label: 'Enable WeChat Integration',
    type: 'boolean',
    description: 'Enable or disable the WeChat (ClawBot) connection',
    defaultValue: false,
    group: 'General',
  },
  {
    key: 'sendRateLimitPerMinute',
    label: 'Outbound sends per minute',
    type: 'number',
    description: 'Rolling-window cap on outbound WeChat messages (default 20).',
    defaultValue: 20,
    group: 'General',
  },
  {
    key: 'companionBridge',
    label: 'Route inbound to the voice companion (秘书)',
    type: 'boolean',
    description: 'Hand private messages to the 秘书 brain (voice companion) and send its reply back to WeChat. Independent of triggers — enable only one of the two.',
    defaultValue: false,
    group: 'General',
  },
];

// ─── Config Value Access (for IntegrationPlugin.getConfig/setConfig) ───

interface SecretsAccessor {
  get: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
}

export function getConfigValues(secrets: { get: (key: string) => string | undefined }): Record<string, unknown> {
  const config = loadConfig();
  void secrets; // token is intentionally never echoed, not even masked
  return {
    enabled: config.enabled,
    baseUrl: config.baseUrl,
    botUserId: config.botUserId || '',
    connectedAt: config.connectedAt ?? 0,
    needsReauth: config.needsReauth === true,
    lastError: config.lastError || '',
    sendRateLimitPerMinute: config.sendRateLimitPerMinute ?? 20,
    aliases: config.aliases ?? {},
    companionBridge: config.companionBridge === true,
  };
}

export async function setConfigValues(
  values: Record<string, unknown>,
  secrets: SecretsAccessor,
): Promise<void> {
  void secrets; // no secret fields in the schema; token is managed by the login flow
  const updates: Partial<WeChatConfig> = {};
  if (typeof values.enabled === 'boolean') updates.enabled = values.enabled;
  if (typeof values.sendRateLimitPerMinute === 'number' && Number.isFinite(values.sendRateLimitPerMinute)) {
    updates.sendRateLimitPerMinute = Math.max(1, Math.floor(values.sendRateLimitPerMinute));
  }
  if (typeof values.companionBridge === 'boolean') updates.companionBridge = values.companionBridge;
  if (values.aliases && typeof values.aliases === 'object' && !Array.isArray(values.aliases)) {
    const aliases: Record<string, string> = {};
    for (const [key, value] of Object.entries(values.aliases as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) aliases[key] = value.trim();
    }
    updates.aliases = aliases;
  }
  updateConfig(updates);
}
