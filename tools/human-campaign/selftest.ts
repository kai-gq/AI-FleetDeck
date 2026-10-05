/**
 * human-campaign 离线自测（--self-test）——战役工具的唯一质量门（工具不入 tsc/eslint）
 *
 * 目标：不依赖 dev server / events.db，验证：探针注册表完整性（导入即覆盖
 * w1..w5 全部模块）、参数解析、门禁判定（optional SKIP 不阻塞）、executeProbe
 * 五态管线（pass/fail/skip/planned/manual）、锚点助手、相似度、报告落盘往返。
 * 全部临时文件写 os.tmpdir()；绝不触碰真实 events.db 与 reports/。
 *
 * 运行：npx tsx tools/human-campaign/run.ts --self-test
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CanaryEntry, CanaryTransport, HttpResult, ProbeContext, ProbeDef } from './types.js';
import { assertThat, bodyNumber, bodyString, findOwnDialogIn, phaseOf, queryRows } from './runner.js';
import { checkRegistry, PLANNED_TOTAL } from './probes/registry.js';
import { defaultOptions, executeProbe, parseArgs } from './run.js';
import { buildReport, gateVerdict, printReport, writeCampaignReport } from './report.js';
import { lcsSimilarity } from './probes/w5-voice.js';

// ─── 迷你断言框架（镜像 canary selftest 口径） ───

interface CheckResult { name: string; ok: boolean; detail?: string }

class Harness {
  results: CheckResult[] = [];
  check(name: string, ok: boolean, detail?: string): void { this.results.push({ name, ok, detail }); }
  eq<T>(name: string, actual: T, expected: T): void {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    this.check(name, ok, ok ? undefined : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

// ─── 假传输 / 假查询 ───

function ok(json: Record<string, unknown> = {}, status = 200): HttpResult {
  return { ok: true, status, json, elapsedMs: 1 };
}

function makeFakeTransport(): CanaryTransport {
  return {
    baseUrl: 'http://fake.local',
    httpGet: async (p: string) => {
      if (p === '/api/health') return ok({ status: 'ok' });
      if (p === '/api/agents') return ok({ value: [] });
      return ok({});
    },
    httpPost: async () => ok({ success: true, action: 'general_response', response: '收到' }),
    httpPut: async () => ok({}),
    wsHandshake: async () => ({ ok: true, firstMessageType: 'server_time', elapsedMs: 1 }),
    close: () => { /* noop */ },
  };
}

function makeFakeQuery(rows: CanaryEntry[]) {
  const query = (filter: { category?: string; source?: string; since?: number; limit?: number; order?: 'asc' | 'desc' }): CanaryEntry[] => {
    let out = rows.filter((r) => {
      if (filter.category && r.category !== filter.category) return false;
      if (filter.source && r.source !== filter.source) return false;
      if (filter.since !== undefined && r.ts < filter.since) return false;
      return true;
    });
    if ((filter.order ?? 'desc') === 'desc') out = [...out].reverse();
    return out.slice(0, filter.limit ?? 200);
  };
  return { query };
}

function makeCtx(): ProbeContext {
  return {
    transport: makeFakeTransport(),
    ws: {
      messages: [], send: () => { /* noop */ },
      waitFor: async () => undefined, waitForType: async () => undefined,
      receivedSince: () => [], close: () => { /* noop */ },
    },
    query: makeFakeQuery([]).query as ProbeContext['query'],
    options: defaultOptions(),
    shared: {},
    dbStats: { totalRows: 0, rows24h: 0, dbPath: '(selftest-fake)' },
    log: () => { /* noop */ },
  };
}

function entry(id: number, over: Partial<CanaryEntry>): CanaryEntry {
  return { id, ts: Date.now(), category: 'dialog', level: 'info', ...over };
}

// ─── 自测主体 ───

