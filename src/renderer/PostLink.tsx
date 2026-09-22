import { useRef, useState } from 'react';
import type { OpenPostLinkInput } from '../shared/contracts';

export function PostLink({ postKey, kind, url }: OpenPostLinkInput & { url: string }) {
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  async function open() {
    if (pending.current) return;
    pending.current = true;
    setError(null);
    try {
      const result = await window.threadsMedia.openPostLink({ postKey, kind });
      if (result.status === 'error') setError(result.problem.message);
    } catch {
      setError('링크를 열지 못했습니다. 다시 시도하세요.');
    } finally {
      pending.current = false;
    }
  }
  return (
    <div className="source-address">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title="기본 브라우저의 새 탭에서 열기"
        onClick={(event) => {
          event.preventDefault();
          void open();
        }}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          void open();
        }}
      >
        {url}
      </a>
      {error && (
        <p className="comment-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
