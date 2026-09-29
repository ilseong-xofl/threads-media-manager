export type ToastNotice = {
  message: string;
  error?: boolean;
  key?: string;
  action?: { label: string; onClick(): void; disabled?: boolean };
};
export type ToastEntry = ToastNotice & { id: number };

export function createToastStore() {
  let entries: ToastEntry[] = [];
  let nextId = 0;
  const listeners = new Set<() => void>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const emit = () => listeners.forEach((listener) => listener());
  const dismiss = (id: number) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
    entries = entries.filter((entry) => entry.id !== id);
    emit();
  };
  return {
    getSnapshot: () => entries,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify(notice: ToastNotice | null) {
      if (!notice?.message.trim()) return;
      const previous = entries.find((entry) =>
        notice.key
          ? entry.key === notice.key
          : entry.message === notice.message && !!entry.error === !!notice.error,
      );
      const id = previous?.id ?? ++nextId;
      clearTimeout(timers.get(id));
      entries = [...entries.filter((entry) => entry.id !== id), { ...notice, id }];
      while (entries.length > 3) {
        const removed = entries.shift()!;
        clearTimeout(timers.get(removed.id));
        timers.delete(removed.id);
      }
      timers.set(
        id,
        setTimeout(() => dismiss(id), notice.error ? 7000 : 3500),
      );
      emit();
    },
    dismiss,
    dispose() {
      timers.forEach(clearTimeout);
      timers.clear();
      listeners.clear();
    },
  };
}
