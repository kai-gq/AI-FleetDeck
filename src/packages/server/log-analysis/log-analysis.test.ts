/**
 * 日志分析智能体（⑮ P1）单测：
 *   - 时间窗解析（昨天/今天/近24h/显式 from-to）；
 *   - 证据硬规则（无证据丢弃 / 不存在 id 丢弃 / 存在 id 保留并回填事实字段）；
 *   - 全链路（fixture system_log + stub LLM 返回值）四段解析 + 统计聚合；
 *   - 空日志窗 / 查询报错 / LLM 报错 / 输出不可解析 的降级行为；
 *   - server.log 窗口读取（error/warn 识别、续行、时间过滤）；
 *   - 报告渲染含四段。
 *
 * 数据目录由 test-setup.ts 重定向到临时沙箱，不触碰真实 events.db；
 * server.log 一律指向临时 fixture 文件，不读真实 logs/server.log。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeEventDb, initEventDb } from '../data/event-db.js';
import { logEvent } from '../data/system-log.js';
import { runLogAnalysis } from './service.js';
import { resolveTimeWindow, localMidnight } from './time-window.js';
import { buildEvidenceIndex, coerceLogId, filterRecommendations } from './evidence.js';
import { extractJsonObject, parseAnalysisOutput } from './parse.js';
import { collectLogs, readServerLogWindow } from './collect.js';
import { logAudit, queryAuditLog } from '../data/event-queries.js';
import type { AuditLogEntry } from '../../shared/event-types.js';
import { renderLogAnalysisReport } from './render.js';
import { parseClaudeJsonOutput } from './claude-invoker.js';
import type { LogAnalysisReport } from './types.js';

beforeAll(() => {
  initEventDb();
});

afterAll(() => {
  closeEventDb();
});

// ─── 工具 ───

const DAY = 86_400_000;
/** 主链路 fixture 时间窗：2026-10-03 00:00 UTC 起（与本地时区无关，显式 from/to） */
const WIN_MAIN_FROM = Date.UTC(2026, 9, 3, 0, 0, 0);
const WIN_MAIN_TO = WIN_MAIN_FROM + DAY - 1;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-log-analysis-'));
const emptyServerLog = path.join(tmpDir, 'empty-server.log');
fs.writeFileSync(emptyServerLog, '');

function stubLLM(text: string, spy?: { calls: number }): (req: { userContent: string; systemPrompt: string }) => Promise<{ text: string; durationMs: number; model: string }> {
  return async () => {
    if (spy) spy.calls += 1;
    return { text, durationMs: 5, model: 'stub' };
  };
}

function insertFixtureRow(ts: number, category: string, fields: Parameters<typeof logEvent>[1]): number {
  const id = logEvent(category, { ts, ...fields });
  if (typeof id !== 'number') throw new Error('fixture 写入失败');
  return id;
}

// ─── 时间窗 ───

describe('时间窗解析', () => {
  it('显式 from/to 直用（乱序自动交换）', () => {
    expect(resolveTimeWindow({ from: 2000, to: 1000 })).toMatchObject({ from: 1000, to: 2000 });
  });

  it('yesterday = 本地昨日零点 ~ 今日零点', () => {
    const now = new Date(2026, 9, 4, 15, 30, 0).getTime(); // 本地 2026-10-04 15:30
    const win = resolveTimeWindow({ preset: 'yesterday', now });
    expect(win.from).toBe(new Date(2026, 9, 3, 0, 0, 0).getTime());
    expect(win.to).toBe(new Date(2026, 9, 4, 0, 0, 0).getTime());
    expect(win.to - win.from).toBe(DAY);
  });

  it('last24h 缺省；today 从本地零点到 now', () => {
    const now = new Date(2026, 9, 4, 15, 30, 0).getTime();
    expect(resolveTimeWindow({ now })).toMatchObject({ from: now - DAY, to: now });
    const today = resolveTimeWindow({ preset: 'today', now });
    expect(today.from).toBe(localMidnight(now));
    expect(today.to).toBe(now);
  });
});

// ─── 证据硬规则（纯函数） ───

