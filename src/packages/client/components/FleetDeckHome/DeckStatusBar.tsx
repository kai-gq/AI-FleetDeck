import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { store, useAgents, useAreas, useIsConnected } from '../../store';
import { useWorkspaceFilter, isAgentVisibleInWorkspace } from '../WorkspaceSwitcher';
import { groupFleet } from './fleetGroups';
import { useVoiceCompanionPhase } from './useVoiceCompanionPhase';

const CLOCK_TICK_MS = 1_000;

/** 相位 → 短标签（B-27 口径：粗粒度；B-29 起语音栏舞台条复用同一映射，单一来源） */
export function voiceStateKey(phase: string): { key: string; fallback: string } {
  switch (phase) {
    case 'off':
      return { key: 'voice.off', fallback: '已关闭' };
    case 'starting':
    case 'listening':
    case 'hearing':
      return { key: 'voice.listening', fallback: '聆听中' };
    case 'transcribing':
    case 'thinking':
      return { key: 'voice.working', fallback: '处理中' };
    case 'speaking':
      return { key: 'voice.speaking', fallback: '播报中' };
    case 'paused':
      return { key: 'voice.paused', fallback: '已暂停' };
    case 'error':
      return { key: 'voice.error', fallback: '出错' };
    default:
      return { key: 'voice.active', fallback: '进行中' };
  }
}

/**
 * 指挥台底部状态栏（B-27，仅本页；`.fleetdeck-home` 第 4 格横跨三栏）。
 * 只放诚实数据源：连接（store.isConnected）/ 语音相位（useVoiceCompanionPhase 镜像）/
 * 团队计数（与左栏同口径：归档区剔除 + 工作区过滤 + groupFleet 分组）/ 工作区 / 本机时钟。
 * 原型里的「测试数/模型」无诚实来源，不做（有意偏差，见台账）。
 * 右侧预留 72px 给 fixed bottom-right 的 FPSMeter；≤760 折叠为 连接+语音+时钟（sticky 吸底）。
 */
export function DeckStatusBar() {
  const { t } = useTranslation(['terminal', 'common']);
  const connected = useIsConnected();
  const voice = useVoiceCompanionPhase();
  const [activeWorkspace, workspaces] = useWorkspaceFilter();

  const agentsMap = useAgents();
  // areas 进依赖：agent 位置/区域变化要重算工作区可见性（与 FleetStatusColumn 同款）
  const areas = useAreas();
  const agents = useMemo(
    () =>
      Array.from(agentsMap.values()).filter((agent) => {
        if (store.isAgentInArchivedArea(agent.id)) return false;
        if (!activeWorkspace) return true;
        const area = store.getAreaForAgent(agent.id);
        return isAgentVisibleInWorkspace(area?.id ?? null);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- areas 仅为触发重算
    [agentsMap, areas, activeWorkspace]
  );
  const groups = useMemo(() => groupFleet(agents), [agents]);
  const activeCount = groups.find((group) => group.id === 'active')?.agents.length ?? 0;

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const voiceActive = voice.present === true && voice.phase !== 'off';
  const voiceState = voice.present === true ? voiceStateKey(voice.phase) : null;

  return (
    <footer
      className="fleetdeck-statusbar"
      aria-label={t('terminal:fleetHome.statusBar.label', { defaultValue: '状态栏' })}
    >
      <span className={`fleetdeck-statusbar__item${connected ? ' is-on' : ' is-off'}`}>
        <span className="fleetdeck-statusbar__dot" aria-hidden="true" />
        {connected
          ? t('terminal:fleetHome.statusBar.connected', { defaultValue: '已连接' })
          : t('terminal:fleetHome.statusBar.disconnected', { defaultValue: '未连接' })}
      </span>

      {voice.present !== null && (
        <span className={`fleetdeck-statusbar__item${voiceActive ? ' is-voice-on' : ''}`}>
          <span className="fleetdeck-statusbar__dot" aria-hidden="true" />
          {t('terminal:fleetHome.statusBar.voiceLabel', { defaultValue: '语音' })}
          {' · '}
          {voice.present === false
            ? t('terminal:fleetHome.voice.disabled', { defaultValue: '未启用' })
            : t(`terminal:fleetHome.statusBar.${voiceState!.key}`, {
                defaultValue: voiceState!.fallback,
              })}
        </span>
      )}

      <span className="fleetdeck-statusbar__item fleetdeck-statusbar__item--team">
        {t('terminal:fleetHome.fleet.count', {
          defaultValue: '{{total}} 员 · {{active}} 在办',
          total: agents.length,
          active: activeCount,
        })}
      </span>

      {(activeWorkspace || workspaces.length > 0) && (
        <span className="fleetdeck-statusbar__item fleetdeck-statusbar__item--ws">
          {activeWorkspace
            ? activeWorkspace.name
            : t('terminal:fleetHome.statusBar.allWorkspaces', { defaultValue: '全部工作区' })}
        </span>
      )}

      <span className="fleetdeck-statusbar__spacer" />
      <time className="fleetdeck-statusbar__clock" dateTime={now.toISOString()}>
        {now.toLocaleTimeString('zh-CN', { hour12: false })}
      </time>
    </footer>
  );
}

export default DeckStatusBar;
