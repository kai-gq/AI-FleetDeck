/**
 * 底部终端 iframe 组件(自 GuakeOutputPanel 迁出;现主文件已无引用,原样保留)。
 *
 * 自 index.tsx 按主题拆出(2026-10-11 W2);块级逐行原样搬移。
 */

import { useEffect, useRef, useState, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';

const _BottomTerminalIframe = memo(function BottomTerminalIframe({
  src,
  title,
}: {
  src: string;
  title: string;
}) {
  const { t } = useTranslation(['terminal', 'common']);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  // Defer src assignment so the UI paints first, then the iframe loads in the background
  const [deferredSrc, setDeferredSrc] = useState<string | null>(null);

  useEffect(() => {
    setLoaded(false);
    setDeferredSrc(null);
    // Delay iframe src assignment so the UI transition/animation completes first.
    // requestIdleCallback fires too soon; use a fixed 400ms delay to let the
    // area-switch paint settle before xterm.js starts blocking the main thread.
    const timer = setTimeout(() => setDeferredSrc(src), 400);
    return () => clearTimeout(timer);
  }, [src]);

  const suppressIframeFocus = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    if (document.activeElement === iframe) iframe.blur();
    try { iframe.contentWindow?.blur(); } catch { /* cross-origin */ }
  }, []);

  const restoreGuakeInputFocus = useCallback(() => {
    const container = document.querySelector('.guake-input-container') as HTMLDivElement | null;
    const input = container?.querySelector('textarea, input') as HTMLTextAreaElement | HTMLInputElement | null;
    container?.focus({ preventScroll: true });
    input?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!deferredSrc) return;
    const startedAt = Date.now();
    const handleFocusSteal = () => {
      if (Date.now() - startedAt > 1500) return;
      suppressIframeFocus();
      restoreGuakeInputFocus();
    };
    window.addEventListener('focus', handleFocusSteal, true);
    document.addEventListener('focusin', handleFocusSteal, true);
    return () => {
      window.removeEventListener('focus', handleFocusSteal, true);
      document.removeEventListener('focusin', handleFocusSteal, true);
    };
  }, [restoreGuakeInputFocus, suppressIframeFocus, deferredSrc]);

  return (
    <>
      {!loaded && (
        <div className="guake-bottom-terminal-starting"><span>{t('terminal:terminalPane.loading', { defaultValue: 'Loading terminal...' })}</span></div>
      )}
      <iframe
        ref={iframeRef}
        src={deferredSrc ?? undefined}
        className={`guake-bottom-terminal-iframe${loaded ? '' : ' iframe-loading'}`}
        title={title}
        allow="clipboard-read; clipboard-write"
        loading="lazy"
        tabIndex={-1}
        onLoad={() => {
          setLoaded(true);
          suppressIframeFocus();
          restoreGuakeInputFocus();
        }}
      />
    </>
  );
});
