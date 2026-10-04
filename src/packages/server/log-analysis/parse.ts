/**
 * LLM 输出解析（⑮ P1）：从自由文本中提取 JSON 四段报告，并套用证据硬规则。
 *
 * 容错：模型可能裹 ```json 代码块或前后加说明文字 —— extractJsonObject 用括号配平
 * 扫描（识别字符串/转义）取第一个完整对象，比 lastIndexOf('}') 稳。
 */

import type { AnalysisFinding, AnalysisRecommendation, DroppedRecommendation } from './types.js';
import { filterRecommendations, parseFindings, type LogEvidenceIndex } from './evidence.js';

/** 从文本中提取第一个括号配平的 JSON 对象；找不到返回 undefined。 */
export function extractJsonObject(text: string): unknown | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          // 配平但非法 JSON（如中文引号/尾逗号）→ 尝试从下一个 '{' 重新扫描
          return extractJsonObject(text.slice(start + 1));
        }
      }
    }
  }
  return undefined;
}

export interface ParsedAnalysisOutput {
  ok: boolean;
  anomalies: AnalysisFinding[];
  bottlenecks: AnalysisFinding[];
  resources: AnalysisFinding[];
  recommendations: AnalysisRecommendation[];
  droppedRecommendations: DroppedRecommendation[];
}

/**
 * 解析 LLM 四段输出。四段键名容忍常见别名（异常 anomalies/abnormalities/issues、
 * 瓶颈 bottlenecks、资源 resources、建议 recommendations/suggestions）。
 * 建议段经证据硬规则过滤（filterRecommendations）。
 */
export function parseAnalysisOutput(text: string, index: LogEvidenceIndex): ParsedAnalysisOutput {
  const empty: ParsedAnalysisOutput = {
    ok: false,
    anomalies: [],
    bottlenecks: [],
    resources: [],
    recommendations: [],
    droppedRecommendations: [],
  };

  const obj = extractJsonObject(text);
  if (!obj || typeof obj !== 'object') return empty;
  const rec = obj as Record<string, unknown>;

  const anomaliesRaw = rec.anomalies ?? rec.abnormalities ?? rec.issues;
  const bottlenecksRaw = rec.bottlenecks;
  const resourcesRaw = rec.resources;
  const recommendationsRaw = rec.recommendations ?? rec.suggestions;

  const { kept, dropped } = filterRecommendations(recommendationsRaw, index);

  return {
    ok: true,
    anomalies: parseFindings(anomaliesRaw, index),
    bottlenecks: parseFindings(bottlenecksRaw, index),
    resources: parseFindings(resourcesRaw, index),
    recommendations: kept,
    droppedRecommendations: dropped,
  };
}
