#!/usr/bin/env node
// 冒烟测试:验证 tmux 包装器的关键修复(需要真 tmux + Git sh + claude)
// 用法:node smoke.mjs [wrapperPath]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = process.argv[2] || path.join(here, 'bin', 'tmux.exe');
const tmp = os.tmpdir();
let pass = 0;
let fail = 0;

const run = (exe, args) =>
  new Promise((res) => {
    let o = '';
    let e = '';
    let p;
    try {
      p = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (er) {
      return res({ c: -1, o: '', e: er.message });
    }
    p.stdout.on('data', (d) => (o += d));
    p.stderr.on('data', (d) => (e += d));
    p.on('error', (er) => res({ c: -1, o: o.trim(), e: er.message }));
    p.on('close', (c) => res({ c, o: o.trim(), e: e.trim() }));
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFile(f, ms = 6000) {
  const n = Math.ceil(ms / 250);
  for (let i = 0; i < n; i++) {
    if (fs.existsSync(f)) return true;
    await sleep(250);
  }
  return false;
}
function ck(name, ok, detail) {
  if (ok) {
    pass++;
    console.log('  ✓ ' + name + (detail ? '   [' + detail + ']' : ''));
  } else {
    fail++;
    console.log('  ✗ ' + name + (detail ? '   [' + detail + ']' : ''));
  }
}
const kill = (n) => run(WRAPPER, ['kill-session', '-t', n]);
const rm = (f) => {
  try {
    fs.unlinkSync(f);
  } catch { /* ignore */ }
};

(async () => {
  console.log('wrapper = ' + WRAPPER);
  if (!fs.existsSync(WRAPPER)) {
    console.error('找不到包装器(先 build.mjs,或把路径作为第一个参数传入)');
    process.exit(2);
  }

  // 0) 基本透传
  const t0 = await run(WRAPPER, ['-V']);
  ck('透传 tmux -V', t0.c === 0 && /tmux/i.test(t0.o), t0.o || t0.e);

  // 0.5) 常驻 seed 会话:钉住 server,保证 set-option 有处可设、exit-empty 不会在中途收走 server
  await run(WRAPPER, ['new-session', '-d', '-s', 'tt-smoke-seed']);
  await run(WRAPPER, ['set-option', '-g', 'exit-empty', 'off']);

  // 1) -c 绝对路径改写(pane 工作目录探针;特意用带空格的目录)
  const probe = path.join(tmp, 'tt-smoke-cwd.txt');
  const dir = path.join(tmp, 'tt smoke dir');
  fs.mkdirSync(dir, { recursive: true });
  rm(probe);
  const t1 = await run(WRAPPER, ['new-session', '-d', '-s', 'tt-smoke-cwd', '-c', dir.replace(/\\/g, '/')]);
  await sleep(1500);
  await run(WRAPPER, ['send-keys', '-t', 'tt-smoke-cwd', 'cd > "' + probe + '"', 'Enter']);
  const got1 = (await waitFile(probe)) ? fs.readFileSync(probe, 'utf8').trim() : '';
  ck(
    '-c 绝对路径(带空格)改写',
    t1.c === 0 && got1.toLowerCase().replace(/\//g, '\\').endsWith(path.basename(dir).toLowerCase()),
    got1 || JSON.stringify(t1.e),
  );
  await kill('tt-smoke-cwd');

  // 2) sh 路由 + 多参数折叠
  const shF = path.join(tmp, 'tt-smoke-sh.txt');
  rm(shF);
  const shCmd = "echo smoke-ok > '" + shF.replace(/\\/g, '/') + "'; true";
  const t2 = await run(WRAPPER, ['new-session', '-d', '-s', 'tt-smoke-sh', '--', 'sh', '-c', shCmd]);
  const got2 = (await waitFile(shF)) ? fs.readFileSync(shF, 'utf8').trim() : '';
  ck('sh 改写 + 参数折叠', t2.c === 0 && got2 === 'smoke-ok', got2 || JSON.stringify(t2.e));
  await kill('tt-smoke-sh');

  // 3) -- claude --version(验证 claude 解析为绝对路径;remain-on-exit 抓死亡 pane 的屏)
  //    claude 是大二进制,冷启动可能要十几秒 → 轮询"出现版本号"或"pane 以 0 退出"
  await run(WRAPPER, ['set-option', '-g', 'remain-on-exit', 'on']);
  const t3 = await run(WRAPPER, ['new-session', '-d', '-s', 'tt-smoke-claude', '--', 'claude', '--version']);
  let m = null;
  let st = '';
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const cap = await run(WRAPPER, ['capture-pane', '-p', '-S', '-200', '-t', 'tt-smoke-claude']);
    m = cap.o.match(/\d+\.\d+\.\d+/);
    if (m) break;
    const lp = await run(WRAPPER, ['list-panes', '-t', 'tt-smoke-claude', '-F', '#{pane_dead_status}']);
    st = lp.o.trim();
    if (st === '0') break;
  }
  ck('-- claude 解析并运行', t3.c === 0 && (!!m || st === '0'), m ? m[0] : 'status=' + st);
  await run(WRAPPER, ['set-option', '-g', 'remain-on-exit', 'off']);
  await kill('tt-smoke-claude');

  // 3.5) 默认 pane shell 必须是 cmd(包装器把 SHELL 固定为 cmd.exe)
  const t35 = await run(WRAPPER, ['new-session', '-d', '-s', 'tt-smoke-shell']);
  await sleep(1500);
  const cap35 = await run(WRAPPER, ['capture-pane', '-p', '-t', 'tt-smoke-shell']);
  ck('默认 pane shell = cmd', t35.c === 0 && /Microsoft Windows|版本/.test(cap35.o), JSON.stringify(cap35.o.slice(0, 80)));
  await kill('tt-smoke-shell');

  // 4) 退出码透传
  const t4 = await run(WRAPPER, ['has-session', '-t', 'tt-no-such-session']);
  ck('退出码透传(不存在会话 ≠ 0)', t4.c !== 0, 'exit=' + t4.c);

  // 清理:不留 tmux server(下次由 TC 以最新环境重新拉起)
  await kill('tt-smoke-seed');
  await run(WRAPPER, ['kill-server']);

  console.log('\n结果:' + pass + ' 通过,' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
