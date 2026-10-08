/**
 * 声纹「只认主人」门禁(SAUC 短音频声纹识别 · ssd_mode=2)
 *
 * 目的:语音伙伴链路里只有用户本人的声音进大脑;家人/电视背景音被静默丢弃。
 * 原理:建会话请求追加 enable_speaker_info / enable_nonstream / ssd_mode=2 /
 *   voiceprints(见 buildVoiceprintRequestFields),服务端在 utterances[].additions.
 *   speaker_id 返回说话人标识 —— 声纹匹配成功时替换为声纹名称,故判定:
 *     matched  任一 definite 分句的 speaker_id 命中本人(名称或 speakId)→ 放行;
 *     rejected 拿到过 speaker_id 但全部不命中 → 明确非本人 → 丢弃(stream 层转空 final);
 *     unknown  拿不到说话人信息(资源不支持/极短句)→ fail-open 放行,防误伤「嗯/好」。
 *
 * 存储:<cwd>/tools/voice-companion/voiceprint.local.json(gitignored;注册工具
 *   tools/voiceprint/enroll.mjs 写入);TC_VOICE_VOICEPRINT_SOURCE 可覆盖(测试沙箱用)。
 * 缺文件/损坏 → null(未启用)= 识别链路零行为变化;任何异常绝不抛(门禁永不阻断识别)。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { VolcengineEndpoint } from '../services/voice-companion-service.js';

export const VOICEPRINT_SOURCE_ENV = 'TC_VOICE_VOICEPRINT_SOURCE';
const VOICEPRINT_REL_PATH = path.join('tools', 'voice-companion', 'voiceprint.local.json');
const NAME_MAX_CHARS = 40;
const ID_MAX_CHARS = 64;

export interface VoiceprintConfig {
  /** 仅当 enabled=true 且 speakId 非空才真正生效(见 sanitizeVoiceprintConfig)。 */
  enabled: boolean;
  /** 注册接口返回的声纹 ID(UUID);判定时与 speakerName 一起作为「本人」标识。 */
  speakId: string;
  /** 声纹组(可选;enroll.mjs --group-* 注册时带上,1:1 认主可不配)。 */
  groupId?: string;
  /** 注册时的说话人名(匹配成功时服务端把 speaker_id 替换为它)。 */
  speakerName: string;
  /** 实验开关:部分资源需要 ssd_version(如 "200");未配置则不发该字段。 */
  ssdVersion?: string;
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** 宽松清洗 + 启用判定(永不抛);垃圾输入 → null(视为未配置)。 */
export function sanitizeVoiceprintConfig(raw: unknown): VoiceprintConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const speakId = str(o.speakId, ID_MAX_CHARS);
  const groupId = str(o.groupId, ID_MAX_CHARS);
  const speakerName = str(o.speakerName, NAME_MAX_CHARS) || '主人';
  const ssdVersion = str(o.ssdVersion, 16);
  return {
    // 没注册到声纹(enabled 却无 speakId)= 未启用:宁可不做门禁,不误伤全部语音
    enabled: o.enabled === true && !!speakId,
    speakId,
    ...(groupId ? { groupId } : {}),
    speakerName,
    ...(ssdVersion ? { ssdVersion } : {}),
  };
}

export function resolveVoiceprintPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env[VOICEPRINT_SOURCE_ENV] ?? '').trim();
  return override || path.join(process.cwd(), VOICEPRINT_REL_PATH);
}

