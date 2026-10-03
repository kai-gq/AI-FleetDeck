#!/usr/bin/env node
/**
 * 「语音伙伴」流式转写通道自测(无需麦克风)
 *
 * 把一段 wav 的 PCM 按协议灌进 /ws/voice-companion,打印 partial/final:
 *   node tools/voice-companion/selftest.mjs 样例.wav
 *   node tools/voice-companion/selftest.mjs 样例.wav --url ws://localhost:6200/ws/voice-companion
 *   node tools/voice-companion/selftest.mjs 样例.wav --token <鉴权令牌>        # 开启鉴权时
 *   node tools/voice-companion/selftest.mjs 样例.wav --speed 2               # 2 倍速发送
 *
 * wav 支持 8/16/24/32bit PCM 与任意采样率/声道:自动降混为单声道并线性重采样到
 * 16kHz(与浏览器端 PCM 一致)。仅用于本机排障,凭据永远不出本机。
 *
 * 退出码:0 = 收到 final;1 = 出错/超时(无凭据、识别失败、连不上服务端)。
 */

import fs from 'node:fs';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

if (!file) {
  console.error('用法:node tools/voice-companion/selftest.mjs <样例.wav> [--url ws://…] [--token …] [--speed 1]');
  process.exit(1);
}

const baseUrl = flag('url', 'ws://localhost:6200/ws/voice-companion').replace(/\/$/, '');
const token = flag('token', process.env.VC_TOKEN || '');
const speed = Math.max(0.1, Number(flag('speed', '1')) || 1);
const url = token ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : baseUrl;

const TARGET_RATE = 16000;
const CHUNK_MS = 100;
const FINAL_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// wav → PCM16 / 16k / mono
// ---------------------------------------------------------------------------
function readWav(path) {
  const buf = fs.readFileSync(path);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 RIFF/WAVE 文件');
  }
  let fmt = null;
  let data = null;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    pos = body + size + (size % 2); // chunk 按偶数字节对齐
  }
  if (!fmt || !data) throw new Error('wav 缺少 fmt/data 块');
  if (fmt.format !== 1) throw new Error(`仅支持 PCM wav(当前 format=${fmt.format};请先转成 PCM wav)`);
  return { ...fmt, data };
}

function readSamples({ data, bits }) {
  const bytes = bits / 8;
  const count = Math.floor(data.length / bytes);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const off = i * bytes;
    if (bits === 8) out[i] = (data[off] - 128) / 128;
    else if (bits === 16) out[i] = data.readInt16LE(off) / 32768;
    else if (bits === 24) out[i] = ((data.readUInt8(off) | (data.readUInt8(off + 1) << 8) | (data.readInt8(off + 2) << 16)) / 8388608);
    else if (bits === 32) out[i] = data.readInt32LE(off) / 2147483648;
    else throw new Error(`不支持的位深:${bits}`);
  }
  return out;
}

function toMono(samples, channels) {
  if (channels <= 1) return samples;
  const frames = Math.floor(samples.length / channels);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += samples[f * channels + c];
    out[f] = sum / channels;
  }
  return out;
}

/** 线性插值重采样(自测用,音质足够)。 */
function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = toRate / fromRate;
  const outLen = Math.floor(samples.length * ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = src - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

function toPcm16(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
let pcm;
try {
  const wav = readWav(file);
  const mono = toMono(readSamples(wav), wav.channels);
  const resampled = resample(mono, wav.sampleRate, TARGET_RATE);
  pcm = toPcm16(resampled);
  console.log(`[selftest] ${file}:${wav.sampleRate}Hz ${wav.channels}ch ${wav.bits}bit → 16kHz mono, ${(pcm.length / 32000).toFixed(2)}s`);
} catch (err) {
  console.error(`[selftest] 读取 wav 失败:${err.message}`);
  process.exit(1);
}

const CHUNK_BYTES = (TARGET_RATE * 2 * CHUNK_MS) / 1000; // 100ms = 3200B
const ws = new WebSocket(url);
let sawFinal = false;
let sawPartial = false;
let finished = false;
let finalTimer = null;

const fail = (message) => {
  console.error(`[selftest] ✗ ${message}`);
  try { ws.close(); } catch { /* noop */ }
  process.exit(1);
};

const done = (code) => {
  if (finalTimer) clearTimeout(finalTimer);
  try { ws.close(); } catch { /* noop */ }
  process.exit(code);
};

ws.on('open', () => {
  console.log(`[selftest] 已连接 ${url},开始发送音频(${speed}× 速)…`);
});

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(String(raw)); } catch { return; }
  switch (msg.type) {
    case 'ready':
      console.log(`[selftest] ready(endpoint=${msg.endpoint})`);
      break;
    case 'partial':
      sawPartial = true;
      process.stdout.write(`\r[selftest] partial: ${msg.text}          `);
      break;
    case 'final':
      sawFinal = true;
      process.stdout.write('\n');
      console.log(`[selftest] ✓ final: ${JSON.stringify(msg.text)}${sawPartial ? '(有实时 partial)' : '(无 partial,可能音频过短)'}`);
      done(0);
      break;
    case 'error':
      fail(`服务端错误 [${msg.code}] ${msg.message}`);
      break;
    case 'pong':
      break;
    default:
      console.log(`[selftest] 未知消息:${JSON.stringify(msg)}`);
  }
});

ws.on('error', (err) => fail(`连接失败:${err.message || err.code || String(err)}(服务端没起?端口不对?鉴权模式需 --token)`));
ws.on('close', (code) => {
  if (!sawFinal && !finished) fail(`连接被关闭(code=${code})且未收到 final`);
});

// 分片发送(按真实时间节奏,让火山有机会出 partial)
(async () => {
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const interval = CHUNK_MS / speed;
  let sent = 0;
  for (let off = 0; off < pcm.length; off += CHUNK_BYTES) {
    if (ws.readyState !== WebSocket.OPEN) break;
    ws.send(pcm.subarray(off, Math.min(off + CHUNK_BYTES, pcm.length)), { binary: true });
    sent += Math.min(CHUNK_BYTES, pcm.length - off);
    await new Promise((r) => setTimeout(r, interval));
  }
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'finish' }));
    finished = true;
    console.log(`[selftest] 已发完 ${(sent / 32000).toFixed(2)}s 音频,等待 final…`);
    finalTimer = setTimeout(() => fail(`等待 final 超时(${FINAL_TIMEOUT_MS / 1000}s)`), FINAL_TIMEOUT_MS);
  }
})().catch((err) => fail(err.message));
