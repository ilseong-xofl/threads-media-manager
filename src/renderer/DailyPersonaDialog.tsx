import { useId, useState } from 'react';
import type { CaptionLanguage } from '../shared/contracts';
import {
  DAILY_DESCRIPTION_LIMIT,
  DAILY_NAME_LIMIT,
  type DailyPersona,
  type DailyPost,
  type SaveDailyPersonaInput,
} from '../shared/daily';
import type { ManagedThreadsAccountRow } from '../shared/managed-threads';
import { ManagedThreadsActionDialog } from './ManagedThreadsActionDialog';
import { dailyAccountChoices, dailyAccountLocked, dailyAccountRow } from './daily-model';
import { mobilePublicationAccountLabel } from './mobile-publication-model';
import './managed-threads.css';

const languages: { value: CaptionLanguage; label: string }[] = [
  { value: 'ko', label: '한국어' },
  { value: 'ja', label: '일본어' },
  { value: 'en', label: '영어' },
];

export function DailyPersonaDialog({
  persona,
  personas,
  posts,
  rows,
  accountsLoaded,
  busy,
  onSave,
  onDelete,
  onClose,
}: {
  /** Omitted when creating a persona. */
  persona: DailyPersona | null;
  personas: DailyPersona[];
  posts: DailyPost[];
  rows: ManagedThreadsAccountRow[];
  accountsLoaded: boolean;
  busy: boolean;
  onSave(input: SaveDailyPersonaInput): Promise<boolean>;
  onDelete(): Promise<boolean>;
  onClose(): void;
}) {
  const id = useId();
  const [name, setName] = useState(persona?.name ?? '');
  const [accountId, setAccountId] = useState(persona?.accountId ?? '');
  const [language, setLanguage] = useState<CaptionLanguage>(persona?.language ?? 'ko');
  const [description, setDescription] = useState(persona?.description ?? '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Until the account list arrives, neither the lock nor a removed account can be judged.
  const locked = !accountsLoaded || (!!persona && dailyAccountLocked(persona, posts, rows));
  const choices = dailyAccountChoices(rows, personas, persona?.id);
  const current = persona ? dailyAccountRow(persona.accountId, rows) : null;
  // A locked account may be unusable (being deleted); it is still shown as the bound account.
  const options = current && !choices.includes(current) ? [current, ...choices] : choices;
  const waiting =
    !!persona && posts.some((p) => p.personaId === persona.id && p.state === 'waiting');
  const selectable = options.some((row) => row.account!.id === accountId);
  const canSave =
    !busy &&
    accountsLoaded &&
    name.trim().length > 0 &&
    description.trim().length > 0 &&
    selectable;
  return (
    <>
      <ManagedThreadsActionDialog
        title={persona ? '페르소나 설정' : '페르소나 만들기'}
        busy={busy}
        onClose={onClose}
      >
        <form
          className="daily-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSave) return;
            void onSave({
              ...(persona ? { personaId: persona.id } : {}),
              name: name.trim(),
              accountId,
              language,
              description,
            }).then((saved) => {
              if (saved) onClose();
            });
          }}
        >
          <label htmlFor={`${id}-name`}>이름</label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={DAILY_NAME_LIMIT}
            autoComplete="off"
            placeholder="보드에 표시할 이름"
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
          <label htmlFor={`${id}-account`}>연동 계정</label>
          <select
            id={`${id}-account`}
            value={selectable ? accountId : ''}
            disabled={busy || locked}
            onChange={(event) => setAccountId(event.target.value)}
          >
            <option value="" disabled>
              {options.length > 0 ? '계정을 고르세요' : '연동할 수 있는 계정이 없습니다'}
            </option>
            {options.map((row) => (
              <option key={row.account!.id} value={row.account!.id}>
                {mobilePublicationAccountLabel(row.account!.id, rows)}
              </option>
            ))}
          </select>
          <p className="daily-form-note">
            {!accountsLoaded
              ? '계정 목록을 확인하고 있습니다.'
              : locked
                ? '글이 있는 페르소나는 연동 계정을 바꿀 수 없습니다.'
                : persona && !current
                  ? '연동했던 계정이 계정 관리에서 삭제되었습니다. 다른 계정을 고르세요.'
                  : '계정 하나에는 페르소나 하나만 연동할 수 있습니다.'}
          </p>
          <label htmlFor={`${id}-language`}>언어</label>
          <select
            id={`${id}-language`}
            value={language}
            disabled={busy}
            onChange={(event) => setLanguage(event.target.value as CaptionLanguage)}
          >
            {languages.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <label htmlFor={`${id}-description`}>설명</label>
          <textarea
            id={`${id}-description`}
            value={description}
            rows={6}
            maxLength={DAILY_DESCRIPTION_LIMIT}
            placeholder="예: 30세 · 5살·4살 아들 둘 · 수원 거주 · 육아와 살림 고민이 많음 · 편한 반말"
            disabled={busy}
            onChange={(event) => setDescription(event.target.value)}
          />
          <p className="daily-form-note">나이·가족·사는 곳·관심사·말투를 적어 주세요.</p>
          <div className="threads-actions managed-threads-dialog-actions daily-form-actions">
            {persona && (
              <button
                type="button"
                className="managed-threads-danger daily-form-delete"
                disabled={busy || waiting}
                title={waiting ? '휴대폰 대기 중인 글이 있으면 삭제할 수 없습니다.' : undefined}
                onClick={() => setConfirmingDelete(true)}
              >
                페르소나 삭제
              </button>
            )}
            <button type="button" disabled={busy} onClick={onClose}>
              취소
            </button>
            <button type="submit" className="primary" disabled={!canSave}>
              {busy ? '저장 중…' : '저장'}
            </button>
          </div>
        </form>
      </ManagedThreadsActionDialog>
      {persona && confirmingDelete && (
        <ManagedThreadsActionDialog
          title="페르소나 삭제"
          busy={busy}
          confirmation
          onClose={() => setConfirmingDelete(false)}
        >
          <div className="managed-threads-confirm-copy">
            <p>
              <strong>{persona.name}</strong> 페르소나와 이 PC에 저장된 글을 삭제합니다.
            </p>
            <p>Threads에 이미 올라간 글은 삭제되지 않습니다.</p>
          </div>
          <div className="threads-actions managed-threads-dialog-actions">
            <button type="button" disabled={busy} onClick={() => setConfirmingDelete(false)}>
              돌아가기
            </button>
            <button
              type="button"
              className="managed-threads-danger-primary"
              disabled={busy}
              onClick={() =>
                void onDelete().then((deleted) => {
                  if (deleted) onClose();
                })
              }
            >
              {busy ? '삭제 중…' : '삭제'}
            </button>
          </div>
        </ManagedThreadsActionDialog>
      )}
    </>
  );
}
