/**
 * 任务23 · 任务资产库存储（append-only 文件账）
 *
 * 台阶三⑫「归档即资产」的落盘层：完成/失败事件驱动的团队资产条目持久化。
 * 设计约束（任务书 ⑤2/⑤4 + 验收 ④）：
 *   - **append-only**：模块只暴露 append / list / has —— 没有任何 update/delete 入口，
 *     篡改/删除在 API 层即被拒绝；同 decisionId 重复 append 返回 duplicate 拒绝（幂等重放不双写）。
 *   - **确定性写入**：条目由完成事件（DelegationCompletion）机械映射而来，非 LLM 自由写。
 *   - **绝不清掉旧数据**：文件损坏时先备份（*.corrupt-<ts>）再重建；备份失败转只读拒写。
 *   - 写失败（磁盘/权限）不抛：返回 write_failed，调用方（完成漏斗）绝不因资产库故障被拦断。
 *
 * 持久化：XDG 数据目录 `tide-commander/team-memory/assets.json`（与 jarvis-morning / jarvis-reflection 同规），
 * 原子写（tmp + rename）。与三状态文件（voice-companion.json / delegation-history.json / tracking）
 * 物理分离、只增不改——任务23 验收③「三文件物理结构不变」。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createLogger } from '../utils/index.js';

const log = createLogger('TeamAssetStore');

// ─── 类型 ───

/**
 * 团队资产条目（一条 = 一个已完成/失败的委派任务）。
 * 字段口径对应台阶三⑫「路径/决策/坑/耗时」+ 五要素视图的落盘子集。
 */
export interface TeamAssetEntry {
  /** 幂等键：来源委派决策 id（delegation-history.json 中 decision.id）。 */
  decisionId: string;
  bossId: string;
  /** 谁：执行者。 */
  agentId: string;
  agentName: string;
  /** 做了什么：任务目标（taskCard.objective 优先；无卡回退用户原话）。 */
  objective: string;
  /** 为什么（原话）：用户当时的请求。 */
  userCommand: string;
  /** 为什么（决策）：Boss 选这个执行者的理由（LLM reasoning，截断）。 */
  reasoning: string;
  /** 路径：任务卡的验收标准（拆解复用的关键材料）。 */
  acceptanceCriteria?: string[];
  /** 坑：失败原因 / 未打勾的验收项（有则记，无则缺省）。 */
  pitfalls?: string[];
  /** 产出在哪（病历 outputLocation；缺省表示入口不可得，非空串）。 */
  outputLocation?: string;
  /** 产出摘要（病历 summary）。 */
  summary?: string;
  /** 耗时（毫秒，病历 durationMs）。 */
  durationMs: number;
  /** 终态结果。 */
  outcome: 'completed' | 'failed';
  /** 完成时刻（epoch 毫秒）。 */
  completedAt: number;
  /** 入库时刻（append 时写入）。 */
  recordedAt: number;
}

/** append 结果（全部显式，无异常路径）。 */
export type AssetAppendResult =
  | { appended: true }
  | { appended: false; reason: 'duplicate' | 'write_failed' | 'file_corrupt' };

/** 资产库读接口（服务层按此注入；测试可传内存 fake）。 */
export interface TeamAssetStore {
  /** 追加条目；同 decisionId 已存在 → 拒绝（append-only 幂等门）。 */
  append(entry: TeamAssetEntry): AssetAppendResult;
  /** 全量快照（拷贝；外部改动不影响库内状态）。 */
  list(): readonly TeamAssetEntry[];
  has(decisionId: string): boolean;
}

/** 资产库默认路径（生产；测试应显式注入临时文件或 fake store，绝不碰真实数据）。 */
export function defaultTeamAssetsPath(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'tide-commander', 'team-memory', 'assets.json');
}

interface TeamAssetFileShape {
  version: 1;
  entries: TeamAssetEntry[];
}

// ─── 完整性校验（宽松：只要求幂等键+核心字段成立，未知字段保留） ───

