import { useCallback, useEffect, useState } from 'react';
import type { DraftNote, PostDraft } from '../shared/contracts';
import { useToast } from './toast';

const emptyNote: DraftNote = { accountId: null, translation: null, commentTranslation: null };

/** What this PC recorded for the opened draft; a post without a draft has nothing to read. */
export function useDraftNote(postKey: string, draft: PostDraft | undefined) {
  const notify = useToast();
  const [state, setState] = useState<{ key: string; note: DraftNote } | null>(null);
  const [version, setVersion] = useState(0);
  const key = draft ? JSON.stringify([postKey, draft.createdAt, draft.revision, version]) : '';
  useEffect(() => {
    if (!key) return;
    let current = true;
    window.threadsMedia
      .getDraftNote({ postKey })
      .then((result) => {
        if (!current) return;
        if (result.status === 'error') notify({ message: result.problem.message, error: true });
        setState({ key, note: result.status === 'ok' ? result.note : emptyNote });
      })
      .catch(() => {
        if (!current) return;
        notify({ message: '이 PC의 계정 기록을 읽지 못했습니다.', error: true });
        setState({ key, note: emptyNote });
      });
    return () => {
      current = false;
    };
  }, [key, postKey, notify]);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  if (!draft) return { note: emptyNote, loaded: true, reload };
  return state?.key === key
    ? { note: state.note, loaded: true, reload }
    : { note: emptyNote, loaded: false, reload };
}
