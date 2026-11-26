import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { MentRegisterDialog } from './MentRegisterDialog';

const catalog = {
  brands: [
    { id: 'b1', name: 'A브랜드', products: [{ id: 'p1', name: '제품1', ments: [] }] },
    { id: 'b2', name: 'B브랜드', products: [] },
  ],
};
const render = (place: { brandId: string | null; productId: string | null }) =>
  renderToStaticMarkup(
    createElement(MentRegisterDialog, {
      catalog,
      place,
      body: '본문',
      onCatalog: vi.fn(),
      onSaved: vi.fn(),
      onClose: vi.fn(),
    }),
  );

it('starts from the brand and product the post window shows, with an empty title', () => {
  const html = render({ brandId: 'b1', productId: 'p1' });
  expect(html).toContain('멘트 등록');
  expect(html).toContain('<option value="b1" selected="">A브랜드</option>');
  expect(html).toContain('<option value="p1" selected="">제품1</option>');
  expect(html).toMatch(/<input[^>]*type="text"[^>]*value=""/);
  expect(html).toContain('0 / 40');
  // [저장] waits for a title.
  expect(html).toMatch(/<button type="submit" class="primary" disabled="">저장<\/button>/);
});

it('asks for a brand and product when the post window chose none', () => {
  const html = render({ brandId: null, productId: null });
  expect(html).toContain('<option value="" disabled="" selected="">브랜드 선택</option>');
  expect(html).toContain('<option value="" selected="">브랜드를 먼저 고르세요</option>');
});