export async function runSelfTest(_argv: string[] = []): Promise<number> {
  const h = new Harness();

  // 1) 注册表完整性（导入 w1..w5 即覆盖全部模块的 import 期错误）
  const issues = checkRegistry();
  h.check('注册表：无 error 级问题', issues.filter((i) => i.level === 'error').length === 0,
    issues.map((i) => `${i.probeId ?? '—'}:${i.msg}`).join('；') || undefined);
  h.check(`注册表：探针总数=${PLANNED_TOTAL}`, issues.every((i) => !i.msg.includes('探针总数')));

  // 2) 参数解析
  {
    const p1 = parseArgs(['--wave=3', '--probe=HC-28,HC-25', '--dry-run', '--stage=verify', '--include-adversarial']);
    h.eq('parseArgs：合法组合', [p1.errors.length, p1.options.wave, p1.options.probeFilter.join(','), p1.options.dryRun, p1.options.stage, p1.options.includeAdversarial],
      [0, 3, 'HC-28,HC-25', true, 'verify', true]);
    const p2 = parseArgs(['--wave=9', '--stage=foo', '--env-prep=bad', '--nope']);
    h.check('parseArgs：非法值全部报错', p2.errors.length === 4, p2.errors.join('；'));
    const p3 = parseArgs(['--env-prep=teardown', '--cleanup', '--wait-report-ms=1000']);
    h.eq('parseArgs：env-prep/cleanup/数字', [p3.errors.length, p3.envPrep, p3.cleanup, p3.options.reportWaitMs], [0, 'teardown', true, 1000]);
  }

  // 3) 锚点助手
  {
    const rows = [
      entry(1, { body: { direction: 'in', text: '你好' } }),
      entry(2, { body: { direction: 'out', text: '在的' } }),
      entry(3, { body: { direction: 'in', text: '你好' } }),
    ];
    h.eq('findOwnDialogIn：同文本取最新', findOwnDialogIn(rows, '你好')?.id, 3);
    h.eq('bodyString/bodyNumber/phaseOf', [bodyString(rows[1]!, 'text'), bodyNumber({ ...rows[0]!, body: { n: 1 } }, 'n'), phaseOf({ ...rows[0]!, body: { phase: 'delegated' } })], ['在的', 1, 'delegated']);
    const q = makeFakeQuery(rows);
    const ctx = makeCtx(); ctx.query = q.query as ProbeContext['query'];
    h.eq('queryRows：category+anchor', queryRows(ctx, { category: 'dialog', since: 0 }, 2).map((e) => e.id), [3]);
  }

  // 4) 相似度
  {
    h.eq('lcsSimilarity：全同=1', lcsSimilarity('语音回环测试，请确认链路正常。', '语音回环测试请确认链路正常'), 1);
    h.eq('lcsSimilarity：无关=0', lcsSimilarity('abc', 'xyz'), 0);
    const half = lcsSimilarity('语音回环测试链路', '语音回环别的');
    h.check('lcsSimilarity：部分匹配介于 0..1', half > 0 && half < 1, `sim=${half.toFixed(2)}`);
  }

  // 5) 门禁判定
  {
    const mk = (status: 'pass' | 'fail' | 'skip', optional?: boolean) => ({
      id: 'HC-99', wave: 1 as const, title: 't', dim: 'd', effect: 'none' as const, status,
      startedAt: new Date().toISOString(), elapsedMs: 1, prereqs: [], assertions: [], notes: [], observed: [], optional,
    });
    const rep = (results: ReturnType<typeof mk>[]) => buildReport({
      startedAt: Date.now(), finishedAt: Date.now(), dryRun: false, baseUrl: 'x', globalErrors: [], results,
    });
    h.check('gateVerdict：全过=ok', gateVerdict(rep([mk('pass')]), false).ok);
    h.check('gateVerdict：fail 阻塞', !gateVerdict(rep([mk('fail')]), false).ok);
    h.check('gateVerdict：optional SKIP 不阻塞', gateVerdict(rep([mk('skip', true)]), false).ok);
    h.check('gateVerdict：非 optional SKIP 阻塞', !gateVerdict(rep([mk('skip', false)]), false).ok);
    h.check('gateVerdict：--allow-skip 放行非 optional SKIP', gateVerdict(rep([mk('skip', false)]), true).ok);
  }

  // 6) executeProbe 五态管线
  {
    const ctx = makeCtx();
    const mkDef = (over: Partial<ProbeDef>): ProbeDef => ({
      id: 'HC-99', wave: 1, title: 't', dim: 'd', effect: 'none', steps: ['s'], assertionDocs: ['a'], prereqIds: [], run: async () => ({ assertions: [], notes: [] }), ...over,
    });
    const rPass = await executeProbe(mkDef({ run: async () => ({ assertions: [assertThat('a1', 'ok', true, '1', '1')], notes: [] }) }), ctx, false);
    h.eq('executeProbe：断言全过=pass', rPass.status, 'pass');
    const rFail = await executeProbe(mkDef({ run: async () => ({ assertions: [assertThat('a1', 'bad', false, '1', '0')], notes: [] }) }), ctx, false);
    h.eq('executeProbe：断言红=fail', rFail.status, 'fail');
    const rSkip = await executeProbe(mkDef({ run: async () => ({ assertions: [], notes: [], skipReason: '如实跳过' }) }), ctx, false);
    h.eq('executeProbe：skipReason=skip', rSkip.status, 'skip');
    const rPlanned = await executeProbe(mkDef({ effect: 'env' }), ctx, true);
    h.eq('executeProbe：dry-run=planned（runtime 前置延后）', rPlanned.status, 'planned');
    const rManual = await executeProbe(mkDef({ manualOnly: true, effect: 'manual' }), ctx, true);
    h.eq('executeProbe：manualOnly=manual', rManual.status, 'manual');
    const rThrow = await executeProbe(mkDef({ run: async () => { throw new Error('boom'); } }), ctx, false);
    h.eq('executeProbe：异常=fail（不炸进程）', rThrow.status, 'fail');
  }

  // 7) 报告往返 + 打印不炸
  {
    const rep = buildReport({
      startedAt: Date.now() - 10, finishedAt: Date.now(), wave: 2, dryRun: false, baseUrl: 'http://fake.local',
      globalErrors: [], results: [{
        id: 'HC-15', wave: 2, title: 't', dim: 'd', effect: 'delegation', status: 'pass',
        startedAt: new Date().toISOString(), elapsedMs: 5, prereqs: [], assertions: [], notes: ['n'], observed: [],
      }],
    });
    const tmp = path.join(os.tmpdir(), `hc-selftest-${Date.now()}.json`);
    writeCampaignReport(rep, tmp);
    const back = JSON.parse(fs.readFileSync(tmp, 'utf8')) as { tool: string; summary: { pass: number } };
    h.eq('报告往返：tool/pass', [back.tool, back.summary.pass], ['human-campaign', 1]);
    fs.unlinkSync(tmp);
    try { printReport(rep, false); h.check('printReport：不抛异常', true); }
    catch (err) { h.check('printReport：不抛异常', false, String(err)); }
  }

  // ── 汇总 ──
  const failed = h.results.filter((r) => !r.ok);
  /* eslint-disable no-console */
  console.log('');
  console.log(`══ human-campaign 离线自测 ══ ${h.results.length - failed.length}/${h.results.length} 通过`);
  for (const r of h.results) {
    console.log(`  ${r.ok ? '✔' : '✘'} ${r.name}${r.detail ? ` —— ${r.detail}` : ''}`);
  }
  /* eslint-enable no-console */
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] && /selftest\.ts$/.test(process.argv[1])) {
  runSelfTest(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => { console.error('自测未捕获异常:', err); process.exitCode = 1; });
}
