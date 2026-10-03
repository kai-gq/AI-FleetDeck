/**
 * 「语音助手」客户端 API(分句流式版)。
 *
 * POST /api/voice-assistant/process {stream:true} → 服务端以 NDJSON 逐行下推
 * sentence / final / error(见 server/routes/voice-assistant.ts);旧服务端不认
 * stream 会返回普通 JSON,这里按 spoke=false 交由调用方整段兜底。
 */

import { apiUrl, authFetch } from '../utils/storage';
import { readNdjsonLines } from '../voice/ndjsonReader';

export interface VoiceAssistantPersona {
  preset: string;
  custom: string;
}

export interface VoiceAssistantResult {
  success: boolean;
  response?: string;
  targetAgent?: { id: string; name: string };
  messageSent?: string;
  error?: string;
}

/** 流式终局:spoke=false 表示服务端没下推过句子,客户端应按 response 整段补播。 */
export interface VoiceAssistantStreamFinal extends VoiceAssistantResult {
  spoke?: boolean;
}

export interface VoiceAssistantStreamHandlers {
  /** 每收到一句可播文本调用一次(按到达顺序)。 */
  onSentence: (sentence: string) => void;
  /** 终局:成功结果或失败(success:false)。abort 不触发。 */
  onFinal: (result: VoiceAssistantStreamFinal) => void;
}

export async function processVoiceAssistantTextStream(
  text: string,
  opts: { persona: VoiceAssistantPersona; signal?: AbortSignal },
  handlers: VoiceAssistantStreamHandlers,
): Promise<void> {
  const res = await authFetch(apiUrl('/api/voice-assistant/process'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, persona: opts.persona, stream: true }),
    signal: opts.signal,
  });

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/x-ndjson')) {
    // 旧服务端(不支持 stream)或路由前置校验的 JSON 错误
    const data = (await res.json().catch(() => ({}))) as VoiceAssistantResult & { details?: string };
    handlers.onFinal(res.ok
      ? { ...data, success: data.success !== false, spoke: false }
      : { success: false, error: data.error || data.details || `请求失败(${res.status})`, spoke: false });
    return;
  }
  if (!res.body) {
    handlers.onFinal({ success: false, error: '响应没有数据流' });
    return;
  }

  let finalSeen = false;
  await readNdjsonLines(res.body, (line) => {
    if (line.type === 'sentence' && typeof line.text === 'string') {
      handlers.onSentence(line.text);
    } else if (line.type === 'final') {
      finalSeen = true;
      const result = (line.result ?? {}) as VoiceAssistantResult;
      handlers.onFinal({ ...result, success: result.success !== false, spoke: line.spoke === true });
    } else if (line.type === 'error') {
      finalSeen = true;
      handlers.onFinal({ success: false, error: typeof line.error === 'string' ? line.error : '处理失败' });
    }
  }, opts.signal);

  if (!finalSeen && !opts.signal?.aborted) {
    handlers.onFinal({ success: false, error: '连接中断' });
  }
}
