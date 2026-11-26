import { useId, useState } from 'react';
import { MENT_TITLE_LIMIT, mentLength, type MentCatalog, type MentResult } from '../shared/ments';
import { ManagedThreadsActionDialog } from './ManagedThreadsActionDialog';
import { MentPlaceSelects, type MentPlace } from './MentPicker';
import { mentLineValid } from './ment-model';
import { useToast } from './toast';

/**
 * [멘트 등록] in the window a post is written in (2026-11-25, the user's call): the post's text is
 * saved as a new ment under a brand and product that already exist. The ones the post's boxes show
 * are chosen at first and can be changed; the title starts empty.
 */
export function MentRegisterDialog({
  catalog,
  place,
  body,
  onCatalog,
  onSaved,
  onClose,
}: {
  catalog: MentCatalog;
  place: MentPlace;
  body: string;
  /** The catalog the server sent back with a refusal, so the boxes show what it has. */
  onCatalog(catalog: MentCatalog): void;
  onSaved(catalog: MentCatalog, place: MentPlace, mentId: string): void;
  onClose(): void;
}) {
  const id = useId();
  const notify = useToast();
  const [chosen, setChosen] = useState(place);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const brand = catalog.brands.find((item) => item.id === chosen.brandId) ?? null;
  const product = brand?.products.find((item) => item.id === chosen.productId) ?? null;
  const length = mentLength(title.trim());
  const valid = !!product && mentLineValid(title, MENT_TITLE_LIMIT);
  async function save() {
    if (!brand || !product || busy || !valid) return;
    setBusy(true);
    const mentId = crypto.randomUUID();
    let result: MentResult;
    try {
      result = await window.threadsMedia.saveMent({
        kind: 'ment',
        id: mentId,
        productId: product.id,
        title: title.trim(),
        body,
      });
    } catch {
      setBusy(false);
      notify({
        message: '멘트 등록 결과를 확인하지 못했습니다. 멘트 관리에서 확인하세요.',
        error: true,
      });
      return;
    }
    if (result.status === 'ok' && result.catalog) {
      notify({ message: '멘트를 등록했습니다.' });
      onSaved(result.catalog, { brandId: brand.id, productId: product.id }, mentId);
      return;
    }
    setBusy(false);
    if (result.catalog) onCatalog(result.catalog);
    notify({ message: result.problem?.message ?? '멘트를 등록하지 못했습니다.', error: true });
  }
  return (
    <ManagedThreadsActionDialog title="멘트 등록" busy={busy} onClose={onClose}>
      <form
        className="daily-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="daily-ment-picker">
          <MentPlaceSelects
            catalog={catalog}
            place={{ brandId: brand?.id ?? null, productId: product?.id ?? null }}
            disabled={busy}
            onSelect={setChosen}
          />
        </div>
        <label htmlFor={`${id}-title`}>멘트 제목</label>
        <input
          id={`${id}-title`}
          type="text"
          value={title}
          autoComplete="off"
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />
        <p className={`daily-form-count ${length > MENT_TITLE_LIMIT ? 'is-over' : ''}`}>
          {length} / {MENT_TITLE_LIMIT}
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
