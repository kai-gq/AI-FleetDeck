#!/usr/bin/env node
/**
 * test-baseline —— test:ci 基线白名单对照器（2026-10-04 钉死）
 *
 * 背景：本仓在 Windows 上有约 60 个"环境型"既有失败（POSIX /tmp 路径假设、
 * tmux 隔离、超时抖动等），"全绿"不可达。波次门/阶段门的纪律是**零新增失败**，
 * 但"零新增"的判定权必须归一份**白名单文件**（本目录 baseline-failures.json），
 * 不归任何开发 agent 的口头判断——否则新增失败会被自说自话解释成"环境型"。
 *
 * 规则（严格模式，无开关）：
 *   - 报告里有失败、且不在白名单       → 新增失败,exit 1(阻塞)
 *   - 白名单条目在当前报告里已通过/消失 → 垃圾条目,exit 1(强制清理,白名单只进不出会腐烂)
 *   - 两者都无                          → exit 0
 *
 * 用法：
 *   node tools/test-baseline/check.mjs                # 跑与 test:ci 同口径的 vitest,然后对照
 *   node tools/test-baseline/check.mjs --report <f>   # 不跑测试,直接对照已有 vitest JSON 报告
 *   node tools/test-baseline/check.mjs --record       # 用当前运行结果**重建**白名单(保留命中条目的 reason)
 *
 * 注意：test:ci 的 exclude 列表在本文件 EXCLUDES 常量里镜像了一份;package.json 改了口径要同步。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const WHITELIST_PATH = path.join(HERE, 'baseline-failures.json');

// 与 package.json "test:ci" 保持一致（vitest run 后跟的两个 exclude）。
const EXCLUDES = [
  'src/packages/client/hooks/__tests__/useSnapshots.test.ts',
  'src/packages/client/hooks/__tests__/useKeyboardShortcuts.test.ts',
];

/** 归一为仓库相对路径:vitest JSON 报告的 name 是绝对路径(含机器盘符),不能原样入白名单。 */
function normFile(p) {
  let f = p.replace(/\\/g, '/').replace(/^\.\//, '');
  const root = REPO_ROOT.replace(/\\/g, '/');
  if (f.startsWith(`${root}/`)) f = f.slice(root.length + 1);
  return f;
}

function keyOf(file, test) {
  return `${normFile(file)} :: ${test}`;
}

function loadWhitelist() {
  if (!fs.existsSync(WHITELIST_PATH)) {
    console.error(`[test-baseline] 白名单不存在：${WHITELIST_PATH}`);
    console.error('  首次使用请先 `node tools/test-baseline/check.mjs --record` 生成。');
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(WHITELIST_PATH, 'utf-8'));
}

/** 从 vitest JSON 报告提取失败与通过清单。 */
function parseReport(jsonPath) {
  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const failed = [];
  const passed = [];
  for (const tr of report.testResults ?? []) {
    const file = normFile(tr.name ?? '');
    for (const a of tr.assertionResults ?? []) {
      const test = a.fullName ?? a.title ?? '';
      if (a.status === 'failed') failed.push({ file, test });
      else if (a.status === 'passed') passed.push({ file, test });
    }
  }
  return { failed, passed };
}

function runVitest() {
  const out = path.join(os.tmpdir(), `tc-test-baseline-${Date.now()}.json`);
  const excludes = EXCLUDES.map((e) => `--exclude "${e}"`).join(' ');
  const cmd = `npx vitest run ${excludes} --reporter=json --outputFile="${out}"`;
  console.log(`[test-baseline] 运行: ${cmd}`);
  try {
    execSync(cmd, { cwd: REPO_ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  } catch {
    // vitest 有失败用例时退出码非 0——这是预期路径,报告文件仍然写了。
  }
  if (!fs.existsSync(out)) {
    console.error('[test-baseline] vitest 未产出 JSON 报告（是否全量崩溃？请手工跑 test:ci 排查）');
    process.exit(2);
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const record = args.includes('--record');
  const reportIdx = args.indexOf('--report');
  const reportPath = reportIdx >= 0 ? args[reportIdx + 1] : null;

  const jsonPath = reportPath ? path.resolve(reportPath) : runVitest();
  const { failed, passed } = parseReport(jsonPath);
  const passedKeys = new Set(passed.map((p) => keyOf(p.file, p.test)));

  if (record) {
    const prev = fs.existsSync(WHITELIST_PATH)
      ? loadWhitelist().entries ?? []
      : [];
    const prevByKey = new Map(prev.map((e) => [keyOf(e.file, e.test), e]));
    const entries = failed
      .map((f) => {
        const old = prevByKey.get(keyOf(f.file, f.test));
        return {
          file: f.file,
          test: f.test,
          reason: old?.reason ?? '（待补原因：跑 --record 后手工填）',
          since: old?.since ?? new Date().toISOString().slice(0, 10),
        };
      })
      .sort((a, b) => keyOf(a.file, a.test).localeCompare(keyOf(b.file, b.test)));
    const doc = {
      version: 1,
      capturedAt: new Date().toISOString(),
      capturedFrom: execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT }).toString().trim(),
      note: 'Windows 环境型既有失败基线（判定权归本文件,详见 README.md）。白名单外新失败=阻塞;白名单内变绿=必须同步删除。',
      entries,
    };
    fs.writeFileSync(WHITELIST_PATH, JSON.stringify(doc, null, 2) + '\n');
    console.log(`[test-baseline] 已重建白名单：${entries.length} 条 → ${WHITELIST_PATH}`);
    return 0;
  }

  const wl = loadWhitelist();
  const wlKeys = new Set((wl.entries ?? []).map((e) => keyOf(e.file, e.test)));
  const failedKeys = new Set(failed.map((f) => keyOf(f.file, f.test)));

  const newFailures = failed.filter((f) => !wlKeys.has(keyOf(f.file, f.test)));
  const staleEntries = (wl.entries ?? []).filter((e) => !failedKeys.has(keyOf(e.file, e.test)));

  console.log(`[test-baseline] 失败 ${failed.length} / 白名单 ${wlKeys.size}`);
  if (newFailures.length > 0) {
    console.error(`\n[test-baseline] ❌ 白名单外新增失败 ${newFailures.length} 条（阻塞）：`);
    for (const f of newFailures) console.error(`  - ${f.file} :: ${f.test}`);
    console.error('  处理：修复；确属环境型的,评估后 `--record` 纳入白名单（必须在提交信息里点名）。');
  }
  if (staleEntries.length > 0) {
    console.error(`\n[test-baseline] ❌ 白名单内已转绿/消失 ${staleEntries.length} 条（必须删除,白名单只进不烂）：`);
    for (const e of staleEntries) console.error(`  - ${e.file} :: ${e.test}`);
    console.error('  处理：`--record` 重建（会自动剔除）,或手工删除对应条目。');
  }
  if (newFailures.length === 0 && staleEntries.length === 0) {
    console.log('[test-baseline] ✅ 与基线一致：零新增失败、零垃圾条目。');
  }
  return newFailures.length === 0 && staleEntries.length === 0 ? 0 : 1;
}

process.exit(main());
