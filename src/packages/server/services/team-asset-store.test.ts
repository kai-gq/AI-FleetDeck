/**
 * 任务23 · 资产库存储层测试（append-only 验收④）：
 * 落盘/读回、重复 append 拒绝（幂等门）、无 update/delete 入口、
 * 损坏备份重建、写失败 fail-open 返回。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FileTeamAssetStore, type TeamAssetEntry } from './team-asset-store.js';

function makeEntry(overrides: Partial<TeamAssetEntry> = {}): TeamAssetEntry {
  return {
    decisionId: 'd-1',
    bossId: 'boss-1',
    agentId: 'agent-1',
    agentName: '小刘',
    objective: '实现登录页',
    userCommand: '做个登录页',
    reasoning: 'builder 空闲',
    durationMs: 38_500,
    outcome: 'completed',
    completedAt: 1_000_000,
    recordedAt: 1_000_100,
    ...overrides,
  };
}

describe('任务23 资产库存储（append-only）', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-team-assets-'));
    file = path.join(dir, 'team-memory', 'assets.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('append 原子落盘（无 .tmp 残留）→ list/has 读回', () => {
    const store = new FileTeamAssetStore({ filePath: file });
    expect(store.append(makeEntry())).toEqual({ appended: true });

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: number; entries: TeamAssetEntry[] };
    expect(onDisk.version).toBe(1);
    expect(onDisk.entries).toHaveLength(1);
    expect(onDisk.entries[0].decisionId).toBe('d-1');
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);

    expect(store.list().map((e) => e.decisionId)).toEqual(['d-1']);
    expect(store.has('d-1')).toBe(true);
    expect(store.has('d-x')).toBe(false);
  });

  it('同 decisionId 重复 append 被拒（duplicate）,文件逐字节不变（防篡改重放）', () => {
    const store = new FileTeamAssetStore({ filePath: file });
    store.append(makeEntry());
    const before = fs.readFileSync(file, 'utf8');

    const again = store.append(makeEntry({ objective: '被篡改的目标', durationMs: 1 }));
    expect(again).toEqual({ appended: false, reason: 'duplicate' });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(store.list()).toHaveLength(1);
  });

  it('append-only API 面：无 update/delete/remove 入口', () => {
    const store = new FileTeamAssetStore({ filePath: file }) as unknown as Record<string, unknown>;
    expect(store.update).toBeUndefined();
    expect(store.delete).toBeUndefined();
    expect(store.remove).toBeUndefined();
    expect(store.deleteEntry).toBeUndefined();
  });

  it('list 返回拷贝：外部改写不影响库内状态', () => {
    const store = new FileTeamAssetStore({ filePath: file });
    store.append(makeEntry());
    const snapshot = store.list() as TeamAssetEntry[];
    snapshot.pop();
    expect(store.list()).toHaveLength(1);
  });

  it('文件损坏 → 备份为 *.corrupt-* 后空库重建（绝不静默丢弃历史文件）', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{不是 JSON', 'utf8');

    const store = new FileTeamAssetStore({ filePath: file });
    expect(store.list()).toEqual([]);
    expect(store.append(makeEntry())).toEqual({ appended: true });

    const backups = fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(file), backups[0]), 'utf8')).toBe('{不是 JSON');
  });

  it('损坏且备份失败 → 转只读拒写（绝不用新数据覆盖仍含旧资产的损坏文件）', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not-json', 'utf8');
    const store = new FileTeamAssetStore({
      filePath: file,
      moveFileSync: () => {
        throw new Error('模拟备份失败');
      },
    });
    expect(store.list()).toEqual([]); // 损坏 → 空库视图，不抛
    expect(store.append(makeEntry())).toEqual({ appended: false, reason: 'file_corrupt' });
    expect(fs.readFileSync(file, 'utf8')).toBe('not-json'); // 旧文件原样保留
  });

  it('写失败（父路径被文件占位）→ 返回 write_failed 不抛,缓存与磁盘保持一致', () => {
    const blocked = path.join(dir, 'blocked-file');
    fs.writeFileSync(blocked, 'x', 'utf8'); // 让 mkdirSync(blocked/team-memory) 必败
    const store = new FileTeamAssetStore({ filePath: path.join(blocked, 'team-memory', 'assets.json') });

    expect(store.append(makeEntry())).toEqual({ appended: false, reason: 'write_failed' });
    expect(store.list()).toEqual([]); // 写失败不污染内存态
  });
});
