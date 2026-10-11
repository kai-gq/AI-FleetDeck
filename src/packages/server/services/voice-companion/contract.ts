/**
 * 语音伙伴服务 — 契约解析与记忆操作(2026-10-11 自 voice-companion-service.ts 拆分,行为不变)。
 * 纯函数:代码围栏剥离 / JSON 契约解析 / memoryOps 应用与未命中告警;落盘 IO 不在此模块。
 */
import { logger } from '../../utils/index.js';
import type { MemoryOpDetail } from '../activity-log.js';
import {
  COMPANION_ACTIONS,
  type CompanionAction,
  type CompanionMemory,
  type CompanionMemoryNote,
  type VoiceContract,
  type VoiceMemoryOp,
} from './types.js';
import { NOTES_MAX_TEXT, SUMMARY_MAX_TEXT } from './constants.js';

const log = logger.server;

export function stripCodeFences(s: string): string {
  let out = s.trim();
  if (out.startsWith('```json')) out = out.slice(7);
  else if (out.startsWith('```')) out = out.slice(3);
  if (out.endsWith('```')) out = out.slice(0, -3);
  return out.trim();
}

export function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 容忍模型输出前后夹带的解释文字:截取第一个 { 到最后一个 } 再解析。 */
export function parseContractJson(raw: string): VoiceContract {
  const stripped = stripCodeFences(raw);
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON object in response');
  const obj = JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;

  const action = COMPANION_ACTIONS.includes(obj.action as CompanionAction)
    ? (obj.action as CompanionAction)
    : 'general_response';

  const contract: VoiceContract = {
    action,
    targetAgentId: typeof obj.targetAgentId === 'string' && obj.targetAgentId.trim() ? obj.targetAgentId.trim() : null,
    targetAgentName: typeof obj.targetAgentName === 'string' && obj.targetAgentName.trim() ? obj.targetAgentName.trim() : null,
    messageToAgent: typeof obj.messageToAgent === 'string' ? obj.messageToAgent.trim() : '',
    delivery: obj.delivery === 'interrupt' ? 'interrupt' : 'queue',
    query: typeof obj.query === 'string' ? obj.query.trim() : '',
    bolbaTask: typeof obj.bolbaTask === 'string' ? truncate(obj.bolbaTask, 200) : '',
    responseToUser: typeof obj.responseToUser === 'string' ? obj.responseToUser.trim() : '',
    memoryOps: [],
  };

  if (Array.isArray(obj.memoryOps)) {
    for (const op of obj.memoryOps) {
      if (!op || typeof op !== 'object') continue;
      const o = op as Record<string, unknown>;
      if (o.op === 'add' && typeof o.text === 'string') {
        contract.memoryOps.push({ op: 'add', text: o.text });
      } else if (o.op === 'remove' && typeof o.id === 'string') {
        contract.memoryOps.push({ op: 'remove', id: o.id });
      } else if (o.op === 'setSummary' && typeof o.summary === 'string') {
        contract.memoryOps.push({ op: 'setSummary', summary: o.summary });
      }
    }
  }
  return contract;
}

