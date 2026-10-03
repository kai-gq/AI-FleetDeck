import { apiUrl, authFetch } from '../utils/storage';

/**
 * 语音识别「云通道」(tools/whisper/cloud.json)读写。
 *
 * 该文件由 whisper 垫片(Python)在每次转写时读取;这里通过通用文件 API
 * 读写,服务端零改动。路径解析用 /api/files/exists:它只走严格的
 * resolveAndValidateFilePath(无 fallback 策略,不会误命中其它目录的同名
 * 文件),且文件不存在时也会返回解析后的绝对路径,正好用来做落盘位置发现
 * (/api/files/write 要求绝对路径且文件已存在,故缺失时先 /create)。
 */

export type SttEngineMode = 'auto' | 'local' | 'cloud';

export interface WhisperCloudConfig {
  mode: SttEngineMode;
  provider: 'siliconflow';
  apiKey: string;
  model: string;
}

export const DEFAULT_WHISPER_CLOUD_CONFIG: WhisperCloudConfig = {
  mode: 'auto',
  provider: 'siliconflow',
  apiKey: '',
  model: 'FunAudioLLM/SenseVoiceSmall',
};

const CLOUD_REL_PATH = 'tools/whisper/cloud.json';
const TOOL_DIR_REL_PATH = 'tools/whisper';

async function resolvePath(relativePath: string): Promise<{ exists: boolean; path: string }> {
  const res = await authFetch(apiUrl(`/api/files/exists?path=${encodeURIComponent(relativePath)}`));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.path !== 'string') {
    throw new Error(data.error || `路径解析失败(${res.status})`);
  }
  return { exists: !!data.exists, path: data.path };
}

function sanitize(raw: unknown): WhisperCloudConfig {
  const cfg: WhisperCloudConfig = { ...DEFAULT_WHISPER_CLOUD_CONFIG };
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (obj.mode === 'auto' || obj.mode === 'local' || obj.mode === 'cloud') cfg.mode = obj.mode;
    if (typeof obj.apiKey === 'string') cfg.apiKey = obj.apiKey.trim();
    if (typeof obj.model === 'string' && obj.model.trim()) cfg.model = obj.model.trim();
  }
  return cfg;
}

/** 读取云通道配置;文件缺失/损坏时回默认值(auto,无 key = 纯本地),不抛出。 */
export async function loadWhisperCloudConfig(): Promise<{ config: WhisperCloudConfig; exists: boolean }> {
  const file = await resolvePath(CLOUD_REL_PATH);
  if (!file.exists) {
    return { config: { ...DEFAULT_WHISPER_CLOUD_CONFIG }, exists: false };
  }
  const res = await authFetch(apiUrl(`/api/files/read?path=${encodeURIComponent(file.path)}`));
  if (!res.ok) {
    return { config: { ...DEFAULT_WHISPER_CLOUD_CONFIG }, exists: true };
  }
  const data = await res.json().catch(() => ({}));
  try {
    return { config: sanitize(JSON.parse(String(data.content ?? ''))), exists: true };
  } catch {
    console.warn('[whisperCloud] cloud.json 解析失败,使用默认配置');
    return { config: { ...DEFAULT_WHISPER_CLOUD_CONFIG }, exists: true };
  }
}

/** 写入云通道配置(文件不存在则先创建);返回写入的绝对路径。 */
export async function saveWhisperCloudConfig(config: WhisperCloudConfig): Promise<string> {
  const file = await resolvePath(CLOUD_REL_PATH);
  if (!file.exists) {
    const dir = await resolvePath(TOOL_DIR_REL_PATH);
    if (!dir.exists) {
      throw new Error('找不到 tools/whisper 目录(服务端需从仓库根目录启动)');
    }
    const createRes = await authFetch(apiUrl('/api/files/create'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentDir: dir.path, name: 'cloud.json' }),
    });
    // 409 = 已存在(并发创建),视为成功
    if (!createRes.ok && createRes.status !== 409) {
      const err = await createRes.json().catch(() => ({}));
      throw new Error(err.error || `创建 cloud.json 失败(${createRes.status})`);
    }
  }
  const writeRes = await authFetch(apiUrl('/api/files/write'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: file.path, content: JSON.stringify(config, null, 2) + '\n' }),
  });
  if (!writeRes.ok) {
    const err = await writeRes.json().catch(() => ({}));
    throw new Error(err.error || `写入 cloud.json 失败(${writeRes.status})`);
  }
  return file.path;
}
