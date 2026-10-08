import { describe, expect, it } from 'vitest';
import { computeSpotlight, computeTooltip, type TourRect } from './homeTourModel';

const VP = { width: 1920, height: 962 };
/** 顶栏段位（矮目标）：pad 后仍 64 高。 */
const TOPBAR: TourRect = { left: 100, top: 0, width: 452, height: 64 };
/** 左栏（竖长目标）：全高 866。 */
const COLUMN: TourRect = { left: 16, top: 64, width: 268, height: 866 };
const TIP = { width: 296, height: 170 };

describe('computeSpotlight', () => {
  it('四面外扩 pad', () => {
    expect(computeSpotlight({ left: 500, top: 300, width: 200, height: 100 }, VP, 6)).toEqual({
      left: 494,
      top: 294,
      width: 212,
      height: 112,
    });
  });

  it('贴边/超边时夹进视口，不产生越界或负尺寸', () => {
    expect(computeSpotlight({ left: 0, top: 0, width: 40, height: 40 }, VP, 6)).toEqual({
      left: 0,
      top: 0,
      width: 46,
      height: 46,
    });
    const overflowing = computeSpotlight(
      { left: -30, top: -30, width: 2000, height: 2000 },
      VP,
      6
    );
    expect(overflowing).toEqual({ left: 0, top: 0, width: VP.width, height: VP.height });
  });
});

describe('computeTooltip', () => {
  it('竖长目标：贴内部底端、水平居中', () => {
    const pos = computeTooltip(COLUMN, VP, TIP);
    // top = 64 + 866 - 170 - 12 = 748；left = 中心 150 - 148 = 2 → 夹到 12
    expect(pos).toEqual({ left: 12, top: 748 });
  });

  it('矮目标：放正下方、水平随目标居中', () => {
    const pos = computeTooltip(TOPBAR, VP, TIP);
    // top = 64 + 12 = 76；left = 中心 326 - 148 = 178
    expect(pos).toEqual({ left: 178, top: 76 });
  });

  it('矮目标下方放不下 → 翻到上方', () => {
    const vp = { width: 1280, height: 300 };
    const spot: TourRect = { left: 0, top: 220, width: 400, height: 64 };
    const pos = computeTooltip(spot, vp, TIP);
    // below 296 放不下 → above = 220 - 170 - 12 = 38
    expect(pos).toEqual({ left: 52, top: 38 });
  });

  it('右侧贴边：水平夹进右边距（右栏居中后超界）', () => {
    const pos = computeTooltip(
      { left: 1737, top: 64, width: 295, height: 866 },
      VP,
      TIP
    );
    expect(pos.left).toBe(VP.width - TIP.width - 12);
  });

  it('目标缺失（零点兜底）→ 视口正中', () => {
    const pos = computeTooltip({ left: 960, top: 481, width: 0, height: 0 }, VP, TIP);
    expect(pos).toEqual({ left: 960 - 148, top: 481 - 85 });
  });

  it('视口比气泡还窄（手机宽）→ 贴左留白', () => {
    const pos = computeTooltip(TOPBAR, { width: 390, height: 780 }, { width: 380, height: 200 });
    expect(pos.left).toBe(12);
  });

  it('气泡几乎占满视口但放得下 → 夹到右边距（不贴左）', () => {
    const pos = computeTooltip(TOPBAR, { width: 390, height: 780 }, { width: 360, height: 200 });
    expect(pos.left).toBe(390 - 360 - 12);
  });

  it('竖长目标的气泡被 clamp 到视口内（目标超矮视口）', () => {
    const vp = { width: 1280, height: 400 };
    const pos = computeTooltip(COLUMN, vp, TIP);
    expect(pos.top).toBe(vp.height - TIP.height - 12);
  });
});
