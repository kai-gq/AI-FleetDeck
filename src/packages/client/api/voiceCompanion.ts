/**
 * 「语音伙伴」客户端 API
 *
 * 1. 配置读写:tools/voice-companion/config.json(服务端大脑与流式通道同读此文件)。
 *    沿用 whisperCloud 的通用文件 API 模式(/exists → /create(409=已存在)→ /write),
 *    服务端零改动;数值/枚举/数组全部 sanitize 夹取。
 * 2. 大脑接口封装:/api/voice-companion/{process,status,reset,memory}。
 * 3. 配置订阅:设置面板保存后,运行中的语音组件即时生效(模块级订阅)。
 */

import { apiUrl, authFetch, getApiBaseUrl, getAuthToken } from '../utils/storage';
import { readNdjsonLines } from '../voice/ndjsonReader';
import type { VadEngineMode } from '../voice/vad';
import { DEFAULT_PERSONA_ID, sanitizePersonaCustom, sanitizePersonaId } from '../../shared/voice-personas';

// ============================================================================
// 类型与默认值
// ============================================================================

export type SttMode = 'auto' | 'stream' | 'segment';
export type VolcengineEndpoint = 'bigmodel_async' | 'bigmodel' | 'bigmodel_nostream';

export interface VolcengineCredentials {
  apiKey: string;
  appId: string;
  accessToken: string;
  resourceId: string;
  endpoint: VolcengineEndpoint;
}

export interface ListeningConfig {
  /** 判停引擎:auto = 小模型可用则用、否则能量;model/energy = 强制。 */
  engine: VadEngineMode;
  /** 静音判停时长(ms)。 */
  silenceMs: number;
  /** 确认时长(ms):候选内有效人声累计达此值才开段;更短的声响直接忽略。 */
  confirmMs: number;
  /** 单段最长时长(ms),超过强制切段。 */
  maxSegmentMs: number;
  /** 固定起说阈值(0 = 纯自适应噪声底)。 */
  startThreshold: number;
  /** 播报中允许抢话打断。 */
  bargeIn: boolean;
  /** 唤醒词(空 = 不启用;非空时必须包含,否则丢弃)。 */
  wakeWord: string;
  /** 结束词(后缀命中则剥离并立即提交)。 */
  endWords: string[];
  /** 判停后自动提交到大脑;关闭则仅上屏。 */
  autoSubmit: boolean;
  /** 页面切到后台时暂停聆听。 */
  pauseWhenHidden: boolean;
}

export interface ProactiveConfig {
  enabled: boolean;
  intervalMinutes: number;
  scope: 'important' | 'all';
  /** 事件合并静默窗口(ms),避免连续播报轰炸。 */
  quietWindowMs: number;
}

export interface UiConfig {
  showTranscript: boolean;
  bubbleTimeoutMs: number;
}

/** 服务端大脑的高级参数(config.json 的 brain 节;默认值与服务端一致)。 */
export interface BrainConfig {
  /** 第一跳(claude)超时 ms。 */
  hop1TimeoutMs: number;
  /** 两跳查询第二跳超时 ms。 */
  hop2TimeoutMs: number;
  /** 会话最大轮数,超出轮换新会话(记忆保留)。 */
  maxTurns: number;
  /** 会话闲置多少天后轮换。 */
  sessionMaxAgeDays: number;
  /** 记忆条数上限(溢出裁最旧)。 */
  maxNotes: number;
  /** W2 阶段2:首句机械上限(>0 生效;0 = 关,缺省)。建议开启值 24。 */
  firstSentenceMaxChars: number;
  /** W5 慢档续垫:等待超过阈值仍无声时,动态生成一句安抚垫话(≤10 字,pre 通道)。 */
  slowFiller: {
    enabled: boolean;
    /** 开始预生成的时间点(ms,自回合开始)。 */
    armMs: number;
    /** 允许吐出的最早时间点(ms,自回合开始)。 */
    emitMs: number;
  };
}

