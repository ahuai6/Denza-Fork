// The playing song's own spectrum, as three bars (lows, mids, highs) read from the song's rhythm analysis at the playing
// moment: they rise fast and fall slowly, like a meter, and rest low between songs or while paused. One loop serves every
// bar set on screen.
import { useEffect, useRef } from 'react';
import { engine } from '../playback/stage';
import s from './kit.module.css';

const live = new Set<HTMLSpanElement>();
let raf = 0,
  last = 0,
  unsubEngine: (() => void) | null = null;
const lvl = [0.2, 0.2, 0.2],
  lastStr = ['', '', ''],
  buf: number[] = [];
/** A share per 60 Hz frame as the share for this frame's time: the same pace at any refresh rate. */
const per = (k: number, dt: number) => 1 - Math.pow(1 - k, dt * 60);
function step(now: number) {
  if (typeof document !== 'undefined' && document.hidden) {
    raf = 0;
    last = 0;
    return;
  }
  const dt = Math.min(0.1, last ? (now - last) / 1000 : 1 / 60);
  last = now;
  const ses = engine.session,
    t = engine.time,
    on = engine.isPlaying && !!ses;
  const sp = on ? ses!.map.spec(t, buf) : null,
    rs = on && !sp ? ses!.sig.sample(t) : null;
  let settled = !on;
  for (let k = 0; k < 3; k++) {
    // two bands to a bar; without a spectrum (no audio analysis yet) the bars follow the beat's pulse and the level
    const want = sp
      ? (sp[k * 2] + sp[k * 2 + 1]) / 2
      : rs
        ? (0.25 + 0.55 * rs.level) * (0.6 + 0.4 * rs.pulse) * (k === 1 ? 1 : 0.8)
        : 0.15;
    lvl[k] += (want - lvl[k]) * per(want > lvl[k] ? 0.55 : 0.12, dt);
    if (Math.abs(want - lvl[k]) > 0.002) settled = false;
  }
  for (let k = 0; k < 3; k++) {
    const str = `scaleY(${(0.18 + 0.82 * Math.min(1, lvl[k])).toFixed(3)})`;
    if (str === lastStr[k]) continue;
    lastStr[k] = str;
    for (const el of live) {
      const bar = el.children[k] as HTMLElement | undefined;
      if (bar) bar.style.transform = str;
    }
  }
  raf = live.size && !settled ? requestAnimationFrame(step) : 0;
  if (!raf) last = 0;
}
function wake() {
  if (!raf && live.size && (typeof document === 'undefined' || !document.hidden)) {
    last = 0;
    raf = requestAnimationFrame(step);
  }
}
export function LiveEq() {
  const el = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const e = el.current!;
    live.add(e);
    for (let k = 0; k < 3; k++) {
      if (lastStr[k]) (e.children[k] as HTMLElement).style.transform = lastStr[k];
    }
    if (!unsubEngine) {
      const a = engine.on('change', wake),
        b = engine.on('tick', () => {
          if (engine.isPlaying) wake();
        });
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wake);
      unsubEngine = () => {
        a();
        b();
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', wake);
      };
    }
    wake();
    return () => {
      live.delete(e);
      if (!live.size) {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        last = 0;
        if (unsubEngine) {
          unsubEngine();
          unsubEngine = null;
        }
      }
    };
  }, []);
  return (
    <span ref={el} className={s.eq} data-live aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
