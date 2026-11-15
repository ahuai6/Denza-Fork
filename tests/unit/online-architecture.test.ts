import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MUSIC_PLATFORMS, platformInfo } from '../../src/app/online/types';
const require = createRequire(import.meta.url);
const { Platforms, PLATFORMS } = require('../../electron/platforms.cjs');
const { catalog } = require('../../electron/online/providers/index.cjs');
const root = resolve(__dirname, '../..');
const store = () => ({
  data: { device: { dfid: 'fixture' }, accounts: {} },
  credential: () => ({ uid: 'user', cookie: 'token=fixture' }),
  save: async () => {},
  setAccount: async () => {},
  accounts: () => [],
});
const fixtures: Record<string, { raw: object; search: string; page: string; resolve: string; lyric: string }> = {
  netease: {
    raw: { id: 'n1', name: 'Song', ar: [{ name: 'Artist' }], dt: 180000 },
    search: 'cloudsearch',
    page: 'playlist_track_all',
    resolve: 'song_url_v1',
    lyric: 'lyric',
  },
  qq: {
    raw: { mid: 'q1', title: 'Song', singer: [{ name: 'Artist' }], interval: 180 },
    search: 'getSearchByKey',
    page: 'songListDetail',
    resolve: 'getMusicPlay',
    lyric: 'getLyric',
  },
  kugou: {
    raw: { Hash: 'k1', FileName: 'Artist - Song', Duration: 180 },
    search: 'search',
    page: 'playlist_track_all',
    resolve: 'song_url',
    lyric: 'search_lyric',
  },
};
describe('online module boundaries', () => {
  it('uses one capability catalog in the interface, registry and packaged app', () => {
    expect(MUSIC_PLATFORMS.map(([id]) => id)).toEqual(PLATFORMS);
    expect(catalog.map((info: { id: string }) => info.id)).toEqual(PLATFORMS);
    const providers = new Platforms(store());
    for (const id of PLATFORMS) expect(providers.info(id)).toEqual(platformInfo(id));
    expect(platformInfo('apple').download).toBe(true);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.build.files).toContain('shared/**');
    expect(() => providers.provider('unknown')).toThrow('Unknown');
  });
  it('keeps SDK imports in the worker loader and adapters away from the library, downloads and views', () => {
    const dir = join(root, 'electron/online/providers');
    for (const file of readdirSync(dir).filter((file) => file.endsWith('.cjs'))) {
      const code = readFileSync(join(dir, file), 'utf8');
      expect(code).not.toMatch(
        /(?:require|import)\(['"](?:.*(?:library|downloads|translation-service|main)\.cjs|@neteasecloudmusicapienhanced\/api|@sansenjian\/qq-music-api|kugoumusicapi)['"]\)/,
      );
      expect(code).not.toContain('src/app');
    }
    for (const file of ['electron/platforms.cjs', 'electron/online.cjs', 'electron/downloads.cjs']) {
      const code = readFileSync(join(root, file), 'utf8');
      expect(code).not.toMatch(
        /(?:require|import)\(['"](?:@neteasecloudmusicapienhanced\/api|@sansenjian\/qq-music-api|kugoumusicapi)['"]\)/,
      );
    }
    expect(readFileSync(join(root, 'src/app/online/state.ts'), 'utf8')).not.toContain('playback/');
    expect(readFileSync(join(root, 'src/app/ui/OnlineMusic.tsx'), 'utf8')).not.toMatch(
      /(?:song|remote|platform)\.?(?:platform)?\s*[!=]==\s*'apple'/,
    );
  });
  for (const [platform, fixture] of Object.entries(fixtures)) {
    it(`${platform} adapts search, playlist, audio and lyrics without changing the application contract`, async () => {
      const calls: { method: string; query: Record<string, unknown> }[] = [];
      const invoke = async (_platform: string, method: string, query: Record<string, unknown>) => {
        calls.push({ method, query });
        if (method === fixture.search)
          return {
            body:
              platform === 'netease'
                ? { result: { songs: [fixture.raw] } }
                : platform === 'qq'
                  ? { response: { song: { list: [fixture.raw] } } }
                  : { data: { lists: [fixture.raw] } },
          };
        if (method === fixture.page)
          return {
            body:
              platform === 'netease'
                ? { songs: [fixture.raw], total: 1 }
                : platform === 'qq'
                  ? { songlist: [fixture.raw], total: 1 }
                  : { data: { songs: [fixture.raw], total: 1 } },
          };
        if (method === fixture.resolve)
          return {
            body:
              platform === 'netease'
                ? { data: [{ url: 'https://audio.example/full' }] }
                : { url: 'https://audio.example/full' },
          };
        if (method === fixture.lyric)
          return {
            body:
              platform === 'netease'
                ? { lrc: { lyric: '[00:01]Original' } }
                : platform === 'qq'
                  ? { lyric: Buffer.from('[00:01]Original').toString('base64') }
                  : { candidates: [{ id: 'lyrics', accesskey: 'fixture' }] },
          };
        if (method === 'lyric') return { body: { decodeContent: '[00:01]Original' } };
        throw Error('Unexpected fixture operation: ' + method);
      };
      const providers = new Platforms(store(), invoke);
      const songs = await providers.search(platform, 'Song', 2);
      expect(songs[0]).toMatchObject({ platform, title: 'Song', artist: 'Artist', duration: 180 });
      const page = await providers.page(platform, 'songs', 'list', 1);
      expect(page.rows[0]).toEqual(songs[0]);
      expect(page.total).toBe(1);
      expect(await providers.resolve(songs[0], 'lossless')).toEqual({ url: 'https://audio.example/full' });
      expect(await providers.lyrics(songs[0])).toMatchObject({ original: '[00:01]Original' });
      expect(calls.map((call) => call.method)).toContain(fixture.resolve);
      const payload = calls.find((call) => call.method === fixture.resolve)!.query;
      expect(
        platform === 'qq'
          ? (payload.params as { quality: string }).quality
          : platform === 'netease'
            ? payload.level
            : payload.quality,
      ).toBe(platform === 'netease' ? 'lossless' : 'flac');
    });
  }
  it('accepts string, array and backup URLs without truncating them', () => {
    const { downloadResult } = require('../../electron/online/providers/helpers.cjs');
    for (const row of [
      { url: 'https://audio.example/full' },
      { url: ['https://audio.example/full'] },
      { url: [], backup_url: ['https://audio.example/full'] },
      { backup_url: 'https://audio.example/full' },
    ])
      expect(downloadResult(row)).toEqual({ url: 'https://audio.example/full' });
  });
  it('rejects preview audio in each SDK adapter before passing a URL to the queue', async () => {
    for (const platform of Object.keys(fixtures)) {
      const providers = new Platforms(store(), async () => ({
        body:
          platform === 'netease'
            ? { data: [{ url: 'https://audio.example/preview', trial: true }] }
            : { url: 'https://audio.example/preview', trial: true },
      }));
      await expect(providers.resolve({ platform, id: 'fixture' }, 'high')).rejects.toThrow('preview');
    }
  });
});
