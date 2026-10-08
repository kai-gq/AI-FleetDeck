import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModalPortal } from '../shared/ModalPortal';
import { computeSpotlight, computeTooltip, type TourRect } from './homeTourModel';

/** 首次使用导游「已看过」标记（B-33）。改版本号 = 老用户可再看一次。 */
export const HOME_TOUR_STORAGE_KEY = 'tide-home-tour-v1';
/** 重看入口事件（状态栏「?」钮派发）；HomeTour 监听后无视标记、从第 1 步重开。 */
export const HOME_TOUR_START_EVENT = 'tide-home-tour-start';
/** 只在桌面三栏布局下引导（≤1100px 语音栏折起，聚光叙事不成立）。 */
const DESKTOP_MEDIA = '(min-width: 1101px)';
/** 挂载后稍候再亮：等三栏首帧布局/字体落定，量取的 rect 才准。 */
const START_DELAY_MS = 400;

interface TourStep {
  key: string;
  /** 聚光目标选择器（三栏根 + 顶栏段位容器，类名来自 FleetDeckHome/TopBar，稳定）。 */
  selector: string;
  titleKey: string;
  title: string;
  bodyKey: string;
  body: string;
}

/**
 * 四步导游（B-33）：团队状态 → 任务树 → 秘书 → 视图切换。
 * 文案口径（用户点名）：自信、有画面感、面向用户；秘书一步讲「工作原理」——
 * 说一句话 → 听懂 → 派活 → 任务树长进度 → 办完亲口汇报。最后一步按钮变「开始使用」。
 */
const TOUR_STEPS: TourStep[] = [
  {
    key: 'fleet',
    selector: '.fleetdeck-col--fleet',
    titleKey: 'fleetHome.tour.fleet.title',
    title: '团队状态',
    bodyKey: 'fleetHome.tour.fleet.body',
    body: '你的一整支队伍都在这儿：谁在忙、谁空闲，一眼扫完。人再多，阵型也不乱。',
  },
  {
    key: 'tasks',
    selector: '.fleetdeck-col--delegation',
    titleKey: 'fleetHome.tour.tasks.title',
    title: '任务树',
    bodyKey: 'fleetHome.tour.tasks.body',
    body: '派出去的每件活都长在这棵树上：怎么拆的、交给了谁、办到哪步、拿回什么结果——全程留痕，有据可查。',
  },
  {
    key: 'secretary',
    selector: '.fleetdeck-col--voice',
    titleKey: 'fleetHome.tour.secretary.title',
    title: '秘书',
    bodyKey: 'fleetHome.tour.secretary.body',
    body: '你说一句话，系统就开始运转：听懂意图 → 派活给主管和成员 → 任务树同步长出进度 → 办完亲口向你汇报。问进展、派新活，动嘴就行。',
  },
  {
    key: 'views',
    selector: '.top-bar__viewswitch',
    titleKey: 'fleetHome.tour.views.title',
    title: '视图切换',
    bodyKey: 'fleetHome.tour.views.body',
    body: '指挥台看全局，2D / 3D 看现场，平铺 / 仪表盘看数据——想从哪个角度看，就从哪个角度看。',
  },
];

function viewportSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * 指挥台首次使用分步高亮导游。
 *
 * 形态：全屏暗幕（聚光板的 9999px box-shadow）+ 目标中空 + 气泡卡；
 * 首次进入指挥台自动出现（≥1101px）、「下一步/上一步/跳过/ESC」，看完或跳过即记
 * localStorage 不再打扰；宽窗拖窄会中止但不置标记（回来再引导）。
 * 重看：状态栏「?」→ 派发 HOME_TOUR_START_EVENT。
 * 挂 ModalPortal（body 层），z 2400+ 压过顶栏与模态族；mask 挡一切点击。
 * 局限（接受）：非完整焦点陷阱——Tab 仍可能移出到身后页面；聚光目标缺失时退化为
 * 全屏变暗 + 居中卡（三栏与顶栏在指挥台恒挂载，实际不会触发）。
 */