/** 读取(缺文件/损坏 → null);任何异常绝不抛。 */
export function readVoiceprintConfig(env: NodeJS.ProcessEnv = process.env): VoiceprintConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(resolveVoiceprintPath(env), 'utf-8'));
    return sanitizeVoiceprintConfig(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 建会话请求字段
// ---------------------------------------------------------------------------

export interface VoiceprintRequestPlan {
  /** true = 本会话启用声纹(fields 已就绪,须合并进 request)。 */
  active: boolean;
  /** 展开进建会话 request 的字段;未启用 = 空对象(请求逐字节同旧)。 */
  fields: Record<string, unknown>;
  /** 已启用但被跳过时的原因(供 onLog);未启用 = null。 */
  reason: string | null;
}

/**
 * 声纹请求字段(官方短音频声纹识别要求:仅二遍双向链路)。
 * 端点非 bigmodel_async → 整体跳过并给出原因,绝不改动请求。
 */
export function buildVoiceprintRequestFields(
  cfg: VoiceprintConfig | null,
  endpoint: VolcengineEndpoint | string,
): VoiceprintRequestPlan {
  if (!cfg || !cfg.enabled || !cfg.speakId) return { active: false, fields: {}, reason: null };
  if (endpoint !== 'bigmodel_async') {
    return {
      active: false,
      fields: {},
      reason: `端点 ${endpoint} 不支持声纹门禁(短音频声纹需 bigmodel_async 二遍链路)`,
    };
  }
  // 1:1 身份验证 = 只传 id;带组 = 组内匹配(仍只注册了本人一个声纹)
  const entry: Record<string, unknown> = cfg.groupId
    ? { id: cfg.speakId, group_id: cfg.groupId }
    : { id: cfg.speakId };
  const fields: Record<string, unknown> = {
    enable_speaker_info: true,
    enable_nonstream: true,
    ssd_mode: 2,
    voiceprints: [entry],
  };
  if (cfg.ssdVersion) fields.ssd_version = cfg.ssdVersion;
  return { active: true, fields, reason: null };
}

// ---------------------------------------------------------------------------
// 响应判定(帧累积 → 判定)
// ---------------------------------------------------------------------------

export type VoiceprintVerdict = 'matched' | 'rejected' | 'unknown';

/** 会随 onFinal meta 外传的判定(unknown = 无证据,fail-open,不外传)。 */
export type VoiceprintSignal = Exclude<VoiceprintVerdict, 'unknown'>;

export interface VoiceprintTracker {
  /** 喂一帧服务端结果 payload(任意帧可重复喂;非对象/无 utterances 忽略,永不抛)。 */
  notePayload(payload: unknown): void;
  /** 判定(见文件头三态;本段内任一 definite 分句命中即 matched)。 */
  verdict(): VoiceprintVerdict;
  /** 观测:出现过的全部 speaker_id(去重、出现序;供日志排查)。 */
  speakerIds(): string[];
  /** 观测:definite 分句计数(≥1 而 ids 为空 = 服务端未附加说话人信息)。 */
  definiteCount(): number;
}

/**
 * 本段(一个 ASR 会话)的说话人追踪。
 * 注意:会话内若先有他人短句、后有本人分句 → any-match 放行整段(切段由客户端
 * VAD 负责,门禁不拆分文本;单人近场使用下不构成问题)。
 */
export function createVoiceprintTracker(cfg: VoiceprintConfig): VoiceprintTracker {
  const targets: string[] = [];
  for (const t of [cfg.speakerName, cfg.speakId]) {
    const v = t.trim().toLowerCase();
    if (v && !targets.includes(v)) targets.push(v);
  }
  const allIds: string[] = [];
  const definiteIds: string[] = [];
  let definiteCount = 0;
  let matched = false;

  const matches = (id: string): boolean => {
    const v = id.toLowerCase();
    return targets.some((t) => {
      // 务实匹配:有声纹资源把名称带后缀返回(如「主人(1)」),前缀也算命中 ——
      // 误判方向是「放行本人」,比把本人静音安全(未注册者的 id 是数字,不会撞中文名)。
      return v === t || v.startsWith(t);
    });
  };

  return {
    notePayload(payload: unknown): void {
      const utterances = (payload as { result?: { utterances?: unknown } } | null)?.result?.utterances;
      if (!Array.isArray(utterances)) return;
      for (const u of utterances) {
        if (!u || typeof u !== 'object') continue;
        const entry = u as { definite?: unknown; additions?: { speaker_id?: unknown } };
        const definite = entry.definite === true;
        if (definite) definiteCount += 1;
        const id = typeof entry.additions?.speaker_id === 'string' ? entry.additions.speaker_id.trim() : '';
        if (!id) continue;
        if (!allIds.includes(id)) allIds.push(id);
        if (definite && !definiteIds.includes(id)) definiteIds.push(id);
        if (definite && matches(id)) matched = true;
      }
    },
    verdict(): VoiceprintVerdict {
      if (matched) return 'matched';
      return definiteIds.length > 0 ? 'rejected' : 'unknown';
    },
    speakerIds(): string[] {
      return [...allIds];
    },
    definiteCount(): number {
      return definiteCount;
    },
  };
}
