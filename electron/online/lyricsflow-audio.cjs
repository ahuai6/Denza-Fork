const { readJSON } = require('./json-client.cjs');
const { appleSong } = require('../apple-music.cjs');
const BASE = 'https://api.trylyricsflow.com';
const FORMATS = { standard: 'mp3', high: 'aac', lossless: 'flac', hires: 'alac' };
// Only constructs the documented public file request. Account authentication remains entirely with Apple Music.
class LyricsFlowAudio {
  constructor(baseURL = BASE, fetcher = fetch) {
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
    this.fetcher = fetcher;
    this.baseURL = url.href.replace(/\/$/, '');
  }
  async json(path, signal) {
    return readJSON(this.fetcher, this.baseURL + path, { signal });
  }
  async lookup(input, signal) {
    let id,
      storefront = 'us',
      kind = 'songs';
    const value = String(input || '').trim();
    if (/^\d+$/.test(value)) id = value;
    else {
      let url;
      try {
        url = new URL(value);
      } catch {
        throw Error('Paste an Apple Music song, album or public playlist link');
      }
      if (url.protocol !== 'https:' || url.hostname !== 'music.apple.com' || url.username || url.password)
        throw Error('Use a music.apple.com link');
      const parts = url.pathname.split('/').filter(Boolean);
      storefront = /^[a-z]{2}$/.test(parts[0]) ? parts[0] : 'us';
      id = url.searchParams.get('i');
      if (!id) {
        const type = parts.find((p) => ['song', 'album', 'playlist'].includes(p));
        id = parts.at(-1);
        kind = type === 'album' ? 'albums' : type === 'playlist' ? 'playlists' : 'songs';
      }
    }
    if (!(kind === 'playlists' ? /^pl\.[a-zA-Z0-9.-]+$/ : /^\d+$/).test(id || ''))
      throw Error('No supported catalog ID in this link');
    const body = await this.json('/' + kind + '/' + encodeURIComponent(id) + '?storefront=' + storefront, signal);
    const item = body.data?.[0] || body;
    const rows = kind === 'songs' ? [item] : item.relationships?.tracks?.data;
    if (!Array.isArray(rows) || !rows.length) throw Error('No tracks in the link');
    let next = kind === 'songs' ? null : item.relationships?.tracks?.next;
    const seen = new Set();
    while (next) {
      if (rows.length >= 2000 || seen.has(next)) throw Error('Incomplete or oversized linked collection');
      seen.add(next);
      const url = new URL(next, this.baseURL);
      if (url.origin !== new URL(this.baseURL).origin || !url.pathname.startsWith('/v1/catalog/' + storefront + '/'))
        throw Error('Unexpected linked collection page');
      const page = await this.json(url.pathname + url.search, signal);
      if (!Array.isArray(page.data) || !page.data.length) throw Error('Incomplete linked collection');
      rows.push(...page.data);
      next = page.next;
    }
    return rows.map((row) => ({
      ...appleSong(row, storefront),
      sourceURL: 'https://music.apple.com/' + storefront + '/song/' + row.id,
    }));
  }
  async lyrics(track, signal) {
    const id = track.catalogId || track.id;
    if (!/^\d+$/.test(id)) throw Error('No catalog ID for lyrics');
    const sf = /^[a-z]{2}$/.test(track.storefront || '') ? track.storefront : 'us';
    const unpack = (data) => {
      const value = data?.data && !Array.isArray(data.data) ? data.data : data;
      const original =
        typeof value === 'string'
          ? value
          : value?.syncedLyrics || value?.ttml || value?.lrc || value?.plainLyrics || '';
      if (typeof original !== 'string' || !original.trim()) throw Error('No lyrics returned by the music service');
      return { value, original };
    };
    let data;
    try {
      data = await this.json('/lyrics?song=' + encodeURIComponent(id) + '&storefront=' + sf, signal);
      unpack(data);
    } catch (error) {
      signal?.throwIfAborted();
      if (!track.title || !track.artist) throw error;
      const query = new URLSearchParams({
        title: track.title,
        artist: track.artist,
        album: track.album || '',
        duration_ms: String(Math.round((track.duration || 0) * 1000)),
        storefront: sf,
      });
      data = await this.json('/lyrics/by-metadata?' + query, signal);
    }
    const { value, original } = unpack(data);
    const { translationLines } = require('../generated/lyrics.cjs');
    const translation = translationLines(original)
      .filter((line) => line.translation)
      .map((line) => {
        const m = Math.floor(line.t / 60),
          s = (line.t - m * 60).toFixed(2).padStart(5, '0');
        return '[' + String(m).padStart(2, '0') + ':' + s + ']' + line.translation;
      })
      .join('\n');
    return {
      original,
      ttml: /<tt[\s>]/i.test(original) ? original : '',
      translation: translation || value.translation || '',
      source: 'LyricsFlow',
    };
  }
  resolve(track, quality) {
    const id = track.catalogId || (/^\d+$/.test(track.id || '') ? track.id : '');
    if (!/^\d+$/.test(id)) throw Error('This library song has no Apple Music catalog ID');
    const format = FORMATS[quality];
    if (!format) throw Error('Unknown audio format');
    const converted = format === 'mp3' || format === 'flac';
    const url = new URL(this.baseURL + (converted ? '/download/' + format : '/download'));
    url.searchParams.set(
      !converted && track.sourceURL ? 'url' : 'song',
      !converted && track.sourceURL ? 'https://music.apple.com/' + (track.storefront || 'us') + '/song/' + id : id,
    );
    url.searchParams.set('mode', converted ? 'apple' : 'gamdl');
    if (!converted) {
      url.searchParams.set('codec', format);
      url.searchParams.set('fallback', 'false');
      if (/^[a-z]{2}$/.test(track.storefront || '')) url.searchParams.set('storefront', track.storefront);
    }
    return {
      url: url.href,
      source: 'LyricsFlow',
      transport: 'http-file',
      headerTimeoutMs: 180000,
      expectedFormat: format,
      qualityByFormat: true,
    };
  }
}
module.exports = { LyricsFlowAudio, FORMATS };
