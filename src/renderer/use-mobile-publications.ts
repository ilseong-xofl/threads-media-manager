import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type {
  MobilePublicationMethods,
  MobilePublicationsResult,
  RecallMobilePublicationInput,
  SendMobilePublicationInput,
} from '../shared/mobile-publications';
import { useToast } from './toast';

export interface MobilePublicationsView {
  publications: MobilePublicationsResult['publications'];
  pending: MobilePublicationsResult['pending'];
  loaded: boolean;
  busy: boolean;
  working: boolean;
}

/** A read or reconnection can discover an interrupted send, but can never resume it. */
export function createMobilePublicationsController(
  api: MobilePublicationMethods,
  effects: { notify(message: string, error?: boolean): void; onWorking(working: boolean): void },
) {
  const empty = { publications: [], pending: [], loaded: false };
  let state: MobilePublicationsView = { ...empty, busy: false, working: false };
  let enabled = false;
  let postKey = '';
  let scope = '';
  let generation = 0;
  let active = false;
  const listeners = new Set<() => void>();
  function update(next: Partial<MobilePublicationsView>) {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener());
  }
  async function run(
    action: () => Promise<MobilePublicationsResult>,
    message?: string,
    mutation = false,
  ) {
    if (!enabled || active || !postKey) return false;
    active = true;
    const requested = generation;
    const requestedPost = postKey;
    update({ busy: true, working: mutation });
    if (mutation) effects.onWorking(true);
    try {
      const result = await action();
      if (!enabled || requested !== generation) return false;
      const authChanged = ['AUTH_CHANGED', 'AUTH_REQUIRED'].includes(result.problem?.code ?? '');
      update({
        publications: authChanged
          ? []
          : result.publications.filter((item) => item.source.postKey === requestedPost),
        pending: authChanged
          ? []
          : result.pending.filter((item) => item.source.postKey === requestedPost),
        loaded: !authChanged,
      });
      if (result.status !== 'ok') {
        effects.notify(result.problem?.message ?? '모바일 게시 정보를 확인하지 못했습니다.', true);
        return false;
      }
      if (message) effects.notify(message);
      return true;
    } catch {
      if (enabled && requested === generation)
        effects.notify('모바일 게시 정보를 확인하지 못했습니다. 서버 연결을 확인해 주세요.', true);
      return false;
    } finally {
      active = false;
      update({ busy: false, working: false });
      if (mutation) effects.onWorking(false);
      if (enabled && requested !== generation) void synchronize();
    }
  }
  function synchronize(showNotice = false) {
    return run(
      () => api.getMobilePublications({ postKey }),
      showNotice ? '모바일 게시 상태를 확인했습니다.' : undefined,
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
    setContext(nextPostKey: string, nextScope: string, nextEnabled: boolean) {
      if (postKey === nextPostKey && scope === nextScope && enabled === nextEnabled) return;
      postKey = nextPostKey;
      scope = nextScope;
      enabled = nextEnabled;
      generation += 1;
      update({ ...empty, busy: active, working: state.working && active });
      if (enabled && !active) void synchronize();
    },
    synchronize,
    send(input: SendMobilePublicationInput) {
      if (input.postKey !== postKey) return Promise.resolve(false);
      return run(() => api.sendMobilePublication(input), '모바일 게시 대기로 전송했습니다.', true);
    },
    retry(requestId: string) {
      return run(
        () => api.retryMobilePublication({ requestId }),
        '모바일 게시 대기로 전송했습니다.',
        true,
      );
    },
    cancelPending(requestId: string) {
      return run(
        () => api.cancelPendingMobilePublication({ requestId }),
        '보류된 전송을 취소했습니다. 로컬 등록 글은 유지됩니다.',
        true,
      );
    },
    recall(input: RecallMobilePublicationInput) {
      return run(
        () => api.recallMobilePublication(input),
        input.abandonUnresolved
          ? '등록 작업을 삭제했습니다. 실제 Threads 등록 여부는 변경하지 않았으며 이력은 보존했습니다.'
          : '게시 대기를 회수했습니다. 로컬에서 수정한 뒤 다시 보낼 수 있습니다.',
        true,
      );
    },
  };
}

export function useMobilePublications(
  postKey: string,
  scope: string,
  enabled: boolean,
  onWorking?: (working: boolean) => void,
) {
  const notify = useToast();
  const effects = useRef({ notify, onWorking });
  effects.current = { notify, onWorking };
  const [controller] = useState(() =>
    createMobilePublicationsController(
      {
        getMobilePublications: (input) => window.threadsMedia.getMobilePublications(input),
        sendMobilePublication: (input) => window.threadsMedia.sendMobilePublication(input),
        retryMobilePublication: (input) => window.threadsMedia.retryMobilePublication(input),
        cancelPendingMobilePublication: (input) =>
          window.threadsMedia.cancelPendingMobilePublication(input),
        recallMobilePublication: (input) => window.threadsMedia.recallMobilePublication(input),
      },
      {
        notify: (message, error) => effects.current.notify({ message, error }),
        onWorking: (working) => effects.current.onWorking?.(working),
      },
    ),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    controller.setContext(postKey, scope, enabled);
    return () => controller.setContext('', '', false);
  }, [controller, postKey, scope, enabled]);
  return { ...state, ...controller };
}

export type MobilePublicationsUi = ReturnType<typeof useMobilePublications>;
