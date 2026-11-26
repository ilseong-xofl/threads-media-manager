import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeleteMentInput, MentCatalog, MentResult, SaveMentInput } from '../shared/ments';
import { useToast } from './toast';

export interface MentsState {
  /** Null until the first read succeeds. */
  catalog: MentCatalog | null;
  loading: boolean;
  /** A save or a delete is running; one at a time. */
  busy: boolean;
  load(): Promise<void>;
  save(input: SaveMentInput): Promise<boolean>;
  remove(input: DeleteMentInput): Promise<boolean>;
}

/**
 * The ment catalog for picking a ment while a post is written: read once when `enabled`, and null
 * until then. Picking is optional, so a failure only leaves it null and the post is written as
 * before (a lost login still reaches the app's access check in the main process). The setter takes
 * the catalog a save sends back.
 */
export function useMentCatalog(
  enabled: boolean,
): readonly [MentCatalog | null, (catalog: MentCatalog) => void] {
  const [catalog, setCatalog] = useState<MentCatalog | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    window.threadsMedia.getMents().then(
      (result) => {
        if (live && result.catalog) setCatalog(result.catalog);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [enabled]);
  return [catalog, setCatalog] as const;
}

/**
 * The ment catalog while the management window is open. It is read when the window opens and
 * after every change; failures go to the toast. `onUnavailable` closes the window when the server
 * has no catalog yet.
 */
export function useMents(onUnavailable: () => void): MentsState {
  const notify = useToast();
  const [catalog, setCatalog] = useState<MentCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const unavailable = useRef(onUnavailable);
  // An answer that comes back after the window closed changes nothing: by then the board may show
  // another window, which closing this one must not take away.
  const open = useRef(false);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  useEffect(() => {
    unavailable.current = onUnavailable;
  }, [onUnavailable]);
  const accept = useCallback(
    (result: MentResult) => {
      if (!open.current) return false;
      if (result.catalog) setCatalog(result.catalog);
      if (result.status === 'ok') return true;
      notify({ message: result.problem?.message ?? '멘트 작업을 마치지 못했습니다.', error: true });
      if (result.problem?.code === 'MENT_UNAVAILABLE') unavailable.current();
      return false;
    },
    [notify],
  );
  const load = useCallback(async () => {
    setLoading(true);
    try {
      accept(await window.threadsMedia.getMents());
    } catch {
      if (open.current)
        notify({ message: '멘트를 불러오지 못했습니다. 잠시 후 다시 시도하세요.', error: true });
    } finally {
      setLoading(false);
    }
  }, [accept, notify]);
  useEffect(() => {
    void load();
  }, [load]);
  const change = useCallback(
    async (action: () => Promise<MentResult>) => {
      setBusy(true);
      try {
        return accept(await action());
      } catch {
        if (open.current)
          notify({
            message: '멘트 작업 결과를 확인하지 못했습니다. 목록을 다시 불러옵니다.',
            error: true,
          });
        // Still busy until the list is back, so no later change can be overwritten by it.
        await load();
        return false;
      } finally {
        setBusy(false);
      }
    },
    [accept, load, notify],
  );
  const save = useCallback(
    (input: SaveMentInput) => change(() => window.threadsMedia.saveMent(input)),
    [change],
  );
  const remove = useCallback(
    (input: DeleteMentInput) => change(() => window.threadsMedia.deleteMent(input)),
    [change],
  );
  return { catalog, loading, busy, load, save, remove };
}
