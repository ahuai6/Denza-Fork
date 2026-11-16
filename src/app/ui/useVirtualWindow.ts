import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

interface VirtualWindowOptions {
  count: number;
  rowHeight: number;
  gap?: number;
  overscan?: number;
  threshold?: number;
  enabled?: boolean;
  resetKey?: string | number;
}

export interface VirtualWindow {
  ref: RefObject<HTMLDivElement | null>;
  active: boolean;
  start: number;
  end: number;
  topPad: number;
  bottomPad: number;
  scrollToIndex: (index: number) => void;
}

function findScrollParent(el: HTMLElement): HTMLElement | Window {
  let cur: HTMLElement | null = el;
  while (cur) {
    const oy = getComputedStyle(cur).overflowY;
    if (oy === 'auto' || oy === 'scroll') return cur;
    cur = cur.parentElement;
  }
  return window;
}

/**
 * Window large vertically scrolling lists once item count crosses `threshold`.
 * Small lists render untouched so tests and compact panels keep their exact DOM layout.
 */
export function useVirtualWindow({
  count,
  rowHeight,
  gap = 0,
  overscan = 6,
  threshold = 80,
  enabled = true,
  resetKey,
}: VirtualWindowOptions): VirtualWindow {
  const active = enabled && count > threshold && rowHeight > 0;
  const ref = useRef<HTMLDivElement | null>(null);
  const stride = rowHeight + gap;
  const fallbackVisible = Math.max(24, Math.ceil(720 / Math.max(1, stride)) + overscan * 2);
  const [range, setRange] = useState<[number, number]>(() => [0, Math.min(count, fallbackVisible)]);

  const measure = useCallback(() => {
    if (!active || !ref.current) return;
    const el = ref.current;
    const scroller = findScrollParent(el);
    let viewTop = 0;
    let viewHeight = 0;
    if (scroller === el) {
      viewTop = el.scrollTop;
      viewHeight = el.clientHeight;
    } else if (scroller === window) {
      const rect = el.getBoundingClientRect();
      viewTop = Math.max(0, -rect.top);
      viewHeight = window.innerHeight;
    } else {
      const sEl = scroller as HTMLElement;
      const elRect = el.getBoundingClientRect();
      const sRect = sEl.getBoundingClientRect();
      viewTop = Math.max(0, sRect.top - elRect.top);
      viewHeight = sEl.clientHeight;
    }
    if (viewHeight <= 0) viewHeight = Math.max(640, stride * 12);
    const start = Math.max(0, Math.floor(viewTop / stride) - overscan);
    const end = Math.min(count, Math.ceil((viewTop + viewHeight) / stride) + overscan);
    setRange((prev) => (prev[0] === start && prev[1] === end ? prev : [start, end]));
  }, [active, count, overscan, stride]);

  useEffect(() => {
    if (!active) {
      setRange((prev) => (prev[0] === 0 && prev[1] === count ? prev : [0, count]));
      return;
    }
    measure();
    const el = ref.current;
    if (!el) return;
    const scroller = findScrollParent(el);
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    scroller.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    ro?.observe(el);
    if (scroller !== window && scroller !== el) ro?.observe(scroller as HTMLElement);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      scroller.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
    };
  }, [active, count, measure, resetKey]);

  const scrollToIndex = useCallback(
    (index: number) => {
      const el = ref.current;
      if (!el || index < 0 || index >= count) return;
      const scroller = findScrollParent(el);
      const offset = index * stride;
      if (scroller === el) {
        el.scrollTo({ top: Math.max(0, offset - el.clientHeight * 0.4), behavior: 'auto' });
      } else if (scroller === window) {
        const rect = el.getBoundingClientRect();
        window.scrollTo({
          top: Math.max(0, window.scrollY + rect.top + offset - window.innerHeight * 0.4),
          behavior: 'auto',
        });
      } else {
        const sEl = scroller as HTMLElement;
        const elRect = el.getBoundingClientRect();
        const sRect = sEl.getBoundingClientRect();
        const topInScroller = sEl.scrollTop + (elRect.top - sRect.top) + offset;
        sEl.scrollTo({ top: Math.max(0, topInScroller - sEl.clientHeight * 0.4), behavior: 'auto' });
      }
      measure();
    },
    [count, measure, stride],
  );

  if (!active) {
    return { ref, active: false, start: 0, end: count, topPad: 0, bottomPad: 0, scrollToIndex };
  }
  const start = Math.max(0, Math.min(range[0], count));
  const end = Math.max(start, Math.min(range[1], count));
  const topPad = start > 0 ? Math.max(0, start * stride - gap) : 0;
  const bottomPad = end < count ? Math.max(0, (count - end) * stride - gap) : 0;
  return { ref, active: true, start, end, topPad, bottomPad, scrollToIndex };
}
