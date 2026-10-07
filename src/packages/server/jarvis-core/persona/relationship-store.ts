/**
 * jarvis-core/persona · 关系模型存储（任务 32 验收②「每次演化留 diff 可回滚」）
 *
 * 文件形态 { version:1, modelVersion, model, history[] }：
 *   - modelVersion：初始 0；每次 applyEvolution / rollbackTo 产生新版本（回滚
 *     也占新版本，历史 append-only、不重写过去）；
 *   - history：逐次演化记录（逐字段 diff + after 快照）——可审计、可回滚；
 *   - 原子写（tmp + rename）；损坏容错 = 初始态 + warn（样板 reflection/run-state.ts）。
 *
 * applyEvolution 门控（类型即纪律：批准必须显式写在调用处）：
 *   - verdict reject / record-only / flagged → 一律拒绝（记录期与「大改不应用」
 *     是硬规则，不给绕过的口子；flagged 需人工拆分/复核后重新提案）；
 *   - 仅 verdict='review' 且显式传 approval:'tier2-approved' 才可应用。
 *
 * rollbackTo(targetVersion)：以目标版本的 after 快照重建模型，反向 diff 记档；
 * 回滚不需要审批（留痕即可）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { jarvisLogger, type JarvisLogger } from '../executors.js';
import { defaultRelationshipPath } from './paths.js';
import type {
  GovernanceDecision,
  PersonaObserver,
  RelationshipEvolutionProposal,
  RelationshipEvolutionRecord,
  RelationshipModel,
  RelationshipValue,
} from './types.js';

interface RelationshipFileShape {
  version: 1;
  modelVersion: number;
  model: RelationshipModel;
  history: RelationshipEvolutionRecord[];
}

export interface FileRelationshipStoreOptions {
  /** 存储文件；缺省 defaultRelationshipPath()（测试必须显式注入临时文件）。 */
  filePath?: string;
  logger?: JarvisLogger;
  /** 观测事件回调（⑦；缺省无）。回调异常静默隔离。 */
  observer?: PersonaObserver;
}

export interface ApplyEvolutionResult {
  applied: boolean;
  reason?: string;
  /** 应用/回滚后的新版本号（applied=true）。 */
  version?: number;
  /** 本次实际写入的逐字段 diff。 */
  diff?: Array<{ field: string; from: RelationshipValue; to: RelationshipValue }>;
  /** diff 字符总量（⑦ 观测）。 */
  diffChars?: number;
}

const INITIAL_FILE: RelationshipFileShape = { version: 1, modelVersion: 0, model: {}, history: [] };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function charLen(value: RelationshipValue): number {
  return value === undefined ? 0 : String(value).length;
}

function diffCharsOf(diff: Array<{ from: RelationshipValue; to: RelationshipValue }>): number {
  return diff.reduce((sum, d) => sum + charLen(d.from) + charLen(d.to), 0);
}

export class FileRelationshipStore {
  readonly filePath: string;
  private readonly logger: JarvisLogger;
  private readonly observer?: PersonaObserver;
  private cache: RelationshipFileShape | null = null;

  constructor(options: FileRelationshipStoreOptions = {}) {
    this.filePath = options.filePath ?? defaultRelationshipPath();
    this.logger = options.logger ?? jarvisLogger;
    this.observer = options.observer;
  }

  load(): RelationshipFileShape {
    if (this.cache) return this.cache;
    let content: string;
    try {
      content = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      this.cache = clone(INITIAL_FILE);
      return this.cache;
    }
    try {
      const parsed = JSON.parse(content) as Partial<RelationshipFileShape>;
      const modelVersion =
        typeof parsed.modelVersion === 'number' && parsed.modelVersion >= 0 ? Math.trunc(parsed.modelVersion) : 0;
      const model = parsed.model && typeof parsed.model === 'object' ? (parsed.model as RelationshipModel) : {};
      const history = Array.isArray(parsed.history)
        ? parsed.history.filter(
            (r): r is RelationshipEvolutionRecord =>
              !!r && typeof (r as RelationshipEvolutionRecord).version === 'number',
          )
        : [];
      this.cache = { version: 1, modelVersion, model, history };
    } catch (error) {
      this.logger.warn(`[Persona] 关系模型文件损坏（按初始态处理）: ${this.filePath}`, error);
      this.cache = clone(INITIAL_FILE);
    }
    return this.cache;
  }

  /** 当前模型（深拷贝，调用方改不动内部态）。 */
  getModel(): { modelVersion: number; model: RelationshipModel } {
    const file = this.load();
    return { modelVersion: file.modelVersion, model: clone(file.model) };
  }

  /** 演化历史（深拷贝）。 */
  getHistory(): RelationshipEvolutionRecord[] {
    return clone(this.load().history);
  }

  private emit(event: Parameters<PersonaObserver>[0]): void {
    if (!this.observer) return;
    try {
      this.observer(event);
    } catch {
      // 观测失败不打断存储
    }
  }