/** 人设:预设 id(见 shared/voice-personas)或 'custom'+自定义文本。 */
export interface VoicePersonaConfig {
  preset: string;
  custom: string;
}

export interface VoiceCompanionConfig {
  enabled: boolean;
  model: 'haiku' | 'sonnet';
  persona: VoicePersonaConfig;
  stt: {
    mode: SttMode;
    volcengine: VolcengineCredentials;
  };
  listening: ListeningConfig;
  proactive: ProactiveConfig;
  ui: UiConfig;
  brain: BrainConfig;
}

export const DEFAULT_VOICE_COMPANION_CONFIG: VoiceCompanionConfig = {
  enabled: false,
  model: 'haiku',
  persona: {
    preset: DEFAULT_PERSONA_ID,
    custom: '',
  },
  stt: {
    mode: 'auto',
    volcengine: {
      apiKey: '',
      appId: '',
      accessToken: '',
      resourceId: 'volc.bigasr.sauc.duration',
      endpoint: 'bigmodel_async',
    },
  },
  listening: {
    engine: 'auto',
    silenceMs: 800,
    confirmMs: 250,
    maxSegmentMs: 30_000,
    startThreshold: 0,
    bargeIn: true,
    wakeWord: '',
    endWords: ['发送', '完事了', '就这些'],
    autoSubmit: true,
    pauseWhenHidden: true,
  },
  proactive: {
    enabled: false,
    intervalMinutes: 30,
    scope: 'important',
    quietWindowMs: 45_000,
  },
  ui: {
    showTranscript: true,
    bubbleTimeoutMs: 6_000,
  },
  brain: {
    hop1TimeoutMs: 60_000,
    hop2TimeoutMs: 45_000,
    maxTurns: 120,
    sessionMaxAgeDays: 7,
    maxNotes: 40,
    firstSentenceMaxChars: 0,
    // 与服务端 DEFAULT_SERVER_CONFIG.slowFiller 保持一致(面板保存全量覆写,两侧别漂移)。
    // C13:垫话生成跳过 MCP(省 ~2.6s)+ 阈值下压 —— 吐出 ≈3.0–3.5s。
    slowFiller: { enabled: true, armMs: 500, emitMs: 2_500 },
  },
};

// ============================================================================
// 配置读写
// ============================================================================

const CONFIG_REL_PATH = 'tools/voice-companion/config.json';
const TOOL_DIR_REL_PATH = 'tools/voice-companion';

async function resolvePath(relativePath: string): Promise<{ exists: boolean; path: string }> {
  const res = await authFetch(apiUrl(`/api/files/exists?path=${encodeURIComponent(relativePath)}`));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.path !== 'string') {
    throw new Error(data.error || `路径解析失败(${res.status})`);
  }
  return { exists: !!data.exists, path: data.path };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

/** 小数域钳制(startThreshold 这类 0..1 的比值;不做取整)。 */
function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

