/** Protected status IPC revalidates service access, so idle polling must remain infrequent. */
export const downloadPollingDelay = (active: boolean) => (active ? 300 : 30_000);

export function createDownloadPolling(options: {
  enabled(): boolean;
  delay(): number;
  poll(): Promise<void>;
}) {
  let stopped = false;
  let running = false;
  let requested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function clear() {
    clearTimeout(timer);
    timer = undefined;
  }
  async function refresh() {
    clear();
    if (stopped || !options.enabled()) {
      requested = false;
      return;
    }
    if (running) {
      requested = true;
      return;
    }
    running = true;
    try {
      await options.poll();
    } catch {
      // The existing service gate owns connection failures; never create a fast error retry loop.
    } finally {
      running = false;
      if (!stopped && options.enabled()) {
        if (requested) {
          requested = false;
          void refresh();
        } else timer = setTimeout(() => void refresh(), options.delay());
      }
    }
  }
  return {
    wake: () => {
      void refresh();
    },
    stop() {
      stopped = true;
      requested = false;
      clear();
    },
  };
}
