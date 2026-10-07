/**
 * jarvis-core/persona · 存储路径（任务 32）
 *
 * 人格层数据（关系模型 / 会话计数）落自己的 JSON 文件，不混入记忆层 vault、
 * 不混 reflection 治理目录。路径约定与任务 27 defaultMemoryBaseDir() /
 * 任务 28 defaultReflectionBaseDir() 同规：XDG_DATA_HOME → tide-commander/<子目录>；
 * **绝不写死真实路径**，测试一律显式注入临时目录/文件。
 */

import * as os from 'node:os';
import * as path from 'node:path';

/** 人格层数据根目录（生产；测试须显式注入临时目录）。 */
export function defaultPersonaBaseDir(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'tide-commander', 'jarvis-persona');
}

/** 关系模型（可演化）默认文件。 */
export function defaultRelationshipPath(): string {
  return path.join(defaultPersonaBaseDir(), 'relationship.json');
}

/** 会话计数（记录期判定）默认文件。 */
export function defaultSessionCounterPath(): string {
  return path.join(defaultPersonaBaseDir(), 'session-count.json');
}
