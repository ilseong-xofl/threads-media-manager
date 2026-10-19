import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type {
  DeleteManagedThreadsAccountInput,
  ManagedThreadsAccountRow,
  ManagedThreadsMethods,
  ManagedThreadsResult,
  PendingManagedThreadsAccountInput,
  RegisterManagedThreadsAccountInput,
  ReplaceManagedThreadsTokenInput,
} from '../shared/managed-threads';
import { useToast } from './toast';

export interface ManagedThreadsViewState {
  accounts: ManagedThreadsAccountRow[];
  busy: boolean;
  loaded: boolean;
}

/** Keeps stale IPC responses from restoring account metadata after the service lock closes. */
export function createManagedThreadsController(
  api: ManagedThreadsMethods,
  effects: {
    notify(message: string, error?: boolean): void;
    onSyncing(working: boolean): void;
  },
) {
  const emptyMetadata = { accounts: [] };
  let state: ManagedThreadsViewState = { ...emptyMetadata, busy: false, loaded: false };
  let enabled = false;
  let pending = false;
  let generation = 0;
  let reportedBusy = false;
  const listeners = new Set<() => void>();
  function update(next: Partial<ManagedThreadsViewState>) {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener());
  }
  function reportBusy(value: boolean) {
    if (reportedBusy === value) return;
    reportedBusy = value;
    effects.onSyncing(value);
  }
  async function run(action: () => Promise<ManagedThreadsResult>, message?: string) {
    if (!enabled || pending) return false;
    const request = generation;
    pending = true;
    update({ busy: true });
    reportBusy(true);
    try {
      const result = await action();
      if (!enabled || request !== generation) return false;
      const authChanged = ['AUTH_CHANGED', 'AUTH_REQUIRED'].includes(result.problem?.code ?? '');
      update({
        accounts: authChanged ? [] : result.accounts,
        loaded: true,
      });
      if (result.status !== 'ok') {
        effects.notify(result.problem?.message ?? '계정 정보를 저장하지 못했습니다.', true);
        return false;
      }
      if (message) effects.notify(message);
      return true;
    } catch {
      if (enabled && request === generation) {
        update({ loaded: true });
        effects.notify('계정 정보를 확인하지 못했습니다. 서버 연결을 확인해 주세요.', true);
      }
      return false;
    } finally {
      pending = false;
      update({ busy: false });
      reportBusy(false);
      // Reconnection reads the current server state. It never retries a pending write.
      if (enabled && request !== generation) void synchronize();
    }
  }
  function synchronize(showNotice = false) {
    return run(
      () => api.getManagedThreadsAccounts(),
      showNotice ? '서버의 최신 계정 정보를 이 PC와 동기화했습니다.' : undefined,
    );
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setEnabled(value: boolean) {
      if (enabled === value) return;
      enabled = value;
      generation += 1;
      if (!value) {
        update({ ...emptyMetadata, loaded: false, busy: false });
        reportBusy(false);
      } else {
        if (pending) {
          update({ busy: true });
          reportBusy(true);
        } else void synchronize();
      }
    },
    synchronize,
    register(input: RegisterManagedThreadsAccountInput) {
      return run(
        () => api.registerManagedThreadsAccount(input),
        '계정 정보를 암호화하여 저장했습니다. 토큰 확인은 휴대폰에서 진행합니다.',
      );
    },
    replace(input: ReplaceManagedThreadsTokenInput) {
      return run(
        () => api.replaceManagedThreadsToken(input),
        '새 토큰을 암호화하여 저장했습니다. 휴대폰에서 다시 확인해 주세요.',
      );
    },
    remove(input: DeleteManagedThreadsAccountInput) {
      return run(
        () => api.deleteManagedThreadsAccount(input),
        '계정 연결을 삭제했습니다. 실제 Threads 계정·게시글과 완료 이력은 유지됩니다.',
      );
    },
    retry(input: PendingManagedThreadsAccountInput) {
      return run(
        () => api.retryManagedThreadsAccount(input),
        '보류된 계정 정보를 서버에 저장했습니다.',
      );
    },
    discard(input: PendingManagedThreadsAccountInput) {
      return run(
        () => api.discardPendingManagedThreadsAccount(input),
        '이 PC의 보류된 변경을 버렸습니다. 서버에 저장된 토큰은 유지됩니다.',
      );
    },
  };
}

export function useManagedThreads(enabled: boolean, onSyncing?: (working: boolean) => void) {
  const notify = useToast();
  const effects = useRef({ notify, onSyncing });
  effects.current = { notify, onSyncing };
  const [controller] = useState(() =>
    createManagedThreadsController(
      {
        getManagedThreadsAccounts: () => window.threadsMedia.getManagedThreadsAccounts(),
        registerManagedThreadsAccount: (input) =>
          window.threadsMedia.registerManagedThreadsAccount(input),
        replaceManagedThreadsToken: (input) =>
          window.threadsMedia.replaceManagedThreadsToken(input),
        deleteManagedThreadsAccount: (input) =>
          window.threadsMedia.deleteManagedThreadsAccount(input),
        retryManagedThreadsAccount: (input) =>
          window.threadsMedia.retryManagedThreadsAccount(input),
        discardPendingManagedThreadsAccount: (input) =>
          window.threadsMedia.discardPendingManagedThreadsAccount(input),
      },
      {
        notify: (message, error) => effects.current.notify({ message, error }),
        onSyncing: (working) => effects.current.onSyncing?.(working),
      },
    ),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    controller.setEnabled(enabled);
    return () => controller.setEnabled(false);
  }, [controller, enabled]);
  return { ...state, ...controller };
}
