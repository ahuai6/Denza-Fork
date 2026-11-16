const path = require('node:path');
const { readJSON } = require('./online/json-client.cjs');
const { OnlineStore } = require('./online-store.cjs');
const { Platforms, PLATFORMS } = require('./platforms.cjs');
const { Downloads } = require('./downloads.cjs');
const { Translator, CodexText } = require('./translation-service.cjs');
const { AppleMusic, appleFetch } = require('./apple-music.cjs');
const { LyricsFlowAudio } = require('./online/lyricsflow-audio.cjs');
const { createPublicResolver } = require('./online/public-resolvers.cjs');
const { closeSdkWorkers } = require('./online/sdk-transport.cjs');

// Fetch the complete snapshot before changing any saved playlist. Repeated/partial pages never erase the old copy.
async function collectPages(read, signal) {
  const rows = [],
    pages = new Set();
  for (let page = 1; page <= 100; page++) {
    signal?.throwIfAborted();
    const result = await read(page);
    if (!Array.isArray(result.rows)) throw Error('Incomplete playlist page');
    const signature = JSON.stringify(result.rows.map((row) => row.id));
    if (result.rows.length && pages.has(signature))
      throw Error('Playlist pagination did not advance; previous copy retained');
    pages.add(signature);
    for (const row of result.rows) {
      if (!row.id) throw Error('Missing remote song identity');
      rows.push(row);
    }
    if (result.total !== null && (!Number.isFinite(result.total) || result.total < 0))
      throw Error('Invalid playlist length');
    if (result.total !== null && rows.length >= result.total) return rows;
    if (!result.more) {
      if (result.total !== null && rows.length < result.total)
        throw Error('Playlist is incomplete; previous copy retained');
      return rows;
    }
    if (!result.rows.length) throw Error('Playlist pagination did not advance; previous copy retained');
  }
  throw Error('Playlist exceeds the supported size; previous copy retained');
}
async function start(ipcMain, getWin, library) {
  const { app, dialog, shell, safeStorage, net } = require('electron');
  const store = new OnlineStore(path.join(app.getPath('userData'), 'online.json'), safeStorage);
  await store.load();
  const apple = new AppleMusic(
    store,
    () => publish(),
    (url, options) => appleFetch(net, url, options),
  );
  const fetcher = (url, options) => net.fetch(url, { ...options, credentials: 'omit' });
  const platforms = new Platforms(store, undefined, apple, {
    json: (url, options) => readJSON(fetcher, url, options),
    audio: new LyricsFlowAudio(undefined, fetcher),
    fallback: createPublicResolver(fetcher),
  });
  const candidates = new Map(),
    tasks = new Map();
  const keyOf = (track) => `${track.platform}:${track.id}`;
  const remember = (tracks) => {
    for (const track of tracks) candidates.set(keyOf(track), track);
    while (candidates.size > 2000) candidates.delete(candidates.keys().next().value);
    return tracks;
  };
  const publish = () => {
    const win = getWin();
    if (win && !win.isDestroyed())
      win.webContents.send('online:changed', {
        accounts: store.accounts(),
        folder: store.data.folder,
        preferences: store.data.preferences,
        jobs: downloads.view(),
      });
  };
  const publishProgress = (progress) => {
    const win = getWin();
    if (win && !win.isDestroyed()) win.webContents.send('online:progress', progress);
  };
  const downloads = new Downloads(
    store,
    platforms,
    library,
    publish,
    (url, options) => fetcher(url, { signal: options.signal, headers: options.headers }),
    fetcher,
    publishProgress,
  );
  const codex = new CodexText(app.getPath('userData'), (url) => shell.openExternal(url));
  const translator = new Translator(store, codex);
  const track = (key) => {
    const found =
      candidates.get(key) || library.remoteSong(key) || store.data.jobs.find((j) => keyOf(j.track) === key)?.track;
    if (!found) throw Error('Search again to refresh this song');
    return found;
  };
  const job = async (id, run) => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id) || tasks.has(id) || tasks.size >= 3)
      throw Error('Another task is running');
    const control = new AbortController();
    tasks.set(id, control);
    try {
      return await run(control.signal);
    } finally {
      tasks.delete(id);
    }
  };
  const openRemote = ({ key, playlistId }) =>
    key ? platforms.open(track(key)) : platforms.open(null, library.remotePlaylist(playlistId));
  const operations = {
    state: () => ({
      accounts: store.accounts(),
      folder: store.data.folder,
      jobs: downloads.view(),
      preferences: store.data.preferences,
    }),
    preferences: async ({ platform, quality, lyricsMode }) => {
      if (platform && ![...PLATFORMS, 'all'].includes(platform)) throw Error('Unknown platform preference');
      if (quality && !['standard', 'high', 'lossless', 'hires'].includes(quality)) throw Error('Unknown quality');
      if (lyricsMode && !['none', 'lrc', 'ttml', 'both'].includes(lyricsMode)) throw Error('Unknown lyric field mode');
      if (platform && quality) store.data.preferences.qualities[platform] = quality;
      if (lyricsMode) store.data.preferences.lyricsMode = lyricsMode;
      await store.save();
      publish();
      return store.data.preferences;
    },
    lookup: ({ input, jobId }) =>
      job(jobId, async (signal) => remember(await platforms.lookup('apple', input, signal))),
    folder: async () => {
      const r = await dialog.showOpenDialog(getWin(), { properties: ['openDirectory', 'createDirectory'] });
      if (!r.canceled && r.filePaths[0]) {
        store.data.folder = r.filePaths[0];
        await store.save();
        publish();
      }
      return store.data.folder;
    },
    search: ({ platform, query, page = 1, jobId }) =>
      job(jobId, async (signal) => {
        const selected = platform === 'all' ? PLATFORMS : [platform];
        const results = await Promise.allSettled(selected.map((p) => platforms.search(p, query, page, signal)));
        signal.throwIfAborted();
        return {
          tracks: remember(results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))),
          errors: results.flatMap((r, i) =>
            r.status === 'rejected' ? [{ platform: selected[i], message: String(r.reason.message).slice(0, 200) }] : [],
          ),
        };
      }),
    login: async ({ platform, action, sessionId }) => {
      const value = await platforms.login(platform, action, sessionId);
      publish();
      return value;
    },
    account: async ({ platform, cookie, uid }) => {
      const value = await platforms.account(platform, cookie, uid);
      publish();
      return value;
    },
    logout: async ({ platform }) => {
      const value = await platforms.logout(platform);
      publish();
      return value;
    },
    sync: ({ platform, jobId }) =>
      job(jobId, async (signal) => {
        const uid = store.credential(platform).uid;
        if (!uid) throw Error('Sign in first');
        const lists = await collectPages((p) => platforms.page(platform, 'lists', '', p, signal), signal);
        if (lists.length > 300) throw Error('Too many playlists to sync at once');
        const snapshot = new Array(lists.length);
        const batchControl = new AbortController();
        const batchSignal = signal ? AbortSignal.any([signal, batchControl.signal]) : batchControl.signal;
        let cursor = 0;
        const concurrency = Math.min(4, lists.length);
        const worker = async () => {
          while (true) {
            batchSignal.throwIfAborted();
            const index = cursor++;
            if (index >= lists.length) return;
            const list = lists[index];
            const songs = await collectPages(
              (p) => platforms.page(platform, 'songs', list.id, p, batchSignal),
              batchSignal,
            );
            snapshot[index] = { ...list, songs };
          }
        };
        try {
          await Promise.all(Array.from({ length: concurrency }, worker));
        } catch (error) {
          batchControl.abort();
          throw error;
        }
        signal.throwIfAborted();
        if (store.credential(platform).uid !== uid) throw Error('Account changed while syncing');
        const view = library.syncPlaylists(platform, uid, snapshot);
        remember(snapshot.flatMap((p) => p.songs));
        return view;
      }),
    enqueue: ({ keys, quality }) => {
      if (!Array.isArray(keys) || !keys.length || keys.length > 100) throw Error('Select 1–100 songs');
      const tracks = keys.map(track);
      if (tracks.some((t) => !platforms.info(t.platform).download))
        throw Error('This platform manages offline downloads in its official app');
      return downloads.add(tracks, quality);
    },
    openRemote,
    // Compatibility with the first draft; new callers use the provider-neutral operation.
    appleOpen: ({ key, playlistId }) => {
      if (key) {
        const song = track(key);
        if (song.platform !== 'apple') throw Error('Not an Apple Music song');
        return platforms.open(song);
      }
      const list = library.remotePlaylist(playlistId);
      if (list?.platform !== 'apple') throw Error('Not an Apple Music playlist');
      return platforms.open(null, list);
    },
    playlistCover: ({ id }) => {
      if (typeof id !== 'string' || id.length > 100) throw Error('Invalid playlist');
      return library.cachePlaylistCover(id);
    },
    playlistSongs: ({ id }) => {
      if (typeof id !== 'string' || id.length > 100) throw Error('Invalid playlist');
      return library.remoteSongs(id);
    },
    downloadAction: ({ id, action }) => downloads.action(id, action),
    lyrics: ({ key, jobId }) => job(jobId, (signal) => platforms.lyrics(track(key), signal)),
    provider: () => translator.settings(),
    setProvider: (value) => translator.configure(value),
    models: () => translator.models(),
    codex: ({ action }) => {
      if (!['status', 'login', 'cancel', 'logout'].includes(action)) throw Error('Invalid login action');
      return codex.account(action);
    },
    translate: ({ input, jobId }) => job(jobId, (signal) => translator.translate(input, signal)),
    cancel: ({ jobId }) => {
      tasks.get(jobId)?.abort();
      return true;
    },
  };
  ipcMain.handle('online:request', async (event, operation, args = {}) => {
    if (
      event.sender !== getWin()?.webContents ||
      !Object.hasOwn(operations, operation) ||
      !args ||
      typeof args !== 'object' ||
      JSON.stringify(args).length > 200000
    )
      throw Error('Invalid online operation');
    return operations[operation](args);
  });
  return {
    async close() {
      for (const c of tasks.values()) c.abort();
      apple.close();
      codex.close();
      await downloads.close();
      await closeSdkWorkers();
      await store.close();
      await library.flushRemotePlaylists?.();
    },
  };
}
module.exports = { start, collectPages };
