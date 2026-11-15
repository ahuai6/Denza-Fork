import type { ReactNode } from 'react';
import { ui, useStore } from '../state';

/** Retract the native owner while its portalled dialog is open, retaining its React state and unsaved edits. */
export function DialogOwner({ children }: { children: ReactNode }) {
  const suspended = useStore(ui, (state) => !!state.dialog);
  return (
    <div
      data-dialog-owner
      data-suspended={suspended || undefined}
      aria-hidden={suspended || undefined}
      inert={suspended}
      style={{ display: suspended ? 'none' : 'contents' }}
    >
      {children}
    </div>
  );
}
