import React from 'react';
import { FleetStatusColumn } from './FleetStatusColumn';
import { Scene2DPane } from './Scene2DPane';
import { DelegationColumn } from './DelegationColumn';
import { VoiceSessionStream } from './VoiceSessionStream';
import { DeckStatusBar } from './DeckStatusBar';
import { HomeTour } from './HomeTour';
import './FleetDeckHome.scss';

export interface FleetDeckHomeProps {
  /** 「去开启」语音引导卡 → 语音设置弹窗（App 注入，保持本组件无 App 依赖）。 */
  onOpenVoiceSettings?: () => void;
}

/**
 * 指挥台总览（EPIC-1）：左=团队状态 / 中栏=2D 现场+委派树（B-35 切两半）/ 右=语音会话流 / 底=状态栏。
 * 数据全部来自现有 store + 现有 API；三栏在 ≤1100px 折起语音栏、≤760px 单列堆叠；
 * 2D 窗格自身只在 ≥1320px 挂载（窄窗回落原三栏，组件返回 null）。
 */
export function FleetDeckHome({ onOpenVoiceSettings }: FleetDeckHomeProps) {
  return (
    <div className="fleetdeck-home">
      <FleetStatusColumn />
      <Scene2DPane />
      <DelegationColumn />
      <VoiceSessionStream onOpenVoiceSettings={onOpenVoiceSettings} />
      <DeckStatusBar />
      {/* 首次使用导游（B-33）：走 ModalPortal 挂 body（position:fixed，不占 grid 格） */}
      <HomeTour />
    </div>
  );
}

export default FleetDeckHome;
