import { useCallback, useEffect, useRef, useState } from 'react';
import type { ThreadsResult, ThreadsState } from '../shared/threads-api';
import { useToast } from './toast';

export interface ThreadsUi {
  state: ThreadsState | null;
  loading: boolean;
  working: boolean;
  error: string | null;
  refresh(): Promise<void>;
  run(action: () => Promise<ThreadsResult>): Promise<boolean>;
}

export function useThreadsApi(watch: boolean, contextKey = ''): ThreadsUi {
  const notify = useToast();
  const [saved, setSaved] = useState<{ scope: string; state: ThreadsState } | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const active = useRef(false);
  const reading = useRef(0);
  const alive = useRef(true);
  const generation = useRef(0);
  const scope = useRef(contextKey);
  scope.current = contextKey;
  const refresh = useCallback(async (force = false) => {
    if (reading.current && !force) return;
    const request = ++generation.current;
    const requestedScope = scope.current;
    reading.current = request;
    try {
      const next = await window.threadsMedia.threadsState();
      if (alive.current && generation.current === request) {
        setSaved({ scope: requestedScope, state: next });
        setReadError(null);
      }
    } catch {
      if (alive.current && generation.current === request)
        setReadError('Threads 연결 상태를 읽지 못했습니다. 다시 확인해 주세요.');
    } finally {
      if (reading.current === request) reading.current = 0;
      if (alive.current && generation.current === request) setLoading(false);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current += 1;
      reading.current = 0;
    };
  }, []);
  useEffect(() => {
    setLoading(true);
    setActionError(null);
    void refresh(true);
  }, [contextKey, refresh]);
  // Account-wide state remains useful, but history from another library must not flash in this one.
  const state = saved
    ? saved.scope === contextKey
      ? saved.state
      : { ...saved.state, publications: [] }
    : null;
  const working = pending || !!state?.busy || !!state?.syncing;
  useEffect(() => {
    if (!watch && !working) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [watch, working, refresh]);
  const run = useCallback(
    async (action: () => Promise<ThreadsResult>): Promise<boolean> => {
      if (active.current) return false;
      active.current = true;
      generation.current += 1;
      const requestedScope = scope.current;
      setPending(true);
      setActionError(null);
      try {
        const result = await action();
        generation.current += 1;
        if (!alive.current) return false;
        if (result.status === 'ok') {
          setSaved({ scope: requestedScope, state: result.state });
          return true;
        }
        if (result.status === 'error') {
          setActionError(result.problem.message);
          notify({ message: result.problem.message, error: true });
        }
        return false;
      } catch {
        if (alive.current) {
          const message = 'Threads 작업을 완료하지 못했습니다. 연결 상태를 확인해 주세요.';
          setActionError(message);
          notify({ message, error: true });
        }
        return false;
      } finally {
        // A failed request may still have created an uncertain publication in the main process.
        if (alive.current) await refresh(true);
        active.current = false;
        if (alive.current) setPending(false);
      }
    },
    [refresh, notify],
  );
  return {
    state,
    loading: loading || (!!saved && saved.scope !== contextKey),
    working,
    error: actionError ?? readError,
    refresh,
    run,
  };
}
