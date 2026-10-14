import { apiUrl, authFetch } from '../utils/storage';

/**
 * 语音播报音色(edge-tts)配置读写。
 *
 * 垫片(tools/edge-tts/shim/tts_shim.py)每次合成时按语言前缀查音色,优先级:
 *   voices.local.json(本模块写的用户覆盖)> voices.json(入库默认)
 * 这里通过通用文件 API 读写 voices.local.json,服务端零改动。落盘位置发现
 * 用 /api/files/exists:只走严格 resolveAndValidateFilePath(无 fallback 策略,
 * 不会误命中其它目录),文件不存在时也返回解析后的绝对路径;/api/files/write
 * 要求绝对路径且文件已存在,故缺失时先 /create。
 */

export type TtsLang = 'zh' | 'en' | 'es';

/** 播报引擎:edge-tts(微软在线,免费)/ volcano(火山引擎·豆包大模型 TTS,按字符计费)。 */
export type TtsEngine = 'edge-tts' | 'volcano';

/** 火山音色(按语言);**空串 = 该语言回退 edge-tts**(与上方 edge 音色字段语义相反:
 *  edge 字段空串 = 保持默认,这里空串是设置页「不用火山 · 回退 edge-tts」的有效选择)。 */
export interface VolcanoVoices {
  zh: string;
  en: string;
  es: string;
}

export interface TtsVoiceConfig {
  zh: string;
  en: string;
  es: string;
  /** 当前播报引擎;老配置无此字段 = edge-tts(等价历史行为)。 */
  engine: TtsEngine;
  volcano: VolcanoVoices;
  /** 语速调整(百分数,0 = 原速;+10 = 快 10%)。 */
  rate: number;
  /** 音量调整(百分数,0 = 原音量)。 */
  volume: number;
  /** 火山合成专用 API Key;留空 = 复用「语音伙伴」config.json 的凭据(推荐)。 */
  volcanoApiKey: string;
  /** 火山 resource 覆盖;留空 = 垫片按当前音色自动推导(uranus→seed-tts-2.0,其余 1.0)。 */
  volcanoResourceId: string;
}

export interface TtsVoiceOption {
  value: string;
  label: string;
}

/** 与 tools/edge-tts/voices.json 的出厂默认保持一致(rate/volume 缺省 = 0)。 */
export const DEFAULT_TTS_VOICES: TtsVoiceConfig = {
  zh: 'zh-CN-XiaoxiaoNeural',
  en: 'en-US-JennyNeural',
  es: 'es-MX-DaliaNeural',
  engine: 'edge-tts',
  volcano: {
    zh: 'zh_female_shuangkuaisisi_moon_bigtts',
    en: 'en_male_tim_uranus_bigtts',
    es: '',
  },
  rate: 0,
  volume: 0,
  volcanoApiKey: '',
  volcanoResourceId: '',
};

