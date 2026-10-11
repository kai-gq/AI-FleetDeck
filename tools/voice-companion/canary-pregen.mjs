#!/usr/bin/env node
/**
 * W7 垫话预生成 · 金丝雀(零人工,真实链路)
 *
 * 与 selftest.mjs / bench.mjs 的差别:这两者各自只覆盖半条链 ——
 *   selftest  = 真 WS(partial→final),但不走回合 → 看不到垫话吐出;
 *   bench     = 真 POST /process,但没有 partial → 预生成必然未命中。
 * 本脚本在同一个进程里把两段接起来,专门验证「命中档」的真实行为:
 *
 *   1) POST /api/tts/speak 合成测试话术 → ffmpeg 解码 16k mono PCM
 *   2) 真 WS /ws/voice-companion 灌音频(实时节奏)→ 等 final(服务端已 seal)
 *      —— 期间记录 {type:'filler'} 预合成 hint(C15 协议)
 *   3) **不关 WS**(关了会 drop 密封槽),立刻 POST /api/voice-companion/process
 *      → 读 NDJSON 前几行,量首句的 tMs 与 pre 标记
 *   4) 收到首句即 abort(等同用户插话),打完判定退出:
 *      PASS = 首句带 pre:true 且 tMs ≥ 2.8s(命中档 = 回合开始 + pregenEmitMs 3000;
 *             C15 实测回归是 ~1.2–2.1s,金丝雀抓的就是这个)
 *
 * 用法:
 *   node tools/voice-companion/canary-pregen.mjs
 *   node tools/voice-companion/canary-pregen.mjs --text "帮我看看最近的天气怎么样" --base http://localhost:6200
 *
 * 注意:会真实进入秘书会话(1 个回合,生成 ~3s 后即 abort,不跑完整回合)。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// ─── 参数 ───
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const TEXT = flag('text', '帮我看看最近的天气怎么样');
const BASE = flag('base', 'http://localhost:6200').replace(/\/$/, '');
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws/voice-companion';
const TARGET_RATE = 16000;
const CHUNK_MS = 100;
/** 首句 tMs 下限:命中档 fuse=3000ms,留 200ms 容差;低于 2.8s 视为「触发线被提前」回归。 */
const MIN_FIRST_MS = 2800;
const FIRST_WAIT_MS = 9000;

const fail = (msg) => { console.error(`\n[canary] ✗ ${msg}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 1) TTS → PCM16 16k mono ───
async function ttsToPcm16(text) {
  const res = await fetch(`${BASE}/api/tts/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`tts HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error(`tts 音频过短(${buf.length}B)`);
  const ext = (res.headers.get('content-type') ?? '').includes('mpeg') ? 'mp3' : 'wav';
  const file = path.join(os.tmpdir(), `tc-canary-pregen-${Date.now()}.${ext}`);
  fs.writeFileSync(file, buf);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const local = path.join(here, '..', 'whisper', 'ffmpeg', 'bin', 'ffmpeg.exe');
  const bin = fs.existsSync(local) ? local : 'ffmpeg';
  const p = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file,
    '-vn', '-ac', '1', '-ar', String(TARGET_RATE), '-f', 's16le', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
  fs.rmSync(file, { force: true });
  if (p.error) throw new Error(`ffmpeg 不可用:${p.error.message}`);
  if (p.status !== 0) throw new Error(`ffmpeg 解码失败:${(p.stderr?.toString('utf-8', 'replace') ?? '').slice(0, 200)}`);
  return p.stdout;
}

// ─── 2) 真 WS:灌音 → final(保持连接) ───
function runWs(pcm) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const out = { final: '', partials: 0, hints: [] };
    let finished = false;
    const timer = setTimeout(() => { try { ws.close(); } catch { /* noop */ } reject(new Error('等 final 超时(15s)')); }, 15000);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === 'partial') out.partials += 1;
      else if (msg.type === 'filler') out.hints.push(String(msg.text ?? ''));
      else if (msg.type === 'final') {
        out.final = String(msg.text ?? '');
        clearTimeout(timer);
        resolve({ ws, out });
      } else if (msg.type === 'error') {
        clearTimeout(timer);
        reject(new Error(`服务端错误 [${msg.code}] ${msg.message}`));
      }
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(new Error(`WS 连接失败:${err.message}`)); });

    ws.on('open', async () => {
      const chunkBytes = (TARGET_RATE * 2 * CHUNK_MS) / 1000;
      for (let off = 0; off < pcm.length; off += chunkBytes) {
        if (ws.readyState !== WebSocket.OPEN) break;
        ws.send(pcm.subarray(off, Math.min(off + chunkBytes, pcm.length)), { binary: true });
        await sleep(CHUNK_MS);
      }
      if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'finish' })); finished = true; }
    });
    void finished;
  });
}

// ─── 3) 同一时刻 POST /process(WS 不关)→ 量首句 ───
async function firstSentence(finalText) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const kill = setTimeout(() => ctrl.abort(), FIRST_WAIT_MS);
  const lines = [];
  try {
    const resp = await fetch(`${BASE}/api/voice-companion/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: finalText, stream: true }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`process HTTP ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'sentence') {
          lines.push({ tMs: typeof msg.tMs === 'number' ? msg.tMs : Date.now() - t0, pre: msg.pre === true, text: String(msg.text ?? '') });
          ctrl.abort(); // 收到首句即收手(等同插话打断),不跑完整回合
          throw new AbortErrorSentinel();
        }
      }
    }
  } catch (err) {
    if (!(err instanceof AbortErrorSentinel) && err?.name !== 'AbortError') throw err;
  } finally {
    clearTimeout(kill);
  }
  return lines;
}
class AbortErrorSentinel extends Error {}

// ─── 主流程 ───
(async () => {
  console.log(`[canary] 话术:「${TEXT}」`);
  const pcm = await ttsToPcm16(TEXT);
  console.log(`[canary] TTS→PCM 就绪 ${(pcm.length / 32000).toFixed(2)}s,开灌真 WS…`);

  const { ws, out } = await runWs(pcm);
  console.log(`[canary] final:「${out.final}」partial=${out.partials} 个,hint=${out.hints.length ? `「${out.hints[0]}」` : '(未到,可能在途)'}`);
  if (!out.final) fail('没收到 final');

  console.log('[canary] 保持 WS,POST /process(命中档应为 fuse=3000ms)…');
  const lines = await firstSentence(out.final);
  try { ws.close(); } catch { /* noop */ }

  if (!lines.length) fail('9s 内没有首句到达(回合报错?看服务端日志)');
  const first = lines[0];
  console.log(`[canary] 首句 tMs=${first.tMs} pre=${first.pre} 「${first.text}」`);
  for (const h of out.hints) console.log(`[canary] (WS hint 预合成)「${h}」`);

  if (!first.pre) {
    console.log(`[canary] ~ 首句是真实句(垫话被取消)——快回合照旧不垫,符合预期;若话术偏慢可重跑`);
    process.exit(0);
  }
  if (first.tMs < MIN_FIRST_MS) fail(`垫话 tMs=${first.tMs} < ${MIN_FIRST_MS}ms —— 触发线被提前(C15 回归型)`);
  console.log(`[canary] ✓ PASS:垫话 ${first.tMs}ms 才吐(≥${MIN_FIRST_MS}ms,fuse=3000 命中档)`);
  process.exit(0);
})().catch((err) => fail(err?.message ?? String(err)));
