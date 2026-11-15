const first = (o, paths, fallback = '') => {
  for (const p of paths) {
    const v = p.split('.').reduce((a, k) => a?.[k], o);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback;
};
const cookies = (s) =>
  Object.fromEntries(
    String(s || '')
      .split(';')
      .map((x) => x.trim().split(/=(.*)/s))
      .filter(([k, v]) => k && v !== undefined),
  );
const joinCookies = (s) =>
  (Array.isArray(s) ? s.map((x) => x.split(';')[0]) : String(s).split(';'))
    .filter((x) => !/^\s*(path|domain|expires|max-age|samesite)=/i.test(x))
    .join('; ');
const names = (v) =>
  Array.isArray(v)
    ? v
        .map((x) => x.name || x.singername || x.author_name || '')
        .filter(Boolean)
        .join(' / ')
    : String(v || '');
const clean = (v) =>
  String(v || '')
    .replace(/<[^>]*>/g, '')
    .trim();
function song(raw, platform) {
  const r = raw.musicData || raw.songInfo || raw;
  const id = first(r, ['mid', 'songmid', 'hash', 'Hash', 'FileHash', 'audio_info.hash', 'id', 'songid']);
  let title = clean(
    first(r, ['name', 'title', 'songname', 'SongName', 'song_name', 'audio_name', 'filename', 'FileName']),
  );
  let artist = names(
    first(r, ['ar', 'artists', 'singer', 'singers', 'authors', 'author_name', 'singername', 'SingerName', 'artist']),
  );
  if (!artist && platform === 'kugou' && title.includes(' - '))
    ([artist, ...title] = title.split(' - ')), (title = title.join(' - '));
  const duration = Number(first(r, ['dt', 'duration', 'timelen', 'timelength', 'interval', 'Duration'], 0));
  return {
    platform,
    id: String(id),
    title,
    artist,
    album: clean(first(r, ['al.name', 'album.name', 'albumname', 'album_name'])),
    duration: r.dt !== undefined || r.timelen !== undefined || r.timelength !== undefined ? duration / 1000 : duration,
    albumId: String(first(r, ['al.id', 'album.id', 'albumid', 'album_id', 'AlbumID'])),
    mediaId: String(first(r, ['file.media_mid', 'file.mediaMid', 'strMediaMid'])),
    albumAudioId: String(first(r, ['album_audio_id', 'AlbumAudioID', 'mixsongid', 'MixSongID'])),
  };
}
function pageResult(rows, kind, platform, body, total, idPaths = ['id', 'tid', 'dissid', 'disstid', 'listid']) {
  if (!Array.isArray(rows)) throw Error('Incomplete playlist response');
  return {
    rows:
      kind === 'songs'
        ? rows.map((r) => song(r, platform))
        : rows
            .map((r) => ({
              id: String(first(r, idPaths)),
              name: clean(first(r, ['name', 'dissname', 'specialname', 'title'])),
            }))
            .filter((r) => r.id && r.name),
    more: body.more === true || rows.length >= 100,
    total: total === undefined || total === null ? null : Number(total),
  };
}
function searchResult(rows, platform) {
  if (!Array.isArray(rows)) throw Error('Platform search response is incomplete');
  return rows.map((r) => song(r, platform)).filter((r) => r.id && r.title);
}
function downloadResult(row) {
  // An SDK may return an array or a string; indexing a string at "0" would truncate the URL to one character.
  const value =
    (Array.isArray(row?.url) ? row.url[0] : row?.url) ||
    (Array.isArray(row?.backup_url) ? row.backup_url[0] : row?.backup_url);
  if (!value) throw Error('No audio is available for this account, quality or region');
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw Error('No downloadable audio');
  if (row.freeTrialInfo || row.trial || row.isFreePart || row.is_free_part || row.free_part === 1)
    throw Error('Only a preview is available');
  return { url: url.href };
}
module.exports = { first, cookies, joinCookies, song, pageResult, searchResult, downloadResult };
