/**
 * 语音伙伴服务 — 默认配置/上限常量/路径(2026-10-11 自 voice-companion-service.ts 拆分,行为不变)。
 */
import path from 'path';
import os from 'os';
import { DEFAULT_PERSONA_ID } from '../../../shared/voice-personas.js';
import type { CompanionMemory, VoiceCompanionState, VoiceCompanionServerConfig } from './types.js';

export const DEFAULT_SERVER_CONFIG: VoiceCompanionServerConfig = {
  model: 'haiku',
  persona: { preset: DEFAULT_PERSONA_ID, custom: '' },
  hop1TimeoutMs: 60_000,
  hop2TimeoutMs: 45_000,
  maxTurns: 120,
  sessionMaxAgeDays: 7,
  maxNotes: 40,
  // 任务39 改判:原 0.8 是行业推导(非实测)。任务39 实测(06-10 §1e):同一句话
  // 新会话 3.6s vs 长会话 74.4s(thinking ~140× 退化,主因=会话历史;in≈82K、cacheR≈0,
  // 中继无 prompt 缓存 → 每回合成本 ∝ 会话长度)。55.8%(111K/200K)已达显著退化区,
  // 等 80% 永远等不到(轮换块先于阈值触发前会话早已拖垮)。故提前到 0.3(=60K@200K)。
  // 窗口 200K 为 claude sonnet/haiku 当代缺省,运行时以 CLI 上报为准。
  contextCompactPercent: 0.3,
  contextWindowTokens: 200_000,
  // 任务39:绝对值闸口(与 percent 取或)。缺省 0 = 关;窗口被 CLI 上报为更大值
  // (e.g. 1M)时,percent 阈值不够用,可用它钉死绝对开销上界。
  contextCompactTokens: 0,
  // W2 阶段2:默认关(首句短化先走提示词版;机械上限开启值建议 24,观察切碎风险)。
  firstSentenceMaxChars: 0,
  // W5/C13 兜底档:生成跳过 MCP 加载(冷启动 4.9→2.2s),吐出 ≈3.0–3.5s。
  // W7/C15 预生成档(命中):说话期间已生成 + 客户端预合成,吐出 = 回合开始 + pregenEmitMs
  // (只等 TTS 合成这一个尾巴)。
  // C16:pregenEmitMs 缺省 3000 = 兜底档的吐出底线 —— 预生成只消掉「到点后还要等生成/合成」
  // 那一段(真麦实测兜底档 3.5–6s),不改变触发阈值(1.2s 版实测「简单问题也垫话」);
  // 调小 = 更早出声但会垫给快回合,调大 = 更稀疏。
  // 未命中/失败/禁用 → 全链回退兜底档(逐字节等同旧行为)。
  // 首字节取消信号仍挂着,快回合(hop1 先出字)照样不垫。无出字的慢回合才轮得到垫话。
  slowFiller: { enabled: true, armMs: 500, emitMs: 2_500, pregenEmitMs: 3_000 },
};

export const DEFAULT_MEMORY: CompanionMemory = {
  summary: '',
  notes: [],
  updatedAt: 0,
  droppedCount: 0,
  handoff: null,
};

export const DEFAULT_STATE: VoiceCompanionState = {
  sessionId: null,
  sessionStartedAt: null,
  turns: 0,
  lastUsedAt: null,
  personaKey: null,
  memory: DEFAULT_MEMORY,
  context: null,
  recentTurns: [],
};

/** Agent 状态里算「正在干活」(打断有代价)的三种。 */
export const ACTIVE_AGENT_STATUSES = new Set(['working', 'waiting', 'waiting_permission']);

export const NOTES_MAX_TEXT = 300;
export const SUMMARY_MAX_TEXT = 1500;
export const MAX_SNAPSHOT_AGENTS = 60;
export const TASK_TRUNCATE = 60;
export const ERROR_TRUNCATE = 80;
/** 🔴 决策观测点④ 查询链路:请求/返回摘要的截断长度(Spec §4.14「返回摘要(截断)」)。 */
export const QUERY_LOG_PREVIEW_CHARS = 120;
/** 注入 prompt 的委派史条数上限:§8.1 已验证常量,镜像 subordinate-context-service.ts:135 的 slice(0,5),不改值。 */
export const MAX_DELEGATION_INJECT = 5;
/** Boss 卡片最多展开的下属个数,超出只报「…另N人」——防单行随团队规模失控(60 快照上限之外的体积护栏)。 */
export const MAX_SNAPSHOT_SUBORDINATES = 8;
export const HISTORY_MESSAGES = 30;
export const HISTORY_EXCERPT_COUNT = 6;
export const HISTORY_ITEM_CHARS = 400;
export const HISTORY_TOTAL_CHARS = 1500;
/** 记忆注入体积告警阈值(P9):笔记上限 40×300 + 总结 1500,超此值先看记忆该不该清。 */
export const MEMORY_WARN_CHARS = 4_000;

// XDG-compliant(与 data/index.ts 惯例一致):测试沙箱靠 XDG_DATA_HOME 重定向,
// 避免测试进程误写真实状态文件。未设 XDG 的机器解析结果与旧路径完全相同。
export const STATE_FILE = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  'tide-commander',
  'voice-companion.json',
);
export const CONFIG_FILE = path.join(process.cwd(), 'tools/voice-companion/config.json');

// 故障分型(HC-B9):上游故障(超时/解析失败/进程退出/报错)不播「没听清」——
// 「没听清」族保留给输入语义问题(见 contract 缺 messageToAgent 分支),避免用户误以为是自己没说清。
export const DEGRADED_RESPONSE = '抱歉,我这会儿有点问题,稍等再说。';
