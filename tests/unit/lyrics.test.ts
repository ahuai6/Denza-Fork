import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse, parseLyrics, parseRange } from '../../src/lyrics/parse';
import { buildLyrics, FUSE } from '../../src/lyrics/model';
import { buildNpLinePlans } from '../../src/lyrics/np-plan';
import { respace } from '../../src/lyrics/spacing';
import { RhythmMap } from '../../src/rhythm/map';
import { plan } from '../../src/director';
import { wordState, unitPose } from '../../src/director/words';
import { approxMeasurer } from '../../src/text/metrics';
import { presetStyle } from '../../src/theme/style';

const map = RhythmMap.grid(120, 0, 120);
describe('lyrics', () => {
  it('parses plain, word-timed, repeated and translated lines', () => {
    const p = parse(
      `[ti:Song]\n[00:01.00]hello world\n[00:01.00]你好世界\n[00:04.00]<00:04.00>sing <00:04.50>a<00:05.00>long <00:06.00>\n[00:08.00][00:20.00]chorus line\n[00:10.00]\n[00:12.00]next`,
    );
    expect(p.meta.ti).toBe('Song');
    expect(p.lines.map((l) => l.t)).toEqual([1, 4, 8, 12, 20]);
    expect(p.lines[0].subs).toEqual(['你好世界']);
    expect(p.lines[1].kar!.map((s) => s.map((u) => u.c).join(''))).toEqual(['sing', 'along']);
    expect(p.lines[1].close).toBe(6);
    expect(p.lines[2].stop).toBe(10);
  });
  it('applies [offset] and the audio range', () => {
    const p = parse(`[offset:+500]\n[00:10.00]a`, 2);
    expect(p.lines[0].t).toBeCloseTo(7.5, 5);
    expect(parseRange('1:20-3:00')).toEqual({ a: 80, b: 180 });
    expect(parseRange('')).toEqual({ a: 0, b: null });
  });
  it('fast word timing is one gesture: <25.570>１ <25.600>２ <25.630>３ share a framing group', () => {
    const d = buildLyrics(parse('[00:25.57]<00:25.570>１ <00:25.600>２ <00:25.630>３<00:25.660>'), map, 60);
    const w = d.lines[0].words;
    expect(w.map((x) => x.text)).toEqual(['１', '２', '３']);
    expect(new Set(w.map((x) => x.group)).size).toBe(1);
    expect(w[2].t - w[0].t).toBeLessThan(FUSE);
  });
  it('paces line-timed words on the beat, in order, inside the line', () => {
    const d = buildLyrics(parse('[00:02.00] 我們 沿著 街道 慢慢走\n[00:08.00] next'), map, 30);
    const w = d.lines[0].words;
    expect(w.length).toBe(4);
    for (let i = 1; i < w.length; i++) expect(w[i].t).toBeGreaterThan(w[i - 1].t);
    expect(w[3].t).toBeLessThan(d.lines[0].end);
    const onGrid = w.slice(1).filter((x) => Math.abs(x.t * 4 - Math.round(x.t * 4)) < 0.01).length;
    expect(onGrid).toBeGreaterThanOrEqual(2);
    expect(d.lines[0].words[3].rest).toBeGreaterThan(1);
  });
  it('breaks words at spaces only (a lone character going with its neighbour): an unspaced line is one word, its characters still sung one at a time', () => {
    const d = buildLyrics(
      parse('[00:01.00]我們沿著熟悉的街道慢慢走回家\n[00:05.00]走過 這條 街\n[00:09.00]x'),
      map,
      20,
    );
    const w = d.lines[0].words;
    expect(w.map((x) => x.text)).toEqual(['我們沿著熟悉的街道慢慢走回家']);
    expect(w[0].paced).toBe(true);
    for (let i = 1; i < w[0].units.length; i++) expect(w[0].units[i].t!).toBeGreaterThan(w[0].units[i - 1].t!);
    expect(d.lines[1].words.map((x) => x.text)).toEqual(['走過', '這條街']);
  });
  it('chorus marks (#1 strongest, #2 or a bare #, #3 lighter) are read and never shown', () => {
    const d = buildLyrics(
      parse(
        '[00:01.00]#1 夜に駆ける\n[00:04.00]走過 #3這條 街\n[00:07.00]#\n[00:08.00]<00:08.00>#2sing <00:08.50>a<00:09.00>long<00:09.50>\n[00:12.00]x',
      ),
      map,
      20,
    );
    expect(d.lines.map((L) => L.text)).toEqual(['夜に駆ける', '走過 這條 街', 'sing along', 'x']);
    expect(
      d.lines.every((L) => L.words.every((W) => !/[#]/.test(W.text) && W.units.every((u) => !/[#]/.test(u.c)))),
    ).toBe(true);
    expect(d.marks.map((m) => [m.t, m.level])).toEqual(
      [
        [1, 1],
        [expect.any(Number), 3],
        [7, 2],
        [8, 2],
      ].map(([a, b]) => [a, b]) as never,
    );
    expect(d.marks[1].t).toBeGreaterThan(4);
  });
  it('a harmony in brackets goes with the word before it, its brackets never shown, its own timing kept', () => {
    const d = buildLyrics(
      parse(
        '[00:01.00]I love you (love you) so\n[00:04.00]想你（想你）\n[00:07.00]<00:07.00>stay <00:07.50>(stay<00:07.80> here) <00:08.20>now<00:08.80>\n[00:12.00](oh oh)',
      ),
      map,
      20,
    );
    const [a, b, c, e] = d.lines;
    expect(a.words.map((W) => W.text)).toEqual(['I', 'love', 'you', 'so']);
    expect(a.words[2].harm!.text).toBe('love you');
    expect(b.words.map((W) => W.text)).toEqual(['想你']);
    expect(b.words[0].harm!.text).toBe('想你');
    expect(c.words.map((W) => W.text)).toEqual(['stay', 'now']);
    expect(c.words[0].harm!.text).toBe('stay here');
    expect(c.words[0].harm!.t).toBeCloseTo(7.5, 5);
    expect(e.words.map((W) => W.text)).toEqual(['oh', 'oh']); // a line only in brackets is sung as itself
    expect(d.lines.every((L) => !/[()（）]/.test(L.text))).toBe(true);
  });
  it("an older file's '#' after a sung unit is still a word break", () => {
    const d = buildLyrics(
      parse(
        '[00:00.00]<00:00.00>清<00:00.25>晨<00:00.50>的#<00:01.00>光<00:01.25>落<00:01.50>在#<00:02.00>窗<00:02.50>邊<00:03.40>\n[00:05.00]x',
      ),
      map,
      20,
    );
    expect(d.lines[0].words.map((W) => W.text)).toEqual(['清晨的', '光落在', '窗邊']);
    expect(d.marks.length).toBe(0);
  });
});

describe('word stamps with nothing after them', () => {
  it('a stamp followed only by a space ends the word before it (it is sustained to there, then a breath)', () => {
    const p = parse('[00:20.00]<00:20.560>stop <00:21.180> <00:22.260>feeling<00:22.800>\n[00:25.00]next');
    const d = buildLyrics(p, RhythmMap.grid(120, 0, 60), 40),
      [a, b] = d.lines[0].words;
    expect(d.lines[0].words.length).toBe(2);
    expect(a.text).toBe('stop');
    expect(a.end).toBeCloseTo(21.18, 2);
    expect(b.text).toBe('feeling');
    expect(b.end).toBeCloseTo(22.8, 2);
  });
});

describe('harmonies hold nothing', () => {
  it("a stamp after a harmony ends the harmony, not the line's own last word", () => {
    const p = parse(
      '[00:01.00]<00:01.00>hold <00:01.50>on<00:02.00>(<00:02.10>oh <00:02.60>yeah)<00:04.00>\n[00:03.00]<00:03.00>next',
    );
    const L = p.lines[0],
      on = L.words[L.words.length - 1];
    expect(on.units!.at(-1)!.e).toBeCloseTo(2, 3);
    expect(L.close).toBeUndefined(); // (it ends where the harmony opens)
    expect(on.harm!.units!.at(-1)!.e).toBeCloseTo(4, 3);
    // (so the line's own last word is over before the next line, and nothing waits for the harmony)
    const doc = buildLyrics(p, RhythmMap.grid(120, 0, 40), 30),
      W = doc.lines[0].words.at(-1)!;
    expect(W.end).toBeCloseTo(2, 3);
    expect(doc.lines[0].sung).toBeLessThan(3);
  });
  it('a line timed only as a whole: its harmony comes with the line', () => {
    const doc = buildLyrics(parse('[00:01.00]hold on to me (oh yeah)\n[00:06.00]next'), RhythmMap.grid(120, 0, 40), 30);
    const W = doc.lines[0].words.find((w) => w.harm)!;
    expect(W.harm!.t).toBe(doc.lines[0].t);
  });
});

describe('Now Playing word-timed schedule, multi-char timestamps and space preservation', () => {
  const map = RhythmMap.grid(120, 0, 60);

  it('subdivides multi-character single timestamps and shared timestamps sequentially instead of lighting all at once', () => {
    // 1) LRC single timestamp covering multiple CJK characters + duplicate timestamps on consecutive characters
    const doc = buildLyrics(
      parse('[00:01.00]<00:01.00>我们的<00:02.20>故<00:02.20>事<00:03.00>\n[00:05.00]next'),
      map,
      30,
    );
    const plan = buildNpLinePlans(doc.lines, (t) => map.beatLen(t))[0];
    const units = plan.words.flatMap((w) => w.units);
    expect(units.map((u) => u.c)).toEqual(['我', '们', '的', '故', '事']);
    expect(units[0].t0).toBeCloseTo(1.0, 2);
    expect(units[0].t1).toBeCloseTo(1.4, 2);
    expect(units[1].t0).toBeCloseTo(1.4, 2);
    expect(units[1].t1).toBeCloseTo(1.8, 2);
    expect(units[2].t0).toBeCloseTo(1.8, 2);
    expect(units[2].t1).toBeCloseTo(2.2, 2);
    expect(units[3].t0).toBeCloseTo(2.2, 2);
    expect(units[3].t1).toBeCloseTo(2.6, 2);
    expect(units[4].t0).toBeCloseTo(2.6, 2);
    expect(units[4].t1).toBeCloseTo(3.0, 2);

    // 2) TTML span covering multiple CJK characters (<span begin="00:02.00" end="00:02.50">清晨</span>)
    const ttml = `<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
      <p begin="00:02.00" end="00:04.20"><span begin="00:02.00" end="00:02.50">清晨</span> <span begin="00:02.50" end="00:03.10">的</span> <span begin="00:03.10" end="00:04.20">光</span></p>
    </div></body></tt>`;
    const ttmlDoc = buildLyrics(parseLyrics(ttml), map, 30);
    const ttmlPlan = buildNpLinePlans(ttmlDoc.lines, (t) => map.beatLen(t))[0];
    const ttmlUnits = ttmlPlan.words.flatMap((w) => w.units);
    expect(ttmlUnits.map((u) => u.c)).toEqual(['清', '晨', '的', '光']);
    expect(ttmlUnits[0].t0).toBeCloseTo(2.0, 2);
    expect(ttmlUnits[0].t1).toBeCloseTo(2.25, 2);
    expect(ttmlUnits[1].t0).toBeCloseTo(2.25, 2);
    expect(ttmlUnits[1].t1).toBeCloseTo(2.5, 2);
    expect(ttmlUnits[2].t0).toBeCloseTo(2.5, 2);
    expect(ttmlUnits[2].t1).toBeCloseTo(3.1, 2);
    expect(ttmlUnits[3].t0).toBeCloseTo(3.1, 2);
    expect(ttmlUnits[3].t1).toBeCloseTo(4.2, 2);
  });

  it('sustains unclosed LRC words and prevents premature line-switch cut-offs while the previous line is still singing', () => {
    const doc = buildLyrics(
      parse('[00:01.00]<00:01.00>Hello <00:02.00>world<00:03.00>\n[00:03.02]<00:03.02>Next <00:03.80>line'),
      map,
      30,
    );
    const plans = buildNpLinePlans(doc.lines, (t) => map.beatLen(t));
    // Word 0 ("Hello") without explicit end stamp sustains up to Word 1 ("world") at 2.0s instead of stopping at 1.25s
    expect(plans[0].words[0].t0).toBeCloseTo(1.0, 2);
    expect(plans[0].words[0].t1).toBeCloseTo(2.0, 2);
    expect(plans[0].words[1].t0).toBeCloseTo(2.0, 2);
    expect(plans[0].words[1].t1).toBeCloseTo(3.0, 2);
    expect(plans[0].sungEnd).toBeCloseTo(3.0, 2);
    // Line 1 starts at 3.02s right after Line 0 ends at 3.00s: it must not switch at 3.02 - 0.15 = 2.87s while Line 0 sings
    expect(plans[1].start).toBeGreaterThanOrEqual(plans[0].sungEnd);
    // Unclosed final word on Line 1 ("line" at 3.80s) sustains well past 0.25s
    expect(plans[1].words[1].t1 - plans[1].words[1].t0).toBeGreaterThanOrEqual(0.65);
  });

  it('preserves spaces in joined CJK phrases, timed space stamps, TTML space spans, and multi-word single timestamps', () => {
    // 1) Spaced CJK words joined by phrasing + timed space stamp (<00:01.50> )
    const cjkDoc = buildLyrics(
      parse('[00:01.00]<00:01.00>清晨 <00:01.25>的 <00:01.80>光<00:02.20> <00:02.60>照亮<00:03.20>'),
      map,
      30,
    );
    const cjkPlan = buildNpLinePlans(cjkDoc.lines)[0];
    const renderedCjk = cjkPlan.words.flatMap((w) => w.units.map((u) => u.c + (u.spaceAfter ? ' ' : ''))).join('');
    expect(renderedCjk).toBe('清晨 的 光 照亮');

    // 2) TTML whitespace-only timed span between words
    const ttmlSpace = `<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
      <p begin="00:01.00" end="00:03.00"><span begin="00:01.00" end="00:01.50">Hello</span><span begin="00:01.50" end="00:01.60"> </span><span begin="00:01.60" end="00:02.50">世界</span></p>
    </div></body></tt>`;
    const ttmlSpaceDoc = buildLyrics(parseLyrics(ttmlSpace), map, 30);
    const ttmlSpacePlan = buildNpLinePlans(ttmlSpaceDoc.lines)[0];
    const renderedTtml = ttmlSpacePlan.words
      .flatMap((w) => w.units.map((u) => u.c + (u.spaceAfter ? ' ' : '')))
      .join('');
    expect(renderedTtml).toBe('Hello 世界');

    // 3) Single timestamp covering multiple space-separated words through respace()
    const multiWordDoc = buildLyrics(respace(parse('[00:01.00]<00:01.00>I love <00:01.80>you<00:02.50>')), map, 30);
    const multiWordPlan = buildNpLinePlans(multiWordDoc.lines)[0];
    const renderedMulti = multiWordPlan.words
      .flatMap((w) => w.units.map((u) => u.c + (u.spaceAfter ? ' ' : '')))
      .join('');
    expect(renderedMulti).toBe('I love you');

    // 4) NpLyrics CSS avoids group-opacity division spike and uses break-spaces so trailing spaces do not hang
    const css = readFileSync(new URL('../../src/app/ui/NpLyrics.module.css', import.meta.url), 'utf8');
    expect(css).not.toContain('calc(var(--bu) /');
    expect(css).toContain('white-space: break-spaces;');
  });

  it('unifies sequential character lighting across 2D Effect Lyrics (director/words) and 3D Space Scene Lyrics (charTimes)', () => {
    const doc = buildLyrics(
      parse('[00:01.00]<00:01.00>我们的<00:02.20>故<00:02.20>事<00:03.00>\n[00:05.00]next'),
      map,
      30,
    );
    // 1) Unified model.ts units: already decomposed into 5 sequential character units
    const modelUnits = doc.lines[0].words.flatMap((w) => w.units);
    expect(modelUnits.map((u) => u.c)).toEqual(['我', '们', '的', '故', '事']);
    expect(modelUnits.map((u) => Number(u.t?.toFixed(2)))).toEqual([1.0, 1.4, 1.8, 2.2, 2.6]);

    // 2) 2D Effect Lyrics (plan + wordState + unitPose): characters light one by one from ghost -> lit
    const scene = plan({
      doc,
      map,
      style: presetStyle('cover'),
      measure: approxMeasurer(),
      aspect: 16 / 9,
      musicEnd: 30,
      endLen: 3.5,
      song: { on: true, title: 'T', artist: 'A' },
      labels: { composer: 'c', lyricist: 'l', artist: 'a' },
    });
    const pw = scene.lines[0].words[0];
    const ctx = {
      enter: 0.25,
      tempo: 1,
      float: 0,
      future: 'dim' as const,
      smooth: true,
      punch: 0.3,
      motion: 1,
      drift: false,
    };
    const ghostsAt = (t: number) => {
      const ws = wordState(pw, t, 0, false, ctx)!;
      return pw.units.slice(0, 3).map((_, ui) => unitPose(pw, ui, t, ws, 0, ctx)!.ghost);
    };
    // At t=1.10s: '我' is lit (ghost=false), while '们' and '的' are still ghosts (ghost=true)
    expect(ghostsAt(1.1)).toEqual([false, true, true]);
    // At t=1.50s: '我' and '们' are lit, while '的' is still a ghost
    expect(ghostsAt(1.5)).toEqual([false, false, true]);
    // At t=1.90s: all three '我', '们', '的' are lit
    expect(ghostsAt(1.9)).toEqual([false, false, false]);

    // 3) 3D Space Scene Lyrics (plan.charTimes fed into AirLine.times): one sequential timestamp per character
    const npPlan = buildNpLinePlans(doc.lines, (t) => map.beatLen(t))[0];
    expect(npPlan.charTimes.map((t) => Number(t.toFixed(2)))).toEqual([1.0, 1.4, 1.8, 2.2, 2.6]);
  });

  it('handles edge cases: leading text before first <tag>, TTML inline punctuation, out-of-order stamps, and empty lists', () => {
    expect(buildNpLinePlans([])).toEqual([]);

    // Leading word before first <mm:ss.xx> tag
    const leadDoc = buildLyrics(parse('[00:01.00]Hello <00:01.50>world<00:02.00>'), map, 30);
    expect(leadDoc.lines[0].words.map((w) => [w.text, w.t])).toEqual([
      ['Hello', 1.0],
      ['world', 1.5],
    ]);

    // TTML plain text punctuation between timed spans
    const ttmlPunct = `<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
      <p begin="00:01.00" end="00:02.20"><span begin="00:01.00" end="00:01.50">Hello</span>, <span begin="00:01.60" end="00:02.20">world</span></p>
    </div></body></tt>`;
    const punctPlan = buildNpLinePlans(buildLyrics(parseLyrics(ttmlPunct), map, 30).lines)[0];
    expect(punctPlan.text).toBe('Hello, world');

    // Out-of-order / decreasing timestamps within a line are normalized to strictly increasing intervals
    const outOfOrderDoc = buildLyrics(parse('[00:02.00]<00:02.00>甲<00:01.80>乙<00:02.60>丙<00:03.00>'), map, 30);
    const outUnits = buildNpLinePlans(outOfOrderDoc.lines)[0].words.flatMap((w) => w.units);
    expect(outUnits.map((u) => u.c)).toEqual(['甲', '乙', '丙']);
    for (const u of outUnits) {
      expect(Number.isFinite(u.t0)).toBe(true);
      expect(Number.isFinite(u.t1)).toBe(true);
      expect(u.t1).toBeGreaterThan(u.t0);
    }
    expect(outUnits[1].t0).toBeGreaterThan(outUnits[0].t0);
    expect(outUnits[2].t0).toBeGreaterThan(outUnits[1].t0);
  });
});
