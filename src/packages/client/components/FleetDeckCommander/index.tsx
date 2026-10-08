import React from 'react';
import { store } from '../../store';
import { CommanderView } from '../CommanderView';
import './FleetDeckCommander.scss';

/**
 * 「指挥官」正式视图（B-30）。
 *
 * 复用模态版 CommanderView（同一组件、同一数据源，零重复实现），用本目录
 * scss 把 .commander-overlay/.commander-view 去模态化后嵌入主内容区：
 * 顶栏常驻、侧栏保留（与 2d/3d/flat/dashboard 一致）；ESC / 头部关闭钮 →
 * onClose → 回指挥台。FAB 与 tide:open-commander 的模态入口不受影响
 * （AppModals 原样挂载，见 B4 既有链路）。
 */
export function FleetDeckCommander() {
  return (
    <div className="fleetdeck-commander">
      <CommanderView isOpen onClose={() => store.setViewMode('home')} />
    </div>
  );
}

export default FleetDeckCommander;
