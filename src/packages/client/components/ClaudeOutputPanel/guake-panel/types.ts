/**
 * GuakeOutputPanel 的类型定义(底部面板类型 / 描述与分屏方向)。
 *
 * 自 index.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */


/** A single bottom panel descriptor */
export type BottomPanelType = 'terminal' | 'pm2-logs' | 'database' | 'http' | 'tests';

export interface BottomPanel {
  id: string;
  type: BottomPanelType;
  buildingId: string;
  areaId?: string;
}

export type SplitDirection = 'horizontal' | 'vertical';
