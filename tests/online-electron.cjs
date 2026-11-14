// Real main/preload/library integration, with a clean synthetic library and no user credentials.
const { _electron: electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'denza-main-'));
  fs.mkdirSync(path.join(profile, 'library'));
  fs.writeFileSync(
    path.join(profile, 'settings.json'),
    JSON.stringify({ lang: 'zh-Hans', rhythmEngine: 'dsp', theme: 'dark' }),
  );
  fs.writeFileSync(
    path.join(profile, 'library/db.json'),
    JSON.stringify({
      version: 1,
      folders: [path.join(__dirname, '.cache/lib')],
      tracks: {},
      favorites: [],
      playlists: [
        {
          id: 'apple-fixture',
          name: 'Apple fixture',
          created: 1,
          tracks: [],
          remote: {
            platform: 'apple',
            uid: 'fixture-user',
            id: 'p.fixture',
            updated: 1,
            songs: [
              {
                platform: 'apple',
                id: 'i.fixture',
                catalogId: '123',
                storefront: 'us',
                title: 'Apple fixture',
                artist: 'Artist',
                album: '',
                duration: 180,
              },
            ],
          },
        },
      ],
      overrides: {},
    }),
  );
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [ROOT, '--no-sandbox'],
    env: { ...process.env, CADENZA_USER_DATA: profile },
  });
  try {
    const page = await app.firstWindow();
    const errors = [],
      missing = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', (r) => {
      if (r.status() === 404) missing.push(r.url());
    });
    await page.waitForFunction(() => window.__cadenza?.lib.get().tracks.filter((t) => !t.protected).length === 3);
    const state = await page.evaluate(() => window.cadenzaOnline.request('state'));
    assert.deepEqual(state.accounts, []);
    assert.deepEqual(state.jobs, []);
    assert.equal(
      await page.evaluate(() =>
        window.cadenzaOnline.request('arbitrary-file-read', { path: '/etc/passwd' }).then(
          () => false,
          () => true,
        ),
      ),
      true,
    );
    await page.evaluate(() =>
      window.cadenzaOnline.request('setProvider', { kind: 'codex', protocol: 'responses', baseURL: '', model: '' }),
    );
    const models = await page.evaluate(() => window.cadenzaOnline.request('models'));
    assert(models.length > 0);
    assert.equal(
      await page.evaluate(() => window.cadenzaOnline.request('codex', { action: 'status' }).then((s) => s.connected)),
      false,
    );
    console.log('pass real IPC, clean online state, restricted operation and bundled Codex runtime/model list');
    await app.evaluate(({ shell }) => {
      const previous = shell.openExternal;
      const opened = [];
      shell.openExternal = async (url) => {
        opened.push(url);
      };
      global.__appleTest = {
        opened,
        restore: () => {
          shell.openExternal = previous;
        },
      };
    });
    try {
      const lists = await page.evaluate(() => window.cadenzaLib.get());
      const apple = lists.playlists.find((list) => list.remote?.platform === 'apple');
      await page.evaluate((playlistId) => window.cadenzaOnline.request('appleOpen', { playlistId }), apple.id);
      await page.evaluate(() => window.cadenzaOnline.request('openRemote', { key: 'apple:i.fixture' }));
      assert.deepEqual(await app.evaluate(() => global.__appleTest.opened), [
        'https://music.apple.com/us/library/playlist/p.fixture',
        'https://music.apple.com/us/song/123',
      ]);
      assert.equal(
        await page.evaluate(() =>
          window.cadenzaOnline.request('enqueue', { keys: ['apple:i.fixture'], quality: 'lossless' }).then(
            () => false,
            (error) => error.message.includes('folder'),
          ),
        ),
        true,
      );
      console.log('pass Apple playlist IPC and official links; downloads require a chosen folder');
    } finally {
      await app.evaluate(() => {
        global.__appleTest.restore();
        delete global.__appleTest;
      });
    }
    await page.evaluate(async () => {
      const c = window.__cadenza;
      const id = c.lib.get().tracks.find((t) => !t.protected && t.lrc).id;
      await c.api.playIds([id], 0, { play: false });
    });
    await page.locator('[data-page="workshop"]').click();
    await page.waitForFunction(() => window.__cadenza.workshop.get().session);
    await page.evaluate(() => window.__cadenza.wsEngine.play());
    await page.waitForFunction(() => window.__cadenza.wsEngine.time > 0.5);
    const before = await page.evaluate(() => window.__cadenza.player.get().shownId);
    await page.locator('[data-page="library"]').click();
    await page.waitForFunction(() => !window.__cadenza.wsEngine.isPlaying, { timeout: 10000 });
    assert.equal(await page.evaluate(() => window.__cadenza.player.get().shownId), before);
    console.log('pass leaving the workshop stops its own engine and preserves the player song');
    assert.deepEqual(errors, []);
    console.log('resource404:', JSON.stringify(missing));
  } finally {
    await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
