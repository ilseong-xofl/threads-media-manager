import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function ToastLayer({ children }: { children: ReactNode }) {
  const [host] = useState(() => {
    const element = document.createElement('div');
    element.className = 'toast-stack';
    return element;
  });
  useLayoutEffect(() => {
    // Native modal dialogs sit above normal z-index layers. Move the existing
    // portal host when a dialog opens or closes without resetting toast timers.
    const placeHost = () => {
      const modals = document.querySelectorAll<HTMLDialogElement>('dialog[open]');
      const target = modals.item(modals.length - 1) ?? document.body;
      if (host.parentElement !== target) target.appendChild(host);
    };
    placeHost();
    const observer = new MutationObserver(placeHost);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open'],
    });
    return () => {
      observer.disconnect();
      host.remove();
    };
  }, [host]);
  return createPortal(children, host);
}
