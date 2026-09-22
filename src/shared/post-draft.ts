import type { PostDraft } from './contracts';

export const validDraftCaption = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 10_000 &&
  !Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
  });

export const validDraftMediaIds = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 100 &&
  value.every((id) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)) &&
  new Set(value).size === value.length;

function validDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}

export function validPostDraft(value: unknown): value is PostDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  return (
    validDraftCaption(draft.caption) &&
    validDraftMediaIds(draft.mediaIds) &&
    validDate(draft.createdAt) &&
    validDate(draft.updatedAt) &&
    Date.parse(draft.updatedAt) >= Date.parse(draft.createdAt) &&
    typeof draft.revision === 'number' &&
    Number.isSafeInteger(draft.revision) &&
    draft.revision > 0
  );
}
