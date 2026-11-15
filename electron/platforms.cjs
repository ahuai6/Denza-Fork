const { randomUUID } = require('node:crypto');
const { sdk, unwrap } = require('./online/sdk-transport.cjs');
const { createProviders, catalog } = require('./online/providers/index.cjs');
const { cookies, joinCookies, song } = require('./online/providers/helpers.cjs');
const PLATFORMS = catalog.map((info) => info.id);

// The application-facing contract. Provider response shapes and SDK method names stay behind this boundary.
class Platforms {
  constructor(store, invoke = sdk, apple = null, services = {}) {
    this.store = store;
    this.services = services;
    this.invoke = invoke;
    this.sessions = new Map();
    this.providers = createProviders(
      (platform) => ({
        call: (method, params, signal, override) => this.call(platform, method, params, signal, override),
        getDevice: () => store.data.device,
        setDevice: async (device) => {
          store.data.device = device;
          await store.save();
        },
      }),
      apple,
      services,
    );
  }
  provider(platform) {
    const provider = this.providers.get(platform);
    if (!provider) throw Error('Unknown music platform');
    return provider;
  }
  info(platform) {
    return this.provider(platform).info;
  }
  async call(platform, method, params = {}, signal, override) {
    const provider = this.provider(platform);
    if (!provider.query) throw Error('Platform does not use the SDK transport');
    const credential = override || this.store.credential(platform);
    return unwrap(await this.invoke(platform, method, provider.query(method, params, credential), signal));
  }
  async search(platform, query, page = 1, signal) {
    if (typeof query !== 'string' || query.length > 200 || !Number.isInteger(page) || page < 1 || page > 100)
      throw Error('Invalid search');
    return this.provider(platform).search(query, page, signal);
  }
  async account(platform, cookie, uid = '') {
    const provider = this.provider(platform);
    if (!provider.info.credentialImport) return provider.verify();
    if (typeof cookie !== 'string' || !cookie.trim() || cookie.length > 50000)
      throw Error('Invalid account credentials');
    const c = cookies(cookie);
    uid = String(uid || c.userid || c.uin || c.wxuin || '').replace(/^o/, '');
    const account = await provider.verify(cookie, uid);
    if (!account.uid || !account.name) throw Error('Cannot verify this account; check login and user ID');
    await this.store.setAccount(platform, { ...account, cookie: joinCookies(account.cookie) });
    return this.store.accounts();
  }
  async login(platform, action, id) {
    const provider = this.provider(platform);
    if (provider.login) return provider.login(action);
    if (action === 'cancel') {
      this.sessions.delete(id);
      return { done: false };
    }
    for (const [key, value] of this.sessions) if (Date.now() - value.created > 180000) this.sessions.delete(key);
    if (action === 'create') {
      if (this.sessions.size >= 6) throw Error('Too many login requests');
      const state = await provider.createLogin();
      if (!state.image || !/^data:image\//.test(state.image)) throw Error('Invalid QR image');
      const sessionId = randomUUID();
      this.sessions.set(sessionId, { ...state, platform, created: Date.now() });
      return { sessionId, image: state.image, done: false };
    }
    if (action !== 'poll') throw Error('Invalid login action');
    const state = this.sessions.get(id);
    if (!state || state.platform !== platform) throw Error('Login expired');
    const value = await provider.pollLogin(state);
    if (!value?.cookie) return { done: false };
    await this.account(platform, value.cookie, value.uid);
    this.sessions.delete(id);
    return { done: true };
  }
  async logout(platform) {
    const provider = this.provider(platform);
    if (provider.logout) return provider.logout();
    delete this.store.data.accounts[platform];
    for (const [id, state] of this.sessions) if (state.platform === platform) this.sessions.delete(id);
    await this.store.save();
    return this.store.accounts();
  }
  async page(platform, kind, id, page, signal) {
    const provider = this.provider(platform),
      uid = this.store.credential(platform).uid;
    if (!uid) throw Error('Sign in first');
    return provider.page(kind, id, page, signal, uid);
  }
  async resolve(track, quality, signal, alternate = false) {
    if (!['standard', 'high', 'lossless', 'hires'].includes(quality)) throw Error('Unknown quality');
    if (alternate) {
      if (!this.services.fallback) throw Error('No alternate audio service');
      return this.services.fallback(track, quality, signal, Array.isArray(alternate) ? alternate : []);
    }
    try {
      const result = await this.provider(track.platform).resolve(track, quality, signal);
      return {
        canFallback: track.platform !== 'apple' && !!this.services.fallback,
        ...result,
        source: result.source || this.info(track.platform).label,
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (track.platform === 'apple' || !this.services.fallback) throw error;
      return this.services.fallback(track, quality, signal);
    }
  }
  async lookup(platform, input, signal) {
    const provider = this.provider(platform);
    if (!provider.lookup) throw Error('Link lookup unavailable');
    return provider.lookup(input, signal);
  }
  async lyrics(track, signal) {
    return this.provider(track.platform).lyrics(track, signal);
  }
  async open(song, playlist) {
    const provider = this.provider(song?.platform || playlist?.platform);
    if (!provider.info.remotePlayback || !provider.open) throw Error('Remote playback unavailable');
    return provider.open(song, playlist?.id);
  }
}
module.exports = { Platforms, PLATFORMS, song, sdk };
