import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { MentPicker } from './MentPicker';

const catalog = {
  brands: [
    {
      id: 'b1',
      name: 'A브랜드',
      products: [{ id: 'p1', name: '제품1', ments: [{ id: 'm1', title: '후기형', body: '본문' }] }],
    },
  ],
};

it('starts with nothing chosen, so an ordinary post is left alone', () => {
  const html = renderToStaticMarkup(
    createElement(MentPicker, {
      catalog,
      place: { brandId: null, productId: null },
      mentId: null,
      disabled: false,
      onSelect: vi.fn(),
      onPick: vi.fn(),
    }),
  );
  // The brand box waits on its placeholder; the boxes below stay off until a choice above.
  expect(html).toContain('<option value="" disabled="" selected="">브랜드 선택</option>');
  expect(html).toContain('<option value="b1">A브랜드</option>');
  expect(html).toContain('<option value="" selected="">브랜드를 먼저 고르세요</option>');
  expect(html).toContain('<option value="" selected="">제품을 먼저 고르세요</option>');
  expect(html.match(/<select[^>]*disabled=""/g)).toHaveLength(2);
  expect(html).toContain('class="daily-ment-pick daily-ment-pick-wide"');
});

it('shows the brand and product the window holds (2026-11-25)', () => {
  const html = renderToStaticMarkup(
    createElement(MentPicker, {
      catalog,
      place: { brandId: 'b1', productId: 'p1' },
      mentId: 'm1',
      disabled: false,
      onSelect: vi.fn(),
      onPick: vi.fn(),
    }),
  );
  expect(html).toContain('<option value="b1" selected="">A브랜드</option>');
  expect(html).toContain('<option value="p1" selected="">제품1</option>');
  expect(html).toContain('<option value="m1" selected="">후기형</option>');
});
