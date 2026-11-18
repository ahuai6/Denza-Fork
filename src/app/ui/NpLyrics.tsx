// The lyric list as the now-playing page shows it (Apple Music's way: the sung line sharp, every word lifting as it is
// sung), shared by both appearances: the classic now-playing page and effect lyrics, and the space's lyric list.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { ui, useStore } from '../state';
import { engine } from '../playback/stage';
import { fontStack, subLines, buildNpLinePlans, type LyricLine as Line } from '../../engine';
import s from './NpLyrics.module.css';

/* ---------- lyrics ----------
   Every line is a small mass on a spring toward its place (the line itself moves, so what is under the pointer is what
   is seen). When the sung line changes, the lines above move at once and each line below starts a moment after the one
   above it, so the column flows upward like a wave. Inside the sung line each word lifts on its own as it is sung, and
   fills from the left exactly as far as it is sung — nothing lights up ahead of the voice. A wheel looks around and
   settles back after a moment; clicking a line plays from it. */
const K = 140,
  C = 2 * 0.82 * Math.sqrt(K);
/** How far a word has lifted (0..1), as Apple Music lifts it — in stages: a quick first rise as it is struck (a third of
 *  the way in about a tenth of a second), then on with the voice for as long as it is sung (a slow-in, slow-out curve),
 *  and there it stays: never past the top and back down (that read as the word dropping once it had risen, 3.2.4).
 *  dt: since the word began; dur: how long it is sung. */
const LIFT = 5;
function liftAt(dt: number, dur: number) {
  if (dt <= 0) return 0;
  const d = Math.max(0.2, dur);
  // (the strike and the voice's rise added together: one curve from rest to the top, rising all the way, no step anywhere)
  const strike = 0.32 * (1 - (1 - Math.min(1, dt / 0.11)) ** 3),
    u = Math.min(1, dt / d);
  return strike + 0.68 * (u * u * (3 - 2 * u));
}
export { buildNpLinePlans };
interface LS {
  el: HTMLElement;
  y: number;
  v: number;
  ty: number;
  at: number;
  next: number;
  yStr: string;
}
interface LineDom {
  ws: HTMLElement[];
  us: HTMLElement[][];
  hs: HTMLElement[];
  leaves: HTMLElement[];
}
const LIFT_END = `0 ${(-LIFT).toFixed(2)}px`;
const HARM_LIFT_END = `0 ${(-LIFT * 0.6).toFixed(2)}px`;
/** A style written only when it changes: the sung line is painted every frame, but most of its words are sung already or
 *  not yet — writing their same values again made the browser restyle them all each frame for nothing. */
const wrote = new WeakMap<HTMLElement, Record<string, string>>();
/** a wait worth marking: a gap of at least this long (seconds) between the last line's singing and the next line, in the
 *  intro or anywhere in the song; the dots begin this long after the singing is over */
const WAIT_MIN = 5,
  WAIT_AFTER = 0.8;
