import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { mergeTranslations, translationLines, cleanBlankLyricRows } from '../../src/lyrics/translation';
import { downloadLyricFormats } from '../../src/lyrics/download';
const require = createRequire(import.meta.url);
const { timedLrc, kugouTracks } = require('../../electron/online/lyric-formats.cjs');
const original = '[00:01]Synthetic original\n[00:02]Second original';
const translated = '[00:01]测试译文\n[00:02]第二行译文';
const pronunciation = '[00:01]sin the tik\n[00:02]se kond';
describe('complete native lyric tracks', () => {
  it('combines original, translation and pronunciation without manufacturing TTML or duplicate rows', () => {
    const result = downloadLyricFormats(original + '\n[00:01]测试译文', translated, pronunciation);
    expect(result.ttml).toBe('');
    expect(result.converted).toBe(false);
    expect(result.lrc.match(/\[00:01\]测试译文/g)).toHaveLength(1);
    expect(result.lrc).toContain('[00:01]sin the tik');
    expect(result.lrc).toContain('[00:02]第二行译文');
  });
  it('preserves native TTML including explicit pronunciation roles', async () => {
    const xml = await readFile(new URL('../fixtures/ttml/line.ttml', import.meta.url), 'utf8');
    const result = downloadLyricFormats(xml);
    expect(result.ttml).toBe(xml);
    expect(result.lrc).toContain('yoru no machi o hashiru');
    const line = translationLines(xml)[1];
    const merged = mergeTranslations(xml, { [line.id]: '新译文' });
    expect(merged).toContain('yoru no machi o hashiru');
    expect(merged).toContain('新译文');
    expect(merged).not.toContain('在夜晚的街上奔跑');
  });
  it('maps native YRC word times and KRC language tracks without synthetic timing', () => {
    const yrc = timedLrc('[1000,1000](1000,400,0)First (1400,600,0)line', 'yrc');
    expect(yrc.original).toBe('[00:01.000]<00:01.000>First <00:01.400>line<00:02.000>');
    const language = Buffer.from(
      JSON.stringify({
        content: [
          { type: 0, lyricContent: [['first', 'lain']] },
          { type: 1, lyricContent: [['测试译文']] },
        ],
      }),
    ).toString('base64');
    expect(kugouTracks('[language:' + language + ']\n[1000,1000]<0,400,0>First <400,600,0>line')).toEqual({
      original: yrc.original,
      translation: '[00:01.000]测试译文',
      pronunciation: '[00:01.000]first lain',
    });
    expect(kugouTracks('[language:invalid]\n[1000,1000]<0,1000,0>Test').original).toContain('Test');
  });
  it('keeps all tracks through the platform contract for Netease and QQ', async () => {
    const { Platforms } = require('../../electron/platforms.cjs');
    const store = { data: { device: {} }, credential: () => ({ cookie: '' }) };
    const platform = new Platforms(store, async (id: string) => ({
      body:
        id === 'netease'
          ? { lrc: { lyric: original }, tlyric: { lyric: translated }, romalrc: { lyric: pronunciation } }
          : {
              lyric: original,
              trans: Buffer.from(translated).toString('base64'),
              roma: Buffer.from(pronunciation).toString('base64'),
            },
    }));
    for (const id of ['netease', 'qq']) {
      const result = await platform.lyrics({ platform: id, id: 'fixture' });
      expect(result.pronunciation).toBe(pronunciation);
      expect(result.lrc).toContain(translated);
      expect(result.lrc).toContain(pronunciation);
      expect(result.ttml).toBe('');
    }
  });
});
describe('matching draft preserves auxiliary tracks', () => {
  for (const [text, reading] of [
    ['愛', 'ai'],
    ['心の音', 'こころのおと'],
    ['你好', 'ni hao'],
    ['사랑', 'saranghae'],
    ['hello', 'həˈləʊ'],
    ['你好', 'ㄋㄧˇ ㄏㄠˇ'],
  ])
    it(`retains pronunciation ${reading} while replacing a Chinese translation`, () => {
      const source = `[00:01]${text}\n[00:01]${reading}\n[00:01]旧译文\n[01:07.00]\n   \n`;
      const merged = mergeTranslations(source, { [translationLines(source)[0].id]: '新译文' });
      expect(merged).toContain(`[00:01]${reading}`);
      expect(merged).toContain('[00:01]新译文');
      expect(merged).not.toContain('旧译文');
      expect(merged).not.toContain('[01:07.00]');
    });
  it('retains ambiguous Latin auxiliaries instead of deleting untyped readings', () => {
    const source = '[00:01]사랑\n[00:01]saranghae';
    expect(translationLines(source)[0].translation).toBe('');
    expect(mergeTranslations(source, { 'line.100': '新译文' })).toContain('[00:01]saranghae');
  });
  it('splits only edited timestamps of a shared subtitle and keeps original word times/cues', () => {
    const source = '[offset:100]\n[00:01][00:04]<00:01>#2あの日<00:02>\n[00:01][00:04]ano hi\n[00:01][00:04]旧译文';
    const merged = mergeTranslations(source, { [translationLines(source)[0].id]: '第一处新译文' });
    expect(merged).toContain('[00:01][00:04]<00:01>#2あの日<00:02>');
    expect(merged).toContain('[00:01][00:04]ano hi');
    expect(merged).toContain('[00:04]旧译文');
    expect(merged).not.toContain('[00:01]旧译文');
  });
  it('updates inline translations without removing other readings', () => {
    const source = '[00:01]愛 | 旧译文\n[00:01]ai';
    const merged = mergeTranslations(source, { 'line.100': '新译文' });
    expect(merged).toContain('[00:01]愛');
    expect(merged).toContain('[00:01]ai');
    expect(merged).not.toContain('旧译文');
  });
  it('cleans timestamp-only and whitespace rows while preserving metadata and cue rows', () => {
    expect(
      cleanBlankLyricRows(
        '[ti:Fixture]\r\n \r\n[01:07.00]  \r\n[01:08]<01:09>\r\n[01:10]#2\r\n[01:11]@1\r\n[01:12]字\r\n',
      ),
    ).toBe('[ti:Fixture]\r\n[01:10]#2\r\n[01:11]@1\r\n[01:12]字');
  });
});