describe('证据硬规则', () => {
  const rows = [
    { id: 11, ts: 1000, category: 'broadcast', source: 'voice-companion', level: 'warn' as const, body: '{"cat":"broadcast","degraded":true}' },
    { id: 12, ts: 2000, category: 'dialog', source: 'voice-companion', level: 'info' as const, body: 'hello' },
  ];
  const index = buildEvidenceIndex(rows);

  it('coerceLogId 容忍 number/数字字符串/{logId}/{id}', () => {
    expect(coerceLogId(11)).toBe(11);
    expect(coerceLogId('11')).toBe(11);
    expect(coerceLogId({ logId: 11 })).toBe(11);
    expect(coerceLogId({ id: '12' })).toBe(12);
    expect(coerceLogId('abc')).toBeUndefined();
    expect(coerceLogId(undefined)).toBeUndefined();
  });

  it('无证据建议被丢弃（no-evidence）', () => {
    const { kept, dropped } = filterRecommendations(
      [{ title: '拍脑袋建议', action: '改配置', evidence: [] }],
      index,
    );
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toBe('no-evidence');
  });

  it('引用不存在 id 的建议被丢弃（all-evidence-invalid）', () => {
    const { kept, dropped } = filterRecommendations(
      [{ title: '幻觉证据', action: '改配置', evidence: [{ logId: 999_999 }] }],
      index,
    );
    expect(kept).toHaveLength(0);
    expect(dropped[0].reason).toBe('all-evidence-invalid');
  });

  it('引用存在 id 的建议保留，且 ts/category/level 按真实行回填（模型自报值不可信）', () => {
    const { kept, dropped } = filterRecommendations(
      [{
        title: '播报降级偏多，建议复核阈值',
        action: '把相关性阈值 60 调到 55 观察一周',
        target: '§8.2 相关性阈值(60)',
        evidence: [{ logId: 11, ts: 1, category: '假的', level: 'error', field: 'body.degraded' }],
      }],
      index,
    );
    expect(dropped).toHaveLength(0);
    expect(kept).toHaveLength(1);
    expect(kept[0].evidence[0]).toMatchObject({
      logId: 11,
      ts: 1000,
      category: 'broadcast',
      level: 'warn',
      field: 'body.degraded',
    });
    expect(kept[0].evidence[0].quote).toContain('degraded');
  });

  it('混合证据：合法引用保留、非法引用被剔除，建议不丢', () => {
    const { kept } = filterRecommendations(
      [{ title: '混合', action: 'x', evidence: [{ logId: 12 }, { logId: 424242 }] }],
      index,
    );
    expect(kept[0].evidence.map(e => e.logId)).toEqual([12]);
  });

  it('无标题建议记 malformed；非对象条目同样计入 dropped（不静默跳过）', () => {
    const { kept, dropped } = filterRecommendations(
      [{ evidence: [{ logId: 11 }] }, 42, null],
      index,
    );
    expect(kept).toHaveLength(0);
    expect(dropped.map(d => d.reason)).toEqual(['malformed', 'malformed', 'malformed']);
  });
});

// ─── JSON 提取 ───

describe('LLM 输出解析容错', () => {
  it('从 markdown 代码块/前后说明中提取 JSON 对象', () => {
    const text = '好的，报告如下：\n```json\n{"anomalies":[],"recommendations":[{"title":"t","action":"a","evidence":[{"logId":1}]}]}\n```\n完毕。';
    const obj = extractJsonObject(text) as { recommendations: unknown[] };
    expect(obj.recommendations).toHaveLength(1);
  });

  it('无 JSON 文本 → ok=false', () => {
    const parsed = parseAnalysisOutput('这不是 JSON', buildEvidenceIndex([]));
    expect(parsed.ok).toBe(false);
  });

  it('parseClaudeJsonOutput 解析 --output-format json 结果并兼容前导噪声行', () => {
    const json = JSON.stringify({ type: 'result', subtype: 'success', result: '{"a":1}', session_id: 's1', total_cost_usd: 0.001 });
    expect(parseClaudeJsonOutput(json)).toMatchObject({ text: '{"a":1}', sessionId: 's1' });
    expect(parseClaudeJsonOutput(`some warning line\n${json}`)).toMatchObject({ text: '{"a":1}' });
    expect(parseClaudeJsonOutput('')).toMatchObject({ text: '' });
  });
});

// ─── 全链路（fixture + stub LLM） ───

