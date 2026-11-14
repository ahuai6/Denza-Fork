const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const QRCode = require('qrcode');
const PLATFORMS = ['netease', 'qq', 'kugou'];
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
function sdk(platform, method, query, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'platform-worker.cjs'), {
      workerData: { platform, method, query },
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate();
      err ? reject(err) : resolve(value);
    };
    const abort = () => finish(Error('Cancelled'));
    const timer = setTimeout(() => finish(Error('Platform request timed out')), 25000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('error', (e) => finish(e));
    worker.once('exit', () => finish(Error('Platform worker stopped')));
    worker.once('message', (r) => finish(r.error ? Error(r.error) : null, r.value));
    if (signal?.aborted) abort();
  });
}
class Platforms {
  constructor(store, invoke = sdk) {
    this.store = store;
    this.invoke = invoke;
    this.sessions = new Map();
  }
  async call(platform, method, params = {}, signal, override) {
    if (!PLATFORMS.includes(platform)) throw Error('Unknown music platform');
    const credential = override || this.store.credential(platform);
    const query =
      platform === 'qq'
        ? ['getUserPlaylists', 'getUserDetail'].includes(method)
          ? { ...params, cookie: credential.cookie }
          : {
              params,
              option: { timeout: 18000, headers: credential.cookie ? { Cookie: credential.cookie } : {} },
              isFormat: false,
            }
        : {
            ...params,
            timestamp: Date.now(),
            cookie:
              platform === 'kugou' ? { ...this.store.data.device, ...cookies(credential.cookie) } : credential.cookie,
          };
    const raw = await this.invoke(platform, method, query, signal);
    let body = raw?.body ?? raw;
    if (body?.response && typeof body.response === 'object') body = body.response;
    if (
      raw?.status >= 400 ||
      body?.error ||
      body?.isOk === false ||
      body?.status === 0 ||
      (body?.code !== undefined && ![0, 1, 200, 800, 801, 802, 803].includes(Number(body.code))) ||
      (body?.error_code && Number(body.error_code) !== 0)
    )
      throw Error('Platform rejected the request');
    return body;
  }
  async device(signal) {
    if (this.store.data.device.dfid) return;
    this.store.data.device = {
      KUGOU_API_MID: randomBytes(16).toString('hex'),
      KUGOU_API_GUID: randomBytes(16).toString('hex'),
      KUGOU_API_MAC: '00:00:00:00:00:00',
      KUGOU_API_DEV: 'Denza',
      ...this.store.data.device,
    };
    const b = await this.call('kugou', 'register_dev', {}, signal);
    this.store.data.device.dfid = first(b, ['data.dfid', 'dfid']);
    await this.store.save();
  }
  async search(platform, query, page = 1, signal) {
    if (
      !PLATFORMS.includes(platform) ||
      typeof query !== 'string' ||
      query.length > 200 ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > 100
    )
      throw Error('Invalid search');
    let b, rows;
    if (platform === 'netease') {
      b = await this.call(
        platform,
        'cloudsearch',
        { keywords: query, type: 1, limit: 30, offset: (page - 1) * 30 },
        signal,
      );
      rows = b.result?.songs;
    } else if (platform === 'qq') {
      b = await this.call(platform, 'getSearchByKey', { key: query, t: 0, n: 30, p: page }, signal);
      rows = first(b, ['data.song.list', 'song.list', 'body.song.list'], []);
    } else {
      await this.device(signal);
      b = await this.call(platform, 'search', { keywords: query, type: 'song', page, pagesize: 30 }, signal);
      rows = first(b, ['data.lists', 'data.info', 'data.list'], []);
    }
    if (!Array.isArray(rows)) throw Error('Platform search response is incomplete');
    return rows.map((r) => song(r, platform)).filter((r) => r.id && r.title);
  }
  async account(platform, cookie, uid = '') {
    if (!PLATFORMS.includes(platform) || typeof cookie !== 'string' || !cookie.trim() || cookie.length > 50000)
      throw Error('Invalid account credentials');
    const c = cookies(cookie);
    uid = String(uid || c.userid || c.uin || c.wxuin || '').replace(/^o/, '');
    const b = await this.call(
      platform,
      platform === 'netease' ? 'login_status' : platform === 'qq' ? 'getUserDetail' : 'user_detail',
      { uin: uid, userid: uid },
      undefined,
      { cookie, uid },
    );
    const profile = platform === 'netease' ? b.data?.profile || b.profile : b.data || b;
    uid = String(platform === 'netease' ? profile?.userId || '' : uid || profile?.userid || '');
    const name = first(profile, ['nickname', 'user_name', 'nick_name', 'creator.nick']);
    if (!uid || !name) throw Error('Cannot verify this account; check login and user ID');
    await this.store.setAccount(platform, { uid, name, cookie: joinCookies(cookie) });
    return this.store.accounts();
  }
  async login(platform, action, id) {
    if (!PLATFORMS.includes(platform)) throw Error('Unknown music platform');
    if (action === 'cancel') {
      this.sessions.delete(id);
      return { done: false };
    }
    for (const [key, value] of this.sessions) if (Date.now() - value.created > 180000) this.sessions.delete(key);
    if (action === 'create') {
      if (this.sessions.size >= 6) throw Error('Too many login requests');
      const state = { platform, created: Date.now() };
      let image;
      if (platform === 'qq') {
        const b = await this.call(platform, 'getQQLoginQr');
        state.qrsig = b.qrsig;
        state.ptqrtoken = b.ptqrtoken;
        image = b.img;
      } else {
        if (platform === 'kugou') await this.device();
        const b = await this.call(platform, 'login_qr_key');
        state.key = first(
          b,
          platform === 'netease'
            ? ['data.unikey', 'data.data.unikey', 'unikey']
            : ['data.qrcode', 'qrcode', 'data.key'],
        );
        if (!state.key) throw Error('Cannot create login QR code');
        image = await QRCode.toDataURL(
          platform === 'netease'
            ? `https://music.163.com/login?codekey=${state.key}`
            : `https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=1005&qrcode=${state.key}`,
        );
      }
      if (!image || !/^data:image\//.test(image)) throw Error('Invalid QR image');
      const sessionId = randomUUID();
      this.sessions.set(sessionId, state);
      return { sessionId, image, done: false };
    }
    const state = this.sessions.get(id);
    if (!state || state.platform !== platform) throw Error('Login expired');
    const b = await this.call(
      platform,
      platform === 'qq' ? 'checkQQLoginQr' : 'login_qr_check',
      platform === 'qq' ? { qrsig: state.qrsig, ptqrtoken: state.ptqrtoken } : { key: state.key },
    );
    if (b.refresh || b.code === 800 || b.data?.status === 0) throw Error('Login expired');
    const cookie =
      platform === 'netease' && b.code === 803
        ? joinCookies(b.cookie || '')
        : platform === 'qq' && b.isOk
          ? b.session?.cookie
          : platform === 'kugou' && b.data?.status === 4
            ? `token=${b.data.token}; userid=${b.data.userid}`
            : '';
    if (!cookie) return { done: false };
    await this.account(platform, cookie, b.data?.userid);
    this.sessions.delete(id);
    return { done: true };
  }
  async page(platform, kind, id, page, signal) {
    const uid = this.store.credential(platform).uid;
    if (!uid) throw Error('Sign in first');
    const n = 100,
      offset = (page - 1) * n;
    let b, rows, total;
    if (platform === 'netease') {
      b = await this.call(
        platform,
        kind === 'lists' ? 'user_playlist' : 'playlist_track_all',
        kind === 'lists' ? { uid, limit: n, offset } : { id, limit: n, offset },
        signal,
      );
      rows = kind === 'lists' ? b.playlist : b.songs;
      total = kind === 'lists' ? undefined : b.total;
    } else if (platform === 'qq') {
      b = await this.call(
        platform,
        kind === 'lists' ? 'getUserPlaylists' : 'songListDetail',
        kind === 'lists' ? { uin: uid, limit: n, offset } : { disstid: id, song_begin: offset, song_num: n },
        signal,
      );
      rows = first(
        b,
        kind === 'lists'
          ? ['playlists', 'data.playlists', 'data.list', 'list']
          : ['songlist', 'cdlist.0.songlist', 'data.songlist'],
        null,
      );
      total = first(b, ['total', 'total_song_num', 'cdlist.0.total_song_num'], null);
    } else {
      await this.device(signal);
      b = await this.call(
        platform,
        kind === 'lists' ? 'user_playlist' : 'playlist_track_all',
        kind === 'lists' ? { userid: uid, page, pagesize: n } : { id, page, pagesize: n },
        signal,
      );
      rows = first(b, kind === 'lists' ? ['data.info', 'data.list'] : ['data.songs', 'data.info', 'data.list'], null);
      total = first(b, ['data.total', 'data.count'], null);
    }
    if (!Array.isArray(rows)) throw Error('Incomplete playlist response');
    return {
      rows:
        kind === 'songs'
          ? rows.map((r) => song(r, platform))
          : rows
              .map((r) => ({
                id: String(
                  first(
                    r,
                    platform === 'kugou'
                      ? ['gid', 'global_collection_id', 'globalCollectionId', 'id', 'specialid', 'listid']
                      : ['id', 'tid', 'dissid', 'disstid', 'listid'],
                  ),
                ),
                name: clean(first(r, ['name', 'dissname', 'specialname', 'title'])),
              }))
              .filter((r) => r.id && r.name),
      more: b.more === true || rows.length >= n,
      total: total === undefined || total === null ? null : Number(total),
    };
  }
  async resolve(track, quality, signal) {
    const levels = { standard: 'standard', high: 'exhigh', lossless: 'lossless', hires: 'hires' };
    if (!levels[quality]) throw Error('Unknown quality');
    let b, row;
    if (track.platform === 'netease') {
      b = await this.call('netease', 'song_url_v1', { id: track.id, level: levels[quality] }, signal);
      row = b.data?.[0];
    } else if (track.platform === 'qq') {
      b = await this.call(
        'qq',
        'getMusicPlay',
        {
          songmid: track.id,
          quality: { standard: '128', high: '320', lossless: 'flac', hires: 'hires' }[quality],
          mediaId: track.mediaId,
        },
        signal,
      );
      row = b.playUrl?.[track.id] || b.data?.playUrl?.[track.id] || b.data || b;
    } else {
      await this.device(signal);
      b = await this.call(
        'kugou',
        'song_url',
        {
          hash: track.id,
          album_id: track.albumId,
          album_audio_id: track.albumAudioId,
          quality: { standard: '128', high: '320', lossless: 'flac', hires: 'high' }[quality],
          free_part: 0,
        },
        signal,
      );
      row = b.data || b;
    }
    const value = first(row, ['url.0', 'url', 'backup_url.0']);
    if (!value) throw Error('No audio is available for this account, quality or region');
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw Error('No downloadable audio');
    if (row.freeTrialInfo || row.trial || row.isFreePart || row.is_free_part || row.free_part === 1)
      throw Error('Only a preview is available');
    return { url: url.href };
  }
  async lyrics(track, signal) {
    let b;
    if (track.platform === 'netease') {
      b = await this.call('netease', 'lyric', { id: track.id }, signal);
      return { original: b.lrc?.lyric || '', translation: b.tlyric?.lyric || '' };
    }
    if (track.platform === 'qq') {
      b = await this.call('qq', 'getLyric', { songmid: track.id, isFormat: false }, signal);
      const decode = (s) =>
        !s || s.includes('[') || s.includes('\n') ? s || '' : Buffer.from(s, 'base64').toString('utf8');
      return {
        original: decode(first(b, ['lyric', 'data.lyric'])),
        translation: decode(first(b, ['trans', 'translyric', 'data.trans'])),
      };
    }
    b = await this.call(
      'kugou',
      'search_lyric',
      {
        hash: track.id,
        keywords: `${track.title} ${track.artist}`,
        duration: Math.round(track.duration * 1000),
        man: 'yes',
      },
      signal,
    );
    const candidate = b.candidates?.[0] || b.data?.candidates?.[0];
    if (!candidate) throw Error('No lyrics available');
    const result = await this.call(
      'kugou',
      'lyric',
      { id: candidate.id, accesskey: candidate.accesskey, fmt: 'lrc', decode: true },
      signal,
    );
    return { original: first(result, ['decodeContent', 'lyric', 'content']), translation: '' };
  }
}
module.exports = { Platforms, PLATFORMS, song, sdk };
