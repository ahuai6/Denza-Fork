const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Secrets never leave the main process. Refuse plaintext storage when the OS keyring is unavailable.
class OnlineStore {
  constructor(file, crypto) {
    this.file = file;
    this.crypto = crypto;
    this.data = { accounts: {}, provider: {}, jobs: [], folder: '', device: {} };
    this.saving = Promise.resolve();
  }
  async load() {
    try {
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!value || !value.accounts || !Array.isArray(value.jobs)) throw Error('Invalid online data');
      this.data = { ...this.data, ...value };
    } catch (e) {
      if (e.code !== 'ENOENT') throw Error('Cannot read online data; the original file has been preserved.');
    }
  }
  save() {
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
    return this.saving;
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
    this.data.accounts[platform] = { ...account, secret: this.seal(account.cookie) };
    delete this.data.accounts[platform].cookie;
    await this.save();
  }
  credential(platform) {
    const a = this.data.accounts[platform];
    return a ? { ...a, cookie: this.open(a.secret) } : { uid: '', cookie: '' };
  }
}
module.exports = { OnlineStore };
