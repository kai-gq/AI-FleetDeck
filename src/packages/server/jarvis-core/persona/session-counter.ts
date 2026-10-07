/**
 * jarvis-core/persona · 会话计数（任务 32 验收①「前 20 次会话零变更」）
 *
 * 每次会话开始时 +1（按会话 id 去重，幂等）；计数 < RECORD_PHASE_SESSIONS 即
 * 记录期（治理层据此出 record-only，只记成长日志不生效）。
 *
 * 持久化：jarvis-persona/session-count.json，原子写（tmp + rename）；损坏容错
 * = 初始态 + warn。样板：reflection/run-state.ts（懒加载缓存 + 写失败降级不阻断）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { jarvisLogger, type JarvisLogger } from '../executors.js';
import { RECORD_PHASE_SESSIONS } from './governance.js';
import { defaultSessionCounterPath } from './paths.js';

export interface PersonaSessionState {
  version: 1;
  /** 已记录的会话数（去重后）。 */
  sessionCount: number;
  /** 最近一次计入的会话 id（同一会话重复 recordSession 不重复计）。 */
  lastSessionId?: string;
  lastRecordedAt?: number;
}

export interface FileSessionCounterOptions {
  /** 存储文件；缺省 defaultSessionCounterPath()（测试必须显式注入临时文件）。 */
  filePath?: string;
  logger?: JarvisLogger;
}

const INITIAL_STATE: PersonaSessionState = { version: 1, sessionCount: 0 };

export class FileSessionCounter {
  readonly filePath: string;
  private readonly logger: JarvisLogger;
  private cache: PersonaSessionState | null = null;

  constructor(options: FileSessionCounterOptions = {}) {
    this.filePath = options.filePath ?? defaultSessionCounterPath();
    this.logger = options.logger ?? jarvisLogger;
  }

  load(): PersonaSessionState {
    if (this.cache) return this.cache;
    let content: string;
    try {
      content = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      this.cache = { ...INITIAL_STATE };
      return this.cache;
    }
    try {
      const parsed = JSON.parse(content) as Partial<PersonaSessionState>;
      const sessionCount =
        typeof parsed.sessionCount === 'number' && parsed.sessionCount >= 0 ? Math.trunc(parsed.sessionCount) : 0;
      this.cache = {
        version: 1,
        sessionCount,
        lastSessionId: typeof parsed.lastSessionId === 'string' ? parsed.lastSessionId : undefined,
        lastRecordedAt: typeof parsed.lastRecordedAt === 'number' ? parsed.lastRecordedAt : undefined,
      };
    } catch (error) {
      this.logger.warn(`[Persona] 会话计数文件损坏（按初始态处理）: ${this.filePath}`, error);
      this.cache = { ...INITIAL_STATE };
    }
    return this.cache;
  }

  get count(): number {
    return this.load().sessionCount;
  }

  /** 是否记录期（前 RECORD_PHASE_SESSIONS 次会话：只记录、不生效）。 */
  isRecordPhase(): boolean {
    return this.count < RECORD_PHASE_SESSIONS;
  }

  /**
   * 记录一次会话开始；与 lastSessionId 相同的重复调用幂等（counted:false）。
   * 空会话 id 不计（claude 尚未返回 sessionId 的回合由调用方跳过）。
   */
  recordSession(sessionId: string, at: number = Date.now()): { sessionCount: number; counted: boolean } {
    const state = this.load();
    if (!sessionId || state.lastSessionId === sessionId) {
      return { sessionCount: state.sessionCount, counted: false };
    }
    const next: PersonaSessionState = {
      version: 1,
      sessionCount: state.sessionCount + 1,
      lastSessionId: sessionId,
      lastRecordedAt: at,
    };
    this.cache = next;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      // 写失败不阻断主链路；降级 = 下次重启后计数回落（记录期判定偏保守）
      this.logger.warn(`[Persona] 会话计数写入失败（降级，本次计数仅存内存）: ${this.filePath}`, error);
    }
    return { sessionCount: next.sessionCount, counted: true };
  }
}
