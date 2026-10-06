/**
 * W13 前置 · 用户活动上报路由测试
 *
 * 照 delegation-board.test.ts / voice-companion-routes.test.ts 的模式：真 express +
 * 真 HTTP；但路由与真服务（单例）端到端联调（不做服务桩），每例先重定向
 * XDG_DATA_HOME 到独立临时目录 + resetUserActivityForTests()，绝不碰真实用户数据目录。
 *
 * 契约：三个客户端 kind 接受；voice-turn 是服务端内部专用（客户端上报一律
 * 400 且零副作用）；不接受客户端时间戳（服务端取时）；status 返回三字段快照。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

import userActivityRouter from './user-activity.js';
import { noteUserActivity, resetUserActivityForTests } from '../services/user-activity-service.js';

let server: http.Server;
let baseUrl: string;
let dataDir: string;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

async function report(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/user-activity/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function getStatus(): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/user-activity/status`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/user-activity', userActivityRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
});

beforeEach(() => {
  // 单例懒创建：每例换一个临时 XDG 目录 + 丢弃单例 → 账本干净且不落真实路径
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-activity-route-'));
  process.env.XDG_DATA_HOME = dataDir;
  resetUserActivityForTests();
});

afterEach(() => {
  resetUserActivityForTests();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('POST /report', () => {
  it('三个客户端 kind 均接受：200 {success:true} 且账本更新', async () => {
    for (const kind of ['voice-page', 'focus', 'input'] as const) {
      const res = await report({ kind });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });

      const snap = await getStatus();
      expect(snap.status).toBe(200);
      expect(snap.body.activity.lastActivityKind).toBe(kind);
      expect(typeof snap.body.activity.lastActivityAt).toBe('number');
      expect(snap.body.activity.lastSpeechAt).toBeNull(); // 客户端活动不冒充「说过话」
    }
  });

  it('kind 白名单：缺失/非法/非字符串/voice-turn 一律 400 INVALID_KIND 且零副作用', async () => {
    await report({ kind: 'focus' }); // 先制造一条账
    const before = (await getStatus()).body.activity;

    const badKinds = [undefined, null, '', 'evil', 'VOICE-PAGE', 42, {}, ['focus'], 'voice-turn'];
    for (const kind of badKinds) {
      const res = await report({ kind });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid kind', code: 'INVALID_KIND' });
    }

    // voice-turn 被拒后账本未被改动（尤其 lastSpeechAt 仍为 null——不可伪造「刚说过话」）
    expect((await getStatus()).body.activity).toEqual(before);
    expect(before.lastSpeechAt).toBeNull();
  });

  it('空 body / 数组 body 同样 400（kind 缺失即拒）', async () => {
    for (const body of [{}, [], [{ kind: 'focus' }]]) {
      const res = await report(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_KIND');
    }
  });

  it('不接受客户端时间戳：body 里的 at/timestamp 一律忽略，服务端取时', async () => {
    const before = Date.now();
    const res = await report({ kind: 'input', at: 1, timestamp: 1, lastActivityAt: 1 });
    const after = Date.now();

    expect(res.status).toBe(200);
    const { activity } = (await getStatus()).body;
    expect(activity.lastActivityAt).toBeGreaterThanOrEqual(before);
    expect(activity.lastActivityAt).toBeLessThanOrEqual(after);
  });
});

describe('GET /status', () => {
  it('空账 → 200 {success:true, activity: 三字段全 null}', async () => {
    const res = await getStatus();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      activity: { lastActivityAt: null, lastSpeechAt: null, lastActivityKind: null },
    });
  });

  it('voice-turn 仅服务端内部可登记：直接调 noteUserActivity → status 可见', async () => {
    noteUserActivity('voice-turn', 1_716_000_000_000);
    const res = await getStatus();
    expect(res.body.activity).toEqual({
      lastActivityAt: 1_716_000_000_000,
      lastSpeechAt: 1_716_000_000_000,
      lastActivityKind: 'voice-turn',
    });
  });

  it('落盘位置在重定向后的 XDG 目录（不碰真实用户数据目录）', async () => {
    await report({ kind: 'input' });
    const file = path.join(dataDir, 'tide-commander', 'user-activity', 'activity.json');
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).lastActivityKind).toBe('input');
  });
});
