const BASE = 'https://api.trylyricsflow.com';
const FORMATS = { standard: 'mp3', high: 'aac', lossless: 'flac', hires: 'alac' };
// Only constructs the documented public file request. Account authentication remains entirely with Apple Music.
class LyricsFlowAudio {
  constructor(baseURL = BASE) {
    const url = new URL(baseURL);
    if (
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw Error('Invalid audio service address');
    this.baseURL = url.href.replace(/\/$/, '');
  }
  resolve(track, quality) {
    const id = track.catalogId || (/^\d+$/.test(track.id || '') ? track.id : '');
    if (!/^\d+$/.test(id)) throw Error('This library song has no Apple Music catalog ID');
    const format = FORMATS[quality];
    if (!format) throw Error('Unknown audio format');
    const converted = format === 'mp3' || format === 'flac';
    const url = new URL(this.baseURL + (converted ? '/download/' + format : '/download'));
    url.searchParams.set('song', id);
    url.searchParams.set('mode', converted ? 'apple' : 'gamdl');
    if (!converted) {
      url.searchParams.set('codec', format);
      url.searchParams.set('fallback', 'false');
      if (/^[a-z]{2}$/.test(track.storefront || '')) url.searchParams.set('storefront', track.storefront);
    }
    return { url: url.href, transport: 'http-file', headerTimeoutMs: 180000, expectedFormat: format };
  }
}
module.exports = { LyricsFlowAudio, FORMATS };
