import { useEffect, useState } from 'react';
import type { ReleaseNote } from '../shared/release-notes';
import { ManagedThreadsActionDialog } from './ManagedThreadsActionDialog';
import './managed-threads.css';
import './release-notes.css';

const KINDS = [
  ['added', '새로 생긴 것'],
  ['changed', '바뀐 것'],
  ['fixed', '고친 것'],
] as const;

/** The update notes, newest version first, each with what was added, changed and fixed. */
export function ReleaseNotesDialog({
  notes,
  onClose,
}: {
  notes: readonly ReleaseNote[];
  onClose(): void;
}) {
  return (
    <ManagedThreadsActionDialog
      title="업데이트 내역"
      busy={false}
      onClose={onClose}
      focusInput={false}
      className="release-notes-dialog"
    >
      <div className="release-notes-list">
        {notes.map((note) => (
          <section key={note.version} className="release-notes-version">
            <h4>{note.version}</h4>
            {KINDS.map(([kind, label]) => {
              const items = note[kind];
              return items?.length ? (
                <div key={kind} className="release-notes-kind">
                  <p>{label}</p>
                  <ul>
                    {items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null;
            })}
          </section>
        ))}
      </div>
      <div className="threads-actions managed-threads-dialog-actions">
        <button type="button" className="primary" onClick={onClose}>
          확인
        </button>
      </div>
    </ManagedThreadsActionDialog>
  );
}

/**
 * The notes this PC has not seen, shown once on the signed-in screen (2026-11-26, the user's
 * call). Closing records the version. When main cannot answer, nothing shows and the next
 * launch asks again.
 */
export function PendingReleaseNotes() {
  const [notes, setNotes] = useState<readonly ReleaseNote[]>([]);
  useEffect(() => {
    let live = true;
    window.threadsMedia.getReleaseNotes().then(
      (value) => {
        if (live) setNotes(value);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  if (!notes.length) return null;
  return (
    <ReleaseNotesDialog
      notes={notes}
      onClose={() => {
        setNotes([]);
        void window.threadsMedia.markReleaseNotesSeen().catch(() => {});
      }}
    />
  );
}