export function HomeTour() {
  const { t } = useTranslation(['terminal', 'common']);
  const [active, setActive] = useState(false);
  const [step, setStep] = useState(0);
  const [spot, setSpot] = useState<TourRect | null>(null);
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(null);
  const [resizeTick, setResizeTick] = useState(0);
  const seenRef = useRef(false);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);

  const start = useCallback(() => {
    setStep(0);
    setSpot(null);
    setTipPos(null);
    setActive(true);
  }, []);

  const finish = useCallback(() => {
    seenRef.current = true;
    try {
      window.localStorage.setItem(HOME_TOUR_STORAGE_KEY, '1');
    } catch {
      /* localStorage 不可写（隐私模式）：本次照常关，不回写 */
    }
    setActive(false);
    setStep(0);
  }, []);

  const next = useCallback(() => {
    if (step >= TOUR_STEPS.length - 1) finish();
    else setStep(step + 1);
  }, [step, finish]);

  const prev = useCallback(() => setStep((s) => Math.max(0, s - 1)), []);

  // 首次自动出现：没看过 + 桌面宽度 → 等布局稳定后开始；宽窗拖宽也算首次（窄窗期间不打扰）
  useEffect(() => {
    try {
      seenRef.current = window.localStorage.getItem(HOME_TOUR_STORAGE_KEY) === '1';
    } catch {
      seenRef.current = true; // 读不了就别打扰
    }
    if (seenRef.current) return;
    const mq = window.matchMedia(DESKTOP_MEDIA);
    let timer: number | null = null;
    const attempt = () => {
      if (seenRef.current || !mq.matches || timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        if (!seenRef.current) start();
      }, START_DELAY_MS);
    };
    attempt();
    const onMedia = () => attempt();
    mq.addEventListener('change', onMedia);
    return () => {
      mq.removeEventListener('change', onMedia);
      if (timer !== null) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时判定一次「是否首次」
  }, []);

  // 重看入口（状态栏「?」）：无视已看标记，从第 1 步重开
  useEffect(() => {
    const onStart = () => start();
    window.addEventListener(HOME_TOUR_START_EVENT, onStart);
    return () => window.removeEventListener(HOME_TOUR_START_EVENT, onStart);
  }, [start]);

  // 导游进行中：ESC=跳过（与「跳过」同语义，置标记）；拖窄到折栏宽度 → 中止不置标记
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
    };
    const onResize = () => {
      if (!window.matchMedia(DESKTOP_MEDIA).matches) {
        setActive(false);
        return;
      }
      setResizeTick((tick) => tick + 1);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [active, finish]);

  // 量取聚光目标（layout effect：补丁在绘制前完成，不闪）
  useLayoutEffect(() => {
    if (!active) return;
    const target = document.querySelector(TOUR_STEPS[step].selector);
    setSpot(target ? computeSpotlight(target.getBoundingClientRect(), viewportSize()) : null);
  }, [active, step, resizeTick]);

  // 定位气泡：等它渲染出来（离屏）量实际尺寸，再按模型规则摆放
  useLayoutEffect(() => {
    if (!active || !tipRef.current) return;
    const tip = tipRef.current.getBoundingClientRect();
    const vp = viewportSize();
    const box: TourRect = spot ?? {
      left: vp.width / 2,
      top: vp.height / 2,
      width: 0,
      height: 0,
    };
    setTipPos(computeTooltip(box, vp, { width: tip.width, height: tip.height }));
  }, [active, step, spot, resizeTick]);

  // 气泡尺寸变化（字体晚载/样式晚到/换行变化）→ 重测重摆，防止定格在旧高度
  useEffect(() => {
    if (!active) return;
    const el = tipRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setResizeTick((tick) => tick + 1));
    observer.observe(el);
    return () => observer.disconnect();
  }, [active]);

  // 每步把焦点给主按钮（回车即「下一步」）
  useEffect(() => {
    if (!active) return;
    primaryRef.current?.focus();
  }, [active, step]);

  if (!active) return null;

  const current = TOUR_STEPS[step];
  const vp = viewportSize();
  const spotlight: TourRect = spot ?? {
    left: vp.width / 2,
    top: vp.height / 2,
    width: 0,
    height: 0,
  };
  const titleId = 'home-tour-title';

  return (
    <ModalPortal>
      <div className="home-tour">
        <div className="home-tour__blocker" aria-hidden="true" />
        <div
          className="home-tour__spot"
          aria-hidden="true"
          style={{
            left: spotlight.left,
            top: spotlight.top,
            width: spotlight.width,
            height: spotlight.height,
          }}
        />
        <div
          className="home-tour__tip"
          ref={tipRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          style={{ left: tipPos?.left ?? -9999, top: tipPos?.top ?? -9999 }}
        >
          <div className="home-tour__step">
            {t('terminal:fleetHome.tour.step', {
              defaultValue: '第 {{n}}/{{total}} 步',
              n: step + 1,
              total: TOUR_STEPS.length,
            })}
          </div>
          <strong className="home-tour__title" id={titleId}>
            {t(`terminal:${current.titleKey}`, { defaultValue: current.title })}
          </strong>
          <p className="home-tour__body">
            {t(`terminal:${current.bodyKey}`, { defaultValue: current.body })}
          </p>
          <div className="home-tour__actions">
            <button type="button" className="home-tour__skip" onClick={finish}>
              {t('terminal:fleetHome.tour.skip', { defaultValue: '跳过' })}
            </button>
            {step > 0 && (
              <button type="button" className="home-tour__prev" onClick={prev}>
                {t('terminal:fleetHome.tour.prev', { defaultValue: '上一步' })}
              </button>
            )}
            <button
              type="button"
              className="home-tour__next"
              ref={primaryRef}
              onClick={next}
            >
              {step === TOUR_STEPS.length - 1
                ? t('terminal:fleetHome.tour.start', { defaultValue: '开始使用' })
                : t('terminal:fleetHome.tour.next', { defaultValue: '下一步' })}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

export default HomeTour;