  private persist(file: RelationshipFileShape): void {
    this.cache = file;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      // 写失败不阻断主链路；降级 = 下次重启后回落（模型改动仅存内存）
      this.logger.warn(`[Persona] 关系模型写入失败（降级，本次改动仅存内存）: ${this.filePath}`, error);
    }
  }

  /**
   * 应用一次经治理通过、人工批准的演化。
   * 仅 verdict='review' + approval:'tier2-approved' 可应用；其余一律拒绝。
   */
  applyEvolution(
    proposal: RelationshipEvolutionProposal,
    decision: GovernanceDecision,
    opts: { approval?: 'tier2-approved'; at?: number } = {},
  ): ApplyEvolutionResult {
    const at = opts.at ?? Date.now();
    const refuse = (reason: string): ApplyEvolutionResult => {
      this.emit({ op: 'evolution-applied', at, proposalId: proposal.id, verdict: decision.verdict, applied: false, reason });
      return { applied: false, reason };
    };

    if (decision.verdict === 'reject') return refuse('治理拒收的提案不可应用');
    if (decision.verdict === 'record-only') return refuse('记录期内不生效（只记成长日志，前 20 次会话零变更）');
    if (decision.verdict === 'flagged') return refuse('大改（重叠 <50%）标记不应用：需人工拆分/复核后重新提案');
    if (opts.approval !== 'tier2-approved') return refuse('缺少 Tier2 人工审查批准（approval）');

    const file = this.load();
    const model: RelationshipModel = clone(file.model);
    const diff: Array<{ field: string; from: RelationshipValue; to: RelationshipValue }> = [];
    for (const change of proposal.changes) {
      const field = change.field as keyof RelationshipModel;
      const from = file.model[field];
      if (change.to === undefined) {
        delete model[field];
      } else {
        (model as Record<string, RelationshipValue>)[field] = change.to;
      }
      diff.push({ field: change.field, from, to: change.to });
    }

    const version = file.modelVersion + 1;
    const record: RelationshipEvolutionRecord = {
      version,
      at,
      proposalId: proposal.id,
      appliedBy: 'tier2-approved',
      evidence: [...proposal.evidence],
      diff,
      after: clone(model),
    };
    this.persist({
      version: 1,
      modelVersion: version,
      model,
      history: [...file.history, record],
    });

    // ⑦ 观测：演化次数 / diff 大小（→ ⑭）
    this.emit({
      op: 'evolution-applied',
      at,
      proposalId: proposal.id,
      verdict: decision.verdict,
      version,
      diffChars: diffCharsOf(diff),
      applied: true,
    });
    return { applied: true, version, diff, diffChars: diffCharsOf(diff) };
  }

  /**
   * 回滚到历史版本（0 = 初始空模型）。产生新版本 + 反向 diff 记录；不重写历史。
   * 不需要审批（回滚本身留痕）。
   */
  rollbackTo(targetVersion: number, opts: { at?: number; reason?: string } = {}): ApplyEvolutionResult {
    const at = opts.at ?? Date.now();
    const file = this.load();
    const refuse = (reason: string): ApplyEvolutionResult => {
      this.emit({ op: 'rollback', at, applied: false, rollbackTo: targetVersion, reason });
      return { applied: false, reason };
    };

    if (!Number.isInteger(targetVersion) || targetVersion < 0) return refuse(`非法版本号 ${targetVersion}`);
    if (targetVersion >= file.modelVersion) {
      return refuse(`版本 ${targetVersion} 尚未产生（当前 modelVersion=${file.modelVersion}）`);
    }
    const targetModel = targetVersion === 0
      ? {}
      : file.history.find((r) => r.version === targetVersion)?.after;
    if (!targetModel) return refuse(`找不到版本 ${targetVersion} 的快照`);

    // 反向 diff（当前 → 目标）
    const fields = new Set<string>([...Object.keys(file.model), ...Object.keys(targetModel)]);
    const diff: Array<{ field: string; from: RelationshipValue; to: RelationshipValue }> = [];
    for (const field of fields) {
      const from = (file.model as Record<string, RelationshipValue>)[field];
      const to = (targetModel as Record<string, RelationshipValue>)[field];
      if (from !== to) diff.push({ field, from, to });
    }

    const version = file.modelVersion + 1;
    const record: RelationshipEvolutionRecord = {
      version,
      at,
      proposalId: `rollback-to-${targetVersion}`,
      appliedBy: 'rollback',
      evidence: opts.reason ? [opts.reason] : [],
      diff,
      rollbackTo: targetVersion,
      after: clone(targetModel),
    };
    this.persist({
      version: 1,
      modelVersion: version,
      model: clone(targetModel),
      history: [...file.history, record],
    });

    this.emit({ op: 'rollback', at, version, rollbackTo: targetVersion, diffChars: diffCharsOf(diff), applied: true });
    return { applied: true, version, diff, diffChars: diffCharsOf(diff) };
  }
}
