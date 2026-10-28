import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type {
  DeleteManagedThreadsAccountInput,
  ManagedThreadsAccountRow,
  ManagedThreadsMethods,
  ManagedThreadsResult,
  ManagedThreadsTokenActionInput,
  PendingManagedThreadsAccountInput,
  RegisterManagedThreadsAccountInput,
  ReplaceManagedThreadsTokenInput,
  UpdateManagedThreadsAccountInput,
} from '../shared/managed-threads';
import { useToast } from './toast';

export interface ManagedThreadsViewState {
  accounts: ManagedThreadsAccountRow[];
  busy: boolean;
  loaded: boolean;
  /** Local-clock time when the next Meta token request is allowed; 0 when it already is. */
  cooldownUntil: number;
  refreshWindowDays: number;
}

/** Keeps stale IPC responses from restoring account metadata after the service lock closes. */
export function createManagedThreadsController(
  api: ManagedThreadsMethods,
  effects: {
    notify(message: string, error?: boolean): void;
    onSyncing(working: boolean): void;
  },
) {
  const emptyMetadata = { accounts: [], cooldownUntil: 0 };
  let state: ManagedThreadsViewState = {
    ...emptyMetadata,
    busy: false,
    loaded: false,
    refreshWindowDays: 14,
  };
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
      // Every result, including errors, carries the server's remaining Meta request interval.
      const wait = result.metaRequestRetryAfterSeconds;
      update({
        accounts: authChanged ? [] : result.accounts,
        loaded: true,
        cooldownUntil: Number.isFinite(wait) && wait > 0 ? Date.now() + wait * 1000 : 0,
        refreshWindowDays: result.refreshWindowDays,
      });
      if (result.status !== 'ok') {
        effects.notify(result.problem?.message ?? '계정 정보를 저장하지 못했습니다.', true);
        // The account was stored as "확인 필요", so the input form closes as on success.
        return result.problem?.code === 'TOKEN_CHECK_FAILED_SAVED';
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
        '토큰을 확인하고 계정 정보를 암호화하여 저장했습니다.',
      );
    },
    replace(input: ReplaceManagedThreadsTokenInput) {
      return run(
        () => api.replaceManagedThreadsToken(input),
        '새 토큰을 확인하고 암호화하여 저장했습니다.',
      );
    },
    update(input: UpdateManagedThreadsAccountInput) {
      return run(
        () => api.updateManagedThreadsAccount(input),
        '계정 정보를 수정했습니다. 토큰과 확인 상태는 그대로입니다.',
      );
    },
    recheck(input: ManagedThreadsTokenActionInput) {
      return run(
        () => api.recheckManagedThreadsAccount(input),
        '토큰을 다시 확인해 "확인됨"으로 저장했습니다.',
      );
    },
    refreshToken(input: ManagedThreadsTokenActionInput) {
      return run(
        () => api.refreshManagedThreadsToken(input),
        '토큰을 갱신하고 새 만료 일시를 저장했습니다.',
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
        updateManagedThreadsAccount: (input) =>
          window.threadsMedia.updateManagedThreadsAccount(input),
        recheckManagedThreadsAccount: (input) =>
          window.threadsMedia.recheckManagedThreadsAccount(input),
        refreshManagedThreadsToken: (input) =>
          window.threadsMedia.refreshManagedThreadsToken(input),
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
