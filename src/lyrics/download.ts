import { parseLyrics } from './parse';
import { isTtml, ttmlToLrc } from './ttml';
const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function downloadLyricFormats(original: string, translation = '') {
  const ttml = isTtml(original) ? original : '';
  const base = ttml ? ttmlToLrc(ttml) : original;
  const lrc = [base, ...translation.split(/\r?\n/).filter((row) => row.trim() && !base.split(/\r?\n/).includes(row))]
    .filter(Boolean)
    .join('\n');
  const parsed = parseLyrics(lrc);
  if (!parsed.lines.length) return { lrc: '', ttml: '', converted: false };
  const stamp = (time: number) => Math.max(0, time).toFixed(3) + 's';
  const generated = parsed.lines
    .map((line, i) => {
      const end = Math.max(line.t + 0.01, line.close ?? parsed.lines[i + 1]?.t ?? line.t + 5);
      const text = line.words
        .map((word) =>
          word.units?.length
            ? word.units.map((unit) => `<span begin="${stamp(unit.t)}">${escape(unit.c)}</span>`).join('')
            : escape(word.text),
        )
        .join(' ');
      return `<p begin="${stamp(line.t)}" end="${stamp(end)}">${text}${line.subs.map((text) => `<span ttm:role="x-translation">${escape(text)}</span>`).join('')}</p>`;
    })
    .join('');
  return {
    lrc,
    ttml:
      ttml ||
      `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div>${generated}</div></body></tt>`,
    converted: !ttml,
  };
}

export { translationLines } from './translation';
