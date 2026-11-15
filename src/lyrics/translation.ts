import { parseLyrics } from './parse';
import { isTtml, ttmlToLrc } from './ttml';
import { looksRomaji, sameAsLine } from './subs';

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
  return parseLyrics(source).lines.map((line) => ({
    id: id(line.t),
    t: line.t,
    text: line.words.map((w) => (w.disp || w.text) + (w.harm ? ` (${w.harm.text})` : '') + (w.gap ? ' ' : '')).join(''),
    translation: editableSubtitle(line, isTtml(source)),
  }));
}
/** LRC carries no explicit track roles. Preserve ambiguous auxiliary rows rather than treating all of them as translations. */
function editableSubtitle(line: ReturnType<typeof parseLyrics>['lines'][number], native = false): string {
  if (native) return line.subs[0] || '';
  const reading = (sub: string) =>
    line.reads?.includes(sub) ||
    sameAsLine(sub, line.text) ||
    /[\u0250-\u02ff\u1d00-\u1d7f\p{Script=Bopomofo}]/u.test(sub) ||
    looksRomaji(sub, line.text) ||
    (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(line.text) && looksRomaji(sub, line.text + 'あ')) ||
    (/\p{Script=Han}/u.test(line.text) && /^[\p{Script=Hiragana}\p{Script=Katakana}\s\p{P}ー]+$/u.test(sub));
  const candidates = line.subs.filter((sub) => !reading(sub));
  const localized = candidates.find((sub) =>
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}]/u.test(
      sub,
    ),
  );
  if (localized) return localized;
  if (line.subs.some(reading)) return candidates[0] || '';
  return '';
}
/** Remove blank rows only in the matching draft, leaving metadata and meaningful cue-only rows untouched. */
export function cleanBlankLyricRows(source: string): string {
  return source
    .split(/\r?\n/)
    .filter(
      (row) => row.replace(/\[\d+:\d+(?:[.:]\d+)?\]|<\d+:\d+(?:[.:]\d+)?>/g, '').replace(/[\s\u200b]/g, '').length,
    )
    .join(source.includes('\r\n') ? '\r\n' : '\n');
}
/** Replace only the identified translation, preserving all other auxiliary rows and original word/cue timing. */
export function mergeTranslations(source: string, values: Record<string, string>): string {
  const text = translationLrc(source),
    parsed = parseLyrics(source);
  const chosen = new Map(
    parsed.lines
      .filter((line) => values[id(line.t)] !== undefined)
      .map((line) => [key(line.t), { line, subtitle: editableSubtitle(line, isTtml(source)) }]),
  );
  const offset = (parseFloat(parsed.meta.offset) || 0) / 1000;
  const seen = new Set<number>(),
    inserted = new Set<number>();
  const output: string[] = [];
  for (const row of text.split(/\r?\n/)) {
    const lead = row.match(/^\s*((?:\[\d+:\d+(?:[.:]\d+)?\]\s*)+)(.*)$/);
    if (!lead) {
      output.push(row);
      continue;
    }
    const times = [...lead[1].matchAll(stamp)].map((m) => ({ raw: m[0], k: key(seconds(m[1], m[2], m[3]) - offset) }));
    const body = lead[2].trim();
    const visible = body.replace(/<\d+:\d+(?:[.:]\d+)?>|#[1-3]?|\$1|@[1-9]/g, '').trim();
    const kept = times.filter(
      (time) => !seen.has(time.k) || !chosen.get(time.k)?.subtitle || visible !== chosen.get(time.k)!.subtitle,
    );
    if (kept.length) {
      const inline = body.indexOf('|');
      const changedInline = inline >= 0 && times.some((time) => !seen.has(time.k) && chosen.has(time.k));
      if (changedInline) {
        for (const time of kept) output.push(time.raw + (chosen.has(time.k) ? body.slice(0, inline).trimEnd() : body));
      } else output.push(kept.length === times.length ? row : kept.map((time) => time.raw).join('') + lead[2]);
    }
    for (const time of times) {
      const selected = chosen.get(time.k);
      if (visible && !seen.has(time.k) && selected && !inserted.has(time.k)) {
        const value = values[id(selected.line.t)].replace(/[\r\n]+/g, ' ').trim();
        if (value) output.push(time.raw + value);
        inserted.add(time.k);
      }
      if (visible) seen.add(time.k);
    }
  }
  return cleanBlankLyricRows(output.join(text.includes('\r\n') ? '\r\n' : '\n'));
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
