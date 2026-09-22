import type { Post } from '../shared/contracts';
import { displayDate, postMedia } from './view-model';
import { Icon } from './Icon';
import { MediaCarousel } from './MediaCarousel';
import { postExportIssue } from '../shared/post-export';

export function PostCard({
  post,
  ordinal,
  onChange,
  onOpen,
  onExport,
  exporting,
  exportDisabled,
  deleteDisabled,
  onDeletePost,
  onDeleteEdit,
}: {
  post: Post;
  ordinal?: number;
  onChange(ordinal: number): void;
  onOpen(): void;
  onExport(): void;
  exporting: boolean;
  exportDisabled: boolean;
  deleteDisabled: boolean;
  onDeletePost(): void;
  onDeleteEdit(mediaId: string): void;
}) {
  const exportIssue = postExportIssue(post);
  return (
    <article className="post-card" aria-label={`@${post.account} 게시글`}>
      <MediaCarousel
        items={postMedia(post)}
        ordinal={ordinal}
        onChange={onChange}
        onOpen={onOpen}
        onDeleteEdit={onDeleteEdit}
        deleteDisabled={deleteDisabled}
        label={`@${post.account} 게시글 첨부`}
      />
      <button
        className="post-card-copy"
        type="button"
        onClick={onOpen}
        aria-label={`@${post.account} 게시글 정보 보기`}
      >
        <div className="post-card-account">
          <strong>@{post.account}</strong>
          <Icon name="right" />
        </div>
        <p>
          {post.caption ||
            (post.captionStatus === 'complete' ? '캡션이 없는 게시글' : '원문 확인 필요')}
        </p>
        <time className="post-card-date">
          {displayDate(post.publishedAt).split(' ').slice(0, 3).join(' ')}
        </time>
      </button>
      <div className="post-card-bottom">
        <button
          className="post-delete-button"
          type="button"
          aria-label={`${post.postId} 게시글 삭제`}
          title="게시글 삭제"
          disabled={deleteDisabled}
          onClick={onDeletePost}
        >
          <Icon name="trash" />
        </button>
        <button
          className={`post-export-button ${exporting ? 'is-exporting' : ''}`}
          type="button"
          aria-label={exporting ? 'ZIP 저장 중' : `${post.postId} ZIP 다운로드`}
          aria-busy={exporting}
          title={exporting ? 'ZIP 저장 중…' : (exportIssue ?? '게시글 ZIP 다운로드')}
          disabled={exportDisabled || !!exportIssue}
          onClick={onExport}
        >
          <Icon name={exporting ? 'refresh' : 'download'} />
        </button>
        {post.draft && (
          <span className="post-draft-marker" title="등록을 위한 작성이 완료된 게시글">
            <span className="post-draft-badge">등록</span>
          </span>
        )}
      </div>
    </article>
  );
}
