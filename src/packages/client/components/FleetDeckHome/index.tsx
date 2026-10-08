import React from 'react';
import { FleetStatusColumn } from './FleetStatusColumn';
import { DelegationColumn } from './DelegationColumn';
import { VoiceSessionStream } from './VoiceSessionStream';
import './FleetDeckHome.scss';

export interface FleetDeckHomeProps {
  /** 「去开启」语音引导卡 → 工具箱（App 注入，保持本组件无 App 依赖）。 */
  onOpenToolbox?: () => void;
}

/**
 * 指挥台总览（EPIC-1）：左=舰队状态 / 中=委派树 / 右=语音会话流。
 * 数据全部来自现有 store + 现有 API；三栏在 ≤1100px 折起语音栏、≤760px 单列堆叠。
 */
export function FleetDeckHome({ onOpenToolbox }: FleetDeckHomeProps) {
  return (
    <div className="fleetdeck-home">
      <FleetStatusColumn />
      <DelegationColumn />
      <VoiceSessionStream onOpenVoiceSettings={onOpenToolbox} />
    </div>
  );
}

export default FleetDeckHome;
