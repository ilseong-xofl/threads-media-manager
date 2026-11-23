import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type {
  CancelDailySendInput,
  DailyMethods,
  DailyReplyThread,
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
  /** The replies of the open replies window, once read. */
  replies: DailyReplyThread | null;
  /** The post whose replies this window is writing in Korean, until the call returns. */
  translatingReplies: string | null;
}

/**
 * `generate`, `translate`, `compose` and `translate-replies` are the long ChatGPT calls; one runs
 * at a time. `replies` reads the replies of the open window.
 */
type CallKind =
  'read' | 'write' | 'generate' | 'translate' | 'compose' | 'replies' | 'translate-replies';
const chatGpt = (kind: CallKind) =>
  kind === 'generate' || kind === 'translate' || kind === 'compose' || kind === 'translate-replies';

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
      translatingRepliesPostId: null,
      unsyncedPersonas: 0,
    },
    loaded: false,
    busy: false,
    generating: null,
    translating: null,
    composing: false,
    replies: null,
    translatingReplies: null,
  };
  /** The post of the open replies window; answers for another post are dropped. */
  let repliesPostId: string | null = null;
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
          : kind === 'translate-replies'
            ? { translatingReplies: id }
            : kind === 'compose'
              ? { composing: id !== null }
              : {};
  async function call(
    kind: CallKind,
    action: () => Promise<DailyResult & { thread?: DailyReplyThread | null }>,
    id = '',
  ) {
    if (!enabled) return false;
    const reads = kind === 'read' || kind === 'replies';
    if (kind === 'read' && reading) {
      readAgain = true;
      return false;
    }
    if (kind === 'write' && state.busy) return false;
    if (
      chatGpt(kind) &&
      (state.generating !== null ||
        state.translating !== null ||
        state.composing ||
        state.translatingReplies !== null)
    )
      return false;
    const request = generation;
    const changesBefore = finishedChanges;
    if (kind === 'read') reading = true;
    else update(mark(kind, id));
    let failed = false;
    try {
      const result = await action();
      if (!reads) finishedChanges += 1;
      if (!enabled || request !== generation) return false;
      // Replies are read from the server as they are; only the board view can be overtaken.
      if (result.thread && result.thread.postId === repliesPostId)
        update({ replies: result.thread });
      if (!reads || finishedChanges === changesBefore) update({ view: result.view, loaded: true });
      else if (kind === 'read') return false;
      if (result.status !== 'ok') {
        effects.notify(result.problem?.message ?? '일상 작업을 마치지 못했습니다.', true);
        return false;
      }
      return true;
    } catch {
      failed = true;
      if (!reads) finishedChanges += 1;
      if (enabled && request === generation) {
        update({ loaded: true });
        effects.notify(
          kind === 'read'
            ? '일상 정보를 불러오지 못했습니다. 잠시 후 다시 시도하세요.'
            : kind === 'replies'
              ? '댓글을 불러오지 못했습니다. 잠시 후 다시 시도하세요.'
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
        } else if (kind !== 'replies' && (failed || request !== generation)) void refresh();
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
    /** Opens the replies window of a published post and reads its replies. */
    openReplies(postId: string) {
      repliesPostId = postId;
      update({ replies: null });
      return call('replies', () => api.getDailyReplies({ postId }));
    },
    closeReplies() {
      repliesPostId = null;
      update({ replies: null });
    },
    /** Every reply still without Korean, or with `threadsId` that one reply. */
    translateReplies(postId: string, threadsId?: string) {
      return call(
        'translate-replies',
        () => api.translateDailyReplies(threadsId ? { postId, threadsId } : { postId }),
        postId,
      );
    },
    /** Adds an answer draft to a reply; `fromKorean` has it written in the persona's language. */
    addAnswer(postId: string, replyThreadsId: string, text: string, fromKorean: boolean) {
      return call(fromKorean ? 'compose' : 'write', () =>
        api.addDailyAnswer({ postId, replyThreadsId, text, fromKorean }),
      );
    },
    saveAnswer(postId: string, answerId: string, text: string) {
      return call('write', () => api.saveDailyAnswer({ postId, answerId, text }));
    },
    deleteAnswer(postId: string, answerId: string) {
      return call('write', () => api.deleteDailyAnswer({ postId, answerId }));
    },
    /** Sends answers of one post to the phone, one by one; the first failure stops the rest. */
    sendAnswers(postId: string, answerIds: string[]) {
      return call('write', () => api.sendDailyAnswers({ postId, answerIds }));
    },
    cancelAnswer(postId: string, answerId: string) {
      return call('write', () => api.cancelDailyAnswer({ postId, answerId }));
    },
    async openReplyLink(postId: string, threadsId: string) {
      const result = await api.openDailyReplyLink({ postId, threadsId }).catch(() => null);
      if (result?.status !== 'ok')
        effects.notify(result?.problem?.message ?? 'Threads 링크를 열지 못했습니다.', true);
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
        getDailyReplies: (input) => window.threadsMedia.getDailyReplies(input),
        translateDailyReplies: (input) => window.threadsMedia.translateDailyReplies(input),
        openDailyReplyLink: (input) => window.threadsMedia.openDailyReplyLink(input),
        addDailyAnswer: (input) => window.threadsMedia.addDailyAnswer(input),
        saveDailyAnswer: (input) => window.threadsMedia.saveDailyAnswer(input),
        deleteDailyAnswer: (input) => window.threadsMedia.deleteDailyAnswer(input),
        sendDailyAnswers: (input) => window.threadsMedia.sendDailyAnswers(input),
        cancelDailyAnswer: (input) => window.threadsMedia.cancelDailyAnswer(input),
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
    /** The post whose replies are being written in Korean, by this window or the main process. */
    translatingRepliesPostId: state.translatingReplies ?? state.view.translatingRepliesPostId,
    /** ChatGPT is writing something; one such call runs at a time and nothing is edited meanwhile. */
    writing:
      state.generating !== null ||
      state.translating !== null ||
      state.composing ||
      state.translatingReplies !== null ||
      state.view.generatingPersonaId !== null ||
      state.view.translatingPostId !== null ||
      state.view.translatingRepliesPostId !== null,
    /** A call that must finish before an update restart. */
    working:
      state.busy ||
      state.generating !== null ||
      state.translating !== null ||
      state.composing ||
      state.translatingReplies !== null,
  };
}

export type DailyState = ReturnType<typeof useDaily>;
