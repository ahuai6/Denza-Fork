import { parseLyrics } from './parse';
import { isTtml, ttmlToLrc } from './ttml';
import { looksRomaji } from './subs';

export interface TranslationLine {
  id: string;
  t: number;
  text: string;
  translation: string;
}
export interface TranslationFragment {
  index: number;
  text: string;
  t: number | null;
  source?: string;
}
export interface TranslationMatch {
  id: string;
  fragments: number[];
  evidence: 'time' | 'source' | 'order' | 'manual' | 'model';
}
const key = (t: number) => Math.round(t * 100);
const id = (t: number) => 'line.' + key(t);
const stamp = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g;
const seconds = (m: string, s: string, fraction?: string) => +m * 60 + +s + +(fraction ? '0.' + fraction : 0);
export const translationLrc = (source: string) => (isTtml(source) ? ttmlToLrc(source) : source);
export function translationLines(source: string): TranslationLine[] {
  return parseLyrics(translationLrc(source)).lines.map((line) => ({
    id: id(line.t),
    t: line.t,
    text: line.words.map((w) => (w.disp || w.text) + (w.harm ? ` (${w.harm.text})` : '') + (w.gap ? ' ' : '')).join(''),
    translation: line.subs.filter((s) => !looksRomaji(s, line.text)).join(' / '),
  }));
}
/** Keep the existing editor's LRC conversion rules, and edit only subtitle rows for selected source times. */
export function mergeTranslations(source: string, values: Record<string, string>): string {
  const text = translationLrc(source),
    parsed = parseLyrics(text);
  const chosen = new Map(parsed.lines.filter((l) => values[id(l.t)] !== undefined).map((l) => [key(l.t), l]));
  const offset = (parseFloat(parsed.meta.offset) || 0) / 1000;
  const seen = new Set<number>();
  const output: string[] = [];
  for (const row of text.split(/\r?\n/)) {
    const lead = row.match(/^\s*((?:\[\d+:\d+(?:[.:]\d+)?\]\s*)+)(.*)$/);
    if (!lead) {
      output.push(row);
      continue;
    }
    const times = [...lead[1].matchAll(stamp)].map((m) => ({ raw: m[0], k: key(seconds(m[1], m[2], m[3]) - offset) }));
    const repeated = times.every((t) => seen.has(t.k));
    const selected = times.filter((t) => chosen.has(t.k));
    const body = lead[2].trim();
    const reading = selected.some((t) => looksRomaji(body, chosen.get(t.k)!.text));
    if (repeated && selected.length === times.length && body && !reading) continue;
    output.push(row);
    for (const time of times) {
      if (!seen.has(time.k) && chosen.has(time.k)) {
        const value = values[id(chosen.get(time.k)!.t)].replace(/[\r\n]+/g, ' ').trim();
        if (value) output.push(time.raw + value);
      }
      if (body) seen.add(time.k);
    }
  }
  return output.join(text.includes('\r\n') ? '\r\n' : '\n');
}
export function readTranslationPaste(text: string): TranslationFragment[] {
  const offset = +(text.match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0) / 1000;
  return text
    .split(/\r?\n/)
    .flatMap((row) => {
      if (/^\s*\[[a-z]+:/i.test(row)) return [];
      const times = [...row.matchAll(stamp)];
      const plain = row
        .replace(stamp, '')
        .replace(/<\d+:\d+(?:[.:]\d+)?>/g, '')
        .trim();
      if (!plain) return [];
      return (times.length ? times.map((m) => seconds(m[1], m[2], m[3]) - offset) : [null]).map((t) => ({
        index: 0,
        text: plain,
        t,
      }));
    })
    .map((f, index) => ({ ...f, index }));
}
const norm = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\s]+/gu, '');
/** Ambiguous repeated choruses remain unassigned unless timing or the listener resolves them. */
export function matchTranslations(
  lines: TranslationLine[],
  fragments: TranslationFragment[],
  shift = 0,
): TranslationMatch[] {
  const result: TranslationMatch[] = [],
    used = new Set<number>(),
    assigned = new Set<string>();
  const sourceRows = new Set(
    fragments
      .filter((f) => !f.source && lines.some((l) => norm(l.text) === norm(f.text)) && fragments.length !== lines.length)
      .map((f) => f.index),
  );
  const put = (l: TranslationLine, f: TranslationFragment, evidence: TranslationMatch['evidence']) => {
    if (!used.has(f.index) && !assigned.has(l.id) && !sourceRows.has(f.index)) {
      result.push({ id: l.id, fragments: [f.index], evidence });
      used.add(f.index);
      assigned.add(l.id);
    }
  };
  for (const f of fragments) {
    if (sourceRows.has(f.index)) continue;
    const byTime = f.t === null ? [] : lines.filter((l) => Math.abs(l.t - f.t! - shift) <= 0.025);
    const atTime = fragments.filter(
      (other) => !sourceRows.has(other.index) && other.t !== null && f.t !== null && Math.abs(other.t - f.t) <= 0.025,
    );
    if (byTime.length === 1 && atTime.length === 1 && (!f.source || norm(f.source) === norm(byTime[0].text)))
      put(byTime[0], f, 'time');
    const reference =
      f.source || (sourceRows.has(f.index - 1) ? fragments.find((r) => r.index === f.index - 1)?.text : '');
    const bySource = reference ? lines.filter((l) => norm(l.text) === norm(reference)) : [];
    if (bySource.length === 1) put(bySource[0], f, 'source');
  }
  const remaining = lines.filter((l) => !assigned.has(l.id));
  const available = fragments.filter((f) => !used.has(f.index) && !sourceRows.has(f.index) && f.t === null);
  // Positional proposals are explicit suggestions, never automatic saves.
  if (!result.length && remaining.length === available.length)
    remaining.forEach((l, i) => put(l, available[i], 'order'));
  return result;
}
