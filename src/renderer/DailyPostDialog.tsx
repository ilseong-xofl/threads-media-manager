import { useId, useState } from 'react';
import { DAILY_TEXT_LIMIT, dailyTextLength, type DailyPost } from '../shared/daily';
import { ManagedThreadsActionDialog } from './ManagedThreadsActionDialog';
import './managed-threads.css';

export function DailyPostDialog({
  post,
  busy,
  onSave,
  onClose,
}: {
  post: DailyPost;
  busy: boolean;
  onSave(text: string): Promise<boolean>;
  onClose(): void;
}) {
  const id = useId();
  const [text, setText] = useState(post.text);
  const length = dailyTextLength(text);
  const valid = dailyTextLength(text.trim()) >= 1 && length <= DAILY_TEXT_LIMIT;
  return (
    <ManagedThreadsActionDialog title="초안 수정" busy={busy} onClose={onClose}>
      <form
        className="daily-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !valid) return;
          void onSave(text).then((saved) => {
            if (saved) onClose();
          });
        }}
      >
        <label htmlFor={`${id}-text`}>본문</label>
        <textarea
          id={`${id}-text`}
          value={text}
          rows={8}
          disabled={busy}
          aria-describedby={`${id}-count`}
          onChange={(event) => setText(event.target.value)}
        />
        <p
          id={`${id}-count`}
          className={`daily-form-count ${length > DAILY_TEXT_LIMIT ? 'is-over' : ''}`}
        >
          {length} / {DAILY_TEXT_LIMIT}
        </p>
        <div className="threads-actions managed-threads-dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            취소
          </button>
          <button type="submit" className="primary" disabled={busy || !valid}>
            {busy ? '저장 중…' : '저장'}
          </button>
        </div>
      </form>
    </ManagedThreadsActionDialog>
  );
}
