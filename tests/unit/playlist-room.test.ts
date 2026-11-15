import { describe, expect, it } from 'vitest';
import { PlaylistRoom } from '../../src/app/space/playlistRoom';
import { LIST_SLOTS, type SpaceLibrary, type SpacePlaylist } from '../../src/app/space/data';

const list = (id: string, online = false): SpacePlaylist => ({ id, name: id, note: '', ids: [], online });
const library = (playlists: SpacePlaylist[]): SpaceLibrary => ({ songs: [], albums: [], playlists, sig: '' });
const mixed = library([
  list('favorites'),
  ...Array.from({ length: 17 }, (_, i) => list('online-' + i, true)),
  ...Array.from({ length: 8 }, (_, i) => list('local-' + i)),
]);
describe('playlist room sources', () => {
  it('keeps favorites and ordinary playlists separate from online lists, paging each group independently', () => {
    const room = new PlaylistRoom(mixed);
    expect(room.items.map((p) => p.id)).toEqual(['favorites', ...Array.from({ length: 6 }, (_, i) => 'local-' + i)]);
    room.turn(1);
    expect(room.items.map((p) => p.id)).toEqual(['local-6', 'local-7']);
    room.select('online');
    expect(room.page).toBe(0);
    expect(room.pages).toBe(3);
    expect(room.items).toHaveLength(LIST_SLOTS);
    expect(room.items.every((p) => p.online)).toBe(true);
    room.turn(-1);
    expect(room.items.map((p) => p.id)).toEqual(['online-14', 'online-15', 'online-16']);
  });
  it('routes global search to the correct source, page and room slot', () => {
    const room = new PlaylistRoom(mixed);
    expect(room.locate('online-15')).toBe(1);
    expect(room.source).toBe('online');
    expect(room.page).toBe(2);
    expect(room.items[1].id).toBe('online-15');
    expect(room.locate('local-7')).toBe(1);
    expect(room.source).toBe('local');
    expect(room.items[1].id).toBe('local-7');
    expect(room.locate('deleted')).toBe(-1);
    expect(room.source).toBe('local');
  });
  it('keeps the selected source when sync changes the library and clamps pages after deletions', () => {
    const room = new PlaylistRoom(mixed);
    room.locate('online-15');
    room.update(library([list('favorites'), list('fresh', true)]));
    expect(room.source).toBe('online');
    expect(room.page).toBe(0);
    expect(room.items.map((p) => p.id)).toEqual(['fresh']);
    room.update(library([list('favorites')]));
    expect(room.items).toEqual([]);
    expect(room.pages).toBe(1);
    room.turn(2);
    expect(room.page).toBe(0);
  });
});
