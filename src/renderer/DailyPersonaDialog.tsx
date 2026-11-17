import { useEffect, useId, useState, type FocusEvent, type KeyboardEvent } from 'react';
import type { CaptionLanguage } from '../shared/contracts';
import {
  DAILY_NAME_LIMIT,
  type DailyPersona,
  type DailyPost,
  type SaveDailyPersonaInput,
} from '../shared/daily';
import type { ManagedThreadsAccountRow } from '../shared/managed-threads';
import { ManagedThreadsActionDialog } from './ManagedThreadsActionDialog';
import {
  DAILY_DESCRIPTION_LABELS,
  dailyAccountChoices,
  dailyAccountLocked,
  dailyAccountRow,
  dailyDescriptionText,
  dailyDescriptionValues,
  dailyPersonaExamples,
  type DailyPersonaExample,
} from './daily-model';
import { mobilePublicationAccountLabel } from './mobile-publication-model';
import './managed-threads.css';

const languages: { value: CaptionLanguage; label: string }[] = [
  { value: 'ko', label: '한국어' },
  { value: 'ja', label: '일본어' },
  { value: 'en', label: '영어' },
];

/** Matches the length of the `daily-hint` animation in daily.css. */
const HINT_CYCLE_MS = 4000;

/** The example persona the empty fields show; it moves on each time the hint fades out. */
function useDailyExample(active: boolean) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(
      () => setIndex((value) => (value + 1) % dailyPersonaExamples.length),
      HINT_CYCLE_MS,
    );
    return () => window.clearInterval(timer);
  }, [active]);
  return dailyPersonaExamples[index]!;
}

/** Five items of this length and their names stay within the description limit. */
const DESCRIPTION_VALUE_LIMIT = 300;

/**
 * Example text over an empty field (2026-11-17, after Suno's create form). It fades in and out
 * until the field takes focus; then the example seen last stays as a placeholder that Tab accepts.
 */
function DailyHint({ moving, held, cycle }: { moving: string; held: string; cycle: string }) {
  return (
    <>
      <span className="daily-hint daily-hint-moving" aria-hidden="true">
        {/* The key changes with each example so the animation starts over. */}
        <span key={cycle} className="daily-hint-text">
          {moving}
        </span>
      </span>
      <span className="daily-hint daily-hint-held" aria-hidden="true">
        {held}
        <span className="daily-hint-key">Tab</span>
      </span>
    </>
  );
}

type HintField = 'name' | 'description';
/** Tab alone accepts the example; with a modifier it keeps its usual meaning. */
const acceptsExample = (event: KeyboardEvent) =>
  event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;

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
  const [description, setDescription] = useState(() =>
    dailyDescriptionValues(persona?.description ?? ''),
  );
  const setItem = (index: number, value: string) =>
    setDescription(description.map((item, at) => (at === index ? value : item)));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Until the account list arrives, neither the lock nor a removed account can be judged.
  const locked = !accountsLoaded || (!!persona && dailyAccountLocked(persona, posts, rows));
  const choices = dailyAccountChoices(rows, personas, persona?.id);
  const current = persona ? dailyAccountRow(persona.accountId, rows) : null;
  // A locked account may be unusable (being deleted); it is still shown as the bound account.
  const options = current && !choices.includes(current) ? [current, ...choices] : choices;
  const waiting =
    !!persona && posts.some((p) => p.personaId === persona.id && p.state === 'waiting');
  const example = useDailyExample(!name || description.some((value) => !value));
  // The example on screen as a field took focus; the other field keeps moving on.
  const [held, setHeld] = useState<{ field: HintField; example: DailyPersonaExample } | null>(null);
  const hold = (field: HintField) => ({
    // Moving between the description items keeps the example they started with.
    onFocus: () => setHeld((now) => (now?.field === field ? now : { field, example })),
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setHeld(null);
    },
  });
  const heldExample = (field: HintField) => (held?.field === field ? held.example : example);
  const selectable = options.some((row) => row.account!.id === accountId);
  const canSave =
    !busy &&
    accountsLoaded &&
    name.trim().length > 0 &&
    dailyDescriptionText(description).length > 0 &&
    selectable;
  return (
    <>
      <ManagedThreadsActionDialog
        title={persona ? '페르소나 설정' : '페르소나 만들기'}
        busy={busy}
        onClose={onClose}
        // A new persona opens with no field focused so the example text is seen first.
        focusInput={!!persona}
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
              description: dailyDescriptionText(description),
            }).then((saved) => {
              if (saved) onClose();
            });
          }}
        >
          <label htmlFor={`${id}-name`}>이름</label>
          <div className="daily-hint-field" {...hold('name')}>
            <input
              id={`${id}-name`}
              value={name}
              maxLength={DAILY_NAME_LIMIT}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (name || !acceptsExample(event)) return;
                event.preventDefault();
                setName(heldExample('name').name);
              }}
            />
            {!name && (
              <DailyHint
                moving={example.name}
                held={heldExample('name').name}
                cycle={example.name}
              />
            )}
          </div>
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
          <div className="daily-fields" {...hold('description')}>
            {DAILY_DESCRIPTION_LABELS.map((label, index) => (
              <label key={label} className="daily-field">
                <span className="daily-field-name">{label}:</span>
                <span className="daily-hint-field">
                  <input
                    id={index === 0 ? `${id}-description` : undefined}
                    value={description[index]}
                    maxLength={DESCRIPTION_VALUE_LIMIT}
                    autoComplete="off"
                    disabled={busy}
                    onChange={(event) => setItem(index, event.target.value)}
                    onKeyDown={(event) => {
                      if (description[index] || !acceptsExample(event)) return;
                      event.preventDefault();
                      setItem(index, heldExample('description').values[index]!);
                    }}
                  />
                  {!description[index] && (
                    <DailyHint
                      moving={example.values[index]!}
                      held={heldExample('description').values[index]!}
                      cycle={example.name}
                    />
                  )}
                </span>
              </label>
            ))}
          </div>
          <p className="daily-form-note">
            항목 옆에 내용을 적어 주세요. 비워 둔 항목은 저장하지 않습니다.
          </p>
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
