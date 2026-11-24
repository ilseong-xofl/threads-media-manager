import {
  mentLength,
  type Ment,
  type MentBrand,
  type MentCatalog,
  type MentKind,
  type MentProduct,
} from '../shared/ments';

// Brands, products and ments stay in the server's order: oldest first, a new one goes last
// (2026-11-24, the user's call).

export interface MentSelection {
  brand: MentBrand | null;
  product: MentProduct | null;
  ment: Ment | null;
}
/**
 * The chosen brand, product and ment while they exist. Otherwise the first of each under the one
 * above: what the window shows when it opens, after another brand or product is chosen, and after
 * the chosen one is deleted.
 */
export function selectMent(
  catalog: MentCatalog,
  brandId: string | null,
  productId: string | null,
  mentId: string | null = null,
): MentSelection {
  const brand = catalog.brands.find((item) => item.id === brandId) ?? catalog.brands[0] ?? null;
  const product = brand
    ? (brand.products.find((item) => item.id === productId) ?? brand.products[0] ?? null)
    : null;
  const ment = product
    ? (product.ments.find((item) => item.id === mentId) ?? product.ments[0] ?? null)
    : null;
  return { brand, product, ment };
}

/** Text typed for one ment's body and not saved yet. */
export interface MentDraft {
  mentId: string;
  text: string;
}
/**
 * Whether the chosen ment's text was changed and not saved: choosing something else or closing
 * the window would lose it, so the window asks first (2026-11-24, the user's call).
 */
export const mentDraftChanged = (ment: Ment | null, draft: MentDraft | null) =>
  !!ment && !!draft && draft.mentId === ment.id && draft.text.trim() !== ment.body;

/** Whether the catalog still has the item. */
export function mentHas(catalog: MentCatalog, kind: MentKind, id: string): boolean {
  return catalog.brands.some((brand) =>
    kind === 'brand'
      ? brand.id === id
      : brand.products.some((product) =>
          kind === 'product' ? product.id === id : product.ments.some((ment) => ment.id === id),
        ),
  );
}

/** A name or a title that can be saved as typed: not blank, within the limit once trimmed. */
export const mentLineValid = (value: string, limit: number) => {
  const text = value.trim();
  return text.length > 0 && mentLength(text) <= limit;
};

export type MentTarget =
  | { kind: 'brand'; item: MentBrand }
  | { kind: 'product'; item: MentProduct }
  | { kind: 'ment'; item: Ment };

/** What the delete confirmation says goes with the item; deleting cannot be undone. */
export function mentDeleteMessage(target: MentTarget): string {
  if (target.kind === 'ment') return `'${target.item.title}' 멘트를 지웁니다. 되돌릴 수 없습니다.`;
  const products = target.kind === 'brand' ? target.item.products : [target.item];
  const ments = products.reduce((count, product) => count + product.ments.length, 0);
  const below = [
    ...(target.kind === 'brand' && products.length ? [`제품 ${products.length}개`] : []),
    ...(ments ? [`멘트 ${ments}개`] : []),
  ];
  return `'${target.item.name}' ${target.kind === 'brand' ? '브랜드를' : '제품을'} 지웁니다.${
    below.length ? ` 그 아래 ${below.join('와 ')}도 함께 지워집니다.` : ''
  } 되돌릴 수 없습니다.`;
}
