import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { MentCatalog } from '../shared/ments';
import { MentCatalogView } from './MentManagerModal';
import { selectMent } from './ment-model';

const handlers = () => ({
  onSelectBrand: vi.fn(),
  onSelectProduct: vi.fn(),
  onAddBrand: vi.fn(),
  onEditBrand: vi.fn(),
  onAddProduct: vi.fn(),
  onEditProduct: vi.fn(),
  onAddMent: vi.fn(),
  onEditMent: vi.fn(),
  onDeleteMent: vi.fn(),
});
const render = (catalog: MentCatalog) =>
  renderToStaticMarkup(
    createElement(MentCatalogView, {
      catalog,
      ...selectMent(catalog, null, null),
      busy: false,
      ...handlers(),
    }),
  );

it('shows brands and products on top and the chosen product’s ments below, line breaks kept', () => {
  const html = render({
    brands: [
      {
        id: 'b1',
        name: 'A브랜드',
        products: [
          {
            id: 'p1',
            name: '제품1',
            ments: [{ id: 'm1', title: '후기형', body: '첫 줄\n둘째 줄' }],
          },
        ],
      },
      { id: 'b2', name: 'B브랜드', products: [] },
    ],
  });
  expect(html).toContain('aria-label="브랜드 추가"');
  expect(html).toContain('aria-label="제품 추가"');
  expect(html).toContain('A브랜드');
  expect(html).toContain('B브랜드');
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain('aria-label="A브랜드 수정"');
  expect(html).toContain('<span class="ment-path"> — A브랜드 › 제품1</span>');
  expect(html).toContain('<strong class="ment-card-title">후기형</strong>');
  // Each card's buttons say which ment they act on.
  expect(html).toContain('aria-label="후기형 수정"');
  expect(html).toContain('aria-label="후기형 삭제"');
  expect(html).toContain('첫 줄\n둘째 줄');
  expect(html.indexOf('ment-lists')).toBeLessThan(html.indexOf('ment-texts'));
});

it('offers only what can be done next when the catalog is empty', () => {
  const html = render({ brands: [] });
  expect(html).toContain('브랜드를 추가하세요.');
  expect(html).toContain('브랜드를 먼저 추가하세요.');
  expect(html).toContain('브랜드와 제품을 추가하면 멘트를 넣을 수 있습니다.');
  // Adding a product waits for a brand, adding a ment for a product.
  expect(html).toMatch(/aria-label="제품 추가"[^>]*disabled=""/);
  expect(html).toMatch(/class="primary ment-add-text" disabled=""/);
  expect(html).not.toMatch(/aria-label="브랜드 추가"[^>]*disabled=""/);
});