describe('runLogAnalysis 全链路（fixture system_log + stub LLM）', () => {
  let idBroadcastWarn = 0;
  let idDelegationFailed = 0;
  let idResource = 0;
  let idAsr = 0;

  beforeAll(() => {
    insertFixtureRow(WIN_MAIN_FROM + 1_000, 'dialog', {
      source: 'voice-companion',
      level: 'info',
      body: { cat: 'dialog', direction: 'in', text: '你好' },
    });
    idBroadcastWarn = insertFixtureRow(WIN_MAIN_FROM + 2_000, 'broadcast', {
      source: 'voice-companion',
      level: 'warn',
      body: { cat: 'broadcast', phase: 'server-sent', text: '降级话术', degraded: true },
    });
    idDelegationFailed = insertFixtureRow(WIN_MAIN_FROM + 3_000, 'delegation', {
      source: 'boss',
      level: 'warn',
      body: { cat: 'delegation', phase: 'failed', channel: 'boss', error: 'spawn ENOENT' },
    });
    idResource = insertFixtureRow(WIN_MAIN_FROM + 4_000, 'system', {
      source: 'resource',
      body: { cat: 'resource', sub: 'turn', model: 'haiku', tokens: { input: 100, output: 50 }, tokensTotal: 150, costUsd: 0.001, durationMs: 800 },
    });
    idAsr = insertFixtureRow(WIN_MAIN_FROM + 5_000, 'system', {
      source: 'voice',
      body: { cat: 'voice', sub: 'asr', channel: 'whisper', text: '转写', durationMs: 1200, ok: true },
    });
  });

  it('四段解析 + 证据过滤 + 统计聚合端到端', async () => {
    const spy = { calls: 0 };
    const llmJson = JSON.stringify({
      anomalies: [
        { title: '播报回合降级', detail: '出现 degraded 兜底话术', severity: 'medium', evidence: [{ logId: idBroadcastWarn }] },
      ],
      bottlenecks: [
        { title: '委派失败告警', severity: 'high', evidence: [{ logId: idDelegationFailed, field: 'body.error' }] },
      ],
      resources: [
        { title: 'token 用量正常', severity: 'low', evidence: [{ logId: idResource }] },
      ],
      recommendations: [
        {
          title: '复核播报阈值',
          action: '将相关性阈值从 60 调到 55，观察一周拒绝率',
          target: '§8.2 相关性阈值(60)',
          priority: 'medium',
          expectedEffect: '降低降级话术比例（需回写标定）',
          evidence: [{ logId: idBroadcastWarn, field: 'body.degraded' }],
        },
        { title: '拍脑袋建议', action: '随便改改', evidence: [] },
        { title: '幻觉证据建议', action: 'x', evidence: [{ logId: 999_999 }] },
        { title: '字符串 id 也合法', action: 'y', evidence: [String(idAsr)] },
      ],
    });

    const report = await runLogAnalysis({
      from: WIN_MAIN_FROM,
      to: WIN_MAIN_TO,
      invokeLLM: stubLLM(llmJson, spy),
      serverLogPath: emptyServerLog,
      promptBudget: { maxSystemRows: 50 },
    });

    expect(spy.calls).toBe(1);
    expect(report.degraded).toBeUndefined();
    expect(report.anomalies).toHaveLength(1);
    expect(report.bottlenecks).toHaveLength(1);
    expect(report.resources).toHaveLength(1);
    // 保留 2 条（合法 + 字符串 id），丢弃 2 条（无证据 / 幻觉 id）
    expect(report.recommendations.map(r => r.title)).toEqual(['复核播报阈值', '字符串 id 也合法']);
    expect(report.droppedRecommendations.map(d => d.reason).sort()).toEqual(['all-evidence-invalid', 'no-evidence']);
    // 证据字段按真实行回填
    expect(report.recommendations[0].evidence[0]).toMatchObject({
      logId: idBroadcastWarn,
      category: 'broadcast',
      level: 'warn',
      ts: WIN_MAIN_FROM + 2_000,
    });
    // 统计聚合
    expect(report.stats.total).toBe(5);
    expect(report.stats.errorRows).toBe(0);
    expect(report.stats.warnRows).toBe(2);
    expect(report.stats.byCategory).toMatchObject({ dialog: 1, broadcast: 1, delegation: 1, system: 2 });
    expect(report.stats.resource).toMatchObject({ turns: 1, tokensInput: 100, tokensOutput: 50, tokensTotal: 150, costUsd: 0.001 });
    expect(report.stats.durationMs).toMatchObject({ count: 2, max: 1200 });
    expect(report.source).toMatchObject({ systemLogRows: 5, serverLogLines: 0 });
  });

  it('注入的 user 内容包含真实行 id，system prompt 含证据硬规则', async () => {
    const spy = { calls: 0, userContent: '', systemPrompt: '' };
    await runLogAnalysis({
      from: WIN_MAIN_FROM,
      to: WIN_MAIN_TO,
      serverLogPath: emptyServerLog,
      invokeLLM: async (req) => {
        spy.calls += 1;
        spy.userContent = req.userContent;
        spy.systemPrompt = req.systemPrompt;
        return { text: JSON.stringify({ anomalies: [], bottlenecks: [], resources: [], recommendations: [] }), durationMs: 1, model: 'stub' };
      },
    });
    expect(spy.calls).toBe(1);
    expect(spy.userContent).toContain(`#${idBroadcastWarn} `);
    expect(spy.systemPrompt).toContain('evidence');
    expect(spy.systemPrompt).toContain('丢弃');
  });
});

