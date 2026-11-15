// Native owner retreat and modal input ownership, with synthetic songs and no account or file writes.
const { chromium } = require('playwright');
const { bridge } = require('./online-desktop.cjs');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const mode = process.env.DENZA_DIALOG_MODE || 'space';
const shots = process.env.DENZA_SHOTS || fs.mkdtempSync('/tmp/denza-dialog-');
fs.mkdirSync(shots, { recursive: true });
(async () => {
  const { server, url } = await require('./serve.cjs')(path.resolve(__dirname, '../dist-app'));
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 0.5 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.addInitScript(bridge);
    await page.addInitScript((mode) => {
      const settings = {
        ui: mode,
        lang: 'zh-Hans',
        theme: 'dark',
        gfx: 'lite',
        audioOut: 'standard',
        scanOnLaunch: false,
        rhythmEngine: 'dsp',
        fps: 5,
      };
      window.cadenzaDesktop.settings = async () => settings;
      window.cadenzaDesktop.setSettings = async (patch) => Object.assign(settings, patch);
    }, mode);
    await page.goto(url + '/index.html');
    await page.waitForFunction(() => window.__cadenza?.player && window.__cadenza.lib.get().loaded, null, {
      timeout: 120000,
    });
    await page.evaluate(() => {
      const c = window.__cadenza;
      c.lib.set({
        tracks: [
          {
            id: 'dialog-song',
            title: 'Dialog song',
            artist: 'Fixture artist',
            album: 'Fixture album',
            duration: 180,
            cover: null,
            genre: [],
            file: 'fixture.flac',
            folder: '/fixture',
            albumArtist: '',
            codec: 'FLAC',
            lossless: true,
            sampleRate: 48000,
            bits: 24,
          },
        ],
      });
      c.player.set({
        id: 'dialog-song',
        shownId: 'dialog-song',
        hasLyrics: true,
        lyrics: { source: 'lrc', text: '[00:01]Original fixture' },
      });
    });
    let owner;
    if (mode === 'space') {
      await page.waitForFunction(() => window.__cad?.go, null, { timeout: 120000 });
      await page.getByRole('button', { name: '歌词列表', exact: true }).click();
      owner = page.locator('[data-test="space-lyrics"]');
      await owner.locator('header button').first().click();
    } else {
      await page.locator('[data-page="workshop"]').click();
      await page.waitForFunction(() => window.__cadenza.workshop.get().session);
      await page.evaluate(async () => {
        const c = window.__cadenza,
          session = c.workshop.get().session;
        session.setLyrics('[00:01]Original fixture');
        await session.flush();
        c.player.set({ session });
        c.ui.set({ modal: { kind: 'np', tab: 'lyrics' } });
      });
      owner = page.locator('[data-test="modal"][data-kind="np"]');
    }
    const draft = '[00:01]Unsaved native draft\n[00:02]Reading fixture';
    await owner.locator('textarea').first().fill(draft);
    await owner.getByRole('button', { name: '翻译与匹配', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '翻译与匹配', exact: true });
    await dialog.waitFor();
    assert.equal(await owner.isVisible(), false);
    assert.equal(await page.getByRole('dialog').count(), 1);
    assert.equal(await page.evaluate(() => !!window.__cadenza.ui.get().dialog), true);
    assert.equal(
      await page.locator(mode === 'classic' ? '[data-top]' : '[data-test="space"]').evaluate((el) => el.inert),
      true,
    );
    if (mode === 'classic') assert.equal(await page.evaluate(() => window.__cadenza.ui.get().modal.kind), 'np');
    await dialog.getByRole('button', { name: '预览歌词', exact: true }).click();
    await dialog.getByRole('combobox').first().click();
    await dialog.getByRole('listbox').waitFor();
    await page.keyboard.press('Escape');
    await dialog.getByRole('listbox').waitFor({ state: 'hidden' });
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await owner.isVisible(), false);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await owner.waitFor({ state: 'visible' });
    assert.equal(await owner.locator('textarea').first().inputValue(), draft);
    assert.equal(await page.evaluate(() => window.__cadenza.ui.get().dialog), null);
    await page.waitForFunction(() => document.activeElement?.textContent.trim() === '翻译与匹配');
    assert.equal(await page.evaluate(() => window.__lyricWrites.length), 0);
    console.log(
      'pass native owner retracts; nested Escape closes the dropdown, then the dialog; cancel restores the draft',
    );

    await owner.getByRole('button', { name: '翻译与匹配', exact: true }).click();
    await dialog.waitFor();
    if (mode === 'classic') {
      await page.evaluate(() =>
        window.__cadenza.ui.set({
          modal: { kind: 'confirm', title: 'Native replacement', text: 'Fixture', yes: 'Confirm' },
        }),
      );
      await page.getByText('Native replacement', { exact: true }).waitFor();
    } else {
      await page.evaluate(() => window.__cadenza.player.set({ shownId: 'another-song' }));
    }
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.__cadenza.ui.get().dialog), null);
    console.log('pass native replacement or song change dismisses the child without leaving an orphan modal');
    if (mode === 'space') {
      await page.getByRole('button', { name: '播放队列', exact: true }).click();
      await page.locator('[data-test="space-queue"]').waitFor();
      await page.locator('[data-test="space-online-control"]').getByRole('button').click();
      await page.getByRole('dialog', { name: '在线音乐', exact: true }).waitFor();
      assert.equal(await page.locator('[data-test="space-queue"]').count(), 0);
      assert.equal(await page.locator('[data-test="space-lyrics"]').count(), 0);
      await page.screenshot({ path: path.join(shots, mode + '-dialog-owner.png'), timeout: 120000 });
      await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
      assert.equal(await page.locator('[data-test="space-queue"]').count(), 0);
      console.log('pass online uses the native primary-panel slot, replacing the queue and lyrics panel');
    } else {
      await page.screenshot({ path: path.join(shots, mode + '-dialog-owner.png'), timeout: 120000 });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
