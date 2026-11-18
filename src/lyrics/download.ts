import { isTtml, ttmlToLrc } from './ttml';
import { cleanBlankLyricRows } from './translation';

interface TimedRow {
  time: number;
  stamp: string;
  body: string;
  track: number;
  order: number;
}
const stamps = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g;
const metadata = /^\s*\[(?:offset|ti|ar|al|by|re|ve|length):/i;

/** Group timed tracks by timestamp, then original / translation / reading; keep word stamps and native metadata. */
function interleave(base: string, translation: string, pronunciation: string): string {
  const rows: TimedRow[] = [],
    headers: string[] = [],
    untimed: string[] = [];
  const seen = new Set<string>();
  for (const [track, text] of [base, translation, pronunciation].entries()) {
    for (const row of text.split(/\r?\n/)) {
      if (!row.trim()) continue;
      const lead = row.match(/^\s*((?:\[\d+:\d+(?:[.:]\d+)?\]\s*)+)(.*)$/);
      if (!lead) {
        if (!seen.has(row.trim()) && (!track || !metadata.test(row))) {
          (metadata.test(row) ? headers : untimed).push(row);
          seen.add(row.trim());
        }
        continue;
      }
      if (track && !lead[2].trim()) continue;
      for (const stamp of lead[1].matchAll(stamps)) {
        const time = Math.round((+stamp[1] * 60 + +stamp[2] + +(stamp[3] ? '0.' + stamp[3] : 0)) * 1000);
        rows.push({ time, stamp: stamp[0], body: lead[2], track, order: rows.length });
      }
    }
  }
  // An original may already contain auxiliary tracks. Explicit tracks identify those rows without guessing their language.
  const roles = new Map(rows.filter((row) => row.track).map((row) => [row.time + '|' + row.body.trim(), row.track]));
  rows.sort(
    (a, b) =>
      a.time - b.time ||
      (roles.get(a.time + '|' + a.body.trim()) ?? a.track) - (roles.get(b.time + '|' + b.body.trim()) ?? b.track) ||
      a.order - b.order,
  );
  const timed = rows
    .filter((row) => {
      const key = row.time + '|' + row.body.trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((row) => row.stamp + row.body);
  return [...headers, ...untimed, ...timed].join('\n');
}

/** Keep native TTML only. A line-timed LRC must never pretend to be a native TTML document. */
export function downloadLyricFormats(original: string, translation = '', pronunciation = '') {
  const ttml = isTtml(original) ? original : '';
  const base = ttml ? ttmlToLrc(ttml) : original;
  return { lrc: cleanBlankLyricRows(interleave(base, translation, pronunciation)), ttml, converted: false };
}
export { translationLines, cleanBlankLyricRows } from './translation';
