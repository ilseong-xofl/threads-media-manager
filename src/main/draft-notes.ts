import type {
  CollectionView,
  DraftNote,
  DraftNoteResult,
  Post,
  PostComment,
  PostDraft,
} from '../shared/contracts';
import {
  lockedPublicationAccount,
  type MobilePublication,
  type PendingMobilePublication,
} from '../shared/mobile-publications';
import { validPostDraft } from '../shared/post-draft';
import { ViewError } from './collection';
import type { DailyScope } from './daily-store';
import type { DraftNoteKey, DraftNoteStore, StoredDraftNote } from './draft-note-store';
import { exactKeys, isObject, parseManagedAccount } from './managed-threads-store';
import type { ServiceApiClient, ServiceBusinessContext } from './service-api';

type Client = Pick<
  ServiceApiClient,
  'getBusinessContext' | 'assertBusinessContext' | 'managedThreadsRequest'
>;
interface History {
  publications: MobilePublication[];
  pending: PendingMobilePublication[];
}
interface Options {
  client: Client;
  store: Pick<DraftNoteStore, 'get' | 'update'>;
  service: string;
  /** What was sent for a post: the server's copies and the sends still pending on this PC. */
  history(libraryId: string, postKey: string): Promise<History>;
}
const EMPTY: DraftNote = { accountId: null, translation: null, commentTranslation: null };
function fail(code: string, message: string): never {
  throw new ViewError(code, message);
}

/**
 * The account a registered draft is written for, and the Korean renderings of its AI caption
 * and comment (2026-11-18). The account is decided when the post is written, not when it is
 * sent, so the caption can be written as that account's persona.
 */
export class DraftNotes {
  constructor(private readonly options: Options) {}
  private scope(context: ServiceBusinessContext): DailyScope {
    return { service: this.options.service, ownerId: context.ownerId };
  }
  private static key(libraryId: string, postKey: string, draft: PostDraft): DraftNoteKey {
    return { libraryId, postKey, draftCreatedAt: draft.createdAt };
  }
  /** The stored note, or null when there is none. A file that cannot be read throws. */
  private stored(context: ServiceBusinessContext, key: DraftNoteKey) {
    return this.options.store.get(this.scope(context), key);
  }
  /** What holds for the post as it is now: a note saved for another revision says nothing. */
  private static current(note: StoredDraftNote | null, post: Post): DraftNote {
    if (!note || !post.draft) return EMPTY;
    const fresh = note.revision === post.draft.revision;
    return {
      accountId: fresh ? note.accountId : null,
      translation: fresh ? note.translation : null,
      commentTranslation:
        post.comment && note.comment?.updatedAt === post.comment.updatedAt
          ? note.comment.translation
          : null,
    };
  }

  /** For the screen. Reads the already loaded view; it does not refresh the library. */
  async read(view: CollectionView, input: unknown): Promise<DraftNoteResult> {
    try {
      if (!isObject(input) || !exactKeys(input, ['postKey']) || typeof input.postKey !== 'string')
        fail('draft_note_input', '게시글을 확인해 주세요.');
      const libraryId = view.snapshot?.libraryId;
      const post = view.snapshot?.posts.find((item) => item.key === input.postKey);
      if (!libraryId || !post || !validPostDraft(post.draft)) return { status: 'ok', note: EMPTY };
      const context = await this.options.client.getBusinessContext();
      // An unreadable file is an error on screen, not a quiet "nothing on record": the post would
      // otherwise show the first account as if no account had ever been chosen.
      const note = await this.stored(context, DraftNotes.key(libraryId, post.key, post.draft));
      this.options.client.assertBusinessContext(context);
      return { status: 'ok', note: DraftNotes.current(note, post) };
    } catch (error) {
      return {
        status: 'error',
        problem:
          error instanceof ViewError
            ? {
                code: error.code,
                message:
                  error.code === 'draft_note_storage'
                    ? '이 PC의 계정 기록을 읽지 못했습니다. 계정이 자동 지정으로 보일 수 있으니 보내기 전에 계정을 확인하세요.'
                    : error.message,
              }
            : { code: 'draft_note', message: '계정 기록을 확인하지 못했습니다.' },
      };
    }
  }

