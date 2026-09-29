import { useRef, useState } from 'react';
import type { ThreadsPublication } from '../shared/threads-api';
import { useToast } from './toast';

export function ThreadsPublicationLink({
  item,
  disabled = false,
}: {
  item: ThreadsPublication;
  disabled?: boolean;
}) {
  const pending = useRef(false);
  const [opening, setOpening] = useState(false);
  const notify = useToast();
  async function open() {
    if (disabled || pending.current || item.status !== 'published' || !item.remoteId) return;
    pending.current = true;
    setOpening(true);
    try {
      const result = await window.threadsMedia.openThreadsPublication({ id: item.id });
      if (result.status === 'error') notify({ message: result.problem.message, error: true });
    } catch {
      notify({ message: '게시글 링크를 열지 못했습니다. 다시 시도하세요.', error: true });
    } finally {
      pending.current = false;
      setOpening(false);
    }
  }
  if (!item.remoteId) return null;
  return (
    <p className="threads-id">
      게시 ID:{' '}
      {item.status === 'published' ? (
        <button
          type="button"
          className="threads-publication-link"
          disabled={disabled || opening}
          aria-busy={opening}
          aria-label={`${item.kind === 'post' ? '게시글' : '댓글'} ${item.remoteId} 기본 브라우저에서 열기`}
          title="기본 브라우저에서 열기"
          onClick={() => void open()}
        >
          {item.remoteId}
        </button>
      ) : (
        item.remoteId
      )}
    </p>
  );
}
