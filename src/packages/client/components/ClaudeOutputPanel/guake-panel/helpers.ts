/**
 * GuakeOutputPanel 的纯助手(区域命中判定 / 底部面板 id 生成)。
 *
 * 自 index.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */


export function isPositionInArea(
  pos: { x: number; z: number },
  area: { type: string; center: { x: number; z: number }; width?: number; height?: number; radius?: number }
): boolean {
  if (area.type === 'rectangle' && area.width && area.height) {
    const halfW = area.width / 2;
    const halfH = area.height / 2;
    return (
      pos.x >= area.center.x - halfW &&
      pos.x <= area.center.x + halfW &&
      pos.z >= area.center.z - halfH &&
      pos.z <= area.center.z + halfH
    );
  }

  if (area.type === 'circle' && area.radius) {
    const dx = pos.x - area.center.x;
    const dz = pos.z - area.center.z;
    return dx * dx + dz * dz <= area.radius * area.radius;
  }

  return false;
}

let nextPanelId = 1;

export function makePanelId(): string {
  return `bp-${nextPanelId++}`;
}
