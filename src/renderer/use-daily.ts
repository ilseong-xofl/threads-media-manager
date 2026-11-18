import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type {
  CancelDailySendInput,
  DailyMethods,
  DailyResult,
  DailyView,
  SaveDailyPersonaInput,
} from '../shared/daily';
import { dailyNeedsTranslation } from './daily-model';
import { useToast } from './toast';

export interface DailyViewState {
  view: DailyView;
  loaded: boolean;
  /** A save, delete, send or cancel call is running. Only one runs at a time. */
  busy: boolean;
  /** The persona of the generation call this window started, until it returns. */
  generating: string | null;
  /** The post of the Korean rendering call this window started, until it returns. */
  translating: string | null;
  /** A Korean draft is being written in a persona's language. */
  composing: boolean;
}

/** `generate`, `translate` and `compose` are the long ChatGPT calls; one runs at a time. */
type CallKind = 'read' | 'write' | 'generate' | 'translate' | 'compose';

/**
 * Applies every mutation result's view and ignores late answers: results from before a
 * re-enable, and reads overtaken by a mutation that finished after the read started.
 */
export function createDailyController(
  api: DailyMethods,
  effects: { notify(message: string, error?: boolean): void },
) {
  let state: DailyViewState = {
    view: {
      personas: [],
      posts: [],
      generatingPersonaId: null,
      translatingPostId: null,
      unsyncedPersonas: 0,
    },
    loaded: false,
    busy: false,
    generating: null,
    translating: null,
    composing: false,
  };
  let enabled = false;
  let generation = 0;
  let reading = false;
  let readAgain = false;
  let finishedChanges = 0;
  const listeners = new Set<() => void>();
  function update(next: Partial<DailyViewState>) {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener());
  }
  const mark = (kind: CallKind, id: string | null): Partial<DailyViewState> =>
    kind === 'write'
      ? { busy: id !== null }
      : kind === 'generate'
        ? { generating: id }
        : kind === 'translate'
          ? { translating: id }
          : { composing: id !== null };
  async function call(kind: CallKind, action: () => Promise<DailyResult>, id = '') {
    if (!enabled) return false;
    if (kind === 'read' && reading) {
      readAgain = true;
      return false;
    }
    if (kind === 'write' && state.busy) return false;
    if (
      kind !== 'read' &&
      kind !== 'write' &&
      (state.generating !== null || state.translating !== null || state.composing)
    )
      return false;
    const request = generation;
    const changesBefore = finishedChanges;
    if (kind === 'read') reading = true;
    else update(mark(kind, id));
    let failed = false;
    try {
      const result = await action();
      if (kind !== 'read') finishedChanges += 1;
      if (!enabled || request !== generation) return false;
      if (kind === 'read' && finishedChanges !== changesBefore) return false;
      update({ view: result.view, loaded: true });
      if (result.status !== 'ok') {
        effects.notify(result.problem?.message ?? '일상 작업을 마치지 못했습니다.', true);
        return false;
      }
      return true;
    } catch {
      failed = true;
      if (kind !== 'read') finishedChanges += 1;
      if (enabled && request === generation) {
        update({ loaded: true });
        effects.notify(
          kind === 'read'
            ? '일상 정보를 불러오지 못했습니다. 잠시 후 다시 시도하세요.'
            : '일상 작업 결과를 확인하지 못했습니다. 보드의 상태를 다시 확인하세요.',
          true,
        );
      }
      return false;
    } finally {
      if (kind === 'read') reading = false;
      else update(mark(kind, null));
      if (enabled) {
        if (kind === 'read') {
          if (readAgain) {
            readAgain = false;
            void refresh();
          }
        } else if (failed || request !== generation) void refresh();
      }
    }
  }
  function refresh() {
    return call('read', () => api.getDaily());
  }
  function translate(postId: string) {
    return call('translate', () => api.translateDailyPost({ postId }), postId);
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
      readAgain = false;
      if (value) void refresh();
    },
    refresh,
    savePersona(input: SaveDailyPersonaInput) {
      return call('write', () => api.saveDailyPersona(input));
    },
    deletePersona(personaId: string) {
      return call('write', () => api.deleteDailyPersona({ personaId }));
    },
    generate(personaId: string) {
      return call('generate', () => api.generateDailyPosts({ personaId }), personaId);
    },
    /** Adds a draft the user wrote; `fromKorean` has it written in the persona's language. */
    async addPost(personaId: string, text: string, fromKorean: boolean) {
      const known = new Set(state.view.posts.map((post) => post.id));
      const added = await call(fromKorean ? 'compose' : 'write', () =>
        api.addDailyPost({ personaId, text, fromKorean }),
      );
      // A post typed in another language has no Korean rendering yet.
      const post = state.view.posts.find((item) => !known.has(item.id));
      if (added && post && dailyNeedsTranslation(state.view, post.id)) void translate(post.id);
      return added;
    },
    async savePost(postId: string, text: string) {
      const saved = await call('write', () => api.saveDailyPost({ postId, text }));
      // An edited post in another language lost its Korean rendering; write it again.
      if (saved && dailyNeedsTranslation(state.view, postId)) void translate(postId);
      return saved;
    },
    translate,
    deletePost(postId: string) {
      return call('write', () => api.deleteDailyPost({ postId }));
    },
    send(postId: string) {
      return call('write', () => api.sendDailyPost({ postId }));
    },
    cancel(input: CancelDailySendInput) {
      return call('write', () => api.cancelDailySend(input));
    },
  };
}

export type DailyController = ReturnType<typeof createDailyController>;

export function useDaily(enabled: boolean) {
  const notify = useToast();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const [controller] = useState(() =>
    createDailyController(
      {
        getDaily: () => window.threadsMedia.getDaily(),
        saveDailyPersona: (input) => window.threadsMedia.saveDailyPersona(input),
        deleteDailyPersona: (input) => window.threadsMedia.deleteDailyPersona(input),
        generateDailyPosts: (input) => window.threadsMedia.generateDailyPosts(input),
        addDailyPost: (input) => window.threadsMedia.addDailyPost(input),
        saveDailyPost: (input) => window.threadsMedia.saveDailyPost(input),
        translateDailyPost: (input) => window.threadsMedia.translateDailyPost(input),
        deleteDailyPost: (input) => window.threadsMedia.deleteDailyPost(input),
        sendDailyPost: (input) => window.threadsMedia.sendDailyPost(input),
        cancelDailySend: (input) => window.threadsMedia.cancelDailySend(input),
      },
      { notify: (message, error) => notifyRef.current({ message, error }) },
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
  return {
    ...state,
    ...controller,
    /** The persona being generated, by this window's call or by the main process. */
    generatingPersonaId: state.generating ?? state.view.generatingPersonaId,
    /** The post whose Korean rendering is being written, by this window or the main process. */
    translatingPostId: state.translating ?? state.view.translatingPostId,
    /** ChatGPT is writing something; one such call runs at a time and nothing is edited meanwhile. */
    writing:
      state.generating !== null ||
      state.translating !== null ||
      state.composing ||
      state.view.generatingPersonaId !== null ||
      state.view.translatingPostId !== null,
    /** A call that must finish before an update restart. */
    working:
      state.busy || state.generating !== null || state.translating !== null || state.composing,
  };
}

export type DailyState = ReturnType<typeof useDaily>;
