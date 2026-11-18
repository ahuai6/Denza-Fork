import type { Line } from './model';
import { graphemes } from '../text/script';

export interface NpUnitPlan {
  c: string;
  spaceAfter: boolean;
  t0: number;
  t1: number;
}
export interface NpWordPlan {
  byUnit: boolean;
  text: string;
  spaceAfter: boolean;
  t0: number;
  t1: number;
  units: NpUnitPlan[];
}
export interface NpHarmPlan {
  t0: number;
  t1: number;
}
export interface NpLinePlan {
  start: number;
  sungEnd: number;
  text: string;
  charTimes: number[];
  words: NpWordPlan[];
  harms: NpHarmPlan[];
}

function tokenizeDisplayWord(w: Line['words'][number], wordSpaceAfter: boolean) {
  const disp = w.disp ?? w.text;
  if (w.latin || w.complex) {
    const trimmed = disp.trim();
    if (!/\s/.test(trimmed)) {
      return {
        byUnit: false,
        tokens: [{ c: disp, spaceAfter: wordSpaceAfter, weight: Math.max(1, graphemes(trimmed || disp).length) }],
      };
    }
    const parts = trimmed.split(/\s+/).filter(Boolean);
    return {
      byUnit: parts.length > 1,
      tokens: parts.map((p, idx) => ({
        c: p,
        spaceAfter: idx < parts.length - 1 ? true : wordSpaceAfter,
        weight: Math.max(1, graphemes(p).length),
      })),
    };
  }
  const tokens: { c: string; spaceAfter: boolean; weight: number }[] = [];
  for (const g of graphemes(disp)) {
    if (/^\s+$/.test(g)) {
      if (tokens.length) tokens[tokens.length - 1].spaceAfter = true;
    } else {
      tokens.push({ c: g, spaceAfter: false, weight: 1 });
    }
  }
  if (!tokens.length) tokens.push({ c: disp, spaceAfter: wordSpaceAfter, weight: 1 });
  else if (wordSpaceAfter) tokens[tokens.length - 1].spaceAfter = true;
  return { byUnit: tokens.length > 1, tokens };
}

/** Build the Now-Playing timing and character-display plan for every line:
 *  - preserves internal spaces from `w.disp` and inter-word `w.gap`;
 *  - subdivides multi-character timestamps and equal-timestamp runs sequentially across characters/tokens;
 *  - sustains TTML and LRC words across their full singing interval and prevents premature line-switch cut-offs. */
