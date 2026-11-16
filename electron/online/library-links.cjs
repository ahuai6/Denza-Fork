const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

// Cadenza owns the database and scanning lifecycle; this module owns only the online extension.
function createLibraryIntegration({
  getDB,
  trackView,
  scan,
  importFile,
  watchAll,
  changed,
  view,
  cacheArtwork,
  hasArtwork = () => true,
  remoteDir,
}) {
  const covers = new Map();
  const cachedSongs = new Map();
  const songLookup = new Map();
  const normCache = new Map();
  let writeChain = Promise.resolve();

  const normalizeSong = (v) =>
    String(v || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s\p{P}]+/gu, '');

  const normParts = (title, artist) => {
    const cacheKey = `${title}\0${artist}`;
    let hit = normCache.get(cacheKey);
    if (hit === undefined) {
      hit = normalizeSong(title) + '\0' + normalizeSong(artist);
      if (normCache.size >= 10000) normCache.clear();
      normCache.set(cacheKey, hit);
    }
    return hit;
  };

  const safeFile = (id) =>
    remoteDir ? path.join(remoteDir, String(id).replace(/[^a-zA-Z0-9_-]/g, '') + '.json') : null;

  function queueWrite(file, payload) {
    if (!file) return;
    const text = JSON.stringify(payload);
    writeChain = writeChain
      .catch(() => {})
      .then(async () => {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const temp = `${file}.${crypto.randomUUID()}.tmp`;
        try {
          await fsp.writeFile(temp, text, 'utf8');
          await fsp.rename(temp, file);
        } finally {
          await fsp.rm(temp, { force: true }).catch(() => {});
        }
      });
  }

  function readShardSync(id) {
    const file = safeFile(id);
    if (!file) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const songs = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.songs) ? parsed.songs : [];
      return songs;
    } catch {
      return null;
    }
  }

  function getPlaylistSongs(playlist) {
    if (!playlist?.remote) return [];
    if (Array.isArray(playlist.remote.songs)) {
      cachedSongs.set(playlist.id, playlist.remote.songs);
      return playlist.remote.songs;
    }
    if (cachedSongs.has(playlist.id)) return cachedSongs.get(playlist.id);
    const loaded = readShardSync(playlist.id);
    if (loaded) {
      cachedSongs.set(playlist.id, loaded);
      return loaded;
    }
    return [];
  }

  function indexSongs(songs) {
    for (const s of songs) {
      if (s && s.platform && s.id) songLookup.set(`${s.platform}:${s.id}`, s);
    }
  }

  function persistPlaylistSongs(playlist, songs) {
    cachedSongs.set(playlist.id, songs);
    indexSongs(songs);
    if (!remoteDir) {
      if (playlist.remote) playlist.remote.songs = songs;
      return;
    }
    const file = safeFile(playlist.id);
    queueWrite(file, { version: 1, id: playlist.id, updated: playlist.remote?.updated || Date.now(), songs });
  }

  async function migrateLegacyPlaylists() {
    if (!remoteDir) return false;
    const db = getDB();
    let migrated = false;
    for (const playlist of db.playlists) {
      if (!playlist.remote) continue;
      if (Array.isArray(playlist.remote.songs)) {
        const songs = playlist.remote.songs;
        await fsp.mkdir(remoteDir, { recursive: true });
        const file = safeFile(playlist.id);
        const temp = `${file}.${crypto.randomUUID()}.tmp`;
        try {
          await fsp.writeFile(
            temp,
            JSON.stringify({ version: 1, id: playlist.id, updated: playlist.remote.updated || Date.now(), songs }),
            'utf8',
          );
          await fsp.rename(temp, file);
        } finally {
          await fsp.rm(temp, { force: true }).catch(() => {});
        }
        cachedSongs.set(playlist.id, songs);
        indexSongs(songs);
        playlist.remote.songCount = songs.length;
        delete playlist.remote.songs;
        migrated = true;
      } else if (typeof playlist.remote.songCount !== 'number') {
        const songs = getPlaylistSongs(playlist);
        playlist.remote.songCount = songs.length;
        migrated = true;
      }
    }
    return migrated;
  }

  function removePlaylistShard(id) {
    cachedSongs.delete(id);
    const file = safeFile(id);
    if (file) void fsp.rm(file, { force: true }).catch(() => {});
  }

  function linkSyncedPlaylists(forcePersistIds = null) {
    const db = getDB();
    const bySource = new Map(),
      byMetadata = new Map();
    for (const track of Object.values(db.tracks)) {
      if (track.protected) continue;
      if (track.onlineCatalogKey) {
        const group = bySource.get(track.onlineCatalogKey) || [];
        group.push(track);
        bySource.set(track.onlineCatalogKey, group);
      }
      if (track.onlineKey) {
        const group = bySource.get(track.onlineKey) || [];
        group.push(track);
        bySource.set(track.onlineKey, group);
      }
      const value = trackView(track),
        key = normParts(value.title, value.artist);
      const group = byMetadata.get(key) || [];
      group.push({ id: track.id, duration: value.duration });
      byMetadata.set(key, group);
    }
    for (const group of bySource.values())
      group.sort(
        (a, b) =>
          Number(!!b.lossless) - Number(!!a.lossless) ||
          (b.sampleRate || 0) - (a.sampleRate || 0) ||
          (b.bits || 0) - (a.bits || 0) ||
          a.id.localeCompare(b.id),
      );
    for (const playlist of db.playlists) {
      if (!playlist.remote) continue;
      const songs = getPlaylistSongs(playlist);
      let dirty = false;
      for (const song of songs) {
        const prevLocal = song.localId ?? null;
        const exact =
          bySource.get(`${playlist.remote.platform}:${song.id}`) ||
          (song.catalogId && bySource.get(`${playlist.remote.platform}:catalog:${song.catalogId}`));
        let nextLocal = null;
        if (exact?.length) {
          // Multiple downloaded qualities share a trusted identity; retain an existing binding when possible.
          nextLocal = exact.find((track) => track.id === prevLocal)?.id || exact[0].id;
        } else if (song.artist && song.duration > 0) {
          const matches = (byMetadata.get(normParts(song.title, song.artist)) || []).filter(
            (track) => Math.abs(track.duration - song.duration) < 2,
          );
          nextLocal = matches.length === 1 ? matches[0].id : null;
        }
        if (nextLocal !== prevLocal) dirty = true;
        song.localId = nextLocal;
      }
      playlist.remote.songCount = songs.length;
      playlist.tracks = songs.map((song) => song.localId).filter(Boolean);
      indexSongs(songs);
      if (dirty || forcePersistIds?.has(playlist.id)) persistPlaylistSongs(playlist, songs);
    }
  }

  async function importDownload(file, source) {
    const db = getDB();
    const folder = path.dirname(file);
    if (!db.folders.includes(folder)) {
      db.folders.push(folder);
      watchAll();
    }
    let track;
    if (typeof importFile === 'function') {
      track = await importFile(file);
    } else {
      await scan();
      const until = Date.now() + 60000;
      while (!(track = Object.values(db.tracks).find((t) => t.path === file)) && Date.now() < until)
        await new Promise((r) => setTimeout(r, 100));
    }
    if (!track) throw Error('Downloaded audio could not be imported');
    if (source.catalogId) track.onlineCatalogKey = `${source.platform}:catalog:${source.catalogId}`;
    track.onlineKey = `${source.platform}:${source.id}`;
    linkSyncedPlaylists();
    changed();
    return track.id;
  }

  function syncPlaylists(platform, uid, lists) {
    const db = getDB();
    const forcePersistIds = new Set();
    for (const list of lists) {
      const id =
        'sync-' + crypto.createHash('sha256').update(`${platform}:${uid}:${list.id}`).digest('hex').slice(0, 24);
      let p = db.playlists.find((x) => x.id === id);
      if (!p) {
        p = { id, created: Date.now(), tracks: [] };
        db.playlists.push(p);
      }
      p.name = list.name;
      const cached = p.remote && p.remote.artworkUrl === list.artworkUrl ? p.remote.cover : null;
      const songs = Array.isArray(list.songs) ? list.songs.map((s) => ({ ...s })) : [];
      p.remote = {
        platform,
        uid,
        id: list.id,
        artworkUrl: list.artworkUrl || '',
        cover: cached || null,
        updated: Date.now(),
        songCount: songs.length,
        ...(!remoteDir ? { songs } : {}),
      };
      cachedSongs.set(p.id, songs);
      forcePersistIds.add(p.id);
    }
    linkSyncedPlaylists(forcePersistIds);
    changed();
    return view();
  }

  async function cachePlaylistCover(id) {
    const playlist = getDB().playlists.find((p) => p.id === id),
      remote = playlist?.remote;
    if (!remote?.artworkUrl || !cacheArtwork) return null;
    if (remote.cover && hasArtwork(remote.cover)) return remote.cover;
    const key = id + '|' + remote.artworkUrl;
    if (covers.has(key)) return covers.get(key);
    if (covers.size >= 4) return null;
    const task = (async () => {
      try {
        const cover = await cacheArtwork(remote.artworkUrl);
        const current = getDB().playlists.find((p) => p.id === id)?.remote;
        if (!cover || current?.uid !== remote.uid || current?.artworkUrl !== remote.artworkUrl) return null;
        current.cover = cover;
        changed();
        return cover;
      } finally {
        covers.delete(key);
      }
    })();
    covers.set(key, task);
    return task;
  }

  function remoteSong(key) {
    const cached = songLookup.get(key);
    if (cached) return cached;
    for (const playlist of getDB().playlists) {
      if (!playlist.remote) continue;
      const songs = getPlaylistSongs(playlist);
      indexSongs(songs);
      if (songLookup.has(key)) return songLookup.get(key);
    }
    return undefined;
  }

  function remoteSongs(id) {
    const playlist = getDB().playlists.find((p) => p.id === id);
    if (!playlist?.remote) return [];
    return getPlaylistSongs(playlist);
  }

  return {
    linkSyncedPlaylists,
    cachePlaylistCover,
    importDownload,
    syncPlaylists,
    migrateLegacyPlaylists,
    removePlaylistShard,
    flushRemotePlaylists: () => writeChain.catch(() => {}),
    remoteSongs,
    remoteSong,
    remotePlaylist: (id) => getDB().playlists.find((p) => p.id === id)?.remote,
  };
}

module.exports = { createLibraryIntegration };
