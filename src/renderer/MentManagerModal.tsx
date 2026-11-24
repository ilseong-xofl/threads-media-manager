import { useEffect, useId, useRef, useState } from 'react';
import {
  MENT_BODY_LIMIT,
  MENT_NAME_LIMIT,
  MENT_TITLE_LIMIT,
  mentLength,
  type Ment,
  type MentBrand,
  type MentCatalog,
  type MentProduct,
} from '../shared/ments';
import { Icon } from './Icon';
import { ManagedThreadsActionDialog } from './ManagedThreadsActionDialog';
import {
  mentDeleteMessage,
  mentHas,
  mentLineValid,
  selectMent,
  type MentTarget,
} from './ment-model';
import { useMents } from './use-ments';
import './daily.css';
import './managed-threads.css';
import './ments.css';

/** An add or edit form. A new item's id is chosen as the form opens, so a retry reuses it. */
type MentForm =
  | { kind: 'brand'; id: string; brandId?: undefined; item: MentBrand | null }
  | { kind: 'product'; id: string; brandId: string; item: MentProduct | null }
  | { kind: 'ment'; id: string; productId: string; item: Ment | null };

const kindNames = { brand: '브랜드', product: '제품', ment: '멘트' } as const;

/**
 * The [멘트 관리] window of the daily tab (2026-11-24): brands and products side by side, the
 * chosen product's ments below. Everything is kept on the server for the signed-in employee.
 */
