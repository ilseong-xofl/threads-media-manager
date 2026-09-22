import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function ToastLayer({ children, modalKey }: { children: ReactNode; modalKey?: string }) {
  const [host] = useState(() => {
    const element = document.createElement('div');
    element.className = 'toast-stack';
    return element;
  });
  useLayoutEffect(() => {
    // Native modal dialogs sit above normal z-index layers. Keep the same portal
    // host inside the dialog so controls remain usable and toast timers keep running.
    const modal = modalKey ? document.querySelector<HTMLDialogElement>('.post-modal') : null;
    (modal ?? document.body).appendChild(host);
    return () => host.remove();
  }, [host, modalKey]);
  return createPortal(children, host);
}
