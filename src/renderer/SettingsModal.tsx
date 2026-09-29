import { useEffect, useRef, useState } from 'react';
import type {
  CollectionView,
  LibraryMaintenanceOperation,
  LibraryMaintenanceResult,
} from '../shared/contracts';
import { Icon } from './Icon';
import { ChatGptSettings } from './ChatGptSettings';
import { ThreadsAccountSettings } from './ThreadsAccountSettings';
import { ThreadsWorkOverlay } from './ThreadsUploadOverlay';
import type { ThreadsUi } from './use-threads-api';
import { useToast } from './toast';

export function SettingsModal({
  enabled,
  onClose,
  onResult,
  onWorking,
  threads,
}: {
  enabled: boolean;
  threads?: ThreadsUi;
  onClose(): void;
  onResult(view: CollectionView): void;
  onWorking(working: boolean): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const insightsPending = useRef(false);
  const [insightsWorking, setInsightsWorking] = useState(false);
  const [root, setRoot] = useState<string | null>(null);
  const [rootLoading, setRootLoading] = useState(true);
  const [working, setWorking] = useState<LibraryMaintenanceOperation | null>(null);
  const apiWorking = !!threads?.working || insightsWorking;
  const setNotice = useToast();
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
  }, [setNotice]);
  function onSyncing(value: boolean) {
    insightsPending.current = value;
    setInsightsWorking(value);
  }
  function requestClose() {
    if (!pending.current && !insightsPending.current && !apiWorking) onClose();
  }
  useEffect(() => {
    if (!insightsWorking) return;
    return () => close.current?.focus({ preventScroll: true });
  }, [insightsWorking]);
  async function run(
    operation: LibraryMaintenanceOperation,
    action: () => Promise<LibraryMaintenanceResult>,
  ) {
    if (
      pending.current ||
      insightsPending.current ||
      apiWorking ||
      !enabled ||
      (!root && operation !== 'reconnect')
    )
      return;
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
            : result.restoreMode === 'full'
              ? 'DB를 복원했습니다. 옮긴 자료를 다시 다운로드하지 않고 사용할 수 있습니다.'
              : '등록·댓글 정보를 복원했습니다. 현재 다운로드·삭제 이력은 유지됩니다.';
      setNotice({
        error: !!result.view.error,
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
        requestClose();
      }}
    >
      <div className="modal-header" inert={insightsWorking}>
        <h2 id="settings-title">설정</h2>
        <button
          ref={close}
          className="icon-button"
          aria-label="설정 닫기"
          onClick={requestClose}
          disabled={!!working || apiWorking}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="settings-body" inert={insightsWorking}>
        <ChatGptSettings enabled={enabled && !working && !apiWorking} />
        {threads && (
          <ThreadsAccountSettings
            threads={threads}
            enabled={enabled && !working}
            onSyncing={onSyncing}
          />
        )}
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
              disabled={rootLoading || !enabled || !!working || apiWorking}
              onClick={() => void run('reconnect', () => window.threadsMedia.reconnectLibrary())}
            >
              <Icon name="folder" />
              {working === 'reconnect' ? '연결 중…' : root ? '재연결' : '폴더 선택'}
            </button>
          </div>
        </section>
        <section className="settings-section">
          <h3>컴퓨터 이전용 DB 백업·복원</h3>
          <p>
            DB 백업 후 앱을 종료하고 작업 폴더 전체와 백업 파일을 새 컴퓨터로 옮기세요. 새
            컴퓨터에서 옮긴 폴더를 선택하고 DB를 복원하면 기존 자료를 그대로 사용할 수 있습니다.
            이미지·영상과 수집 Excel은 작업 폴더에, 게시 완료 이력은 백업 시 작업 폴더에 함께
            보관됩니다. Threads 토큰과 파일 서버 연결코드는 새 컴퓨터에서 다시 입력하세요.
          </p>
          <div className="settings-row">
            <div>
              <strong>DB 백업</strong>
              <p>DB 파일을 저장하고, 게시 완료 이력을 작업 폴더에 보관합니다.</p>
            </div>
            <button
              disabled={!root || !enabled || !!working || apiWorking}
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
                옮긴 작업 폴더와 함께 보관한 DB 백업을 불러옵니다. 파일을 다시 다운로드하지
                않습니다. 현재 DB가 있으면 먼저 별도 보관하며 최신 다운로드·삭제 이력은 유지합니다.
              </p>
            </div>
            <button
              disabled={!root || !enabled || !!working || apiWorking}
              onClick={() => void run('restore', () => window.threadsMedia.restoreDatabase())}
            >
              <Icon name="refresh" />
              {working === 'restore' ? '복원 중…' : 'DB 복원'}
            </button>
          </div>
        </section>
      </div>
      {insightsWorking && (
        <ThreadsWorkOverlay label="Threads 통계 조회 진행" title="통계 조회 중" />
      )}
    </dialog>
  );
}
