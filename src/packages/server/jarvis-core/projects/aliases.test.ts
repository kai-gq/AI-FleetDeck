/**
 * jarvis-core/projects · 项目别名表（任务 14·⑪ ⑤.1）
 *
 * 钉死：workspace 名自动种子（纯函数、幂等）、文件读写（XDG 路径由调用方注入，
 * 缺文件/损坏 → 空表绝不抛）、归一化匹配（忽略大小写/空白）、长别名优先、
 * 单 ASCII 字母太泛不参与子串匹配。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { JarvisLogger } from '../executors.js';
import {
  aliasesForProject,
  defaultAliasTablePath,
  defaultProjectsBaseDir,
  emptyAliasTable,
  isMatchableAlias,
  loadAliasTable,
  matchAliases,
  normalizeAlias,
  projectIdForAlias,
  saveAliasTable,
  seedAliasesForWorkspaces,
  upsertAlias,
} from './aliases.js';
import type { ProjectAliasTable, ProjectWorkspaceInput } from './types.js';

const silentLogger: JarvisLogger = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
const NOW = 1_800_000_000_000;

const workspaces: ProjectWorkspaceInput[] = [
  { id: 'wsA', name: '项目A', areaIds: [] },
  { id: 'wsB', name: ' Project B ', areaIds: [] }, // 首尾空白归一化
  { id: 'wsC', name: '', areaIds: [] }, // 空名不种
];

describe('别名归一化与可匹配性', () => {
  it('normalizeAlias：去首尾与内部空白、忽略大小写', () => {
    expect(normalizeAlias(' Project B ')).toBe('projectb');
    expect(normalizeAlias('项目 A')).toBe('项目a');
  });

  it('isMatchableAlias：单 ASCII 字母太泛 → false；单汉字/多字符 → true', () => {
    expect(isMatchableAlias('b')).toBe(false);
    expect(isMatchableAlias('B')).toBe(false);
    expect(isMatchableAlias('报')).toBe(true);
    expect(isMatchableAlias('ab')).toBe(true);
    expect(isMatchableAlias('项目b')).toBe(true);
    expect(isMatchableAlias(' ')).toBe(false);
  });

  it('load 的 alias 一律归一化后再比较（见读写 roundtrip）', () => {
    const table = emptyAliasTable(NOW);
    const next = upsertAlias(table, ' Project B ', 'wsB', NOW);
    expect(next.entries[0].alias).toBe('projectb');
  });
});

describe('seedAliasesForWorkspaces（纯函数种子）', () => {
  it('workspace 名 → 别名；空名跳过；无新增返回原表引用', () => {
    const base = emptyAliasTable(NOW);
    const seeded = seedAliasesForWorkspaces(base, workspaces, NOW);
    expect(seeded.entries.map((e) => [e.alias, e.projectId, e.source])).toEqual([
      ['项目a', 'wsA', 'seed'],
      ['projectb', 'wsB', 'seed'],
    ]);
    expect(seedAliasesForWorkspaces(seeded, workspaces, NOW)).toBe(seeded); // 幂等
  });

  it('已有同别名（手改或旧种子）不覆盖', () => {
    const withManual = upsertAlias(emptyAliasTable(NOW), '项目A', 'wsX', NOW);
    const seeded = seedAliasesForWorkspaces(withManual, workspaces, NOW);
    expect(seeded.entries.find((e) => e.alias === '项目a')?.projectId).toBe('wsX');
  });
});

describe('别名表文件读写（注入临时路径）', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-aliases-'));
    file = path.join(dir, 'aliases.json');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('save → load roundtrip（tmp+rename 原子落盘）', () => {
    const table = upsertAlias(seedAliasesForWorkspaces(emptyAliasTable(NOW), workspaces, NOW), '报价组', 'wsA', NOW + 1);
    saveAliasTable(table, file);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    const loaded = loadAliasTable(file, { now: () => NOW });
    expect(loaded.entries).toHaveLength(3);
    expect(projectIdForAlias(loaded, '报价组')).toBe('wsA');
    expect(projectIdForAlias(loaded, ' BAO ')).toBeUndefined();
  });

  it('文件缺失 → 空表（正常路径，不抛）', () => {
    const table = loadAliasTable(path.join(dir, 'nope.json'), { now: () => NOW });
    expect(table).toEqual({ version: 1, entries: [], updatedAt: NOW });
  });

  it('文件损坏 → warn + 空表（容错，不抛）', () => {
    fs.writeFileSync(file, '{ not json');
    const warn = vi.fn();
    const logger: JarvisLogger = { ...silentLogger, warn };
    const table = loadAliasTable(file, { now: () => NOW, logger });
    expect(table.entries).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('畸形条目丢弃 / 别名去重（首条保留）', () => {
    const raw: ProjectAliasTable = {
      version: 1,
      entries: [
        { alias: '报价组', projectId: 'wsA', createdAt: 1, source: 'file' },
        { alias: '报价组', projectId: 'wsB', createdAt: 2, source: 'file' }, // 重复别名 → 丢
        { alias: 'bad', projectId: '  ', createdAt: 3, source: 'file' }, // projectId 空 → 丢
      ] as ProjectAliasTable['entries'],
      updatedAt: NOW,
    };
    fs.writeFileSync(file, JSON.stringify(raw));
    const loaded = loadAliasTable(file, { now: () => NOW });
    expect(loaded.entries).toEqual([{ alias: '报价组', projectId: 'wsA', createdAt: 1, source: 'file' }]);
  });
});

describe('upsert / 查询 / 匹配', () => {
  const table: ProjectAliasTable = {
    version: 1,
    updatedAt: NOW,
    entries: [
      { alias: '项目b组', projectId: 'wsB', createdAt: NOW, source: 'file' },
      { alias: '项目b', projectId: 'wsB', createdAt: NOW, source: 'file' },
      { alias: 'a组', projectId: 'wsA', createdAt: NOW, source: 'file' },
      { alias: 'b', projectId: 'wsA', createdAt: NOW, source: 'file' }, // 单 ASCII → 不参与子串匹配
    ],
  };

  it('upsertAlias：同别名改绑到新项目', () => {
    const next = upsertAlias(table, '项目B', 'wsC', NOW + 1);
    expect(next.entries.filter((e) => e.alias === '项目b').map((e) => e.projectId)).toEqual(['wsC']);
    expect(next.entries).toHaveLength(4);
    expect(upsertAlias(next, '  ', 'wsC', NOW)).toBe(next); // 空别名 → 原表
  });

  it('aliasesForProject / projectIdForAlias', () => {
    expect(aliasesForProject(table, 'wsB')).toEqual(['项目b组', '项目b']);
    expect(projectIdForAlias(table, '项目B组')).toBe('wsB');
    expect(projectIdForAlias(table, 'b')).toBe('wsA');
    expect(projectIdForAlias(table, '不存在')).toBeUndefined();
  });

  it('matchAliases：长别名优先、同一项目只记首个、单 ASCII 字母跳过', () => {
    const matches = matchAliases('把项目B组的活交给 A组 办', table.entries);
    expect(matches).toEqual([
      { projectId: 'wsB', alias: '项目b组' },
      { projectId: 'wsA', alias: 'a组' },
    ]);
  });

  it('matchAliases：大小写/空白不敏感；空文本不匹配', () => {
    expect(matchAliases('PROJECTB', [{ alias: 'projectb', projectId: 'wsB', createdAt: 0, source: 'file' }]))
      .toEqual([{ projectId: 'wsB', alias: 'projectb' }]);
    expect(matchAliases('   ', table.entries)).toEqual([]);
  });
});

describe('默认路径（XDG 模式，绝不写死真实路径）', () => {
  it('defaultProjectsBaseDir 拼在 XDG_DATA_HOME 下；文件名为 aliases.json', () => {
    const original = process.env.XDG_DATA_HOME;
    try {
      process.env.XDG_DATA_HOME = path.join(os.tmpdir(), 'xdg-probe');
      expect(defaultProjectsBaseDir()).toBe(path.join(os.tmpdir(), 'xdg-probe', 'tide-commander', 'jarvis-projects'));
      expect(defaultAliasTablePath()).toBe(path.join(os.tmpdir(), 'xdg-probe', 'tide-commander', 'jarvis-projects', 'aliases.json'));
    } finally {
      if (original === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = original;
    }
  });
});