/** 任意来源的 JSON → 合法配置(未知字段丢弃,数值夹取,枚举白名单)。 */
export function sanitizeVoiceCompanionConfig(raw: unknown): VoiceCompanionConfig {
  const cfg: VoiceCompanionConfig = {
    ...DEFAULT_VOICE_COMPANION_CONFIG,
    persona: { ...DEFAULT_VOICE_COMPANION_CONFIG.persona },
    stt: { ...DEFAULT_VOICE_COMPANION_CONFIG.stt, volcengine: { ...DEFAULT_VOICE_COMPANION_CONFIG.stt.volcengine } },
    listening: { ...DEFAULT_VOICE_COMPANION_CONFIG.listening, endWords: [...DEFAULT_VOICE_COMPANION_CONFIG.listening.endWords] },
    proactive: { ...DEFAULT_VOICE_COMPANION_CONFIG.proactive },
    ui: { ...DEFAULT_VOICE_COMPANION_CONFIG.ui },
    brain: {
      ...DEFAULT_VOICE_COMPANION_CONFIG.brain,
      slowFiller: { ...DEFAULT_VOICE_COMPANION_CONFIG.brain.slowFiller },
    },
  };
  if (!raw || typeof raw !== 'object') return cfg;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.enabled === 'boolean') cfg.enabled = obj.enabled;
  if (obj.model === 'sonnet' || obj.model === 'haiku') cfg.model = obj.model;

  const persona = obj.persona as Record<string, unknown> | undefined;
  if (persona && typeof persona === 'object') {
    cfg.persona.preset = sanitizePersonaId(persona.preset);
    cfg.persona.custom = sanitizePersonaCustom(persona.custom);
  }

  const stt = obj.stt as Record<string, unknown> | undefined;
  if (stt && typeof stt === 'object') {
    if (stt.mode === 'auto' || stt.mode === 'stream' || stt.mode === 'segment') cfg.stt.mode = stt.mode;
    const volc = stt.volcengine as Record<string, unknown> | undefined;
    if (volc && typeof volc === 'object') {
      cfg.stt.volcengine.apiKey = str(volc.apiKey);
      cfg.stt.volcengine.appId = str(volc.appId);
      cfg.stt.volcengine.accessToken = str(volc.accessToken);
      // 显式留空 = 不发送 X-Api-Resource-Id(平台预置模型);字段缺失才回默认
      cfg.stt.volcengine.resourceId = typeof volc.resourceId === 'string'
        ? volc.resourceId.trim()
        : DEFAULT_VOICE_COMPANION_CONFIG.stt.volcengine.resourceId;
      if (volc.endpoint === 'bigmodel_async' || volc.endpoint === 'bigmodel' || volc.endpoint === 'bigmodel_nostream') {
        cfg.stt.volcengine.endpoint = volc.endpoint;
      }
    }
  }

  const listening = obj.listening as Record<string, unknown> | undefined;
  if (listening && typeof listening === 'object') {
    cfg.listening.silenceMs = clampInt(listening.silenceMs, 200, 10_000, cfg.listening.silenceMs);
    if (listening.engine === 'auto' || listening.engine === 'model' || listening.engine === 'energy') {
      cfg.listening.engine = listening.engine;
    }
    // 确认时长:新字段优先;旧配置的 minSpeechMs(最短语音段)按 ×0.625 迁移(400→250),
    // 保留「嫌误触发、调大最短段」的意图;保存即写新形状(自动丢旧字段)。
    if (listening.confirmMs !== undefined) {
      cfg.listening.confirmMs = clampInt(listening.confirmMs, 100, 400, cfg.listening.confirmMs);
    } else if (listening.minSpeechMs !== undefined) {
      cfg.listening.confirmMs = clampInt(
        Math.round(Number(listening.minSpeechMs) * 0.625), 100, 400, cfg.listening.confirmMs,
      );
    }
    cfg.listening.maxSegmentMs = clampInt(listening.maxSegmentMs, 3_000, 120_000, cfg.listening.maxSegmentMs);
    // 比值域:允许 0.05 这类小数(原来用 clampInt 会被取整成 0/1)
    cfg.listening.startThreshold = clampFloat(listening.startThreshold, 0, 1, cfg.listening.startThreshold);
    if (typeof listening.bargeIn === 'boolean') cfg.listening.bargeIn = listening.bargeIn;
    cfg.listening.wakeWord = str(listening.wakeWord);
    if (Array.isArray(listening.endWords)) {
      cfg.listening.endWords = listening.endWords
        .filter((w): w is string => typeof w === 'string' && w.trim().length > 0)
        .map((w) => w.trim())
        .slice(0, 10);
    }
    if (typeof listening.autoSubmit === 'boolean') cfg.listening.autoSubmit = listening.autoSubmit;
    if (typeof listening.pauseWhenHidden === 'boolean') cfg.listening.pauseWhenHidden = listening.pauseWhenHidden;
  }

  const proactive = obj.proactive as Record<string, unknown> | undefined;
  if (proactive && typeof proactive === 'object') {
    if (typeof proactive.enabled === 'boolean') cfg.proactive.enabled = proactive.enabled;
    cfg.proactive.intervalMinutes = clampInt(proactive.intervalMinutes, 5, 240, cfg.proactive.intervalMinutes);
    if (proactive.scope === 'important' || proactive.scope === 'all') cfg.proactive.scope = proactive.scope;
    cfg.proactive.quietWindowMs = clampInt(proactive.quietWindowMs, 5_000, 300_000, cfg.proactive.quietWindowMs);
  }

  const ui = obj.ui as Record<string, unknown> | undefined;
  if (ui && typeof ui === 'object') {
    if (typeof ui.showTranscript === 'boolean') cfg.ui.showTranscript = ui.showTranscript;
    cfg.ui.bubbleTimeoutMs = clampInt(ui.bubbleTimeoutMs, 1_500, 30_000, cfg.ui.bubbleTimeoutMs);
  }

  // brain 节服务端也读:夹取范围与服务端 loadServerConfig 保持一致,避免面板保存把值改丢
  const brain = obj.brain as Record<string, unknown> | undefined;
  if (brain && typeof brain === 'object') {
    cfg.brain.hop1TimeoutMs = clampInt(brain.hop1TimeoutMs, 5_000, 180_000, cfg.brain.hop1TimeoutMs);
    cfg.brain.hop2TimeoutMs = clampInt(brain.hop2TimeoutMs, 5_000, 180_000, cfg.brain.hop2TimeoutMs);
    cfg.brain.maxTurns = clampInt(brain.maxTurns, 10, 2_000, cfg.brain.maxTurns);
    cfg.brain.sessionMaxAgeDays = clampInt(brain.sessionMaxAgeDays, 1, 365, cfg.brain.sessionMaxAgeDays);
    cfg.brain.maxNotes = clampInt(brain.maxNotes, 5, 200, cfg.brain.maxNotes);
    // W2 阶段2 首句上限:不设面板,但必须原样保留(否则面板保存一次就把值改丢)。
    cfg.brain.firstSentenceMaxChars = clampInt(brain.firstSentenceMaxChars, 0, 60, cfg.brain.firstSentenceMaxChars);
    // W5 慢档续垫:不设面板,但必须原样保留(否则面板保存一次就把值改丢)。
    const sf = brain.slowFiller as Record<string, unknown> | undefined;
    if (sf && typeof sf === 'object') {
      if (typeof sf.enabled === 'boolean') cfg.brain.slowFiller.enabled = sf.enabled;
      cfg.brain.slowFiller.armMs = clampInt(sf.armMs, 500, 10_000, cfg.brain.slowFiller.armMs);
      cfg.brain.slowFiller.emitMs = clampInt(sf.emitMs, 1_000, 30_000, cfg.brain.slowFiller.emitMs);
    }
  }

  return cfg;
}

