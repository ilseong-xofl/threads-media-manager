import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ManagedThreadsAccountSettings } from './ManagedThreadsAccountSettings';
import { Icon } from './Icon';
import './account-management-modal.css';

export function AccountManagementModal({
  enabled,
  onClose,
}: {
  enabled: boolean;
  onClose(): void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const [working, setWorking] = useState(false);
  const onSyncing = useCallback((value: boolean) => {
    pending.current = value;
    setWorking(value);
  }, []);
  useEffect(() => {
    if (
      !working &&
      enabled &&
      dialog.current?.open &&
      (document.activeElement === document.body ||
        document.activeElement === document.documentElement)
    )
      close.current?.focus({ preventScroll: true });
  }, [working, enabled]);
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    element?.showModal();
    close.current?.focus();
    document.body.style.overflow = 'hidden';
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  function requestClose() {
    if (!pending.current) onClose();
  }
  return (
    <dialog
      ref={dialog}
      className="post-modal account-management-modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        requestClose();
      }}
    >
      <button
        ref={close}
        type="button"
        className="icon-button account-management-close"
        aria-label="계정 관리 닫기"
        disabled={working}
        onClick={requestClose}
      >
        <Icon name="close" />
      </button>
      <div className="account-management-content">
        <ManagedThreadsAccountSettings enabled={enabled} onSyncing={onSyncing} titleId={titleId} />
      </div>
    </dialog>
  );
}