// ─── 降级行为 ───

describe('降级行为', () => {
  const FAR_FROM = Date.UTC(2030, 0, 1);
  const FAR_TO = FAR_FROM + DAY;

  it('空日志窗：不发 LLM，degraded=no-data', async () => {
    const spy = { calls: 0 };
    const report = await runLogAnalysis({
      from: FAR_FROM,
      to: FAR_TO,
      invokeLLM: stubLLM('{}', spy),
      serverLogPath: emptyServerLog,
    });
    expect(report.degraded).toBe('no-data');
    expect(spy.calls).toBe(0);
    expect(report.stats.total).toBe(0);
    expect(report.recommendations).toHaveLength(0);
  });

  it('查询报错：不抛异常，degraded=collect-error，warning 记录原因', async () => {
    const report = await runLogAnalysis({
      from: FAR_FROM,
      to: FAR_TO,
      deps: {
        querySystemLog: () => { throw new Error('Event database not initialized.'); },
        queryAuditLog: () => { throw new Error('Event database not initialized.'); },
        readServerLog: () => { throw new Error('EACCES'); },
      },
      invokeLLM: stubLLM('{}'),
    });
    expect(report.degraded).toBe('collect-error');
    expect(report.source.warnings.join('\n')).toContain('system_log 查询失败');
    expect(report.source.warnings.join('\n')).toContain('server.log 读取失败');
  });

  it('LLM 调用失败：degraded=llm-error，统计摘要保留', async () => {
    const report = await runLogAnalysis({
      from: WIN_MAIN_FROM,
      to: WIN_MAIN_TO,
      serverLogPath: emptyServerLog,
      invokeLLM: async () => { throw new Error('Claude 一次性调用超时（1ms）'); },
    });
    expect(report.degraded).toBe('llm-error');
    expect(report.stats.total).toBeGreaterThan(0);
    expect(report.source.warnings.join('\n')).toContain('LLM 调用失败');
  });

  it('LLM 输出不可解析：degraded=parse-error，保留统计', async () => {
    const report = await runLogAnalysis({
      from: WIN_MAIN_FROM,
      to: WIN_MAIN_TO,
      serverLogPath: emptyServerLog,
      invokeLLM: stubLLM('抱歉，我无法给出 JSON。'),
    });
    expect(report.degraded).toBe('parse-error');
    expect(report.stats.total).toBeGreaterThan(0);
    expect(report.anomalies).toHaveLength(0);
  });
});

// ─── server.log 读取 ───

