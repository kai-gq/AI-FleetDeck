/**
 * 运行时可用性路由层测试 — GET /api/runtimes
 *
 * 照 voice-companion-routes.test.ts 的模式:服务模块整体替换,用真 express +
 * 真 HTTP 请求验证 200 契约,以及「检测失败也必须 200 + fail-open」的兜底
 * (前端口径依赖它:任何失败都不允许演变成「藏起运行时」)。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RuntimeAvailability } from '../../shared/runtime-availability.js';

vi.mock('../services/runtime-availability-service.js', () => ({
  getRuntimeAvailability: vi.fn(),
}));

import * as service from '../services/runtime-availability-service.js';
import runtimesRoutes from './runtimes.js';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use('/api/runtimes', runtimesRoutes);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.resetAllMocks();
});

const payload: RuntimeAvailability = {
  ok: true,
  generatedAt: 1,
  platform: 'win32',
  degraded: false,
  providers: [
    {
      provider: 'claude',
      available: true,
      executable: 'C:\\bin\\claude.cmd',
      source: 'path',
      models: ['claude-opus-5-5[1m]'],
      defaultModel: 'claude-opus-5-5[1m]',
    },
    {
      provider: 'grok',
      available: false,
      executable: 'grok',
      source: 'none',
      models: ['grok-4.6', 'grok-4.5'],
      defaultModel: 'grok-4.6',
    },
  ],
  notes: [],
};

async function get(qs = ''): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/runtimes${qs}`);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('GET /api/runtimes', () => {
  it('returns the service payload', async () => {
    vi.mocked(service.getRuntimeAvailability).mockReturnValue(payload);
    const { status, json } = await get();
    expect(status).toBe(200);
    expect(json).toEqual(payload);
    expect(service.getRuntimeAvailability).toHaveBeenCalledWith({ refresh: false });
  });

  it('passes ?refresh=1 through as refresh:true', async () => {
    vi.mocked(service.getRuntimeAvailability).mockReturnValue(payload);
    await get('?refresh=1');
    expect(service.getRuntimeAvailability).toHaveBeenCalledWith({ refresh: true });
  });

  it('stays 200 and fail-open when the service throws', async () => {
    vi.mocked(service.getRuntimeAvailability).mockImplementation(() => {
      throw new Error('boom');
    });
    const { status, json } = await get();
    expect(status).toBe(200);
    expect(json.ok).toBe(false);
    expect(json.degraded).toBe(true);
    expect(json.providers).toEqual([]);
    expect((json.notes as string[])[0]).toContain('detection failed: boom');
  });
});
