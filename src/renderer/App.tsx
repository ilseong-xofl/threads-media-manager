import { useEffect, useMemo, useRef, useState } from 'react';
import { DownloadToast, activeDownload, idleDownload } from './DownloadPanel';
import type {
  Attachment,
  CollectionView,
  DownloadView,
  MediaEditInput,
  MediaDeleteInput,
  SavePostCommentInput,
} from '../shared/contracts';
import { displayDate, filterPosts, isSavedPost, pendingPostCount, postMedia } from './view-model';
import { Icon } from './Icon';
import { PostCard } from './PostCard';
import { PostDetailModal } from './PostDetailModal';
import { ToastLayer } from './ToastLayer';
import { Pagination } from './Pagination';
import { paginate, POST_PAGE_SIZE, type PostListMode } from './post-pagination';
import { defaultDateRange, type DateRange } from './date-range';
import { DatePicker } from './DatePicker';

export function App() {
  const [view, setView] = useState<CollectionView>({ snapshot: null, error: null });
  const [busy, setBusy] = useState(true);
  const [account, setAccount] = useState('');
  const [query, setQuery] = useState('');
  const [dateRange, setDateRange] = useState<DateRange>(() => defaultDateRange());
  const [page, setPage] = useState(1);
  const [listMode, setListMode] = useState<PostListMode>(POST_PAGE_SIZE);
  const [scrollLimit, setScrollLimit] = useState<number>(POST_PAGE_SIZE);
  const scrollSentinel = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<string, number>>({});
  const [startingDownload, setStartingDownload] = useState(false);
  const [download, setDownload] = useState(idleDownload);
  const [exporting, setExporting] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<{ error: boolean; message: string } | null>(
    null,
  );
  const [savingEdit, setSavingEdit] = useState(false);
  const editPending = useRef(false);
  const [deleting, setDeleting] = useState(false);
  const deletePending = useRef(false);
  const [savingComment, setSavingComment] = useState(false);
  const commentPending = useRef(false);
  const localMutation = savingEdit || deleting || savingComment;
  const exportPending = useRef(false);
  const downloadPending = useRef(false);
  const revision = useRef(-1);
  const downloading = activeDownload(download) || startingDownload;
  const snapshot = view.snapshot;
  const deletionRecovery =
    view.error?.code === 'deletion_recovery_required' ||
    !!snapshot?.warnings.some((warning) => warning.code === 'deletion_recovery_required');
  const posts = useMemo(() => snapshot?.posts ?? [], [snapshot]);
  const savedPosts = useMemo(() => posts.filter(isSavedPost), [posts]);
  const pendingPosts = pendingPostCount(posts);
  const accounts = useMemo(
    () => [...new Set(savedPosts.map((post) => post.account))].sort(),
    [savedPosts],
  );
  const visible = useMemo(
    () => filterPosts(savedPosts, account, query, dateRange),
    [savedPosts, account, query, dateRange],
  );
  const detail = visible.find((post) => post.key === selected);
  const scrolling = listMode === 'scroll';
  const paginated = useMemo(
    () => paginate(visible, page, listMode === 'scroll' ? POST_PAGE_SIZE : listMode),
    [visible, page, listMode],
  );
  const shownPosts = scrolling ? visible.slice(0, scrollLimit) : paginated.items;
  const hasMore = scrolling && shownPosts.length < visible.length;
  useEffect(() => {
    if (page !== paginated.page) setPage(paginated.page);
  }, [page, paginated.page]);
  useEffect(() => {
    const sentinel = scrollSentinel.current;
    if (!hasMore || detail || !sentinel) return;
    let consumed = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (consumed || !entries.some((entry) => entry.isIntersecting)) return;
        consumed = true;
        observer.disconnect();
        setScrollLimit((limit) => Math.min(limit + POST_PAGE_SIZE, visible.length));
      },
      { rootMargin: '0px 0px 240px 0px' },
    );
    observer.observe(sentinel);
    return () => {
      consumed = true;
      observer.disconnect();
    };
  }, [
    hasMore,
    scrollLimit,
    visible.length,
    account,
    query,
    dateRange.from,
    dateRange.to,
    snapshot?.root,
    detail?.key,
  ]);
  function resetList() {
    setPage(1);
    setScrollLimit(POST_PAGE_SIZE);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function changeListMode(mode: PostListMode) {
    setListMode(mode);
    resetList();
  }
  function changePage(next: number) {
    setPage(next);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function changePosition(key: string, ordinal: number) {
    setPositions((previous) => ({ ...previous, [key]: ordinal }));
  }
  async function act(action: () => Promise<CollectionView>) {
    setBusy(true);
    try {
      setView(await action());
    } catch {
      setView((old) => ({
        ...old,
        error: { code: 'app_connection', message: '앱과 연결하지 못했습니다. 다시 시도하세요.' },
      }));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void act(() => window.threadsMedia.current());
    let disposed = false;
    let pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const state = await window.threadsMedia.downloadStatus();
        if (disposed) return;
        setDownload(state);
        if (revision.current !== state.revision) {
          revision.current = state.revision;
          const updated = await window.threadsMedia.current();
          if (!disposed) setView(updated);
        }
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(() => {
      void poll().catch(() => {});
    }, 300);
    void poll().catch(() => {});
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!actionNotice || actionNotice.error) return;
    const timer = setTimeout(() => setActionNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [actionNotice]);
  async function downloadAction(action: () => Promise<DownloadView>) {
    try {
      setDownload(await action());
    } catch {
      setDownload((old) => ({
        ...old,
        phase: 'error',
        problem: {
          code: 'download_connection',
          message: '다운로드 요청을 처리하지 못했습니다. 원본을 새로고침해 확인하세요.',
        },
      }));
    }
  }

  async function startDownloads() {
    if (downloadPending.current) return;
    downloadPending.current = true;
    setStartingDownload(true);
    setActionNotice(null);
    try {
      await downloadAction(() => window.threadsMedia.startDownload());
    } finally {
      downloadPending.current = false;
      setStartingDownload(false);
    }
  }

  async function saveMediaEdit(input: MediaEditInput): Promise<Attachment | null> {
    if (editPending.current) throw new Error('편집본을 저장하고 있습니다.');
    editPending.current = true;
    setSavingEdit(true);
    try {
      const result = await window.threadsMedia.saveMediaEdit(input);
      if (result.status === 'error') throw new Error(result.problem.message);
      setView(result.view);
      const post = result.view.snapshot?.posts.find((entry) => entry.key === input.postKey);
      return post
        ? (postMedia(post).find((entry) => entry.mediaId === result.mediaId) ?? null)
        : null;
    } finally {
      editPending.current = false;
      setSavingEdit(false);
    }
  }

  async function savePostComment(input: SavePostCommentInput): Promise<void> {
    if (commentPending.current) throw new Error('댓글 정보를 저장하고 있습니다.');
    commentPending.current = true;
    setSavingComment(true);
    try {
      const result = await window.threadsMedia.savePostComment(input);
      if (result.status === 'error') throw new Error(result.problem.message);
      setView(result.view);
    } finally {
      commentPending.current = false;
      setSavingComment(false);
    }
  }

  async function deleteMedia(input?: MediaDeleteInput) {
    if (deletePending.current) return;
    deletePending.current = true;
    setDeleting(true);
    setActionNotice(null);
    try {
      const result = input
        ? await window.threadsMedia.deleteMedia(input)
        : await window.threadsMedia.recoverDeletions();
      if (result.status === 'deleted') {
        setView(result.view);
        setPositions((previous) => {
          const next = { ...previous };
          for (const key of Object.keys(next)) {
            const updated = result.view.snapshot?.posts.find((post) => post.key === key);
            if (!updated) {
              delete next[key];
              continue;
            }
            const old = posts.find((post) => post.key === key);
            const originalItems = old ? postMedia(old) : [];
            const newItems = postMedia(updated);
            const oldIndex = Math.max(
              0,
              originalItems.findIndex((item) => item.ordinal === next[key]),
            );
            const original = originalItems[oldIndex];
            const preserved = newItems.find(
              (item) => original?.mediaId && item.mediaId === original.mediaId,
            );
            const replacement = preserved ?? newItems[Math.min(oldIndex, newItems.length - 1)];
            if (replacement) next[key] = replacement.ordinal;
            else delete next[key];
          }
          return next;
        });
        setActionNotice({
          error: !!result.view.error,
          message:
            result.view.error?.message ??
            (input
              ? input.kind === 'post'
                ? '게시글을 삭제했습니다.'
                : '편집본을 삭제했습니다.'
              : '삭제 작업을 복구했습니다.'),
        });
      } else if (result.status === 'error') {
        setActionNotice({ error: true, message: result.problem.message });
      }
    } catch {
      setActionNotice({
        error: true,
        message: '삭제 결과를 확인하지 못했습니다. 새로고침해 상태를 확인하세요.',
      });
    } finally {
      deletePending.current = false;
      setDeleting(false);
      void window.threadsMedia
        .current()
        .then(setView)
        .catch(() => {});
    }
  }

  async function exportPost(postKey: string) {
    if (exportPending.current) return;
    exportPending.current = true;
    setExporting(postKey);
    setActionNotice(null);
    try {
      const result = await window.threadsMedia.exportPost(postKey);
      if (result.status === 'saved')
        setActionNotice({ error: false, message: `${result.fileName} 저장 완료` });
      if (result.status === 'error')
        setActionNotice({ error: true, message: result.problem.message });
    } catch {
      setActionNotice({ error: true, message: 'ZIP을 저장하지 못했습니다. 다시 시도하세요.' });
    } finally {
      exportPending.current = false;
      setExporting(null);
      void window.threadsMedia
        .current()
        .then(setView)
        .catch(() => {});
    }
  }

  useEffect(() => {
    setAccount('');
    setSelected(null);
    setPositions({});
    setQuery('');
    setDateRange(defaultDateRange());
    resetList();
  }, [snapshot?.root]);
  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="brand">
            <span className="brand-mark">
              <Icon name="grid" />
            </span>
            <h1>Threads Media Manager</h1>
          </div>
          <div className="actions">
            <button
              onClick={() => void act(() => window.threadsMedia.chooseFolder())}
              disabled={busy || downloading || !!exporting || localMutation}
            >
              <Icon name="folder" />
              폴더 연결
            </button>
            <button
              className="refresh-button"
              onClick={() => void act(() => window.threadsMedia.refresh())}
              disabled={
                busy || downloading || !!exporting || localMutation || (!snapshot && !view.error)
              }
            >
              <Icon name="refresh" />
              {busy ? '읽는 중…' : '새로고침'}
            </button>
            <button
              className={`download-button ${pendingPosts === 0 ? 'is-empty' : 'primary'} ${pendingPosts > 0 && !downloading ? 'has-pending' : ''}`}
              onClick={() => void startDownloads()}
              disabled={
                busy ||
                downloading ||
                !!exporting ||
                localMutation ||
                deletionRecovery ||
                pendingPosts === 0
              }
            >
              <Icon name="download" />
              {pendingPosts > 0 ? `다운로드 (${pendingPosts})` : '다운로드'}
            </button>
          </div>
        </div>
      </header>
      <main className="library-content">
        <div className="library-heading">
          <h2>
            저장한 게시글 <span className="post-total">{savedPosts.length}</span>
          </h2>
          <p>이미지와 영상을 한곳에서 살펴보세요.</p>
          <div className="folder">
            <Icon name="folder" />
            <span title={snapshot?.root}>{snapshot?.root ?? '연결된 수집 폴더가 없습니다'}</span>
          </div>
          {snapshot && (
            <span className="collection-updated">{displayDate(snapshot.loadedAt)} 갱신</span>
          )}
        </div>
        {view.error && (
          <div className="notice error" role="alert">
            <strong>{view.error.message}</strong>
            {snapshot && view.error.code !== 'settings_save_failed' && (
              <p>아래 목록은 마지막으로 확인한 자료입니다.</p>
            )}
            {view.error.code === 'busy' && (
              <button
                disabled={busy || downloading || !!exporting || localMutation || deletionRecovery}
                onClick={() => void downloadAction(() => window.threadsMedia.recoverDownloads())}
              >
                로컬 저장 복구
              </button>
            )}
          </div>
        )}
        {deletionRecovery && (
          <div className="notice warning deletion-recovery" role="alert">
            <span>이전 삭제 작업을 정리해야 합니다. 복구 후 다른 작업을 진행할 수 있습니다.</span>
            <button
              disabled={busy || downloading || !!exporting || localMutation}
              onClick={() => void deleteMedia()}
            >
              {deleting ? '복구 중…' : '삭제 작업 복구'}
            </button>
          </div>
        )}
        {snapshot?.warnings.length ? (
          <details className="notice warning global-warning">
            <summary>확인할 수집·저장 정보 {snapshot.warnings.length}건</summary>
            {snapshot.warnings.map((warning, index) => (
              <p key={index}>{warning.message}</p>
            ))}
          </details>
        ) : null}
        <div className="toolbar">
          <div className="filters">
            <label className="sr-only" htmlFor="account">
              계정 필터
            </label>
            <div className="select-field">
              <select
                id="account"
                disabled={downloading}
                value={account}
                onChange={(e) => {
                  setAccount(e.target.value);
                  resetList();
                }}
              >
                <option value="">전체 계정</option>
                {accounts.map((value) => (
                  <option key={value} value={value}>
                    @{value}
                  </option>
                ))}
              </select>
              <Icon name="chevron" />
            </div>
          </div>
          <div className="search-tools">
            <div className="search-field">
              <Icon name="search" />
              <input
                aria-label="게시글 검색"
                placeholder="캡션, 계정 검색"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  resetList();
                }}
              />
              {query && (
                <button
                  className="search-clear"
                  aria-label="검색어 지우기"
                  onClick={() => {
                    setQuery('');
                    resetList();
                  }}
                >
                  <Icon name="close" />
                </button>
              )}
            </div>
            <div className="date-range" role="group" aria-label="게시글 등록일 범위">
              <DatePicker
                label="등록일 시작 날짜"
                value={dateRange.from}
                max={dateRange.to}
                onChange={(from) => {
                  setDateRange((range) => ({ ...range, from }));
                  resetList();
                }}
              />
              <span aria-hidden="true">~</span>
              <DatePicker
                label="등록일 종료 날짜"
                value={dateRange.to}
                min={dateRange.from}
                onChange={(to) => {
                  setDateRange((range) => ({ ...range, to }));
                  resetList();
                }}
              />
            </div>
          </div>
        </div>
        {snapshot && savedPosts.length > 0 ? (
          <section className="post-library" aria-label="게시글 목록">
            <div className="list-heading">
              <span>{visible.length}개 게시글</span>
              <span>최신순</span>
            </div>
            <div className="post-grid">
              {shownPosts.map((post) => (
                <PostCard
                  key={post.key}
                  post={post}
                  ordinal={positions[post.key]}
                  onChange={(ordinal) => changePosition(post.key, ordinal)}
                  onOpen={() => setSelected(post.key)}
                  onExport={() => void exportPost(post.key)}
                  onDeletePost={() => void deleteMedia({ kind: 'post', postKey: post.key })}
                  onDeleteEdit={(mediaId) =>
                    void deleteMedia({ kind: 'edit', postKey: post.key, mediaId })
                  }
                  deleteDisabled={
                    busy ||
                    downloading ||
                    !!exporting ||
                    localMutation ||
                    !!view.error ||
                    deletionRecovery
                  }
                  exporting={exporting === post.key}
                  exportDisabled={
                    busy ||
                    downloading ||
                    !!exporting ||
                    localMutation ||
                    !!view.error ||
                    deletionRecovery
                  }
                />
              ))}
            </div>
            {hasMore && <div ref={scrollSentinel} className="scroll-sentinel" aria-hidden="true" />}
            {visible.length === 0 && (
              <div className="empty">
                <Icon name="search" />
                <h3>검색 결과가 없습니다</h3>
                <p>다른 검색어, 계정 또는 날짜 범위로 다시 찾아보세요.</p>
                <button
                  onClick={() => {
                    setAccount('');
                    setQuery('');
                    setDateRange(defaultDateRange());
                    resetList();
                  }}
                  disabled={downloading}
                >
                  필터 초기화
                </button>
              </div>
            )}
            <div className="list-controls">
              {visible.length > 0 &&
                (scrolling ? (
                  <span className="scroll-count" role="status">
                    {shownPosts.length} / {visible.length}개
                  </span>
                ) : (
                  <Pagination
                    page={paginated.page}
                    totalPages={paginated.totalPages}
                    onChange={changePage}
                  />
                ))}
              <div className="select-field list-display-mode">
                <select
                  aria-label="게시글 표시 방식"
                  value={listMode}
                  onChange={(event) =>
                    changeListMode(
                      event.target.value === 'scroll'
                        ? 'scroll'
                        : event.target.value === '24'
                          ? 24
                          : 12,
                    )
                  }
                >
                  <option value={12}>12개</option>
                  <option value={24}>24개</option>
                  <option value="scroll">스크롤</option>
                </select>
                <Icon name="chevron" />
              </div>
            </div>
          </section>
        ) : (
          <section className="empty welcome">
            <Icon name="layers" />
            <h2>
              {busy
                ? '수집 자료를 불러오고 있습니다'
                : snapshot
                  ? '아직 저장한 게시글이 없습니다'
                  : '수집 폴더를 연결하세요'}
            </h2>
            <p>
              {snapshot
                ? pendingPosts > 0
                  ? '상단 다운로드 버튼을 눌러 이미지와 영상을 저장하세요.'
                  : '수집한 자료를 저장한 뒤 새로고침하세요.'
                : '수집 플러그인에서 준비한 폴더를 선택하세요.'}
            </p>
            {!snapshot && (
              <button
                className="primary"
                onClick={() => void act(() => window.threadsMedia.chooseFolder())}
                disabled={busy || downloading}
              >
                <Icon name="folder" />
                폴더 연결
              </button>
            )}
          </section>
        )}
      </main>
      <footer>
        <span>Threads Media Manager</span>
        <span>내 컴퓨터에 저장된 자료</span>
      </footer>
      {detail && (
        <PostDetailModal
          key={detail.key}
          post={detail}
          editDisabled={
            busy || downloading || !!exporting || localMutation || !!view.error || deletionRecovery
          }
          onEdit={saveMediaEdit}
          onSaveComment={savePostComment}
          commentProblem={
            view.error?.code === 'comment_refresh_failed'
              ? view.error.message
              : snapshot?.warnings.find((warning) => warning.code === 'comments_unavailable')
                  ?.message
          }
          ordinal={positions[detail.key]}
          onChange={(ordinal) => changePosition(detail.key, ordinal)}
          onClose={() => setSelected(null)}
        />
      )}
      <ToastLayer modalKey={detail?.key}>
        <DownloadToast
          view={download}
          starting={startingDownload}
          enabled={!busy && !exporting && !localMutation && !deletionRecovery}
          stop={() => void downloadAction(() => window.threadsMedia.stopDownload())}
          recover={() => void downloadAction(() => window.threadsMedia.recoverDownloads())}
        />
        {actionNotice && (
          <div
            className={`export-toast ${actionNotice.error ? 'export-toast-error' : ''}`}
            role={actionNotice.error ? 'alert' : 'status'}
          >
            <span>{actionNotice.message}</span>
            <button type="button" aria-label="저장 안내 닫기" onClick={() => setActionNotice(null)}>
              <Icon name="close" />
            </button>
          </div>
        )}
      </ToastLayer>
    </div>
  );
}
