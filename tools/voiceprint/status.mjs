#!/usr/bin/env node
/**
 * 声纹门禁管理 —— 查看/开关/清理(配合 enroll.mjs)
 *
 * 用法:
 *   node tools/voiceprint/status.mjs                 # 本地配置摘要 + 云端注册状态
 *   node tools/voiceprint/status.mjs --off           # 门禁关闭(回滚开关;识别链路立即恢复原样)
 *   node tools/voiceprint/status.mjs --on            # 门禁重新打开
 *   node tools/voiceprint/status.mjs --list          # 列出账号下全部声纹
 *   node tools/voiceprint/status.mjs --delete <SpeakId>   # 云端软删除一条声纹(清理用)
 *
 * 环境变量 TC_VOICE_VOICEPRINT_SOURCE 可改写本地配置文件路径(默认
 * tools/voice-companion/voiceprint.local.json)。绝不打印 apiKey。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_FILE = path.join(ROOT, 'tools', 'voice-companion', 'config.json');
const INVOKE_BASE = 'https://openspeech.bytedance.com/api/proxy/invoke';

function outPath() {
  const override = (process.env.TC_VOICE_VOICEPRINT_SOURCE || '').trim();
  return override || path.join(ROOT, 'tools', 'voice-companion', 'voiceprint.local.json');
}

function fail(msg, code = 1) {
  console.error(`✗ ${msg}`);
  process.exit(code);
}

function readApiKey() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (err) {
    fail(`读取 ${CONFIG_FILE} 失败:${err.message}`);
  }
  const key = raw?.stt?.volcengine?.apiKey;
  if (typeof key !== 'string' || !key.trim()) fail('config.json 的 stt.volcengine.apiKey 为空');
  return key.trim();
}

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

function explain(json, text, httpStatus) {
  if (!json) return `HTTP ${httpStatus},非 JSON 响应:${text.slice(0, 400)}`;
  const err = json?.ResponseMetadata?.Error;
  const errPart = err && String(err.Code) !== '0' ? ` 错误:${err.Code}:${err.Message ?? ''}` : '';
  return `${JSON.stringify(json.Result ?? json)}${errPart}`;
}

function localSummary() {
  const target = outPath();
  if (!fs.existsSync(target)) {
    console.log(`本地配置:${target} 不存在 → 门禁未启用(识别链路零变化)`);
    return null;
  }
  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(target, 'utf-8'));
  } catch (err) {
    fail(`本地配置损坏:${err.message}(删除该文件即可回滚)`);
  }
  console.log(`本地配置:${target}`);
  console.log(`  enabled     : ${cfg?.enabled === true ? 'true(门禁生效中)' : 'false(已关闭)'}`);
  console.log(`  speakId     : ${cfg?.speakId ?? '(空)'}`);
  console.log(`  speakerName : ${cfg?.speakerName ?? '(空)'}`);
  if (cfg?.groupId) console.log(`  groupId     : ${cfg.groupId}`);
  if (cfg?.ssdVersion) console.log(`  ssdVersion  : ${cfg.ssdVersion}`);
  return cfg;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = argv[0];

  if (arg === '--off' || arg === '--on') {
    const target = outPath();
    if (!fs.existsSync(target)) fail(`没有本地配置可改:${target}(先跑 enroll.mjs 注册)`);
    const cfg = JSON.parse(fs.readFileSync(target, 'utf-8'));
    if (arg === '--on' && !cfg?.speakId) fail('本地配置里没有 speakId,不能打开门禁(先跑 enroll.mjs)');
    cfg.enabled = arg === '--on';
    fs.writeFileSync(target, JSON.stringify(cfg, null, 2), 'utf-8');
    console.log(`✓ 已${arg === '--on' ? '打开' : '关闭'}声纹门禁:${target}(enabled=${cfg.enabled})`);
    if (arg === '--off') console.log('  下一段话起生效(每段话建会话时现读配置)。');
    return;
  }

  const apiKey = readApiKey();

  if (arg === '--delete') {
    const speakId = argv[1];
    if (!speakId) fail('用法:--delete <SpeakId>');
    const r = await invoke(apiKey, 'UpdateVoiceprint', { Action: 2, SpeakId: speakId });
    console.log(`软删除 ${speakId}:${explain(r.json, r.text, r.httpStatus)}`);
    return;
  }

  if (arg === '--list') {
    const r = await invoke(apiKey, 'ListVoiceprint', { Limit: 50, Offset: 0 });
    console.log(`云端声纹列表:${explain(r.json, r.text, r.httpStatus)}`);
    return;
  }

  const cfg = localSummary();
  if (!cfg?.speakId) return;
  const body = { SpeakIdList: [cfg.speakId] };
  if (cfg.groupId) body.GroupId = cfg.groupId;
  const r = await invoke(apiKey, 'GetVoiceprint', body);
  console.log(`云端注册状态:${explain(r.json, r.text, r.httpStatus)}`);
}

main().catch((err) => fail(err?.stack || String(err)));
