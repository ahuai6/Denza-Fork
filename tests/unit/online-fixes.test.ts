import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, copyFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { downloadLyricFormats } from '../../src/lyrics/download';
import { translationLines } from '../../src/lyrics/translation';
const require = createRequire(import.meta.url);
const { writeDownloadTags, verifyLyrics, nativeTtml } = require('../../electron/online/tags.cjs');
const { LyricsFlowAudio } = require('../../electron/online/lyricsflow-audio.cjs');
const { createPublicResolver } = require('../../electron/online/public-resolvers.cjs');
const { Downloads } = require('../../electron/downloads.cjs');
const track = { platform: 'apple', id: '123', title: 'Synthetic', artist: 'Fixture', album: 'Test', duration: 1 };
const original = '[00:00.10]First & next\n[00:00.50]Second';
const translation = '[00:00.10]第一句\n[00:00.50]第二句';
describe('download lyrics and container fields', () => {
  it('preserves native TTML exactly and retains translations in both conversions', () => {
    const generated = downloadLyricFormats(original, translation);
    expect(translationLines(generated.ttml).map((l) => l.translation)).toEqual(['第一句', '第二句']);
    const native = downloadLyricFormats(generated.ttml);
    expect(native.ttml).toBe(generated.ttml);
    expect(native.converted).toBe(false);
    expect(native.lrc).toContain('第一句');
  });
  for (const fixture of ['tone.mp3', 'tone.flac', 'tone-aac.m4a', 'tone-alac.m4a'])
    it(`writes and reads each independent field mode in ${fixture} without changing duration`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'denza-tag-'));
      try {
        const { parseFile } = await import('music-metadata');
        const source = resolve('tests/fixtures/online-audio', fixture);
        const before = await parseFile(source);
        for (const mode of ['both', 'lrc', 'ttml', 'none']) {
          const file = join(dir, mode + fixture);
          await copyFile(source, file);
          // Seed both tags, then verify switching to a single field removes the other.
          writeDownloadTags(file, fixture.split('.').at(-1), track, { original, translation }, 'both');
          const state = writeDownloadTags(file, fixture.split('.').at(-1), track, { original, translation }, mode);
          const checked = await parseFile(file);
          verifyLyrics(checked, state);
          expect(checked.format.duration).toBeCloseTo(before.format.duration!, 2);
          expect(checked.common.title).toBe('Synthetic');
          expect(!!checked.common.lyrics?.length).toBe(mode === 'both' || mode === 'lrc');
          expect(!!nativeTtml(checked.native)).toBe(mode === 'both' || mode === 'ttml');
          if (mode === 'both' || mode === 'ttml')
            expect(translationLines(nativeTtml(checked.native))[0].translation).toBe('第一句');
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
});
describe('provider compatibility fixes', () => {
  it('reads an AM album song link and fetches TTML without account credentials', async () => {
    const calls: URL[] = [];
    const ttml = downloadLyricFormats(original, translation).ttml;
    const client = new LyricsFlowAudio(undefined, async (input: string, options: RequestInit) => {
      expect(options.credentials).toBe('omit');
      expect(options.headers).toBeUndefined();
      const url = new URL(input);
      calls.push(url);
      return new Response(
        JSON.stringify(
          url.pathname === '/lyrics'
            ? { syncedLyrics: ttml }
            : {
                data: [
                  {
                    id: '123',
                    type: 'songs',
                    attributes: {
                      name: 'Synthetic',
                      artistName: 'Fixture',
                      durationInMillis: 1000,
                      artwork: { url: 'https://img.example/{w}x{h}.{f}' },
                    },
                  },
                ],
              },
        ),
      );
    });
    const songs = await client.lookup('https://music.apple.com/cn/album/example/456?i=123');
    expect(songs[0]).toMatchObject({
      catalogId: '123',
      storefront: 'cn',
      artworkUrl: 'https://img.example/500x500.jpg',
    });
    const lyrics = await client.lyrics(songs[0]);
    expect(lyrics.ttml).toBe(ttml);
    expect(lyrics.translation).toContain('第一句');
    expect(calls[0].pathname).toBe('/songs/123');
    await expect(client.lookup('https://evil.example/123')).rejects.toThrow('music.apple.com');
  });
  it('uses Sonora reference fallbacks without cookies and rejects a preview before trying the next source', async () => {
    const urls: string[] = [];
    const resolveAudio = createPublicResolver(async (url: string, options: RequestInit) => {
      urls.push(url);
      expect(options.credentials).toBe('omit');
      expect(options.headers).toBeUndefined();
      return new Response(
        JSON.stringify(
          url.includes('jerrynis')
            ? { data: [{ id: '17', url: 'https://audio.example/preview', freeTrialInfo: {} }] }
            : { data: { result: { url: 'https://audio.example/full' } } },
        ),
      );
    });
    expect(await resolveAudio({ platform: 'netease', id: '17' }, 'lossless')).toMatchObject({
      url: 'https://audio.example/full',
      source: 'Mxin',
    });
    expect(urls).toHaveLength(2);
    expect(new URL(urls[1]).searchParams.get('bitrate')).toBe('999');
  });
  it('accepts QQ nested string play URLs and sends Kugou private list IDs to the cloud endpoint', async () => {
    const qq = require('../../electron/online/providers/qq.cjs')({
      call: async () => ({ playUrl: { mid: 'https://audio.example/full' } }),
    });
    expect(await qq.resolve({ id: 'mid' }, 'high')).toMatchObject({ url: 'https://audio.example/full' });
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const kg = require('../../electron/online/providers/kugou.cjs')({
      getDevice: () => ({ dfid: 'test' }),
      setDevice: async () => {},
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return method === 'user_playlist'
          ? {
              data: {
                info: [
                  {
                    listid: 'private',
                    global_collection_id: 'public',
                    name: 'List',
                    pic: 'https://img.example/list.jpg',
                  },
                ],
                total: 1,
              },
            }
          : { data: { files: [{ hash: 'hash', name: 'Song' }], total: 1 } };
      },
    });
    const lists = await kg.page('lists', '', 1, undefined, 'user');
    expect(lists.rows[0]).toMatchObject({ id: 'private', artworkUrl: 'https://img.example/list.jpg' });
    const songs = await kg.page('songs', 'private', 1, undefined, 'user');
    expect(songs.rows).toHaveLength(1);
    expect(calls[1]).toMatchObject({ method: 'playlist_track_all_new', params: { listid: 'private', userid: 'user' } });
  });
  it('falls back one tier at a time, keeps the requested preference, and exposes tag and quality results', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'denza-tier-'));
    try {
      const data = await readFile(resolve('tests/fixtures/online-audio/tone.flac'));
      const qualities: string[] = [];
      const manager = new Downloads(
        { data: { jobs: [], folder: dir }, save: async () => {} },
        {
          resolve: async (_song: unknown, q: string) => {
            qualities.push(q);
            if (q === 'hires') throw Error('Unavailable');
            return { url: 'https://audio.example/full', expectedFormat: 'flac', source: 'Fixture' };
          },
          lyrics: async () => ({ original, translation }),
        },
        { importDownload: async () => {} },
        () => {},
        async () => new Response(data),
      );
      const job: any = {
        id: 'tier',
        track,
        quality: 'hires',
        lyricsMode: 'ttml',
        folder: dir,
        status: 'queued',
        received: 0,
        total: 0,
      };
      await manager.run(job, new AbortController());
      expect(qualities).toEqual(['hires', 'lossless']);
      expect(job).toMatchObject({
        status: 'completed',
        quality: 'hires',
        resolvedQuality: 'lossless',
        source: 'Fixture',
        lyrics: { fields: ['ttml'], status: 'embedded' },
      });
      expect(job.fallbackReason).toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('file-source recovery', () => {
  it('tries another service at the same tier when a native URL fails, before lowering quality', async () => {
    const { Platforms } = require('../../electron/platforms.cjs');
    const dir = await mkdtemp(join(tmpdir(), 'denza-source-'));
    try {
      const body = await readFile(resolve('tests/fixtures/online-audio/tone.flac'));
      const tiers: string[] = [];
      const platforms = new Platforms(
        { data: { device: {} }, credential: () => ({ cookie: '' }) },
        async () => ({ body: { playUrl: { mid: 'https://native.example/missing' } } }),
        null,
        {
          fallback: async (_track: unknown, q: string) => {
            tiers.push(q);
            return { url: 'https://alternate.example/full', source: 'Mxin' };
          },
        },
      );
      const manager = new Downloads(
        { data: { jobs: [], folder: dir }, save: async () => {} },
        platforms,
        { importDownload: async () => {} },
        () => {},
        async (url: string) => (url.includes('native') ? new Response(null, { status: 404 }) : new Response(body)),
      );
      const job: any = {
        id: 'source',
        track: { ...track, platform: 'qq', id: 'mid' },
        quality: 'lossless',
        lyricsMode: 'none',
        folder: dir,
        status: 'queued',
      };
      await manager.run(job, new AbortController());
      expect(job).toMatchObject({ status: 'completed', quality: 'lossless', source: 'Mxin' });
      expect(tiers).toEqual(['lossless']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
