import { describe, expect, it } from 'vitest';
import type { MentCatalog } from '../shared/ments';
import {
  mentDeleteMessage,
  mentDraftChanged,
  mentHas,
  mentLineValid,
  selectMent,
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
  it('keeps the chosen brand, product and ment, and falls back to the first ones in order made', () => {
    // The server's order, oldest first, is the order on screen.
    const [sky, garam] = catalog.brands;
    const [ten, two] = sky.products;
    expect(selectMent(catalog, null, null)).toEqual({ brand: sky, product: ten, ment: null });
    expect(selectMent(catalog, 'b2', 'p2')).toEqual({
      brand: sky,
      product: two,
      ment: two.ments[0],
    });
    expect(selectMent(catalog, 'b2', 'p2', 'm1').ment).toBe(two.ments[1]);
    // A chosen item that is gone, or that belongs to another parent, gives the first under it.
    expect(selectMent(catalog, 'b2', 'gone').product).toBe(ten);
    expect(selectMent(catalog, 'b2', 'p2', 'gone').ment).toBe(two.ments[0]);
    expect(selectMent(catalog, 'b1', 'p2', 'm1')).toEqual({
      brand: garam,
      product: null,
      ment: null,
    });
    expect(selectMent({ brands: [] }, 'b1', 'p1', 'm1')).toEqual({
      brand: null,
      product: null,
      ment: null,
    });
  });

  it('sees unsaved text only for the chosen ment, ignoring spaces around it', () => {
    const chosen = { id: 'm1', title: '후기형', body: '좋아요' };
    expect(mentDraftChanged(chosen, null)).toBe(false);
    expect(mentDraftChanged(chosen, { mentId: 'm1', text: ' 좋아요\n' })).toBe(false);
    expect(mentDraftChanged(chosen, { mentId: 'm1', text: '좋아요!' })).toBe(true);
    expect(mentDraftChanged(chosen, { mentId: 'm2', text: '다른 글' })).toBe(false);
    expect(mentDraftChanged(null, { mentId: 'm1', text: '좋아요!' })).toBe(false);
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
