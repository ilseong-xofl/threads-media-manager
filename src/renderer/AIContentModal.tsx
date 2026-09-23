import { useEffect, useRef, useState } from 'react';
import type { AIContentDraft, CaptionLanguage, Post } from '../shared/contracts';
import { Icon } from './Icon';
import './ai-content.css';

export function AIContentModal({
  post,
  draft,
  working,
  error,
  onGenerate,
  onClose,
  onReveal,
  onCopy,
}: {
  post: Post;
  draft: AIContentDraft | null;
  working: boolean;
  error: string | null;
  onGenerate(language: CaptionLanguage): void;
  onClose(): void;
  onReveal(): Promise<void>;
  onCopy(): Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [language, setLanguage] = useState<CaptionLanguage>(draft?.language ?? 'en');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      element?.close();
      document.body.style.overflow = previous;
      opener?.focus();
    };
  }, []);
  useEffect(() => {
    if (draft) setLanguage(draft.language);
    setCopied(false);
  }, [draft]);
  const count = post.attachments.filter((item) => item.kind === 'image').length;
  return (
    <dialog
      ref={dialog}
      className="post-modal ai-content-modal"
      aria-labelledby="ai-content-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header className="modal-header">
        <div>
          <h2 id="ai-content-title">AI 생성 · 제품 홍보 초안</h2>
          <p className="ai-content-subtitle">
            원본 이미지 {count}장과 원문 캡션으로 새로운 컨텐츠를 만듭니다.
          </p>
        </div>
        <button
          type="button"
          className="icon-button modal-close"
          aria-label="AI 초안 닫기"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="modal-body ai-content-body">
        <div className="ai-content-toolbar">
          <span>인물은 성인 여성 · 편집본 제외</span>
          <label>
            캡션 언어{' '}
            <select
              value={language}
              disabled={working}
              onChange={(e) => setLanguage(e.target.value as CaptionLanguage)}
            >
              <option value="en">영어</option>
              <option value="ko">한국어</option>
              <option value="ja">일본어</option>
            </select>
          </label>
        </div>
        {working && (
          <div className="ai-content-progress" role="status">
            <Icon name="sparkles" />
            <strong>원본을 분석하고 홍보 이미지와 캡션을 만들고 있어요.</strong>
            <p>완료까지 몇 분 걸릴 수 있습니다.</p>
          </div>
        )}
        {error && (
          <p className="editor-notice editor-error" role="alert">
            {error}
          </p>
        )}
        {draft && (
          <>
            <div className="ai-content-images">
              {draft.images.map((src, i) => (
                <figure key={src}>
                  <img src={src} alt={`AI 생성 홍보 이미지 ${i + 1}`} />
                  <figcaption>
                    {i + 1} / {draft.images.length} · AI 생성
                  </figcaption>
                </figure>
              ))}
            </div>
            <section className="detail-section ai-content-caption">
              <div>
                <h3>Threads 캡션 초안</h3>
                <button
                  type="button"
                  onClick={() => {
                    setCopyError('');
                    void onCopy()
                      .then(() => setCopied(true))
                      .catch(() =>
                        setCopyError('복사하지 못했습니다. 캡션을 직접 선택해 복사하세요.'),
                      );
                  }}
                >
                  {copied ? '복사됨' : '캡션 복사'}
                </button>
              </div>
              <p className="caption">{draft.caption}</p>
              {copyError && <p role="alert">{copyError}</p>}
            </section>
            <section className="detail-section">
              <h3>홍보 컨셉</h3>
              <p>{draft.concept}</p>
              <p className="ai-content-product">{draft.product}</p>
            </section>
            <details className="ai-content-analysis">
              <summary>원본 분석과 생성 프롬프트</summary>
              <p>{draft.analysis}</p>
              {draft.imagePrompts.map((prompt, i) => (
                <p key={i}>
                  <strong>이미지 {i + 1}</strong>
                  <br />
                  {prompt}
                </p>
              ))}
            </details>
            <p className="ai-content-saved">
              이미지와 캡션이 AI 초안 폴더에 저장되었습니다. 검토 후 사용하세요.
            </p>
          </>
        )}
        {!draft && !working && !error && (
          <p>원본의 제품 홍보 흐름을 분석해 이미지와 캡션을 함께 설계합니다.</p>
        )}
      </div>
      <div className="media-editor-footer">
        {draft && (
          <button
            type="button"
            className="ai-content-folder"
            disabled={working}
            onClick={() => void onReveal()}
          >
            <Icon name="folder" />
            초안 폴더
          </button>
        )}
        <button type="button" onClick={onClose}>
          {working ? '취소하고 닫기' : '닫기'}
        </button>
        <button
          type="button"
          className="primary"
          disabled={working}
          onClick={() => onGenerate(language)}
        >
          <Icon name="sparkles" />
          {draft ? '다시 생성' : '생성'}
        </button>
      </div>
    </dialog>
  );
}