  /** Before a draft is saved: the account is the user's own, and a sent post keeps its account. */
  async requireAccount(libraryId: string, post: Post, accountId: string): Promise<void> {
    const context = await this.options.client.getBusinessContext();
    const raw = await this.options.client.managedThreadsRequest(context, 'list');
    this.options.client.assertBusinessContext(context);
    if (!isObject(raw) || !Array.isArray(raw.accounts))
      fail('INVALID_RESPONSE', '계정 목록을 확인하지 못했습니다.');
    let own: boolean;
    try {
      own = (raw.accounts as unknown[])
        .map((account) => parseManagedAccount(account, context.ownerId))
        .some((account) => account.id === accountId);
    } catch {
      return fail('INVALID_RESPONSE', '계정 목록을 확인하지 못했습니다.');
    }
    if (!own) fail('draft_account', '본인이 등록한 게시 계정을 선택하세요.');
    if (!validPostDraft(post.draft)) return;
    const { publications, pending } = await this.options.history(libraryId, post.key);
    const locked = lockedPublicationAccount(publications, pending, post.draft.createdAt);
    if (locked && locked !== accountId)
      fail('draft_account_locked', '이미 보낸 글은 계정을 바꿀 수 없습니다.');
  }

  /** After a draft is saved. False when the note could not be written; the draft stays saved. */
  async recordDraft(
    libraryId: string,
    postKey: string,
    draft: PostDraft,
    accountId: string,
    translation: string | null,
  ): Promise<boolean> {
    try {
      const context = await this.options.client.getBusinessContext();
      const key = DraftNotes.key(libraryId, postKey, draft);
      await this.options.store.update(this.scope(context), key, (note) => ({
        ...key,
        revision: draft.revision,
        accountId,
        translation,
        comment: note?.comment ?? null,
      }));
      return true;
    } catch {
      return false;
    }
  }

  /** After a comment is saved. A failure only loses the Korean rendering. */
  async recordComment(
    libraryId: string,
    post: Post,
    comment: PostComment,
    translation: string | null,
  ): Promise<void> {
    if (!validPostDraft(post.draft)) return;
    const draft = post.draft;
    try {
      const context = await this.options.client.getBusinessContext();
      const key = DraftNotes.key(libraryId, post.key, draft);
      await this.options.store.update(this.scope(context), key, (note) => {
        const next = translation ? { updatedAt: comment.updatedAt, translation } : null;
        if (!note && !next) return null;
        // A note made only for a comment records no account for the draft.
        return {
          ...(note ?? { ...key, revision: draft.revision, accountId: null, translation: null }),
          comment: next,
        };
      });
    } catch {
      /* The comment itself is saved; only its rendering is missing. */
    }
  }

  /** After a registration is deleted. */
  async forget(libraryId: string, post: Post): Promise<void> {
    if (!validPostDraft(post.draft)) return;
    try {
      const context = await this.options.client.getBusinessContext();
      await this.options.store.update(
        this.scope(context),
        DraftNotes.key(libraryId, post.key, post.draft),
        () => null,
      );
    } catch {
      /* A leftover note is keyed by a registration that no longer exists. */
    }
  }

  /**
   * At send time, inside the sender's lock: the account shown on screen must be the one the post
   * is bound to. A post with no account on record takes this account as its record.
   */
  async confirmSendAccount(
    context: ServiceBusinessContext,
    libraryId: string,
    post: Post,
    accountId: string,
    history: History,
  ): Promise<void> {
    if (!validPostDraft(post.draft)) return;
    const draft = post.draft;
    const locked = lockedPublicationAccount(history.publications, history.pending, draft.createdAt);
    if (locked && locked !== accountId)
      fail(
        'mobile_publication_account_changed',
        '이 글은 이미 다른 계정으로 보냈습니다. 글을 다시 열어 계정을 확인하세요.',
      );
    const key = DraftNotes.key(libraryId, post.key, draft);
    let stored: StoredDraftNote | null;
    try {
      stored = await this.stored(context, key);
    } catch {
      // Without the record nobody can tell which account this post was written for.
      return fail(
        'mobile_publication_account_unknown',
        '이 PC의 계정 기록을 읽지 못해 보낼 계정을 확인할 수 없습니다. 기록 파일은 그대로 두었으니 관리자에게 문의하세요.',
      );
    }
    const note = DraftNotes.current(stored, post);
    if (note.accountId) {
      if (note.accountId !== accountId)
        fail(
          'mobile_publication_account_changed',
          '글에 지정한 계정과 보내려는 계정이 다릅니다. 글을 다시 열어 계정을 확인하세요.',
        );
      return;
    }
    try {
      await this.options.store.update(this.scope(context), key, (existing) => ({
        ...key,
        revision: draft.revision,
        accountId,
        translation: note.translation,
        comment: existing?.comment ?? null,
      }));
    } catch {
      /* The send itself names the account; a missing note only shows it as auto-assigned. */
    }
  }
}
