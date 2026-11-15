const { createHash } = require('node:crypto');
const ORIGIN = 'https://music.apple.com';
const API = 'https://amp-api.music.apple.com';
const METADATA_LANGUAGE = 'zh-Hans-CN';
const PARTITION = 'persist:denza-apple-music';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Electron's fetch cannot expose manual redirects. Follow them explicitly without forwarding tokens to another host.
function appleFetch(net, url, options) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'manual', credentials: 'omit' });
    let redirects = 0,
      settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      if (error) {
        req.abort();
        reject(error);
      } else resolve(value);
    };
    const abort = () => finish(Error('Apple Music request cancelled'));
    options.signal?.addEventListener('abort', abort, { once: true });
    for (const [key, value] of Object.entries(options.headers || {})) req.setHeader(key, value);
    req.on('redirect', (_status, _method, target) => {
      const next = new URL(target);
      if (++redirects > 5 || next.origin !== new URL(url).origin || next.username || next.password)
        return finish(Error('Apple Music redirect rejected'));
      req.followRedirect();
    });
    req.on('error', (error) => finish(error));
    req.on('response', (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > 20 * 1024 * 1024) return finish(Error('Apple Music response is too large'));
        chunks.push(chunk);
      });
      response.on('error', (error) => finish(error));
      response.on('aborted', () => finish(Error('Apple Music response interrupted')));
      response.on('end', () => {
        if (settled) return;
        try {
          const body = [204, 205, 304].includes(response.statusCode) ? null : Buffer.concat(chunks);
          finish(null, new Response(body, { status: response.statusCode }));
        } catch (error) {
          finish(error);
        }
      });
    });
    if (options.signal?.aborted) abort();
    else req.end();
  });
}

