const { readJSON } = require('./json-client.cjs');
const { downloadResult } = require('./providers/helpers.cjs');
// Reference endpoints from Sonora; maintained here independently and never receive account credentials.
function createPublicResolver(fetcher) {
  return async (track, quality, signal) => {
    const kbps = { standard: 128, high: 320, lossless: 999, hires: 1999 }[quality];
    const sources = [];
    if (track.platform === 'netease')
      sources.push({
        name: 'JerryMusicAPI',
        url: 'https://music-api.jerrynis.com/api/song/url/v1',
        params: {
          id: track.id,
          level: { standard: 'standard', high: 'exhigh', lossless: 'lossless', hires: 'hires' }[quality],
        },
        kind: 'netease',
      });
    sources.push({
      name: 'Mxin',
      url: 'https://api.mxin.me/api/v1/music',
      params: { server: track.platform, type: 'url', id: track.id, bitrate: String(kbps) },
      kind: 'json',
    });
    sources.push({
      name: 'Sakurink',
      url: 'https://apivc-meting.sakurink.eu.org/registration/',
      params: { server: track.platform, type: 'url', id: track.id, br: String(kbps) },
      kind: 'redirect',
    });
    for (const source of sources) {
      signal?.throwIfAborted();
      const url = new URL(source.url);
      for (const [key, value] of Object.entries(source.params)) url.searchParams.set(key, value);
      try {
        if (source.kind === 'redirect') {
          const response = await fetcher(url.href, {
            credentials: 'omit',
            signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
          });
          await response.body?.cancel();
          if (!response.ok || response.url === url.href) throw Error('No audio redirect');
          return { ...downloadResult({ url: response.url }), source: source.name };
        }
        const body = await readJSON(fetcher, url.href, { signal });
        const row = source.kind === 'netease' ? body.data?.[0] : body.data?.result || body.data;
        if (row?.id && String(row.id) !== String(track.id)) throw Error('Different song returned');
        if (source.kind === 'netease' && row?.code && row.code !== 200) throw Error('No available audio');
        const result = downloadResult(row);
        return { ...result, source: source.name, bitrate: Number(row.br || row.bitrate) || 0 };
      } catch {
        signal?.throwIfAborted();
      }
    }
    throw Error('No audio available from the configured services at this quality');
  };
}
module.exports = { createPublicResolver };
