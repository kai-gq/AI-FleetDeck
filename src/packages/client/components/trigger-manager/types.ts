/**
 * TriggerManagerPanel 的类型定义(props / 视图与类型过滤)。
 *
 * 自 TriggerManagerPanel.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { type TriggerType } from '../../../shared/trigger-types';

export interface TriggerManagerPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export type PanelView = 'list' | 'edit';

export type TypeFilter = 'all' | TriggerType;
