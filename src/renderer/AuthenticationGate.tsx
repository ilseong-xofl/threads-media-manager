import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { AppAuthState } from '../shared/service-auth';
import { ACCOUNT_PASSWORD_MAX_LENGTH, ACCOUNT_PASSWORD_MIN_LENGTH } from '../shared/service-auth';
import { App } from './App';
import { useToast } from './toast';
import './authentication.css';

export function AuthenticationGate() {
  const [state, setState] = useState<AppAuthState | null>(null);
  const [mountedUser, setMountedUser] = useState<string | null>(null);
  const [accountId, setAccountId] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const notify = useToast();
  const online = useRef(navigator.onLine);
  const lockDialog = useRef<HTMLDialogElement>(null);
  const accept = useCallback((value: AppAuthState) => {
    // A completed earlier request must not unlock an explicitly offline renderer.
    if (!online.current) {
      setState({
        status: 'blocked',
        reason: 'service',
        message: '인터넷 연결이 끊어졌습니다. 연결 후 다시 확인하세요.',
      });
      return;
    }
    setState(value);
    if (value.status === 'authenticated' && !value.mustChangePassword)
      setMountedUser(value.user.id);
    if (value.status === 'signed-out') setMountedUser(null);
  }, []);
  const refresh = useCallback(async () => {
    try {
      accept(await window.threadsMedia.getAuthState());
    } catch {
      accept({
        status: 'blocked',
        reason: 'service',
        message: '서비스 연결을 확인하지 못했습니다.',
      });
    }
  }, [accept]);
  useEffect(() => {
    void refresh();
    const unsubscribe = window.threadsMedia.onAuthStateChanged(accept);
    const network = () => {
      online.current = navigator.onLine;
      if (!online.current)
        accept({ status: 'blocked', reason: 'service', message: '인터넷 연결이 끊어졌습니다.' });
      else void refresh();
    };
    const timer = window.setInterval(() => void refresh(), 60_000);
    window.addEventListener('online', network);
    window.addEventListener('offline', network);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener('online', network);
      window.removeEventListener('offline', network);
    };
  }, [refresh, accept]);
  const unlocked = state?.status === 'authenticated' && !state.mustChangePassword;
  useEffect(() => {
    if (!unlocked || changing) {
      document
        .querySelectorAll('video,audio')
        .forEach((element) => (element as HTMLMediaElement).pause());
      void window.threadsMedia.reportUpdateBlocked(true).catch(() => {});
    }
  }, [unlocked, changing]);
  async function signIn(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      accept(await window.threadsMedia.signIn(accountId, password));
      setPassword('');
    } catch {
      notify({
        error: true,
        message: '로그인하지 못했습니다. 아이디·비밀번호와 서비스 연결을 확인하세요.',
      });
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    setBusy(true);
    try {
      accept(await window.threadsMedia.signOut());
      setChanging(false);
      setPassword('');
      setNewPassword('');
    } catch {
      notify({ error: true, message: '로그아웃하지 못했습니다. 다시 시도하세요.' });
    } finally {
      setBusy(false);
    }
  }
  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      accept(await window.threadsMedia.changePassword(password, newPassword));
      setPassword('');
      setNewPassword('');
      setChanging(false);
      notify({ message: '비밀번호를 변경했습니다. 새 비밀번호로 로그인하세요.' });
    } catch {
      notify({
        error: true,
        message: '비밀번호를 변경하지 못했습니다. 현재 비밀번호와 연결 상태를 확인하세요.',
      });
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const element = lockDialog.current;
    if (!element) return;
    if (!unlocked || changing) {
      if (!element.open) element.showModal();
    } else if (element.open) element.close();
  }, [unlocked, changing]);
  const passwordRequired = state?.status === 'authenticated' && state.mustChangePassword;
  return (
    <>
      {/* Preserve an open draft during temporary service failure; no protected UI remains visible. */}
      {mountedUser && (
        <div hidden={!unlocked || changing} inert={!unlocked || changing}>
          <App
            key={mountedUser}
            serviceAvailable={!!unlocked && !changing}
            displayName={state?.status === 'authenticated' ? state.user.displayName : ''}
            accountBusy={busy}
            onChangePassword={() => {
              setPassword('');
              setNewPassword('');
              setChanging(true);
            }}
            onSignOut={() => void signOut()}
          />
        </div>
      )}
      <dialog
        ref={lockDialog}
        className="service-auth-lock"
        onCancel={(event) => event.preventDefault()}
      >
        <main className="service-auth-screen">
          <section className="service-auth-card" aria-label="서비스 로그인">
            <p className="service-auth-brand">Threads Media Manager</p>
            {!state ? (
              <p role="status">서비스 연결 확인 중…</p>
            ) : passwordRequired || changing ? (
              <>
                <h1>비밀번호 변경</h1>
                <p>
                  {passwordRequired
                    ? '초기 비밀번호를 변경한 뒤 사용할 수 있습니다.'
                    : '변경 후 모든 기기에서 다시 로그인해야 합니다.'}
                </p>
                <form onSubmit={(event) => void changePassword(event)}>
                  <label>
                    현재 비밀번호
                    <input
                      type="password"
                      autoComplete="current-password"
                      required
                      value={password}
                      maxLength={ACCOUNT_PASSWORD_MAX_LENGTH}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </label>
                  <label>
                    새 비밀번호
                    <input
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={ACCOUNT_PASSWORD_MIN_LENGTH}
                      maxLength={ACCOUNT_PASSWORD_MAX_LENGTH}
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                    />
                  </label>
                  <button className="primary" disabled={busy} type="submit">
                    {busy ? '변경 중…' : '비밀번호 변경'}
                  </button>
                </form>
                {changing && !passwordRequired && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      setChanging(false);
                      setPassword('');
                      setNewPassword('');
                    }}
                  >
                    취소
                  </button>
                )}
                <button disabled={busy} onClick={() => void signOut()}>
                  로그아웃
                </button>
              </>
            ) : state.status === 'blocked' ? (
              <>
                <h1>앱 사용이 잠겨 있습니다</h1>
                <p>{state.message}</p>
                <button className="primary" disabled={busy} onClick={() => void refresh()}>
                  연결 다시 확인
                </button>
                <button disabled={busy} onClick={() => void signOut()}>
                  로그아웃
                </button>
              </>
            ) : (
              <>
                <h1>로그인</h1>
                <p>관리자가 발급한 아이디로 로그인하세요.</p>
                <form onSubmit={(event) => void signIn(event)}>
                  <label>
                    아이디
                    <input
                      autoComplete="username"
                      value={accountId}
                      maxLength={64}
                      required
                      onChange={(event) => setAccountId(event.target.value)}
                    />
                  </label>
                  <label>
                    비밀번호
                    <input
                      type="password"
                      autoComplete="current-password"
                      required
                      value={password}
                      maxLength={ACCOUNT_PASSWORD_MAX_LENGTH}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </label>
                  <button className="primary" type="submit" disabled={busy}>
                    {busy ? '로그인 중…' : '로그인'}
                  </button>
                </form>
              </>
            )}
          </section>
        </main>
      </dialog>
    </>
  );
}
