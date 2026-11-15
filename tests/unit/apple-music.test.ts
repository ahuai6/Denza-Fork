import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const { AppleMusic, appleFetch, appleSong, applePage, appleNavigation } = require('../../electron/apple-music.cjs');
const { collectPages } = require('../../electron/online.cjs');
const { Platforms } = require('../../electron/platforms.cjs');
const token = (kid: string, exp = Math.floor(Date.now() / 1000) + 3600) =>
  [JSON.stringify({ alg: 'ES256', kid }), JSON.stringify({ exp, iss: 'fixture-issuer' })]
    .map((part) => Buffer.from(part).toString('base64url'))
    .join('.') +
  '.' +
  'x'.repeat(30);
function store() {
  const accounts: Record<string, { uid: string; cookie: string; storefront: string; name?: string }> = {};
  return {
    data: { accounts },
    credential: (platform: string) => accounts[platform] || { uid: '', cookie: '', storefront: '' },
    setAccount: async (platform: string, value: { uid: string; cookie: string; storefront: string }) => {
      accounts[platform] = value;
    },
    save: async () => {},
    accounts: () => Object.entries(accounts).map(([platform, a]) => ({ platform, uid: a.uid, name: a.name })),
  };
}
const librarySong = (id: string) => ({
  id,
  type: 'library-songs',
  attributes: { name: 'Song', artistName: 'Artist', durationInMillis: 180000 },
  relationships: { catalog: { data: [{ id: '123' }] } },
});
describe('Apple Music platform', () => {
  it('follows only same-origin HTTP redirects and stops cancelled requests before sending', async () => {
    let target = 'https://amp-api.music.apple.com/v1/me/storefront';
    let followed = 0,
      aborted = 0,
      sent = 0;
    const net = {
      request: () => {
        const req = Object.assign(new EventEmitter(), {
          setHeader: () => {},
          abort: () => {
            aborted++;
          },
          followRedirect: () => {
            followed++;
            const response = Object.assign(new EventEmitter(), { statusCode: 200 });
            req.emit('response', response);
            response.emit('data', Buffer.from('{"data":[]}'));
            response.emit('end');
          },
          end: () => {
            sent++;
            queueMicrotask(() => req.emit('redirect', 302, 'GET', target));
          },
        });
        return req;
      },
    };
    expect(await (await appleFetch(net, target, { headers: { Authorization: 'Bearer private' } })).json()).toEqual({
      data: [],
    });
    expect(followed).toBe(1);
    target = 'https://evil.example/steal';
    await expect(appleFetch(net, 'https://amp-api.music.apple.com/v1/me/storefront', {})).rejects.toThrow(
      'redirect rejected',
    );
    expect(followed).toBe(1);
    const cancel = new AbortController();
    cancel.abort();
    await expect(appleFetch(net, target, { signal: cancel.signal })).rejects.toThrow('cancelled');
    expect(sent).toBe(2);
    expect(aborted).toBe(2);
  });
  it('keeps library identities distinct from catalog identities, including uploaded songs', () => {
    expect(appleSong(librarySong('i.library'), 'cn')).toMatchObject({
      id: 'i.library',
      catalogId: '123',
      duration: 180,
      storefront: 'cn',
    });
    expect(
      appleSong({ id: 'i.upload', type: 'library-songs', attributes: { playParams: { id: 'i.upload' } } }, 'us')
        .catalogId,
    ).toBe('');
    expect(appleSong({ id: '456', type: 'songs', attributes: {} }, 'us').catalogId).toBe('456');
  });
  it('restricts pagination and sign-in navigation to the expected Apple surfaces', () => {
    const root = '/v1/me/library/playlists/p.test/tracks';
    expect(applePage(root + '?offset=100', root)).toBe(root + '?offset=100');
    for (const url of [
      'https://evil.example' + root,
      '/v1/me/storefront',
      'https://user@amp-api.music.apple.com' + root,
    ])
      expect(() => applePage(url, root)).toThrow();
    expect(appleNavigation('https://idmsa.apple.com/appleauth/auth/authorize')).toBe(true);
    for (const url of [
      'http://music.apple.com',
      'https://music.apple.com.evil.example',
      'file:///tmp/test',
      'https://u@music.apple.com',
    ])
      expect(appleNavigation(url)).toBe(false);
  });
  it('discovers current public web tokens, verifies the account and never sends its user token to the bundle host', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const s = store();
    const webToken = token('WebPlayKid');
    const a = new AppleMusic(
      s,
      () => {},
      async (url: string, options: { headers: Record<string, string> }) => {
        calls.push({ url, headers: options.headers });
        if (url.endsWith('/us/browse')) return new Response('<script src="/assets/index~fixture.js"></script>');
        if (url.endsWith('.js')) return new Response([token('Other'), webToken, token('Old', 1)].join(';'));
        expect(options.headers.Authorization).toBe('Bearer ' + webToken);
        return Response.json({ data: [{ id: 'cn' }] });
      },
    );
    await a.verify('private-user-token', 0);
    expect(s.credential('apple').storefront).toBe('cn');
    expect(s.credential('apple').uid).not.toContain('private');
    expect(JSON.stringify(s.accounts())).not.toContain('private-user-token');
    expect(
      calls.filter((c) => c.url.startsWith('https://music.apple.com')).every((c) => !c.headers['Music-User-Token']),
    ).toBe(true);
    expect(calls.at(-1)?.headers['Music-User-Token']).toBe('private-user-token');
  });
  it('does not persist an unverified or cancelled sign-in', async () => {
    const s = store(),
      a = new AppleMusic(s);
    a.api = async () => ({ data: [] });
    await expect(a.verify('private', 0)).rejects.toThrow('verify');
    a.api = async () => ({ data: [{ id: 'us' }] });
    a.revision = 1;
    await expect(a.verify('private', 0)).rejects.toThrow('cancelled');
    expect(s.accounts()).toEqual([]);
  });
  it('follows server cursors to the complete snapshot and rejects incomplete or foreign next pages', async () => {
    const s = store();
    await s.setAccount('apple', { uid: 'user', cookie: 'private', storefront: 'us' });
    const a = new AppleMusic(s),
      paths: string[] = [];
    a.api = async (path: string) => {
      paths.push(path);
      return path.includes('offset=opaque')
        ? { data: [librarySong('i.2')], meta: { total: 2 } }
        : {
            data: [librarySong('i.1')],
            next: '/v1/me/library/playlists/p.test/tracks?offset=opaque',
            meta: { total: 2 },
          };
    };
    const result = await collectPages((page: number) => a.page('songs', 'p.test', page));
    expect(result.map((song: { id: string }) => song.id)).toEqual(['i.1', 'i.2']);
    expect(paths[1]).toContain('offset=opaque');
    a.api = async () => ({ data: [librarySong('i.1')], next: 'https://evil.example/steal' });
    await expect(a.page('songs', 'p.test', 1)).rejects.toThrow('pagination');
    a.api = async () => ({ data: [librarySong('i.1')], meta: { total: 2 } });
    await expect(collectPages((page: number) => a.page('songs', 'p.test', page))).rejects.toThrow('incomplete');
  });
  it('retries unsupported catalog expansion without losing library-only entries and rejects changed accounts', async () => {
    const s = store();
    await s.setAccount('apple', { uid: 'user', cookie: 'private', storefront: 'us' });
    const a = new AppleMusic(s);
    a.api = async (path: string) => {
      if (path.includes('include=catalog')) throw Error('Apple Music HTTP 400');
      return { data: [{ id: 'i.upload', attributes: { name: 'Upload' } }] };
    };
    expect((await a.page('songs', 'p.test', 1)).rows[0].id).toBe('i.upload');
    a.api = async () => {
      delete s.data.accounts.apple;
      return { data: [] };
    };
    await expect(a.page('songs', 'p.test', 1)).rejects.toThrow('account changed');
  });
  it('opens canonical official links and resolves public file requests without SDK access or Apple credentials', async () => {
    const urls: string[] = [];
    const a = new AppleMusic(
      store(),
      () => {},
      fetch,
      () => ({ shell: { openExternal: async (url: string) => urls.push(url) } }),
    );
    await a.play({ catalogId: '123', storefront: 'cn' });
    await a.play({ catalogId: '', storefront: 'us' });
    await a.play(null, 'p.test');
    expect(urls).toEqual([
      'https://music.apple.com/cn/song/123',
      'https://music.apple.com/us/library/songs',
      'https://music.apple.com/us/library/playlist/p.test',
    ]);
    const p = new Platforms(
      store(),
      () => {
        throw Error('SDK must not run');
      },
      a,
    );
    const result = await p.resolve({ platform: 'apple', id: 'i.fixture', catalogId: '123' }, 'lossless');
    expect(new URL(result.url).pathname).toBe('/download/flac');
    expect(new URL(result.url).searchParams.get('song')).toBe('123');
    expect(result).not.toHaveProperty('cookie');
    await expect(p.account('apple', 'private')).rejects.toThrow('sign-in window');
  });
  it('closes and clears only the dedicated Apple session when signing out', async () => {
    const s = store();
    await s.setAccount('apple', { uid: 'user', cookie: 'private', storefront: 'us' });
    let cleared = false;
    const a = new AppleMusic(
      s,
      () => {},
      fetch,
      () => ({
        session: {
          fromPartition: (partition: string) => {
            expect(partition).toBe('persist:denza-apple-music');
            return {
              clearStorageData: async () => {
                cleared = true;
              },
            };
          },
        },
      }),
    );
    await a.logout();
    expect(cleared).toBe(true);
    expect(s.accounts()).toEqual([]);
    a.close();
    expect(a.lifetime.signal.aborted).toBe(true);
  });
  it('keeps the official login window isolated and closes pending windows on cancellation', async () => {
    const options: { webPreferences: Record<string, unknown> }[] = [];
    let popup: (input: { url: string }) => { action: string } = () => ({ action: 'deny' });
    class Window extends EventEmitter {
      destroyed = false;
      webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler: (handler: typeof popup) => {
          popup = handler;
        },
      });
      constructor(value: { webPreferences: Record<string, unknown> }) {
        super();
        options.push(value);
      }
      async loadURL(url: string) {
        expect(url).toBe('https://music.apple.com/us/browse');
      }
      isDestroyed() {
        return this.destroyed;
      }
      destroy() {
        this.destroyed = true;
        this.emit('closed');
      }
      focus() {}
    }
    const a = new AppleMusic(
      store(),
      () => {},
      fetch,
      () => ({ BrowserWindow: Window, session: { fromPartition: () => ({ setUserAgent: () => {} }) } }),
    );
    expect((await a.login('create')).sessionId).toBe('apple-window');
    expect(options[0].webPreferences).toEqual({
      partition: 'persist:denza-apple-music',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    });
    let prevented = false;
    a.window.webContents.emit(
      'will-navigate',
      {
        preventDefault: () => {
          prevented = true;
        },
      },
      'https://evil.example',
    );
    expect(prevented).toBe(true);
    expect(popup({ url: 'https://evil.example' }).action).toBe('deny');
    expect(popup({ url: 'https://idmsa.apple.com/appleauth/auth/authorize' }).action).toBe('allow');
    const window = a.window;
    await a.login('cancel');
    expect(window.destroyed).toBe(true);
    expect(a.window).toBe(null);
  });
});
