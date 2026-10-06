/**
 * W13 前置 · user-activity-service 单测
 *
 * 覆盖：内存账（任意 kind 更新 lastActivityAt；voice-turn 同时更新 lastSpeechAt；
 * 其它 kind 不动 lastSpeechAt）、isActiveWithin 边界、落盘+重读恢复（原子写无
 * .tmp 残留）、写节流（间隔内多次 note 只写一次，flush 强制补写）、损坏/形状
 * 不符容错为归零（不抛）、默认路径口径与单例 reset。
 * 一律显式注入临时文件 / 重定向 XDG，绝不碰真实数据目录。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UserActivityStore,
  defaultUserActivityPath,
  getUserActivitySnapshot,
  getUserActivityStore,
  isUserActiveWithin,
  noteUserActivity,
  resetUserActivityForTests,
} from './user-activity-service.js';

let dir: string;

function tmpFile(): string {
  return path.join(dir, 'activity.json');
}

function readDisk(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-activity-'));
  resetUserActivityForTests();
});

afterEach(() => {
  resetUserActivityForTests();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('UserActivityStore 内存账', () => {
  it('任意 kind 更新 lastActivityAt/lastActivityKind；voice-turn 同时更新 lastSpeechAt', () => {
    const store = new UserActivityStore(tmpFile());
    expect(store.snapshot()).toEqual({ lastActivityAt: null, lastSpeechAt: null, lastActivityKind: null });

    store.note('input', 1_000);
    expect(store.snapshot()).toEqual({ lastActivityAt: 1_000, lastSpeechAt: null, lastActivityKind: 'input' });

    store.note('voice-page', 2_000);
    expect(store.snapshot()).toEqual({ lastActivityAt: 2_000, lastSpeechAt: null, lastActivityKind: 'voice-page' });

    store.note('focus', 3_000);
    expect(store.snapshot()).toEqual({ lastActivityAt: 3_000, lastSpeechAt: null, lastActivityKind: 'focus' });

    store.note('voice-turn', 4_000);
    expect(store.snapshot()).toEqual({ lastActivityAt: 4_000, lastSpeechAt: 4_000, lastActivityKind: 'voice-turn' });
  });

  it('其它 kind 不动 lastSpeechAt（说话时间独立于一般活动）', () => {
    const store = new UserActivityStore(tmpFile());
    store.note('voice-turn', 1_000);
    store.note('input', 9_999);
    expect(store.snapshot()).toEqual({ lastActivityAt: 9_999, lastSpeechAt: 1_000, lastActivityKind: 'input' });
  });

  it('at 缺省用注入时钟；snapshot 返回拷贝（外部改动不回写）', () => {
    let clock = 12_345;
    const store = new UserActivityStore(tmpFile(), { now: () => clock });
    store.note('focus');
    expect(store.snapshot().lastActivityAt).toBe(12_345);

    clock = 23_456;
    store.note('voice-turn');
    expect(store.snapshot()).toMatchObject({ lastActivityAt: 23_456, lastSpeechAt: 23_456 });

    const copy = store.snapshot();
    copy.lastActivityAt = 1;
    expect(store.snapshot().lastActivityAt).toBe(23_456);
  });
});

describe('UserActivityStore.isActiveWithin 边界', () => {
  it('无活动 → 恒 false；窗口内 / 恰边界 / 出窗三态', () => {
    const store = new UserActivityStore(tmpFile());
    expect(store.isActiveWithin(60_000, 100_000)).toBe(false);

    store.note('input', 100_000);
    expect(store.isActiveWithin(60_000, 130_000)).toBe(true); // 30s < 60s
    expect(store.isActiveWithin(30_000, 130_000)).toBe(true); // 恰好边界（含）算窗口内
    expect(store.isActiveWithin(29_999, 130_000)).toBe(false); // 1ms 出窗
    expect(store.isActiveWithin(60_000, 160_001)).toBe(false); // 60s + 1ms 出窗
  });

  it('缺省 now 用注入时钟', () => {
    const store = new UserActivityStore(tmpFile(), { now: () => 200_000 });
    store.note('focus', 100_000);
    expect(store.isActiveWithin(100_000)).toBe(true);
    expect(store.isActiveWithin(99_999)).toBe(false);
  });
});

describe('UserActivityStore 持久化', () => {
  it('落盘 + 重读恢复：新实例读回三字段；原子写无 .tmp 残留', () => {
    const filePath = path.join(dir, 'nested', 'activity.json'); // 父目录不存在 → 原子写自建
    const first = new UserActivityStore(filePath);
    first.note('voice-turn', 1_716_000_000_000);
    first.flush();

    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
    expect(readDisk(filePath)).toEqual({
      lastActivityAt: 1_716_000_000_000,
      lastSpeechAt: 1_716_000_000_000,
      lastActivityKind: 'voice-turn',
    });

    const second = new UserActivityStore(filePath);
    expect(second.snapshot()).toEqual({
      lastActivityAt: 1_716_000_000_000,
      lastSpeechAt: 1_716_000_000_000,
      lastActivityKind: 'voice-turn',
    });
  });

  it('写节流：间隔内多次 note 只写一次；flush 强制补写；过间隔后恢复写', () => {
    let clock = 0;
    const filePath = tmpFile();
    const store = new UserActivityStore(filePath, { minWriteIntervalMs: 10_000, now: () => clock });

    store.note('input', 1_000); // 首次 note 立即写
    expect(readDisk(filePath).lastActivityAt).toBe(1_000);

    clock = 1_000;
    store.note('input', 2_000); // 间隔内 → 跳写
    clock = 2_000;
    store.note('focus', 3_000); // 仍跳写
    expect(readDisk(filePath).lastActivityAt).toBe(1_000); // 磁盘仍是第一次的内容

    store.flush(); // 无视节流立即补写
    expect(readDisk(filePath)).toEqual({ lastActivityAt: 3_000, lastSpeechAt: null, lastActivityKind: 'focus' });

    clock = 12_000;
    store.note('input', 4_000); // 距上次落盘 (2000) 恰好 10s → 恢复写
    expect(readDisk(filePath).lastActivityAt).toBe(4_000);
  });

  it('文件不存在（首次运行）→ 归零，且构造不创建文件', () => {
    const filePath = tmpFile();
    const store = new UserActivityStore(filePath);
    expect(store.snapshot()).toEqual({ lastActivityAt: null, lastSpeechAt: null, lastActivityKind: null });
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('损坏 / 形状不符 → 构造不抛、归零', () => {
    const filePath = tmpFile();

    fs.writeFileSync(filePath, '{ 这不是 JSON', 'utf-8');
    expect(new UserActivityStore(filePath).snapshot()).toEqual({
      lastActivityAt: null,
      lastSpeechAt: null,
      lastActivityKind: null,
    });

    fs.writeFileSync(
      filePath,
      JSON.stringify({ lastActivityAt: 'nope', lastSpeechAt: -5, lastActivityKind: 'evil' }),
      'utf-8',
    );
    expect(new UserActivityStore(filePath).snapshot()).toEqual({
      lastActivityAt: null,
      lastSpeechAt: null,
      lastActivityKind: null,
    });

    fs.writeFileSync(filePath, 'null', 'utf-8');
    expect(new UserActivityStore(filePath).snapshot()).toEqual({
      lastActivityAt: null,
      lastSpeechAt: null,
      lastActivityKind: null,
    });
  });

  it('损坏文件登记不抛：归零实例照常 note', () => {
    const filePath = tmpFile();
    fs.writeFileSync(filePath, 'broken', 'utf-8');
    const store = new UserActivityStore(filePath);
    expect(() => store.note('voice-turn', 5_000)).not.toThrow();
    expect(store.snapshot()).toEqual({ lastActivityAt: 5_000, lastSpeechAt: 5_000, lastActivityKind: 'voice-turn' });
  });

  it('落盘失败（目标路径被目录占据）→ 不抛，内存态照常生效', () => {
    const target = path.join(dir, 'as-dir');
    fs.mkdirSync(target);
    const store = new UserActivityStore(target);
    expect(() => store.note('voice-turn', 5_000)).not.toThrow();
    expect(() => store.flush()).not.toThrow();
    expect(store.snapshot()).toEqual({ lastActivityAt: 5_000, lastSpeechAt: 5_000, lastActivityKind: 'voice-turn' });
  });
});

describe('默认路径与单例', () => {
  it('默认路径口径：XDG_DATA_HOME/tide-commander/user-activity/activity.json', () => {
    vi.stubEnv('XDG_DATA_HOME', dir);
    expect(defaultUserActivityPath()).toBe(path.join(dir, 'tide-commander', 'user-activity', 'activity.json'));
  });

  it('getUserActivityStore 幂等；reset 后可换新（不建/不删文件）', () => {
    vi.stubEnv('XDG_DATA_HOME', dir);
    const first = getUserActivityStore();
    expect(getUserActivityStore()).toBe(first);
    resetUserActivityForTests();
    const second = getUserActivityStore();
    expect(second).not.toBe(first);
    expect(fs.existsSync(second.filePath)).toBe(false);
  });

  it('模块级助手走单例：note → snapshot → isActiveWithin；未知 kind 忽略', () => {
    vi.stubEnv('XDG_DATA_HOME', dir);
    expect(getUserActivitySnapshot()).toEqual({ lastActivityAt: null, lastSpeechAt: null, lastActivityKind: null });
    expect(isUserActiveWithin(1_000, 5_000)).toBe(false);

    noteUserActivity('voice-turn', 4_500);
    expect(getUserActivitySnapshot()).toEqual({
      lastActivityAt: 4_500,
      lastSpeechAt: 4_500,
      lastActivityKind: 'voice-turn',
    });
    expect(isUserActiveWithin(1_000, 5_000)).toBe(true);
    expect(isUserActiveWithin(499, 5_000)).toBe(false);

    noteUserActivity('evil' as never, 9_999); // 运行时白名单兜底：忽略
    expect(getUserActivitySnapshot().lastActivityAt).toBe(4_500);
  });
});