/** edge-tts 实际可用的音色(msedge 列表,非 Azure 全量)。 */
export const TTS_VOICE_OPTIONS: Record<TtsLang, readonly TtsVoiceOption[]> = {
  zh: [
    { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温柔女声(默认)' },
    { value: 'zh-CN-XiaoyiNeural', label: '晓伊 · 活泼女声' },
    { value: 'zh-CN-YunxiNeural', label: '云希 · 阳光男声' },
    { value: 'zh-CN-YunyangNeural', label: '云扬 · 新闻男声' },
    { value: 'zh-CN-YunjianNeural', label: '云健 · 激情男声' },
    { value: 'zh-CN-YunxiaNeural', label: '云夏 · 可爱童声' },
    { value: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北话' },
    { value: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 陕西话' },
    { value: 'zh-HK-HiuGaaiNeural', label: '晓佳 · 粤语女声' },
    { value: 'zh-HK-HiuMaanNeural', label: '晓曼 · 粤语女声' },
    { value: 'zh-HK-WanLungNeural', label: '云龙 · 粤语男声' },
    { value: 'zh-TW-HsiaoChenNeural', label: '晓臻 · 台湾女声' },
    { value: 'zh-TW-HsiaoYuNeural', label: '晓雨 · 台湾女声' },
    { value: 'zh-TW-YunJheNeural', label: '云哲 · 台湾男声' },
  ],
  en: [
    { value: 'en-US-JennyNeural', label: 'Jenny · 亲切女声(默认)' },
    { value: 'en-US-AriaNeural', label: 'Aria · 自信女声' },
    { value: 'en-US-AvaNeural', label: 'Ava · 友好女声' },
    { value: 'en-US-EmmaNeural', label: 'Emma · 开朗女声' },
    { value: 'en-US-MichelleNeural', label: 'Michelle · 温柔女声' },
    { value: 'en-US-AnaNeural', label: 'Ana · 童声' },
    { value: 'en-US-AndrewNeural', label: 'Andrew · 沉稳男声' },
    { value: 'en-US-BrianNeural', label: 'Brian · 随和男声' },
    { value: 'en-US-ChristopherNeural', label: 'Christopher · 权威男声' },
    { value: 'en-US-GuyNeural', label: 'Guy · 激情男声' },
    { value: 'en-US-RogerNeural', label: 'Roger · 活泼男声' },
    { value: 'en-US-SteffanNeural', label: 'Steffan · 理性男声' },
  ],
  es: [
    { value: 'es-MX-DaliaNeural', label: 'Dalia · 墨西哥女声(默认)' },
    { value: 'es-MX-JorgeNeural', label: 'Jorge · 墨西哥男声' },
    { value: 'es-ES-ElviraNeural', label: 'Elvira · 西班牙女声' },
    { value: 'es-ES-AlvaroNeural', label: 'Alvaro · 西班牙男声' },
    { value: 'es-US-PalomaNeural', label: 'Paloma · 美国西语女声' },
    { value: 'es-AR-ElenaNeural', label: 'Elena · 阿根廷女声' },
  ],
};

/**
 * 火山引擎音色(2026-10-14 本机逐个实测全通;1.0 = seed-tts-1.0,2.0 = seed-tts-2.0,
 * 垫片按音色名后缀 moon/mars↔uranus 自动选 resource)。西语无火山专用音色 → 只有回退项。
 * 音色语言不匹配(如英文音色读中文)时服务端返回零音频,垫片会自动回退 edge-tts。
 */
export const VOLCANO_VOICE_OPTIONS: Record<TtsLang, readonly TtsVoiceOption[]> = {
  zh: [
    { value: 'zh_female_shuangkuaisisi_moon_bigtts', label: '爽快思思 · 活泼女声(1.0)' },
    { value: 'zh_female_gaolengyujie_moon_bigtts', label: '高冷御姐(1.0)' },
    { value: 'zh_female_meilinvyou_moon_bigtts', label: '魅力女友(1.0)' },
    { value: 'zh_female_wanwanxiaohe_moon_bigtts', label: '湾湾小何(1.0)' },
    { value: 'zh_male_jingqiangkanye_moon_bigtts', label: '京腔侃爷(1.0)' },
    { value: 'zh_male_beijingxiaoye_moon_bigtts', label: '北京小爷(1.0)' },
    { value: 'zh_male_yangguangqingnian_moon_bigtts', label: '阳光青年(1.0)' },
    { value: 'zh_female_wenrouxiaoya_uranus_bigtts', label: '温柔小雅(2.0)' },
    { value: 'zh_female_vv_uranus_bigtts', label: 'Vivi · 多语种(2.0)' },
    { value: 'zh_female_xiaohe_uranus_bigtts', label: '小何(2.0)' },
    { value: 'zh_male_m191_uranus_bigtts', label: '云舟(2.0)' },
    { value: 'zh_male_ruyayichen_uranus_bigtts', label: '儒雅逸辰(2.0)' },
    { value: 'zh_female_tianmeixiaoyuan_uranus_bigtts', label: '甜美小源(2.0)' },
  ],
  en: [
    { value: 'en_male_tim_uranus_bigtts', label: 'Tim · 男声(2.0)' },
    { value: 'en_female_dacey_uranus_bigtts', label: 'Dacey · 女声(2.0)' },
    { value: 'en_female_stokie_uranus_bigtts', label: 'Stokie · 女声(2.0)' },
  ],
  es: [],
};

/** 火山下拉的逃生项:选它 = 该语言不走火山,回退 edge-tts(垫片读空串)。 */
export const VOLCANO_FALLBACK_VALUE = '';

/** 试听样句(按语言)。 */
export const TTS_AUDITION_SAMPLES: Record<TtsLang, string> = {
  zh: '老板，任务已经完成，这是今天的进度汇报。',
  en: "Boss, the task is complete. Here is today's status report.",
  es: 'Jefe, la tarea está completa. Aquí está el informe de hoy.',
};

export const TTS_LANG_LABELS: Record<TtsLang, string> = {
  zh: '中文',
  en: '英文',
  es: '西班牙语',
};

const LOCAL_REL_PATH = 'tools/edge-tts/voices.local.json';
const DEFAULTS_REL_PATH = 'tools/edge-tts/voices.json';
const TOOL_DIR_REL_PATH = 'tools/edge-tts';

async function resolvePath(relativePath: string): Promise<{ exists: boolean; path: string }> {
  const res = await authFetch(apiUrl(`/api/files/exists?path=${encodeURIComponent(relativePath)}`));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.path !== 'string') {
    throw new Error(data.error || `路径解析失败(${res.status})`);
  }
  return { exists: !!data.exists, path: data.path };
}

async function readJson(absPath: string): Promise<unknown> {
  const res = await authFetch(apiUrl(`/api/files/read?path=${encodeURIComponent(absPath)}`));
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  try {
    return JSON.parse(String(data.content ?? ''));
  } catch {
    return null;
  }
}

/** 数值字段(rate/volume):接受数字或数字串,钳到 [-100,100];非法/缺失走默认。 */
export function sanitizeTuning(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(/%$/, ''));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(-100, Math.min(100, n));
}

/**
 * 白名单重建:只认已知字段,其余保持默认(新增字段必须在此登记,否则会被静默丢掉)。
 * 注意 volcano 要**深拷贝**——`{...fallback}` 是浅拷贝,直接改 cfg.volcano 会污染
 * 模块级 DEFAULT_TTS_VOICES(别名)。
 */
export function sanitize(raw: unknown, fallback: TtsVoiceConfig): TtsVoiceConfig {
  const cfg: TtsVoiceConfig = { ...fallback, volcano: { ...fallback.volcano } };
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const lang of ['zh', 'en', 'es'] as const) {
      const v = obj[lang];
      if (typeof v === 'string' && v.trim()) cfg[lang] = v.trim();
    }
    if (obj.engine === 'edge-tts' || obj.engine === 'volcano') cfg.engine = obj.engine;
    const volc = obj.volcano;
    if (volc && typeof volc === 'object') {
      const v = volc as Record<string, unknown>;
      for (const lang of ['zh', 'en', 'es'] as const) {
        if (typeof v[lang] === 'string') cfg.volcano[lang] = v[lang].trim(); // 空串保留(有效值)
      }
    }
    if (typeof obj.volcanoApiKey === 'string') cfg.volcanoApiKey = obj.volcanoApiKey.trim();
    if (typeof obj.volcanoResourceId === 'string') cfg.volcanoResourceId = obj.volcanoResourceId.trim();
    cfg.rate = sanitizeTuning(obj.rate, fallback.rate);
    cfg.volume = sanitizeTuning(obj.volume, fallback.volume);
  }
  return cfg;
}