function put(el: HTMLElement, k: string, v: string) {
  let m = wrote.get(el);
  if (!m) wrote.set(el, (m = {}));
  if (m[k] === v) return;
  m[k] = v;
  if (k === 'translate') el.style.translate = v;
  else el.style.setProperty(k, v);
}
let gens = 0;
export function NpLyrics({ lines, live, compact = false }: { lines: Line[]; live: boolean; compact?: boolean }) {
  const box = useRef<HTMLDivElement>(null),
    dotsEl = useRef<HTMLElement>(null),
    lineEls = useRef<(HTMLElement | null)[]>([]),
    view = useStore(ui, (x) => x.npLyr),
    // (each set of lines gets lines of its own: a line of the song before never lends its place — and what was written
    // on it, its words lifted and lit — to a line of this one)
    gen = useMemo(() => ++gens, [lines]);
  // the lyric face chosen for this page (or the interface's own)
  const faceStyle = useMemo(() => {
    if (!view.font || view.font === 'ui') return {};
    const f = fontStack(
      view.font,
      lines
        .map((L) => L.text)
        .join('')
        .slice(0, 200),
    );
    return { fontFamily: f.stack, fontWeight: f.w };
  }, [view.font, lines]);
  const st = useRef({
    tops: [] as number[],
    ls: [] as (LS | null)[],
    dom: [] as (LineDom | null)[],
    cur: -2,
    manual: 0,
    raf: 0,
    last: 0,
    mTm: 0,
    wait: -1,
    /** the room the dots take while a line is waited for (px): the lines from it on make way for them */
    gap: 0,
    /** the music's level as the glow reads it: eased, so the glow swells and fades with the music, never flickers */
    lvl: 0.5,
    lvlAt: 0,
  });
  // when each line becomes the current one and how each word/character is timed across its singing
  const plans = useMemo(() => {
    const map = engine.session?.map;
    return buildNpLinePlans(lines, map ? (t) => map.beatLen(t) : undefined);
  }, [lines]);
  const starts = useMemo(() => plans.map((p) => p.start), [plans]);
  const findLine = (t: number) => {
    let lo = 0,
      hi = lines.length - 1,
      r = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (starts[m] <= t) {
        r = m;
        lo = m + 1;
      } else hi = m - 1;
    }
    return r;
  };
  // the wait's dots: one row of their own in the list, in the room the waited-for line and those after it make, riding
  // with that line as it moves (they are not part of the line: it keeps its own light, and is not made the current one)
  const placeDots = () => {
    const S = st.current,
      el = dotsEl.current;
    if (!el) return;
    const w = S.wait >= 0 ? S.ls[S.wait] : null;
    if (!w) {
      if (el.dataset.on !== 'false') el.dataset.on = 'false';
      return;
    }
    el.dataset.on = 'true';
    el.style.transform = `translate3d(0,${(S.tops[S.wait] + w.y - 3 - S.gap * 0.5).toFixed(2)}px,0)`;
  };
  const step = (now: number) => {
    const S = st.current,
      dt = Math.min(0.05, Math.max(0.001, (now - S.last) / 1000));
    S.last = now;
    let moving = false;
    for (const w of S.ls) {
      if (!w) continue;
      if (!S.manual && w.el.dataset.far === 'true') {
        if (w.y !== w.next || w.ty !== w.next) {
          w.y = w.ty = w.next;
          w.v = 0;
          const yStr = w.y.toFixed(2);
          if (w.yStr !== yStr) {
            w.yStr = yStr;
            w.el.style.transform = `translate3d(0,${yStr}px,0)`;
          }
        }
        continue;
      }
      if (now >= w.at && w.ty !== w.next) w.ty = w.next;
      if (w.ty !== w.next) moving = true;
      for (let k = 0; k < 2; k++) {
        const h = dt / 2;
        w.v += (K * (w.ty - w.y) - C * w.v) * h;
        w.y += w.v * h;
      }
      if (Math.abs(w.ty - w.y) > 0.12 || Math.abs(w.v) > 0.3) moving = true;
      else {
        w.y = w.ty;
        w.v = 0;
      }
      const yStr = w.y.toFixed(2);
      if (w.yStr !== yStr) {
        w.yStr = yStr;
        w.el.style.transform = `translate3d(0,${yStr}px,0)`;
      }
    }
    placeDots();
    S.raf = moving ? requestAnimationFrame(step) : 0;
  };
  const kick = () => {
    const S = st.current;
    if (!S.raf) {
      S.last = performance.now();
      S.raf = requestAnimationFrame(step);
    }
  };
  // new places around line idx: a wave when the music moves on, together when the user scrolls, at once when jumping
  const aim = (idx: number, wave: boolean, jump: boolean) => {
    const S = st.current,
      H = box.current ? box.current.clientHeight : 600,
      anchor = H * (compact ? 0.38 : 0.34),
      a = S.tops[Math.max(0, idx)] || 0,
      now = performance.now();
    S.ls.forEach((w, i) => {
      if (!w) return;
      // (while a line is waited for, its dots come in as a line of their own: that line and the ones after it make way)
      const d = i - idx,
        ty = anchor - a + S.manual + (S.wait >= 0 && i >= S.wait ? S.gap : 0);
      w.next = ty;
      w.at = now + (wave ? Math.max(0, Math.min(d + 1, 9)) * 52 : 0);
      if (jump) {
        w.y = w.ty = ty;
        w.v = 0;
        w.at = now;
        const yStr = ty.toFixed(2);
        w.yStr = yStr;
        w.el.style.transform = `translate3d(0,${yStr}px,0)`;
      }
    });
    if (!jump) kick();
    else placeDots();
  };
  // (one state of light per line: a line timed only as a whole has a single fill and glow on the line itself, which its
  // words, their characters and its harmonies all inherit — none carries one of its own, so no row or character can
  // light at another moment than the rest; a line timed word by word has one on each of its drawn words or characters)
  const leavesOf = (i: number, el: HTMLElement) =>
    st.current.dom[i]?.leaves ?? [...el.querySelectorAll<HTMLElement>('[data-w]:not([data-u-w]), [data-u], [data-h]')];
  const paintLine = (i: number, t = engine.time) => {
    const L = lines[i],
      plan = plans[i],
      el = lineEls.current[i];
    if (!L || !plan || !el) return;
    const dom = st.current.dom[i],
      ws = dom ? dom.ws : [...el.querySelectorAll<HTMLElement>('[data-w]')],
      lvl = st.current.lvl;
    // a line timed only as a whole lights as a whole, at once, from the moment it is the current line (or its own time,
    // if that is sooner), as Apple Music does: one fill on the line — never dark while current, never faded in
    const t0w = Math.min(starts[i] ?? L.t, L.t);
    if (!L.kar) {
      const on = t >= t0w ? 1 : 0;
      put(el, '--p', String(on));
      put(el, '--gl', on ? (0.6 * lvl).toFixed(2) : '0');
    }
    // each word: its fill (how far it is sung), its glow (only once it is all but sung) and its own lift as it is sung
    plan.words.forEach((wp, k) => {
      const e = ws[k];
      if (!e) return;
      const fill = (node: HTMLElement, t0: number, t1: number) => {
        if (t <= t0) {
          put(node, '--p', '0');
          put(node, '--gl', '0');
          put(node, 'translate', '');
          return;
        }
        const dur = Math.max(0.08, t1 - t0),
          dt = t - t0;
        if (t >= t1 + 0.22 && dt >= Math.max(0.2, dur)) {
          put(node, '--p', '1');
          put(node, '--gl', '0');
          put(node, 'translate', LIFT_END);
          return;
        }
        const q = Math.min(1, dt / dur),
          glIn = Math.min(1, Math.max(0, (q - 0.6) / 0.4)),
          glOut = t <= t1 ? 1 : Math.max(0, 1 - (t - t1) / 0.22),
          gl = glIn * glOut;
        put(node, '--p', q >= 1 ? '1' : q.toFixed(3));
        put(node, '--gl', gl < 0.01 ? '0' : (gl * gl * lvl).toFixed(2));
        put(node, 'translate', `0 ${(-LIFT * liftAt(dt, dur)).toFixed(2)}px`);
      };
      // a word drawn character by character (one that may wrap onto the next row): each character fills in its own
      // time, so a second row lights up only once it is sung
      if (wp.byUnit && L.kar) {
        const us = dom ? dom.us[k] : [...e.querySelectorAll<HTMLElement>('[data-u]')];
        wp.units.forEach((up, ui) => {
          const uEl = us[ui];
          if (uEl) fill(uEl, up.t0, up.t1);
        });
      } else if (!L.kar) put(e, 'translate', '');
      else fill(e, wp.t0, wp.t1);
    });
    // the harmonies: each from its own first sound to its last (at least as long as the word it goes with)
    const hs = dom ? dom.hs : [...el.querySelectorAll<HTMLElement>('[data-h]')];
    plan.harms.forEach((hp, k) => {
      const e = hs[k];
      if (!e) return;
      if (!L.kar) {
        put(e, 'translate', '');
        return;
      }
      if (t <= hp.t0) {
        put(e, '--p', '0');
        put(e, 'translate', '');
        return;
      }
      const dur = Math.max(0.08, hp.t1 - hp.t0),
        dt = t - hp.t0;
      if (t >= hp.t1 && dt >= Math.max(0.2, dur)) {
        put(e, '--p', '1');
        put(e, 'translate', HARM_LIFT_END);
        return;
      }
      const q = Math.min(1, dt / dur);
      put(e, '--p', q >= 1 ? '1' : q.toFixed(3));
      put(e, 'translate', `0 ${(-LIFT * 0.6 * liftAt(dt, dur)).toFixed(2)}px`);
    });
  };
  const mark = (idx: number, t = engine.time) => {
    lineEls.current.forEach((el, i) => {
      if (!el) return;
      const d = i - idx,
        whole = !lines[i]?.kar;
      // a line left in the wake above the current one (including lines skipped over by a forward seek): finish its words
      if (d < 0 && el.dataset.completed !== 'true') {
        leavesOf(i, el).forEach((w) => {
          if (!whole) {
            put(w, 'translate', w.dataset.h != null ? HARM_LIFT_END : LIFT_END);
            put(w, '--p', '1');
          }
          put(w, '--gl', '0');
        });
        if (whole) put(el, '--p', '1');
        put(el, '--gl', '0');
        el.dataset.completed = 'true';
      }
      if (d >= 0 && el.dataset.completed === 'true') delete el.dataset.completed;
      // a line still to come holds nothing from an earlier pass (a seek back, or the line of another song that had this
      // place): its words wait at rest, unlit — never lifted, to drop the moment its voice comes in
      if (d > 0 && (el.dataset.sung === 'true' || el.dataset.on === 'true')) {
        leavesOf(i, el).forEach((w) => {
          put(w, 'translate', '');
          put(w, '--p', '0');
          put(w, '--gl', '0');
        });
        put(el, '--p', '0');
        put(el, '--gl', '0');
        delete el.dataset.sung;
      }
      if (d <= 0) el.dataset.sung = 'true';
      // (becoming current, a line timed as a whole starts from dark on the line itself, its parts holding nothing of their own)
      if (d === 0 && whole) {
        leavesOf(i, el).forEach((w) => {
          w.style.removeProperty('--p');
          w.style.removeProperty('--gl');
          const m = wrote.get(w);
          if (m) {
            delete m['--p'];
            delete m['--gl'];
          }
        });
        put(el, '--p', '0');
        put(el, '--gl', '0');
      }
      put(el, '--d', String(Math.min(5, Math.abs(d))));
      const isOn = String(d === 0);
      if (el.dataset.on !== isOn) el.dataset.on = isOn;
      if (el.dataset.singing === 'true' && d !== 1) delete el.dataset.singing;
      const isFar = !st.current.manual && Math.abs(d) > 10 ? 'true' : 'false';
      if (el.dataset.far !== isFar) el.dataset.far = isFar;
    });
    if (idx >= 0) paintLine(idx, t);
  };
  const measure = () => {
    const S = st.current;
    lineEls.current.forEach((el) => {
      if (el) el.style.transform = '';
    });
    S.tops = lineEls.current.map((el) => (el ? el.offsetTop : 0));
    const fs = lineEls.current.find(Boolean);
    S.gap = fs ? Math.round(parseFloat(getComputedStyle(fs).fontSize) * 0.9) : 0;
    if (box.current) box.current.style.setProperty('--gap', S.gap + 'px');
    S.ls = lineEls.current.map((el) => (el ? { el, y: 0, v: 0, ty: 0, at: 0, next: 0, yStr: '' } : null));
    S.dom = lineEls.current.map((el) => {
      if (!el) return null;
      const ws = [...el.querySelectorAll<HTMLElement>('[data-w]')],
        us = ws.map((w) => [...w.querySelectorAll<HTMLElement>('[data-u]')]),
        hs = [...el.querySelectorAll<HTMLElement>('[data-h]')],
        leaves = [...el.querySelectorAll<HTMLElement>('[data-w]:not([data-u-w]), [data-u], [data-h]')];
      return { ws, us, hs, leaves };
    });
  };
  useLayoutEffect(() => {
    // (before the first line: none is current — the first is not lit before it is sung)
    const S = st.current;
    // (the dots of a wait belong to this set of lines: a wait of the song before is not carried over — kept, the new
    // song's first line never got its dots when it was waited for at the same place)
    S.wait = -1;
    S.manual = 0;
    if (box.current) box.current.dataset.manual = 'false';
    measure();
    const i = findLine(engine.time);
    S.cur = i;
    mark(i);
    aim(i, false, true);
    const ro = new ResizeObserver(() => {
      const keep = S.ls;
      measure();
      S.ls.forEach((w, i) => {
        const o = keep[i];
        if (w && o) {
          w.y = o.y;
          w.v = o.v;
        }
      });
      aim(S.cur, false, true);
    });
    if (box.current) ro.observe(box.current);
    return () => {
      cancelAnimationFrame(S.raf);
      S.raf = 0;
      clearTimeout(S.mTm);
      S.mTm = 0;
      ro.disconnect();
    };
  }, [lines, view.size, view.subs, view.reads]); // (a new size or the translations shown or not: the lines are measured again)
  useEffect(() => {
    if (!live) return;
    const S = st.current,
      i0 = findLine(engine.time);
    if (i0 !== S.cur) {
      S.cur = i0;
      mark(i0);
      aim(i0, false, true);
    } // catch up after being away
    return engine.on('tick', (p) => {
      const i = findLine(p.t);
      if (i !== S.cur) {
        S.cur = i;
        mark(i, p.t);
        aim(i, !S.manual, false);
      }
      // a long wait (the intro, a break): three dots come in above the line to come as a line of their own (it keeps its own
      // light, the list stays on the line sung last), lighting one by one with the wait itself — then, a beat before the voice, one swell in time with
      // the music, and they go as it comes in: the line only lights, it does not arrive. All of it read off the song's
      // time, so a paused song holds the dots still.
      {
        const N = lines[i + 1],
          // (from when the singing is over — not when the line stops being current, a few bars later)
          sungEnd = i < 0 ? 0 : (plans[i]?.sungEnd ?? lines[i].sung),
          from = i < 0 ? 0 : sungEnd + WAIT_AFTER,
          to = N ? starts[i + 1] : 0,
          w = N && to - sungEnd >= WAIT_MIN && to - from >= 2 && p.t >= from && p.t < to ? i + 1 : -1;
        // (the list stays on the current line: the dots make their room below it, they are not a line come round)
        if (w !== S.wait) {
          S.wait = w;
          aim(S.cur, !S.manual, false);
        }
        const el = dotsEl.current;
        if (el && w >= 0) {
          const bl = Math.max(0.25, engine.session?.map?.beatLen(to) ?? 0.5),
            tb = to - bl,
            x = Math.max(0, 1 - Math.abs(p.t - tb) / (bl * 0.5)),
            pulse = (1 - Math.cos(Math.PI * x)) / 2,
            end = Math.min(1, Math.max(0, (p.t - (to - bl * 0.5)) / (bl * 0.5)));
          put(el, '--wait', Math.min(1, (p.t - from) / Math.max(0.5, tb - bl * 0.5 - from)).toFixed(3));
          put(el, '--pulse', pulse.toFixed(3));
          put(el, '--end', end.toFixed(3));
        }
      }
      {
        const now = performance.now(),
          k = Math.min(1, Math.max(0, (now - S.lvlAt) / 1000) * 4);
        S.lvlAt = now;
        S.lvl += ((p.rs ? p.rs.level : 0.5) - S.lvl) * k;
      }
      // (the current line — and a line already begun under it, still waiting to be current: its words are sung meanwhile)
      paintLine(i, p.t);
      if (lines[i + 1] && p.t >= lines[i + 1].t) {
        const nextEl = lineEls.current[i + 1];
        if (nextEl && nextEl.dataset.singing !== 'true') nextEl.dataset.singing = 'true';
        paintLine(i + 1, p.t);
      }
    });
  }, [lines, live]);
  const wheel = (e: React.WheelEvent) => {
    const S = st.current,
      a = S.tops[Math.max(0, S.cur)] || 0,
      lastTop = S.tops[Math.max(0, S.tops.length - 1)] || 0,
      minM = Math.min(0, a - lastTop - 40),
      maxM = Math.max(0, a + 40);
    S.manual = Math.max(minM, Math.min(maxM, S.manual - e.deltaY));
    clearTimeout(S.mTm);
    aim(S.cur, false, false);
    if (box.current) box.current.dataset.manual = 'true';
    S.mTm = window.setTimeout(() => {
      S.manual = 0;
      if (box.current) box.current.dataset.manual = 'false';
      mark(S.cur);
      aim(S.cur, false, false);
    }, 2600);
  };
  return (
    <div
      data-np-lyr
      className={s.lyr + (compact ? ' ' + s.compact : '')}
      ref={box}
      onWheel={wheel}
      data-blur={view.blur}
      data-subs={view.subs}
      style={{ ['--np-fs' as string]: view.size, ...faceStyle } as React.CSSProperties}
    >
      <i className={s.dots} ref={dotsEl} data-on="false" aria-hidden>
        <i />
        <i />
        <i />
      </i>
      {lines.map((L, i) => (
        <button
          key={gen + ':' + i}
          type="button"
          data-test="line"
          className={s.line}
          data-whole={!L.kar || undefined}
          ref={(el) => {
            lineEls.current[i] = el;
          }}
          onClick={() => {
            st.current.manual = 0;
            engine.seek(Math.max(0, L.t - 0.05));
            if (!engine.isPlaying) engine.play();
          }}
        >
          {plans[i]?.words.length ? (
            plans[i].words.map((wp, k) => (
              <Fragment key={k}>
                {wp.byUnit ? (
                  <span data-w data-u-w className={s.wu}>
                    {wp.units.map((u, ui) => (
                      <span key={ui} data-u className={s.w}>
                        {u.c}
                        {u.spaceAfter ? ' ' : ''}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span data-w className={s.w}>
                    {wp.text}
                    {wp.spaceAfter ? ' ' : ''}
                  </span>
                )}
              </Fragment>
            ))
          ) : (
            <span data-w className={s.w}>
              {L.text}
            </span>
          )}
          {/* the harmonies, as Apple Music shows backing vocals: their own smaller line under the words, each lit as it is sung */}
          {L.words.some((w) => w.harm) && (
            <span className={s.harmRow}>
              {L.words
                .filter((w) => w.harm)
                .map((w, k, a) => (
                  <span key={k} data-h className={s.w}>
                    {w.harm!.text}
                    {k < a.length - 1 ? ' ' : ''}
                  </span>
                ))}
            </span>
          )}
          {/* readings (softer than translations; one that only repeats the line left out), translations, and a translation's
              bracketed part on a line of its own, as a harmony is */}
          {subLines(L, view.reads !== false).map((x, k) => (
            <small key={k} data-kind={x.kind}>
              {x.s}
            </small>
          ))}
        </button>
      ))}
    </div>
  );
}
