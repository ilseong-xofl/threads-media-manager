import { useState } from 'react';
import {
  THREADS_INSIGHTS_HOUR,
  type ThreadsPublication,
  type ThreadsState,
} from '../shared/threads-api';
import type { ThreadsUi } from './use-threads-api';
import { displayDate } from './view-model';
import { useToastMessage } from './toast';
import './threads-api.css';

export function latestPublication(
  state: ThreadsState | null,
  postKey: string,
  kind: 'post' | 'reply',
) {
  return state?.publications
    .filter(
      (item) =>
        item.postKey === postKey && item.accountId === state.account?.id && item.kind === kind,
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}
export function publicationBlocksUpload(item: ThreadsPublication | undefined): boolean {
  return !!item && item.status !== 'failed';
}
const labels: Record<ThreadsPublication['status'], string> = {
  preparing: '업로드 준비 중',
  processing: '미디어 처리 중',
  publishing: '게시 중',
  published: '등록 완료',
  failed: '업로드 실패',
  uncertain: '게시 결과 확인 필요',
};
export function ThreadsMetrics({ publication }: { publication: ThreadsPublication }) {
  return (
    <div className="threads-metrics">
      <dl>
        <div>
          <dt>조회</dt>
          <dd>{publication.metrics?.views?.toLocaleString() ?? '—'}</dd>
        </div>
        <div>
          <dt>좋아요</dt>
          <dd>{publication.metrics?.likes?.toLocaleString() ?? '—'}</dd>
        </div>
        <div>
          <dt>댓글</dt>
          <dd>{publication.metrics?.replies?.toLocaleString() ?? '—'}</dd>
        </div>
      </dl>
      <p>
        {publication.metricsUpdatedAt
          ? `${displayDate(publication.metricsUpdatedAt)} 갱신`
          : '아직 통계를 조회하지 않았습니다.'}
      </p>
    </div>
  );
}
function PublicationStatus({
  item,
  threads,
  disabled,
}: {
  item: ThreadsPublication;
  threads: ThreadsUi;
  disabled: boolean;
}) {
  const [remoteId, setRemoteId] = useState('');
  const account = threads.state?.account;
  const blocked =
    disabled ||
    threads.working ||
    threads.loading ||
    !account ||
    !!account.requiresReconnect ||
    Date.parse(account.expiresAt) <= Date.now();
  const recoverable = ['preparing', 'processing', 'publishing', 'uncertain'].includes(item.status);
  return (
    <article className="threads-publication-status">
      <div className="threads-section-heading">
        <strong>
          {item.kind === 'post' ? '게시글' : '댓글'} {labels[item.status]}
        </strong>
        <span>@{item.username}</span>
      </div>
      {item.remoteId && <p className="threads-id">게시 ID: {item.remoteId}</p>}
      {item.publishedAt && (
        <p className="threads-publication-time">
          <span>{displayDate(item.publishedAt)} 게시</span>
          {item.kind === 'post' && (
            <span>(매일 오전 {THREADS_INSIGHTS_HOUR}시에 자동 갱신됩니다.)</span>
          )}
        </p>
      )}
      {item.status === 'published' && item.kind === 'post' && item.metricsUpdatedAt && (
        <ThreadsMetrics publication={item} />
      )}
      {recoverable && (
        <div className="threads-recovery">
          <p>
            게시 결과를 확인한 뒤 계속할 수 있습니다. Threads에서 이미 게시됐다면 해당 게시글의 API
            ID를 연결하세요.
          </p>
          <button
            type="button"
            disabled={blocked}
            onClick={() =>
              void threads.run(() =>
                window.threadsMedia.reconcileThreadsPublication({ id: item.id }),
              )
            }
          >
            상태 확인
          </button>
          <form
            className="threads-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (blocked || !/^\d+$/.test(remoteId.trim())) return;
              void threads
                .run(() =>
                  window.threadsMedia.reconcileThreadsPublication({
                    id: item.id,
                    remoteId: remoteId.trim(),
                  }),
                )
                .then((ok) => {
                  if (ok) setRemoteId('');
                });
            }}
          >
            <label htmlFor={`threads-remote-${item.id}`}>실제 게시글 API ID</label>
            <input
              id={`threads-remote-${item.id}`}
              inputMode="numeric"
              pattern="[0-9]+"
              maxLength={64}
              value={remoteId}
              onChange={(event) => setRemoteId(event.target.value)}
              disabled={blocked}
              placeholder="Threads API에서 확인한 숫자 ID"
              required
            />
            <button type="submit" disabled={blocked || !/^\d+$/.test(remoteId.trim())}>
              게시 결과 연결
            </button>
          </form>
        </div>
      )}
    </article>
  );
}
export function ThreadsPublicationPanel({
  postKey,
  threads,
  disabled = false,
}: {
  postKey: string;
  threads: ThreadsUi;
  disabled?: boolean;
}) {
  const post = latestPublication(threads.state, postKey, 'post');
  const reply = latestPublication(threads.state, postKey, 'reply');
  const errorMessage =
    threads.error ||
    threads.state?.accountProblem?.message ||
    threads.state?.problem?.message ||
    post?.problem?.message ||
    reply?.problem?.message ||
    post?.metricsProblem?.message;
  useToastMessage(errorMessage, true);
  return (
    <section
      className="registration-section threads-panel"
      aria-labelledby="threads-publication-title"
    >
      <h3 id="threads-publication-title" className="section-divider">
        API 업로드
      </h3>
      {!post && (
        <div className="threads-section-heading">
          {threads.loading ? (
            <p role="status">연결 상태 확인 중…</p>
          ) : !threads.state?.account ? (
            <p>설정에서 Threads 계정을 연결하세요.</p>
          ) : !threads.state.storageConfigured ? (
            <p>설정에서 파일 서버 연결 코드를 등록하세요.</p>
          ) : !post ? (
            <p>아래 API 업로드를 누르면 연결 계정과 등록 내용을 확인한 뒤 게시합니다.</p>
          ) : null}
          {threads.state?.account && <span>@{threads.state.account.username}</span>}
        </div>
      )}
      {post && (
        <PublicationStatus key={post.id} item={post} threads={threads} disabled={disabled} />
      )}
      {reply && (
        <PublicationStatus key={reply.id} item={reply} threads={threads} disabled={disabled} />
      )}
    </section>
  );
}
