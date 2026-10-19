import type {
  MobilePublication,
  MobilePublicationMedia,
  MobilePublicationSource,
} from '../shared/mobile-publications';
import { isObject, validId, validRevision } from './managed-threads-store';
import { ServiceApiError } from './service-api';

export const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export const timestamp = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length <= 40 &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(v) &&
  Number.isFinite(Date.parse(v));
export const postKey = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 512 && !v.includes('\0');
const fail = (): never => {
  throw new ServiceApiError('게시 대기 정보를 확인하지 못했습니다.', 'INVALID_RESPONSE', 502);
};
export function parseSource(v: unknown): MobilePublicationSource {
  if (
    !isObject(v) ||
    typeof v.libraryId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(v.libraryId) ||
    !postKey(v.postKey) ||
    !timestamp(v.draftCreatedAt) ||
    !validRevision(v.draftRevision) ||
    !(v.commentUpdatedAt === null || timestamp(v.commentUpdatedAt))
  )
    return fail();
  return {
    libraryId: v.libraryId,
    postKey: v.postKey,
    draftCreatedAt: v.draftCreatedAt,
    draftRevision: v.draftRevision,
    commentUpdatedAt: v.commentUpdatedAt,
  };
}
export function parseMedia(v: unknown): MobilePublicationMedia[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 20) return fail();
  const result = v.map((m, i): MobilePublicationMedia => {
    if (
      !isObject(m) ||
      !uuid(m.id) ||
      m.ordinal !== i ||
      !['image', 'video'].includes(String(m.kind)) ||
      !['image/jpeg', 'image/png', 'video/mp4', 'video/quicktime'].includes(
        String(m.contentType),
      ) ||
      typeof m.size !== 'number' ||
      !Number.isSafeInteger(m.size) ||
      m.size <= 0 ||
      m.size > (m.kind === 'image' ? 8 * 1024 ** 2 : 1024 ** 3) ||
      !String(m.contentType).startsWith(`${m.kind}/`) ||
      typeof m.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(m.sha256)
    )
      return fail();
    return {
      id: m.id,
      ordinal: i,
      kind: m.kind as 'image' | 'video',
      contentType: m.contentType as MobilePublicationMedia['contentType'],
      size: m.size,
      sha256: m.sha256,
    };
  });
  if (new Set(result.map((m) => m.id)).size !== result.length) return fail();
  return result;
}
export function parseComment(v: unknown): MobilePublication['comment'] {
  if (v === null) return null;
  if (
    !isObject(v) ||
    typeof v.caption !== 'string' ||
    typeof v.link !== 'string' ||
    [...[v.caption, v.link].filter(Boolean).join('\n')].length > 500 ||
    ![v.caption, v.link].filter(Boolean).join('\n').trim()
  )
    return fail();
  return { caption: v.caption, link: v.link };
}
export function parsePublication(v: unknown): MobilePublication {
  if (
    !isObject(v) ||
    !uuid(v.id) ||
    !uuid(v.requestId) ||
    !validId(v.accountId) ||
    !validRevision(v.version) ||
    !['uploading', 'ready', 'cancelled', 'expired', 'started', 'published'].includes(
      String(v.status),
    ) ||
    typeof v.caption !== 'string' ||
    [...v.caption].length > 500 ||
    !(v.sentAt === null || timestamp(v.sentAt)) ||
    !(v.deadlineAt === null || timestamp(v.deadlineAt)) ||
    typeof v.rootStatus !== 'string' ||
    !/^[a-z_]{1,40}$/.test(v.rootStatus) ||
    typeof v.commentStatus !== 'string' ||
    !/^[a-z_]{1,40}$/.test(v.commentStatus)
  )
    return fail();
  return {
    id: v.id,
    requestId: v.requestId,
    version: v.version,
    accountId: v.accountId,
    source: parseSource(v.source),
    status: v.status as MobilePublication['status'],
    caption: v.caption,
    comment: parseComment(v.comment),
    media: parseMedia(v.media),
    sentAt: v.sentAt,
    deadlineAt: v.deadlineAt,
    rootStatus: v.rootStatus,
    commentStatus: v.commentStatus,
  };
}
export function parsePublications(v: unknown): MobilePublication[] {
  if (!isObject(v) || !Array.isArray(v.publications) || v.publications.length > 10000)
    return fail();
  const rows = v.publications.map(parsePublication);
  if (
    new Set(rows.map((r) => r.id)).size !== rows.length ||
    new Set(rows.map((r) => r.requestId)).size !== rows.length
  )
    return fail();
  return rows;
}
export function parsePublicationResponse(v: unknown): MobilePublication {
  return isObject(v) ? parsePublication(v.publication) : fail();
}

export interface PublicationRequest {
  requestId: string;
  accountId: string;
  expectedLifecycleVersion: number;
  expectedOwnershipVersion: number;
  source: MobilePublicationSource;
  caption: string;
  comment: MobilePublication['comment'];
  media: MobilePublicationMedia[];
}
export interface PublicationJournalEntry {
  service: string;
  ownerId: string;
  request: PublicationRequest;
}
export interface PublicationDeletionEntry {
  service: string;
  ownerId: string;
  requestId: string;
  source: Pick<MobilePublicationSource, 'libraryId' | 'postKey' | 'draftCreatedAt'>;
  expectedSourceVersion: number;
}
export interface PublicationJournal {
  version: 1;
  pending: PublicationJournalEntry[];
  deletions: PublicationDeletionEntry[];
}
export function validPublicationJournal(v: unknown): v is PublicationJournal {
  try {
    if (
      !isObject(v) ||
      v.version !== 1 ||
      !Array.isArray(v.pending) ||
      v.pending.length > 2000 ||
      !Array.isArray(v.deletions) ||
      v.deletions.length > 2000
    )
      return false;
    for (const e of v.pending) {
      if (
        !isObject(e) ||
        typeof e.service !== 'string' ||
        e.service.length > 2048 ||
        !validId(e.ownerId) ||
        !isObject(e.request)
      )
        return false;
      const r = e.request;
      if (
        !uuid(r.requestId) ||
        !validId(r.accountId) ||
        !validRevision(r.expectedLifecycleVersion) ||
        !validRevision(r.expectedOwnershipVersion) ||
        typeof r.caption !== 'string' ||
        [...r.caption].length > 500
      )
        return false;
      parseSource(r.source);
      parseMedia(r.media);
      parseComment(r.comment);
    }
    for (const e of v.deletions) {
      if (
        !isObject(e) ||
        typeof e.service !== 'string' ||
        !validId(e.ownerId) ||
        !uuid(e.requestId) ||
        !isObject(e.source) ||
        typeof e.expectedSourceVersion !== 'number' ||
        !Number.isSafeInteger(e.expectedSourceVersion) ||
        e.expectedSourceVersion < 0
      )
        return false;
      parseSource({ ...e.source, draftRevision: 1, commentUpdatedAt: null });
    }
    return (
      new Set(v.pending.map((e) => (e as PublicationJournalEntry).request.requestId)).size ===
        v.pending.length &&
      new Set(v.deletions.map((e) => (e as PublicationDeletionEntry).requestId)).size ===
        v.deletions.length
    );
  } catch {
    return false;
  }
}
