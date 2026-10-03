/**
 * NDJSON 逐行读取(浏览器端,配套服务端 voice/ndjson.ts)。
 * 处理跨 chunk 断行、结尾无换行、abort;非 JSON 行静默跳过。
 */

export type NdjsonLine = Record<string, unknown>;

export async function readNdjsonLines(
  body: ReadableStream<Uint8Array>,
  onLine: (line: NdjsonLine) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const emit = (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') onLine(parsed as NdjsonLine);
    } catch {
      // 非 JSON 行(脏输出):忽略
    }
  };

  try {
    for (;;) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        emit(raw);
      }
    }
    buffer += decoder.decode();
    emit(buffer); // 结尾无换行的最后一行
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 流已结束/已取消
    }
  }
}
