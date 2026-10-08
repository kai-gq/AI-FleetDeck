/**
 * 「声纹门禁」客户端 API(工具箱 → 语音伙伴 面板用)
 *
 * 服务端:/api/voice-companion/voiceprint/{status,toggle,enroll,delete}
 * 错误统一抛 VoiceprintApiError{code}(error 文案为服务端中文可读信息)。
 */

import { apiUrl, authFetch } from '../utils/storage';

export interface VoiceprintStatus {
  /** 本地配置文件存在(含损坏)。 */
  exists: boolean;
  /** 文件存在但 JSON 不可用。 */
  corrupt: boolean;
  /** 注册过 —— 决定开关/删除是否可用。 */
  registered: boolean;
  /** 门禁实际生效中。 */
  enabled: boolean;
  speakId: string;
  speakerName: string;
  groupId?: string;
  createdAt?: string;
  ssdVersion?: string;
  /** 当前转写端点;声纹仅在 bigmodel_async 二遍链路上生效。 */
  endpoint: string;
  endpointSupported: boolean;
  hasCredentials: boolean;
}

export class VoiceprintApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VoiceprintApiError';
  }
}

async function requestJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await authFetch(apiUrl(`/api/voice-companion/voiceprint${path}`), init);
  } catch (err) {
    throw new VoiceprintApiError('NETWORK', err instanceof Error ? err.message : String(err));
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const code = typeof data?.code === 'string' ? data.code : `HTTP_${res.status}`;
    const message = typeof data?.error === 'string' ? data.error : `请求失败(HTTP ${res.status})`;
    throw new VoiceprintApiError(code, message);
  }
  return data ?? {};
}

function post(body?: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  };
}

export async function fetchVoiceprintStatus(): Promise<VoiceprintStatus> {
  const data = await requestJson('/status');
  return data.status as VoiceprintStatus;
}

export async function setVoiceprintEnabled(enabled: boolean): Promise<VoiceprintStatus> {
  const data = await requestJson('/toggle', post({ enabled }));
  return data.status as VoiceprintStatus;
}

export async function enrollVoiceprint(input: {
  audioBase64: string;
  speakerName?: string;
}): Promise<{ speakId: string; status: VoiceprintStatus }> {
  const data = await requestJson('/enroll', post(input));
  return { speakId: typeof data.speakId === 'string' ? data.speakId : '', status: data.status as VoiceprintStatus };
}

export async function deleteVoiceprint(): Promise<{
  status: VoiceprintStatus;
  cloudDeleted: boolean;
  cloudError: string | null;
}> {
  const data = await requestJson('/delete', post());
  return {
    status: data.status as VoiceprintStatus,
    cloudDeleted: data.cloudDeleted === true,
    cloudError: typeof data.cloudError === 'string' ? data.cloudError : null,
  };
}