function newNoteId(now: number): string {
  return `m${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** A13/H6-1:remove 文本兜底匹配用的归一化(trim + 折叠连续空白 + 小写)。 */
function normalizeMemoryMatchText(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A13/H6-1:remove.id 未命中时把它当文本再匹配 notes——先归一化精确相等,
 * 再双向包含(笔记文本含该串,或该串含笔记文本);**仅唯一命中**才返回,
 * 0 命中返回 null、多命中置 ambiguous(宁缺毋滥,防误删)。
 * 极短串(<2 字符)只做精确匹配,不做包含。
 */
function matchNoteByText(
  notes: readonly CompanionMemoryNote[],
  query: string,
): { note: CompanionMemoryNote | null; ambiguous: boolean } {
  const q = normalizeMemoryMatchText(query);
  if (q.length === 0) return { note: null, ambiguous: false };
  const exact = notes.filter((n) => normalizeMemoryMatchText(n.text) === q);
  if (exact.length === 1) return { note: exact[0], ambiguous: false };
  if (exact.length > 1) return { note: null, ambiguous: true };
  if (q.length < 2) return { note: null, ambiguous: false };
  const loose = notes.filter((n) => {
    const t = normalizeMemoryMatchText(n.text);
    return t.length > 0 && (t.includes(q) || q.includes(t));
  });
  if (loose.length === 1) return { note: loose[0], ambiguous: false };
  return { note: null, ambiguous: loose.length > 1 };
}

/**
 * 应用模型给出的 memoryOps:add 去重、上限裁剪(先裁最旧的 auto 条目);
 * remove 按 id(未命中再按文本兜底);setSummary 覆盖总结。返回新 memory 与生效条数。
 * (任务 02 扩展:details 逐条记录每个 op 是否生效及 add 触发的 droppedCount,
 *  供 logMemoryOps 落盘;调用方解构 {memory, applied} 的现用法不受影响。
 *  A13/H6-1 扩展:remove 明细带 id/matchedBy/reason,未命中的告警在调用点打。)
 */
export function applyMemoryOps(
  memory: CompanionMemory,
  ops: VoiceMemoryOp[] | undefined,
  maxNotes: number,
  now: number = Date.now(),
): { memory: CompanionMemory; applied: number; details: MemoryOpDetail[] } {
  const details: MemoryOpDetail[] = [];
  if (!ops || ops.length === 0) return { memory, applied: 0, details };

  const next: CompanionMemory = {
    summary: memory.summary,
    notes: [...memory.notes],
    updatedAt: now,
    droppedCount: memory.droppedCount,
    // 任务39·F4:交接便签随记忆透传(缺省不带键,旧用例逐字不变)——
    // 否则任何一次 memoryOp 都会把便签悄悄洗掉。
    ...(memory.handoff ? { handoff: memory.handoff } : {}),
  };
  let applied = 0;

  for (const op of ops) {
    if (op.op === 'add' && typeof op.text === 'string') {
      const text = op.text.replace(/\s+/g, ' ').trim().slice(0, NOTES_MAX_TEXT);
      if (text.length < 2) {
        details.push({ op: 'add', applied: false });
        continue;
      }
      const dup = next.notes.some((n) => n.text.toLowerCase() === text.toLowerCase());
      if (dup) {
        details.push({ op: 'add', applied: false });
        continue;
      }
      const droppedBefore = next.droppedCount;
      while (next.notes.length >= maxNotes) {
        const autoIdx = next.notes.findIndex((n) => n.source === 'auto');
        next.notes.splice(autoIdx === -1 ? 0 : autoIdx, 1);
        next.droppedCount++;
      }
      next.notes.push({ id: newNoteId(now), text, createdAt: now, source: 'user' });
      applied++;
      details.push({ op: 'add', applied: true, droppedCount: next.droppedCount - droppedBefore });
    } else if (op.op === 'remove' && typeof op.id === 'string') {
      // 原路径:按 id 精确删(行为与旧版逐字一致);id 精确命中时绝不触发文本匹配。
      let target = next.notes.find((n) => n.id === op.id) ?? null;
      let matchedBy: 'id' | 'text' | undefined = target ? 'id' : undefined;
      let reason: 'empty_id' | 'not_found' | 'ambiguous' | undefined;
      const raw = op.id.trim();
      if (!target) {
        if (raw.length === 0) {
          // 空串/纯空白 id 不触发兜底
          reason = 'empty_id';
        } else {
          // A13/H6-1 兜底:模型可能把笔记文本(甚至整行「- [id] 文本」)填进 remove.id,
          // 旧实现查无即静默不删、模型却已回话「撤了」→ 假成功。
          // 整行时先试 [] 里的原 id,再拿 [] 后的剩余文本兜底。
          let fallbackText = raw;
          const line = /^[-*•]?\s*\[([^\]]*)\]\s*([\s\S]*)$/.exec(raw);
          if (line) {
            const bracketId = line[1].trim();
            const byBracketId = bracketId ? next.notes.find((n) => n.id === bracketId) ?? null : null;
            if (byBracketId) {
              target = byBracketId;
              matchedBy = 'id';
            } else {
              fallbackText = line[2].trim();
            }
          }
          if (!target && fallbackText.length > 0) {
            const hit = matchNoteByText(next.notes, fallbackText);
            if (hit.note) {
              target = hit.note;
              matchedBy = 'text';
            } else {
              reason = hit.ambiguous ? 'ambiguous' : 'not_found';
            }
          } else if (!target) {
            reason = 'not_found';
          }
        }
      }
      if (target) {
        const hitId = target.id;
        next.notes = next.notes.filter((n) => n.id !== hitId);
        applied++;
        details.push({ op: 'remove', applied: true, id: op.id, matchedBy });
      } else {
        details.push({ op: 'remove', applied: false, id: op.id, reason: reason ?? 'not_found' });
      }
    } else if (op.op === 'setSummary' && typeof op.summary === 'string') {
      const summary = op.summary.trim().slice(0, SUMMARY_MAX_TEXT);
      const changed = summary !== next.summary;
      if (changed) {
        next.summary = summary;
        applied++;
      }
      details.push({ op: 'setSummary', applied: changed });
    }
  }

  if (applied === 0) return { memory, applied: 0, details };
  return { memory: next, applied, details };
}

/**
 * A13/H6-1:remove 未命中任何 note 时在调用点如实告警——applyMemoryOps 是纯函数不能打日志。
 * details 里带了 id/reason,日志可直接复盘(模型把笔记文本当 id 是本次事故形态)。
 */
export function warnUnappliedMemoryRemoves(details: MemoryOpDetail[], channel: 'voice' | 'settings'): void {
  for (const d of details) {
    if (d.op === 'remove' && !d.applied) {
      log.warn(`[VoiceCompanion] 记忆删除未命中 id=${d.id || '(空)'} reason=${d.reason ?? 'not_found'} channel=${channel}`);
    }
  }
}
