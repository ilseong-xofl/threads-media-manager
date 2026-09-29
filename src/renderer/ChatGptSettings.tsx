import { useEffect, useRef, useState } from 'react';
import type { ChatGptResult, ChatGptState } from '../shared/contracts';
import type { ToastNotice } from './toast-store';
import { useToast } from './toast';

type ChatGptApi = {
  chatGptState(): Promise<ChatGptState>;
  loginChatGpt(): Promise<ChatGptResult>;
  cancelChatGptLogin(): Promise<ChatGptResult>;
  logoutChatGpt(): Promise<ChatGptResult>;
};
type Operation = 'checking' | 'login' | 'logout' | 'cancel';
export type ChatGptSettingsSnapshot = {
  state: ChatGptState | null;
  operation: Operation | null;
};

/** Ignore late replies after cancellation or closing this settings view. */
export function createChatGptSettingsSession(
  api: ChatGptApi,
  update: (snapshot: ChatGptSettingsSnapshot) => void,
  notify: (notice: ToastNotice) => void,
) {
  let snapshot: ChatGptSettingsSnapshot = { state: null, operation: null };
  let disposed = false;
  let revision = 0;
  const publish = (next: ChatGptSettingsSnapshot) => {
    snapshot = next;
    if (!disposed) update(next);
  };
  const error = () =>
    notify({ error: true, message: 'ChatGPT 연결 상태를 확인하지 못했습니다. 다시 시도하세요.' });
  async function refresh() {
    if (disposed || snapshot.operation) return;
    const request = ++revision;
    publish({ ...snapshot, operation: 'checking' });
    try {
      const state = await api.chatGptState();
      if (disposed || request !== revision) return;
      publish({ state, operation: null });
      if (state.problem) notify({ error: true, message: state.problem.message });
    } catch {
      if (!disposed && request === revision) {
        publish({ ...snapshot, operation: null });
        error();
      }
    }
  }
  async function run(operation: Exclude<Operation, 'checking'>) {
    if (disposed) return;
    if (operation === 'cancel') {
      if (
        snapshot.operation === 'cancel' ||
        (snapshot.operation !== 'login' && snapshot.state?.status !== 'signing_in')
      )
        return;
    } else if (snapshot.operation || snapshot.state?.status === 'signing_in') return;
    const request = ++revision;
    publish({ ...snapshot, operation });
    try {
      const result = await (operation === 'login'
        ? api.loginChatGpt()
        : operation === 'logout'
          ? api.logoutChatGpt()
          : api.cancelChatGptLogin());
      if (disposed || request !== revision) return;
      publish({ state: result.state, operation: null });
      if (result.status === 'error') notify({ error: true, message: result.problem.message });
      else if (
        result.status === 'ok' &&
        operation === 'login' &&
        result.state.status === 'signed_in'
      )
        notify({ message: 'ChatGPT에 연결했습니다. AI 캡션을 생성할 수 있습니다.' });
      else if (
        result.status === 'ok' &&
        operation === 'logout' &&
        result.state.status === 'signed_out'
      )
        notify({ message: '이 앱의 ChatGPT 계정에서 로그아웃했습니다.' });
    } catch {
      if (!disposed && request === revision) {
        publish({ ...snapshot, operation: null });
        error();
      }
    }
  }
  return {
    refresh,
    login: () => run('login'),
    logout: () => run('logout'),
    cancel: () => run('cancel'),
    dispose() {
      disposed = true;
      revision += 1;
      if (
        snapshot.operation === 'login' ||
        snapshot.operation === 'cancel' ||
        snapshot.state?.status === 'signing_in'
      )
        void api.cancelChatGptLogin().catch(() => {});
    },
  };
}

export function ChatGptSettingsControls({
  snapshot,
  enabled,
  onLogin,
  onLogout,
  onRefresh,
  onCancel,
}: {
  snapshot: ChatGptSettingsSnapshot;
  enabled: boolean;
  onLogin(): void;
  onLogout(): void;
  onRefresh(): void;
  onCancel(): void;
}) {
  const { state, operation } = snapshot;
  const waiting = operation === 'login' || operation === 'cancel' || state?.status === 'signing_in';
  const disabled = !enabled || !!operation;
  const status = waiting
    ? operation === 'cancel'
      ? '로그인 취소 중…'
      : '로그인 기다리는 중…'
    : operation === 'checking'
      ? '연결 상태 확인 중…'
      : operation === 'logout'
        ? '로그아웃 중…'
        : state?.status === 'signed_in'
          ? '연결됨'
          : state?.status === 'signed_out'
            ? '로그인 필요'
            : state?.status === 'unavailable'
              ? '연결 확인 필요'
              : '연결 상태 확인 필요';
  return (
    <section className="settings-section threads-settings" aria-labelledby="chatgpt-settings-title">
      <div className="threads-section-heading">
        <h3 id="chatgpt-settings-title">ChatGPT · AI 캡션</h3>
        <span role="status">{status}</span>
      </div>
      <p>ChatGPT 계정으로 로그인하면 선택한 이미지와 원문으로 AI 캡션을 만들 수 있습니다.</p>
      {waiting ? (
        <>
          <p>브라우저에서 로그인을 완료해 주세요. 이 창을 닫으면 로그인을 취소합니다.</p>
          <div className="threads-actions">
            <button type="button" disabled={operation === 'cancel'} onClick={onCancel}>
              {operation === 'cancel' ? '취소 중…' : '로그인 취소'}
            </button>
            {!operation && (
              <button type="button" disabled={!enabled} onClick={onRefresh}>
                연결 상태 확인
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="threads-actions">
          {state?.status === 'signed_in' ? (
            <button type="button" disabled={disabled} onClick={onLogout}>
              로그아웃
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={disabled || state?.status !== 'signed_out'}
              onClick={onLogin}
            >
              ChatGPT 로그인
            </button>
          )}
          <button type="button" disabled={disabled} onClick={onRefresh}>
            연결 상태 다시 확인
          </button>
        </div>
      )}
    </section>
  );
}

export function ChatGptSettings({ enabled }: { enabled: boolean }) {
  const [snapshot, setSnapshot] = useState<ChatGptSettingsSnapshot>({
    state: null,
    operation: null,
  });
  const session = useRef<ReturnType<typeof createChatGptSettingsSession> | null>(null);
  const notify = useToast();
  useEffect(() => {
    const current = createChatGptSettingsSession(window.threadsMedia, setSnapshot, notify);
    session.current = current;
    void current.refresh();
    return () => {
      session.current = null;
      current.dispose();
    };
  }, [notify]);
  return (
    <ChatGptSettingsControls
      snapshot={snapshot}
      enabled={enabled}
      onLogin={() => {
        if (enabled) void session.current?.login();
      }}
      onLogout={() => {
        if (enabled) void session.current?.logout();
      }}
      onRefresh={() => {
        if (enabled) void session.current?.refresh();
      }}
      onCancel={() => void session.current?.cancel()}
    />
  );
}
