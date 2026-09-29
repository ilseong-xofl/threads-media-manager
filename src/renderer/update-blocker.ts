export interface UpdateUiState {
  busy: boolean;
  downloading: boolean;
  exporting: string | null;
  localMutation: boolean;
  selected: string | null;
  registration: object | null;
  settingsOpen: boolean;
  contentPostKey: string | null;
  confirmDownload: boolean;
}

/** Keep open editors protected even before the user starts saving their work. */
export function updateBlockedByUi(state: UpdateUiState): boolean {
  return (
    state.busy ||
    state.downloading ||
    state.exporting !== null ||
    state.localMutation ||
    state.selected !== null ||
    state.registration !== null ||
    state.settingsOpen ||
    state.contentPostKey !== null ||
    state.confirmDownload
  );
}

/** A failed report never grants permission to restart during this renderer lifetime. */
export function createUpdateBlockReporter(report: (blocked: boolean) => Promise<void>) {
  let failed = false;
  let disposed = false;
  let last: boolean | null = null;
  const restoreBlock = () => {
    failed = true;
    last = true;
    try {
      void report(true).catch(() => {});
    } catch {
      // Main starts blocked and also blocks when this renderer is lost.
    }
  };
  const send = (blocked: boolean) => {
    if (last === blocked) return;
    last = blocked;
    try {
      void report(blocked).catch(restoreBlock);
    } catch {
      restoreBlock();
    }
  };
  return {
    report(blocked: boolean) {
      if (!disposed) send(failed || blocked);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      send(true);
    },
  };
}
