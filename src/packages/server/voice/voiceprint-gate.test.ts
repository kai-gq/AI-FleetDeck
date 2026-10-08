/**
 * 声纹门禁纯函数单测:配置读取/清洗、请求字段构造(端点守卫)、三态判定(fail-open)。
 * 不触网、不碰真实 tools 目录(全部走临时文件 + env 覆盖)。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VOICEPRINT_SOURCE_ENV,
  buildVoiceprintRequestFields,
  createVoiceprintTracker,
  readVoiceprintConfig,
  resolveVoiceprintPath,
  sanitizeVoiceprintConfig,
  type VoiceprintConfig,
} from './voiceprint-gate.js';

let tmpDir: string;

function writeCfg(obj: unknown, name: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, JSON.stringify(obj), 'utf-8');
  return p;
}

const BASE: VoiceprintConfig = {
  enabled: true,
  speakId: 'spk-uuid-1',
  speakerName: '主人',
};

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-gate-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('readVoiceprintConfig / sanitizeVoiceprintConfig', () => {
  it('缺文件 → null(未启用 = 零行为变化)', () => {
    const env = { [VOICEPRINT_SOURCE_ENV]: path.join(tmpDir, 'nope.json') };
    expect(readVoiceprintConfig(env)).toBeNull();
  });

  it('损坏 JSON → null(永不抛)', () => {
    const p = path.join(tmpDir, 'broken.json');
    fs.writeFileSync(p, '{not json', 'utf-8');
    expect(readVoiceprintConfig({ [VOICEPRINT_SOURCE_ENV]: p })).toBeNull();
  });

  it('正常文件:读取 + 默认名「主人」+ 组/版本清洗', () => {
    const p = writeCfg({ enabled: true, speakId: 'spk-uuid-1', groupId: ' grp-1 ', ssdVersion: '200' }, 'ok.json');
    const cfg = readVoiceprintConfig({ [VOICEPRINT_SOURCE_ENV]: p });
    expect(cfg).toEqual({
      enabled: true,
      speakId: 'spk-uuid-1',
      groupId: 'grp-1',
      speakerName: '主人',
      ssdVersion: '200',
    });
  });

  it('enabled 但无 speakId → enabled 降为 false(宁可不做门禁,不误伤全部语音)', () => {
    const p = writeCfg({ enabled: true, speakId: '', speakerName: '主人' }, 'nospeakid.json');
    const cfg = readVoiceprintConfig({ [VOICEPRINT_SOURCE_ENV]: p });
    expect(cfg?.enabled).toBe(false);
  });

  it('垃圾输入(数组/字符串/数字)→ null', () => {
    expect(sanitizeVoiceprintConfig([1, 2])).toBeNull();
    expect(sanitizeVoiceprintConfig('x')).toBeNull();
    expect(sanitizeVoiceprintConfig(7)).toBeNull();
    expect(sanitizeVoiceprintConfig(null)).toBeNull();
  });

  it('resolveVoiceprintPath:env 覆盖优先,否则落在 tools/voice-companion 下', () => {
    expect(resolveVoiceprintPath({ [VOICEPRINT_SOURCE_ENV]: 'X:/tmp/vp.json' })).toBe('X:/tmp/vp.json');
    expect(resolveVoiceprintPath({})).toContain(path.join('tools', 'voice-companion', 'voiceprint.local.json'));
  });
});

describe('buildVoiceprintRequestFields', () => {
  it('未启用/null → 空字段、无原因(请求逐字节同旧)', () => {
    expect(buildVoiceprintRequestFields(null, 'bigmodel_async')).toEqual({
      active: false,
      fields: {},
      reason: null,
    });
    expect(buildVoiceprintRequestFields({ ...BASE, enabled: false }, 'bigmodel_async').active).toBe(false);
  });

  it('启用 + bigmodel_async → ssd_mode=2 / enable_speaker_info / enable_nonstream / 1:1 voiceprints', () => {
    const plan = buildVoiceprintRequestFields(BASE, 'bigmodel_async');
    expect(plan.active).toBe(true);
    expect(plan.reason).toBeNull();
    expect(plan.fields).toEqual({
      enable_speaker_info: true,
      enable_nonstream: true,
      ssd_mode: 2,
      voiceprints: [{ id: 'spk-uuid-1' }],
    });
  });

  it('带组 → 组内匹配形态;带 ssdVersion → 透传 ssd_version', () => {
    const plan = buildVoiceprintRequestFields(
      { ...BASE, groupId: 'grp-1', ssdVersion: '200' },
      'bigmodel_async',
    );
    expect(plan.fields.voiceprints).toEqual([{ id: 'spk-uuid-1', group_id: 'grp-1' }]);
    expect(plan.fields.ssd_version).toBe('200');
  });

  it('端点非 bigmodel_async → 跳过并给出原因(不改请求)', () => {
    for (const endpoint of ['bigmodel', 'bigmodel_nostream']) {
      const plan = buildVoiceprintRequestFields(BASE, endpoint);
      expect(plan.active).toBe(false);
      expect(plan.fields).toEqual({});
      expect(plan.reason).toContain(endpoint);
    }
  });
});

describe('createVoiceprintTracker 三态判定', () => {
  const utterance = (text: string, definite: boolean, speakerId?: string) => ({
    text,
    definite,
    additions: speakerId ? { speaker_id: speakerId } : {},
  });

  it('无有效响应 → unknown(fail-open 放行)', () => {
    const t = createVoiceprintTracker(BASE);
    expect(t.verdict()).toBe('unknown');
    for (const garbage of [null, undefined, 0, 'x', {}, { result: {} }, { result: { utterances: 'x' } }]) {
      t.notePayload(garbage);
    }
    expect(t.verdict()).toBe('unknown');
  });

  it('definite 分句 speaker_id = 声纹名称 → matched', () => {
    const t = createVoiceprintTracker(BASE);
    t.notePayload({ result: { utterances: [utterance('帮我查天气', true, '主人')] } });
    expect(t.verdict()).toBe('matched');
    expect(t.speakerIds()).toEqual(['主人']);
    expect(t.definiteCount()).toBe(1);
  });

  it('definite 分句 speaker_id = speakId(任意大小写)→ matched', () => {
    const t = createVoiceprintTracker({ ...BASE, speakId: 'ABC-UUID' });
    t.notePayload({ result: { utterances: [utterance('嗯', true, 'abc-uuid')] } });
    expect(t.verdict()).toBe('matched');
  });

  it('一次性词数:带后缀的声纹名(主人(1))前缀命中 → matched(防误杀本人)', () => {
    const t = createVoiceprintTracker(BASE);
    t.notePayload({ result: { utterances: [utterance('你好', true, '主人(1)')] } });
    expect(t.verdict()).toBe('matched');
  });

  it('definite 分句有 speaker_id 但全不命中 → rejected(明确非本人)', () => {
    const t = createVoiceprintTracker(BASE);
    t.notePayload({ result: { utterances: [utterance('今天下雨', true, '2')] } });
    expect(t.verdict()).toBe('rejected');
  });

  it('只有非 definite 分句带 id → unknown(fail-open;稳定分句没证据不误杀)', () => {
    const t = createVoiceprintTracker(BASE);
    t.notePayload({ result: { utterances: [utterance('电', false, '2')] } });
    expect(t.speakerIds()).toEqual(['2']);
    expect(t.definiteCount()).toBe(0);
    expect(t.verdict()).toBe('unknown');
  });

  it('多分句:任一命中即 matched;跨帧累积', () => {
    const t = createVoiceprintTracker(BASE);
    t.notePayload({ result: { utterances: [utterance('嗯', false, '1')] } });
    t.notePayload({ result: { utterances: [utterance('帮我订票', true, '1')] } });
    expect(t.verdict()).toBe('rejected'); // 目前只有一个非本人 definite 分句
    t.notePayload({ result: { utterances: [utterance('顺便查天气', true, '主人')] } });
    expect(t.verdict()).toBe('matched');
    expect(t.speakerIds()).toEqual(['1', '主人']);
    expect(t.definiteCount()).toBe(2);
  });

  it('definite 但无 additions/speaker_id → unknown,计数照记', () => {
    const t = createVoiceprintTracker(BASE);
    t.notePayload({ result: { utterances: [utterance('好', true)] } });
    expect(t.definiteCount()).toBe(1);
    expect(t.verdict()).toBe('unknown');
  });
});