describe('online QQ lyric encoding', () => {
  it('decodes the published lyric-text format and preserves word timings', () => {
    const { deflateSync } = require('node:zlib');
    const {
      createSchedule,
      ENCRYPT,
      tripleDESKeySetup,
      tripleDESCrypt,
    } = require('../../electron/online/vendor/lrc-get/des-helper.cjs');
    const { decodeOnlineLyric, qrcLrc } = require('../../electron/online/qq-lyric-codec.cjs');
    const xml =
      '<QrcInfos><LyricInfo LyricContent="[1000,1000]First(1000,400)line(1400,600)&#10;[2000,500]Test(2000,500)"/></QrcInfos>';
    const zipped = deflateSync(xml),
      input = Buffer.alloc(Math.ceil(zipped.length / 8) * 8);
    zipped.copy(input);
    const encoded = Buffer.alloc(input.length),
      schedule = createSchedule(),
      block = Buffer.alloc(8);
    tripleDESKeySetup(Buffer.from('!@#)(*$%123ZXC!@!@#)(NHL', 'ascii'), schedule, ENCRYPT);
    for (let i = 0; i < input.length; i += 8) {
      tripleDESCrypt(input.subarray(i, i + 8), block, schedule);
      block.copy(encoded, i);
    }
    expect(decodeOnlineLyric(encoded.toString('hex'))).toBe(xml);
    expect(qrcLrc(xml)).toContain('[00:01.000]<00:01.000>First<00:01.400>line<00:02.000>');
    expect(decodeOnlineLyric('00')).toBe('');
    expect(decodeOnlineLyric('00'.repeat(300000))).toBe('');
  });
});
