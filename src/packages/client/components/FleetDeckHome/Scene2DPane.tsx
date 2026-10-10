/**
 * 指挥台 · 2D 现场窗格（B-35）
 *
 * 用户口径：任务树占比太大 → 中栏切两半：左=2D 视图 / 右=任务树；
 * 顶栏段位条同步撤下「2D」（见 TopBar/viewMenu.ts 的 hidden 项）。
 *
 * - 挂载门：≥1320px（与顶栏把手收进的断点同款）。窄窗不渲染 = 不留空转的
 *   动画循环；全屏 2D 仍可从其它视图的视图菜单进入。
 * - 交互只保留「看现场」最小集：单击选中成员/建筑、Shift 加选、双击成员开终端、
 *   点地面清选。建筑弹窗/右键菜单/移动指令等重交互仍归全屏 2D/3D（由 App 接线），
 *   本窗格刻意不复制，避免两处接线长期漂移。
 * - 画布引擎经 React.lazy 载入（与 App.tsx 的 2D 分支同款）；尺寸由 Scene2D
 *   自行跟随父容器（handleResize 读 parent.clientWidth/Height + window resize）。
 * - 场景配置（缩放/任务标签/网格/FPS）与全屏 2D 同源：挂载时读一次持久化配置，
 *   工具箱里改完回到指挥台（窗格随视图切换重建）即生效。
 */

import React, { Suspense, useEffect, useMemo, useState } from 'react';
import { store } from '../../store';
import { loadConfig } from '../../app/sceneConfig';

const Scene2DCanvas = React.lazy(() =>
  import('../Scene2DCanvas').then((m) => ({ default: m.Scene2DCanvas }))
);

/** 窗格挂载断点：与 TopBar.scss「≥1320px 把手收进顶栏」同一档。 */
export const SCENE2D_PANE_MEDIA = '(min-width: 1320px)';

export function Scene2DPane() {
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(SCENE2D_PANE_MEDIA).matches
  );

  useEffect(() => {
    const mq = window.matchMedia(SCENE2D_PANE_MEDIA);
    const onChange = () => setWide(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const sceneConfig = useMemo(() => loadConfig(), []);

  if (!wide) return null;

  return (
    <Suspense fallback={null}>
      <Scene2DCanvas
        className="scene-2d-pane"
        scale2d={sceneConfig.scale2d}
        showTaskLabels={sceneConfig.show2DTaskLabels}
        showGrid={sceneConfig.gridVisible}
        fpsLimit={sceneConfig.fpsLimit}
        onAgentClick={(agentId, shiftKey) => {
          if (shiftKey) {
            store.addToSelection(agentId);
          } else {
            store.selectAgent(agentId);
          }
        }}
        onAgentDoubleClick={(agentId) => {
          store.selectAgent(agentId);
          store.setTerminalOpen(true);
        }}
        onGroundClick={() => {
          store.selectAgent(null);
          store.selectBuilding(null);
        }}
        onBuildingClick={(buildingId) => store.selectBuilding(buildingId)}
      />
    </Suspense>
  );
}

export default Scene2DPane;
