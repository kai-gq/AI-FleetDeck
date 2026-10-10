import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../../data/index.js';
import {
  WECHAT_BOT_TOKEN_SECRET,
  getConfigValues,
  loadConfig,
  resetConfigCacheForTests,
  setConfigValues,
  updateConfig,
} from './wechat-config.js';
import { WECHAT_BOT_BASE } from './ilink-client.js';

const CONFIG_PATH = path.join(getDataDir(), 'wechat-config.json');

function cleanupConfig(): void {
  fs.rmSync(CONFIG_PATH, { force: true });
  resetConfigCacheForTests();
}

function makeSecrets(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: (key: string) => store.get(key),
    set: (key: string, value: string) => {
      if (value) store.set(key, value);
      else store.delete(key);
    },
  };
}

describe('wechat-config', () => {
  beforeEach(() => {
    cleanupConfig();
  });

  it('falls back to defaults when the file is missing or corrupted', () => {
    const defaults = loadConfig();
    expect(defaults.enabled).toBe(false);
    expect(defaults.baseUrl).toBe(WECHAT_BOT_BASE);
    expect(defaults.sendRateLimitPerMinute).toBe(20);

    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, '{not json', 'utf-8');
    resetConfigCacheForTests();
    const fromCorrupt = loadConfig();
    expect(fromCorrupt.enabled).toBe(false);
    expect(fromCorrupt.baseUrl).toBe(WECHAT_BOT_BASE);
  });

  it('persists updates to disk and survives a cache reset', () => {
    updateConfig({ enabled: true, botUserId: 'bot@im.bot', cursor: 'CUR-1', aliases: { 'wxid_a': '张三' } });
    const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    expect(onDisk.enabled).toBe(true);
    expect(onDisk.cursor).toBe('CUR-1');
    expect(onDisk.aliases).toEqual({ 'wxid_a': '张三' });

    resetConfigCacheForTests();
    const reloaded = loadConfig();
    expect(reloaded.enabled).toBe(true);
    expect(reloaded.botUserId).toBe('bot@im.bot');
  });

  it('getConfigValues never exposes the bot token', () => {
    const secrets = makeSecrets({ [WECHAT_BOT_TOKEN_SECRET]: 'SUPER-SECRET' });
    updateConfig({ enabled: true, botUserId: 'bot@im.bot' });
    const values = getConfigValues(secrets);
    expect(JSON.stringify(values)).not.toContain('SUPER-SECRET');
    expect(values).not.toHaveProperty('botToken');
    expect(values).not.toHaveProperty('wechatBotToken');
    expect(values.enabled).toBe(true);
    expect(values.sendRateLimitPerMinute).toBe(20);
  });

  it('setConfigValues applies enabled / rate / aliases and ignores unknown token fields', async () => {
    const secrets = makeSecrets();
    await setConfigValues(
      {
        enabled: true,
        sendRateLimitPerMinute: 0, // clamped to >= 1
        aliases: { 'wxid_a': ' 张三 ', 'wxid_b': 42 as unknown as string },
        botToken: 'SHOULD-BE-IGNORED',
      },
      secrets,
    );
    const config = loadConfig();
    expect(config.enabled).toBe(true);
    expect(config.sendRateLimitPerMinute).toBe(1);
    expect(config.aliases).toEqual({ 'wxid_a': '张三' });
    expect(secrets.store.size).toBe(0);
    expect(secrets.store.has(WECHAT_BOT_TOKEN_SECRET)).toBe(false);
  });
});
