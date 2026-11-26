import { useId } from 'react';
import type { Ment, MentCatalog } from '../shared/ments';
import { Icon } from './Icon';
import './ments.css';

/** One ment select box, in the app's own select look: a chevron inset from the right edge. */
export function MentSelect({
  id,
  items,
  value,
  empty,
  placeholder,
  disabled = false,
  onChange,
}: {
  id: string;
  items: { id: string; label: string }[];
  value: string | null;
  /** Shown in the disabled box while there is nothing to choose. */
  empty: string;
  /** Shown while nothing is chosen, when the box may stay empty. */
  placeholder?: string;
  disabled?: boolean;
  onChange(id: string): void;
}) {
  return (
    <div className="select-field">
      <select
        id={id}
        value={value ?? ''}
        disabled={disabled || !items.length}
        onChange={(event) => onChange(event.target.value)}
      >
        {!items.length && <option value="">{empty}</option>}
        {items.length > 0 && placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
      </select>
      <Icon name="chevron" />
    </div>
  );
}

/** The brand and product a ment belongs to, or is about to; either may be unchosen. */
export interface MentPlace {
  brandId: string | null;
  productId: string | null;
}

/** The brand and product boxes, side by side; a new brand clears the product. */
export function MentPlaceSelects({
  catalog,
  place,
  disabled,
  onSelect,
}: {
  catalog: MentCatalog;
  place: MentPlace;
  disabled: boolean;
  onSelect(place: MentPlace): void;
}) {
  const id = useId();
  const brand = catalog.brands.find((item) => item.id === place.brandId) ?? null;
  const product = brand?.products.find((item) => item.id === place.productId) ?? null;
  return (
    <>
      <div className="daily-ment-pick">
        <label htmlFor={`${id}-brand`}>브랜드</label>
        <MentSelect
          id={`${id}-brand`}
          items={catalog.brands.map((item) => ({ id: item.id, label: item.name }))}
          value={brand?.id ?? null}
          empty="등록된 브랜드가 없습니다"
          placeholder="브랜드 선택"
          disabled={disabled}
          onChange={(value) => onSelect({ brandId: value, productId: null })}
        />
      </div>
      <div className="daily-ment-pick">
        <label htmlFor={`${id}-product`}>제품</label>
        <MentSelect
          id={`${id}-product`}
          items={(brand?.products ?? []).map((item) => ({ id: item.id, label: item.name }))}
          value={product?.id ?? null}
          empty={brand ? '등록된 제품이 없습니다' : '브랜드를 먼저 고르세요'}
          placeholder="제품 선택"
          disabled={disabled}
          onChange={(value) => onSelect({ brandId: brand?.id ?? null, productId: value })}
        />
      </div>
    </>
  );
}

/**
 * The brand, product and ment-title boxes of a post being written (2026-11-24): nothing is chosen
 * at first, so an ordinary post is left alone. Choosing a ment hands it to the post, which puts its
 * text in the body; `mentId` is the ment the body was last filled from. The window holds the brand
 * and product, so [멘트 등록] starts from them (2026-11-25).
 */
export function MentPicker({
  catalog,
  place,
  mentId,
  disabled,
  onSelect,
  onPick,
}: {
  catalog: MentCatalog;
  place: MentPlace;
  mentId: string | null;
  disabled: boolean;
  onSelect(place: MentPlace): void;
  onPick(ment: Ment): void;
}) {
  const id = useId();
  const brand = catalog.brands.find((item) => item.id === place.brandId) ?? null;
  const product = brand?.products.find((item) => item.id === place.productId) ?? null;
  const ments = product?.ments ?? [];
  return (
    <div className="daily-ment-picker">
      <MentPlaceSelects catalog={catalog} place={place} disabled={disabled} onSelect={onSelect} />
      <div className="daily-ment-pick daily-ment-pick-wide">
        <label htmlFor={`${id}-ment`}>멘트</label>
        <MentSelect
          id={`${id}-ment`}
          items={ments.map((item) => ({ id: item.id, label: item.title }))}
          value={ments.some((item) => item.id === mentId) ? mentId : null}
          empty={product ? '등록된 멘트가 없습니다' : '제품을 먼저 고르세요'}
          placeholder="멘트 선택"
          disabled={disabled}
          onChange={(value) => {
            const ment = ments.find((item) => item.id === value);
            if (ment) onPick(ment);
          }}
        />
      </div>
    </div>
  );
}
