import type { Attachment, Post } from '../shared/contracts';
import { MediaCarousel } from './MediaCarousel';
import { displayDate } from './view-model';
import { registrationMedia } from './registration-model';
import { Icon } from './Icon';
import { postDraftExportIssue } from '../shared/post-export';

export function RegisteredPostCard({
  post,
  ordinal,
  onChange,
  onOpen,
  onDelete,
  onExport,
  exporting,
  actionsDisabled,
}: {
  post: Post;
  ordinal?: number;
  onChange(ordinal: number): void;
  onOpen(): void;
  onDelete(): void;
  onExport(): void;
  exporting: boolean;
  actionsDisabled: boolean;
}) {
  if (!post.draft) return null;
  const exportIssue = postDraftExportIssue(post);
  const available = registrationMedia(post);
  const items: Attachment[] = post.draft.mediaIds.map((id, index) => ({
    ...(available.find((item) => item.mediaId === id) ?? {
      kind: 'image',
      status: 'unavailable',
      reason: 'draft_media_missing',
      addressStatus: '',
      observedAt: null,
      mediaId: id,
      localUrl: null,
    }),
    ordinal: index + 1,
  }));
  return (
    <article className="post-card" aria-label={`@${post.account} 등록한 게시글`}>
      <MediaCarousel
        items={items}
        includeEditsInType
        ordinal={ordinal}
        onChange={onChange}
        onOpen={onOpen}
        label={`@${post.account} 등록 미디어`}
      />
      <button className="post-card-copy" type="button" onClick={onOpen}>
        <div className="post-card-account">
          <strong>@{post.account}</strong>
          <Icon name="right" />
        </div>
        <p>{post.draft.caption || '캡션이 없는 게시글'}</p>
        <time className="post-card-date">{displayDate(post.draft.updatedAt)} 수정</time>
      </button>
      <div className="post-card-bottom">
        <button
          className="post-delete-button"
          type="button"
          aria-label={`${post.postId} 등록한 게시글 삭제`}
          title="등록한 게시글 삭제"
          disabled={actionsDisabled}
          onClick={onDelete}
        >
          <Icon name="trash" />
        </button>
        <button
          className={`post-export-button ${exporting ? 'is-exporting' : ''}`}
          type="button"
          aria-label={exporting ? 'ZIP 저장 중' : `${post.postId} 등록한 게시글 ZIP 다운로드`}
          aria-busy={exporting}
          title={exporting ? 'ZIP 저장 중…' : (exportIssue ?? '등록한 게시글 ZIP 다운로드')}
          disabled={actionsDisabled || !!exportIssue}
          onClick={onExport}
        >
          <Icon name={exporting ? 'refresh' : 'download'} />
        </button>
      </div>
    </article>
  );
}
