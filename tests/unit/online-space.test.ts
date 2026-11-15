import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fromLibrary } from '../../src/app/space/data';
const require = createRequire(import.meta.url);
const { createLibraryIntegration } = require('../../electron/online/library-links.cjs');
const { fetchArtwork } = require('../../electron/online/artwork.cjs');
const remote = {
  platform: 'netease' as const,
  uid: 'fixture',
  id: 'remote',
  updated: 1,
  artworkUrl: 'https://p1.music.126.net/cover.jpg',
  songs: [
    {
      platform: 'netease' as const,
      id: 'song',
      title: 'Remote fixture',
      artist: 'Fixture',
      album: 'Fixture',
      duration: 10,
      localId: null,
    },
  ],
};
describe('synced playlists in the space', () => {
  it('shows the full remote count and original cached artwork even with no local songs', () => {
    const playlist = { id: 'synced', name: 'Fixture', created: 1, tracks: [], remote };
    const first = fromLibrary([], [], [playlist]);
    expect(first.playlists[0].note).toContain('1');
    expect(first.playlists[0].ids).toEqual([]);
    const second = fromLibrary([], [], [{ ...playlist, remote: { ...remote, cover: 'image-key' } }]);
    expect(second.playlists[0].cover).toBe('image-key');
    expect(second.sig).not.toBe(first.sig);
    const third = fromLibrary([], [], [{ ...playlist, remote: { ...remote, songs: [] } }]);
    expect(third.sig).not.toBe(first.sig);
  });
  it('coalesces cache requests and rejects an image from an obsolete playlist snapshot', async () => {
    const playlist = { id: 'synced', name: 'Fixture', tracks: [], remote: { ...remote, cover: null as string | null } };
    let resolveCover!: (key: string) => void,
      calls = 0,
      changes = 0;
    const integration = createLibraryIntegration({
      getDB: () => ({ playlists: [playlist] }),
      changed: () => {
        changes++;
      },
      cacheArtwork: () => {
        calls++;
        return new Promise<string>((resolve) => {
          resolveCover = resolve;
        });
      },
    });
    const a = integration.cachePlaylistCover('synced'),
      b = integration.cachePlaylistCover('synced');
    expect(calls).toBe(1);
    playlist.remote = { ...playlist.remote, artworkUrl: 'https://p1.music.126.net/new.jpg' };
    resolveCover('old-key');
    expect(await a).toBeNull();
    expect(await b).toBeNull();
    expect(changes).toBe(0);
    const fresh = integration.cachePlaylistCover('synced');
    resolveCover('new-key');
    expect(await fresh).toBe('new-key');
    expect(changes).toBe(1);
    expect(await integration.cachePlaylistCover('synced')).toBe('new-key');
    expect(calls).toBe(2);
  });
  it('fetches only anonymous bounded images from supported CDNs and checks redirects', async () => {
    const seen: string[] = [];
    const fetcher = async (url: string, options: RequestInit) => {
      seen.push(url);
      expect(options.credentials).toBe('omit');
      expect(options.headers).toBeUndefined();
      return url.includes('redirect')
        ? new Response(null, { status: 302, headers: { location: 'https://y.gtimg.cn/test.jpg' } })
        : new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/jpeg' } });
    };
    expect((await fetchArtwork(fetcher, 'https://p1.music.126.net/redirect')).length).toBe(2);
    expect(seen).toHaveLength(2);
    await expect(fetchArtwork(fetcher, 'https://127.0.0.1/image.jpg')).rejects.toThrow('source');
    await expect(
      fetchArtwork(
        async () => new Response('html', { headers: { 'content-type': 'text/html' } }),
        'https://p1.music.126.net/cover.jpg',
      ),
    ).rejects.toThrow('unavailable');
  });
});
