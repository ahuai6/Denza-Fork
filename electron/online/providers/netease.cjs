const QRCode = require('qrcode');
const { first, joinCookies, searchResult, pageResult, downloadResult } = require('./helpers.cjs');
module.exports = ({ call }) => ({
  query: (_method, params, credential) => ({ ...params, timestamp: Date.now(), cookie: credential.cookie }),
  async search(query, page, signal) {
    const b = await call('cloudsearch', { keywords: query, type: 1, limit: 30, offset: (page - 1) * 30 }, signal);
    return searchResult(b.result?.songs, 'netease');
  },
  async verify(cookie) {
    const b = await call('login_status', {}, undefined, { cookie });
    const profile = b.data?.profile || b.profile;
    return {
      uid: String(profile?.userId || ''),
      name: first(profile, ['nickname', 'user_name', 'nick_name', 'creator.nick']),
      cookie,
    };
  },
  async createLogin() {
    const b = await call('login_qr_key');
    const key = first(b, ['data.unikey', 'data.data.unikey', 'unikey']);
    if (!key) throw Error('Cannot create login QR code');
    return { key, image: await QRCode.toDataURL(`https://music.163.com/login?codekey=${key}`) };
  },
  async pollLogin(state) {
    const b = await call('login_qr_check', { key: state.key });
    if (b.code === 800) throw Error('Login expired');
    return b.code === 803 && b.cookie ? { cookie: joinCookies(b.cookie) } : null;
  },
  async page(kind, id, page, signal, uid) {
    const offset = (page - 1) * 100;
    const b = await call(
      kind === 'lists' ? 'user_playlist' : 'playlist_track_all',
      kind === 'lists' ? { uid, limit: 100, offset } : { id, limit: 100, offset },
      signal,
    );
    return pageResult(kind === 'lists' ? b.playlist : b.songs, kind, 'netease', b, kind === 'lists' ? null : b.total);
  },
  async resolve(track, quality, signal) {
    const level = { standard: 'standard', high: 'exhigh', lossless: 'lossless', hires: 'hires' }[quality];
    const b = await call('song_url_v1', { id: track.id, level }, signal);
    return downloadResult(b.data?.[0]);
  },
  async lyrics(track, signal) {
    const b = await call('lyric', { id: track.id }, signal);
    return { original: b.lrc?.lyric || '', translation: b.tlyric?.lyric || '' };
  },
});
