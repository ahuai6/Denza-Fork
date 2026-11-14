import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  translationLines,
  mergeTranslations,
  readTranslationPaste,
  matchTranslations,
} from '../../src/lyrics/translation';
const require = createRequire(import.meta.url);
const { collectPages } = require('../../electron/online.cjs');
const { OnlineStore } = require('../../electron/online-store.cjs');
const { Translator, endpoint } = require('../../electron/translation-service.cjs');
const { song, Platforms } = require('../../electron/platforms.cjs');
const { commit, audioExtension } = require('../../electron/downloads.cjs');

const lyrics =
  '[ti:Example]\n[offset:100]\n[00:01.00]<00:01.00>New <00:01.50>day#2\n[00:01.00]Old translation\n[00:03.00]Next day\n[00:04.00]\n';
describe('translation drafts', () => {
  it('retains original word timestamps, cues, metadata, offsets and end markers while changing a selected translation', () => {
    const lines = translationLines(lyrics);
    const merged = mergeTranslations(lyrics, { [lines[0].id]: 'New translation' });
    expect(merged).toContain('[00:01.00]<00:01.00>New <00:01.50>day#2');
    expect(merged).toContain('[00:01.00]New translation');
    expect(merged).not.toContain('Old translation');
    expect(merged).toContain('[offset:100]');
    expect(merged).toContain('[00:03.00]Next day\n[00:04.00]');
    expect(translationLines(merged)[0].t).toBeCloseTo(0.9);
    expect(translationLines(merged)[0].translation).toBe('New translation');
  });
  it('leaves untouched LRC exactly unchanged when no values were edited', () =>
    expect(mergeTranslations(lyrics, {})).toBe(lyrics));
  it('retains readings and applies different translations to repeated timestamp groups', () => {
    const source = '[00:01][00:04]あの日\n[00:01]ano hi\n[00:04]ano hi';
    const lines = translationLines(source);
    const result = mergeTranslations(source, { [lines[0].id]: 'That day', [lines[1].id]: 'This day' });
    expect(result).toContain('[00:01][00:04]あの日');
    expect(result).toContain('[00:01]ano hi');
    expect(result).toContain('[00:04]ano hi');
    expect(translationLines(result).map((l) => l.translation)).toEqual(['That day', 'This day']);
  });
  it('does not assign repeated choruses by source text without a time or manual decision', () => {
    const lines = translationLines('[00:01]Repeat\n[00:04]Repeat');
    const fragments = [{ index: 0, text: '译文', t: null, source: 'Repeat' }];
    expect(matchTranslations(lines, fragments)).toEqual([]);
    expect(matchTranslations(lines, [{ ...fragments[0], t: 4 }])[0].id).toBe(lines[1].id);
  });
  it('recognizes bilingual source anchors and explicitly marks positional proposals', () => {
    const lines = translationLines('[00:01]First\n[00:04]Second');
    const result = matchTranslations(lines, readTranslationPaste('First\n第一句\nSecond\n第二句'));
    expect(result.map((m) => m.evidence)).toEqual(['source', 'source']);
    expect(matchTranslations(lines, readTranslationPaste('甲\n乙')).map((m) => m.evidence)).toEqual(['order', 'order']);
  });
});
describe('online integration contracts', () => {
  it('rejects incomplete and stuck pagination, without producing a snapshot to commit', async () => {
    await expect(collectPages(async () => ({ rows: [{ id: '1' }], more: true, total: 3 }))).rejects.toThrow('advance');
    await expect(collectPages(async () => ({ rows: [{ id: '1' }], more: false, total: 3 }))).rejects.toThrow(
      'incomplete',
    );
    const all = await collectPages(async (page: number) => ({
      rows: [{ id: String(page) }],
      more: page < 3,
      total: 3,
    }));
    expect(all.map((r: { id: string }) => r.id)).toEqual(['1', '2', '3']);
    expect(
      await collectPages(async () => ({ rows: [{ id: 'repeat' }, { id: 'repeat' }], more: false, total: 2 })),
    ).toHaveLength(2);
  });
  it('normalizes platform identities independently from local library IDs', () => {
    expect(song({ id: 17, name: 'Song', ar: [{ name: 'Artist' }], dt: 180000 }, 'netease')).toMatchObject({
      id: '17',
      platform: 'netease',
      duration: 180,
      artist: 'Artist',
    });
    expect(song({ Hash: 'abc', FileName: 'Artist - Song', Duration: 180 }, 'kugou')).toMatchObject({
      title: 'Song',
      artist: 'Artist',
      id: 'abc',
    });
  });
  it('does not expose account cookies or API keys in public settings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'denza-store-'));
    try {
      const crypto = {
        isEncryptionAvailable: () => true,
        encryptString: (s: string) => Buffer.from(s).reverse(),
        decryptString: (b: Buffer) => Buffer.from(b).reverse().toString(),
      };
      const store = new OnlineStore(join(dir, 'online.json'), crypto);
      await store.load();
      await store.setAccount('netease', { uid: '12', name: 'Example', cookie: 'secret-cookie' });
      expect(JSON.stringify(store.accounts())).not.toContain('secret-cookie');
      expect(await readFile(join(dir, 'online.json'), 'utf8')).not.toContain('secret-cookie');
      expect(store.credential('netease').cookie).toBe('secret-cookie');
      const tr = new Translator(store, {});
      await tr.configure({
        kind: 'compatible',
        baseURL: 'http://127.0.0.1:3000/v1',
        protocol: 'chat',
        model: 'example',
        key: 'secret-key',
      });
      expect(JSON.stringify(tr.settings())).not.toContain('secret-key');
      expect(tr.settings().hasKey).toBe(true);
      const broken = join(dir, 'broken.json');
      await writeFile(broken, '{broken');
      await expect(new OnlineStore(broken, crypto).load()).rejects.toThrow('preserved');
      expect(await readFile(broken, 'utf8')).toBe('{broken');
      expect(() => new OnlineStore('unused', { isEncryptionAvailable: () => false }).seal('secret')).toThrow(
        'encryption',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('validates account identity before saving and rejects missing playlist rows', async () => {
    let saved = false;
    const store = {
      credential: () => ({ uid: '12', cookie: '' }),
      data: { device: {} },
      setAccount: async () => {
        saved = true;
      },
      accounts: () => [],
    };
    const platform = new Platforms(store, async () => ({ body: { code: 200, data: {} } }));
    await expect(platform.account('netease', 'MUSIC_U=test')).rejects.toThrow('verify');
    expect(saved).toBe(false);
    await expect(platform.page('netease', 'songs', 'list', 1)).rejects.toThrow('Incomplete');
  });
  it('sends the full context but only accepts requested IDs and never accepts duplicate model rows', async () => {
    const config = { kind: 'compatible', baseURL: 'http://localhost:1234/v1', protocol: 'chat', model: 'example' };
    const store = { data: { provider: config }, open: () => '' };
    let sent: { messages: { content: string }[] } | undefined;
    const tr = new Translator(store, {}, async (_url: string, opts: { body: string }) => {
      sent = JSON.parse(opts.body);
      return Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify({ lines: [{ id: 'b', translation: 'Result' }] }) },
          },
        ],
      });
    });
    const input = {
      song: { title: 'Example', artist: 'Artist' },
      language: 'zh-Hans',
      lines: [
        { id: 'a', text: '<00:01.00>Locked original' },
        { id: 'b', text: 'Next' },
      ],
      wanted: ['b'],
      locked: { a: 'Locked translation' },
    };
    expect(await tr.translate(input, new AbortController().signal)).toEqual([{ id: 'b', translation: 'Result' }]);
    expect(sent!.messages[1].content).toContain('Locked original');
    expect(sent!.messages[1].content).not.toContain('00:01');
    const bad = new Translator(store, {}, async () =>
      Response.json({
        choices: [{ message: { content: '{"lines":[{"id":"a","translation":"x"},{"id":"a","translation":"y"}]}' } }],
      }),
    );
    await expect(bad.translate({ ...input, wanted: ['a', 'b'] }, new AbortController().signal)).rejects.toThrow(
      'duplicated',
    );
    expect(() => endpoint('https://example.com/v1?key=secret')).toThrow();
    expect(() => endpoint('http://remote.example/v1')).toThrow();
  });
  it('rejects non-audio responses and commits files without overwriting existing names', async () => {
    expect(() => audioExtension(Buffer.from('<html>Error</html>'))).toThrow('audio');
    const dir = await mkdtemp(join(tmpdir(), 'denza-files-'));
    try {
      await writeFile(join(dir, 'song.flac'), 'original');
      await writeFile(join(dir, '.part'), 'download');
      const result = await commit(join(dir, '.part'), dir, 'song', 'flac');
      expect(result).toBe(join(dir, 'song (1).flac'));
      expect(await readFile(join(dir, 'song.flac'), 'utf8')).toBe('original');
      expect(await readFile(result, 'utf8')).toBe('download');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('synced playlists in the existing library', () => {
  it('shares local IDs, preserves remote order and unmatched songs, and protects synced lists from manual edits', async () => {
    const vm = await import('node:vm');
    const fs = await import('node:fs');
    const dir = await mkdtemp(join(tmpdir(), 'denza-library-'));
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    try {
      fs.mkdirSync(join(dir, 'library'), { recursive: true });
      fs.writeFileSync(
        join(dir, 'library', 'db.json'),
        JSON.stringify({
          version: 1,
          folders: [],
          tracks: {
            a: { id: 'a', path: join(dir, 'a.mp3'), title: 'First', artist: 'Artist', duration: 180 },
            b: {
              id: 'b',
              path: join(dir, 'b.mp3'),
              title: 'Custom title',
              artist: 'Custom artist',
              duration: 190,
              onlineKey: 'qq:remote-b',
            },
            c: {
              id: 'c',
              path: join(dir, 'c.mp3'),
              title: 'Another copy',
              artist: 'Custom artist',
              duration: 190,
              onlineKey: 'qq:remote-b',
            },
          },
          favorites: ['a'],
          playlists: [{ id: 'local', name: 'My list', tracks: ['a'] }],
          overrides: {},
        }),
      );
      const exports = {
        exports: {} as {
          start(ipc: object, getWin: () => null, settings: object): Promise<void>;
          syncPlaylists(
            platform: string,
            uid: string,
            lists: object[],
          ): { playlists: { id: string; tracks: string[]; remote?: { songs: { localId: string | null }[] } }[] };
        },
      };
      vm.runInNewContext(fs.readFileSync(join(__dirname, '../../electron/library.cjs'), 'utf8'), {
        require: (name: string) =>
          name === 'electron'
            ? { app: { getPath: () => dir }, protocol: { handle: () => {} } }
            : name === './online/library-links.cjs'
              ? require('../../electron/online/library-links.cjs')
              : require(name),
        module: exports,
        process: { env: { CADENZA_USER_DATA: dir } },
        Buffer,
        Response,
        URL,
        TextDecoder,
        console,
        clearTimeout,
        setTimeout: (fn: () => void, ms: number) => {
          const id = setTimeout(fn, ms);
          timers.add(id);
          return id;
        },
      });
      await exports.exports.start(
        { handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) },
        () => null,
        { scanOnLaunch: false },
      );
      const lists = [
        {
          id: 'remote-list',
          name: 'Remote',
          songs: [
            { id: 'remote-b', platform: 'qq', title: 'Second', artist: 'Artist', duration: 190 },
            { id: 'remote-missing', platform: 'qq', title: 'Missing', artist: 'Artist', duration: 210 },
            { id: 'remote-a', platform: 'qq', title: 'First', artist: 'Artist', duration: 180 },
          ],
        },
      ];
      const view = exports.exports.syncPlaylists('qq', '12', lists);
      expect(view.playlists.find((p) => p.remote)?.tracks).toEqual(['b', 'a']);
      expect(view.playlists.find((p) => p.remote)?.remote?.songs.map((s) => s.localId)).toEqual(['b', null, 'a']);
      expect(view.playlists.find((p) => p.id === 'local')?.tracks).toEqual(['a']);
      const again = exports.exports.syncPlaylists('qq', '12', lists);
      expect(again.playlists).toHaveLength(2);
      const remoteId = view.playlists.find((p) => p.remote)!.id;
      expect(handlers.get('lib:playlist')!(null, 'add', remoteId, ['a'])).toBe(false);
      expect(handlers.get('lib:playlist')!(null, 'rename', remoteId, 'Changed')).toBe(false);
    } finally {
      for (const timer of timers) clearTimeout(timer);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('download transactions', () => {
  const { Downloads } = require('../../electron/downloads.cjs');
  function wave() {
    const data = Buffer.alloc(16044);
    data.write('RIFF', 0);
    data.writeUInt32LE(data.length - 8, 4);
    data.write('WAVEfmt ', 8);
    data.writeUInt32LE(16, 16);
    data.writeUInt16LE(1, 20);
    data.writeUInt16LE(1, 22);
    data.writeUInt32LE(8000, 24);
    data.writeUInt32LE(16000, 28);
    data.writeUInt16LE(2, 32);
    data.writeUInt16LE(16, 34);
    data.write('data', 36);
    data.writeUInt32LE(16000, 40);
    return data;
  }
  it('validates, tags and imports a synthetic song, then recovers a committed file without another network request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'denza-download-'));
    try {
      const store = { data: { jobs: [], folder: dir }, save: async () => {} };
      const calls: string[] = [];
      const services = {
        resolve: async () => ({ url: 'https://fixture.invalid/audio' }),
        lyrics: async () => ({ original: '[00:00]Original fixture', translation: '[00:00]测试译文' }),
      };
      const manager = new Downloads(
        store,
        services,
        {
          importDownload: async (file: string) => {
            calls.push(file);
          },
        },
        () => {},
        async () => new Response(wave()),
      );
      const job = {
        id: 'fixture-id',
        track: {
          platform: 'netease',
          id: 'fixture',
          title: 'Fixture',
          artist: 'Test artist',
          album: 'Test album',
          duration: 1,
        },
        quality: 'high',
        folder: dir,
        status: 'queued',
        received: 0,
        total: 0,
        file: '',
      };
      await manager.run(job, new AbortController());
      expect(job.status).toBe('completed');
      expect(calls).toEqual([job.file]);
      const { parseFile } = await import('music-metadata');
      const saved = await parseFile(job.file);
      expect(saved.common.title).toBe('Fixture');
      expect(saved.format.sampleRate).toBe(8000);
      expect(saved.common.lyrics?.[0].text).toContain('测试译文');
      manager.fetcher = () => {
        throw Error('must not download again');
      };
      job.status = 'paused';
      await manager.run(job, new AbortController());
      expect(job.status).toBe('completed');
      expect(calls).toEqual([job.file, job.file]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('keeps cancellation out of the music library and removes its partial file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'denza-cancel-'));
    try {
      const store = { data: { jobs: [], folder: dir }, save: async () => {} };
      const control = new AbortController();
      let imported = false;
      const manager = new Downloads(
        store,
        {
          resolve: async () => {
            job.status = 'paused';
            control.abort();
            throw Error('Cancelled');
          },
        },
        {
          importDownload: async () => {
            imported = true;
          },
        },
        () => {},
      );
      const job = {
        id: 'cancel-id',
        track: { platform: 'qq', id: 'fixture' },
        quality: 'high',
        folder: dir,
        status: 'queued',
      };
      await manager.run(job, control);
      expect(job.status).toBe('paused');
      expect(imported).toBe(false);
      const { readdir } = await import('node:fs/promises');
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
