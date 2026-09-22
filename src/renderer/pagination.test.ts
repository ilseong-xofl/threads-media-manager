import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Pagination } from './Pagination';
import { paginate, pageNumbers, POST_PAGE_SIZE } from './post-pagination';

const items = (count: number) => Array.from({ length: count }, (_, index) => ({ id: index + 1 }));

describe('saved post pagination', () => {
  it.each([
    [0, 1, 0],
    [12, 1, 12],
    [13, 2, 1],
    [24, 2, 12],
    [25, 3, 1],
  ])('defaults %i posts to %i pages with %i posts on the last page', (count, pages, lastCount) => {
    expect(POST_PAGE_SIZE).toBe(12);
    const result = paginate(items(count), pages);
    expect(result.totalPages).toBe(pages);
    expect(result.page).toBe(pages);
    expect(result.items).toHaveLength(lastCount);
  });

  it.each([
    [0, 1, 0],
    [24, 1, 24],
    [25, 2, 1],
    [48, 2, 24],
    [49, 3, 1],
  ])(
    'splits %i posts into %i selected 24-post pages with %i on the last page',
    (count, pages, lastCount) => {
      const result = paginate(items(count), pages, 24);
      expect(result.totalPages).toBe(pages);
      expect(result.page).toBe(pages);
      expect(result.items).toHaveLength(lastCount);
    },
  );

  it.each([12, 24] as const)(
    'preserves source order and identity with %i posts per page',
    (pageSize) => {
      const source = Object.freeze(items(pageSize * 2 + 1));
      const first = paginate(source, 1, pageSize);
      const second = paginate(source, 2, pageSize);
      const third = paginate(source, 3, pageSize);
      const combined = [...first.items, ...second.items, ...third.items];
      expect(combined).toEqual(source);
      expect(first.items[0]).toBe(source[0]);
      expect(second.items[0]).toBe(source[pageSize]);
      expect(third.items[0]).toBe(source[pageSize * 2]);
      expect(new Set(combined.map((item) => item.id)).size).toBe(source.length);
    },
  );

  it.each([12, 24] as const)(
    'clamps a shrinking or empty list with %i posts per page',
    (pageSize) => {
      const source = items(pageSize * 2 + 1);
      expect(paginate(source, 3, pageSize).page).toBe(3);
      expect(paginate(source.slice(0, pageSize + 1), 3, pageSize)).toEqual({
        page: 2,
        totalPages: 2,
        items: [source[pageSize]],
      });
      expect(paginate([], 3, pageSize)).toEqual({ page: 1, totalPages: 1, items: [] });
    },
  );

  it('clamps the current page when switching from 12 to 24 posts per page', () => {
    const source = items(49);
    expect(paginate(source, 5).items).toEqual([source[48]]);
    expect(paginate(source, 5, 24)).toEqual({
      page: 3,
      totalPages: 3,
      items: [source[48]],
    });
  });

  it.each([
    [-5, 1],
    [0, 1],
    [2.9, 2],
    [999, 3],
    [NaN, 1],
    [Infinity, 3],
    [-Infinity, 1],
  ])('normalizes requested page %s to %i', (requested, expected) => {
    expect(paginate(items(25), requested).page).toBe(expected);
    expect(paginate(items(49), requested, 24).page).toBe(expected);
  });
});

describe('compact page numbers', () => {
  it('shows every number for a small list, including a single or empty page', () => {
    expect(pageNumbers(1, 0)).toEqual([1]);
    expect(pageNumbers(1, 1)).toEqual([1]);
    expect(pageNumbers(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it.each([
    [1, [1, 2, 3, 4, 5, 'ellipsis-end', 20]],
    [10, [1, 'ellipsis-start', 9, 10, 11, 'ellipsis-end', 20]],
    [20, [1, 'ellipsis-start', 16, 17, 18, 19, 20]],
  ])('keeps page %i, its neighboring pages, and both ends visible', (page, expected) => {
    expect(pageNumbers(page, 20)).toEqual(expected);
  });

  it('keeps numbers ordered, unique, bounded, and compact throughout a long list', () => {
    for (const total of [8, 9, 20, 1000]) {
      for (const page of [1, 2, 4, 5, Math.ceil(total / 2), total - 4, total - 1, total]) {
        const result = pageNumbers(page, total);
        const numbers = result.filter((entry): entry is number => typeof entry === 'number');
        expect(result.length).toBeLessThanOrEqual(7);
        expect(new Set(result).size).toBe(result.length);
        expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
        expect(numbers[0]).toBe(1);
        expect(numbers.at(-1)).toBe(total);
        expect(numbers).toContain(page);
        expect(
          numbers.every((number) => Number.isInteger(number) && number >= 1 && number <= total),
        ).toBe(true);
        for (let index = 1; index < result.length - 1; index++) {
          if (typeof result[index] === 'number') continue;
          expect(typeof result[index - 1]).toBe('number');
          expect(typeof result[index + 1]).toBe('number');
          expect(Number(result[index + 1]) - Number(result[index - 1])).toBeGreaterThan(2);
        }
      }
    }
  });
});

describe('pagination navigation', () => {
  it('retains accessible navigation on one page with both directional buttons disabled', () => {
    const html = renderToStaticMarkup(
      createElement(Pagination, { page: 1, totalPages: 1, onChange: vi.fn() }),
    );
    expect(html).toContain('aria-label="게시글 페이지"');
    expect(html).toMatch(/<button(?=[^>]*aria-label="이전 페이지")(?=[^>]*disabled="")[^>]*>/);
    expect(html).toMatch(/<button(?=[^>]*aria-label="다음 페이지")(?=[^>]*disabled="")[^>]*>/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it('marks exactly the current page while leaving both directions available in the middle', () => {
    const html = renderToStaticMarkup(
      createElement(Pagination, { page: 10, totalPages: 20, onChange: vi.fn() }),
    );
    expect(html).toMatch(/<button(?=[^>]*aria-label="10페이지")(?=[^>]*aria-current="page")[^>]*>/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).not.toContain('disabled=');
    expect(html.match(/class="pagination-ellipsis"/g)).toHaveLength(2);
  });
});
