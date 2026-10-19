import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

export function cancelManagedThreadsDialog(
  event: { preventDefault(): void; stopPropagation(): void },
  busy: boolean,
  onClose: () => void,
) {
  event.preventDefault();
  // React cancellation events must not also close the account table underneath.
  event.stopPropagation();
  if (!busy) onClose();
}

/** A second native modal keeps the account table mounted and makes it inert. */
export function ManagedThreadsActionDialog({
  title,
  busy,
  onClose,
  children,
  confirmation = false,
  returnFocusTo,
}: {
  title: string;
  busy: boolean;
  onClose(): void;
  children: ReactNode;
  confirmation?: boolean;
  returnFocusTo?: HTMLElement | null;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const openerRef = useRef(returnFocusTo);
  useEffect(() => {
    const element = dialog.current;
    // The toolbar is disabled as this dialog opens, so capture its button before that render.
    const opener =
      openerRef.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    element?.showModal();
    (element?.querySelector<HTMLInputElement>('input:not(:disabled)') ?? close.current)?.focus();
    return () => {
      element?.close();
      // React removes the child and re-enables its opener in the same commit. Native dialog
      // closing also restores focus, so wait one frame before choosing the final focus target.
      requestAnimationFrame(() => {
        const parent = opener?.closest<HTMLDialogElement>('dialog');
        const modals = document.querySelectorAll<HTMLDialogElement>('dialog[open]');
        if (
          !parent?.isConnected ||
          !parent.open ||
          parent.closest('[inert], [hidden]') ||
          modals.item(modals.length - 1) !== parent
        )
          return;
        if (opener?.isConnected && !opener.hasAttribute('disabled')) {
          opener.focus({ preventScroll: true });
        } else {
          // After successful deletion its action is disabled because the selected row is gone.
          parent
            .querySelector<HTMLButtonElement>('button:not(:disabled)')
            ?.focus({ preventScroll: true });
        }
      });
    };
  }, []);
  useEffect(() => {
    if (
      !busy &&
      dialog.current?.open &&
      (document.activeElement === document.body ||
        document.activeElement === document.documentElement)
    )
      close.current?.focus({ preventScroll: true });
  }, [busy]);
  return (
    <dialog
      ref={dialog}
      className="post-modal managed-threads-action-dialog"
      role={confirmation ? 'alertdialog' : undefined}
      aria-labelledby={`${id}-title`}
      aria-busy={busy}
      onCancel={(event) => cancelManagedThreadsDialog(event, busy, onClose)}
    >
      <div className="managed-threads-action-header">
        <h3 id={`${id}-title`}>{title}</h3>
        <button
          ref={close}
          type="button"
          className="icon-button"
          aria-label={`${title} 닫기`}
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="managed-threads-action-content">{children}</div>
    </dialog>
  );
}
