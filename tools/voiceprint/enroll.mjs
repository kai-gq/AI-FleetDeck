#!/usr/bin/env node
/**
 * 声纹注册 —— 给语音伙伴大脑加「只认主人」门禁(火山 openspeech 声纹管理接口)
 *
 * 流程:录音/选文件 → ffmpeg 转 16k 单声道 wav → 临时文件床托管(取公网 URL)
 *       → UpdateVoiceprint(Action=0)注册 → 写 tools/voice-companion/voiceprint.local.json
 *
 * 用法:
 *   node tools/voiceprint/enroll.mjs --record [--seconds 20]      # 用本机麦克风直录(默认)
 *   node tools/voiceprint/enroll.mjs --file 某段话.wav|mp3        # 用已有音频(自动转码)
 *   node tools/voiceprint/enroll.mjs --file x.wav --url https://… # 跳过上传,自备公网 URL
 *   node tools/voiceprint/enroll.mjs --record --name 主人 --group-name 我家  # 可选:建声纹组
 *
 * 要点:
 *   - 注册音频规格 5~30 秒;务必用「平时对电脑说话的同一支麦克风/同一设备」录,
 *     换设备会显著掉准确率(官方明确)。录的时候正常说话,别刻意压嗓。
 *   - 采样会短暂上传到临时文件床(litterbox 1 小时自动删;失败依次退 uguu.se / 0x0.st);
 *     介意隐私可用 --url 自己传一个公网可下载地址。
 *   - 绝不打印 apiKey;输出只有 SpeakId/名称等摘要。
 *   - 环境变量 TC_VOICE_VOICEPRINT_SOURCE 可改写本地配置文件路径(烟测/多套声纹用)。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Blob } from 'node:buffer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FFMPEG = path.join(ROOT, 'tools', 'whisper', 'ffmpeg', 'bin', 'ffmpeg.exe');
const CONFIG_FILE = path.join(ROOT, 'tools', 'voice-companion', 'config.json');
const SAMPLES_DIR = path.join(ROOT, 'tools', 'voiceprint', 'samples');
const INVOKE_BASE = 'https://openspeech.bytedance.com/api/proxy/invoke';

function outPath() {
  const override = (process.env.TC_VOICE_VOICEPRINT_SOURCE || '').trim();
  return override || path.join(ROOT, 'tools', 'voice-companion', 'voiceprint.local.json');
}

function fail(msg, code = 1) {
  console.error(`\n✗ ${msg}`);
  process.exit(code);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function parseArgs(argv) {
  const args = { record: false, seconds: 20, device: '', file: '', url: '', name: '主人', groupName: '', groupId: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) fail(`参数 ${a} 缺值`);
      i += 1;
      return v;
    };
    if (a === '--record') args.record = true;
    else if (a === '--seconds') args.seconds = Number(next());
    else if (a === '--device') args.device = next();
    else if (a === '--file') args.file = next();
    else if (a === '--url') args.url = next();
    else if (a === '--name') args.name = next();
    else if (a === '--group-name') args.groupName = next();
    else if (a === '--group-id') args.groupId = next();
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('*/')[0].split('/**')[1]);
      process.exit(0);
    } else fail(`未知参数:${a}(--help 看用法)`);
  }
  if (!args.record && !args.file && !args.url) args.record = true; // 默认:直录
  if (!Number.isFinite(args.seconds)) fail('--seconds 必须是数字');
  args.seconds = Math.max(5, Math.min(30, Math.round(args.seconds))); // 官方规格 5~30s
  return args;
}

function readApiKey() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (err) {
    fail(`读取 ${CONFIG_FILE} 失败:${err.message}`);
  }
  const key = raw?.stt?.volcengine?.apiKey;
  if (typeof key !== 'string' || !key.trim()) {
    fail('config.json 的 stt.volcengine.apiKey 为空 —— 声纹管理接口需要新版 X-Api-Key 凭据(工具箱 → 语音伙伴 配好再试)');
  }
  return key.trim();
}

// ---------------------------------------------------------------------------
// 采样:录音 / 转码
// ---------------------------------------------------------------------------

function runFfmpeg(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', ...args], { encoding: 'buffer' });
  const stderr = (r.stderr ?? Buffer.alloc(0)).toString('utf-8');
  return { status: r.status, stderr };
}

function lastLines(text, n = 6) {
  return text.trim().split(/\r?\n/).slice(-n).join('\n');
}

function listAudioDevices() {
  const { stderr } = runFfmpeg(['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
  const devices = [];
  let inAudio = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (line.includes('DirectShow audio devices')) inAudio = true;
    else if (line.includes('DirectShow video devices')) inAudio = false;
    else if (inAudio) {
      const m = line.match(/\]\s+"(.+)"\s*$/);
      if (m) devices.push(m[1]);
    }
  }
  return devices;
}

function record(seconds, deviceArg) {
  if (!fs.existsSync(FFMPEG)) fail(`找不到 ffmpeg:${FFMPEG}`);
  const devices = listAudioDevices();
  if (devices.length === 0) fail('ffmpeg 枚举不到录音设备(检查麦克风连接)');
  const device = deviceArg || devices[0];
  console.log(`可用录音设备:\n  - ${devices.join('\n  - ')}`);
  if (deviceArg && !devices.includes(deviceArg)) {
    console.log(`提示:--device 不在枚举列表,仍按原样尝试。`);
  }
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  const wav = path.join(SAMPLES_DIR, `sample-${stamp()}.wav`);
  console.log(`\n● 开始录音 ${seconds} 秒 —— 现在开始,用平时对电脑说话的音量和距离,说满全程`);
  console.log(`  设备:${device}\n`);
  const { status, stderr } = runFfmpeg([
    '-y', '-f', 'dshow', '-i', `audio=${device}`,
    '-t', String(seconds), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav,
  ]);
  if (status !== 0 || !fs.existsSync(wav)) {
    fail(`录音失败(ffmpeg exit=${status})。常见原因:麦克风被占用(先在 TC 里关掉语音聆听)、设备名不对。\n--- ffmpeg 输出 ---\n${lastLines(stderr)}`);
  }
  console.log(`● 录音完成:${path.relative(ROOT, wav)}`);
  return wav;
}

function toWav16k(inputPath) {
  if (!fs.existsSync(inputPath)) fail(`文件不存在:${inputPath}`);
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  const wav = path.join(SAMPLES_DIR, `sample-${stamp()}.wav`);
  const { status, stderr } = runFfmpeg(['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
  if (status !== 0 || !fs.existsSync(wav)) {
    fail(`转码失败(ffmpeg exit=${status})\n--- ffmpeg 输出 ---\n${lastLines(stderr)}`);
  }
  return wav;
}

/** 从 WAV 头取音频时长(16k 单声道 16bit;本脚本产物专用)。 */
function wavSeconds(buf) {
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return size / (16000 * 2);
    off += 8 + size + (size % 2);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 托管:临时文件床(公网可下载 URL;注册接口要求服务端自己去拉)
// ---------------------------------------------------------------------------

async function uploadLitterbox(buf, filename) {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('time', '1h');
  form.append('fileToUpload', new Blob([buf], { type: 'audio/wav' }), filename);
  const res = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', { method: 'POST', body: form });
  const text = (await res.text()).trim();
  if (!res.ok || !/^https?:\/\//.test(text)) throw new Error(`litterbox HTTP ${res.status}:${text.slice(0, 120)}`);
  return text;
}

async function uploadUguu(buf, filename) {
  const form = new FormData();
  form.append('files[]', new Blob([buf], { type: 'audio/wav' }), filename);
  const res = await fetch('https://uguu.se/upload?output=text', { method: 'POST', body: form });
  const text = (await res.text()).trim();
  if (!res.ok || !/^https?:\/\//.test(text)) throw new Error(`uguu.se HTTP ${res.status}:${text.slice(0, 120)}`);
  return text;
}

async function upload0x0(buf, filename) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/wav' }), filename);
  const res = await fetch('https://0x0.st', { method: 'POST', body: form });
  const text = (await res.text()).trim();
  if (!res.ok || !/^https?:\/\//.test(text)) throw new Error(`0x0.st HTTP ${res.status}:${text.slice(0, 120)}`);
  return text;
}

async function uploadSample(wav) {
  const buf = fs.readFileSync(wav);
  const filename = path.basename(wav);
  const hosts = [
    ['litterbox(1h 后自动删)', uploadLitterbox],
    ['uguu.se', uploadUguu],
    ['0x0.st', upload0x0],
  ];
  for (const [label, fn] of hosts) {
    try {
      process.stdout.write(`● 上传采样(${label})…`);
      const url = await fn(buf, filename);
      console.log(' 完成');
      console.log(`  URL:${url}`);
      return url;
    } catch (err) {
      console.log(` 失败:${err.message}`);
    }
  }
  fail('所有临时文件床都上传失败 —— 可手动上传后重跑:`node tools/voiceprint/enroll.mjs --file <wav> --url <公网URL>');
}

// ---------------------------------------------------------------------------
// 注册(openspeech 声纹管理接口 · TOP)
// ---------------------------------------------------------------------------

async function invoke(apiKey, action, body) {
  const res = await fetch(`${INVOKE_BASE}?Action=${encodeURIComponent(action)}`, {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 保留原文 */
  }
  return { httpStatus: res.status, json, text };
}

function topError(json) {
  const err = json?.ResponseMetadata?.Error;
  if (err && err.Code !== undefined && String(err.Code) !== '0') return `${err.Code}:${err.Message ?? ''}`;
  return '';
}

function extractString(json, keys) {
  const result = json?.Result;
  if (!result || typeof result !== 'object') return '';
  for (const k of keys) {
    const v = result[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

async function createGroup(apiKey, groupName) {
  console.log(`● 创建声纹组「${groupName}」…`);
  const r = await invoke(apiKey, 'CreateVoiceprintGroup', { GroupName: groupName });
  const topErr = topError(r.json);
  if (topErr || !r.json) {
    fail(`建组失败(HTTP ${r.httpStatus})${topErr ? ` ${topErr}` : ''}:\n${r.text.slice(0, 500)}`);
  }
  const groupId = extractString(r.json, ['GroupId', 'groupId', 'GroupID']);
  if (!groupId) fail(`建组响应里没找到 GroupId,原文:\n${r.text.slice(0, 800)}`);
  console.log(`  组 ID:${groupId}`);
  return groupId;
}

async function register(apiKey, { audioUrl, speakerName, groupId }) {
  console.log('● 注册声纹(UpdateVoiceprint)…');
  const body = { Action: 0, AudioUrl: audioUrl, SpeakerName: speakerName };
  if (groupId) body.GroupId = groupId;
  const r = await invoke(apiKey, 'UpdateVoiceprint', body);
  const topErr = topError(r.json);
  if (r.json) {
    if (r.json.ResponseMetadata) console.log(`  ResponseMetadata:${JSON.stringify(r.json.ResponseMetadata)}`);
    if (r.json.Result !== undefined) console.log(`  Result:${JSON.stringify(r.json.Result)}`);
  }
  if (!r.json) fail(`注册响应不是 JSON(HTTP ${r.httpStatus}):\n${r.text.slice(0, 800)}`);
  if (topErr) fail(`注册被拒:${topErr}`);
  const code = r.json.Result?.Code;
  if (code !== undefined && String(code) !== '1000') {
    fail(`注册失败:Result.Code=${code}(176=不存在 / 177=提取失败 / 179=超上限),原文:\n${JSON.stringify(r.json.Result)}`);
  }
  const speakId = extractString(r.json, ['SpeakId', 'speakId', 'SpeakID', 'speak_id']);
  if (!speakId) {
    const list = r.json.Result?.SpeakIdList ?? r.json.Result?.speakIdList;
    if (Array.isArray(list) && list.length > 0) {
      const first = list[0];
      if (typeof first === 'string') return first;
      const v = first?.SpeakId ?? first?.speakId ?? first?.id;
      if (typeof v === 'string' && v) return v;
    }
    fail(`注册响应里没找到 SpeakId(可能已注册成功,请核对上面 Result 原文;勿重复提交)`);
  }
  return speakId;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = readApiKey();

  let wav = '';
  if (args.file) {
    console.log(`● 转码 ${args.file} → 16k 单声道 wav…`);
    wav = toWav16k(args.file);
  } else if (args.record) {
    wav = record(args.seconds, args.device);
  } else if (!args.url) {
    fail('需要 --record / --file / --url 之一');
  }

  if (wav) {
    const seconds = wavSeconds(fs.readFileSync(wav));
    console.log(`  采样时长:${seconds.toFixed(1)}s(官方规格 5~30s)`);
    if (seconds < 4.5) fail(`采样有效音频太短(${seconds.toFixed(1)}s),请重录更长的连续说话`);
  }

  const audioUrl = args.url || (await uploadSample(wav));

  const groupId = args.groupId || (args.groupName ? await createGroup(apiKey, args.groupName) : '');
  const speakId = await register(apiKey, { audioUrl, speakerName: args.name, groupId });

  const target = outPath();
  const cfg = {
    enabled: true,
    speakId,
    speakerName: args.name,
    ...(groupId ? { groupId } : {}),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(target, JSON.stringify(cfg, null, 2), 'utf-8');

  console.log('\n✓ 注册成功');
  console.log(`  SpeakId:${speakId}`);
  console.log(`  说话人名:${args.name}${groupId ? `(组:${groupId})` : ''}`);
  console.log(`  门禁配置:${target}(enabled=true)`);
  console.log('\n下一步:让语音伙伴跑一段语音,观察服务端日志里的「声纹判定 …」行;');
  console.log('回滚:node tools/voiceprint/status.mjs --off(或删除上面这个配置文件)。');
}

main().catch((err) => fail(err?.stack || String(err)));
