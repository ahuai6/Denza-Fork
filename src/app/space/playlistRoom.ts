// Room-local selection and paging stay independent of the renderer and account protocols.
import { LIST_SLOTS, type SpaceLibrary, type SpacePlaylist } from './data';

export type PlaylistSource = 'local' | 'online';
export class PlaylistRoom {
  source: PlaylistSource = 'local';
  page = 0;
  constructor(private library: SpaceLibrary) {}
  get lists(): SpacePlaylist[] {
    return this.library.playlists.filter((p) => (p.online ? 'online' : 'local') === this.source);
  }
  get pages() {
    return Math.max(1, Math.ceil(this.lists.length / LIST_SLOTS));
  }
  get items() {
    return this.lists.slice(this.page * LIST_SLOTS, (this.page + 1) * LIST_SLOTS);
  }
  select(source: PlaylistSource) {
    this.source = source;
    this.page = 0;
  }
  turn(page: number) {
    const pages = this.pages;
    this.page = ((page % pages) + pages) % pages;
  }
  update(library: SpaceLibrary) {
    this.library = library;
    this.page = Math.min(this.page, this.pages - 1);
  }
  locate(id: string): number {
    const playlist = this.library.playlists.find((p) => p.id === id);
    if (!playlist) return -1;
    this.source = playlist.online ? 'online' : 'local';
    const index = this.lists.findIndex((p) => p.id === id);
    this.page = Math.floor(index / LIST_SLOTS);
    return index % LIST_SLOTS;
  }
}
