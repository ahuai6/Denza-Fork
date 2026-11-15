import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/emitter';
import { createDialogCoordinator } from '../../src/app/actions/dialogs';
function setup() {
  const state = createStore({
    page: 'library',
    layer: 'none',
    modal: null as null | object,
    dialog: null as string | null,
    section: 'songs',
    detail: null as null | object,
  });
  const coordinator = createDialogCoordinator({
    read: state.get,
    write: (dialog) => state.set({ dialog }),
    subscribe: (f) => state.subscribe(f),
  });
  return { state, coordinator };
}
describe('extension dialog ownership', () => {
  it('replaces the previous dialog and ignores stale unmounts and dismissals', () => {
    const { state, coordinator } = setup();
    let closed = 0;
    const first = coordinator.claim('first', () => closed++);
    const second = coordinator.claim('second', () => closed++);
    expect(closed).toBe(1);
    expect(state.get().dialog).toBe('second');
    first.release();
    first.dismiss('closed');
    expect(state.get().dialog).toBe('second');
    expect(first.restoreFocus()).toBe(false);
    second.dismiss('closed');
    expect(closed).toBe(2);
    expect(state.get().dialog).toBeNull();
    expect(second.restoreFocus()).toBe(true);
  });
  for (const patch of [
    { page: 'settings' },
    { layer: 'np' },
    { modal: { kind: 'meta' } },
    { section: 'playlists' },
    { detail: { kind: 'playlist', key: 'fixture' } },
  ])
    it('hands ownership back to native navigation: ' + JSON.stringify(patch), () => {
      const { state, coordinator } = setup();
      let closed = 0;
      const lease = coordinator.claim('child', () => closed++);
      state.set(patch);
      expect(state.get().dialog).toBeNull();
      expect(closed).toBe(1);
      expect(lease.restoreFocus()).toBe(false);
      state.set({ page: 'wall' });
      expect(closed).toBe(1);
    });
  it('keeps native modal state intact on cancel and supports ordinary unmount cleanup', () => {
    const { state, coordinator } = setup();
    const native = { kind: 'np' };
    state.set({ modal: native });
    const lease = coordinator.claim('translation', () => {});
    coordinator.dismiss();
    expect(state.get().modal).toBe(native);
    expect(lease.restoreFocus()).toBe(true);
    const unmounted = coordinator.claim('search', () => {});
    unmounted.release();
    expect(state.get().dialog).toBeNull();
    expect(unmounted.restoreFocus()).toBe(true);
  });
});
