import { useRef, useState } from 'react';
import type { ThreadsUi } from './use-threads-api';
import { displayDate } from './view-model';
import { FileServerSettings } from './FileServerSettings';
import { useToast, useToastMessage } from './toast';
import './threads-api.css';

export function ThreadsAccountSettings({
  threads,
  enabled,
  onSyncing,
}: {
  threads: ThreadsUi;
  enabled: boolean;
  onSyncing?(working: boolean): void;
}) {
  const { state, loading, working } = threads;
  const [token, setToken] = useState('');
  const [editingAccount, setEditingAccount] = useState(false);
  const notify = useToast();
  const syncing = useRef(false);
  const disabled = !enabled || working || loading || !state;
  const account = state?.account;
  const expired = !!account && Date.parse(account.expiresAt) <= Date.now();
  const reconnect = expired || !!account?.requiresReconnect;
  const latest = (state?.recentPublications ?? [])
    .filter(
      (item) =>
        item.kind === 'post' && item.status === 'published' && item.accountId === account?.id,
    )
    .sort(
      (a, b) => Date.parse(b.publishedAt ?? b.createdAt) - Date.parse(a.publishedAt ?? a.createdAt),
    )
    .slice(0, 5);
  const errorMessage =
    threads.error ||
    state?.accountProblem?.message ||
    state?.problem?.message ||
    latest.find((item) => item.metricsProblem)?.metricsProblem?.message;
  useToastMessage(errorMessage, true);
  async function syncInsights() {
    if (syncing.current || disabled || !account || reconnect || !latest.length) return;
    syncing.current = true;
    onSyncing?.(true);
    try {
      const ok = await threads.run(() => window.threadsMedia.syncThreadsInsights());
      if (ok) notify({ message: '최근 게시글 통계를 조회했습니다.' });
    } finally {
      syncing.current = false;
      onSyncing?.(false);
    }
  }
  async function connect() {
    if (disabled) return;
    if (!token.trim()) {
      notify({ message: 'Meta에서 발급받은 API 토큰을 입력하세요.', error: true });
      return;
    }
    const accessToken = token.trim();
    const success = await threads.run(() =>
      window.threadsMedia.connectThreads({
        accessToken,
      }),
    );
    setToken('');
    if (success) {
      setEditingAccount(false);
      notify({ message: 'Threads 계정과 만료 일시를 확인하고 암호화하여 저장했습니다.' });
    }
  }
  return (
    <>
      <section
        className="settings-section threads-settings"
        aria-labelledby="threads-account-title"
      >
        <div className="threads-section-heading">
          <h3 id="threads-account-title">Threads 계정</h3>
          {loading && <span role="status">확인 중…</span>}
        </div>
        <p>
          API 토큰을 이 PC에 암호화하여 저장합니다. 앱 실행 중 만료 전에 자동 갱신하며, 앱이 꺼져
          있으면 다음 실행 때 확인합니다.
        </p>
        {account && (
          <div className="threads-account-summary">
            <div className="threads-account-heading">
              <div className="threads-account-identity">
                <strong>@{account.username}</strong>
                <span className={reconnect ? 'threads-error' : ''}>
                  {expired
                    ? '토큰 만료 · 다시 등록 필요'
                    : reconnect
                      ? '연결 해제됨 · 토큰 다시 등록 필요'
                      : '연결됨'}
                </span>
              </div>
              {!editingAccount && (
                <div className="threads-actions">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      setEditingAccount(true);
                    }}
                  >
                    토큰 교체
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      void threads
                        .run(() => window.threadsMedia.disconnectThreads())
                        .then((ok) => {
                          if (ok) {
                            setToken('');
                            notify({ message: '이 PC의 Threads 계정 연결을 해제했습니다.' });
                          }
                        });
                    }}
                  >
                    연결 해제
                  </button>
                </div>
              )}
            </div>
            <dl>
              <div>
                <dt>만료 일시</dt>
                <dd>{displayDate(account.expiresAt)}</dd>
              </div>
              <div>
                <dt>마지막 갱신</dt>
                <dd>
                  {account.lastRefreshedAt
                    ? displayDate(account.lastRefreshedAt)
                    : '아직 갱신하지 않음'}
                </dd>
              </div>
            </dl>
          </div>
        )}
        {errorMessage && (
          <button type="button" disabled={working} onClick={() => void threads.refresh()}>
            연결 상태 다시 확인
          </button>
        )}
        {(!account || editingAccount) && (
          <form
            className="threads-form"
            onSubmit={(event) => {
              event.preventDefault();
              void connect();
            }}
          >
            <label htmlFor="threads-access-token">API 토큰</label>
            <div className="threads-token-row">
              <input
                id="threads-access-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                maxLength={16384}
                onChange={(event) => setToken(event.target.value)}
                disabled={disabled}
                required
                placeholder="Meta에서 발급받은 토큰"
              />
              <button type="submit" className="primary" disabled={disabled || !token.trim()}>
                {working ? '저장 중…' : '저장'}
              </button>
            </div>
            <p>토큰을 저장하면 계정과 실제 만료 일시를 자동으로 확인합니다.</p>
            {account && (
              <div className="threads-actions">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    setEditingAccount(false);
                    setToken('');
                  }}
                >
                  취소
                </button>
              </div>
            )}
          </form>
        )}
      </section>
      <FileServerSettings threads={threads} enabled={enabled} />
      <section
        className="settings-section threads-settings"
        aria-labelledby="threads-insights-title"
      >
        <div className="threads-section-heading">
          <h3 id="threads-insights-title">최근 게시글 통계</h3>
          <button
            type="button"
            disabled={disabled || !account || reconnect || !latest.length}
            onClick={() => void syncInsights()}
          >
            {state?.syncing ? '조회 중…' : '지금 조회'}
          </button>
        </div>
        <p>최신 5개 게시글의 조회·좋아요·댓글 수를 확인합니다.</p>
        <p>
          {state?.lastSyncAt
            ? `마지막 조회: ${displayDate(state.lastSyncAt)}`
            : '아직 조회한 기록이 없습니다.'}
        </p>
        {!latest.length && <p>이 앱에서 업로드한 게시글이 아직 없습니다.</p>}
      </section>
    </>
  );
}