export function buildNpLinePlans(lines: Line[], beatLen?: (t: number) => number): NpLinePlan[] {
  const plans: NpLinePlan[] = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i],
      nextL = lines[i + 1];
    const rawUnits = L.kar
      ? L.words.flatMap((w) =>
          w.units
            .filter((u) => u.t != null)
            .map((u) => ({
              t: u.t!,
              e: u.e,
              n: Math.max(1, graphemes(u.c.replace(/\s+/g, '')).length),
            })),
        )
      : [];
    const charPaces: number[] = [];
    for (let a = 0; a < rawUnits.length; ) {
      let b = a,
        chars = rawUnits[a].n;
      while (b + 1 < rawUnits.length && rawUnits[b + 1].t <= rawUnits[a].t + 1e-4) {
        b++;
        chars += rawUnits[b].n;
      }
      if (b + 1 < rawUnits.length) {
        const dt = rawUnits[b + 1].t - rawUnits[a].t;
        if (dt > 0.02) charPaces.push(dt / Math.max(1, chars));
      } else if (rawUnits[b].e != null && rawUnits[b].e! > rawUnits[a].t + 0.02) {
        charPaces.push((rawUnits[b].e! - rawUnits[a].t) / Math.max(1, chars));
      }
      a = b + 1;
    }
    charPaces.sort((x, y) => x - y);
    const pace = charPaces.length ? Math.min(0.85, Math.max(0.18, charPaces[charPaces.length >> 1])) : 0.38;

    const tokenized = L.words.map((w, k) => {
      const wordSpaceAfter = k < L.words.length - 1 && Boolean(w.gap ?? (w.latin && L.words[k + 1]?.latin));
      return { w, wordSpaceAfter, ...tokenizeDisplayWord(w, wordSpaceAfter) };
    });

    const wordIntervals: { t0: number; t1: number; sharedRun: boolean }[] = new Array(L.words.length);
    for (let wa = 0; wa < L.words.length; ) {
      let wb = wa;
      const runStart = L.words[wa].t;
      if (L.kar) {
        while (wb + 1 < L.words.length && L.words[wb + 1].t <= runStart + 1e-4) wb++;
      }
      const lastWord = L.words[wb],
        lu = lastWord.units[lastWord.units.length - 1],
        lastUnitT = Math.max(runStart, ...lastWord.units.map((u) => u.t ?? runStart)),
        nextWordT = wb + 1 < L.words.length ? L.words[wb + 1].t : null;
      let runEnd: number;
      if (!L.kar) {
        runEnd = nextWordT != null && nextWordT > runStart ? Math.min(lastWord.end, nextWordT) : lastWord.end;
      } else if (lu?.e != null || lastWord.endGiven) {
        const givenEnd = lu?.e ?? lastWord.end;
        runEnd = nextWordT != null && nextWordT > runStart ? Math.min(givenEnd, nextWordT) : givenEnd;
      } else if (nextWordT != null && nextWordT > lastUnitT) {
        const lastChars = Math.max(1, graphemes((lu?.c || lastWord.text).replace(/\s+/g, '')).length);
        runEnd = Math.min(nextWordT, lastUnitT + Math.max(1.4, pace * 2.4 * lastChars));
      } else if (L.close != null && L.close > lastUnitT) {
        runEnd = L.close;
      } else {
        const lastChars = Math.max(1, graphemes((lu?.c || lastWord.text).replace(/\s+/g, '')).length),
          naturalHold = Math.max(0.65, pace * 1.6 * lastChars),
          cap = nextL && nextL.t > lastUnitT ? nextL.t : Math.max(lastUnitT + 0.65, L.end);
        runEnd = Math.min(cap, lastUnitT + naturalHold);
      }
      runEnd = Math.max(runEnd, lastUnitT + 0.12);
      if (wb === wa) {
        wordIntervals[wa] = { t0: runStart, t1: runEnd, sharedRun: false };
      } else {
        const weights = tokenized.slice(wa, wb + 1).map((tk) => tk.tokens.reduce((s, x) => s + x.weight, 0)),
          totalW = Math.max(
            1,
            weights.reduce((a, b) => a + b, 0),
          );
        let acc = 0;
        for (let m = wa; m <= wb; m++) {
          const w0 = runStart + ((runEnd - runStart) * acc) / totalW;
          acc += weights[m - wa];
          const w1 = runStart + ((runEnd - runStart) * acc) / totalW;
          wordIntervals[m] = { t0: w0, t1: Math.max(w0 + 0.08, w1), sharedRun: true };
        }
      }
      wa = wb + 1;
    }

    const words: NpWordPlan[] = tokenized.map(({ w, wordSpaceAfter, byUnit, tokens }, k) => {
      const { t0: wStart, t1: wEnd, sharedRun } = wordIntervals[k];
      if (!byUnit) {
        const tok = tokens[0];
        return {
          byUnit: false,
          text: tok.c,
          spaceAfter: tok.spaceAfter,
          t0: wStart,
          t1: wEnd,
          units: [{ c: tok.c, spaceAfter: tok.spaceAfter, t0: wStart, t1: wEnd }],
        };
      }
      const units: NpUnitPlan[] = [];
      if (!L.kar || sharedRun || w.units.length <= 1) {
        const totalW = Math.max(
          1,
          tokens.reduce((s, x) => s + x.weight, 0),
        );
        let acc = 0;
        for (const tok of tokens) {
          const u0 = wStart + ((wEnd - wStart) * acc) / totalW;
          acc += tok.weight;
          const u1 = wStart + ((wEnd - wStart) * acc) / totalW;
          units.push({ c: tok.c, spaceAfter: tok.spaceAfter, t0: u0, t1: Math.max(u0 + 0.08, u1) });
        }
      } else {
        const slices: { c: string; spaceAfter: boolean; weight: number }[][] = [];
        let cursor = 0;
        for (let j = 0; j < w.units.length; j++) {
          const u = w.units[j];
          const count =
            j === w.units.length - 1
              ? Math.max(0, tokens.length - cursor)
              : w.latin || w.complex
                ? Math.max(1, u.c.trim().split(/\s+/).filter(Boolean).length)
                : Math.max(1, graphemes(u.c.replace(/\s+/g, '')).length);
          slices.push(tokens.slice(cursor, cursor + count));
          cursor += count;
        }
        if (cursor < tokens.length && slices.length) {
          slices[slices.length - 1].push(...tokens.slice(cursor));
        }
        for (let ua = 0; ua < w.units.length; ) {
          let ub = ua;
          const baseT = ua === 0 ? wStart : Math.max(wStart, w.units[ua].t ?? wStart);
          while (ub + 1 < w.units.length && (w.units[ub + 1].t ?? baseT) <= baseT + 1e-4) ub++;
          const runToks = slices.slice(ua, ub + 1).flat();
          if (runToks.length) {
            const lastU = w.units[ub],
              nextUT = ub + 1 < w.units.length ? w.units[ub + 1].t : null;
            let uRunEnd: number;
            if (lastU.e != null) {
              uRunEnd = nextUT != null && nextUT > baseT ? Math.min(lastU.e, nextUT) : Math.min(lastU.e, wEnd);
            } else if (nextUT != null && nextUT > baseT) {
              const runWeight = Math.max(
                1,
                runToks.reduce((s, x) => s + x.weight, 0),
              );
              uRunEnd = Math.min(nextUT, baseT + Math.max(1.4, pace * 2.4 * runWeight));
            } else {
              uRunEnd = wEnd;
            }
            uRunEnd = Math.max(uRunEnd, baseT + 0.08);
            const totalW = Math.max(
              1,
              runToks.reduce((s, x) => s + x.weight, 0),
            );
            let acc = 0;
            for (const tok of runToks) {
              const u0 = baseT + ((uRunEnd - baseT) * acc) / totalW;
              acc += tok.weight;
              const u1 = baseT + ((uRunEnd - baseT) * acc) / totalW;
              units.push({ c: tok.c, spaceAfter: tok.spaceAfter, t0: u0, t1: Math.max(u0 + 0.08, u1) });
            }
          }
          ua = ub + 1;
        }
      }
      return {
        byUnit: true,
        text: w.disp ?? w.text,
        spaceAfter: wordSpaceAfter,
        t0: wStart,
        t1: wEnd,
        units,
      };
    });

    const harms: NpHarmPlan[] = [];
    L.words.forEach((w, k) => {
      if (!w.harm) return;
      const H = w.harm,
        wp = words[k],
        t0 = isFinite(H.t) ? H.t : wp.t0,
        lastU = H.units[H.units.length - 1],
        lastT = lastU?.t ?? t0,
        t1 = Math.max(t0 + 0.3, lastU?.e ?? lastT + Math.max(0.45, pace * 1.2), wp.t1);
      harms.push({ t0, t1 });
    });

    const sungEnd = L.kar ? (words.length ? Math.max(...words.map((w) => w.t1)) : L.sung) : Math.min(L.sung, L.end);

    const P = lines[i - 1],
      pPlan = plans[i - 1],
      bl = beatLen ? beatLen(L.t) : 0.5;
    let start: number;
    if (!P || !pPlan) {
      start = L.t - 0.15;
    } else {
      const pLastW = P.words[P.words.length - 1],
        pHoldEnd = pLastW?.endGiven && pPlan.sungEnd > L.t ? pPlan.sungEnd : Math.min(pPlan.sungEnd, L.t);
      start = Math.max(pHoldEnd, L.t - pPlan.sungEnd >= bl ? L.t - bl / 2 : L.t - 0.15);
    }

    const text = words.length
      ? words
          .flatMap((w) => w.units.map((u) => u.c + (u.spaceAfter ? ' ' : '')))
          .join('')
          .trim()
      : L.text;
    const charTimes: number[] = [];
    if (L.kar) {
      for (const wp of words) {
        for (const up of wp.units) {
          const chars = [...up.c].filter((ch) => ch !== ' ');
          const m = Math.max(1, chars.length);
          for (let r = 0; r < chars.length; r++) {
            charTimes.push(up.t0 + ((up.t1 - up.t0) * r) / m);
          }
        }
      }
    }

    plans.push({ start, sungEnd, text, charTimes, words, harms });
  }
  return plans;
}
