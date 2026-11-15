const stamp = (ms) => {
  const seconds = Math.max(0, Number(ms)) / 1000;
  return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + (seconds % 60).toFixed(3).padStart(6, '0');
};
// SDKs decode the transport. This module only maps documented lyric text/timing into Cadenza's LRC syntax.
function timedLrc(text, format) {
  const rows = String(text || '')
    .split(/\r?\n/)
    .flatMap((row) => {
      const line = row.match(/^\[(\d+),(\d+)\](.*)$/);
      if (!line) return [];
      const start = Number(line[1]),
        end = start + Number(line[2]);
      const regex = format === 'krc' ? /<(\d+),(\d+),\d+>([^<]*)/g : /\((\d+),(\d+),\d+\)([^()]*)/g;
      const words = [...line[3].matchAll(regex)];
      const body = words.length
        ? words.map((word) => '<' + stamp(Number(word[1]) + (format === 'krc' ? start : 0)) + '>' + word[3]).join('') +
          '<' +
          stamp(end) +
          '>'
        : line[3];
      return [{ start, text: '[' + stamp(start) + ']' + body }];
    });
  return { original: rows.map((row) => row.text).join('\n'), starts: rows.map((row) => row.start) };
}
function kugouTracks(text) {
  const { original, starts } = timedLrc(text, 'krc');
  let translation = '',
    pronunciation = '';
  try {
    const encoded = String(text).match(/\[language:([^\]]+)\]/)?.[1];
    const language = JSON.parse(Buffer.from(encoded || '', 'base64').toString('utf8'));
    for (const track of language.content || []) {
      if (!Array.isArray(track.lyricContent) || track.lyricContent.length !== starts.length) continue;
      const lrc = track.lyricContent
        .map((row, index) => '[' + stamp(starts[index]) + ']' + (Array.isArray(row) ? row.join(' ') : String(row)))
        .join('\n');
      if (track.type === 1) translation = [translation, lrc].filter(Boolean).join('\n');
      if (track.type === 0) pronunciation = [pronunciation, lrc].filter(Boolean).join('\n');
    }
  } catch {
    /* A malformed optional language track must not discard the original lyric. */
  }
  return { original, translation, pronunciation };
}
function decodeText(value) {
  if (typeof value !== 'string') return '';
  if (!value || /\[\d+:|<tt[\s>]|\n/.test(value)) return value;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(value) || value.length % 4 !== 0) return value;
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  return /[\u0000-\u0008\u000e-\u001f\ufffd]/.test(decoded) ? '' : decoded;
}
module.exports = { timedLrc, kugouTracks, decodeText };
