// 新手指引「分步高亮导游」的纯定位数学（B-33）
//
// 与 DOM 无关：输入视口尺寸 / 目标矩形 / 气泡实测尺寸，输出聚光板矩形与气泡的
// 左/上角位置。抽成独立模块的原因：vitest 全局 environment:'node'（无 jsdom），
// 组件层（HomeTour.tsx）只负责量取 getBoundingClientRect 与测量气泡，计算与边界
// 规则全部在这里单测覆盖。

/** 视口坐标下的矩形（left/top 为左上角，单位 px）。 */
export interface TourRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 尺寸（视口同理）。 */
export interface TourSize {
  width: number;
  height: number;
}

/** 目标高度达到这条线即算「竖长目标」：气泡不再往目标下方放（没空间），改贴其内部底端。 */
const TALL_TARGET_PX = 260;
/** 气泡与目标/视口边缘的默认间距。 */
const GAP = 12;
/** 气泡与视口边缘的最小留白。 */
const EDGE = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** 以 center 为轴心放 size 宽的盒子，并夹进 [edge, viewport - size - edge]；比视口还宽时贴左。 */
function centerOn(center: number, size: number, viewportSize: number, edge: number): number {
  if (size + edge * 2 >= viewportSize) return edge;
  return clamp(center - size / 2, edge, viewportSize - size - edge);
}

/**
 * 聚光板：目标矩形向外扩 pad，并夹进视口（贴边目标的 pad 被裁掉，不产生越界/负值）。
 * pad 的用途是把目标四周留出呼吸，同时让 box-shadow 的暗幕从目标外缘开始。
 */
export function computeSpotlight(target: TourRect, viewport: TourSize, pad = 6): TourRect {
  const left = Math.max(0, target.left - pad);
  const top = Math.max(0, target.top - pad);
  const right = Math.min(viewport.width, target.left + target.width + pad);
  const bottom = Math.min(viewport.height, target.top + target.height + pad);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * 气泡位置（左/上角，视口坐标）。规则：
 * - 目标缺失（spot 宽高 < 2px，组件层用零点兜底）→ 视口正中（全屏变暗 + 居中卡）；
 * - 竖长目标（≥260px，如整根栏）→ 贴其内部底端、水平居中（下方没空间）；
 * - 矮目标（如顶栏段位）→ 放其正下方；下方放不下翻到上方；
 * - 水平方向以目标中心居中，随后夹进视口左右留白（比视口宽时贴左）。
 */
export function computeTooltip(
  spot: TourRect,
  viewport: TourSize,
  tooltip: TourSize,
  gap = GAP,
  edge = EDGE,
): { left: number; top: number } {
  const centerX = spot.left + spot.width / 2;
  const left = centerOn(centerX, tooltip.width, viewport.width, edge);

  if (spot.width < 2 || spot.height < 2) {
    const centerY = spot.top + spot.height / 2;
    return { left, top: centerOn(centerY, tooltip.height, viewport.height, edge) };
  }

  let top: number;
  if (spot.height >= TALL_TARGET_PX) {
    top = spot.top + spot.height - tooltip.height - gap;
  } else {
    const below = spot.top + spot.height + gap;
    top =
      below + tooltip.height + edge <= viewport.height
        ? below
        : spot.top - tooltip.height - gap;
  }
  return { left, top: clamp(top, edge, viewport.height - tooltip.height - edge) };
}
