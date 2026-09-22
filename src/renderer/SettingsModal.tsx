import { useEffect, useRef, useState } from 'react';
import type {
  CollectionView,
  LibraryMaintenanceOperation,
  LibraryMaintenanceResult,
} from '../shared/contracts';
import { Icon } from './Icon';

export function SettingsModal({
  enabled,
  onClose,
  onResult,
  onWorking,
}: {
  enabled: boolean;
  onClose(): void;
  onResult(view: CollectionView): void;
  onWorking(working: boolean): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const [root, setRoot] = useState<string | null>(null);
  const [rootLoading, setRootLoading] = useState(true);
  const [working, setWorking] = useState<LibraryMaintenanceOperation | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; message: string } | null>(null);
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let cancelled = false;
    void window.threadsMedia
      .libraryRoot()
      .then((value) => {
        if (!cancelled) setRoot(value);
      })
      .catch(() => {
        if (!cancelled)
          setNotice({
            error: true,
            message: '연결된 폴더 정보를 읽을 수 없습니다. 설정을 다시 열어주세요.',
          });
      })
      .finally(() => {
        if (!cancelled) setRootLoading(false);
      });
    element?.showModal();
    close.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      cancelled = true;
      element?.close();
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  async function run(
    operation: LibraryMaintenanceOperation,
    action: () => Promise<LibraryMaintenanceResult>,
  ) {
    if (pending.current || !enabled || (!root && operation !== 'reconnect')) return;
    pending.current = true;
    setWorking(operation);
    onWorking(true);
    setNotice(null);
    try {
      const result = await action();
      if (result.status === 'cancelled') return;
      if (result.status === 'error') {
        setNotice({ error: true, message: result.problem.message });
        return;
      }
      setRoot(await window.threadsMedia.libraryRoot());
      onResult(result.view);
      const message =
        operation === 'backup'
          ? `DB 백업을 저장했습니다.${result.filePath ? `\n${result.filePath}` : ''}`
          : operation === 'reconnect'
            ? '선택한 작업 폴더를 연결했습니다.'
            : result.historyReviewRequired
              ? '백업 시점의 DB를 복원했습니다. 이후 다운로드 이력을 확인할 수 없어 다운로드는 보류됩니다.'
              : '등록·댓글 정보를 복원했습니다. 현재 다운로드·삭제 이력은 유지됩니다.';
      setNotice({
        error: !!result.view.error || !!result.historyReviewRequired,
        message:
          message +
          (result.automaticBackupPath ? `\n복원 전 DB: ${result.automaticBackupPath}` : '') +
          (result.view.error ? `\n${result.view.error.message}` : ''),
      });
    } catch {
      setNotice({ error: true, message: '설정 작업을 완료하지 못했습니다. 다시 확인하세요.' });
    } finally {
      pending.current = false;
      setWorking(null);
      onWorking(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="post-modal settings-modal"
      aria-labelledby="settings-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending.current) onClose();
      }}
    >
      <div className="modal-header">
        <h2 id="settings-title">설정</h2>
        <button
          ref={close}
          className="icon-button"
          aria-label="설정 닫기"
          onClick={onClose}
          disabled={!!working}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="settings-body">
        <section className="settings-section">
          <h3>라이브러리</h3>
          <p className="settings-root">
            {rootLoading ? '폴더 확인 중…' : (root ?? '작업 폴더를 선택하세요.')}
          </p>
          <div className="settings-row">
            <div>
              <strong>폴더 재연결</strong>
              <p>사용할 작업 폴더를 선택합니다. 기존 DB가 있으면 새 위치에 연결합니다.</p>
            </div>
            <button
              disabled={rootLoading || !enabled || !!working}
              onClick={() => void run('reconnect', () => window.threadsMedia.reconnectLibrary())}
            >
              <Icon name="folder" />
              {working === 'reconnect' ? '연결 중…' : root ? '재연결' : '폴더 선택'}
            </button>
          </div>
        </section>
        <section className="settings-section">
          <h3>데이터베이스 백업·복원</h3>
          <p>
            DB에는 다운로드 이력, 편집본 정보, 등록한 게시글과 댓글이 저장됩니다. 이미지·영상과 수집
            Excel은 포함되지 않으므로 수집 폴더도 별도로 보관하세요.
          </p>
          <div className="settings-row">
            <div>
              <strong>DB 백업</strong>
              <p>현재 라이브러리의 DB를 파일로 저장합니다.</p>
            </div>
            <button
              disabled={!root || !enabled || !!working}
              onClick={() => void run('backup', () => window.threadsMedia.backupDatabase())}
            >
              <Icon name="download" />
              {working === 'backup' ? '백업 중…' : 'DB 백업'}
            </button>
          </div>
          <div className="settings-row">
            <div>
              <strong>DB 복원</strong>
              <p>
                같은 라이브러리의 백업을 불러옵니다. 정상 DB의 다운로드·삭제 이력은 유지하며, DB가
                없거나 손상됐다면 백업 시점으로 복원합니다. 현재 DB는 먼저 별도 보관합니다.
              </p>
            </div>
            <button
              disabled={!root || !enabled || !!working}
              onClick={() => void run('restore', () => window.threadsMedia.restoreDatabase())}
            >
              <Icon name="refresh" />
              {working === 'restore' ? '복원 중…' : 'DB 복원'}
            </button>
          </div>
        </section>
        {notice && (
          <p
            className={`settings-notice ${notice.error ? 'error' : ''}`}
            role={notice.error ? 'alert' : 'status'}
          >
            {notice.message}
          </p>
        )}
      </div>
    </dialog>
  );
}
