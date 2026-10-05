/**
 * 任务29 · morning-coverage-store 单测
 *
 * 覆盖：读写往返（数字 id 字符串化/去重）、同日并集、跨日不串（只留最近一天）、
 * 损坏与形状不符容错为初始态、写入失败降级不抛（warn）、原子写（tmp+rename，无 .tmp 残留）、
 * 路径不落真实 XDG（一律显式注入临时文件）。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileMorningCoverageStore,
  defaultMorningCoveragePath,
  getMorningCoverageStore,
  resetMorningCoverageStoreForTests,
  type FileMorningCoverageStoreOptions,
} from './morning-coverage-store.js';

let dir: string;

function tmpStore(over: FileMorningCoverageStoreOptions = {}): FileMorningCoverageStore {
  return new FileMorningCoverageStore({ filePath: path.join(dir, 'coverage.json'), ...over });
}

function silentLogger() {
  return { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morning-coverage-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetMorningCoverageStoreForTests();
});

describe('FileMorningCoverageStore', () => {
  it('读写往返：recordCoverage → 落盘 → 新实例 load 读回（数字 id 字符串化/去重）', () => {
    const filePath = path.join(dir, 'nested', 'coverage.json'); // 父目录不存在 → 原子写自建
    const first = new FileMorningCoverageStore({ filePath });
    const state = first.recordCoverage({ day: '2026-10-05', bolbaTaskIds: [1, '2', 1] });

    expect(state).toEqual({ day: '2026-10-05', bolbaTaskIds: ['1', '2'] });
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(`${filePath}.tmp`)).toBe(false); // 原子写无 .tmp 残留
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual({ day: '2026-10-05', bolbaTaskIds: ['1', '2'] });

    const second = new FileMorningCoverageStore({ filePath });
    expect([...second.coveredIds('2026-10-05')].sort()).toEqual(['1', '2']);
    expect(second.isCovered('2026-10-05', 2)).toBe(true);
    expect(second.isCovered('2026-10-05', '3')).toBe(false);
  });

  it('同日重复记录 → 并集（幂等重试不丢已有 id）', () => {
    const store = tmpStore();
    store.recordCoverage({ day: '2026-10-05', bolbaTaskIds: ['1'] });
    store.recordCoverage({ day: '2026-10-05', bolbaTaskIds: ['2'] });

    expect([...store.coveredIds('2026-10-05')].sort()).toEqual(['1', '2']);
    expect([...new FileMorningCoverageStore({ filePath: store.filePath }).coveredIds('2026-10-05')].sort())
      .toEqual(['1', '2']);
  });

  it('跨日不串：换日覆盖旧日，查旧日键返回空集', () => {
    const store = tmpStore();
    store.recordCoverage({ day: '2026-10-05', bolbaTaskIds: ['1'] });
    store.recordCoverage({ day: '2026-10-06', bolbaTaskIds: ['9'] });

    expect([...store.coveredIds('2026-10-06')]).toEqual(['9']);
    expect(store.coveredIds('2026-10-05').size).toBe(0);
    expect(store.isCovered('2026-10-05', '1')).toBe(false);
  });

  it('无文件（首次运行）→ 初始态空集，不 warn', () => {
    const logger = silentLogger();
    const store = tmpStore({ logger });
    expect(store.load()).toEqual({ day: '', bolbaTaskIds: [] });
    expect(store.coveredIds('2026-10-05').size).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('文件损坏（非 JSON）→ 按无覆盖处理 + warn，不抛', () => {
    const filePath = path.join(dir, 'coverage.json');
    fs.writeFileSync(filePath, '{ 这不是 JSON', 'utf-8');
    const logger = silentLogger();
    const store = new FileMorningCoverageStore({ filePath, logger });

    expect(store.load()).toEqual({ day: '', bolbaTaskIds: [] });
    expect(store.coveredIds('2026-10-05').size).toBe(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('形状不符（day 非日键 / ids 非字符串数组）→ 归一化为初始态，不抛', () => {
    const filePath = path.join(dir, 'coverage.json');
    fs.writeFileSync(filePath, JSON.stringify({ day: 'x', bolbaTaskIds: 'nope' }), 'utf-8');
    const store = new FileMorningCoverageStore({ filePath });

    expect(store.load()).toEqual({ day: '', bolbaTaskIds: [] });
    expect(store.coveredIds('x').size).toBe(0);

    fs.writeFileSync(filePath, JSON.stringify({ day: '2026-10-05', bolbaTaskIds: ['1', 2, '', null] }), 'utf-8');
    const second = new FileMorningCoverageStore({ filePath });
    expect([...second.coveredIds('2026-10-05')]).toEqual(['1']);
  });

  it('写入失败（目标路径是目录）→ 不抛、warn 降级，内存态照常返回', () => {
    const target = path.join(dir, 'as-dir');
    fs.mkdirSync(target);
    const logger = silentLogger();
    const store = new FileMorningCoverageStore({ filePath: target, logger });

    expect(() => store.recordCoverage({ day: '2026-10-05', bolbaTaskIds: ['7'] })).not.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect([...store.coveredIds('2026-10-05')]).toEqual(['7']); // 进程内照常生效（只是没落盘）
  });

  it('默认路径口径：XDG_DATA_HOME/tide-commander/jarvis-morning/coverage.json', () => {
    vi.stubEnv('XDG_DATA_HOME', dir);
    expect(defaultMorningCoveragePath()).toBe(
      path.join(dir, 'tide-commander', 'jarvis-morning', 'coverage.json'),
    );
    vi.unstubAllEnvs();
  });

  it('单例：getMorningCoverageStore 幂等，reset 后可换新（测试隔离）', () => {
    const first = getMorningCoverageStore();
    expect(getMorningCoverageStore()).toBe(first);
    resetMorningCoverageStoreForTests();
    expect(getMorningCoverageStore()).not.toBe(first);
  });
});
