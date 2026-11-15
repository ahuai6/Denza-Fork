// Shared online contracts in the actual space room: no account credentials or real audio downloads.
const { chromium } = require('playwright');
const { bridge } = require('./online-desktop.cjs');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const shots = process.env.DENZA_SHOTS || fs.mkdtempSync('/tmp/denza-space-online-');
fs.mkdirSync(shots, { recursive: true });
(async () => {
  const { server, url } = await require('./serve.cjs')(path.resolve(__dirname, '../dist-app'));
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.route('https://fixture.invalid/artwork.jpg', (route) =>
      route.fulfill({ path: path.join(__dirname, 'fixtures/cover.jpg'), contentType: 'image/jpeg' }),
    );
    await page.addInitScript(bridge);
    await page.addInitScript((gfx) => {
      const settings = {
        ui: 'space',
        lang: 'zh-Hans',
        theme: 'dark',
        gfx,
        audioOut: 'standard',
        scanOnLaunch: false,
        rhythmEngine: 'dsp',
        fps: 20,
      };
      window.cadenzaDesktop.settings = async () => settings;
      window.cadenzaDesktop.setSettings = async (patch) => Object.assign(settings, patch);
      const original = window.cadenzaLib.get;
      window.cadenzaLib.get = async () => {
        const local = await original();
        return {
          ...local,
          playlists: [
            ...local.playlists,
            {
              id: 'space-remote',
              name: 'Room remote fixture',
              created: 1,
              tracks: [],
              remote: {
                platform: 'netease',
                uid: 'fixture-user',
                id: 'remote-list',
                updated: 1,
                artworkUrl: 'https://fixture.invalid/artwork.jpg',
                songs: [
                  {
                    platform: 'netease',
                    id: 'unmatched',
                    title: 'Unmatched room song',
                    artist: 'Fixture artist',
                    album: 'Fixture album',
                    duration: 180,
                    artworkUrl: 'https://fixture.invalid/artwork.jpg',
                    localId: null,
                  },
                ],
              },
            },
          ],
        };
      };
    }, process.env.DENZA_SPACE_GFX || 'lite');
    await page.goto(url + '/index.html');
    await page.waitForFunction(
      () => window.__cad?.go && document.querySelector('[data-test="space-online-control"]'),
      null,
      { timeout: 120000 },
    );
    const button = page
      .locator('[data-test="space-online-control"]')
      .getByRole('button', { name: '在线', exact: true });
    await button.waitFor();
    const box = await button.boundingBox();
    assert(box.x < 100 && box.y < 120);
    await page.evaluate(() => window.__cad.go('lists'));
    const source = page.locator('[data-test="space-playlist-source"]');
    await source.waitFor({ timeout: 120000 });
    assert.deepEqual(await page.evaluate(() => window.__cad.playlists().ids), ['local']);
    await source.getByRole('button', { name: '在线', exact: true }).click();
    await page.waitForFunction(() => window.__cad.playlists().source === 'online');
    assert.deepEqual(await page.evaluate(() => window.__cad.playlists().ids), ['space-remote']);
    await page.screenshot({ path: path.join(shots, 'space-online-room.png'), timeout: 120000 });
    await source.getByRole('button', { name: '本地', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__cad.playlists().ids), ['local']);
    await button.click();
    await page.getByRole('dialog', { name: '在线音乐', exact: true }).waitFor();
    const dialog = page.getByRole('dialog', { name: '在线音乐', exact: true });
    assert.equal(await dialog.evaluate((el) => el.classList.contains('card')), true);
    assert.equal(
      await dialog.evaluate((el) => getComputedStyle(el).backgroundColor),
      process.env.DENZA_SPACE_GFX === 'default' ? 'rgba(0, 0, 0, 0)' : 'rgba(60, 48, 36, 0.38)',
    );
    if (process.env.DENZA_SPACE_GFX === 'default') {
      await page.waitForFunction(() => document.querySelector('[role="dialog"]').dataset.sz, null, { timeout: 120000 });
    }
    assert.equal(
      await dialog
        .getByRole('textbox', { name: '搜索歌曲', exact: true })
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      'rgba(255, 255, 255, 0.12)',
    );
    await dialog.getByRole('combobox', { name: '全部平台', exact: true }).click();
    const listbox = dialog.getByRole('listbox');
    await listbox.waitFor();
    assert.equal(await listbox.evaluate((el) => el.classList.contains('card')), true);
    await dialog.getByRole('option', { name: 'QQ Music', exact: true }).click();
    await page.screenshot({ path: path.join(shots, 'space-online-slot.png'), timeout: 120000 });
    await page
      .getByRole('dialog', { name: '在线音乐', exact: true })
      .getByRole('button', { name: '关闭', exact: true })
      .click();
    await page.locator('#q').fill('Room remote fixture');
    await page.locator('#results button').filter({ hasText: 'Room remote fixture' }).click();
    assert.equal(await page.evaluate(() => window.__cad.playlists().source), 'online');
    assert.deepEqual(await page.evaluate(() => window.__cad.playlists().ids), ['space-remote']);
    const detail = page.locator('[data-test="space-detail"][data-remote="true"]');
    await detail.getByText('Unmatched room song', { exact: true }).waitFor({ timeout: 120000 });
    assert.equal(await detail.getByRole('button', { name: '播放本地歌曲', exact: true }).isDisabled(), true);
    await detail.getByRole('button', { name: '下载歌曲', exact: true }).click();
    assert.equal(
      await page.evaluate(() =>
        window.__onlineCalls.some((c) => c.op === 'enqueue' && c.args.keys.includes('netease:unmatched')),
      ),
      true,
    );
    await page.screenshot({ path: path.join(shots, 'space-remote-playlist.png'), timeout: 120000 });
    await detail.getByRole('combobox', { name: '期望音质', exact: true }).click();
    const remoteDropdown = page.getByRole('listbox');
    await remoteDropdown.waitFor();
    assert.equal(await remoteDropdown.evaluate((el) => el.classList.contains('card')), true);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__cad.go('gallery'));
    await source.waitFor({ state: 'hidden', timeout: 120000 });
    assert.deepEqual(errors, []);
    console.log('pass space online button is top-left and opens the shared panel');
    console.log(
      'pass room playlist opens in place and retains unmatched songs with original artwork and download actions',
    );
    console.log('Screenshots:', shots);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
