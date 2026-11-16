import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');

function makeWave(seed) {
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
  // Make each track's audio payload distinct so fileId/audioKey are unique.
  for (let i = 44; i < data.length; i += 4) data.writeInt16LE((seed * 131 + i) % 30000, i);
  return data;
}

async function benchSdkWorkers() {
  const transport = require(path.join(ROOT, 'electron/online/sdk-transport.cjs'));
  const results = {};
  for (const platform of ['netease', 'qq', 'kugou']) {
    const t0 = performance.now();
    await transport.sdk(platform, '__bench_noop__', {}).catch(() => {});
    const coldMs = performance.now() - t0;

    const warmTimes = [];
    for (let i = 0; i < 5; i++) {
      const s = performance.now();
      await transport.sdk(platform, '__bench_noop__', {}).catch(() => {});
      warmTimes.push(performance.now() - s);
    }
    const avgWarmMs = warmTimes.reduce((a, b) => a + b, 0) / warmTimes.length;
    results[platform] = { coldMs: +coldMs.toFixed(2), subsequentAvgMs: +avgWarmMs.toFixed(2) };
  }
  const tConc = performance.now();
  await Promise.all([
    transport.sdk('netease', '__bench_noop__', {}).catch(() => {}),
    transport.sdk('qq', '__bench_noop__', {}).catch(() => {}),
    transport.sdk('kugou', '__bench_noop__', {}).catch(() => {}),
  ]);
  results.concurrent3Ms = +(performance.now() - tConc).toFixed(2);
  if (typeof transport.closeSdkWorkers === 'function') await transport.closeSdkWorkers();
  return results;
}

