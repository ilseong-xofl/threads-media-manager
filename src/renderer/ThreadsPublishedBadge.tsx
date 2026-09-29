import type { ThreadsPublication } from '../shared/threads-api';

export function isPublishedPost(
  publication: ThreadsPublication | undefined,
): publication is ThreadsPublication {
  return (
    publication?.kind === 'post' && publication.status === 'published' && !!publication.remoteId
  );
}

export function ThreadsPublishedBadge({ publication }: { publication?: ThreadsPublication }) {
  if (!isPublishedPost(publication)) return null;
  return (
    <span
      className="threads-published-badge"
      title={`@${publication.username} 계정의 Threads 게시 이력`}
    >
      등록 완료
    </span>
  );
}

export function isPublishedReply(
  reply: ThreadsPublication | undefined,
  publication: ThreadsPublication | undefined,
): reply is ThreadsPublication {
  return (
    isPublishedPost(publication) &&
    reply?.kind === 'reply' &&
    reply.status === 'published' &&
    !!reply.remoteId &&
    reply.postKey === publication.postKey &&
    reply.accountId === publication.accountId
  );
}

export function ThreadsReplyPublishedBadge({
  reply,
  publication,
}: {
  reply?: ThreadsPublication;
  publication?: ThreadsPublication;
}) {
  if (!isPublishedReply(reply, publication)) return null;
  return (
    <span
      className="threads-published-badge threads-reply-published-badge"
      title={`@${reply.username} 계정의 Threads 댓글 게시 이력`}
    >
      댓글 완료
    </span>
  );
}