function isValidEntry(value: unknown): value is TeamAssetEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.decisionId === 'string' && e.decisionId.length > 0 &&
    typeof e.bossId === 'string' &&
    typeof e.objective === 'string' &&
    (e.outcome === 'completed' || e.outcome === 'failed')
  );
}

// ─── 文件实现（load 缓存 + 原子写 + 损坏备份 + 只读降级） ───

export interface FileTeamAssetStoreOptions {
  /** 存储文件；缺省 defaultTeamAssetsPath()（测试必须显式注入临时文件）。 */
  filePath?: string;
  /** 损坏文件备份的文件移动（测试注入用；缺省 fs.renameSync）。 */
  moveFileSync?: (from: string, to: string) => void;
}

export class FileTeamAssetStore implements TeamAssetStore {
  readonly filePath: string;
  private cache: TeamAssetEntry[] | null = null;
  /** 损坏且备份失败 → 拒写（绝不用新数据覆盖仍含旧资产的损坏文件）。 */
  private readOnly = false;
  private readonly moveFileSync: (from: string, to: string) => void;

  constructor(options: FileTeamAssetStoreOptions = {}) {
    this.filePath = options.filePath ?? defaultTeamAssetsPath();
    this.moveFileSync = options.moveFileSync ?? fs.renameSync;
  }

  load(): readonly TeamAssetEntry[] {
    if (this.cache) return this.cache;
    let content: string;
    try {
      content = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      // 首次运行/文件不存在：无声初始态（不是错误）
      this.cache = [];
      return this.cache;
    }
    try {
      const parsed = JSON.parse(content) as Partial<TeamAssetFileShape>;
      this.cache = Array.isArray(parsed.entries) ? parsed.entries.filter(isValidEntry) : [];
    } catch (err) {
      // 损坏：先备份再重建（绝不静默丢弃历史资产）；备份失败 → 只读拒写
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        this.moveFileSync(this.filePath, backup);
        log.warn(`资产库文件损坏,已备份至 ${backup}(按空库重建): ${err instanceof Error ? err.message : String(err)}`);
        this.cache = [];
      } catch (backupErr) {
        this.readOnly = true;
        log.warn(`资产库文件损坏且备份失败,转只读拒写(保旧文件): ${backupErr instanceof Error ? backupErr.message : String(backupErr)}`);
        this.cache = [];
      }
    }
    return this.cache;
  }

  append(entry: TeamAssetEntry): AssetAppendResult {
    if (this.readOnly) return { appended: false, reason: 'file_corrupt' };
    const entries = this.load();
    if (entries.some((e) => e.decisionId === entry.decisionId)) {
      return { appended: false, reason: 'duplicate' };
    }
    const next = [...entries, entry];
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      const payload: TeamAssetFileShape = { version: 1, entries: next };
      fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      // 写失败：内存缓存保持旧态（与磁盘一致），调用方按 fail-open 继续
      log.warn(`资产库写入失败(${this.filePath}): ${err instanceof Error ? err.message : String(err)}`);
      return { appended: false, reason: 'write_failed' };
    }
    this.cache = next;
    return { appended: true };
  }

  list(): readonly TeamAssetEntry[] {
    return [...this.load()];
  }

  has(decisionId: string): boolean {
    return this.load().some((e) => e.decisionId === decisionId);
  }
}

// ─── 进程单例（生产共用；测试一律显式注入临时文件/fake） ───

let defaultStore: TeamAssetStore | null = null;

export function getTeamAssetStore(): TeamAssetStore {
  return (defaultStore ??= new FileTeamAssetStore());
}

/** 测试专用：注入 fake / 临时文件 store；传 null 复位。 */
export function setTeamAssetStoreForTests(store: TeamAssetStore | null): void {
  defaultStore = store;
}

/** 测试专用：丢弃进程内单例。 */
export function resetTeamAssetStoreForTests(): void {
  defaultStore = null;
}
