const { decodeOnlineLyric, qrcLrc } = require('../qq-lyric-codec.cjs');
const { decodeText } = require('../lyric-formats.cjs');
const { first, searchResult, pageResult, downloadResult } = require('./helpers.cjs');
module.exports = ({ call, json }) => ({
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
    if (quality === 'hires') throw Error('Native QQ Hi-Res is unavailable');
    const b = await call(
      'getMusicPlay',
      {
        songmid: track.id,
        quality: { standard: '128', high: '320', lossless: 'flac', hires: 'flac' }[quality],
        mediaId: track.mediaId,
      },
      signal,
    );
    const row = b.playUrl?.[track.id] || b.data?.playUrl?.[track.id] || b.data || b;
    return {
      ...downloadResult(typeof row === 'string' ? { url: row } : row),
      headers: { Referer: 'https://y.qq.com/' },
    };
  },
  async lyrics(track, signal) {
    let decoded = {};
    if (json) {
      try {
        const body = await json('https://u.y.qq.com/cgi-bin/musicu.fcg', {
          method: 'POST',
          signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
          headers: { 'Content-Type': 'application/json', Referer: 'https://y.qq.com/' },
          body: JSON.stringify({
            comm: { ct: 24, cv: 0 },
            req_0: {
              module: 'music.musichallSong.PlayLyricInfo',
              method: 'GetPlayLyricInfo',
              param: {
                songMID: track.id,
                songID: Number(track.lyricId || 0),
                qrc: 0,
                trans: 1,
                roma: 1,
                crypt: 0,
                lrc_t: 0,
                qrc_t: 0,
                trans_t: 0,
                roma_t: 0,
              },
            },
          }),
        });
        const extra = body.req_0?.data;
        if (extra) {
          decoded = Object.fromEntries(
            ['lyric', 'trans', 'roma']
              .map((key) => [key, qrcLrc(decodeOnlineLyric(extra[key]))])
              .filter(([, value]) => value),
          );
        }
      } catch {
        signal?.throwIfAborted();
      }
    }
    let b = {};
    if (!decoded.lyric) {
      try {
        b = await call(
          'getLyric',
          { songmid: track.id, songid: track.lyricId, isFormat: false, trans: 1, roma: 1 },
          signal,
        );
      } catch (error) {
        signal?.throwIfAborted();
        if (!json) throw error;
      }
    }
    const merged = { ...b, ...decoded };
    return {
      original: decodeText(first(merged, ['lyric', 'data.lyric'])),
      translation: decodeText(first(merged, ['trans', 'translyric', 'data.trans'])),
      pronunciation: decodeText(first(merged, ['roma', 'romalrc', 'data.roma'])),
    };
  },
});
