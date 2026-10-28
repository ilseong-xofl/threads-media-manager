import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ManagedThreadsAccountRow, ManagedThreadsTokenCheck } from '../shared/managed-threads';
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

const DAY_MS = 86_400_000;

function tokenStatus(row: ManagedThreadsAccountRow) {
  if (!row.account) return '서버 저장 후 확인';
  if (row.account.validationStatus === 'invalid') return '사용할 수 없음';
  if (row.account.validationStatus === 'reported_valid') return '확인됨';
  return '확인 필요';
}

/** Whole days left, rounded up, so "14일 남음" is exactly when refresh opens; ≤ 0 is expired. */
export function managedThreadsExpiryDays(expiresAt: string, now: number): number {
  return Math.ceil((Date.parse(expiresAt) - now) / DAY_MS);
}

/** "m:ss" left in the server's per-employee Meta request interval, or null once it is over. */
export function managedThreadsCooldownTime(remainingMs: number): string | null {
  if (!(remainingMs > 0)) return null;
  const seconds = Math.ceil(remainingMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** One login notice for verified accounts that expired or enter the refresh window. */
export function managedThreadsExpiryNotice(
  rows: ManagedThreadsAccountRow[],
  refreshWindowDays: number,
  now: number,
): string | null {
  const expired: string[] = [];
  const soon: string[] = [];
  for (const row of rows) {
    const account = row.account;
    if (!account?.expiresAt || account.validationStatus !== 'reported_valid' || row.pendingDeletion)
      continue;
    const days = managedThreadsExpiryDays(account.expiresAt, now);
    if (Date.parse(account.expiresAt) <= now) expired.push(row.label);
    else if (days <= refreshWindowDays) soon.push(`${row.label}(${days}일)`);
  }
  const parts = [
    expired.length ? `만료됨: ${expired.join(', ')}` : null,
    soon.length ? `${refreshWindowDays}일 이내 만료: ${soon.join(', ')}` : null,
  ].filter(Boolean);
  return parts.length
    ? `토큰 만료를 확인해 주세요. ${parts.join(' / ')}. 계정 관리에서 갱신하거나 토큰을 교체할 수 있습니다.`
    : null;
}

export function managedThreadsActionAvailability(
  row: ManagedThreadsAccountRow | null,
  now = Date.now(),
  refreshWindowDays = 14,
) {
  const synced =
    !!row?.account && row.localState === 'synced' && !row.pendingAction && !row.pendingDeletion;
  const expiresAt = row?.account?.expiresAt ? Date.parse(row.account.expiresAt) : Number.NaN;
  return {
    // Names are independent of the token, so a pending token replacement does not block them.
    edit: !!row?.account && !row.pendingDeletion && row.localState !== 'missing',
    replace:
      !!row?.account && !row.pendingAction && !row.pendingDeletion && row.localState !== 'missing',
    // Only an unverified account needs it: a verified one is unchanged, an invalid one needs a new token.
    recheck: synced && row!.account!.validationStatus === 'pending_validation',
    refresh:
      synced &&
      row!.account!.validationStatus === 'reported_valid' &&
      !!row!.account!.threadsUserId &&
      expiresAt > now &&
      expiresAt <= now + refreshWindowDays * DAY_MS,
    // The only way out of an unsent change: it is sent, or main follows a server that moved on.
    retry: !!row?.pendingAction && !row.pendingDeletion,
    remove: !!row?.account && !row.pendingAction && row.localState !== 'missing',
  };
}

/** What the [갱신 재시도] info dialog says. Only a refresh can be left unsent by this version. */
export function managedThreadsResendExplanation(row: ManagedThreadsAccountRow): string[] {
  if (row.localState === 'conflict')
    return [
      '이 PC의 변경을 서버에 보내지 못한 사이 서버의 토큰이 바뀌었습니다.',
      '[갱신 재시도]를 누르면 이 PC의 변경 대신 서버의 토큰을 사용합니다.',
    ];
  if (row.localState === 'missing')
    return [
      '서버 목록에서 이 계정을 찾을 수 없습니다.',
      '[갱신 재시도]를 누르면 이 PC에 남은 변경을 정리합니다.',
    ];
  if (row.pendingReason !== 'refresh')
    // Left by an earlier version, which also kept other unsent changes on this PC.
    return [
      '이전 버전에서 서버에 보내지 못한 변경이 이 PC에 남아 있습니다.',
      '[갱신 재시도]를 누르면 서버에 다시 보냅니다. 완료되어야 이 계정을 사용할 수 있습니다.',
    ];
  return [
    'Meta에서 토큰을 갱신해 새 토큰을 이 PC에 암호화하여 저장했지만, 서버와 통신하지 못해 데이터베이스에 반영하지 못한 상태입니다.',
    '인터넷 연결을 확인한 뒤 [갱신 재시도]를 눌러 주세요. Meta에 다시 요청하지 않고 이 PC에 저장된 새 토큰을 서버에 보냅니다.',
    '완료되어야 이 계정을 사용할 수 있으며, 그 전에는 모바일로 보낼 수 없습니다.',
  ];
}

const checkOperation: Record<ManagedThreadsTokenCheck['operation'], string> = {
  register: '등록',
  replace: '토큰 교체',
  recheck: '재확인',
  refresh: '갱신',
};
const checkResult: Record<ManagedThreadsTokenCheck['result'], string> = {
  success: '성공',
  duplicate: '이미 등록된 Threads 계정',
  mismatch: '다른 Threads 계정의 토큰',
  invalid_token: '유효하지 않은 토큰',
  rejected: 'Meta가 거절함',
  network: '통신 실패(처리 여부 알 수 없음)',
  not_sent: '요청을 보내지 못함',
  timeout: '시간 초과(처리 여부 알 수 없음)',
  bad_response: '응답을 확인하지 못함',
};
const checkDetail = {
  expired: '만료됨',
  short_lived: '남은 기간 24시간 미만(단기 토큰)',
  permission: '토큰 정보 조회 권한 없음',
};

/** The last check of a row as labeled lines, shown in the summary and copied for support. */
export function managedThreadsCheckLines(check: ManagedThreadsTokenCheck): string[] {
  return [
    `확인 시각: ${displayDate(check.at)}`,
    `작업: ${checkOperation[check.operation]}`,
    `결과: ${checkResult[check.result]}${check.detail ? ` · ${checkDetail[check.detail]}` : ''}`,
    ...(check.expiresAt ? [`만료 일시: ${displayDate(check.expiresAt)}`] : []),
    ...(check.httpStatus === null ? [] : [`HTTP 상태: ${check.httpStatus}`]),
    ...(check.metaCode === null ? [] : [`Meta 코드: ${check.metaCode}`]),
    ...(check.metaSubcode === null ? [] : [`하위 코드: ${check.metaSubcode}`]),
    ...(check.metaType ? [`유형: ${check.metaType}`] : []),
    ...(check.metaMessage ? [`메시지: ${check.metaMessage}`] : []),
    ...(check.fbtraceId ? [`fbtrace_id: ${check.fbtraceId}`] : []),
    ...(check.networkCode ? [`네트워크 코드: ${check.networkCode}`] : []),
  ];
}

function MetaActionLabel({ children, cooldown }: { children: ReactNode; cooldown: string | null }) {
  return (
    <span className="managed-threads-meta-action">
      <span>{children}</span>
      {cooldown && <span className="managed-threads-cooldown">{cooldown}</span>}
    </span>
  );
}

export function ManagedThreadsAccountTable({
  rows,
  selectedId,
  selectionName,
  disabled,
  loaded,
  enabled,
  now = Date.now(),
  recheckDisabled = false,
  onSelect,
  onRecheck,
}: {
  rows: ManagedThreadsAccountRow[];
  selectedId: string | null;
  selectionName: string;
  disabled: boolean;
  loaded: boolean;
  enabled: boolean;
  now?: number;
  /** The shared Meta request interval; the countdown is shown beside the account actions. */
  recheckDisabled?: boolean;
  onSelect(localId: string): void;
  /** Shown in place of "확인 필요", so the account that needs a check is the one with the button. */
  onRecheck?(row: ManagedThreadsAccountRow): void;
}) {
  return (
    <div className="managed-threads-table-wrap" tabIndex={0} aria-label="계정 목록 스크롤 영역">
      <table className="managed-threads-table" aria-label="등록된 Threads 계정">
        <colgroup>
          <col className="managed-threads-select-column" />
          <col className="managed-threads-app-column" />
          <col className="managed-threads-id-column" />
          <col className="managed-threads-mobile-column" />
          <col className="managed-threads-expiry-column" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">
              <span className="managed-threads-sr-only">선택</span>
            </th>
            <th scope="col">앱 이름</th>
            <th scope="col">Threads ID</th>
            <th scope="col">토큰 확인</th>
            <th scope="col">만료 일시</th>
          </tr>
        </thead>
        <tbody>
          {!rows.length && (
            <tr>
              <td colSpan={5} className="managed-threads-empty">
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
                  {row.account?.threadsUserId ? `확인 ID: ${row.account.threadsUserId}` : '확인 전'}
                </span>
              </td>
              <td>
                {onRecheck && managedThreadsActionAvailability(row, now).recheck ? (
                  <button
                    type="button"
                    className="managed-threads-recheck"
                    aria-label={`${row.appName} / ${row.label} 토큰 재확인`}
                    title="토큰 확인이 필요합니다. 저장된 토큰을 Meta에 다시 확인합니다."
                    disabled={disabled || recheckDisabled}
                    onClick={() => onRecheck(row)}
                  >
                    재확인
                  </button>
                ) : (
                  <span
                    className={`managed-threads-phone-state managed-threads-phone-${row.account?.validationStatus ?? 'pending_validation'}`}
                  >
                    <span aria-hidden="true" className="managed-threads-state-dot" />
                    {tokenStatus(row)}
                  </span>
                )}
              </td>
              <td className="managed-threads-expiry">
                {row.account?.expiresAt ? (
                  <>
                    {displayDate(row.account.expiresAt)}
                    <span className="managed-threads-cell-detail">
                      {Date.parse(row.account.expiresAt) <= now
                        ? '만료됨'
                        : `${managedThreadsExpiryDays(row.account.expiresAt, now)}일 남음`}
                    </span>
                  </>
                ) : (
                  <span className="managed-threads-muted">확인 전</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function managedThreadsNameProblem(input: {
  appName: string;
  label: string;
}): string | null {
  if (!input.appName.trim() || input.appName.trim().length > 80) {
    return 'Meta 앱 이름을 1~80자로 입력하세요.';
  }
  if (!input.label.trim() || input.label.trim().length > 80) {
    return 'Threads 계정 이름을 1~80자로 입력하세요.';
  }
  return null;
}

export function managedThreadsInputProblem(
  input: { appName: string; label: string; token: string },
  registering: boolean,
): string | null {
  const nameProblem = registering ? managedThreadsNameProblem(input) : null;
  if (nameProblem) return nameProblem;
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
  editingNames = false,
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
  /** Names only, for editing an existing account; the token field is omitted. */
  editingNames?: boolean;
  disabled: boolean;
  onAppNameChange(value: string): void;
  onLabelChange(value: string): void;
  onTokenChange(value: string): void;
}) {
  // A new account is refused before Meta when any of these equals another account's value.
  const unique = registering && <span className="managed-threads-field-note">(중복 불가)</span>;
  return (
    <>
      {(registering || editingNames) && (
        <>
          <label htmlFor={`${id}-app-name`}>Meta 앱 이름{unique}</label>
          <input
            id={`${id}-app-name`}
            value={appName}
            onChange={(event) => onAppNameChange(event.target.value)}
            disabled={disabled}
            maxLength={80}
            autoComplete="off"
            placeholder="개발자센터에서 정한 앱 이름"
          />
          <label htmlFor={`${id}-label`}>Threads 계정 이름{unique}</label>
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
      {!editingNames && (
        <>
          <label htmlFor={`${id}-token`}>
            {registering ? '장기 토큰' : '새 장기 토큰'}
            {unique}
          </label>
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
      )}
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
        <p>게시 대기·미게시 댓글과 진행 중·결과 불명 등록 작업을 종료합니다.</p>
        <p>
          이미 Meta로 전송한 요청은 취소할 수 없으며 실제 등록 여부는 미확인일 수 있습니다. 받은
          결과와 이력은 보존합니다.
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
  const [renaming, setRenaming] = useState<ManagedThreadsAccountRow | null>(null);
  const [explaining, setExplaining] = useState<ManagedThreadsAccountRow | null>(null);
  const [deleting, setDeleting] = useState<ManagedThreadsAccountRow | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const actionOpener = useRef<HTMLElement | null>(null);
  const disabled = !enabled || accounts.busy || !accounts.loaded;
  const editing = enabled && (registering || !!replacing);
  const visibleAccounts = enabled ? accounts.accounts : [];
  const selected = visibleAccounts.find((row) => row.localId === selectedId) ?? null;
  const available = managedThreadsActionAvailability(selected, clock, accounts.refreshWindowDays);
  const actionDialogOpen = editing || !!renaming || !!explaining || !!deleting;
  const actionDisabled = disabled || actionDialogOpen;
  // The server allows one Meta request per employee per interval. Every Meta request button
  // stays disabled meanwhile, so the countdown is shown once beside the selected-account actions.
  const cooldown = managedThreadsCooldownTime(accounts.cooldownUntil - clock);
  const headingId = titleId ?? `${id}-title`;
  useEffect(() => {
    setClock(Date.now());
    if (accounts.cooldownUntil <= Date.now()) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setClock(current);
      if (current >= accounts.cooldownUntil) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [accounts.cooldownUntil]);
  useEffect(() => {
    if (enabled) return;
    setToken('');
    setLabel('');
    setAppName('');
    setRegistering(false);
    setReplacing(null);
    setRenaming(null);
    setExplaining(null);
    setDeleting(null);
    setSelectedId(null);
  }, [enabled]);
  function closeForm() {
    setToken('');
    setLabel('');
    setAppName('');
    setRegistering(false);
    setReplacing(null);
    setRenaming(null);
  }
  // Separate from save(): the shared name fields must never reach a token mutation.
  async function rename() {
    if (disabled || !renaming?.account) return;
    const problem = managedThreadsNameProblem({ appName, label });
    if (problem) {
      notify({ message: problem, error: true });
      return;
    }
    const ok = await accounts.update({
      accountId: renaming.account.id,
      appName: appName.trim(),
      label: label.trim(),
    });
    if (ok) closeForm();
  }
  async function save() {
    if (disabled || cooldown) return;
    const problem = managedThreadsInputProblem({ appName, label, token }, registering);
    if (problem) {
      notify({ message: problem, error: true });
      return;
    }
    const inputToken = token.trim();
    const ok = registering
      ? await accounts.register({ appName: appName.trim(), label: label.trim(), token: inputToken })
      : replacing?.account
        ? await accounts.replace({
            accountId: replacing.account.id,
            expectedRevision: replacing.account.tokenRevision,
            token: inputToken,
          })
        : false;
    // The server saves first, so a failure stores nothing and the input stays for another try.
    if (ok) closeForm();
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
            disabled={actionDisabled || !!cooldown}
            onClick={(event) => {
              actionOpener.current = event.currentTarget;
              closeForm();
              setRegistering(true);
            }}
          >
            <span aria-hidden="true" className="managed-threads-plus">
              ＋
            </span>{' '}
            계정 추가
          </button>
        </div>
      </div>
      <p className="managed-threads-intro">
        계정을 선택하면 정보 수정·토큰 교체·갱신·삭제를 할 수 있습니다. 토큰 확인이 필요한 계정은
        토큰 확인 칸에 [재확인]이 나옵니다.
      </p>
      <div className="managed-threads-selected-actions" role="group" aria-label="선택 계정 작업">
        <span className="managed-threads-actions-label">선택 계정</span>
        <button
          type="button"
          disabled={actionDisabled || !available.edit}
          onClick={(event) => {
            if (selected) {
              actionOpener.current = event.currentTarget;
              closeForm();
              setAppName(selected.appName);
              setLabel(selected.label);
              setRenaming(selected);
            }
          }}
        >
          정보 수정
        </button>
        <button
          type="button"
          disabled={actionDisabled || !available.replace || !!cooldown}
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
          className="managed-threads-refresh-action"
          disabled={actionDisabled || !available.refresh || !!cooldown}
          onClick={() => {
            if (selected?.account) void accounts.refreshToken({ accountId: selected.account.id });
          }}
        >
          갱신
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
        {/* A rare recovery step, kept apart from the everyday actions. */}
        <span className="managed-threads-toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          disabled={actionDisabled || !available.retry}
          onClick={() => {
            if (selected) void accounts.retry({ localId: selected.localId });
          }}
        >
          갱신 재시도
        </button>
        {!actionDisabled && available.retry && (
          <button
            type="button"
            className="managed-threads-info-button"
            aria-label="갱신 재시도가 필요한 이유"
            onClick={(event) => {
              if (selected) {
                actionOpener.current = event.currentTarget;
                setExplaining(selected);
              }
            }}
          >
            i
          </button>
        )}
        {cooldown && (
          <span className="managed-threads-cooldown-status" role="timer">
            다음 토큰 확인·갱신까지 <strong>{cooldown}</strong>
          </span>
        )}
      </div>
      {enabled && explaining && (
        <ManagedThreadsActionDialog
          title="갱신 재시도가 필요한 이유"
          busy={accounts.busy}
          onClose={() => setExplaining(null)}
          returnFocusTo={actionOpener.current}
        >
          <div className="managed-threads-confirm-copy">
            <strong>
              {explaining.appName} · {explaining.label}
            </strong>
            {managedThreadsResendExplanation(explaining).map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
          <div className="threads-actions managed-threads-dialog-actions">
            <button type="button" onClick={() => setExplaining(null)}>
              닫기
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
              저장하기 전에 이 PC가 Meta에 토큰을 확인합니다. 입력한 토큰은 암호화하여 저장한 뒤
              지워지며, 기존 토큰은 화면에 표시하지 않습니다.
            </p>
            <div className="threads-actions managed-threads-dialog-actions">
              <button type="button" disabled={disabled} onClick={closeForm}>
                취소
              </button>
              <button type="submit" className="primary" disabled={disabled || !!cooldown}>
                <MetaActionLabel cooldown={cooldown && `${cooldown} 후 가능`}>
                  {accounts.busy ? '확인·저장 중…' : '확인하고 암호화하여 저장'}
                </MetaActionLabel>
              </button>
            </div>
          </form>
        </ManagedThreadsActionDialog>
      )}
      {enabled && renaming && (
        <ManagedThreadsActionDialog
          title="계정 정보 수정"
          busy={accounts.busy}
          onClose={closeForm}
          returnFocusTo={actionOpener.current}
        >
          <form
            className="threads-form managed-threads-form"
            onSubmit={(event) => {
              event.preventDefault();
              void rename();
            }}
          >
            <ManagedThreadsAccountFields
              id={id}
              appName={appName}
              label={label}
              token=""
              registering={false}
              editingNames
              disabled={disabled}
              onAppNameChange={setAppName}
              onLabelChange={setLabel}
              onTokenChange={() => {}}
            />
            <p>이름은 계정을 구분하는 표시용입니다. 토큰과 확인 상태는 바뀌지 않습니다.</p>
            <div className="threads-actions managed-threads-dialog-actions">
              <button type="button" disabled={disabled} onClick={closeForm}>
                취소
              </button>
              <button type="submit" className="primary" disabled={disabled}>
                {accounts.busy ? '저장 중…' : '저장'}
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
        now={clock}
        recheckDisabled={!!cooldown}
        onSelect={setSelectedId}
        onRecheck={(row) => {
          if (row.account) void accounts.recheck({ accountId: row.account.id });
        }}
      />
      <div className="managed-threads-selection-summary" aria-live="polite">
        {selected ? (
          <>
            <strong>
              {selected.appName} · {selected.label}
            </strong>
            {selected.pendingDeletion ? (
              <p>삭제 결과를 확인할 때까지 토큰 교체를 막습니다. [삭제 재시도]를 눌러 주세요.</p>
            ) : selected.pendingAction ? (
              <p>서버에 반영하지 못한 갱신이 있습니다. [갱신 재시도]를 눌러 주세요.</p>
            ) : selected.localState === 'missing' ? (
              <p>
                서버 목록에서 계정을 찾을 수 없습니다. 계정 관리 창을 다시 열면 서버 상태를 다시
                읽습니다.
              </p>
            ) : (
              <p>
                [갱신]은 확인된 계정의 만료가 {accounts.refreshWindowDays}일 이내일 때 열립니다.
              </p>
            )}
            {selected.lastCheck && (
              <div className="managed-threads-last-check">
                <ul aria-label="최근 토큰 확인 결과">
                  {managedThreadsCheckLines(selected.lastCheck).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                {selected.lastCheck.result !== 'success' && (
                  <button
                    type="button"
                    onClick={() => {
                      const text = [
                        `${selected.appName} · ${selected.label}`,
                        ...managedThreadsCheckLines(selected.lastCheck!),
                      ].join('\n');
                      const failed = () =>
                        notify({
                          message: '오류 내용을 복사하지 못했습니다. 화면의 내용을 확인해 주세요.',
                          error: true,
                        });
                      try {
                        navigator.clipboard
                          .writeText(text)
                          .then(() => notify({ message: '오류 내용을 복사했습니다.' }), failed);
                      } catch {
                        failed();
                      }
                    }}
                  >
                    오류 내용 복사
                  </button>
                )}
              </div>
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
          앱 이름은 구분용입니다. 실제 Threads 계정은 이 PC가 Meta에 토큰을 확인해 구분합니다.
          <br />
          토큰 확인·갱신은 이 PC 프로그램이 Meta에 직접 요청하며, 직원마다 10분에 한 번(유효하지
          않은 토큰이면 5분 뒤) 요청할 수 있습니다. 토큰은 이 PC와 서버에 암호화하여 저장합니다.
        </p>
      </div>
    </section>
  );
}
