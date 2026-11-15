const { randomBytes } = require('node:crypto');
const QRCode = require('qrcode');
const { first, cookies, searchResult, pageResult, downloadResult } = require('./helpers.cjs');
module.exports = ({ call, getDevice, setDevice }) => {
  const publicIds = new Map();
  const device = async (signal) => {
    if (getDevice().dfid) return;
    await setDevice({
      KUGOU_API_MID: randomBytes(16).toString('hex'),
      KUGOU_API_GUID: randomBytes(16).toString('hex'),
      KUGOU_API_MAC: '00:00:00:00:00:00',
      KUGOU_API_DEV: 'Denza',
      ...getDevice(),
    });
    const b = await call('register_dev', {}, signal);
    await setDevice({ ...getDevice(), dfid: first(b, ['data.dfid', 'dfid']) });
  };
  return {
    query: (_method, params, credential) => ({
      ...params,
      timestamp: Date.now(),
      cookie: { ...getDevice(), ...cookies(credential.cookie) },
    }),
    async search(query, page, signal) {
      await device(signal);
      const b = await call('search', { keywords: query, type: 'song', page, pagesize: 30 }, signal);
      return searchResult(first(b, ['data.lists', 'data.info', 'data.list'], []), 'kugou');
    },
    async verify(cookie, uid) {
      const b = await call('user_detail', { uin: uid, userid: uid }, undefined, { cookie, uid });
      const profile = b.data || b;
      return {
        uid: String(uid || profile?.userid || ''),
        name: first(profile, ['nickname', 'user_name', 'nick_name', 'creator.nick']),
        cookie,
      };
    },
    async createLogin() {
      await device();
      const b = await call('login_qr_key');
      const key = first(b, ['data.qrcode', 'qrcode', 'data.key']);
      if (!key) throw Error('Cannot create login QR code');
      return {
        key,
        image: await QRCode.toDataURL(`https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=1005&qrcode=${key}`),
      };
    },
    async pollLogin(state) {
      const b = await call('login_qr_check', { key: state.key });
      if (b.data?.status === 0) throw Error('Login expired');
      return b.data?.status === 4 && b.data.token
        ? { cookie: `token=${b.data.token}; userid=${b.data.userid}`, uid: b.data.userid }
        : null;
    },
    async page(kind, id, page, signal, uid) {
      await device(signal);
      let b;
      if (kind === 'lists') b = await call('user_playlist', { userid: uid, page, pagesize: 100 }, signal);
      else {
        try {
          b = await call('playlist_track_all_new', { listid: id, userid: uid, page, pagesize: 100 }, signal);
        } catch (error) {
          signal?.throwIfAborted();
          const publicId = publicIds.get(id);
          if (!publicId) throw error;
          b = await call('playlist_track_all', { id: publicId, page, pagesize: 100 }, signal);
        }
      }
      const rows = first(
        b,
        kind === 'lists' ? ['data.info', 'data.list'] : ['data.songs', 'data.info', 'data.list', 'data.files'],
        null,
      );
      if (kind === 'lists' && Array.isArray(rows))
        for (const row of rows) {
          const local = String(first(row, ['listid', 'id']));
          const global = first(row, ['global_collection_id', 'globalCollectionId', 'gid']);
          if (local && global) publicIds.set(local, String(global));
        }
      return pageResult(rows, kind, 'kugou', b, first(b, ['data.total', 'data.count'], null), [
        'listid',
        'id',
        'gid',
        'global_collection_id',
        'globalCollectionId',
        'specialid',
      ]);
    },
    async resolve(track, quality, signal) {
      await device(signal);
      const b = await call(
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
      return downloadResult(b.data || b);
    },
    async lyrics(track, signal) {
      const b = await call(
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
      const r = await call(
        'lyric',
        { id: candidate.id, accesskey: candidate.accesskey, fmt: 'lrc', decode: true },
        signal,
      );
      return { original: first(r, ['decodeContent', 'lyric', 'content']), translation: '' };
    },
  };
};