/** 读取配置;文件缺失/损坏时回默认值(不抛出)。 */
export async function loadVoiceCompanionConfig(): Promise<{ config: VoiceCompanionConfig; exists: boolean }> {
  const file = await resolvePath(CONFIG_REL_PATH);
  if (!file.exists) {
    return { config: sanitizeVoiceCompanionConfig(null), exists: false };
  }
  const res = await authFetch(apiUrl(`/api/files/read?path=${encodeURIComponent(file.path)}`));
  if (!res.ok) {
    return { config: sanitizeVoiceCompanionConfig(null), exists: true };
  }
  const data = await res.json().catch(() => ({}));
  try {
    return { config: sanitizeVoiceCompanionConfig(JSON.parse(String(data.content ?? ''))), exists: true };
  } catch {
    console.warn('[voiceCompanion] config.json 解析失败,使用默认配置');
    return { config: sanitizeVoiceCompanionConfig(null), exists: true };
  }
}

/** 写入配置(文件/目录不存在则先创建);成功后通知订阅者。 */
export async function saveVoiceCompanionConfig(config: VoiceCompanionConfig): Promise<string> {
  const clean = sanitizeVoiceCompanionConfig(config);
  const file = await resolvePath(CONFIG_REL_PATH);
  if (!file.exists) {
    const dir = await resolvePath(TOOL_DIR_REL_PATH);
    if (!dir.exists) {
      throw new Error('找不到 tools/voice-companion 目录(服务端需从仓库根目录启动)');
    }
    const createRes = await authFetch(apiUrl('/api/files/create'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentDir: dir.path, name: 'config.json' }),
    });
    // 409 = 已存在(并发创建),视为成功
    if (!createRes.ok && createRes.status !== 409) {
      const err = await createRes.json().catch(() => ({}));
      throw new Error(err.error || `创建 config.json 失败(${createRes.status})`);
    }
  }
  const writeRes = await authFetch(apiUrl('/api/files/write'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: file.path, content: JSON.stringify(clean, null, 2) + '\n' }),
  });
  if (!writeRes.ok) {
    const err = await writeRes.json().catch(() => ({}));
    throw new Error(err.error || `写入 config.json 失败(${writeRes.status})`);
  }
  emitConfigChange(clean);
  return file.path;
}

