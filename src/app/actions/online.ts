import { engine } from '../playback/stage';
import { request } from '../online/state';
// Playback coordination is an application action, not part of the online state store.
export async function openRemote(args: { key?: string; playlistId?: string }) {
  await request('openRemote', args);
  engine.pause();
}
