export type PostPageSize = 12 | 24;
export type PostListMode = PostPageSize | 'scroll';
export const POST_PAGE_SIZE: PostPageSize = 12;

export type PageNumber = number | 'ellipsis-start' | 'ellipsis-end';

function pageCount(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
}

export function clampPage(requestedPage: number, totalPages: number): number {
  const requested = Number.isNaN(requestedPage) ? 1 : Math.trunc(requestedPage);
  return Math.max(1, Math.min(pageCount(totalPages), requested));
}

export function paginate<T>(
  items: readonly T[],
  requestedPage: number,
  pageSize: PostPageSize = POST_PAGE_SIZE,
): { items: T[]; page: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = clampPage(requestedPage, totalPages);
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page, totalPages };
}

export function pageNumbers(requestedPage: number, requestedTotal: number): PageNumber[] {
  const total = pageCount(requestedTotal);
  const page = clampPage(requestedPage, total);
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);

  const start = page <= 4 ? 2 : page >= total - 3 ? total - 4 : page - 1;
  const end = page <= 4 ? 5 : page >= total - 3 ? total - 1 : page + 1;
  const result: PageNumber[] = [1];
  if (start > 2) result.push('ellipsis-start');
  for (let number = start; number <= end; number++) result.push(number);
  if (end < total - 1) result.push('ellipsis-end');
  result.push(total);
  return result;
}