// ----------------------------------------------------------------------------
// 配置订阅(设置面板保存 → 运行中的组件即时生效)
// ----------------------------------------------------------------------------

type ConfigListener = (config: VoiceCompanionConfig) => void;
const configListeners = new Set<ConfigListener>();

export function subscribeVoiceCompanionConfig(listener: ConfigListener): () => void {
  configListeners.add(listener);
  return () => configListeners.delete(listener);
}

function emitConfigChange(config: VoiceCompanionConfig): void {
  for (const listener of configListeners) {
    try {
      listener(config);
    } catch (err) {
      console.warn('[voiceCompanion] 配置订阅回调出错:', err);
    }
  }
}

// ============================================================================
// 大脑接口
// ============================================================================

export interface VoiceProcessRequestResult {
  success: boolean;
  action?: string;
  response?: string;
  targetAgent?: { id: string; name: string };
  messageSent?: string;
  delivery?: 'queue' | 'interrupt';
  interrupted?: boolean;
  secondHopMs?: number;
  memoryOpsApplied?: number;
  degraded?: boolean;
  elapsedMs?: number;
  error?: string;
  /** 服务端稳定错误码(见 routes/voice-companion.ts);前端按它做中文映射。 */
  code?: string;
}

/** 提交一段文本(语音终稿或系统事件)给语音伙伴大脑。 */
export async function processVoiceCompanionText(
  text: string,
  opts: { event?: boolean } = {},
): Promise<VoiceProcessRequestResult> {
  const res = await authFetch(apiUrl('/api/voice-companion/process'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, event: opts.event ? true : undefined }),
  });
  const data = (await res.json().catch(() => ({}))) as VoiceProcessRequestResult;
  if (!res.ok) {
    return { success: false, error: data.error || `请求失败(${res.status})`, code: data.code };
  }
  return { ...data, success: data.success !== false };
}

/** 流式终局结果:spoke=false 表示服务端没播过声,客户端应按 response 整段补播。 */
export interface VoiceProcessStreamFinal extends VoiceProcessRequestResult {
  spoke?: boolean;
}

export interface VoiceProcessStreamHandlers {
  /**
   * 每收到一句可播文本调用一次(按到达顺序,已过服务端语义门控)。
   * meta.pre=true:过渡/垫话句(W4 起服务端可下发)——照常播报,
   * 但消费方不应把它计入「与最终 response 的对账集」(防整段重播)。
   */
  onSentence: (sentence: string, meta?: { pre?: boolean }) => void;
  /** 终局:成功结果或失败(success:false)。abort 不触发。 */
  onFinal: (result: VoiceProcessStreamFinal) => void;
}

