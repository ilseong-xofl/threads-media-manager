import { Icon } from './Icon';
import { clampPage, pageNumbers } from './post-pagination';

export function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange(page: number): void;
}) {
  const current = clampPage(page, totalPages);
  const pages = pageNumbers(current, totalPages);
  const last = pages[pages.length - 1] as number;
  return (
    <nav className="pagination" aria-label="게시글 페이지">
      <button
        type="button"
        aria-label="이전 페이지"
        disabled={current === 1}
        onClick={() => onChange(Math.max(1, current - 1))}
      >
        <Icon name="left" />
      </button>
      {pages.map((entry) =>
        typeof entry === 'number' ? (
          <button
            key={entry}
            type="button"
            aria-label={`${entry}페이지`}
            aria-current={entry === current ? 'page' : undefined}
            className={entry === current ? 'pagination-current' : undefined}
            onClick={() => onChange(entry)}
          >
            {entry}
          </button>
        ) : (
          <span key={entry} className="pagination-ellipsis" aria-hidden="true">
            …
          </span>
        ),
      )}
      <button
        type="button"
        aria-label="다음 페이지"
        disabled={current === last}
        onClick={() => onChange(Math.min(last, current + 1))}
      >
        <Icon name="right" />
      </button>
    </nav>
  );
}
