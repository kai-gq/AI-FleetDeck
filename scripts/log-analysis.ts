#!/usr/bin/env tsx
/**
 * log-analysis —— ⑮ P1 日志分析智能体手动冒烟脚本（不注册路由、不动 server/index.ts）。
 *
 * 用法（在仓库根目录）：
 *   npx tsx scripts/log-analysis.ts --window yesterday
 *   npx tsx scripts/log-analysis.ts --from 1760000000000 --to 1760086400000 --model haiku
 *   npx tsx scripts/log-analysis.ts --window last24h --collect-only   # 只收集+统计，不调 LLM（零成本）
 *   npx tsx scripts/log-analysis.ts --window yesterday --json out.json --out report.md
 *
 * 说明：
 *   - 只读 events.db（system_log/audit_log）与 logs/server.log；
 *   - 默认用 Claude CLI 一次性调用（--model haiku）；数据为空时不发 LLM；
 *   - 报告建议受证据硬规则过滤，无证据建议会列在"证据规则丢弃"段。
 */

import * as fs from 'fs';
import * as path from 'path';
import { initEventDb, closeEventDb } from '../src/packages/server/data/event-db.js';
import { collectLogs, createDefaultDeps } from '../src/packages/server/log-analysis/collect.js';
import { buildLogStats } from '../src/packages/server/log-analysis/stats.js';
import { runLogAnalysis } from '../src/packages/server/log-analysis/service.js';
import { renderLogAnalysisReport } from '../src/packages/server/log-analysis/render.js';
import { resolveTimeWindow, type TimeWindowPreset } from '../src/packages/server/log-analysis/time-window.js';

interface Args {
  window?: TimeWindowPreset;
  from?: number;
  to?: number;
  model?: string;
  out?: string;
  json?: string;
  collectOnly: boolean;
  serverLog?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { collectOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const val = argv[i + 1];
    switch (key) {
      case '--window':
        args.window = val as TimeWindowPreset;
        i += 1;
        break;
      case '--from':
        args.from = Number(val);
        i += 1;
        break;
      case '--to':
        args.to = Number(val);
        i += 1;
        break;
      case '--model':
        args.model = val;
        i += 1;
        break;
      case '--out':
        args.out = val;
        i += 1;
        break;
      case '--json':
        args.json = val;
        i += 1;
        break;
      case '--server-log':
        args.serverLog = val;
        i += 1;
        break;
      case '--collect-only':
        args.collectOnly = true;
        break;
      case '--help':
        console.log('用法: npx tsx scripts/log-analysis.ts --window yesterday|today|last24h|last7d [--from ms --to ms] [--model haiku] [--collect-only] [--json out.json] [--out report.md]');
        process.exit(0);
        break;
      default:
        if (key.startsWith('--')) {
          console.error(`未知参数: ${key}`);
          process.exit(2);
        }
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const window = resolveTimeWindow({ preset: args.window, from: args.from, to: args.to });
  console.log(`[log-analysis] 时间窗: ${window.label} (${window.from} ~ ${window.to})`);

  initEventDb();
  try {
    if (args.collectOnly) {
      const collected = collectLogs(window, {}, createDefaultDeps(), args.serverLog);
      const stats = buildLogStats(collected.systemLog, collected.serverLog);
      console.log(`[log-analysis] system_log=${collected.systemLog.length} audit_log=${collected.auditLog.length} server.log=${collected.serverLog.lines.length}`);
      console.log(JSON.stringify(stats, null, 2));
      collected.warnings.forEach(w => console.warn(`[warn] ${w}`));
      return;
    }

    const report = await runLogAnalysis({
      preset: args.window,
      from: args.from,
      to: args.to,
      model: args.model,
      serverLogPath: args.serverLog,
    });
    const text = renderLogAnalysisReport(report);
    console.log(text);
    if (report.degraded) console.warn(`[log-analysis] 降级: ${report.degraded}`);

    if (args.out) {
      fs.writeFileSync(path.resolve(args.out), text, 'utf8');
      console.log(`[log-analysis] 文本报告已写入 ${path.resolve(args.out)}`);
    }
    if (args.json) {
      fs.writeFileSync(path.resolve(args.json), JSON.stringify(report, null, 2), 'utf8');
      console.log(`[log-analysis] JSON 报告已写入 ${path.resolve(args.json)}`);
    }
  } finally {
    closeEventDb();
  }
}

main().catch(err => {
  console.error(`[log-analysis] 失败: ${(err as Error).message}`);
  process.exit(1);
});
