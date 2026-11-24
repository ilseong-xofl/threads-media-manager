import { describe, expect, it } from 'vitest';
import type { MentCatalog } from '../shared/ments';
import {
  mentDeleteMessage,
  mentHas,
  mentLineValid,
  selectMent,
  sortMentCatalog,
} from './ment-model';

const ment = (id: string, title = id) => ({ id, title, body: `${title} 본문` });
const catalog: MentCatalog = {
  brands: [
    {
      id: 'b2',
      name: '하늘',
      products: [
        { id: 'p10', name: '제품10', ments: [] },
        { id: 'p2', name: '제품2', ments: [ment('m2'), ment('m1')] },
      ],
    },
    { id: 'b1', name: '가람', products: [] },
    { id: 'b3', name: 'Apple', products: [] },
  ],
};

describe('ment window model', () => {
  it('orders brands and products by name, numbers by value, and keeps the ments as made', () => {
    const sorted = sortMentCatalog(catalog);
    expect(sorted.brands.map((brand) => brand.name)).toEqual(['가람', '하늘', 'Apple']);
    expect(sorted.brands[1].products.map((product) => product.name)).toEqual(['제품2', '제품10']);
    expect(sorted.brands[1].products[0].ments.map((item) => item.id)).toEqual(['m2', 'm1']);
    // The catalog it was given is left as it was.
    expect(catalog.brands[0].products[0].name).toBe('제품10');
  });

  it('keeps the chosen brand and product, and falls back to the first ones', () => {
    const sorted = sortMentCatalog(catalog);
    expect(selectMent(sorted, null, null)).toEqual({ brand: sorted.brands[0], product: null });
    const sky = sorted.brands[1];
    expect(selectMent(sorted, 'b2', null)).toEqual({ brand: sky, product: sky.products[0] });
    expect(selectMent(sorted, 'b2', 'p10')).toEqual({ brand: sky, product: sky.products[1] });
    // A chosen product that is gone, or that belongs to another brand, gives the brand's first.
    expect(selectMent(sorted, 'b2', 'gone').product).toBe(sky.products[0]);
    expect(selectMent(sorted, 'gone', 'p10')).toEqual({ brand: sorted.brands[0], product: null });
    expect(selectMent({ brands: [] }, 'b1', 'p1')).toEqual({ brand: null, product: null });
  });

  it('tells whether the catalog still has an item of each kind', () => {
    expect(mentHas(catalog, 'brand', 'b1')).toBe(true);
    expect(mentHas(catalog, 'product', 'p2')).toBe(true);
    expect(mentHas(catalog, 'ment', 'm1')).toBe(true);
    expect(mentHas(catalog, 'brand', 'p2')).toBe(false);
    expect(mentHas(catalog, 'product', 'b1')).toBe(false);
    expect(mentHas(catalog, 'ment', 'gone')).toBe(false);
  });

  it('accepts a name or title that is not blank and fits once trimmed, counting code points', () => {
    expect(mentLineValid('  브랜드  ', 40)).toBe(true);
    expect(mentLineValid('   ', 40)).toBe(false);
    expect(mentLineValid('😀'.repeat(40), 40)).toBe(true);
    expect(mentLineValid('😀'.repeat(41), 40)).toBe(false);
  });

  it('says what goes with the item in the delete confirmation', () => {
    const [sky] = catalog.brands;
    expect(mentDeleteMessage({ kind: 'brand', item: sky })).toBe(
      "'하늘' 브랜드를 지웁니다. 그 아래 제품 2개와 멘트 2개도 함께 지워집니다. 되돌릴 수 없습니다.",
    );
    expect(
      mentDeleteMessage({ kind: 'brand', item: { ...sky, products: [sky.products[0]] } }),
    ).toBe("'하늘' 브랜드를 지웁니다. 그 아래 제품 1개도 함께 지워집니다. 되돌릴 수 없습니다.");
    expect(mentDeleteMessage({ kind: 'brand', item: catalog.brands[1] })).toBe(
      "'가람' 브랜드를 지웁니다. 되돌릴 수 없습니다.",
    );
    expect(mentDeleteMessage({ kind: 'product', item: sky.products[1] })).toBe(
      "'제품2' 제품을 지웁니다. 그 아래 멘트 2개도 함께 지워집니다. 되돌릴 수 없습니다.",
    );
    expect(mentDeleteMessage({ kind: 'product', item: sky.products[0] })).toBe(
      "'제품10' 제품을 지웁니다. 되돌릴 수 없습니다.",
    );
    expect(mentDeleteMessage({ kind: 'ment', item: ment('m1', '후기형') })).toBe(
      "'후기형' 멘트를 지웁니다. 되돌릴 수 없습니다.",
    );
  });
});
