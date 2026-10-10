import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildQrPath } from './wechatQr';
import qrcode from '../vendor/qrcode/qrcode';

const SAMPLE = 'https://liteapp.weixin.qq.com/q/SAMPLE-TOKEN?bot_type=3';

/** 解析 path 里全部 `M x y h1 v1 h-1 z` 子路径为 "x,y" 集合。 */
function cellSet(path: string): Set<string> {
  const cells = new Set<string>();
  for (const m of path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    cells.add(`${m[1]},${m[2]}`);
  }
  return cells;
}

describe('buildQrPath · 微信绑定二维码', () => {
  it('moduleCount 为标准 QR 尺寸（4n+17），自动选版本', () => {
    const { moduleCount } = buildQrPath(SAMPLE);
    expect(moduleCount % 4).toBe(1);
    expect(moduleCount).toBeGreaterThanOrEqual(21);
  });

  it('path 子路径数 = 深色模块数（isDark 全遍历对照）', () => {
    const { path, moduleCount } = buildQrPath(SAMPLE);
    const qr = qrcode(0, 'M');
    qr.addData(SAMPLE, 'Byte');
    qr.make();
    let dark = 0;
    for (let r = 0; r < moduleCount; r += 1) {
      for (let c = 0; c < moduleCount; c += 1) {
        if (qr.isDark(r, c)) dark += 1;
      }
    }
    expect(cellSet(path).size).toBe(dark);
    expect(dark).toBeGreaterThan(100);
  });

  it('三个定位图案齐全（外圈深/中圈浅/中心深），含 margin 偏移', () => {
    const margin = 2;
    const { path, moduleCount: n } = buildQrPath(SAMPLE, 'M', margin);
    const cells = cellSet(path);
    // 左上定位：角 (0,0) 深、内白圈 (1,1) 浅、中心 (3,3) 深
    expect(cells.has('2,2')).toBe(true);
    expect(cells.has('3,3')).toBe(false);
    expect(cells.has('5,5')).toBe(true);
    // 右上定位：角 (n-7, 0) 深、内白圈 (n-6, 1) 浅、中心 (n-4, 3) 深
    expect(cells.has(`${n - 7 + margin},${margin}`)).toBe(true);
    expect(cells.has(`${n - 6 + margin},${1 + margin}`)).toBe(false);
    expect(cells.has(`${n - 4 + margin},${3 + margin}`)).toBe(true);
    // 左下定位：角 (0, n-7) 深
    expect(cells.has(`${margin},${n - 7 + margin}`)).toBe(true);
  });

  it('margin 生效：0 时从 (0,0) 起、size=moduleCount；2 时 size=moduleCount+4', () => {
    const m0 = buildQrPath(SAMPLE, 'M', 0);
    expect(m0.path.startsWith('M0 0h1v1h-1z')).toBe(true);
    expect(m0.size).toBe(m0.moduleCount);
    const m2 = buildQrPath(SAMPLE, 'M', 2);
    expect(m2.size).toBe(m2.moduleCount + 4);
  });

  it('确定性回归：同输入输出稳定（sha256 快照）', () => {
    const a = buildQrPath(SAMPLE);
    const b = buildQrPath(SAMPLE);
    expect(a.path).toBe(b.path);
    expect(createHash('sha256').update(a.path).digest('hex')).toBe(
      '2a8ec31150f09dc1017de349ff5fb4c60cd37f8aa8b730ff01097fe2ce23c530',
    );
  });

  it('UTF-8 覆盖生效：非 ASCII 走 UTF-8（含代理对），不再 ISO-8859-1 截断', () => {
    expect(qrcode.stringToBytes('中')).toEqual([228, 184, 173]);
    expect(qrcode.stringToBytes('😀')).toEqual([240, 159, 152, 128]);
    const { moduleCount } = buildQrPath('微信绑定:中文内容');
    expect(moduleCount % 4).toBe(1);
  });
});
