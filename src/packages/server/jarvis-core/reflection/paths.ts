/**
 * jarvis-core/reflection · 存储路径（任务 28）
 *
 * 治理数据（Tier2 待审队列 / 运行状态）落反思自己的 JSON 文件，不混入记忆层
 * vault（记忆层目录只放四层 Markdown 条目）。路径约定与任务 27
 * defaultMemoryBaseDir() 同规：XDG_DATA_HOME → tide-commander/<子目录>；
 * **绝不写死真实路径**，测试一律显式注入临时目录/文件。
 */

import * as os from 'node:os';
import * as path from 'node:path';

/** 反思治理数据根目录（生产；测试须显式注入临时目录）。 */
export function defaultReflectionBaseDir(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'tide-commander', 'jarvis-reflection');
}

/** Tier2 待审队列默认文件。 */
export function defaultReviewQueuePath(): string {
  return path.join(defaultReflectionBaseDir(), 'pending-reviews.json');
}

/** 运行状态（首次运行判定）默认文件。 */
export function defaultRunStatePath(): string {
  return path.join(defaultReflectionBaseDir(), 'run-state.json');
}
