const { first, searchResult, pageResult, downloadResult } = require('./helpers.cjs');
module.exports = ({ call }) => ({
  query: (method, params, credential) =>
    ['getUserPlaylists', 'getUserDetail'].includes(method)
      ? { ...params, cookie: credential.cookie }
      : {
          params,
          option: { timeout: 18000, headers: credential.cookie ? { Cookie: credential.cookie } : {} },
          isFormat: false,
        },
  async search(query, page, signal) {
    const b = await call('getSearchByKey', { key: query, t: 0, n: 30, p: page }, signal);
    return searchResult(first(b, ['data.song.list', 'song.list', 'body.song.list'], []), 'qq');
  },
  async verify(cookie, uid) {
    const b = await call('getUserDetail', { uin: uid, userid: uid }, undefined, { cookie, uid });
    const profile = b.data || b;
    return {
      uid: String(uid || profile?.userid || ''),
      name: first(profile, ['nickname', 'user_name', 'nick_name', 'creator.nick']),
      cookie,
    };
  },
  async createLogin() {
    const b = await call('getQQLoginQr');
    return { qrsig: b.qrsig, ptqrtoken: b.ptqrtoken, image: b.img };
  },
  async pollLogin(state) {
    const b = await call('checkQQLoginQr', { qrsig: state.qrsig, ptqrtoken: state.ptqrtoken });
    if (b.refresh) throw Error('Login expired');
    return b.isOk && b.session?.cookie ? { cookie: b.session.cookie, uid: b.data?.userid } : null;
  },
  async page(kind, id, page, signal, uid) {
    const offset = (page - 1) * 100;
    const b = await call(
      kind === 'lists' ? 'getUserPlaylists' : 'songListDetail',
      kind === 'lists' ? { uin: uid, limit: 100, offset } : { disstid: id, song_begin: offset, song_num: 100 },
      signal,
    );
    const rows = first(
      b,
      kind === 'lists'
        ? ['playlists', 'data.playlists', 'data.list', 'list']
        : ['songlist', 'cdlist.0.songlist', 'data.songlist'],
      null,
    );
    return pageResult(rows, kind, 'qq', b, first(b, ['total', 'total_song_num', 'cdlist.0.total_song_num'], null));
  },
  async resolve(track, quality, signal) {
    const b = await call(
      'getMusicPlay',
      {
        songmid: track.id,
        quality: { standard: '128', high: '320', lossless: 'flac', hires: 'hires' }[quality],
        mediaId: track.mediaId,
      },
      signal,
    );
    return downloadResult(b.playUrl?.[track.id] || b.data?.playUrl?.[track.id] || b.data || b);
  },
  async lyrics(track, signal) {
    const b = await call('getLyric', { songmid: track.id, isFormat: false }, signal);
    const decode = (s) =>
      !s || s.includes('[') || s.includes('\n') ? s || '' : Buffer.from(s, 'base64').toString('utf8');
    return {
      original: decode(first(b, ['lyric', 'data.lyric'])),
      translation: decode(first(b, ['trans', 'translyric', 'data.trans'])),
    };
  },
});
