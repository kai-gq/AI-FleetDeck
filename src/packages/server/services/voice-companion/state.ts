/**
 * 语音伙伴服务 — 会话/记忆状态落盘与容错(2026-10-11 自 voice-companion-service.ts 拆分,行为不变)。
 * 状态文件 ~/.local/share/tide-commander/voice-companion.json(tmp + rename);旧字段一律容错。
 */
import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/index.js';
import { HANDOFF_TEXT_MAX_CHARS, sanitizeRecentTurns } from '../../voice/handoff.js';
import { DEFAULT_MEMORY, DEFAULT_STATE, NOTES_MAX_TEXT, STATE_FILE, SUMMARY_MAX_TEXT } from './constants.js';
import type { CompanionMemory, VoiceCompanionContextState, VoiceCompanionState } from './types.js';

const log = logger.server;

function sanitizeMemory(raw: unknown): CompanionMemory {
  const memory: CompanionMemory = { ...DEFAULT_MEMORY, notes: [] };
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.summary === 'string') memory.summary = obj.summary.slice(0, SUMMARY_MAX_TEXT);
    if (Array.isArray(obj.notes)) {
      for (const n of obj.notes) {
        if (!n || typeof n !== 'object') continue;
        const note = n as Record<string, unknown>;
        if (typeof note.id !== 'string' || typeof note.text !== 'string' || !note.text.trim()) continue;
        memory.notes.push({
          id: note.id,
          text: note.text.slice(0, NOTES_MAX_TEXT),
          createdAt: typeof note.createdAt === 'number' ? note.createdAt : 0,
          source: note.source === 'auto' ? 'auto' : 'user',
        });
      }
    }
    if (typeof obj.updatedAt === 'number') memory.updatedAt = obj.updatedAt;
    if (typeof obj.droppedCount === 'number') memory.droppedCount = obj.droppedCount;
    // 任务39·F4:交接便签容错(坏类型/空文本 → null;文本再防御性截断到 300 字)。
    if (obj.handoff && typeof obj.handoff === 'object') {
      const h = obj.handoff as Record<string, unknown>;
      const text = typeof h.text === 'string' ? h.text.trim().slice(0, HANDOFF_TEXT_MAX_CHARS) : '';
      if (text && typeof h.forSessionId === 'string' && typeof h.at === 'number' && Number.isFinite(h.at)) {
        memory.handoff = { text, forSessionId: h.forSessionId, at: h.at };
      }
    }
  }
  return memory;
}

/** 任务18:旧状态文件无 context 字段 → null;非法值一律丢弃。 */
function sanitizeContextState(raw: unknown): VoiceCompanionContextState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<VoiceCompanionContextState>;
  if (typeof r.tokensUsed !== 'number' || !Number.isFinite(r.tokensUsed)) return null;
  if (typeof r.windowTokens !== 'number' || !(r.windowTokens > 0)) return null;
  if (typeof r.percent !== 'number' || !Number.isFinite(r.percent)) return null;
  return {
    tokensUsed: r.tokensUsed,
    windowTokens: r.windowTokens,
    percent: r.percent,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
  };
}

export function loadCompanionState(): VoiceCompanionState {
  try {
    if (!fs.existsSync(STATE_FILE)) return { ...structuredClone(DEFAULT_STATE) };
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    const state: VoiceCompanionState = {
      sessionId: typeof raw?.sessionId === 'string' ? raw.sessionId : null,
      sessionStartedAt: typeof raw?.sessionStartedAt === 'number' ? raw.sessionStartedAt : null,
      turns: typeof raw?.turns === 'number' ? raw.turns : 0,
      lastUsedAt: typeof raw?.lastUsedAt === 'number' ? raw.lastUsedAt : null,
      personaKey: typeof raw?.personaKey === 'string' ? raw.personaKey : null,
      memory: sanitizeMemory(raw?.memory),
      context: sanitizeContextState(raw?.context),
      // 任务39·F2:环缓冲逐条容错;旧状态文件缺字段 → []。
      recentTurns: sanitizeRecentTurns(raw?.recentTurns),
    };
    return state;
  } catch (err) {
    log.error(`[VoiceCompanion] 状态文件读取失败:`, err);
    return { ...structuredClone(DEFAULT_STATE) };
  }
}

export function saveCompanionState(state: VoiceCompanionState): void {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    log.error(`[VoiceCompanion] 状态文件写入失败:`, err);
  }
}
