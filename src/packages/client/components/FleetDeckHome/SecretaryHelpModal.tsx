import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../Icon';
import { ModalPortal } from '../shared/ModalPortal';
import { useModalStackRegistration } from '../../hooks/useModalStack';
import { VOICE_CHIPS } from './voiceChips';

interface HelpItem {
  /** 可照说的口语示例（引号短语，左列）；缺省只在右列讲能力 */
  sayKey?: string;
  say?: string;
  descKey: string;
  desc: string;
}

interface HelpGroup {
  key: string;
  icon: IconName;
  titleKey: string;
  title: string;
  /** true = 渲染七句快捷口令（与秘书栏空态常用指令同键同文案） */
  chips?: boolean;
  noteKey?: string;
  note?: string;
  items?: HelpItem[];
}

/**
 * 能力清单锚定已上线链路（§06-10）:七句快捷口令 / 派活（主管链）/ 分钟级提醒
 * （voice-reminder 快通道）/ 待办（bolba 桥）/「打开X」本地直达 / 主动汇报（proactiveReporter）/
 * 抢话打断 / 跨会话持久记忆 / 声纹门禁。不写没接线的能力（如口头「批准」方案——拍板入口不在本链路）。
 * 文案与 B-33 导游同口径（自信、有画面感、面向用户）。
 */
const HELP_GROUPS: HelpGroup[] = [
  {
    key: 'ask',
    icon: 'search',
    titleKey: 'fleetHome.voice.help.ask.title',
    title: '张口就问',
    chips: true,
    noteKey: 'fleetHome.voice.help.ask.note',
    note: '这七句一点就发，动嘴说也一样；不限于这些，想问什么问什么。',
  },
  {
    key: 'do',
    icon: 'send',
    titleKey: 'fleetHome.voice.help.do.title',
    title: '动嘴就办',
    items: [
      {
        sayKey: 'fleetHome.voice.help.do.delegate.say',
        say: '让小刘去查登录模块的 bug',
        descKey: 'fleetHome.voice.help.do.delegate.desc',
        desc: '派活：交给主管和成员，任务树同步长出进度，全程留痕。',
      },
      {
        sayKey: 'fleetHome.voice.help.do.remind.say',
        say: '10 分钟后叫我 / 半小时后提醒我喝水',
        descKey: 'fleetHome.voice.help.do.remind.desc',
        desc: '分钟级提醒，到点必喊；「取消提醒」「有哪些提醒」也听得懂。',
      },
      {
        sayKey: 'fleetHome.voice.help.do.todo.say',
        say: '记一下：周五交周报',
        descKey: 'fleetHome.voice.help.do.todo.desc',
        desc: '随手记待办，进任务板，到期主动喊你。',
      },
    ],
  },
  {
    key: 'open',
    icon: 'open-external',
    titleKey: 'fleetHome.voice.help.open.title',
    title: '开口就切',
    items: [
      {
        sayKey: 'fleetHome.voice.help.open.agent.say',
        say: '打开小陈 / 打开主管',
        descKey: 'fleetHome.voice.help.open.agent.desc',
        desc: '说到谁，谁的终端立即展开——本地直达，不占用大脑半秒。',
      },
      {
        sayKey: 'fleetHome.voice.help.open.commander.say',
        say: '打开指挥官',
        descKey: 'fleetHome.voice.help.open.commander.desc',
        desc: '指挥官视图一键到位。',
      },
    ],
  },
  {
    key: 'always',
    icon: 'announce',
    titleKey: 'fleetHome.voice.help.always.title',
    title: '不用问，它在场',
    items: [
      {
        descKey: 'fleetHome.voice.help.always.report.desc',
        desc: '办完就报——任务完成或失败，秘书主动出声，不用追问。',
      },
      {
        descKey: 'fleetHome.voice.help.always.interject.desc',
        desc: '随时插话——它正说话时你直接开口，它让位。',
      },
      {
        descKey: 'fleetHome.voice.help.always.memory.desc',
        desc: '记得住事——跨会话持久记忆，几天前的约定也算数。',
      },
      {
        descKey: 'fleetHome.voice.help.always.gate.desc',
        desc: '只认主人——声纹门禁开启后，只有你的声音能进大脑。',
      },
    ],
  },
];

/**
 * 秘书能力速览弹窗（B-34 用户口径：列头「?」一键看「它所有可以干的事儿」）。
 * 挂 ModalPortal（body 层，z 2300——低于首次导游 2400）；ESC / 点暗幕 / 关闭钮收场；
 * 移动端返回手势走 useModalStackRegistration。
 */
export function SecretaryHelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation(['terminal', 'common']);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useModalStackRegistration('secretary-help', open, onClose);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const title = t('terminal:fleetHome.voice.help.title', { defaultValue: '秘书能做什么' });

  return (
    <ModalPortal>
      <div className="secretary-help" role="dialog" aria-modal="true" aria-label={title}>
        <div className="secretary-help__scrim" onClick={onClose} aria-hidden="true" />
        <div className="secretary-help__panel">
          <header className="secretary-help__head">
            <h2>
              <Icon name="microphone" size={14} />
              {title}
            </h2>
            <button
              type="button"
              className="secretary-help__close"
              ref={closeRef}
              onClick={onClose}
              title={t('common:buttons.close', { defaultValue: '关闭' })}
              aria-label={t('common:buttons.close', { defaultValue: '关闭' })}
            >
              <Icon name="close" size={13} />
            </button>
          </header>
          <div className="secretary-help__body">
            {HELP_GROUPS.map((group) => (
              <section key={group.key} className="secretary-help__group">
                <h3 className="secretary-help__group-title">
                  <Icon name={group.icon} size={11} />
                  {t(`terminal:${group.titleKey}`, { defaultValue: group.title })}
                </h3>
                {group.chips && (
                  <div className="secretary-help__phrases">
                    {VOICE_CHIPS.map((chip) => (
                      <span key={chip.key} className="secretary-help__phrase">
                        {t(`terminal:${chip.key}`, { defaultValue: chip.fallback })}
                      </span>
                    ))}
                  </div>
                )}
                {group.noteKey && (
                  <p className="secretary-help__note">
                    {t(`terminal:${group.noteKey}`, { defaultValue: group.note ?? '' })}
                  </p>
                )}
                {group.items && (
                  <ul className="secretary-help__items">
                    {group.items.map((item) => (
                      <li key={item.descKey}>
                        {item.sayKey && (
                          <span className="secretary-help__say">
                            「{t(`terminal:${item.sayKey}`, { defaultValue: item.say ?? '' })}」
                          </span>
                        )}
                        <span className="secretary-help__desc">
                          {t(`terminal:${item.descKey}`, { defaultValue: item.desc })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
            <div className="secretary-help__foot">
              <Icon name="gear" size={11} />
              <span>
                {t('terminal:fleetHome.voice.help.tuning', {
                  defaultValue: '人设、聆听参数、声纹门禁：工具箱 → 语音伙伴；播报音色：工具箱 → 文字转语音。',
                })}
              </span>
            </div>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

export default SecretaryHelpModal;
