// Deterministic UI contract checks. Providers and file writes are mocked; this does not verify real accounts or APIs.
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const shots = process.env.DENZA_SHOTS || fs.mkdtempSync('/tmp/denza-online-');
fs.mkdirSync(shots, { recursive: true });
function bridge() {
  const off = () => () => {};
  const local = {
    folders: [],
    tracks: [],
    favorites: [],
    playlists: [{ id: 'local', name: 'Local fixture list', tracks: [], created: 1 }],
  };
  const state = {
    accounts: [{ platform: 'netease', uid: 'fixture-user', name: 'Fixture account' }],
    folder: '/fixture/downloads',
    jobs: [],
  };
  const song = {
    platform: 'netease',
    id: 'remote-song',
    title: 'Fixture song',
    artist: 'Fixture artist',
    album: 'Fixture album',
    duration: 180,
  };
  let settings = {
    ui: 'classic',
    lang: 'zh-Hans',
    theme: 'dark',
    rhythmEngine: 'dsp',
    audioOut: 'standard',
    scanOnLaunch: false,
  };
  let changed = () => {},
    libraryChanged = () => {};
  window.__onlineCalls = [];
  window.cadenzaDesktop = {
    platform: 'linux',
    settings: async () => settings,
    setSettings: async (patch) => (settings = { ...settings, ...patch }),
    onWin: off,
    onMedia: off,
    win: async () => null,
    playing: async () => {},
  };
  window.cadenzaLib = {
    get: async () => local,
    onChanged: (f) => {
      libraryChanged = f;
      return () => {};
    },
    onProgress: off,
    onAnalysis: off,
    onWake: off,
    nextAnalysis: async () => null,
    unverified: async () => [],
    song: async () => null,
    lyrics: async () => null,
  };
  window.cadenzaOnline = {
    onChanged: (f) => {
      changed = f;
      return () => {};
    },
    request: async (op, args = {}) => {
      window.__onlineCalls.push({ op, args });
      if (op === 'state') return state;
      if (op === 'provider' || op === 'setProvider')
        return {
          kind: 'compatible',
          baseURL: 'http://localhost:1234/v1',
          protocol: 'chat',
          model: 'fixture',
          hasKey: false,
        };
      if (op === 'search')
        return {
          tracks: [
            {
              ...song,
              ...(args.platform === 'apple'
                ? { platform: 'apple', id: '123', catalogId: '123', title: 'Apple fixture' }
                : {}),
            },
          ],
          errors: [],
        };
      if (op === 'lyrics')
        return { original: '[00:01]First line\n[00:04]Second line', translation: '[00:01]第一句\n[00:04]第二句' };
      if (op === 'sync') {
        if (args.platform === 'apple') {
          local.playlists.push({
            id: 'apple-list',
            name: 'Apple fixture playlist',
            created: 1,
            tracks: [],
            remote: {
              platform: 'apple',
              uid: 'apple-user',
              id: 'p.apple',
              updated: Date.now(),
              songs: [{ ...song, platform: 'apple', id: 'i.apple', catalogId: '123', title: 'Apple fixture' }],
            },
          });
          libraryChanged(local);
          return local;
        }
        local.playlists = [
          local.playlists[0],
          {
            id: 'synced',
            name: 'Synced fixture list',
            created: 1,
            tracks: [],
            remote: { platform: 'netease', uid: 'fixture-user', id: 'remote-list', updated: Date.now(), songs: [song] },
          },
        ];
        libraryChanged(local);
        return local;
      }
      if (op === 'enqueue') {
        state.jobs.push({
          id: 'fixture-job',
          track: song,
          quality: args.quality,
          status: 'completed',
          received: 1234,
          total: 1234,
          info: { codec: 'FLAC', bits: 24, sampleRate: 96000, bitrate: 2000000 },
        });
        changed({ ...state });
        return state.jobs;
      }
      if (op === 'translate') return args.input.wanted.map((id) => ({ id, translation: '模型测试译文' }));
      if (op === 'login' && args.platform === 'apple') {
        if (args.action === 'create') return { done: false, sessionId: 'apple-window' };
        if (args.action === 'poll') {
          state.accounts.push({ platform: 'apple', uid: 'apple-user', name: 'Apple Music fixture' });
          changed({ ...state });
        }
        return { done: true };
      }
      if (op === 'login')
        return args.action === 'create'
          ? {
              done: false,
              sessionId: 'fixture-login',
              image:
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBZwAAAAASUVORK5CYII=',
            }
          : { done: true };
      if (op === 'folder') return state.folder;
      if (op === 'models') return ['fixture'];
      return true;
    },
  };
}
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const { server, url } = await require('./serve.cjs')(path.resolve(__dirname, '../dist-app'));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.addInitScript(bridge);
    await page.goto(url + '/index.html');
    await page.locator('[data-test="shelves"]').waitFor();
    await page.locator('[data-section="online"]').click();
    const music = page.locator('[data-test="online-music"]');
    await music.getByRole('textbox', { name: '搜索歌曲', exact: true }).fill('fixture');
    await music.locator('[data-test="online-search"]').getByRole('button', { name: '搜索歌曲', exact: true }).click();
    await music.getByText('Fixture song', { exact: true }).waitFor();
    await music.getByRole('button', { name: '下载歌曲', exact: true }).click();
    await music.getByRole('button', { name: '下载', exact: true }).click();
    await music.getByText(/FLAC.*24 bit.*96 kHz/).waitFor();
    await page.screenshot({ path: path.join(shots, 'downloads.png') });
    console.log('pass search → download queue → actual quality display');
    await page.locator('[data-section="playlists"]').click();
    await page.getByRole('button', { name: '同步歌单', exact: true }).click();
    await page.getByRole('button', { name: /同步歌单 · Fixture account/ }).click();
    await page.locator('[data-test="synced-playlists"]').getByText('Fixture song', { exact: true }).waitFor();
    assert.equal(
      await page
        .locator('[data-test="synced-playlists"]')
        .getByText(/尚未下载/)
        .count(),
      1,
    );
    await page.screenshot({ path: path.join(shots, 'synced-playlists.png') });
    await page.getByRole('button', { name: '本地歌单', exact: true }).click();
    await page.getByText('Local fixture list', { exact: true }).waitFor();
    assert.equal(await page.getByText('Synced fixture list', { exact: true }).count(), 0);
    console.log('pass synced playlists have a separate tab, preserve unresolved songs and leave local lists alone');
    await page.locator('[data-section="online"]').click();
    await music.getByRole('button', { name: '账号', exact: true }).click();
    await music.getByRole('button', { name: '扫码登录', exact: true }).click();
    await music.getByRole('img', { name: '扫码登录', exact: true }).waitFor();
    await music.getByRole('button', { name: '确认登录', exact: true }).click();
    console.log('pass account QR creation and confirmation UI');
    await music.locator('[data-test="online-accounts"]').getByRole('combobox').click();
    await page.getByRole('option', { name: 'Apple Music', exact: true }).click();
    await music.getByRole('button', { name: '登录 Apple Music', exact: true }).click();
    assert.equal(await music.getByRole('img').count(), 0);
    assert.equal(await music.locator('details').count(), 0);
    await music.getByRole('button', { name: '确认登录', exact: true }).click();
    await music.getByText('Apple Music fixture', { exact: true }).waitFor();
    await music.getByRole('button', { name: '同步歌单', exact: true }).click();
    await music.getByRole('button', { name: /同步歌单 · Apple Music fixture/ }).click();
    await music
      .locator('[data-test="synced-playlists"]')
      .getByRole('combobox', { name: '同步歌单', exact: true })
      .click();
    await page.getByRole('option', { name: /Apple fixture playlist/ }).click();
    assert.equal(await music.getByRole('button', { name: '下载歌曲', exact: true }).count(), 0);
    await music.getByRole('button', { name: '在浏览器播放', exact: true }).first().click();
    await music.getByRole('button', { name: '离线下载说明', exact: true }).click();
    await page.screenshot({ path: path.join(shots, 'apple-playlists.png') });
    await music.getByRole('navigation').getByRole('button', { name: '搜索歌曲', exact: true }).click();
    await music.getByRole('combobox', { name: '全部平台', exact: true }).click();
    await page.getByRole('option', { name: 'Apple Music', exact: true }).click();
    await music.getByRole('textbox', { name: '搜索歌曲', exact: true }).fill('apple');
    await music.locator('form').getByRole('button', { name: '搜索歌曲', exact: true }).click();
    await music.getByText('Apple fixture', { exact: true }).waitFor();
    assert.equal(await music.getByRole('checkbox', { name: 'Apple fixture', exact: true }).isDisabled(), true);
    await music.getByRole('button', { name: '在浏览器播放', exact: true }).click();
    const appleCalls = await page.evaluate(() => window.__onlineCalls.filter((c) => c.op === 'openRemote'));
    assert(appleCalls.some((c) => c.args.playlistId === 'apple-list'));
    assert(appleCalls.some((c) => c.args.key === 'apple:123'));
    assert.equal(
      await page.evaluate(() =>
        window.__onlineCalls.some((c) => c.op === 'enqueue' && c.args.keys.some((key) => key.startsWith('apple:'))),
      ),
      false,
    );
    console.log('pass Apple sign-in, unified playlists/search and official playback without protected downloads');
    await page.locator('[data-page="workshop"]').click();
    await page.waitForFunction(() => window.__cadenza?.workshop?.get().session);
    await page.evaluate(async () => {
      const ws = window.__cadenza.workshop,
        s = ws.get().session;
      s.setLyrics('[00:01]First line\n[00:04]Second line');
      await s.flush();
      ws.set({ rev: ws.get().rev + 1 });
    });
    await page.getByRole('button', { name: '翻译与匹配', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: '翻译与匹配', exact: true });
    await dialog.getByRole('button', { name: '粘贴译文', exact: true }).click();
    await dialog.getByRole('textbox', { name: '粘贴译文', exact: true }).fill('第一句\n第二句');
    await dialog.getByRole('button', { name: '匹配译文', exact: true }).click();
    assert.equal(await dialog.getByText('顺序建议，请核对', { exact: true }).count(), 2);
    assert.equal(
      await page.evaluate(() => window.__cadenza.workshop.get().session.spec.lyrics),
      '[00:01]First line\n[00:04]Second line',
    );
    await dialog.getByRole('textbox', { name: '粘贴译文', exact: true }).fill('Only one unmatched fragment');
    await dialog.getByRole('button', { name: '匹配译文', exact: true }).click();
    assert.equal(await dialog.getByRole('textbox', { name: 'First line', exact: true }).inputValue(), '');
    assert.equal(await dialog.getByRole('textbox', { name: 'Second line', exact: true }).inputValue(), '');
    await dialog.getByRole('textbox', { name: '粘贴译文', exact: true }).fill('第一句\n第二句');
    await dialog.getByRole('button', { name: '匹配译文', exact: true }).click();
    await page.screenshot({ path: path.join(shots, 'translation-review.png') });
    await dialog.getByRole('button', { name: '应用到草稿', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(
      await page.evaluate(() => window.__cadenza.workshop.get().session.spec.lyrics),
      '[00:01]First line\n[00:04]Second line',
    );
    assert.equal(await page.evaluate(() => window.__onlineCalls.some((c) => /writeLyrics|save/.test(c.op))), false);
    console.log('pass paste matching only applies to the editor draft; project and files remain unchanged');
    await page.getByRole('button', { name: '翻译与匹配', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '翻译与匹配', exact: true });
    await dialog.getByRole('button', { name: '在线翻译', exact: true }).last().click();
    await dialog.getByRole('textbox', { name: 'First line', exact: true }).filter({ visible: true }).waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-test="translation-editor"] textarea')].some(
        (e) => e.value === '模型测试译文',
      ),
    );
    const payload = await page.evaluate(() => window.__onlineCalls.findLast((c) => c.op === 'translate').args.input);
    assert.equal(payload.lines.length, 2);
    assert.equal(payload.lines[0].text, 'First line');
    assert.equal(/00:01/.test(JSON.stringify(payload.lines)), false);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    console.log('pass online translation receives whole-song plain lines; closing never saves');
    console.log('Screenshots:', shots);
  } finally {
    await page.screenshot({ path: path.join(shots, 'final.png') }).catch(() => {});
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
