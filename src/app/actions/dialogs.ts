// One extension dialog owns modal input. Owners remain mounted so a temporary retreat never loses a draft.
import { ui } from '../state';
interface Context {
  page: unknown;
  layer: unknown;
  modal: unknown;
  section?: unknown;
  detail?: unknown;
}
interface Host {
  read(): Context;
  write(id: string | null): void;
  subscribe(listener: () => void): () => void;
}
type Reason = 'closed' | 'replaced' | 'navigation';
export function createDialogCoordinator(host: Host) {
  let active: { dismiss(reason: Reason): void } | null = null;
  const same = (a: Context, b: Context) =>
    a.page === b.page && a.layer === b.layer && a.modal === b.modal && a.section === b.section && a.detail === b.detail;
  return {
    claim(id: string, close: () => void) {
      active?.dismiss('replaced');
      const origin = host.read();
      let reason: Reason | null = null;
      let off = () => {};
      const lease = {
        release() {
          off();
          if (active !== lease) return;
          active = null;
          host.write(null);
        },
        dismiss(next: Reason) {
          if (active !== lease) return;
          reason = next;
          lease.release();
          close();
        },
        restoreFocus: () => reason !== 'replaced' && reason !== 'navigation' && !active && same(origin, host.read()),
      };
      active = lease;
      host.write(id);
      off = host.subscribe(() => {
        if (!same(origin, host.read())) lease.dismiss('navigation');
      });
      return lease;
    },
    dismiss(reason: Reason = 'closed') {
      active?.dismiss(reason);
    },
  };
}
export const dialogs = createDialogCoordinator({
  read: ui.get,
  write: (dialog) => ui.set({ dialog }),
  subscribe: (listener) => ui.subscribe(listener),
});
