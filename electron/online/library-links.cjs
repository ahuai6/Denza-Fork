const path = require('node:path');
const crypto = require('node:crypto');
// Cadenza owns the database and scanning lifecycle; this module owns only the online extension.
function createLibraryIntegration({ getDB, trackView, scan, watchAll, changed, view }) {
  const normalizeSong = (v) =>
    String(v || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s\p{P}]+/gu, '');
  function linkSyncedPlaylists() {
    const db = getDB();
    const bySource = new Map(),
      byMetadata = new Map();
    const metadataKey = (title, artist) => normalizeSong(title) + '\0' + normalizeSong(artist);
    for (const track of Object.values(db.tracks)) {
      if (track.protected) continue;
      if (track.onlineKey) {
        const group = bySource.get(track.onlineKey) || [];
        group.push(track);
        bySource.set(track.onlineKey, group);
      }
      const value = trackView(track),
        key = metadataKey(value.title, value.artist);
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
      for (const song of playlist.remote.songs) {
        const exact = bySource.get(`${playlist.remote.platform}:${song.id}`);
        if (exact?.length) {
          // Multiple downloaded qualities share a trusted identity; retain an existing binding when possible.
          song.localId = exact.find((track) => track.id === song.localId)?.id || exact[0].id;
          continue;
        }
        const matches =
          song.artist && song.duration > 0
            ? (byMetadata.get(metadataKey(song.title, song.artist)) || []).filter(
                (track) => Math.abs(track.duration - song.duration) < 2,
              )
            : [];
        song.localId = matches.length === 1 ? matches[0].id : null;
      }
      playlist.tracks = playlist.remote.songs.map((song) => song.localId).filter(Boolean);
    }
  }
  async function importDownload(file, source) {
    const db = getDB();
    const folder = path.dirname(file);
    if (!db.folders.includes(folder)) {
      db.folders.push(folder);
      watchAll();
    }
    await scan();
    // A scan already underway queues another pass. Wait until it has actually registered this file.
    const until = Date.now() + 60000;
    let track;
    while (!(track = Object.values(db.tracks).find((t) => t.path === file)) && Date.now() < until)
      await new Promise((r) => setTimeout(r, 100));
    if (!track) throw Error('Downloaded audio could not be imported');
    track.onlineKey = `${source.platform}:${source.id}`;
    linkSyncedPlaylists();
    changed();
    return track.id;
  }
  function syncPlaylists(platform, uid, lists) {
    const db = getDB();
    for (const list of lists) {
      const id =
        'sync-' + crypto.createHash('sha256').update(`${platform}:${uid}:${list.id}`).digest('hex').slice(0, 24);
      let p = db.playlists.find((x) => x.id === id);
      if (!p) {
        p = { id, created: Date.now(), tracks: [] };
        db.playlists.push(p);
      }
      p.name = list.name;
      p.remote = { platform, uid, id: list.id, updated: Date.now(), songs: list.songs };
    }
    linkSyncedPlaylists();
    changed();
    return view();
  }
  return {
    linkSyncedPlaylists,
    importDownload,
    syncPlaylists,
    remoteSong: (key) =>
      getDB()
        .playlists.flatMap((p) => p.remote?.songs || [])
        .find((s) => `${s.platform}:${s.id}` === key),
    remotePlaylist: (id) => getDB().playlists.find((p) => p.id === id)?.remote,
  };
}
module.exports = { createLibraryIntegration };
