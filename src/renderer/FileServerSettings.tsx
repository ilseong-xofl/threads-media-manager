import { useState } from 'react';
import type { ThreadsUi } from './use-threads-api';
import { useToast } from './toast';

function serverHost(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

export function FileServerSettings({ threads, enabled }: { threads: ThreadsUi; enabled: boolean }) {
  const [code, setCode] = useState('');
  const [editing, setEditing] = useState(false);
  const notify = useToast();
  const connection = threads.state?.fileServer;
  const disabled = !enabled || threads.working || threads.loading || !threads.state;

  async function save() {
    if (disabled) return;
    const connectionCode = code.trim();
    if (!connectionCode) {
      notify({ message: '관리자에게 받은 연결 코드를 입력하세요.', error: true });
      return;
    }
    const success = await threads.run(() =>
      window.threadsMedia.connectFileServer({ connectionCode }),
    );
    if (success) {
      setCode('');
      setEditing(false);
      notify({ message: '파일 서버 연결 코드를 암호화하여 저장했습니다.' });
    }
  }

  async function disconnect() {
    if (disabled) return;
    const success = await threads.run(() => window.threadsMedia.disconnectFileServer());
    if (success) {
      setCode('');
      setEditing(false);
      notify({ message: '이 PC의 파일 서버 연결을 해제했습니다.' });
    }
  }

  return (
    <section className="settings-section threads-settings" aria-labelledby="file-server-title">
      <div className="threads-section-heading">
        <h3 id="file-server-title">파일 서버</h3>
      </div>
      <p>
        연결 코드를 이 PC에 암호화하여 저장합니다. Threads 게시에 필요한 이미지·영상 업로드에
        사용합니다.
      </p>
      {connection && (
        <div className="threads-account-summary">
          <div className="threads-account-heading">
            <div className="threads-account-identity">
              <strong>{serverHost(connection.server)}</strong>
              <span>저장됨</span>
            </div>
            {!editing && (
              <div className="threads-actions">
                <button type="button" disabled={disabled} onClick={() => setEditing(true)}>
                  코드 교체
                </button>
                <button type="button" disabled={disabled} onClick={() => void disconnect()}>
                  연결 해제
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {(!connection || editing) && (
        <form
          className="threads-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor="file-server-connection-code">연결 코드</label>
          <div className="threads-token-row">
            <input
              id="file-server-connection-code"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={code}
              maxLength={16384}
              onChange={(event) => setCode(event.target.value)}
              disabled={disabled}
              required
              placeholder="관리자에게 받은 연결 코드"
              aria-describedby="file-server-help"
            />
            <button type="submit" className="primary" disabled={disabled || !code.trim()}>
              {threads.working ? '저장 중…' : '저장'}
            </button>
          </div>
          {connection && (
            <div className="threads-actions">
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  setEditing(false);
                  setCode('');
                }}
              >
                취소
              </button>
            </div>
          )}
        </form>
      )}
      <p id="file-server-help">코드의 사용 가능 여부는 파일 업로드 시 확인합니다.</p>
    </section>
  );
}
