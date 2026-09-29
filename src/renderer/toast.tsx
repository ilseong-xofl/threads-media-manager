import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Icon } from './Icon';
import { ToastLayer } from './ToastLayer';
import { createToastStore, type ToastNotice } from './toast-store';

const ToastContext = createContext<(notice: ToastNotice | null) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function useToastMessage(message: string | null | undefined, error = true) {
  const notify = useToast();
  useEffect(() => {
    if (message) notify({ message, error });
  }, [message, error, notify]);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createToastStore);
  const entries = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => () => store.dispose(), [store]);
  return (
    <ToastContext.Provider value={store.notify}>
      {children}
      <ToastLayer>
        {entries.map((entry) => (
          <div
            key={entry.id}
            className={`export-toast ${entry.error ? 'export-toast-error' : ''}`}
            role={entry.error ? 'alert' : 'status'}
          >
            <span>{entry.message}</span>
            {entry.action && (
              <button
                type="button"
                disabled={entry.action.disabled}
                onClick={() => {
                  entry.action?.onClick();
                  store.dismiss(entry.id);
                }}
              >
                {entry.action.label}
              </button>
            )}
            <button type="button" aria-label="알림 닫기" onClick={() => store.dismiss(entry.id)}>
              <Icon name="close" />
            </button>
          </div>
        ))}
      </ToastLayer>
    </ToastContext.Provider>
  );
}