/**
 * 分句流式版:POST /process {stream:true},服务端以 NDJSON 逐行下推
 * sentence / final / error(见 server/routes/voice-companion.ts)。
 * 旧服务端不认 stream → 返回普通 JSON,这里按 spoke=false 整段兜底。
 */
export async function processVoiceCompanionTextStream(
  text: string,
  opts: { event?: boolean; signal?: AbortSignal } = {},
  handlers: VoiceProcessStreamHandlers,
): Promise<void> {
  const res = await authFetch(apiUrl('/api/voice-companion/process'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, event: opts.event ? true : undefined, stream: true }),
    signal: opts.signal,
  });

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/x-ndjson')) {
    // 旧服务端(不支持 stream)或路由前置校验的 JSON 错误
    const data = (await res.json().catch(() => ({}))) as VoiceProcessRequestResult;
    handlers.onFinal(res.ok
      ? { ...data, success: data.success !== false, spoke: false }
      : { success: false, error: data.error || `请求失败(${res.status})`, code: data.code, spoke: false });
    return;
  }
  if (!res.body) {
    handlers.onFinal({ success: false, error: '响应没有数据流' });
    return;
  }

  let finalSeen = false;
  await readNdjsonLines(res.body, (line) => {
    if (line.type === 'sentence' && typeof line.text === 'string') {
      handlers.onSentence(line.text, line.pre === true ? { pre: true } : undefined);
    } else if (line.type === 'final') {
      finalSeen = true;
      const result = (line.result ?? {}) as VoiceProcessRequestResult;
      handlers.onFinal({ ...result, success: result.success !== false, spoke: line.spoke === true });
    } else if (line.type === 'error') {
      finalSeen = true;
      handlers.onFinal({
        success: false,
        error: typeof line.error === 'string' ? line.error : '处理失败',
        code: typeof line.code === 'string' ? line.code : undefined,
      });
    }
  }, opts.signal);

  if (!finalSeen && !opts.signal?.aborted) {
    handlers.onFinal({ success: false, error: '连接中断' });
  }
}

export interface CompanionMemoryNote {
  id: string;
  text: string;
  createdAt: number;
  source: 'user' | 'auto';
}

export interface CompanionMemory {
  summary: string;
  notes: CompanionMemoryNote[];
  updatedAt: number;
  droppedCount: number;
}

export interface CompanionStatus {
  available: boolean;
  hasSession: boolean;
  turns: number;
  sessionStartedAt: number | null;
  lastUsedAt: number | null;
  model: string;
  memory: CompanionMemory;
}

export async function getVoiceCompanionStatus(): Promise<CompanionStatus | null> {
  const res = await authFetch(apiUrl('/api/voice-companion/status'));
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return (data as CompanionStatus) ?? null;
}

export async function resetVoiceCompanionSession(keepMemory = true): Promise<boolean> {
  const res = await authFetch(apiUrl('/api/voice-companion/reset'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keepMemory }),
  });
  return res.ok;
}

export async function getVoiceCompanionMemory(): Promise<CompanionMemory | null> {
  const res = await authFetch(apiUrl('/api/voice-companion/memory'));
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return (data?.memory as CompanionMemory) ?? null;
}

export async function updateVoiceCompanionMemory(input: {
  ops?: Array<{ op: 'remove'; id: string }>;
  clear?: boolean;
}): Promise<CompanionMemory | null> {
  const res = await authFetch(apiUrl('/api/voice-companion/memory'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return (data?.memory as CompanionMemory) ?? null;
}

// ============================================================================
// 流式通道 WS 地址
// ============================================================================

/** /ws/voice-companion 的完整地址(与主连接同后端、同鉴权方式)。 */
export function buildVoiceCompanionWsUrl(): string {
  const base = getApiBaseUrl().replace(/\/$/, '');
  const wsBase = base.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  return `${wsBase}/ws/voice-companion`;
}

export function getVoiceCompanionAuthToken(): string {
  return getAuthToken();
}
