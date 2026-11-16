const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Secrets never leave the main process. Refuse plaintext storage when the OS keyring is unavailable.
class OnlineStore {
  constructor(file, crypto) {
    this.file = file;
    this.crypto = crypto;
    this.data = {
      accounts: {},
      provider: {},
      jobs: [],
      folder: '',
      device: {},
      preferences: { qualities: {}, lyricsMode: 'both' },
      appleTokens: [],
    };
    this.saving = Promise.resolve();
    this.decrypted = new Map();
    this.saveTimer = null;
    this.pendingScheduled = null;
  }
  async load() {
    this.decrypted.clear();
    try {
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!value || !value.accounts || !Array.isArray(value.jobs)) throw Error('Invalid online data');
      this.data = {
        ...this.data,
        ...value,
        preferences: { qualities: {}, lyricsMode: 'both', ...value.preferences },
        appleTokens: Array.isArray(value.appleTokens) ? value.appleTokens : [],
      };
    } catch (e) {
      if (e.code !== 'ENOENT') throw Error('Cannot read online data; the original file has been preserved.');
    }
  }
  save() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const pendingResolve = this.pendingScheduled;
    this.pendingScheduled = null;
    const snapshot = JSON.stringify(this.data);
    this.saving = this.saving
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const temp = this.file + '.' + randomUUID();
        try {
          await fs.writeFile(temp, snapshot, { mode: 0o600, flag: 'wx' });
          await fs.rename(temp, this.file);
        } finally {
          await fs.rm(temp, { force: true });
        }
      });
    if (pendingResolve) {
      void this.saving.then(
        () => pendingResolve.resolve(),
        (err) => pendingResolve.reject(err),
      );
    }
    return this.saving;
  }
  scheduleSave(delayMs = 500) {
    if (!this.pendingScheduled) {
      let resolve, reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this.pendingScheduled = { promise, resolve, reject };
    }
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, delayMs);
    this.saveTimer.unref?.();
    return this.pendingScheduled.promise;
  }
  async flush() {
    if (this.saveTimer || this.pendingScheduled) {
      await this.save();
    } else {
      await this.saving.catch(() => {});
    }
  }
  clearCache() {
    this.decrypted.clear();
  }
  async close() {
    this.decrypted.clear();
    await this.flush();
  }
  seal(text) {
    if (!this.crypto.isEncryptionAvailable() || this.crypto.getSelectedStorageBackend?.() === 'basic_text')
      throw Error('System credential encryption is unavailable.');
    return this.crypto.encryptString(text).toString('base64');
  }
  open(text) {
    return text ? this.crypto.decryptString(Buffer.from(text, 'base64')) : '';
  }
  accounts() {
    return Object.entries(this.data.accounts).map(([platform, a]) => ({ platform, uid: a.uid, name: a.name }));
  }
  async setAccount(platform, account) {
    const secret = this.seal(account.cookie);
    const stored = { ...account, secret };
    delete stored.cookie;
    this.data.accounts[platform] = stored;
    this.decrypted.set(platform, { secret, cookie: account.cookie || '' });
    await this.save();
  }
  async deleteAccount(platform) {
    delete this.data.accounts[platform];
    this.decrypted.delete(platform);
    await this.save();
  }
  credential(platform) {
    const a = this.data.accounts[platform];
    if (!a) {
      this.decrypted.delete(platform);
      return { uid: '', cookie: '' };
    }
    const cached = this.decrypted.get(platform);
    if (cached && cached.secret === a.secret) return { ...a, cookie: cached.cookie };
    const cookie = this.open(a.secret);
    this.decrypted.set(platform, { secret: a.secret, cookie });
    return { ...a, cookie };
  }
}
module.exports = { OnlineStore };