// ---------------------------------------------------------------- 上次播报状态

const STATE_REL_PATH = 'tools/edge-tts/shim-state.json';

/** 垫片每次合成后原子写的状态(见 tools/edge-tts/shim/tts_shim.py write_state)。 */
export interface TtsShimState {
  time?: string;
  /** 配置里选的引擎。 */
  engine?: string;
  /** 实际出声的合成器。 */
  used?: 'volcano' | 'edge-tts' | 'piper';
  ok?: boolean;
  voice?: string;
  /** 非空 = 发生了回退(如 volcano->edge-tts / piper_real)。 */
  fallback?: string | null;
  /** 回退/跳过原因(已截断,不含凭据)。 */
  reason?: string | null;
  /** 火山计费字符数(如「17字」)。 */
  usage?: string | null;
  ms?: number;
}

export interface TtsShimStateView {
  level: 'ok' | 'warn' | 'info';
  key: string;
  params: Record<string, string>;
}

/**
 * 状态 → 展示语义(纯函数,可单测)。五态:
 *   volcano 成功 / 火山失败回退 edge / 连 edge 也失败回退 piper / 普通 edge(含按配置回退) / 无记录
 */
export function describeShimState(state: TtsShimState | null | undefined): TtsShimStateView {
  if (!state || !state.used) return { level: 'info', key: 'lastNone', params: {} };
  if (state.used === 'volcano') {
    return { level: 'ok', key: 'lastOkVolcano', params: { voice: state.voice ?? '', usage: state.usage ?? '' } };
  }
  if (state.used === 'piper') {
    return { level: 'warn', key: 'lastFallbackPiper', params: { reason: state.reason ?? '' } };
  }
  if (state.fallback) { // used === 'edge-tts' 且发生了火山→edge 回退
    return { level: 'warn', key: 'lastFallbackEdge', params: { reason: state.reason ?? '' } };
  }
  return { level: 'info', key: 'lastOkEdge', params: { voice: state.voice ?? '' } };
}

