import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { MentCatalog } from '../shared/ments';
import { MentCatalogView } from './MentManagerModal';
import { selectMent } from './ment-model';

const render = (catalog: MentCatalog, mentId: string | null = null) =>
  renderToStaticMarkup(
    createElement(MentCatalogView, {
      catalog,
      ...selectMent(catalog, null, null, mentId),
      busy: false,
      onSelectBrand: vi.fn(),
      onSelectProduct: vi.fn(),
      onSelectMent: vi.fn(),
      onAdd: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      bodyText: selectMent(catalog, null, null, mentId).ment?.body ?? '',
      bodyChanged: false,
      onBodyChange: vi.fn(),
      onSaveBody: vi.fn(async () => true),
    }),
  );
const catalog: MentCatalog = {
  brands: [
    {
      id: 'b1',
      name: 'A브랜드',
      products: [
        {
          id: 'p1',
          name: '제품1',
          ments: [
            { id: 'm1', title: '후기형', body: '첫 줄\n둘째 줄' },
            { id: 'm2', title: '할인 안내', body: '이번 주까지' },
          ],
        },
        { id: 'p2', name: '제품2', ments: [] },
      ],
    },
    { id: 'b2', name: 'B브랜드', products: [] },
  ],
};

it('shows one select box per level and the chosen ment’s text, written and saved in place', () => {
  const html = render(catalog);
  for (const label of ['브랜드', '제품', '멘트'])
    for (const action of ['등록', '수정', '삭제'])
      expect(html).toContain(`aria-label="${label} ${action}"`);
  // Brand and product share a row, the ment takes a whole one; the actions are icon buttons.
  expect(html.match(/class="ment-field"/g)).toHaveLength(2);
  expect(html.match(/class="ment-field ment-field-wide"/g)).toHaveLength(1);
  expect(html.match(/class="ment-icon ment-icon-(add|edit|delete)"/g)).toHaveLength(9);
  // Each label shows how many: brands, the chosen brand's products, the chosen product's ments.
  expect(html.match(/<span class="ment-count">(\d+)<\/span>/g)).toEqual([
    '<span class="ment-count">2</span>',
    '<span class="ment-count">2</span>',
    '<span class="ment-count">2</span>',
  ]);
  // The brand box lists every brand; the product box only the chosen brand's products.
  expect(html).toContain('<option value="b1" selected="">A브랜드</option>');
  expect(html).toContain('<option value="b2">B브랜드</option>');
  expect(html).toContain('<option value="p1" selected="">제품1</option>');
  expect(html).toContain('<option value="p2">제품2</option>');
  // The ment box lists the chosen product's ments by title, and the text shows the chosen one.
  expect(html).toContain('<option value="m1" selected="">후기형</option>');
  expect(html).toContain('<option value="m2">할인 안내</option>');
  expect(html).toMatch(
    /<textarea class="ment-body" aria-label="멘트 내용"[^>]*>첫 줄\n둘째 줄<\/textarea>/,
  );
  expect(html).not.toMatch(/<textarea[^>]*(readOnly|disabled)=""/);
  // [저장] waits for a change to the text, with the text's length beside it.
  expect(html).toContain('<span class="ment-body-count">8 / 500</span>');
  expect(html).toMatch(/<button type="button" class="primary" disabled="">저장<\/button>/);
  expect(render(catalog, 'm2')).toContain('>이번 주까지</textarea>');
  expect(html).not.toMatch(
    /aria-label="(브랜드|제품|멘트) (등록|수정|삭제)" title="[^"]*" disabled=""/,
  );
});

it('offers only what can be done next when the catalog is empty', () => {
  const html = render({ brands: [] });
  expect(html).toContain('<option value="" selected="">등록된 브랜드가 없습니다</option>');
  expect(html).toContain('<option value="" selected="">브랜드를 먼저 등록하세요</option>');
  expect(html).toContain('<option value="" selected="">제품을 먼저 등록하세요</option>');
  // Only the brand can be added; nothing can be edited or deleted yet.
  expect(html).not.toMatch(/aria-label="브랜드 등록" title="브랜드 등록" disabled=""/);
  expect(html).toMatch(/aria-label="제품 등록" title="제품 등록" disabled=""/);
  expect(html).toMatch(/aria-label="멘트 등록" title="멘트 등록" disabled=""/);
  for (const label of ['브랜드', '제품', '멘트'])
    expect(html).toMatch(
      new RegExp(`aria-label="${label} 수정" title="${label} 수정" disabled=""`),
    );
  expect(html.match(/<select[^>]*disabled=""/g)).toHaveLength(3);
  // With no ment there is nothing to write into.
  expect(html).toMatch(
    /<textarea[^>]*disabled=""[^>]*placeholder="멘트를 등록하면 여기에 내용을 쓸 수 있습니다."/,
  );
});
