import { useEffect, useId, useRef, useState } from 'react';
import type { ManagedThreadsAccountRow } from '../shared/managed-threads';
import { displayDate } from './view-model';
import { useManagedThreads } from './use-managed-threads';
import { useToast } from './toast';
import { ManagedThreadsActionDialog } from './ManagedThreadsActionDialog';
import './managed-threads.css';

const localStatus: Record<ManagedThreadsAccountRow['localState'], string> = {
  synced: '서버와 동기화됨',
  pending: '서버 저장 대기',
  conflict: '서버의 최신 정보와 충돌',
  missing: '서버 목록에서 계정을 찾을 수 없음',
};

function mobileStatus(row: ManagedThreadsAccountRow) {
  if (!row.account) return '서버에 저장한 뒤 휴대폰에서 확인';
  if (row.account.validationStatus === 'invalid') return '휴대폰에서 유효하지 않다고 보고됨';
  if (row.account.validationStatus === 'reported_valid') return '휴대폰에서 확인했다고 보고됨';
  return '휴대폰 확인 대기';
}

export function managedThreadsActionAvailability(row: ManagedThreadsAccountRow | null) {
  return {
    replace:
      !!row?.account && !row.pendingAction && !row.pendingDeletion && row.localState !== 'missing',
    retry: !!row?.pendingAction && !row.pendingDeletion && row.localState === 'pending',
    discard: !!row?.pendingAction && !row.pendingDeletion,
    remove: !!row?.account && !row.pendingAction && row.localState !== 'missing',
  };
}

