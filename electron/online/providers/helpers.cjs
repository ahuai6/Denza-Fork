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
function imageURL(value) {
  const url = String(value || '')
    .replace(/\{(?:size|w|h)\}/g, '500')
    .replace('{f}', 'jpg')
    .replace('{c}', 'bb');
  try {
    const parsed = new URL(url.startsWith('//') ? 'https:' + url : url);
    return /^https?:$/.test(parsed.protocol) ? parsed.href.replace(/^http:/, 'https:') : '';
  } catch {
    return '';
  }
}
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
    artworkUrl: imageURL(
      first(r, [
        'al.picUrl',
        'album.picUrl',
        'album.picurl',
        'picUrl',
        'Image',
        'imgurl',
        'sizable_cover',
        'flexible_cover',
        'trans_param.union_cover',
        'album_info.sizable_cover',
        'album_info.cover',
        'cover_url',
        'image',
        'img',
        'pic',
        'album_info.img',
      ]) ||
        (platform === 'qq' && first(r, ['album.mid', 'albummid'])
          ? 'https://y.gtimg.cn/music/photo_new/T002R500x500M000' + first(r, ['album.mid', 'albummid']) + '.jpg'
          : ''),
    ),
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
              artworkUrl: imageURL(
                first(r, [
                  'coverImgUrl',
                  'picUrl',
                  'logo',
                  'disspic',
                  'imgurl',
                  'Image',
                  'flexible_cover',
                  'sizable_cover',
                  'trans_param.union_cover',
                  'cover_url',
                  'pic',
                  'cover',
                  'img',
                ]),
              ),
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
module.exports = { first, cookies, joinCookies, song, pageResult, searchResult, downloadResult, imageURL };