export function MentManagerModal({ onClose }: { onClose(): void }) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const ments = useMents(onClose);
  const [brandId, setBrandId] = useState<string | null>(null);
  const [productId, setProductId] = useState<string | null>(null);
  const [form, setForm] = useState<MentForm | null>(null);
  const [deleting, setDeleting] = useState<MentTarget | null>(null);
  const refocus = useRef(false);
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    element?.showModal();
    close.current?.focus();
    document.body.style.overflow = 'hidden';
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  const requestClose = () => {
    if (!ments.busy) onClose();
  };
  const { catalog } = ments;
  const { brand, product } = catalog
    ? selectMent(catalog, brandId, productId)
    : { brand: null, product: null };
  // What the window chose by itself stays chosen when a rename moves it in the name order.
  useEffect(() => {
    if (brand && brand.id !== brandId) setBrandId(brand.id);
    if (product && product.id !== productId) setProductId(product.id);
  }, [brand, product, brandId, productId]);
  // An item the catalog read again no longer has (a delete whose answer was lost) takes its
  // windows with it, so saving there cannot bring back a parent without what was under it.
  useEffect(() => {
    if (!catalog) return;
    if (deleting && !mentHas(catalog, deleting.kind, deleting.item.id)) setDeleting(null);
    if (
      form &&
      (form.item
        ? !mentHas(catalog, form.kind, form.item.id)
        : (form.kind === 'product' && !mentHas(catalog, 'brand', form.brandId)) ||
          (form.kind === 'ment' && !mentHas(catalog, 'product', form.productId)))
    )
      setForm(null);
  }, [catalog, deleting, form]);
  // The button that opened a deleted item's windows went with it; keep the keyboard in the window.
  useEffect(() => {
    if (!refocus.current || deleting || form) return;
    refocus.current = false;
    requestAnimationFrame(() =>
      dialog.current
        ?.querySelector<HTMLButtonElement>('.ment-board button:not(:disabled)')
        ?.focus({ preventScroll: true }),
    );
  }, [deleting, form]);

  async function saveName(open: Extract<MentForm, { kind: 'brand' | 'product' }>, name: string) {
    const saved = await ments.save(
      open.kind === 'brand'
        ? { kind: 'brand', id: open.id, name }
        : { kind: 'product', id: open.id, brandId: open.brandId, name },
    );
    if (!saved) return;
    // A new brand or product is chosen at once; a new brand shows its (empty) product list.
    if (!open.item && open.kind === 'brand') {
      setBrandId(open.id);
      setProductId(null);
    }
    if (!open.item && open.kind === 'product') setProductId(open.id);
    setForm(null);
  }
  async function saveMent(open: Extract<MentForm, { kind: 'ment' }>, title: string, body: string) {
    if (await ments.save({ kind: 'ment', id: open.id, productId: open.productId, title, body }))
      setForm(null);
  }
  async function remove(target: MentTarget) {
    if (!(await ments.remove({ kind: target.kind, id: target.item.id }))) return;
    refocus.current = true;
    setDeleting(null);
    setForm(null);
  }

  return (
    <dialog
      ref={dialog}
      className="post-modal ment-manager-modal"
      aria-labelledby={titleId}
      aria-busy={ments.busy}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        requestClose();
      }}
    >
      <div className="ment-manager-header">
        <div>
          <h2 id={titleId}>멘트 관리</h2>
          <p>브랜드와 제품별로 광고 멘트를 저장해 둡니다.</p>
        </div>
        <button
          ref={close}
          type="button"
          className="icon-button"
          aria-label="멘트 관리 닫기"
          disabled={ments.busy}
          onClick={requestClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="ment-manager-content">
        {catalog ? (
          <MentCatalogView
            catalog={catalog}
            brand={brand}
            product={product}
            busy={ments.busy}
            onSelectBrand={(id) => {
              setBrandId(id);
              setProductId(null);
            }}
            onSelectProduct={setProductId}
            onAddBrand={() => setForm({ kind: 'brand', id: crypto.randomUUID(), item: null })}
            onEditBrand={(item) => setForm({ kind: 'brand', id: item.id, item })}
            onAddProduct={() =>
              brand &&
              setForm({ kind: 'product', id: crypto.randomUUID(), brandId: brand.id, item: null })
            }
            onEditProduct={(item) =>
              brand && setForm({ kind: 'product', id: item.id, brandId: brand.id, item })
            }
            onAddMent={() =>
              product &&
              setForm({ kind: 'ment', id: crypto.randomUUID(), productId: product.id, item: null })
            }
            onEditMent={(item) =>
              product && setForm({ kind: 'ment', id: item.id, productId: product.id, item })
            }
            onDeleteMent={(item) => setDeleting({ kind: 'ment', item })}
          />
        ) : (
          <div className="ment-loading" role="status">
            {ments.loading ? (
              <p>멘트를 불러오고 있습니다.</p>
            ) : (
              <>
                <p>멘트를 불러오지 못했습니다.</p>
                <button type="button" onClick={() => void ments.load()}>
                  다시 불러오기
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {form && form.kind !== 'ment' && (
        <MentNameDialog
          title={`${kindNames[form.kind]} ${form.item ? '수정' : '추가'}`}
          label={`${kindNames[form.kind]} 이름`}
          initial={form.item?.name ?? ''}
          busy={ments.busy}
          onSave={(name) => saveName(form, name)}
          onDelete={
            form.item
              ? () =>
                  setDeleting(
                    form.kind === 'brand'
                      ? { kind: 'brand', item: form.item as MentBrand }
                      : { kind: 'product', item: form.item as MentProduct },
                  )
              : undefined
          }
          onClose={() => setForm(null)}
        />
      )}
      {form?.kind === 'ment' && (
        <MentTextDialog
          title={form.item ? '멘트 수정' : '멘트 추가'}
          initialTitle={form.item?.title ?? ''}
          initialBody={form.item?.body ?? ''}
          busy={ments.busy}
          onSave={(title, body) => saveMent(form, title, body)}
          onClose={() => setForm(null)}
        />
      )}
      {deleting && (
        <ManagedThreadsActionDialog
          title={`${kindNames[deleting.kind]} 삭제`}
          busy={ments.busy}
          confirmation
          onClose={() => setDeleting(null)}
        >
          <div className="managed-threads-confirm-copy">
            <p>{mentDeleteMessage(deleting)}</p>
          </div>
          <div className="threads-actions managed-threads-dialog-actions">
            <button type="button" disabled={ments.busy} onClick={() => setDeleting(null)}>
              돌아가기
            </button>
            <button
              type="button"
              className="managed-threads-danger-primary"
              disabled={ments.busy}
              onClick={() => void remove(deleting)}
            >
              {ments.busy ? '삭제 중…' : '삭제'}
            </button>
          </div>
        </ManagedThreadsActionDialog>
      )}
    </dialog>
  );
}

/** Brands and products on top, the chosen product's ments below. Holds no state of its own. */
export function MentCatalogView({
  catalog,
  brand,
  product,
  busy,
  onSelectBrand,
  onSelectProduct,
  onAddBrand,
  onEditBrand,
  onAddProduct,
  onEditProduct,
  onAddMent,
  onEditMent,
  onDeleteMent,
}: {
  catalog: MentCatalog;
  brand: MentBrand | null;
  product: MentProduct | null;
  busy: boolean;
  onSelectBrand(id: string): void;
  onSelectProduct(id: string): void;
  onAddBrand(): void;
  onEditBrand(brand: MentBrand): void;
  onAddProduct(): void;
  onEditProduct(product: MentProduct): void;
  onAddMent(): void;
  onEditMent(ment: Ment): void;
  onDeleteMent(ment: Ment): void;
}) {
  return (
    <div className="ment-board">
      <div className="ment-lists">
        <MentList
          title="브랜드"
          kind="브랜드"
          items={catalog.brands}
          selectedId={brand?.id ?? null}
          count={(item) => `제품 ${item.products.length}`}
          empty="브랜드를 추가하세요."
          canAdd
          busy={busy}
          onSelect={onSelectBrand}
          onAdd={onAddBrand}
          onEdit={onEditBrand}
        />
        <MentList
          title={brand ? `제품 · ${brand.name}` : '제품'}
          kind="제품"
          items={brand?.products ?? []}
          selectedId={product?.id ?? null}
          count={(item) => `멘트 ${item.ments.length}`}
          empty={brand ? '이 브랜드에 제품을 추가하세요.' : '브랜드를 먼저 추가하세요.'}
          canAdd={!!brand}
          busy={busy}
          onSelect={onSelectProduct}
          onAdd={onAddProduct}
          onEdit={onEditProduct}
        />
      </div>
      <section className="ment-panel ment-texts" aria-label="멘트">
        <div className="ment-panel-header">
          <h3>
            멘트
            {brand && product && (
              <span className="ment-path">
                {' '}
                — {brand.name} › {product.name}
              </span>
            )}
          </h3>
          <button
            type="button"
            className="primary ment-add-text"
            disabled={busy || !product}
            onClick={onAddMent}
          >
            <Icon name="plus" />
            멘트
          </button>
        </div>
        {!product ? (
          <p className="ment-empty">
            {brand
              ? '이 브랜드에 제품을 추가하면 멘트를 넣을 수 있습니다.'
              : '브랜드와 제품을 추가하면 멘트를 넣을 수 있습니다.'}
          </p>
        ) : product.ments.length ? (
          <ul className="ment-cards">
            {product.ments.map((ment) => (
              <li key={ment.id} className="ment-card">
                <div className="ment-card-head">
                  <strong className="ment-card-title">{ment.title}</strong>
                  <div className="ment-card-actions">
                    <button
                      type="button"
                      aria-label={`${ment.title} 수정`}
                      disabled={busy}
                      onClick={() => onEditMent(ment)}
                    >
                      수정
                    </button>
                    <button
                      type="button"
                      className="managed-threads-danger"
                      aria-label={`${ment.title} 삭제`}
                      disabled={busy}
                      onClick={() => onDeleteMent(ment)}
                    >
                      삭제
                    </button>
                  </div>
                </div>
                <p className="ment-card-body">{ment.body}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ment-empty">이 제품의 멘트를 추가하세요.</p>
        )}
      </section>
    </div>
  );
}

function MentList<T extends { id: string; name: string }>({
  title,
  kind,
  items,
  selectedId,
  count,
  empty,
  canAdd,
  busy,
  onSelect,
  onAdd,
  onEdit,
}: {
  title: string;
  kind: string;
  items: T[];
  selectedId: string | null;
  count(item: T): string;
  empty: string;
  canAdd: boolean;
  busy: boolean;
  onSelect(id: string): void;
  onAdd(): void;
  onEdit(item: T): void;
}) {
  return (
    <section className="ment-panel" aria-label={kind}>
      <div className="ment-panel-header">
        <h3>{title}</h3>
        <button
          type="button"
          className="ment-add"
          aria-label={`${kind} 추가`}
          title={`${kind} 추가`}
          disabled={busy || !canAdd}
          onClick={onAdd}
        >
          <Icon name="plus" />
        </button>
      </div>
      {items.length ? (
        <ul className="ment-list">
          {items.map((item) => (
            <li key={item.id} className={item.id === selectedId ? 'is-selected' : undefined}>
              <button
                type="button"
                className="ment-row"
                aria-pressed={item.id === selectedId}
                onClick={() => onSelect(item.id)}
              >
                <span className="ment-row-name">{item.name}</span>
                <span className="ment-row-count">{count(item)}</span>
              </button>
              <button
                type="button"
                className="daily-icon-button"
                aria-label={`${item.name} 수정`}
                title="이름 바꾸기·삭제"
                disabled={busy}
                onClick={() => onEdit(item)}
              >
                <Icon name="more" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ment-empty">{empty}</p>
      )}
    </section>
  );
}

function MentNameDialog({
  title,
  label,
  initial,
  busy,
  onSave,
  onDelete,
  onClose,
}: {
  title: string;
  label: string;
  initial: string;
  busy: boolean;
  onSave(name: string): Promise<void>;
  onDelete?: () => void;
  onClose(): void;
}) {
  const id = useId();
  const [name, setName] = useState(initial);
  const length = mentLength(name.trim());
  const valid = mentLineValid(name, MENT_NAME_LIMIT);
  return (
    <ManagedThreadsActionDialog title={title} busy={busy} onClose={onClose}>
      <form
        className="daily-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && valid) void onSave(name);
        }}
      >
        <label htmlFor={`${id}-name`}>{label}</label>
        <input
          id={`${id}-name`}
          type="text"
          value={name}
          autoComplete="off"
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
        <p className={`daily-form-count ${length > MENT_NAME_LIMIT ? 'is-over' : ''}`}>
          {length} / {MENT_NAME_LIMIT}
        </p>
        <div className="threads-actions managed-threads-dialog-actions daily-form-actions">
          {onDelete && (
            <button
              type="button"
              className="managed-threads-danger daily-form-delete"
              disabled={busy}
              onClick={onDelete}
            >
              삭제
            </button>
          )}
          <button type="button" disabled={busy} onClick={onClose}>
            취소
          </button>
          <button type="submit" className="primary" disabled={busy || !valid}>
            {busy ? '저장 중…' : '저장'}
          </button>
        </div>
      </form>
    </ManagedThreadsActionDialog>
  );
}

function MentTextDialog({
  title,
  initialTitle,
  initialBody,
  busy,
  onSave,
  onClose,
}: {
  title: string;
  initialTitle: string;
  initialBody: string;
  busy: boolean;
  onSave(title: string, body: string): Promise<void>;
  onClose(): void;
}) {
  const id = useId();
  const [heading, setHeading] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const headingLength = mentLength(heading.trim());
  const bodyLength = mentLength(body.trim());
  const valid = mentLineValid(heading, MENT_TITLE_LIMIT) && mentLineValid(body, MENT_BODY_LIMIT);
  return (
    <ManagedThreadsActionDialog title={title} busy={busy} onClose={onClose}>
      <form
        className="daily-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && valid) void onSave(heading, body);
        }}
      >
        <label htmlFor={`${id}-title`}>제목</label>
        <input
          id={`${id}-title`}
          type="text"
          value={heading}
          autoComplete="off"
          placeholder="예: 후기형, 할인 안내"
          disabled={busy}
          onChange={(event) => setHeading(event.target.value)}
        />
        <p className={`daily-form-count ${headingLength > MENT_TITLE_LIMIT ? 'is-over' : ''}`}>
          {headingLength} / {MENT_TITLE_LIMIT}
        </p>
        <label htmlFor={`${id}-body`}>본문</label>
        <textarea
          id={`${id}-body`}
          value={body}
          rows={8}
          disabled={busy}
          onChange={(event) => setBody(event.target.value)}
        />
        <p className={`daily-form-count ${bodyLength > MENT_BODY_LIMIT ? 'is-over' : ''}`}>
          {bodyLength} / {MENT_BODY_LIMIT}
        </p>
        <div className="threads-actions managed-threads-dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            취소
          </button>
          <button type="submit" className="primary" disabled={busy || !valid}>
            {busy ? '저장 중…' : '저장'}
          </button>
        </div>
      </form>
    </ManagedThreadsActionDialog>
  );
}
