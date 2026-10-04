/**
 * 报告渲染（⑮ P1）：把 LogAnalysisReport 转成可读文本（手动查看/后续 ⑥ 播报推送复用）。
 *
 * 不引入任何 UI 依赖；纯字符串输出。
 */

import type { AnalysisFinding, AnalysisRecommendation, LogAnalysisReport } from './types.js';

function iso(ts: number): string {
  return new Date(ts).toISOString();
}

function renderEvidence(refs: AnalysisFinding['evidence']): string {
  if (refs.length === 0) return '';
  const ids = refs.map(r => `#${r.logId}(${r.category ?? '?'}/${r.level ?? '?'}${r.ts ? ` ${iso(r.ts)}` : ''})`);
  return ` [证据: ${ids.join(', ')}]`;
}

function renderFindings(title: string, items: AnalysisFinding[]): string {
  if (items.length === 0) return `## ${title}\n（无）`;
  const lines = items.map((it, i) => {
    const sev = it.severity ? `[${it.severity}] ` : '';
    const detail = it.detail ? `\n   ${it.detail}` : '';
    return `${i + 1}. ${sev}${it.title}${detail}${renderEvidence(it.evidence)}`;
  });
  return `## ${title}\n${lines.join('\n')}`;
}

function renderRecommendations(items: AnalysisRecommendation[]): string {
  if (items.length === 0) return '## 优化建议（可拍板）\n（无）';
  const lines = items.map((it, i) => {
    const pri = it.priority ? `[${it.priority}] ` : '';
    const target = it.target ? `\n   目标参数: ${it.target}` : '';
    const effect = it.expectedEffect ? `\n   预期效果: ${it.expectedEffect}` : '';
    return `${i + 1}. ${pri}${it.title}\n   动作: ${it.action}${target}${effect}${renderEvidence(it.evidence)}`;
  });
  return `## 优化建议（可拍板）\n${lines.join('\n')}`;
}

/** 渲染四段报告为文本。 */
export function renderLogAnalysisReport(report: LogAnalysisReport): string {
  const { stats } = report;
  const head = [
    `# 日志分析报告（${report.window.label ?? `${iso(report.window.from)} ~ ${iso(report.window.to)}`}）`,
    `生成于 ${iso(report.generatedAt)}${report.degraded ? `；降级: ${report.degraded}` : ''}`,
    `数据源: system_log ${report.source.systemLogRows} 行 / audit_log ${report.source.auditLogRows} 行 / server.log ${report.source.serverLogLines} 行` +
      `；error=${stats.errorRows} warn=${stats.warnRows}；tokens=${stats.resource.tokensTotal} costUsd=${stats.resource.costUsd}`,
  ];
  if (report.source.warnings.length > 0) {
    head.push(`数据源告警:\n${report.source.warnings.map(w => `- ${w}`).join('\n')}`);
  }
  const body = [
    renderFindings('异常', report.anomalies),
    renderFindings('瓶颈', report.bottlenecks),
    renderFindings('资源', report.resources),
    renderRecommendations(report.recommendations),
  ];
  if (report.droppedRecommendations.length > 0) {
    body.push(
      `## 证据规则丢弃（${report.droppedRecommendations.length} 条）\n` +
        report.droppedRecommendations
          .map(d => `- ${d.title}（${d.reason === 'no-evidence' ? '无证据' : d.reason === 'all-evidence-invalid' ? '引用 id 不存在' : '格式不合法'}）`)
          .join('\n')
    );
  }
  return [...head, '', ...body].join('\n\n');
}
