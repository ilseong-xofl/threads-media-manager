import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  MENT_BODY_LIMIT,
  MENT_NAME_LIMIT,
  MENT_TITLE_LIMIT,
  mentLength,
  type Ment,
  type MentBrand,
  type MentCatalog,
  type MentKind,
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
  | { kind: 'brand'; id: string; item: MentBrand | null }
  | { kind: 'product'; id: string; brandId: string; item: MentProduct | null }
  | { kind: 'ment'; id: string; productId: string; item: Ment | null };

const kindNames = { brand: '브랜드', product: '제품', ment: '멘트' } as const;

/**
 * The [멘트 관리] window of the daily tab (2026-11-24): one select box each for the brand, its
 * product and the product's ment, and the chosen ment's text below, so the window keeps one size.
 * Everything is kept on the server for the signed-in employee.
 */
export function MentManagerModal({ onClose }: { onClose(): void }) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const ments = useMents(onClose);
  const [brandId, setBrandId] = useState<string | null>(null);
  const [productId, setProductId] = useState<string | null>(null);
  const [mentId, setMentId] = useState<string | null>(null);
  const [form, setForm] = useState<MentForm | null>(null);
  const [deleting, setDeleting] = useState<MentTarget | null>(null);
  const refocus = useRef(false);
  const focusBody = useRef(false);
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
  const { brand, product, ment } = catalog
    ? selectMent(catalog, brandId, productId, mentId)
    : { brand: null, product: null, ment: null };
  // What the window chose by itself stays chosen while the catalog changes around it.
  useEffect(() => {
    if (brand && brand.id !== brandId) setBrandId(brand.id);
    if (product && product.id !== productId) setProductId(product.id);
    if (ment && ment.id !== mentId) setMentId(ment.id);
  }, [brand, product, ment, brandId, productId, mentId]);
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
  // The button that opened a deleted item's windows may be off now; keep the keyboard in the window.
  useEffect(() => {
    if (!refocus.current || deleting || form) return;
    refocus.current = false;
    requestAnimationFrame(() =>
      dialog.current
        ?.querySelector<HTMLButtonElement>('.ment-board button:not(:disabled)')
        ?.focus({ preventScroll: true }),
    );
  }, [deleting, form]);
  // A ment registered by its title is written next, so the cursor goes to its text.
  useEffect(() => {
    if (!focusBody.current || form) return;
    focusBody.current = false;
    requestAnimationFrame(() =>
      dialog.current
        ?.querySelector<HTMLTextAreaElement>('textarea.ment-body')
        ?.focus({ preventScroll: true }),
    );
  }, [form]);

  async function saveName(open: Extract<MentForm, { kind: 'brand' | 'product' }>, name: string) {
    const saved = await ments.save(
      open.kind === 'brand'
        ? { kind: 'brand', id: open.id, name }
        : { kind: 'product', id: open.id, brandId: open.brandId, name },
    );
    if (!saved) return;
    // A new brand or product is chosen at once, and what is under it starts from its first.
    if (!open.item && open.kind === 'brand') {
      setBrandId(open.id);
      setProductId(null);
      setMentId(null);
    }
    if (!open.item && open.kind === 'product') {
      setProductId(open.id);
      setMentId(null);
    }
    setForm(null);
  }
  /** Registers a ment by its title, or renames one; its text is kept and written in the window. */
  async function saveTitle(open: Extract<MentForm, { kind: 'ment' }>, title: string) {
    const body = open.item?.body ?? '';
    if (!(await ments.save({ kind: 'ment', id: open.id, productId: open.productId, title, body })))
      return;
    if (!open.item) {
      setMentId(open.id);
      focusBody.current = true;
    }
    setForm(null);
  }
  function saveBody(body: string) {
    if (!product || !ment) return Promise.resolve(false);
    return ments.save({
      kind: 'ment',
      id: ment.id,
      productId: product.id,
      title: ment.title,
      body,
    });
  }
  async function remove(target: MentTarget) {
    if (!(await ments.remove({ kind: target.kind, id: target.item.id }))) return;
    refocus.current = true;
    setDeleting(null);
    setForm(null);
  }
  function add(kind: MentKind) {
    if (kind === 'brand') setForm({ kind, id: crypto.randomUUID(), item: null });
    if (kind === 'product' && brand)
      setForm({ kind, id: crypto.randomUUID(), brandId: brand.id, item: null });
    if (kind === 'ment' && product)
      setForm({ kind, id: crypto.randomUUID(), productId: product.id, item: null });
  }
  function edit(kind: MentKind) {
    if (kind === 'brand' && brand) setForm({ kind, id: brand.id, item: brand });
    if (kind === 'product' && brand && product)
      setForm({ kind, id: product.id, brandId: brand.id, item: product });
    if (kind === 'ment' && product && ment)
      setForm({ kind, id: ment.id, productId: product.id, item: ment });
  }
  function askDelete(kind: MentKind) {
    if (kind === 'brand' && brand) setDeleting({ kind, item: brand });
    if (kind === 'product' && product) setDeleting({ kind, item: product });
    if (kind === 'ment' && ment) setDeleting({ kind, item: ment });
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
            ment={ment}
            busy={ments.busy}
            onSelectBrand={(id) => {
              setBrandId(id);
              setProductId(null);
              setMentId(null);
            }}
            onSelectProduct={(id) => {
              setProductId(id);
              setMentId(null);
            }}
            onSelectMent={setMentId}
            onAdd={add}
            onEdit={edit}
            onDelete={askDelete}
            onSaveBody={saveBody}
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
          title={`${kindNames[form.kind]} ${form.item ? '수정' : '등록'}`}
          label={`${kindNames[form.kind]} 이름`}
          limit={MENT_NAME_LIMIT}
          initial={form.item?.name ?? ''}
          busy={ments.busy}
          onSave={(name) => saveName(form, name)}
          onClose={() => setForm(null)}
        />
      )}
      {form?.kind === 'ment' && (
        <MentNameDialog
          title={form.item ? '멘트 제목 수정' : '멘트 등록'}
          label="멘트 제목"
          limit={MENT_TITLE_LIMIT}
          initial={form.item?.title ?? ''}
          busy={ments.busy}
          onSave={(title) => saveTitle(form, title)}
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
            <button
              type="button"
              className="ment-action-button"
              disabled={ments.busy}
              onClick={() => setDeleting(null)}
            >
              돌아가기
            </button>
            <button
              type="button"
              className="managed-threads-danger-primary ment-action-button"
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

/**
 * The brand, product and ment select boxes, each under its label with its buttons, and the chosen
 * ment's text below, written and saved in place.
 */
export function MentCatalogView({
  catalog,
  brand,
  product,
  ment,
  busy,
  onSelectBrand,
  onSelectProduct,
  onSelectMent,
  onAdd,
  onEdit,
  onDelete,
  onSaveBody,
}: {
  catalog: MentCatalog;
  brand: MentBrand | null;
  product: MentProduct | null;
  ment: Ment | null;
  busy: boolean;
  onSelectBrand(id: string): void;
  onSelectProduct(id: string): void;
  onSelectMent(id: string): void;
  onAdd(kind: MentKind): void;
  /** For a ment, only its title; its text is edited in the window. */
  onEdit(kind: MentKind): void;
  onDelete(kind: MentKind): void;
  onSaveBody(body: string): Promise<boolean>;
}) {
  const id = useId();
  const field = (kind: MentKind, count: number, canAdd: boolean, chosen: boolean) => ({
    id: `${id}-${kind}`,
    label: kindNames[kind],
    count,
    busy,
    canAdd,
    chosen,
    onAdd: () => onAdd(kind),
    onEdit: () => onEdit(kind),
    onDelete: () => onDelete(kind),
  });
  return (
    <div className="ment-board">
      {/* Brand and product share one row; the ment takes a whole row with its text below. */}
      <MentField {...field('brand', catalog.brands.length, true, !!brand)}>
        <MentSelect
          id={`${id}-brand`}
          items={catalog.brands.map((item) => ({ id: item.id, label: item.name }))}
          value={brand?.id ?? null}
          empty="등록된 브랜드가 없습니다"
          onChange={onSelectBrand}
        />
      </MentField>
      <MentField {...field('product', brand?.products.length ?? 0, !!brand, !!product)}>
        <MentSelect
          id={`${id}-product`}
          items={(brand?.products ?? []).map((item) => ({ id: item.id, label: item.name }))}
          value={product?.id ?? null}
          empty={brand ? '등록된 제품이 없습니다' : '브랜드를 먼저 등록하세요'}
          onChange={onSelectProduct}
        />
      </MentField>
      <MentField {...field('ment', product?.ments.length ?? 0, !!product, !!ment)} wide>
        <MentSelect
          id={`${id}-ment`}
          items={(product?.ments ?? []).map((item) => ({ id: item.id, label: item.title }))}
          value={ment?.id ?? null}
          empty={product ? '등록된 멘트가 없습니다' : '제품을 먼저 등록하세요'}
          onChange={onSelectMent}
        />
        {/* A new editor per ment, so switching ments starts from that ment's saved text. */}
        <MentBodyEditor key={ment?.id ?? ''} ment={ment} busy={busy} onSave={onSaveBody} />
      </MentField>
    </div>
  );
}

function MentField({
  id,
  label,
  count,
  busy,
  canAdd,
  chosen,
  wide = false,
  onAdd,
  onEdit,
  onDelete,
  children,
}: {
  id: string;
  label: string;
  /** How many there are: brands, the brand's products, the product's ments. */
  count: number;
  busy: boolean;
  canAdd: boolean;
  /** Something is chosen to edit or delete. */
  chosen: boolean;
  /** Takes the whole row instead of half of it. */
  wide?: boolean;
  onAdd(): void;
  onEdit(): void;
  onDelete(): void;
  children: ReactNode;
}) {
  // Bare coloured icons (add blue, edit green, delete red); the box shows only under the pointer.
  const action = (
    name: 'plus' | 'edit' | 'trash',
    verb: string,
    enabled: boolean,
    run: () => void,
  ) => (
    <button
      type="button"
      className={`ment-icon ment-icon-${{ plus: 'add', edit: 'edit', trash: 'delete' }[name]}`}
      aria-label={`${label} ${verb}`}
      title={`${label} ${verb}`}
      disabled={busy || !enabled}
      onClick={run}
    >
      <Icon name={name} />
    </button>
  );
  return (
    <div className={`ment-field${wide ? ' ment-field-wide' : ''}`}>
      <div className="ment-field-head">
        <div className="ment-field-title">
          <label htmlFor={id}>{label}</label>
          <span className="ment-count">{count}</span>
        </div>
        <div className="ment-field-actions">
          {action('plus', '등록', canAdd, onAdd)}
          {action('edit', '수정', chosen, onEdit)}
          {action('trash', '삭제', chosen, onDelete)}
        </div>
      </div>
      {children}
    </div>
  );
}

function MentSelect({
  id,
  items,
  value,
  empty,
  onChange,
}: {
  id: string;
  items: { id: string; label: string }[];
  value: string | null;
  /** Shown in the disabled box while there is nothing to choose. */
  empty: string;
  onChange(id: string): void;
}) {
  // The app's own select look: no native arrow, a chevron inset from the right edge.
  return (
    <div className="select-field">
      <select
        id={id}
        value={value ?? ''}
        disabled={!items.length}
        onChange={(event) => onChange(event.target.value)}
      >
        {items.length ? (
          items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))
        ) : (
          <option value="">{empty}</option>
        )}
      </select>
      <Icon name="chevron" />
    </div>
  );
}