export function ManagedThreadsAccountTable({
  rows,
  selectedId,
  selectionName,
  disabled,
  loaded,
  enabled,
  onSelect,
}: {
  rows: ManagedThreadsAccountRow[];
  selectedId: string | null;
  selectionName: string;
  disabled: boolean;
  loaded: boolean;
  enabled: boolean;
  onSelect(localId: string): void;
}) {
  return (
    <div className="managed-threads-table-wrap" tabIndex={0} aria-label="계정 목록 스크롤 영역">
      <table className="managed-threads-table" aria-label="등록된 Threads 계정">
        <colgroup>
          <col className="managed-threads-select-column" />
          <col className="managed-threads-app-column" />
          <col className="managed-threads-id-column" />
          <col className="managed-threads-mobile-column" />
          <col className="managed-threads-connection-column" />
          <col className="managed-threads-expiry-column" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">
              <span className="managed-threads-sr-only">선택</span>
            </th>
            <th scope="col">앱 이름</th>
            <th scope="col">Threads ID</th>
            <th scope="col">휴대폰 토큰 확인</th>
            <th scope="col">앱 연결 확인</th>
            <th scope="col">보고된 만료 일시</th>
          </tr>
        </thead>
        <tbody>
          {!rows.length && (
            <tr>
              <td colSpan={6} className="managed-threads-empty">
                {!enabled ? (
                  <p role="status">서비스 로그인 후 계정을 확인할 수 있습니다.</p>
                ) : !loaded ? (
                  <p role="status">내 계정 확인 중…</p>
                ) : (
                  <>
                    <span className="managed-threads-empty-icon" aria-hidden="true">
                      @
                    </span>
                    <strong>등록된 Threads 계정이 없습니다.</strong>
                    <p>계정 추가 버튼으로 앱 이름과 계정, 장기 토큰을 등록하세요.</p>
                  </>
                )}
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr
              key={row.localId}
              className={row.localId === selectedId ? 'managed-threads-row-selected' : undefined}
              onClick={() => {
                if (!disabled) onSelect(row.localId);
              }}
            >
              <td className="managed-threads-select-cell">
                <input
                  type="radio"
                  name={selectionName}
                  aria-label={`${row.appName} / ${row.label} 선택`}
                  checked={row.localId === selectedId}
                  disabled={disabled}
                  onChange={() => onSelect(row.localId)}
                />
              </td>
              <td>
                <strong className="managed-threads-cell-title" title={row.appName}>
                  {row.appName}
                </strong>
                <span className={`managed-threads-status managed-threads-${row.localState}`}>
                  {row.pendingDeletion ? '삭제 결과 확인 필요' : localStatus[row.localState]}
                </span>
                {row.account?.appId && (
                  <span
                    className="managed-threads-cell-detail"
                    title={`Meta App ID: ${row.account.appId}`}
                  >
                    App ID {row.account.appId}
                  </span>
                )}
              </td>
              <td>
                <strong className="managed-threads-cell-title" title={row.label}>
                  {row.label}
                </strong>
                <span
                  className="managed-threads-cell-detail"
                  title={row.account?.threadsUserId ?? undefined}
                >
                  {row.account?.threadsUserId
                    ? `확인 ID: ${row.account.threadsUserId}`
                    : '휴대폰 확인 전'}
                </span>
              </td>
              <td>
                <span
                  className={`managed-threads-phone-state managed-threads-phone-${row.account?.validationStatus ?? 'pending_validation'}`}
                >
                  <span aria-hidden="true" className="managed-threads-state-dot" />
                  {mobileStatus(row)}
                </span>
              </td>
              <td>
                <span
                  className={
                    row.account?.appIdVerified
                      ? 'managed-threads-verified'
                      : 'managed-threads-muted'
                  }
                >
                  {row.account?.appIdVerified ? '휴대폰 확인 보고 있음' : '확인되지 않음'}
                </span>
              </td>
              <td className="managed-threads-expiry">
                {row.account?.expiresAt ? (
                  displayDate(row.account.expiresAt)
                ) : (
                  <span className="managed-threads-muted">휴대폰 확인 전</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function managedThreadsInputProblem(
  input: { appName: string; label: string; token: string },
  registering: boolean,
): string | null {
  if (registering && (!input.appName.trim() || input.appName.trim().length > 80)) {
    return 'Meta 앱 이름을 1~80자로 입력하세요.';
  }
  if (registering && (!input.label.trim() || input.label.trim().length > 80)) {
    return 'Threads 계정 이름을 1~80자로 입력하세요.';
  }
  if (!/^[\x21-\x7e]{1,8192}$/.test(input.token.trim())) {
    return registering
      ? 'Meta에서 발급받은 장기 토큰을 입력하세요. 토큰 중간에 공백이나 줄바꿈이 없는지 확인해 주세요.'
      : '새 장기 토큰을 입력하세요. 토큰 중간에 공백이나 줄바꿈이 없는지 확인해 주세요.';
  }
  return null;
}

export function ManagedThreadsAccountFields({
  id,
  appName,
  label,
  token,
  registering,
  disabled,
  onAppNameChange,
  onLabelChange,
  onTokenChange,
}: {
  id: string;
  appName: string;
  label: string;
  token: string;
  registering: boolean;
  disabled: boolean;
  onAppNameChange(value: string): void;
  onLabelChange(value: string): void;
  onTokenChange(value: string): void;
}) {
  return (
    <>
      {registering && (
        <>
          <label htmlFor={`${id}-app-name`}>Meta 앱 이름</label>
          <input
            id={`${id}-app-name`}
            value={appName}
            onChange={(event) => onAppNameChange(event.target.value)}
            disabled={disabled}
            maxLength={80}
            autoComplete="off"
            placeholder="개발자센터에서 정한 앱 이름"
          />
          <label htmlFor={`${id}-label`}>Threads 계정 이름</label>
          <input
            id={`${id}-label`}
            value={label}
            onChange={(event) => onLabelChange(event.target.value)}
            disabled={disabled}
            maxLength={80}
            autoComplete="off"
            placeholder="계정을 구분할 이름"
          />
        </>
      )}
      <label htmlFor={`${id}-token`}>{registering ? '장기 토큰' : '새 장기 토큰'}</label>
      <input
        id={`${id}-token`}
        type="password"
        value={token}
        onChange={(event) => onTokenChange(event.target.value)}
        disabled={disabled}
        maxLength={8192}
        autoComplete="off"
        spellCheck={false}
        placeholder="Meta에서 발급받은 장기 토큰"
      />
    </>
  );
}

export function ManagedThreadsDeleteConfirmation({
  row,
  busy,
  onConfirm,
  onClose,
  returnFocusTo,
}: {
  row: ManagedThreadsAccountRow;
  busy: boolean;
  onConfirm(): void;
  onClose(): void;
  returnFocusTo?: HTMLElement | null;
}) {
  return (
    <ManagedThreadsActionDialog
      title={row.pendingDeletion ? '계정 삭제 재시도' : '계정 삭제'}
      busy={busy}
      onClose={onClose}
      confirmation
      returnFocusTo={returnFocusTo}
    >
      <dl className="managed-threads-confirm-account">
        <dt>Meta 앱 이름</dt>
        <dd>{row.appName}</dd>
        <dt>Threads 계정</dt>
        <dd>{row.label}</dd>
      </dl>
      <div className="managed-threads-confirm-copy">
        {row.pendingDeletion && (
          <p>
            이전 삭제 결과를 아직 확인하지 못했습니다. 서버 상태를 확인한 뒤 삭제를 다시 요청합니다.
          </p>
        )}
        <p>이 서비스의 계정 연결과 저장한 토큰을 삭제하고, 연결된 휴대폰을 해제합니다.</p>
        <p>
          아직 시작하지 않은 게시 대기 글·미게시 댓글은 취소하며, 전송 중·결과 불명 작업이 있으면
          삭제할 수 없습니다.
        </p>
        <p>실제 Threads 계정·게시글과 기존 완료 이력은 삭제하지 않습니다.</p>
        <p>다시 사용하려면 장기 토큰을 새로 등록하고 휴대폰을 다시 연결해야 합니다.</p>
      </div>
      <div className="threads-actions managed-threads-dialog-actions">
        <button type="button" disabled={busy} onClick={onClose}>
          돌아가기
        </button>
        <button
          type="button"
          className="managed-threads-danger-primary"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? '삭제 중…' : row.pendingDeletion ? '삭제 다시 요청' : '계정 삭제 확인'}
        </button>
      </div>
    </ManagedThreadsActionDialog>
  );
}

export function ManagedThreadsAccountSettings({
  enabled,
  onSyncing,
  titleId,
}: {
  enabled: boolean;
  onSyncing?(working: boolean): void;
  titleId?: string;
}) {
  const accounts = useManagedThreads(enabled, onSyncing);
  const notify = useToast();
  const id = useId();
  const [registering, setRegistering] = useState(false);
  const [label, setLabel] = useState('');
  const [appName, setAppName] = useState('');
  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState<ManagedThreadsAccountRow | null>(null);
  const [discarding, setDiscarding] = useState<ManagedThreadsAccountRow | null>(null);
  const [deleting, setDeleting] = useState<ManagedThreadsAccountRow | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const actionOpener = useRef<HTMLElement | null>(null);
  const disabled = !enabled || accounts.busy || !accounts.loaded;
  const editing = enabled && (registering || !!replacing);
  const visibleAccounts = enabled ? accounts.accounts : [];
  const selected = visibleAccounts.find((row) => row.localId === selectedId) ?? null;
  const available = managedThreadsActionAvailability(selected);
  const actionDialogOpen = editing || !!discarding || !!deleting;
  const actionDisabled = disabled || actionDialogOpen;
  const headingId = titleId ?? `${id}-title`;
  useEffect(() => {
    if (enabled) return;
    setToken('');
    setLabel('');
    setAppName('');
    setRegistering(false);
    setReplacing(null);
    setDiscarding(null);
    setDeleting(null);
    setSelectedId(null);
  }, [enabled]);
  function closeForm() {
    setToken('');
    setLabel('');
    setAppName('');
    setRegistering(false);
    setReplacing(null);
  }
  async function save() {
    if (disabled) return;
    const problem = managedThreadsInputProblem({ appName, label, token }, registering);
    if (problem) {
      notify({ message: problem, error: true });
      return;
    }
    const inputToken = token.trim();
    const existingLocalIds = new Set(accounts.accounts.map((row) => row.localId));
    const ok = registering
      ? await accounts.register({ appName: appName.trim(), label: label.trim(), token: inputToken })
      : replacing?.account
        ? await accounts.replace({
            accountId: replacing.account.id,
            expectedRevision: replacing.account.tokenRevision,
            token: inputToken,
          })
        : false;
    const retainedPending = accounts
      .getSnapshot()
      .accounts.some((row) =>
        registering
          ? row.pendingAction === 'create' &&
            row.appName === appName.trim() &&
            row.label === label.trim() &&
            !existingLocalIds.has(row.localId)
          : row.pendingAction === 'replace' && row.account?.id === replacing?.account?.id,
      );
    // Leave unsaved input intact on validation/storage failures. Once main has encrypted the
    // input, close the form so the explicit retry/discard controls are available on the row.
    if (ok || retainedPending) closeForm();
  }
  return (
    <section className="managed-threads" aria-labelledby={headingId}>
      <div className="managed-threads-heading">
        <div className="managed-threads-heading-title">
          <h2 id={headingId}>계정 관리</h2>
          <span className="managed-threads-count">{visibleAccounts.length}</span>
        </div>
        <div className="managed-threads-toolbar" role="group" aria-label="계정 관리 작업">
          <button
            type="button"
            className="primary"
            disabled={actionDisabled}
            onClick={(event) => {
              actionOpener.current = event.currentTarget;
              closeForm();
              setRegistering(true);
            }}
          >
            <span aria-hidden="true">＋</span> 계정 추가
          </button>
          <button
            type="button"
            disabled={!enabled || accounts.busy || actionDialogOpen}
            onClick={() => void accounts.synchronize(true)}
          >
            {accounts.busy ? '동기화 중…' : '서버와 동기화'}
          </button>
        </div>
      </div>
      <p className="managed-threads-intro">
        계정을 선택하면 토큰 교체·삭제와 보류된 작업을 관리할 수 있습니다.
      </p>
      <div className="managed-threads-selected-actions" role="group" aria-label="선택 계정 작업">
        <span className="managed-threads-actions-label">선택 계정</span>
        <button
          type="button"
          disabled={actionDisabled || !available.replace}
          onClick={(event) => {
            if (selected) {
              actionOpener.current = event.currentTarget;
              setToken('');
              setReplacing(selected);
            }
          }}
        >
          토큰 교체
        </button>
        <button
          type="button"
          disabled={actionDisabled || !available.retry}
          onClick={() => {
            if (selected) void accounts.retry({ localId: selected.localId });
          }}
        >
          저장 재시도
        </button>
        <button
          type="button"
          disabled={actionDisabled || !available.discard}
          onClick={(event) => {
            if (selected) {
              actionOpener.current = event.currentTarget;
              setDiscarding(selected);
            }
          }}
        >
          보류 취소
        </button>
        <button
          type="button"
          className="managed-threads-danger"
          disabled={actionDisabled || !available.remove}
          onClick={(event) => {
            if (selected) {
              actionOpener.current = event.currentTarget;
              setDeleting(selected);
            }
          }}
        >
          {selected?.pendingDeletion ? '삭제 재시도' : '삭제'}
        </button>
      </div>
      {enabled && discarding && (
        <ManagedThreadsActionDialog
          title="보류된 변경 취소"
          busy={accounts.busy}
          onClose={() => setDiscarding(null)}
          confirmation
          returnFocusTo={actionOpener.current}
        >
          <div className="managed-threads-confirm-copy">
            <strong>
              {discarding.appName} · {discarding.label}
            </strong>
            <p>이 PC에 보류된 입력만 버립니다. 서버에 이미 저장된 계정과 토큰은 유지됩니다.</p>
          </div>
          <div className="threads-actions managed-threads-dialog-actions">
            <button type="button" disabled={disabled} onClick={() => setDiscarding(null)}>
              돌아가기
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                void accounts.discard({ localId: discarding.localId }).then((ok) => {
                  if (ok) setDiscarding(null);
                })
              }
            >
              보류 취소 확인
            </button>
          </div>
        </ManagedThreadsActionDialog>
      )}
      {editing && (
        <ManagedThreadsActionDialog
          title={registering ? 'Threads 계정 추가' : '장기 토큰 교체'}
          busy={accounts.busy}
          onClose={closeForm}
          returnFocusTo={actionOpener.current}
        >
          <form
            className="threads-form managed-threads-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {replacing && (
              <p className="managed-threads-form-account">
                {replacing.appName} · {replacing.label}
              </p>
            )}
            <ManagedThreadsAccountFields
              id={id}
              appName={appName}
              label={label}
              token={token}
              registering={registering}
              disabled={disabled}
              onAppNameChange={setAppName}
              onLabelChange={setLabel}
              onTokenChange={setToken}
            />
            <p>
              입력한 토큰은 암호화하여 저장한 뒤 지워집니다. 기존 토큰은 화면에 표시하지 않습니다.
            </p>
            <div className="threads-actions managed-threads-dialog-actions">
              <button type="button" disabled={disabled} onClick={closeForm}>
                취소
              </button>
              <button type="submit" className="primary" disabled={disabled}>
                {accounts.busy ? '저장 중…' : '암호화하여 저장'}
              </button>
            </div>
          </form>
        </ManagedThreadsActionDialog>
      )}
      {enabled && deleting && (
        <ManagedThreadsDeleteConfirmation
          row={deleting}
          busy={accounts.busy}
          onClose={() => setDeleting(null)}
          returnFocusTo={actionOpener.current}
          onConfirm={() => {
            if (disabled || !deleting.account) return;
            void accounts
              .remove({
                accountId: deleting.account.id,
                expectedRevision: deleting.account.tokenRevision,
              })
              .then(() => setDeleting(null));
          }}
        />
      )}
      <ManagedThreadsAccountTable
        rows={visibleAccounts}
        selectedId={selectedId}
        selectionName={`${id}-selection`}
        disabled={actionDisabled}
        loaded={accounts.loaded}
        enabled={enabled}
        onSelect={setSelectedId}
      />
      <div className="managed-threads-selection-summary" aria-live="polite">
        {selected ? (
          <>
            <strong>
              {selected.appName} · {selected.label}
            </strong>
            {selected.pendingDeletion ? (
              <p>
                삭제 결과를 확인할 때까지 토큰 교체와 보류 취소를 막습니다. 서버와 동기화하거나 삭제
                재시도를 직접 실행해 주세요.
              </p>
            ) : !selected.account ? (
              <p>
                입력은 이 PC에 암호화하여 보관했습니다. 서버 저장 결과를 확인하려면 동기화하거나
                저장을 재시도하세요.
              </p>
            ) : selected.localState === 'conflict' ? (
              <p>
                보류된 변경은 자동으로 보내지 않습니다. 서버 정보를 확인한 뒤 보류를 취소하고
                필요하면 새 토큰을 등록하세요.
              </p>
            ) : selected.localState === 'pending' ? (
              <p>암호화한 입력을 이 PC에 보관했습니다. 저장 재시도는 직접 실행해 주세요.</p>
            ) : selected.localState === 'missing' ? (
              <p>서버 목록에서 계정을 찾을 수 없습니다. 서버와 동기화하여 상태를 확인해 주세요.</p>
            ) : (
              <p>이 계정의 토큰 확인·갱신은 연결된 휴대폰에서 진행합니다.</p>
            )}
          </>
        ) : (
          <span>선택된 계정이 없습니다.</span>
        )}
      </div>
      <div className="managed-threads-footnote">
        <span className="managed-threads-footnote-icon" aria-hidden="true">
          i
        </span>
        <p>
          앱 이름은 구분용입니다. 실제 Threads 계정은 휴대폰에서 토큰으로 확인합니다.
          <br />
          토큰은 이 PC와 서버에 암호화하여 저장하며, 토큰 확인·갱신은 휴대폰에서 직접 처리합니다.
        </p>
      </div>
    </section>
  );
}
