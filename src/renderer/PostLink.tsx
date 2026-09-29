import { useRef } from 'react';
import type { OpenPostLinkInput } from '../shared/contracts';
import { useToast } from './toast';

export function PostLink({ postKey, kind, url }: OpenPostLinkInput & { url: string }) {
  const pending = useRef(false);
  const notify = useToast();
  async function open() {
    if (pending.current) return;
    pending.current = true;
    try {
      const result = await window.threadsMedia.openPostLink({ postKey, kind });
      if (result.status === 'error') notify({ message: result.problem.message, error: true });
    } catch {
      notify({ message: '링크를 열지 못했습니다. 다시 시도하세요.', error: true });
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
    </div>
  );
}