function MentNameDialog({
  title,
  label,
  limit,
  initial,
  busy,
  onSave,
  onClose,
}: {
  title: string;
  label: string;
  limit: number;
  initial: string;
  busy: boolean;
  onSave(name: string): Promise<void>;
  onClose(): void;
}) {
  const id = useId();
  const [name, setName] = useState(initial);
  const length = mentLength(name.trim());
  const valid = mentLineValid(name, limit);
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
        <p className={`daily-form-count ${length > limit ? 'is-over' : ''}`}>
          {length} / {limit}
        </p>
        <div className="threads-actions managed-threads-dialog-actions">
          <button type="button" className="ment-action-button" disabled={busy} onClick={onClose}>
            취소
          </button>
          <button type="submit" className="primary ment-action-button" disabled={busy || !valid}>
            {busy ? '저장 중…' : '저장'}
          </button>
        </div>
      </form>
    </ManagedThreadsActionDialog>
  );
}

/**
 * The chosen ment's text, written in place and kept with [저장], which is on only while the text
 * differs from what is saved. With no ment there is nothing to write into.
 */
function MentBodyEditor({
  ment,
  busy,
  onSave,
}: {
  ment: Ment | null;
  busy: boolean;
  onSave(body: string): Promise<boolean>;
}) {
  const [text, setText] = useState(ment?.body ?? '');
  const length = mentLength(text.trim());
  const changed = !!ment && text.trim() !== ment.body;
  return (
    <>
      <textarea
        className="ment-body"
        aria-label="멘트 내용"
        value={text}
        disabled={!ment || busy}
        placeholder={
          ment ? '멘트 내용을 쓰고 저장하세요.' : '멘트를 등록하면 여기에 내용을 쓸 수 있습니다.'
        }
        onChange={(event) => setText(event.target.value)}
      />
      <div className="ment-body-foot">
        <span className={`ment-body-count${length > MENT_BODY_LIMIT ? ' is-over' : ''}`}>
          {length} / {MENT_BODY_LIMIT}
        </span>
        <button
          type="button"
          className="primary ment-action-button"
          disabled={busy || !changed || length > MENT_BODY_LIMIT}
          onClick={() => void onSave(text)}
        >
          {busy && changed ? '저장 중…' : '저장'}
        </button>
      </div>
    </>
  );
}
