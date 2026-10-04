/**
 * jarvis-core/reflection · 运行状态存储（任务 28 ⑤.4「首次运行强制 Tier2」）
 *
 * 首次运行判定：runCount === 0。**仅 completed 计次**——skipped（门槛不足）与
 * failed（通道未接线/解析失败）没有自动应用任何东西，不消耗「首次」；
 * 下次成功运行仍按首次强制 Tier2（保守，未审不下发）。
 *
 * 持久化：反思自己的 JSON 文件（默认 jarvis-reflection/run-state.json），
 * 原子写（tmp + rename）；损坏容错为初始态 + warn。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { jarvisLogger, type JarvisLogger } from '../executors.js';
import { defaultRunStatePath } from './paths.js';
import type { ReflectionRunStatus } from './types.js';

export interface ReflectionRunState {
  /** 已完成的反思运行次数（首次 D 判定依据）。 */
  runCount: number;
  lastStatus?: ReflectionRunStatus;
  lastRunAt?: number;
  lastTier2Rate?: number;
}

export interface FileReflectionRunStateOptions {
  /** 存储文件；缺省 defaultRunStatePath()（测试必须显式注入临时文件）。 */
  filePath?: string;
  logger?: JarvisLogger;
}

const INITIAL_STATE: ReflectionRunState = { runCount: 0 };

export class FileReflectionRunState {
  readonly filePath: string;
  private readonly logger: JarvisLogger;
  private cache: ReflectionRunState | null = null;

  constructor(options: FileReflectionRunStateOptions = {}) {
    this.filePath = options.filePath ?? defaultRunStatePath();
    this.logger = options.logger ?? jarvisLogger;
  }

  load(): ReflectionRunState {
    if (this.cache) return this.cache;
    let content: string;
    try {
      content = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      this.cache = { ...INITIAL_STATE };
      return this.cache;
    }
    try {
      const parsed = JSON.parse(content) as Partial<ReflectionRunState>;
      const runCount = typeof parsed.runCount === 'number' && parsed.runCount >= 0 ? Math.trunc(parsed.runCount) : 0;
      this.cache = {
        runCount,
        lastStatus: parsed.lastStatus,
        lastRunAt: typeof parsed.lastRunAt === 'number' ? parsed.lastRunAt : undefined,
        lastTier2Rate: typeof parsed.lastTier2Rate === 'number' ? parsed.lastTier2Rate : undefined,
      };
    } catch (error) {
      this.logger.warn(`[Reflection] 运行状态文件损坏（按初始态处理）: ${this.filePath}`, error);
      this.cache = { ...INITIAL_STATE };
    }
    return this.cache;
  }

  /** 是否首次运行（未完成过任何一次反思）。 */
  isFirstRun(): boolean {
    return this.load().runCount === 0;
  }

  /** 记录一次终态；completed 才计入 runCount。 */
  record(update: { status: ReflectionRunStatus; at: number; tier2Rate?: number }): ReflectionRunState {
    const state = this.load();
    const next: ReflectionRunState = {
      runCount: state.runCount + (update.status === 'completed' ? 1 : 0),
      lastStatus: update.status,
      lastRunAt: update.at,
      lastTier2Rate: update.tier2Rate ?? state.lastTier2Rate,
    };
    this.cache = next;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      // 状态写失败不阻断主链路；降级 = 下次仍视为首次（保守侧：全部 Tier2）
      this.logger.warn(`[Reflection] 运行状态写入失败（降级，下次按首次处理）: ${this.filePath}`, error);
    }
    return next;
  }
}
