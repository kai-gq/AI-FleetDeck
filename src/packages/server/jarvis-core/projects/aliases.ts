/**
 * jarvis-core · 项目感知与路由（任务 14·⑪）·项目别名表（workspace ⇄ 口称名）
 *
 * 存储路径沿用任务 28 reflection/paths.ts 的 XDG 模式：
 *   XDG_DATA_HOME → tide-commander/jarvis-projects/aliases.json
 * （**绝不写死真实路径**；测试注入临时文件或直接走全局 XDG 沙箱）。
 *
 * 口径：
 * - 缺省自动种子 = workspace 名（seedAliasesForWorkspaces 纯函数，不落盘）；
 * - 文件只存手改/后续写入（P2 语音建项目、工具箱）的别名，读写宽松降级：
 *   文件缺失/损坏 → 空表，绝不抛（不打断 hop1/路由）；
 * - 匹配忽略大小写与空白；单 ASCII 字母别名太泛（'b' 命中 'abc'）不参与子串匹配。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { jarvisLogger, type JarvisLogger } from '../executors.js';
import type { ProjectAliasEntry, ProjectAliasTable, ProjectWorkspaceInput } from './types.js';

/** 项目治理数据根目录（生产；测试须显式注入临时路径）。 */
export function defaultProjectsBaseDir(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'tide-commander', 'jarvis-projects');
}

/** 别名表默认文件。 */
export function defaultAliasTablePath(): string {
  return path.join(defaultProjectsBaseDir(), 'aliases.json');
}

/** 归一化口称名：去首尾空白、忽略大小写、去内部空白。 */
export function normalizeAlias(alias: string): string {
  return alias.trim().toLowerCase().replace(/\s+/g, '');
}

/** 是否可作为匹配别名：>=2 字符，或单个汉字（单 ASCII 字母太泛，跳过子串匹配）。 */
export function isMatchableAlias(alias: string): boolean {
  const normalized = normalizeAlias(alias);
  if (normalized.length >= 2) return true;
  return normalized.length === 1 && /[一-鿿]/.test(normalized);
}

export function emptyAliasTable(now: number): ProjectAliasTable {
  return { version: 1, entries: [], updatedAt: now };
}

export interface AliasTableIoOptions {
  now?: () => number;
  logger?: JarvisLogger;
}

/**
 * 读别名表：文件缺失 = 空表（正常）；损坏 = warn + 空表（容错，不抛）；
 * 同别名重复 / 畸形条目按首条保留（后者丢弃）。
 */
export function loadAliasTable(
  filePath: string = defaultAliasTablePath(),
  options: AliasTableIoOptions = {},
): ProjectAliasTable {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? jarvisLogger;
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return emptyAliasTable(now());
  }
  try {
    const parsed = JSON.parse(content) as Partial<ProjectAliasTable>;
    const raw = Array.isArray(parsed?.entries) ? parsed.entries : [];
    const entries: ProjectAliasEntry[] = [];
    for (const item of raw) {
      if (!item || typeof item.alias !== 'string' || typeof item.projectId !== 'string') continue;
      const alias = normalizeAlias(item.alias);
      if (!alias || !item.projectId.trim()) continue;
      if (entries.some((e) => e.alias === alias)) continue;
      entries.push({
        alias,
        projectId: item.projectId,
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : now(),
        source: item.source === 'seed' ? 'seed' : 'file',
      });
    }
    return {
      version: 1,
      entries,
      updatedAt: typeof parsed?.updatedAt === 'number' ? parsed.updatedAt : now(),
    };
  } catch (error) {
    logger.warn(`[Projects] 别名表文件损坏（按空表处理）: ${filePath}`, error);
    return emptyAliasTable(now());
  }
}

/** 原子落盘（tmp + rename，与 reflection/Tier2ReviewQueue.persist 同型）。 */
export function saveAliasTable(table: ProjectAliasTable, filePath: string = defaultAliasTablePath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(table, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, filePath);
}

/** 缺省种子：workspace 名 → 别名（纯函数；已有同别名则不动，返回原表引用）。 */
export function seedAliasesForWorkspaces(
  table: ProjectAliasTable,
  workspaces: readonly ProjectWorkspaceInput[],
  now: number,
): ProjectAliasTable {
  let entries: ProjectAliasEntry[] | null = null;
  for (const ws of workspaces) {
    const alias = normalizeAlias(ws.name);
    if (!alias) continue;
    const current: ProjectAliasEntry[] = entries ?? table.entries;
    if (current.some((e) => e.alias === alias)) continue;
    entries = [...current, { alias, projectId: ws.id, createdAt: now, source: 'seed' }];
  }
  if (!entries) return table;
  return { version: 1, entries, updatedAt: now };
}

/** 写入口称名（同别名已有 → 改绑到新项目；空别名/项目返回原表）。 */
export function upsertAlias(
  table: ProjectAliasTable,
  alias: string,
  projectId: string,
  now: number,
  source: 'seed' | 'file' = 'file',
): ProjectAliasTable {
  const normalized = normalizeAlias(alias);
  if (!normalized || !projectId) return table;
  const rest = table.entries.filter((e) => e.alias !== normalized);
  return {
    version: 1,
    entries: [...rest, { alias: normalized, projectId, createdAt: now, source }],
    updatedAt: now,
  };
}

/** 该项目当前全部口称名（不含 workspace 名兜底；卡构建时自行补 name）。 */
export function aliasesForProject(table: ProjectAliasTable, projectId: string): string[] {
  return table.entries.filter((e) => e.projectId === projectId).map((e) => e.alias);
}

/** 口称名 → 项目 id（归一化后精确查；找不到回 undefined）。 */
export function projectIdForAlias(table: ProjectAliasTable, alias: string): string | undefined {
  const normalized = normalizeAlias(alias);
  return table.entries.find((e) => e.alias === normalized)?.projectId;
}

export interface AliasMatch {
  projectId: string;
  alias: string;
}

/**
 * 从一段话里匹配口称名（消歧①）：归一化后子串命中；长别名优先（「项目B组」
 * 先于「项目B」）；同一项目只记首个命中的别名。单 ASCII 字母别名不参与匹配。
 */
export function matchAliases(text: string, aliases: readonly ProjectAliasEntry[]): AliasMatch[] {
  const haystack = normalizeAlias(text);
  if (!haystack) return [];
  const out: AliasMatch[] = [];
  const seen = new Set<string>();
  for (const entry of [...aliases].sort((a, b) => b.alias.length - a.alias.length)) {
    if (!isMatchableAlias(entry.alias)) continue;
    if (!haystack.includes(entry.alias)) continue;
    if (seen.has(entry.projectId)) continue;
    seen.add(entry.projectId);
    out.push({ projectId: entry.projectId, alias: entry.alias });
  }
  return out;
}
