import { createStore } from '../../core/emitter';
import { Online } from '../bridge';
import type { OnlineState } from './types';
import { engine } from '../playback/stage';
export const online = createStore<OnlineState>({ accounts: [], jobs: [], folder: '' });
export function request<T>(operation: string, args: object = {}): Promise<T> {
  if (!Online) return Promise.reject(new Error('Online services require the desktop app'));
  return Online.request(operation, args) as Promise<T>;
}
export function bootOnline() {
  if (!Online) return () => {};
  let active = true;
  const off = Online.onChanged((state) => {
    if (active) online.set(state);
  });
  request<OnlineState>('state')
    .then((state) => {
      if (active) online.set(state);
    })
    .catch(() => {});
  return () => {
    active = false;
    off();
  };
}
export const jobId = () => crypto.randomUUID();
export async function openApple(args: { key?: string; playlistId?: string }) {
  await request('appleOpen', args);
  engine.pause();
}