async function benchOnlineStore() {
  const { OnlineStore } = require(path.join(ROOT, 'electron/online-store.cjs'));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'denza-bench-store-'));
  let decryptCalls = 0;
  try {
    const crypto = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s, 'utf8'),
      decryptString: (b) => {
        decryptCalls++;
        return b.toString('utf8');
      },
    };
    const store = new OnlineStore(path.join(dir, 'online.json'), crypto);
    await store.load();
    await store.setAccount('netease', { uid: '100', name: 'Bench', cookie: 'MUSIC_U=' + 'x'.repeat(256) });
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) store.credential('netease');
    const ms = +(performance.now() - t0).toFixed(3);
    return { calls: 1000, decryptStringCalls: decryptCalls, ms };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function benchLibraryAndPlaylists() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'denza-bench-lib-'));
  const musicDir = path.join(dir, 'music');
  const dlDir = path.join(dir, 'downloads');
  await fsp.mkdir(path.join(dir, 'library'), { recursive: true });
  await fsp.mkdir(musicDir, { recursive: true });
  await fsp.mkdir(dlDir, { recursive: true });

  const trackCount = 200;
  for (let i = 0; i < trackCount; i++) {
    await fsp.writeFile(path.join(musicDir, `track-${i}.wav`), makeWave(i + 1));
  }
  const downloadFile = path.join(dlDir, 'downloaded-new.wav');
  await fsp.writeFile(downloadFile, makeWave(99999));

  await fsp.writeFile(
    path.join(dir, 'library', 'db.json'),
    JSON.stringify({ version: 1, folders: [musicDir], tracks: {}, favorites: [], playlists: [], overrides: {} }),
  );

  const timers = new Set();
  const handlers = new Map();
  let waitIdle = null;
  let waitChanged = null;
  let lastChangedBytes = 0;
  let existsSyncCount = 0;
  const origExistsSync = fs.existsSync;
  const trackedFs = {
    ...fs,
    watch: () => ({ close() {} }),
    existsSync(p) {
      existsSyncCount++;
      return origExistsSync(p);
    },
  };

  try {
    const exports = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'electron/library.cjs'), 'utf8'), {
      require: (name) => {
        if (name === 'electron') {
          return {
            app: { getPath: () => dir, getVersion: () => '3.2.9-denza.5' },
            protocol: { handle: () => {} },
            net: { fetch: async () => new Response('') },
            nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
            dialog: {},
          };
        }
        if (name === 'node:fs') return trackedFs;
        if (name === './online/library-links.cjs') return require(path.join(ROOT, 'electron/online/library-links.cjs'));
        return require(name);
      },
      module: exports,
      __dirname: path.join(ROOT, 'electron'),
      process: { env: { CADENZA_USER_DATA: dir } },
      Buffer,
      Response,
      URL,
      TextDecoder,
      console,
      clearTimeout,
      setTimeout: (fn, ms) => {
        const id = setTimeout(fn, ms);
        timers.add(id);
        return id;
      },
    });

    await exports.exports.start(
      { handle: (name, fn) => handlers.set(name, fn) },
      () => ({
        isDestroyed: () => false,
        webContents: {
          send: (ch, data) => {
            if (ch === 'lib:progress' && data?.phase === 'idle' && waitIdle) {
              const resolve = waitIdle;
              waitIdle = null;
              resolve();
            }
            if (ch === 'lib:changed') {
              lastChangedBytes = Buffer.byteLength(JSON.stringify(data));
              if (waitChanged) {
                const resolve = waitChanged;
                waitChanged = null;
                resolve(lastChangedBytes);
              }
            }
          },
        },
      }),
      { scanOnLaunch: false },
    );

    const runScan = () =>
      new Promise((resolve) => {
        waitIdle = resolve;
        handlers.get('lib:rescan')();
      });

    existsSyncCount = 0;
    const tScan1 = performance.now();
    await runScan();
    const scanColdMs = +(performance.now() - tScan1).toFixed(2);
    const scanColdExistsSync = existsSyncCount;

    existsSyncCount = 0;
    const tScan2 = performance.now();
    await runScan();
    const scanWarmMs = +(performance.now() - tScan2).toFixed(2);
    const scanWarmExistsSync = existsSyncCount;

    const lists = [0, 1, 2].map((p) => ({
      id: `pl-${p}`,
      name: `Playlist ${p}`,
      artworkUrl: '',
      songs: Array.from({ length: 1000 }, (_, i) => ({
        platform: 'netease',
        id: `song-${p}-${i}`,
        title: `Track Title ${p}-${i}`,
        artist: `Artist ${i % 50}`,
        album: `Album ${i % 20}`,
        duration: 180 + (i % 60),
      })),
    }));

    const tSync = performance.now();
    const viewAfterSync = exports.exports.syncPlaylists('netease', 'bench-uid', lists);
    const syncMs = +(performance.now() - tSync).toFixed(2);

    // Wait for debounced save() (400ms) to flush db.json to disk.
    await new Promise((r) => setTimeout(r, 600));
    const dbBytes = fs.statSync(path.join(dir, 'library', 'db.json')).size;
    const viewPayloadBytes = Buffer.byteLength(JSON.stringify(viewAfterSync));

    const tLookup = performance.now();
    for (let i = 0; i < 100; i++) exports.exports.remoteSong(`netease:song-2-${900 + i}`);
    const remoteSong100Ms = +(performance.now() - tLookup).toFixed(3);

    const tPlayed = performance.now();
    const anyTrackId = viewAfterSync.tracks[0].id;
    const changedPromise = new Promise((resolve) => {
      waitChanged = resolve;
    });
    handlers.get('lib:played')(null, anyTrackId);
    const libPlayedSyncMs = +(performance.now() - tPlayed).toFixed(3);
    const libPlayedChangedBytes = await changedPromise;
    await new Promise((r) => setTimeout(r, 500));

    const tImport = performance.now();
    await exports.exports.importDownload(downloadFile, {
      platform: 'netease',
      id: 'song-0-42',
      title: 'Downloaded New',
      artist: 'Artist 42',
      duration: 180,
    });
    const importDownloadMs = +(performance.now() - tImport).toFixed(2);
    await new Promise((r) => setTimeout(r, 500));

    return {
      trackCount,
      syncedPlaylists: 3,
      syncedSongsTotal: 3000,
      scanColdMs,
      scanColdExistsSync,
      scanWarmMs,
      scanWarmExistsSync,
      syncMs,
      dbBytes,
      libChangedPayloadBytes: viewPayloadBytes,
      libPlayedChangedBytes,
      remoteSong100Ms,
      libPlayedSyncMs,
      importDownloadMs,
    };
  } finally {
    for (const timer of timers) clearTimeout(timer);
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function benchTaggingEventLoopLag() {
  const { Downloads } = require(path.join(ROOT, 'electron/downloads.cjs'));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'denza-bench-dl-'));
  try {
    const flac = await fsp.readFile(path.join(ROOT, 'tests/fixtures/online-audio/tone.flac'));
    const cover = await fsp.readFile(path.join(ROOT, 'tests/fixtures/cover.jpg'));
    const store = { data: { jobs: [], folder: dir }, save: async () => {} };
    let artworkFetchCount = 0;
    const manager = new Downloads(
      store,
      {
        resolve: async () => ({ url: 'https://fixture.invalid/audio', expectedFormat: 'flac' }),
        lyrics: async () => ({ original: '[00:01]Line 1\n[00:02]Line 2', translation: '[00:01]行1\n[00:02]行2' }),
      },
      { importDownload: async () => {} },
      () => {},
      async () => new Response(flac),
      async () => {
        artworkFetchCount++;
        return new Response(cover, { headers: { 'content-type': 'image/jpeg' } });
      },
    );
    const makeJob = (i) => ({
      id: `dl-${i}`,
      track: {
        platform: 'netease',
        id: `track-${i}`,
        title: `Tone ${i}`,
        artist: 'Bench Artist',
        album: 'Bench Album',
        duration: 1,
        artworkUrl: 'https://p1.music.126.net/cover.jpg',
      },
      quality: 'lossless',
      lyricsMode: 'both',
      folder: dir,
      status: 'queued',
      received: 0,
      total: 0,
    });
    const t0 = performance.now();
    await manager.run(makeJob(0), new AbortController());
    let maxLag = 0;
    let lastTick = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      const lag = now - lastTick - 10;
      if (lag > maxLag) maxLag = lag;
      lastTick = now;
    }, 10);
    for (let i = 1; i < 4; i++) {
      await manager.run(makeJob(i), new AbortController());
    }
    clearInterval(probe);
    const totalMs = +(performance.now() - t0).toFixed(2);
    if (typeof manager.close === 'function') await manager.close();
    return { downloads: 4, artworkFetchCount, totalMs, warmMaxEventLoopLagMs: +maxLag.toFixed(2) };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function measureDistApp() {
  const distDir = path.join(ROOT, 'dist-app');
  if (!fs.existsSync(distDir)) return { present: false };
  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      return e.isDirectory() ? walk(p) : e.isFile() ? [{ p, size: fs.statSync(p).size }] : [];
    });
  const all = walk(distDir);
  const indexHtml = fs.existsSync(path.join(distDir, 'index.html'))
    ? fs.statSync(path.join(distDir, 'index.html')).size
    : 0;
  const assetsBytes = all.filter((f) => f.p.includes(path.sep + 'assets' + path.sep)).reduce((a, b) => a + b.size, 0);
  const fontsBytes = all.filter((f) => f.p.includes(path.sep + 'fonts' + path.sep)).reduce((a, b) => a + b.size, 0);
  return {
    present: true,
    totalFiles: all.length,
    indexHtmlBytes: indexHtml,
    assetsBytes,
    fontsBytes,
  };
}

async function main() {
  const report = {
    timestamp: new Date().toISOString(),
    node: process.version,
    sdkWorkers: await benchSdkWorkers(),
    onlineStore: await benchOnlineStore(),
    libraryAndPlaylists: await benchLibraryAndPlaylists(),
    downloadsAndTagging: await benchTaggingEventLoopLag(),
    distApp: measureDistApp(),
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
