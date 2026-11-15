const { inflateSync } = require('node:zlib');
const { createSchedule, DECRYPT, tripleDESKeySetup, tripleDESCrypt } = require('./vendor/lrc-get/des-helper.cjs');
// A public lyric-format constant, not an account secret or an audio content key.
const FORMAT_KEY = Buffer.from('!@#)(*$%123ZXC!@!@#)(NHL', 'ascii');
function decodeOnlineLyric(value) {
  if (typeof value !== 'string' || !value) return '';
  if (!/^[\da-fA-F]+$/.test(value)) return value;
  if (value.length % 16 || value.length > 512 * 1024) return '';
  try {
    const input = Buffer.from(value, 'hex'),
      output = Buffer.alloc(input.length),
      block = Buffer.alloc(8),
      schedule = createSchedule();
    tripleDESKeySetup(FORMAT_KEY, schedule, DECRYPT);
    for (let pos = 0; pos < input.length; pos += 8) {
      tripleDESCrypt(input.subarray(pos, pos + 8), block, schedule);
      block.copy(output, pos);
    }
    return inflateSync(output, { maxOutputLength: 4 * 1024 * 1024 }).toString('utf8');
  } catch {
    return '';
  }
}
function qrcLrc(text) {
  const source = String(text || '');
  const content = source.match(/LyricContent\s*=\s*"([^"]*)"/)?.[1] || source;
  const decoded = content
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_m, hex, dec) => String.fromCodePoint(parseInt(hex || dec, hex ? 16 : 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  const rows = [...decoded.matchAll(/\[(\d+),(\d+)\]([^\r\n]*)/g)];
  if (!rows.length) return decoded;
  const stamp = (ms) => {
    const t = Number(ms) / 1000;
    return String(Math.floor(t / 60)).padStart(2, '0') + ':' + (t % 60).toFixed(3).padStart(6, '0');
  };
  return rows
    .map((row) => {
      const words = [...row[3].matchAll(/(.*?)\((\d+),(\d+)\)/g)];
      const body = words.length
        ? words.map((word) => '<' + stamp(word[2]) + '>' + word[1]).join('') +
          '<' +
          stamp(Number(row[1]) + Number(row[2])) +
          '>'
        : row[3];
      return '[' + stamp(row[1]) + ']' + body;
    })
    .join('\n');
}
module.exports = { decodeOnlineLyric, qrcLrc };
