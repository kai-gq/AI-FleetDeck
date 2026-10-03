/**
 * TTS 路由层纯函数测试(P6:语速/音量)
 *
 * 只测两个导出纯函数(不 spawn piper):
 *   parseTuningValue  - 请求参数解析:缺失/非法 → undefined(不追加),越界钳到 ±100
 *   buildPiperArgs    - 参数组装:只在显式给值时追加 --rate/--volume
 */

import { describe, expect, it } from 'vitest';
import { buildPiperArgs, parseTuningValue } from './tts.js';

describe('parseTuningValue', () => {
  it('treats missing / empty / null as undefined (参数不追加)', () => {
    expect(parseTuningValue(undefined)).toBeUndefined();
    expect(parseTuningValue(null)).toBeUndefined();
    expect(parseTuningValue('')).toBeUndefined();
  });

  it('passes through finite numbers, including explicit 0', () => {
    expect(parseTuningValue(10)).toBe(10);
    expect(parseTuningValue(-5)).toBe(-5);
    expect(parseTuningValue(0)).toBe(0);
  });

  it('parses numeric strings with optional sign / percent / spaces', () => {
    expect(parseTuningValue('10')).toBe(10);
    expect(parseTuningValue('+10')).toBe(10);
    expect(parseTuningValue('10%')).toBe(10);
    expect(parseTuningValue('-5%')).toBe(-5);
    expect(parseTuningValue('  -5  ')).toBe(-5);
  });

  it('clamps out-of-range values to [-100, 100]', () => {
    expect(parseTuningValue(150)).toBe(100);
    expect(parseTuningValue(-150)).toBe(-100);
    expect(parseTuningValue('999')).toBe(100);
  });

  it('returns undefined for non-numeric / non-finite input', () => {
    expect(parseTuningValue('abc')).toBeUndefined();
    expect(parseTuningValue(NaN)).toBeUndefined();
    expect(parseTuningValue(Infinity)).toBeUndefined();
    expect(parseTuningValue('NaN')).toBeUndefined();
    expect(parseTuningValue(true)).toBeUndefined();
    expect(parseTuningValue({})).toBeUndefined();
  });
});

describe('buildPiperArgs', () => {
  const model = 'C:/voices/zh_CN-huayan-medium.onnx';
  const out = 'C:/tmp/out.wav';

  it('omits tuning flags when no value is given (未使用新参的调用方不受影响)', () => {
    expect(buildPiperArgs(model, out)).toEqual(['--model', model, '--output_file', out]);
    expect(buildPiperArgs(model, out, {})).toEqual(['--model', model, '--output_file', out]);
    expect(buildPiperArgs(model, out, { rate: undefined, volume: undefined })).toEqual([
      '--model', model, '--output_file', out,
    ]);
  });

  it('appends --rate / --volume only when defined (explicit 0 is passed through)', () => {
    expect(buildPiperArgs(model, out, { rate: 10 })).toEqual([
      '--model', model, '--output_file', out, '--rate', '10',
    ]);
    expect(buildPiperArgs(model, out, { volume: -5 })).toEqual([
      '--model', model, '--output_file', out, '--volume', '-5',
    ]);
    expect(buildPiperArgs(model, out, { rate: 0, volume: 0 })).toEqual([
      '--model', model, '--output_file', out, '--rate', '0', '--volume', '0',
    ]);
  });

  it('orders flags as --rate then --volume and does not mutate the tuning object', () => {
    const tuning = { rate: 20, volume: 5 };
    expect(buildPiperArgs(model, out, tuning)).toEqual([
      '--model', model, '--output_file', out, '--rate', '20', '--volume', '5',
    ]);
    expect(tuning).toEqual({ rate: 20, volume: 5 });
  });
});
