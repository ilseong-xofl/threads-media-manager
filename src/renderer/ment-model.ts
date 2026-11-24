import {
  mentLength,
  type Ment,
  type MentBrand,
  type MentCatalog,
  type MentKind,
  type MentProduct,
} from '../shared/ments';

const collator = new Intl.Collator('ko', { numeric: true });
const byName = <T extends { id: string; name: string }>(a: T, b: T) =>
  collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Brands and each brand's products in name order; ments stay in the order they were made. */
export function sortMentCatalog(catalog: MentCatalog): MentCatalog {
  return {
    brands: [...catalog.brands]
      .sort(byName)
      .map((brand) => ({ ...brand, products: [...brand.products].sort(byName) })),
  };
}

export interface MentSelection {
  brand: MentBrand | null;
  product: MentProduct | null;
}
/**
 * The chosen brand and product while they exist. Otherwise the first brand, and the first product
 * of the brand: what the window shows when it opens, after another brand is chosen, and after the
 * chosen one is deleted.
 */
export function selectMent(
  catalog: MentCatalog,
  brandId: string | null,
  productId: string | null,
): MentSelection {
  const brand = catalog.brands.find((item) => item.id === brandId) ?? catalog.brands[0] ?? null;
  const product = brand
    ? (brand.products.find((item) => item.id === productId) ?? brand.products[0] ?? null)
    : null;
  return { brand, product };
}

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
