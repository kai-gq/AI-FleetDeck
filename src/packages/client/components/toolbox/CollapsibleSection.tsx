import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';

const TOOLBOX_COLLAPSE_KEY = 'tide-toolbox-collapse';

// Helper to get/set collapse state from localStorage
function getCollapseState(key: string, defaultValue: boolean): boolean {
  try {
    const stored = localStorage.getItem(`${TOOLBOX_COLLAPSE_KEY}-${key}`);
    if (stored !== null) {
      return stored === 'true';
    }
  } catch {
    // localStorage not available
  }
  return defaultValue;
}

function setCollapseState(key: string, isOpen: boolean): void {
  try {
    localStorage.setItem(`${TOOLBOX_COLLAPSE_KEY}-${key}`, String(isOpen));
  } catch {
    // localStorage not available
  }
}

// Collapsible section component with localStorage persistence
export function CollapsibleSection({
  title,
  storageKey,
  defaultOpen = false,
  forceOpen = false,
  children,
  headerExtra,
  id,
  expandSignal,
}: {
  title: string;
  storageKey?: string;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  children: React.ReactNode;
  headerExtra?: React.ReactNode;
  /** 根元素 id(供外部锚点滚动,如设置里的互跳)。 */
  id?: string;
  /** 值变化即展开(配套 onJump 互跳);展开后用户仍可手动折叠。 */
  expandSignal?: number;
}) {
  const [isOpen, setIsOpen] = useState(() =>
    storageKey ? getCollapseState(storageKey, defaultOpen) : defaultOpen
  );

  // 外部请求展开:signal 变化时展开并持久化(仅首次挂载后的变化,初始值不算)
  const lastSignalRef = useRef(expandSignal);
  useEffect(() => {
    if (expandSignal === undefined || expandSignal === lastSignalRef.current) return;
    lastSignalRef.current = expandSignal;
    setIsOpen(true);
    if (storageKey) setCollapseState(storageKey, true);
  }, [expandSignal, storageKey]);

  const handleToggle = () => {
    const newState = !isOpen;
    setIsOpen(newState);
    if (storageKey) {
      setCollapseState(storageKey, newState);
    }
  };

  // Use forceOpen when searching, otherwise use internal state
  const effectivelyOpen = forceOpen || isOpen;

  return (
    <div id={id} className={`collapsible-section ${effectivelyOpen ? 'open' : 'collapsed'}`}>
      <button className="collapsible-header" onClick={handleToggle}>
        <span className="collapsible-title">{title}</span>
        <span className="collapsible-header-right">
          {headerExtra}
          <span className="collapsible-arrow"><Icon name={effectivelyOpen ? 'caret-down' : 'caret-right'} size={10} /></span>
        </span>
      </button>
      {effectivelyOpen && <div className="collapsible-content">{children}</div>}
    </div>
  );
}
