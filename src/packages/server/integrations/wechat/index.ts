/**
 * WeChat (ClawBot) Integration Plugin
 * Exports wechatPlugin implementing IntegrationPlugin.
 *
 * Unique among integrations: there is no external bridge — TC itself runs the
 * iLink long-poll loop (wechat-connection.ts) inside the server process.
 * Registered in integration-registry.ts; routes/skills/trigger-handler are
 * wired automatically by the registry.
 */

import type {
  IntegrationPlugin,
  IntegrationContext,
  IntegrationStatus,
  ConfigField,
  TriggerHandler,
} from '../../../shared/integration-types.js';
import { createWeChatRoutes } from './wechat-routes.js';
import { wechatConfigSchema, getConfigValues, setConfigValues } from './wechat-config.js';
import {
  initWeChatConnection,
  syncWeChatConnection,
  stopWeChatConnection,
  describeWeChatConnection,
} from './wechat-connection.js';
import { wechatTriggerHandler } from './wechat-trigger-handler.js';
import { startWeChatCompanionBridge, stopWeChatCompanionBridge } from './wechat-companion-bridge.js';
import { wechatSkill } from './wechat-skill.js';

let integrationCtx: IntegrationContext | null = null;
let lastChecked = 0;

export const wechatPlugin: IntegrationPlugin = {
  id: 'wechat',
  name: '微信 (ClawBot)',
  description: '通过腾讯 ClawBot（iLink）接入个人微信：接收私聊消息、驱动触发器、由 agent 回复',
  routePrefix: '/wechat',

  async init(ctx: IntegrationContext): Promise<void> {
    integrationCtx = ctx;
    initWeChatConnection(ctx);
    syncWeChatConnection(ctx);
    startWeChatCompanionBridge();
    lastChecked = Date.now();
    const info = describeWeChatConnection();
    ctx.log.info(`WeChat integration ready (state=${info.state})`);
  },

  async shutdown(): Promise<void> {
    // Must return immediately: the core force-kills integrations after
    // 4500ms. stop() aborts the in-flight long poll synchronously.
    stopWeChatCompanionBridge();
    stopWeChatConnection();
    integrationCtx = null;
  },

  getRoutes(): unknown {
    if (!integrationCtx) {
      throw new Error('WeChat plugin not initialized');
    }
    return createWeChatRoutes(integrationCtx);
  },

  getSkills(): unknown[] {
    return [wechatSkill];
  },

  getTriggerHandler(): TriggerHandler | null {
    return wechatTriggerHandler;
  },

  getStatus(): IntegrationStatus {
    const info = describeWeChatConnection();
    lastChecked = Date.now();
    return {
      connected: info.state === 'connected',
      lastChecked,
      error: info.lastError,
      needsReauth: info.needsReauth,
    };
  },

  getConfigSchema(): ConfigField[] {
    return wechatConfigSchema;
  },

  getConfig(): Record<string, unknown> {
    return getConfigValues(integrationCtx ? integrationCtx.secrets : { get: () => undefined });
  },

  async setConfig(config: Record<string, unknown>): Promise<void> {
    if (!integrationCtx) throw new Error('WeChat plugin not initialized');
    await setConfigValues(config, integrationCtx.secrets);
    syncWeChatConnection(integrationCtx);
  },

  getCustomSettingsComponent(): string | null {
    return 'wechat-config';
  },
};
