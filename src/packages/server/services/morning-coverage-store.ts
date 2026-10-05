/**
 * 任务29 · 晨报覆盖账（Bolba 到期并入去重）
 *
 * 背景：任务12·⑨ 晨报（08:00）与任务13·⑩ Bolba 到期提醒（08:00）同点触发，
 * 若两者都把「Bolba 待办到期」说一遍 = 双播。对称防双播（与触发顺序无关）：
 *   - 晨报侧：并入前查当日 broadcast 日志，已有 bolba_due_reminder 独播 → 不并入；
 *     并入且**真的播出去**（voice/notice 通道）后才写本账 {day, bolbaTaskIds}；
 *   - 13 侧：播报前读本账，当日到期任务全部已随晨报播出 → 跳过独播（仅登记日志）。
 * 无晨报数据日（未并过）→ 账里没有当日记录 → 13 照常独播，不改变既有行为。
 *
 * 持久化：jarvis-morning/coverage.json（XDG 数据目录；与 jarvis-reflection 同规），
 * 原子写（tmp + rename）；损坏/读失败容错为初始态 + warn（绝不抛、绝不断播报主链路）。
 * 只存「最后写入的一天」——跨日不串：查别的日键一律返回空集。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { jarvisLogger, type JarvisLogger } from '../jarvis-core/index.js';

// ─── 类型 ───

export interface MorningCoverageState {
  /** 日键（本地日历日 'YYYY-MM-DD'，与晨报 dedupeKey / 13 扫描日键同口径）；空串 = 无覆盖。 */
  day: string;
  /** 当日已随晨报播出的 Bolba 任务 id（字符串化去重；id 类型跨 number/string 幂等）。 */
  bolbaTaskIds: string[];
}

/** 覆盖账读接口（两个服务按此注入；FileMorningCoverageStore 实现其子集）。 */
export interface MorningCoverageStore {
  /** 记录覆盖（语义见实现注释）。 */
  recordCoverage(input: { day: string; bolbaTaskIds: readonly (string | number)[] }): MorningCoverageState;
  /** 某日已覆盖 id 集；无记录/日键不同 → 空集。 */
  coveredIds(day: string): ReadonlySet<string>;
  /** 某日某任务是否已被晨报覆盖。 */
  isCovered(day: string, taskId: string | number): boolean;
}

const INITIAL_STATE: MorningCoverageState = { day: '', bolbaTaskIds: [] };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 覆盖账默认路径（生产；测试必须显式注入临时文件，绝不碰真实路径）。 */
export function defaultMorningCoveragePath(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'tide-commander', 'jarvis-morning', 'coverage.json');
}

// ─── 文件实现（load 缓存 + 原子写 + 损坏容错） ───

export interface FileMorningCoverageStoreOptions {
  /** 存储文件；缺省 defaultMorningCoveragePath()（测试必须显式注入临时文件）。 */
  filePath?: string;
  logger?: JarvisLogger;
}

export class FileMorningCoverageStore implements MorningCoverageStore {
  readonly filePath: string;
  private readonly logger: JarvisLogger;
  private cache: MorningCoverageState | null = null;

  constructor(options: FileMorningCoverageStoreOptions = {}) {
    this.filePath = options.filePath ?? defaultMorningCoveragePath();
    this.logger = options.logger ?? jarvisLogger;
  }

  load(): MorningCoverageState {
    if (this.cache) return this.cache;
    let content: string;
    try {
      content = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      // 首次运行/文件不存在：无声初始态（不是错误）
      this.cache = { ...INITIAL_STATE, bolbaTaskIds: [] };
      return this.cache;
    }
    try {
      const parsed = JSON.parse(content) as Partial<MorningCoverageState>;
      const day = typeof parsed.day === 'string' && DAY_RE.test(parsed.day) ? parsed.day : '';
      const ids = Array.isArray(parsed.bolbaTaskIds)
        ? [...new Set(parsed.bolbaTaskIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
        : [];
      this.cache = { day, bolbaTaskIds: ids };
    } catch (error) {
      this.logger.warn(`[MorningCoverage] 覆盖账文件损坏（按无覆盖处理）: ${this.filePath}`, error);
      this.cache = { ...INITIAL_STATE, bolbaTaskIds: [] };
    }
    return this.cache;
  }

  /**
   * 记录「某日晨报已播出的 bolba 任务 id」。
   * 同一天重复记录 → 取并集（幂等重试不丢已有 id）；换一天 → 覆盖旧日（只留最近一天）。
   * 写失败不阻断播报主链路：降级 = 13 下次仍可能独播（宁可重复，不静默丢话）。
   */
  recordCoverage(input: { day: string; bolbaTaskIds: readonly (string | number)[] }): MorningCoverageState {
    const state = this.load();
    const incoming = [...new Set(input.bolbaTaskIds.map((id) => String(id)).filter((id) => id.length > 0))];
    const next: MorningCoverageState = state.day === input.day
      ? { day: input.day, bolbaTaskIds: [...new Set([...state.bolbaTaskIds, ...incoming])] }
      : { day: input.day, bolbaTaskIds: incoming };
    this.cache = next;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      this.logger.warn(`[MorningCoverage] 覆盖账写入失败（降级，13 可能照常独播）: ${this.filePath}`, error);
    }
    return next;
  }

  /** 某日已覆盖 id 集；无记录或日键不同 → 空集（跨日不串）。 */
  coveredIds(day: string): ReadonlySet<string> {
    const state = this.load();
    return state.day === day && state.day !== '' ? new Set(state.bolbaTaskIds) : new Set();
  }

  isCovered(day: string, taskId: string | number): boolean {
    return this.coveredIds(day).has(String(taskId));
  }
}

// ─── 进程单例（生产共用；测试一律显式注入临时文件路径） ───

let defaultStore: FileMorningCoverageStore | null = null;

export function getMorningCoverageStore(): FileMorningCoverageStore {
  return (defaultStore ??= new FileMorningCoverageStore());
}

/** 测试专用：丢弃进程内单例。 */
export function resetMorningCoverageStoreForTests(): void {
  defaultStore = null;
}