// Account/catalog behavior is adapted from the user's LyricsFlow 1.3.0. Playback remains Apple-hosted.
function appleSong(item, storefront) {
  const a = { ...item.attributes, ...item.relationships?.catalog?.data?.[0]?.attributes };
  const catalog =
    item.relationships?.catalog?.data?.[0]?.id ||
    a.playParams?.catalogId ||
    (item.type === 'songs' ? item.id : a.playParams?.id);
  return {
    platform: 'apple',
    artworkUrl: String(a.artwork?.url || '')
      .replace(/\{[wh]\}/g, '500')
      .replace('{f}', 'jpg')
      .replace('{c}', 'bb'),
    id: String(item.id || ''),
    catalogId: /^\d+$/.test(String(catalog)) ? String(catalog) : '',
    title: a.name || '',
    artist: a.artistName || '',
    album: a.albumName || '',
    duration: (a.durationInMillis || 0) / 1000,
    storefront,
  };
}
function applePage(value, root) {
  if (typeof value !== 'string') throw Error('Incomplete Apple Music pagination');
  const u = new URL(value, API);
  if (u.origin !== API || u.pathname !== root || u.username || u.password || u.hash)
    throw Error('Invalid Apple Music pagination');
  return u.pathname + u.search;
}
function appleNavigation(value) {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      (u.hostname === 'music.apple.com' ||
        u.hostname === 'appleid.apple.com' ||
        u.hostname === 'idmsa.apple.com' ||
        u.hostname === 'account.apple.com')
    );
  } catch {
    return false;
  }
}
class AppleMusic {
  constructor(store, notify = () => {}, transport = fetch, desktop = () => require('electron')) {
    Object.assign(this, { store, notify, transport, desktop });
    this.tokens = [];
    this.cursors = new Map();
    this.window = null;
    this.popupWindows = new Set();
    this.revision = 0;
    this.epoch = 0;
    this.lifetime = new AbortController();
  }
  async text(url, headers = {}, signal) {
    const r = await this.transport(url, {
      headers: { 'User-Agent': UA, ...headers },
      redirect: 'error',
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
    });
    if (!r.ok) throw Error('Apple Music HTTP ' + r.status);
    const max = 20 * 1024 * 1024;
    if (Number(r.headers.get('content-length')) > max) throw Error('Apple Music response is too large');
    const reader = r.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > max) throw Error('Apple Music response is too large');
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  async developerTokens(signal) {
    if (this.tokens.some((t) => t.exp > Date.now() / 1000 + 120)) return this.tokens;
    const page = await this.text(ORIGIN + '/us/browse', {}, signal);
    const bundle = page.match(/\/assets\/index~[A-Za-z0-9_-]+\.js/);
    if (!bundle) throw Error('Apple Music web player changed; sign-in cannot be verified');
    const code = await this.text(ORIGIN + bundle[0], {}, signal);
    const tokens = [];
    for (const token of new Set(
      code.match(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/g) || [],
    )) {
      try {
        const [h, p] = token
          .split('.')
          .slice(0, 2)
          .map((part) => JSON.parse(Buffer.from(part, 'base64url').toString()));
        if (h.alg === 'ES256' && p.exp > Date.now() / 1000 + 120) tokens.push({ token, exp: p.exp, kid: h.kid });
      } catch {
        /* Ignore unrelated bundle strings. */
      }
    }
    tokens.sort((a, b) => Number(b.kid === 'WebPlayKid') - Number(a.kid === 'WebPlayKid'));
    this.tokens = tokens.slice(0, 8);
    if (!this.tokens.length) throw Error('No current Apple Music web token');
    return this.tokens;
  }
  async api(path, signal, credential, retry = true) {
    if (!path.startsWith('/v1/')) throw Error('Invalid Apple Music API path');
    signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(90000), ...(signal ? [signal] : [])]);
    const tokens = await this.developerTokens(signal);
    const localized = new URL(API + path);
    localized.searchParams.set('l', METADATA_LANGUAGE);
    const user = credential ?? this.store.credential('apple').cookie;
    for (const token of tokens) {
      try {
        return JSON.parse(
          await this.text(
            localized.href,
            {
              Authorization: 'Bearer ' + token.token,
              Origin: ORIGIN,
              'Accept-Language': 'zh-CN,zh;q=0.9',
              ...(user ? { 'Music-User-Token': user } : {}),
            },
            signal,
          ),
        );
      } catch (e) {
        if (!/^Apple Music HTTP (401|403)$/.test(e.message)) throw e;
      }
    }
    if (retry) {
      this.tokens = [];
      return this.api(path, signal, credential, false);
    }
    throw Error('Apple Music session expired; sign in again');
  }
  async verify(token, revision) {
    const data = await this.api('/v1/me/storefront', undefined, token);
    const storefront = data.data?.[0]?.id;
    if (!/^[a-z]{2}$/.test(storefront || '')) throw Error('Cannot verify Apple Music account');
    if (revision !== this.revision) throw Error('Apple Music sign-in cancelled');
    const uid = createHash('sha256').update(token).digest('hex').slice(0, 24);
    await this.store.setAccount('apple', {
      uid,
      name: 'Apple Music · ' + storefront.toUpperCase(),
      cookie: token,
      storefront,
    });
    this.cursors.clear();
    this.notify();
    return { done: true };
  }
  session() {
    return this.desktop().session.fromPartition(PARTITION);
  }
  async check() {
    if (this.checking) return this.checking;
    const revision = this.revision;
    this.checking = (async () => {
      const entries = await this.session().cookies.get({ url: ORIGIN, name: 'media-user-token' });
      const token = entries.find((c) => c.value.length > 20)?.value;
      if (!token) return { done: false, sessionId: 'apple-window' };
      if (this.store.credential('apple').cookie === token) return { done: true };
      return this.verify(token, revision);
    })().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }
  async login(action) {
    if (action === 'cancel') {
      this.revision++;
      this.closeWindows();
      return { done: false };
    }
    if (action === 'poll') return this.check();
    if (action !== 'create') throw Error('Invalid Apple Music sign-in action');
    this.revision++;
    await this.open(ORIGIN + '/us/browse');
    return { done: false, sessionId: 'apple-window' };
  }
  async open(url) {
    if (!appleNavigation(url)) throw Error('Invalid Apple Music page');
    if (this.window && !this.window.isDestroyed()) {
      await this.window.loadURL(url);
      this.window.focus();
      return true;
    }
    const { BrowserWindow } = this.desktop();
    this.session().setUserAgent(UA);
    const win = new BrowserWindow({
      width: 1060,
      height: 780,
      title: 'Apple Music',
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    this.window = win;
    const guard = (contents) => {
      contents.on('will-navigate', (event, target) => {
        if (!appleNavigation(target)) event.preventDefault();
      });
      contents.on('will-redirect', (event, target) => {
        if (!appleNavigation(target)) event.preventDefault();
      });
      contents.setWindowOpenHandler(({ url: target }) =>
        appleNavigation(target)
          ? {
              action: 'allow',
              overrideBrowserWindowOptions: {
                autoHideMenuBar: true,
                webPreferences: { partition: PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true },
              },
            }
          : { action: 'deny' },
      );
      contents.on('did-create-window', (child) => {
        this.popupWindows.add(child);
        child.on('closed', () => this.popupWindows.delete(child));
        guard(child.webContents);
      });
    };
    guard(win.webContents);
    win.on('closed', () => {
      if (this.window === win) this.window = null;
    });
    try {
      await win.loadURL(url);
    } catch {
      win.destroy();
      throw Error('Apple Music page could not be opened');
    }
    return true;
  }
  async logout() {
    this.revision++;
    this.epoch++;
    this.closeWindows();
    await this.checking?.catch(() => {});
    await this.session().clearStorageData();
    delete this.store.data.accounts.apple;
    this.cursors.clear();
    await this.store.save();
    this.notify();
    return this.store.accounts();
  }
  async search(query, page, signal) {
    const storefront = this.store.credential('apple').storefront || 'us';
    const r = await this.api(
      `/v1/catalog/${storefront}/search?types=songs&limit=30&offset=${(page - 1) * 30}&term=${encodeURIComponent(query)}`,
      signal,
      '',
    );
    const rows = r.results?.songs?.data ?? (r.results && !r.results.songs ? [] : null);
    if (!Array.isArray(rows)) throw Error('Incomplete Apple Music search');
    return rows.map((row) => appleSong(row, storefront));
  }
  // Link expansion uses the public file service for IDs, but metadata uses Apple's localized catalog.
  async localizeSongs(tracks, signal) {
    const groups = new Map();
    for (const track of tracks) {
      if (!/^\d+$/.test(track.catalogId || '')) continue;
      const sf = /^[a-z]{2}$/.test(track.storefront || '') ? track.storefront : 'us';
      if (!groups.has(sf)) groups.set(sf, new Set());
      groups.get(sf).add(track.catalogId);
    }
    const found = new Map();
    for (const [sf, keys] of groups) {
      const ids = [...keys];
      for (let offset = 0; offset < ids.length; offset += 100) {
        const result = await this.api(
          '/v1/catalog/' + sf + '/songs?ids=' + ids.slice(offset, offset + 100).join(','),
          signal,
          '',
        );
        if (!Array.isArray(result.data)) throw Error('Incomplete Apple Music metadata');
        for (const row of result.data) found.set(sf + ':' + row.id, appleSong(row, sf));
      }
    }
    return tracks.map((track) => {
      const metadata = found.get((track.storefront || 'us') + ':' + track.catalogId);
      return metadata
        ? {
            ...track,
            title: metadata.title || track.title,
            artist: metadata.artist || track.artist,
            album: metadata.album || track.album,
            artworkUrl: metadata.artworkUrl || track.artworkUrl,
          }
        : track;
    });
  }
  async page(kind, id, page, signal) {
    const account = this.store.credential('apple');
    if (!account.uid) throw Error('Sign in to Apple Music first');
    const epoch = this.epoch;
    const root = '/v1/me/library/playlists' + (kind === 'songs' ? '/' + encodeURIComponent(id) + '/tracks' : '');
    const key = account.uid + ':' + root;
    if (page === 1)
      this.cursors.set(key, new Map([[1, root + '?limit=100' + (kind === 'songs' ? '&include=catalog' : '')]]));
    while (this.cursors.size > 400) this.cursors.delete(this.cursors.keys().next().value);
    const cursors = this.cursors.get(key),
      next = cursors?.get(page);
    if (!next) throw Error('Apple Music playlist pagination expired');
    let r;
    try {
      r = await this.api(next, signal);
    } catch (error) {
      if (error.message !== 'Apple Music HTTP 400' || !next.includes('&include=catalog')) throw error;
      r = await this.api(next.replace('&include=catalog', ''), signal);
    }
    if (epoch !== this.epoch || account.uid !== this.store.credential('apple').uid)
      throw Error('Apple Music account changed');
    if (!Array.isArray(r.data)) throw Error('Incomplete Apple Music playlist');
    if (r.next) cursors.set(page + 1, applePage(r.next, root));
    return {
      rows:
        kind === 'songs'
          ? r.data.map((row) => appleSong(row, account.storefront))
          : r.data.map((row) => ({
              id: String(row.id || ''),
              name: row.attributes?.name || '',
              artworkUrl: String(row.attributes?.artwork?.url || '')
                .replace(/\{[wh]\}/g, '500')
                .replace('{f}', 'jpg')
                .replace('{c}', 'bb'),
            })),
      more: !!r.next,
      total: r.meta?.total ?? null,
    };
  }
  async play(track, playlist) {
    const storefront = track?.storefront || this.store.credential('apple').storefront || 'us';
    if (!/^[a-z]{2}$/.test(storefront)) throw Error('Invalid Apple Music storefront');
    let route;
    if (playlist) route = '/library/playlist/' + encodeURIComponent(playlist);
    else if (/^\d+$/.test(track?.catalogId || '')) route = '/song/' + track.catalogId;
    else route = '/library/songs';
    // The system browser supplies Apple's supported DRM playback environment; Electron has no bundled Widevine.
    await this.desktop().shell.openExternal(ORIGIN + '/' + storefront + route);
    return true;
  }
  closeWindows() {
    this.window?.destroy();
    this.window = null;
    for (const win of this.popupWindows) if (!win.isDestroyed()) win.destroy();
    this.popupWindows.clear();
  }
  close() {
    this.revision++;
    this.epoch++;
    this.lifetime.abort();
    this.closeWindows();
  }
}
module.exports = { AppleMusic, appleFetch, appleSong, applePage, appleNavigation, PARTITION, METADATA_LANGUAGE };
