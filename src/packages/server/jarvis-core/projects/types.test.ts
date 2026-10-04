/**
 * jarvis-core/projects · 开关与常量（任务 14·⑪）
 *
 * 开关口径与 isMorningReportEnabled / isSenseEnabled 同型：环境变量缺省开，
 * '0'/'off'/'false'（忽略大小写与空白）关；配置入参优先于环境变量。
 */

import { describe, expect, it } from 'vitest';

import {
  isProjectRoutingEnabled,
  PROJECT_CARD_DECAY_DAYS,
  PROJECT_ROUTING_ENV_KEY,
  RECENT_DELEGATION_WINDOW_MS,
  resolveProjectRoutingEnabled,
} from './types.js';

describe('⑪ 项目路由开关（TC_JARVIS_PROJECT_ROUTING）', () => {
  it('环境变量缺省/空白 → 开', () => {
    expect(isProjectRoutingEnabled({})).toBe(true);
    expect(isProjectRoutingEnabled({ [PROJECT_ROUTING_ENV_KEY]: '' })).toBe(true);
    expect(isProjectRoutingEnabled({ [PROJECT_ROUTING_ENV_KEY]: '   ' })).toBe(true);
    expect(isProjectRoutingEnabled({ [PROJECT_ROUTING_ENV_KEY]: '1' })).toBe(true);
    expect(isProjectRoutingEnabled({ [PROJECT_ROUTING_ENV_KEY]: 'on' })).toBe(true);
  });

  it("'0' / 'off' / 'false'（忽略大小写与空白）→ 关", () => {
    for (const raw of ['0', 'off', 'false', ' OFF ', 'False', ' 0 ']) {
      expect(isProjectRoutingEnabled({ [PROJECT_ROUTING_ENV_KEY]: raw })).toBe(false);
    }
  });

  it('配置入参优先于环境变量（测试/接线用）', () => {
    expect(resolveProjectRoutingEnabled(false, { [PROJECT_ROUTING_ENV_KEY]: '1' })).toBe(false);
    expect(resolveProjectRoutingEnabled(true, { [PROJECT_ROUTING_ENV_KEY]: 'off' })).toBe(true);
    expect(resolveProjectRoutingEnabled(undefined, { [PROJECT_ROUTING_ENV_KEY]: 'off' })).toBe(false);
    expect(resolveProjectRoutingEnabled(undefined, {})).toBe(true);
  });

  it('常量钉值（初始值非实测；标定回写时同步改这里）', () => {
    expect(PROJECT_CARD_DECAY_DAYS).toBe(30);
    expect(RECENT_DELEGATION_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});
