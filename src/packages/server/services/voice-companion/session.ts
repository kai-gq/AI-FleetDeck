/**
 * 语音伙伴服务 — 会话轮换与上下文压缩判定(2026-10-11 自 voice-companion-service.ts 拆分,行为不变)。
 * 纯函数;轮换 = 清 sessionId 保留记忆,压缩门槛=百分比与绝对 token 取或。
 */
import type { CompanionContextUsage } from '../../voice/companion-runner.js';
import type { VoiceCompanionContextState, VoiceCompanionServerConfig, VoiceCompanionState } from './types.js';

/** 会话轮换判定:轮数上限或存活天数上限。轮换 = 清 sessionId,保留记忆。 */
export function shouldRotateSession(
  state: VoiceCompanionState,
  cfg: VoiceCompanionServerConfig,
  now: number = Date.now(),
): boolean {
  if (state.sessionId) {
    if (state.turns >= cfg.maxTurns) return true;
    if (state.sessionStartedAt != null && now - state.sessionStartedAt > cfg.sessionMaxAgeDays * 86_400_000) return true;
  }
  return false;
}

/**
 * 人设变化判定:--resume 的历史会盖过新系统提示词,不换会话换人设就不生效。
 * personaKey 缺失(旧状态/首次)也算变化 → 一次性轮换到当前人设;记忆不受影响。
 */
export function shouldRotateForPersona(state: VoiceCompanionState, personaKey: string): boolean {
  return state.personaKey !== personaKey;
}

/**
 * 任务18·压缩 v1:由 result usage 计算上下文占用快照(纯函数)。
 * 输入侧 = input + cache_read + cache_creation(近似当前 prompt 总长);无用量 → null。
 */
export function computeContextState(
  usage: CompanionContextUsage,
  cfg: VoiceCompanionServerConfig,
  now: number = Date.now(),
): VoiceCompanionContextState | null {
  const tokensUsed = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
  if (tokensUsed <= 0) return null;
  const windowTokens = usage.contextWindow ?? cfg.contextWindowTokens;
  if (!(windowTokens > 0)) return null;
  return { tokensUsed, windowTokens, percent: tokensUsed / windowTokens, updatedAt: now };
}

/**
 * 任务18·压缩 v1:到阈值即应摘要续跑——走既有 summarizeSession + 轮换路径
 * (轮换块里 reason='context-compact'),不做 /compact、不发 stdin control_request。
 * 任务39:百分比(缺省 0.3 = 60K@200K)+ 可选绝对 token 闸口,两者取或;
 * contextCompactTokens=0(缺省)时与旧判定逐字节等价(仅阈值不同)。
 */
export function isContextCompactionDue(state: VoiceCompanionState, cfg: VoiceCompanionServerConfig): boolean {
  if (!state.sessionId || !state.context) return false;
  if (state.context.percent >= cfg.contextCompactPercent) return true;
  return cfg.contextCompactTokens > 0 && state.context.tokensUsed >= cfg.contextCompactTokens;
}
