import { isTtml, ttmlToLrc } from './ttml';

/** Keep native TTML only. A line-timed LRC must never pretend to be a native TTML document. */
export function downloadLyricFormats(original: string, translation = '', pronunciation = '') {
  const ttml = isTtml(original) ? original : '';
  const base = ttml ? ttmlToLrc(ttml) : original;
  const existing = new Set(base.split(/\r?\n/).map((row) => row.trim()));
  const extra = [translation, pronunciation].flatMap((track) =>
    track.split(/\r?\n/).filter((row) => {
      const value = row.trim();
      if (!value || existing.has(value) || /^\s*\[(?:offset|ti|ar|al|by|re|ve|length):/i.test(row)) return false;
      existing.add(value);
      return true;
    }),
  );
  return { lrc: [base, ...extra].filter(Boolean).join('\n'), ttml, converted: false };
}
export { translationLines } from './translation';