describe('server.log 窗口读取', () => {
  it('按时间窗过滤、识别 error/warn、保留堆栈续行', () => {
    const file = path.join(tmpDir, 'fixture-server.log');
    const t0 = Date.parse('10/03/2026, 10:00:00 AM');
    const t2 = Date.parse('10/03/2026, 11:00:00 AM'); // 窗外
    const lines = [
      `[Tide] 111  - 10/03/2026, 10:00:00 AM  ERROR [Runner] spawn ENOENT`,
      `    at child_process (internal.js:1)`,
      `[Tide] 111  - 10/03/2026, 10:01:00 AM  WARN [Entity] 降级`,
      `[Tide] 111  - 10/03/2026, 10:02:00 AM  LOG [SystemLog] ok`,
      `[Tide] 111  - 10/03/2026, 11:00:00 AM  ERROR [Late] outside`,
    ];
    fs.writeFileSync(file, lines.join('\n'));

    const result = readServerLogWindow({ from: t0 - 1_000, to: t2 - 1_000, filePath: file });
    expect(result.lines.map(l => l.level)).toEqual(['error', 'error', 'warn', 'info']); // 续行继承 error
    expect(result.lines[1].text).toContain('at child_process');
    expect(result.lines[1].ts).toBe(t0);
    expect(result.errorCount).toBe(1);
    expect(result.warnCount).toBe(1);
    expect(result.lines.some(l => l.text.includes('outside'))).toBe(false);
  });

  it('文件不存在：warning 降级，不抛异常', () => {
    const result = readServerLogWindow({ from: 0, to: Date.now(), filePath: path.join(tmpDir, 'nope.log') });
    expect(result.lines).toHaveLength(0);
    expect(result.warnings.join('')).toContain('server.log 不存在');
  });

  it('只有 server.log 数据也可触发分析（数据源独立）', async () => {
    const file = path.join(tmpDir, 'only-server.log');
    const ts = Date.parse('10/03/2026, 10:05:00 AM');
    fs.writeFileSync(file, `[Tide] 111  - 10/03/2026, 10:05:00 AM  ERROR [X] crash`);
    const spy = { calls: 0 };
    const report = await runLogAnalysis({
      from: ts - 10_000,
      to: ts + 10_000,
      deps: { querySystemLog: () => [], queryAuditLog: () => [] },
      serverLogPath: file,
      invokeLLM: stubLLM(JSON.stringify({ anomalies: [], bottlenecks: [], resources: [], recommendations: [] }), spy),
    });
    expect(spy.calls).toBe(1);
    expect(report.source.serverLogLines).toBe(1);
    expect(report.stats.serverLogErrors).toBe(1);
    expect(report.degraded).toBeUndefined();
  });
});

// ─── 渲染 ───

describe('报告渲染', () => {
  it('包含四段标题、证据与丢弃说明', async () => {
    const report: LogAnalysisReport = await runLogAnalysis({
      from: WIN_MAIN_FROM,
      to: WIN_MAIN_TO,
      serverLogPath: emptyServerLog,
      invokeLLM: stubLLM(JSON.stringify({
        anomalies: [{ title: '异常A', evidence: [] }],
        bottlenecks: [],
        resources: [],
        recommendations: [{ title: '建议B', action: '动作', evidence: [] }],
      })),
    });
    const text = renderLogAnalysisReport(report);
    expect(text).toContain('## 异常');
    expect(text).toContain('## 瓶颈');
    expect(text).toContain('## 资源');
    expect(text).toContain('## 优化建议');
    expect(text).toContain('证据规则丢弃');
    expect(text).toContain('建议B');
  });
});

// ─── audit 采集：旧窗口不漏数（queryAuditLog.until 回归，任务03 验证后加固） ───

describe('collectLogs × 真实 queryAuditLog：旧窗口不被新行淹没', () => {
  it('窗口其后新行超过 limit 时，窗口内 audit 行仍被采集（until 生效）', () => {
    const base = Date.UTC(2020, 0, 1); // 远离其它用例窗口，避免互相干扰
    const winFrom = base;
    const winTo = base + 60_000;
    const audit = (action: string, createdAt: number): AuditLogEntry => ({
      category: 'system',
      action,
      level: 'info',
      createdAt,
    });
    logAudit(audit('audit-in-1', winFrom + 1_000));
    logAudit(audit('audit-in-2', winFrom + 2_000));
    // 205 条晚于窗口的新行：若无 until，DESC + limit 200 会把窗口内行全部挤出
    for (let i = 0; i < 205; i += 1) logAudit(audit(`audit-late-${i}`, winTo + 1_000 + i));

    const collected = collectLogs(
      { from: winFrom, to: winTo },
      {},
      {
        querySystemLog: () => [],
        queryAuditLog, // 真实实现，非桩
        readServerLog: () => ({ lines: [], errorCount: 0, warnCount: 0, warnings: [] }),
      },
    );
    expect(collected.errors.auditLog).toBe(false);
    expect(collected.auditLog.map(e => e.action).sort()).toEqual(['audit-in-1', 'audit-in-2']);
  });
});
