import { createStore } from '../../core/emitter';
import { Online } from '../bridge';
import type { OnlineState } from './types';
export const online = createStore<OnlineState>({ accounts: [], jobs: [], folder: '' });
export function request<T>(operation: string, args: object = {}): Promise<T> {
  if (!Online) return Promise.reject(new Error('Online services require the desktop app'));
  return Online.request(operation, args) as Promise<T>;
}
export function bootOnline() {
  if (!Online) return () => {};
  let active = true;
  const offChanged = Online.onChanged((state) => {
    if (active) online.set(state);
  });
  const offProgress =
    Online.onProgress?.((progress) => {
      if (!active) return;
      const cur = online.get();
      const idx = cur.jobs.findIndex((j) => j.id === progress.id);
      if (idx < 0) return;
      const prev = cur.jobs[idx];
      if (prev.status === progress.status && prev.received === progress.received && prev.total === progress.total)
        return;
      const jobs = cur.jobs.slice();
      jobs[idx] = { ...prev, status: progress.status, received: progress.received, total: progress.total };
      online.set({ jobs });
    }) || (() => {});
  request<OnlineState>('state')
    .then((state) => {
      if (active) online.set(state);
    })
    .catch(() => {});
  return () => {
    active = false;
    offChanged();
    offProgress();
  };
}
export const jobId = () => crypto.randomUUID();