/** 读 shim-state.json(垫片写的「上次播报实际引擎」);缺失/损坏回 null,不抛出。 */
export async function loadTtsShimState(): Promise<TtsShimState | null> {
  try {
    const file = await resolvePath(STATE_REL_PATH);
    if (!file.exists) return null;
    const raw = await readJson(file.path);
    return raw && typeof raw === 'object' ? (raw as TtsShimState) : null;
  } catch {
    return null;
  }
}

/**
 * 读取生效音色:voices.local.json(用户覆盖,exists=true)优先,
 * 否则读入库默认 voices.json 仅用于回显;任何失败回默认值,不抛出。
 */
export async function loadTtsVoices(): Promise<{ config: TtsVoiceConfig; exists: boolean }> {
  const local = await resolvePath(LOCAL_REL_PATH);
  if (local.exists) {
    const raw = await readJson(local.path);
    return { config: sanitize(raw, DEFAULT_TTS_VOICES), exists: true };
  }
  const base = await resolvePath(DEFAULTS_REL_PATH);
  if (base.exists) {
    const raw = await readJson(base.path);
    return { config: sanitize(raw, DEFAULT_TTS_VOICES), exists: false };
  }
  return { config: { ...DEFAULT_TTS_VOICES }, exists: false };
}

/** 写入 voices.local.json(不存在则先创建);返回写入的绝对路径。 */
export async function saveTtsVoices(config: TtsVoiceConfig): Promise<string> {
  const file = await resolvePath(LOCAL_REL_PATH);
  if (!file.exists) {
    const dir = await resolvePath(TOOL_DIR_REL_PATH);
    if (!dir.exists) {
      throw new Error('找不到 tools/edge-tts 目录(服务端需从仓库根目录启动)');
    }
    const createRes = await authFetch(apiUrl('/api/files/create'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentDir: dir.path, name: 'voices.local.json' }),
    });
    // 409 = 已存在(并发创建),视为成功
    if (!createRes.ok && createRes.status !== 409) {
      const err = await createRes.json().catch(() => ({}));
      throw new Error(err.error || `创建 voices.local.json 失败(${createRes.status})`);
    }
  }
  const writeRes = await authFetch(apiUrl('/api/files/write'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: file.path, content: JSON.stringify(config, null, 2) + '\n' }),
  });
  if (!writeRes.ok) {
    const err = await writeRes.json().catch(() => ({}));
    throw new Error(err.error || `写入 voices.local.json 失败(${writeRes.status})`);
  }
  return file.path;
}
