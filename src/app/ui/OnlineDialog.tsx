import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { tx } from '../../i18n';
import { ui, useStore } from '../state';
import { dialogs } from '../actions/dialogs';
import { Button, OUT_MS, usePresence } from './kit';
import s from './OnlineMusic.module.css';
import { useOnlineSurface } from './OnlineSurface';

export function OnlineDialog({
  open = true,
  title,
  children,
  close,
}: {
  open?: boolean;
  title: string;
  children: ReactNode;
  close(): void;
}) {
  const surface = useOnlineSurface();
  const picture = useStore(ui, (state) => state.layer !== 'none');
  const { shown, closing } = usePresence(open, OUT_MS);
  const ref = useRef<HTMLElement>(null),
    id = useId(),
    onClose = useRef(close);
  onClose.current = close;
  const active = useStore(ui, (state) => state.dialog === id);
  useLayoutEffect(() => {
    if (!open) return;
    const prior = document.activeElement;
    const lease = dialogs.claim(id, () => onClose.current());
    return () => {
      lease.release();
      if (lease.restoreFocus() && prior instanceof HTMLElement)
        requestAnimationFrame(() => {
          if (!ui.get().dialog && prior.isConnected && prior.getClientRects().length && !prior.closest('[inert]'))
            prior.focus();
        });
    };
  }, [id, open]);
  useLayoutEffect(() => {
    if (open && active) ref.current?.focus();
  }, [open, active]);
  useEffect(() => {
    if (!open || !active) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (document.querySelector('[role="listbox"]:not([data-closing])')) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        dialogs.dismiss();
      }
      if (e.key === 'Tab') {
        const items = [
          ...(ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
          ) || []),
        ].filter((el) => el.getClientRects().length);
        const first = items[0],
          last = items.at(-1);
        if (
          !items.includes(document.activeElement as HTMLElement) ||
          (!e.shiftKey && document.activeElement === last)
        ) {
          e.preventDefault();
          first?.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      }
    };
    addEventListener('keydown', key, true);
    return () => removeEventListener('keydown', key, true);
  }, [open, active]);
  if (!shown || (open && !active)) return null;
  const isClosing = !open || closing;
  return createPortal(
    <div
      className={s.overlay + ' ' + surface.className + (!surface.space && picture ? ' on-picture' : '')}
      data-online-scene={surface.space ? 'space' : 'classic'}
      data-closing={isClosing || undefined}
      aria-hidden={isClosing || undefined}
      inert={isClosing}
      onKeyDown={(e) => {
        if (e.key !== 'F11') e.stopPropagation();
      }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) dialogs.dismiss();
      }}
    >
      <section
        className={s.dialog + (surface.space ? ' card' : '')}
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className={s.header}>
          <h2>{title}</h2>
          <Button onClick={() => dialogs.dismiss()}>{tx('on.close')}</Button>
        </header>
        {children}
      </section>
    </div>,
    document.body,
  );
}
