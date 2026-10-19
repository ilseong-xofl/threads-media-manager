import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { CollectionView, Post } from '../shared/contracts';
import type {
  MobilePublication,
  MobilePublicationsResult,
  SendMobilePublicationInput,
} from '../shared/mobile-publications';
import { validPostDraft } from '../shared/post-draft';
import { postDraftExportIssue } from '../shared/post-export';
import { ViewError } from './collection';
import {
  exactKeys,
  isObject,
  parseManagedAccount,
  validId,
  validRevision,
} from './managed-threads-store';
import {
  parsePublicationResponse,
  parsePublications,
  postKey,
  timestamp,
  uuid,
  type PublicationJournal,
  type PublicationJournalEntry,
  type PublicationRequest,
} from './mobile-publication-data';
import {
  parseUploadUrls,
  preparedFileDigest,
  uploadPublicationFile,
} from './publication-s3-upload';
import { ServiceApiError, type ServiceApiClient, type ServiceBusinessContext } from './service-api';
import type { ThreadsUploadFile } from './threads-media';
import { publicationWorkDirectory } from './publication-outbox';

type Client = Pick<
  ServiceApiClient,
  | 'getBusinessContext'
  | 'assertBusinessContext'
  | 'publicationRequest'
  | 'managedThreadsRequest'
  | 'businessSignal'
>;
interface JournalStore {
  read(): Promise<PublicationJournal | null>;
  write(value: PublicationJournal): Promise<void>;
}
interface Options {
  client: Client;
  store: JournalStore;
  service: string;
  userData: string;
  refresh(): Promise<CollectionView>;
  localBusy(): boolean;
  prepareMedia(root: string, ids: string[], directory: string): Promise<ThreadsUploadFile[]>;
  upload?: typeof uploadPublicationFile;
}
const terminal = (p: MobilePublication) => p.status !== 'uploading';
function fail(code: string, message: string): never {
  throw new ViewError(code, message);
}
const invalid = (): never =>
  fail('mobile_publication_input', '게시글과 전송 정보를 확인해 주세요.');
const safeProblem = (error: unknown) =>
  error instanceof ViewError || error instanceof ServiceApiError
    ? { code: error.code, message: error.message }
    : {
        code: 'mobile_publication_failed',
        message: '게시 대기 전송 상태를 확인하지 못했습니다. 기존 자료는 보존했습니다.',
      };
const result = (
  publications: MobilePublication[] = [],
  pending: MobilePublicationsResult['pending'] = [],
): MobilePublicationsResult => ({ status: 'ok', publications, pending, problem: null });
const sameSource = (a: PublicationRequest['source'], b: PublicationRequest['source']) =>
  JSON.stringify(a) === JSON.stringify(b);

export class MobilePublicationsController {
  private running = false;
  private operationSource: { libraryId: string; key: string } | null = null;
  constructor(private readonly options: Options) {}
  get active() {
    return this.running;
  }
  private async journal() {
    return (await this.options.store.read()) ?? { version: 1 as const, pending: [], deletions: [] };
  }
  private scoped(entry: { service: string; ownerId: string }, context: ServiceBusinessContext) {
    return entry.service === this.options.service && entry.ownerId === context.ownerId;
  }
  private assert(context: ServiceBusinessContext) {
    this.options.client.assertBusinessContext(context);
  }
  private async request(
    context: ServiceBusinessContext,
    operation: Parameters<Client['publicationRequest']>[1],
    id?: string,
    body?: unknown,
  ) {
    this.assert(context);
    const response = await this.options.client.publicationRequest(context, operation, id, body);
    this.assert(context);
    return response;
  }
  private async sourceView(key: string) {
    const view = await this.options.refresh();
    if (view.error) throw new ViewError(view.error.code, view.error.message);
    const s = view.snapshot;
    if (
      !s?.libraryId ||
      s.stateStatus !== 'read_only' ||
      s.warnings.some((w) =>
        ['deletion_recovery_required', 'drafts_unavailable', 'comments_unavailable'].includes(
          w.code,
        ),
      )
    )
      fail('mobile_publication_source', '라이브러리와 저장된 본문·댓글 정보를 확인하세요.');
    const post = s.posts.find((p) => p.key === key);
    if (!post)
      fail('mobile_publication_source', '등록 글을 찾을 수 없습니다. 목록을 새로고침하세요.');
    this.operationSource = { libraryId: s.libraryId!, key };
    return { snapshot: s, post };
  }
  private async list(context: ServiceBusinessContext, libraryId: string, key: string) {
    const rows = parsePublications(
      await this.request(context, 'list', undefined, { libraryId, postKey: key }),
    );
    if (rows.some((p) => p.source.libraryId !== libraryId || p.source.postKey !== key))
      fail('INVALID_RESPONSE', '다른 게시글의 응답을 받았습니다.');
    return rows;
  }
  private async stateFor(
    context: ServiceBusinessContext,
    libraryId: string,
    key: string,
  ): Promise<MobilePublicationsResult> {
    const rows = await this.list(context, libraryId, key);
    const journal = await this.journal();
    const matching = journal.pending.filter(
      (e) =>
        this.scoped(e, context) &&
        e.request.source.libraryId === libraryId &&
        e.request.source.postKey === key,
    );
    const completed = matching.filter((e) =>
      rows.some((p) => {
        if (p.requestId !== e.request.requestId) return false;
        this.assertSamePublication(p, e.request);
        return terminal(p);
      }),
    );
    if (completed.length) {
      this.assert(context);
      await this.options.store.write({
        ...journal,
        pending: journal.pending.filter((e) => !completed.includes(e)),
      });
    }
    return result(
      rows,
      matching
        .filter((e) => !completed.includes(e))
        .map((e) => ({
          requestId: e.request.requestId,
          accountId: e.request.accountId,
          source: e.request.source,
        })),
    );
  }
  private async run(
    action: (context: ServiceBusinessContext) => Promise<MobilePublicationsResult>,
  ): Promise<MobilePublicationsResult> {
    if (this.running || this.options.localBusy())
      return {
        ...result(),
        status: 'error',
        problem: {
          code: 'mobile_publication_busy',
          message: '진행 중인 작업이 끝난 뒤 시도하세요.',
        },
      };
    this.running = true;
    this.operationSource = null;
    let context: ServiceBusinessContext | undefined;
    try {
      context = await this.options.client.getBusinessContext();
      return await action(context);
    } catch (error) {
      let state = result();
      const scope = this.operationSource as { libraryId: string; key: string } | null;
      if (context && scope) {
        try {
          state = await this.stateFor(context, scope.libraryId, scope.key);
        } catch {
          try {
            this.assert(context);
            const journal = await this.journal();
            state.pending = journal.pending
              .filter(
                (e) =>
                  this.scoped(e, context!) &&
                  e.request.source.libraryId === scope.libraryId &&
                  e.request.source.postKey === scope.key,
              )
              .map((e) => ({
                requestId: e.request.requestId,
                accountId: e.request.accountId,
                source: e.request.source,
              }));
          } catch {
            /* No state is exposed after an auth transition. */
          }
        }
      }
      return { ...state, status: 'error', problem: safeProblem(error) };
    } finally {
      this.running = false;
    }
  }
  get(input: unknown) {
    return this.run(async (context) => {
      if (!isObject(input) || !exactKeys(input, ['postKey']) || !postKey(input.postKey))
        return invalid();
      const { snapshot } = await this.sourceView(input.postKey);
      return this.stateFor(context, snapshot.libraryId!, input.postKey);
    });
  }
  private currentSource(libraryId: string, post: Post): PublicationRequest['source'] {
    if (!validPostDraft(post.draft))
      return fail('mobile_publication_source', '등록한 글을 먼저 저장하세요.');
    return {
      libraryId,
      postKey: post.key,
      draftCreatedAt: post.draft.createdAt,
      draftRevision: post.draft.revision,
      commentUpdatedAt: post.comment?.updatedAt ?? null,
    };
  }
  private async prepare(entry: PublicationRequest, directory: string) {
    const { snapshot, post } = await this.sourceView(entry.source.postKey);
    if (
      !sameSource(this.currentSource(snapshot.libraryId!, post), entry.source) ||
      post.draft!.caption !== entry.caption ||
      JSON.stringify(this.comment(post)) !== JSON.stringify(entry.comment)
    )
      fail(
        'mobile_publication_changed',
        '전송에 사용한 글이 변경되었습니다. 보류 전송을 취소한 뒤 새로 전송하세요.',
      );
    const issue = postDraftExportIssue(post);
    if (issue) fail('mobile_publication_media', issue);
    const files = await this.options.prepareMedia(snapshot.root, post.draft!.mediaIds, directory);
    if (files.length !== entry.media.length)
      fail('mobile_publication_media', '전송할 첨부 구성이 변경되었습니다.');
    for (const [i, file] of files.entries()) {
      const digest = await preparedFileDigest(file.path);
      const m = entry.media[i];
      if (
        digest.sha256 !== m.sha256 ||
        digest.size !== m.size ||
        file.contentType !== m.contentType ||
        file.kind !== m.kind
      )
        fail(
          'mobile_publication_media',
          '전송할 파일이 변경되었습니다. 보류 전송을 취소하고 다시 준비하세요.',
        );
    }
    const { snapshot: latest, post: current } = await this.sourceView(entry.source.postKey);
    if (
      !sameSource(this.currentSource(latest.libraryId!, current), entry.source) ||
      current.draft!.caption !== entry.caption ||
      JSON.stringify(this.comment(current)) !== JSON.stringify(entry.comment)
    )
      fail(
        'mobile_publication_changed',
        '파일 준비 중 글이 변경되었습니다. 보류 전송을 취소하고 다시 준비하세요.',
      );
    return files;
  }
  private comment(post: Post): PublicationRequest['comment'] {
    if (
      !post.comment ||
      ![post.comment.caption, post.comment.link].filter(Boolean).join('\n').trim()
    )
      return null;
    const text = [post.comment.caption, post.comment.link].filter(Boolean).join('\n');
    if ([...text].length > 500)
      fail('mobile_publication_text', '댓글과 링크는 합쳐서 500자 이내로 작성하세요.');
    return { caption: post.comment.caption, link: post.comment.link };
  }
  send(input: unknown) {
    return this.run(async (context) => {
      if (
        !isObject(input) ||
        !exactKeys(input, [
          'postKey',
          'expectedRevision',
          'expectedDraftCreatedAt',
          'expectedCommentUpdatedAt',
          'accountId',
        ]) ||
        !postKey(input.postKey) ||
        !validRevision(input.expectedRevision) ||
        !timestamp(input.expectedDraftCreatedAt) ||
        !(input.expectedCommentUpdatedAt === null || timestamp(input.expectedCommentUpdatedAt)) ||
        !validId(input.accountId)
      )
        return invalid();
      const expected = input as unknown as SendMobilePublicationInput;
      const { snapshot, post } = await this.sourceView(expected.postKey);
      const source = this.currentSource(snapshot.libraryId!, post);
      if (
        source.draftRevision !== expected.expectedRevision ||
        source.draftCreatedAt !== expected.expectedDraftCreatedAt ||
        source.commentUpdatedAt !== expected.expectedCommentUpdatedAt
      )
        fail(
          'mobile_publication_changed',
          '글이나 댓글이 변경되었습니다. 최신 내용을 확인한 뒤 전송하세요.',
        );
      if ([...post.draft!.caption].length > 500)
        fail('mobile_publication_text', '본문은 500자 이내로 작성하세요.');
      const issue = postDraftExportIssue(post);
      if (issue) fail('mobile_publication_media', issue);
      const journal = await this.journal();
      if (
        journal.pending.some(
          (e) =>
            this.scoped(e, context) &&
            e.request.source.libraryId === source.libraryId &&
            e.request.source.postKey === source.postKey,
        )
      )
        fail(
          'mobile_publication_pending',
          '이 글에 보류된 전송이 있습니다. 먼저 재시도하거나 취소하세요.',
        );
      const raw = await this.options.client.managedThreadsRequest(context, 'list');
      this.assert(context);
      if (!isObject(raw) || !Array.isArray(raw.accounts))
        return fail('INVALID_RESPONSE', '계정 목록을 확인하지 못했습니다.');
      const account = raw.accounts
        .map((a) => parseManagedAccount(a, context.ownerId))
        .find((a) => a.id === expected.accountId);
      if (!account) fail('mobile_publication_account', '본인이 등록한 게시 계정을 선택하세요.');
      const requestId = randomUUID();
      const directory = await publicationWorkDirectory(this.options.userData, requestId);
      try {
        const files = await this.options.prepareMedia(
          snapshot.root,
          post.draft!.mediaIds,
          directory,
        );
        const media: PublicationRequest['media'] = [];
        for (const [ordinal, file] of files.entries())
          media.push({
            id: randomUUID(),
            ordinal,
            kind: file.kind,
            contentType: file.contentType as PublicationRequest['media'][number]['contentType'],
            ...(await preparedFileDigest(file.path)),
          });
        const { snapshot: current, post: refreshed } = await this.sourceView(expected.postKey);
        if (
          !sameSource(this.currentSource(current.libraryId!, refreshed), source) ||
          refreshed.draft!.caption !== post.draft!.caption ||
          JSON.stringify(this.comment(refreshed)) !== JSON.stringify(this.comment(post))
        )
          fail('mobile_publication_changed', '준비 중 글이 변경되었습니다. 다시 확인하세요.');
        const request: PublicationRequest = {
          requestId,
          accountId: account.id,
          expectedLifecycleVersion: account.lifecycleVersion ?? 1,
          expectedOwnershipVersion: account.ownershipVersion ?? 1,
          source,
          caption: post.draft!.caption,
          comment: this.comment(post),
          media,
        };
        const entry = { service: this.options.service, ownerId: context.ownerId, request };
        this.assert(context);
        await this.options.store.write({ ...journal, pending: [...journal.pending, entry] });
        await this.transfer(context, entry, files);
        return this.stateFor(context, source.libraryId, source.postKey);
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    });
  }
  private assertSamePublication(p: MobilePublication, request: PublicationRequest) {
    if (
      p.requestId !== request.requestId ||
      p.accountId !== request.accountId ||
      !sameSource(p.source, request.source) ||
      p.caption !== request.caption ||
      JSON.stringify(p.comment) !== JSON.stringify(request.comment) ||
      JSON.stringify(p.media) !== JSON.stringify(request.media)
    )
      fail('INVALID_RESPONSE', '전송 요청과 서버에 저장된 게시본이 다릅니다.');
  }
  private async transfer(
    context: ServiceBusinessContext,
    entry: PublicationJournalEntry,
    files?: ThreadsUploadFile[],
  ) {
    const request = entry.request;
    let publication = parsePublicationResponse(
      await this.request(context, 'create', undefined, request),
    );
    this.assertSamePublication(publication, request);
    if (publication.status === 'ready') return;
    if (terminal(publication))
      fail(
        'mobile_publication_existing_state',
        '이 전송은 이미 취소·만료되었거나 게시가 시작되었습니다. 현재 이력을 확인하세요.',
      );
    if (!files) return fail('mobile_publication_media', '전송할 파일을 준비하지 못했습니다.');
    const urls = parseUploadUrls(
      await this.request(context, 'upload-urls', publication.id, {
        mediaIds: request.media.map((m) => m.id),
      }),
      request.media,
    );
    for (const [i, media] of request.media.entries()) {
      this.assert(context);
      await (this.options.upload ?? uploadPublicationFile)(
        files[i].path,
        media,
        urls.find((u) => u.mediaId === media.id)!,
        undefined,
        this.options.client.businessSignal(context),
      );
      this.assert(context);
    }
    publication = parsePublicationResponse(
      await this.request(context, 'complete', publication.id, {}),
    );
    this.assertSamePublication(publication, request);
    if (publication.status !== 'ready')
      fail(
        'mobile_publication_not_ready',
        '첨부 확인이 끝나지 않았습니다. 같은 전송을 다시 확인하세요.',
      );
  }
  retry(input: unknown) {
    return this.run(async (context) => {
      if (!isObject(input) || !exactKeys(input, ['requestId']) || !uuid(input.requestId))
        return invalid();
      const journal = await this.journal();
      const entry = journal.pending.find(
        (e) => this.scoped(e, context) && e.request.requestId === input.requestId,
      );
      if (!entry) fail('mobile_publication_pending', '현재 사용자의 보류 전송을 찾을 수 없습니다.');
      this.operationSource = {
        libraryId: entry.request.source.libraryId,
        key: entry.request.source.postKey,
      };
      const rows = await this.list(
        context,
        entry.request.source.libraryId,
        entry.request.source.postKey,
      );
      const existing = rows.find((p) => p.requestId === entry.request.requestId);
      if (existing) {
        this.assertSamePublication(existing, entry.request);
        if (existing.status === 'ready')
          return this.stateFor(
            context,
            entry.request.source.libraryId,
            entry.request.source.postKey,
          );
        if (terminal(existing))
          fail(
            'mobile_publication_existing_state',
            '이 전송은 이미 취소·만료되었거나 게시가 시작되었습니다. 현재 이력을 확인하세요.',
          );
      }
      const directory = await publicationWorkDirectory(
        this.options.userData,
        entry.request.requestId,
      );
      try {
        await this.transfer(context, entry, await this.prepare(entry.request, directory));
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
      return this.stateFor(context, entry.request.source.libraryId, entry.request.source.postKey);
    });
  }
  cancelPending(input: unknown) {
    return this.run(async (context) => {
      if (!isObject(input) || !exactKeys(input, ['requestId']) || !uuid(input.requestId))
        return invalid();
      const journal = await this.journal();
      const entry = journal.pending.find(
        (e) => this.scoped(e, context) && e.request.requestId === input.requestId,
      );
      if (!entry) fail('mobile_publication_pending', '현재 사용자의 보류 전송을 찾을 수 없습니다.');
      this.operationSource = {
        libraryId: entry.request.source.libraryId,
        key: entry.request.source.postKey,
      };
      const response = await this.request(context, 'cancel-request', input.requestId, {});
      if (!isObject(response) || response.requestCancelled !== true)
        fail('INVALID_RESPONSE', '전송 취소 결과를 확인하지 못했습니다.');
      if (response.publication !== null) {
        const publication = parsePublicationResponse(response);
        this.assertSamePublication(publication, entry.request);
        if (publication.status !== 'cancelled' && publication.status !== 'expired')
          fail('INVALID_RESPONSE', '게시 대기가 취소되지 않았습니다.');
      }
      this.assert(context);
      await this.options.store.write({
        ...journal,
        pending: journal.pending.filter((e) => e !== entry),
      });
      return this.stateFor(context, entry.request.source.libraryId, entry.request.source.postKey);
    });
  }
  recall(input: unknown) {
    return this.run(async (context) => {
      if (
        !isObject(input) ||
        !exactKeys(input, ['publicationId', 'expectedVersion']) ||
        !uuid(input.publicationId) ||
        !validRevision(input.expectedVersion)
      )
        return invalid();
      const before = parsePublicationResponse(
        await this.request(context, 'get', input.publicationId),
      );
      this.operationSource = { libraryId: before.source.libraryId, key: before.source.postKey };
      if (before.id !== input.publicationId)
        fail('INVALID_RESPONSE', '게시 대기 연결을 확인하지 못했습니다.');
      const publication = parsePublicationResponse(
        await this.request(context, 'recall', input.publicationId, {
          expectedVersion: input.expectedVersion,
        }),
      );
      if (publication.id !== before.id || publication.status !== 'cancelled')
        fail('INVALID_RESPONSE', '회수 결과를 확인하지 못했습니다.');
      return this.stateFor(context, before.source.libraryId, before.source.postKey);
    });
  }

  /** Called inside the existing local save lock, immediately before its worker starts. */
  async requireEditable(libraryId: string, key: string): Promise<void> {
    if (this.running) fail('mobile_publication_busy', '게시 대기 전송이 끝난 뒤 수정하세요.');
    this.running = true;
    try {
      const context = await this.options.client.getBusinessContext();
      const journal = await this.journal();
      if (
        journal.pending.some(
          (e) =>
            this.scoped(e, context) &&
            e.request.source.libraryId === libraryId &&
            e.request.source.postKey === key,
        )
      )
        fail('mobile_publication_pending', '보류된 전송을 재시도하거나 취소한 뒤 수정하세요.');
      const response = await this.request(context, 'source-state', undefined, {
        libraryId,
        postKey: key,
      });
      if (!isObject(response) || typeof response.editable !== 'boolean')
        fail('INVALID_RESPONSE', '게시 대기 상태를 확인하지 못했습니다.');
      if (!response.editable)
        fail(
          'mobile_publication_recall_required',
          '모바일 게시 대기 글을 먼저 회수한 뒤 수정하세요.',
        );
    } finally {
      this.running = false;
    }
  }
  /** Run only after the user's existing local delete confirmation, before local deletion. */
  async beforeDelete(libraryId: string, post: Post): Promise<void> {
    if (!post.draft) return;
    if (this.running) fail('mobile_publication_busy', '게시 대기 전송이 끝난 뒤 삭제하세요.');
    this.running = true;
    try {
      const context = await this.options.client.getBusinessContext();
      const source = { libraryId, postKey: post.key, draftCreatedAt: post.draft.createdAt };
      let journal = await this.journal();
      let deletion = journal.deletions.find(
        (e) => this.scoped(e, context) && JSON.stringify(e.source) === JSON.stringify(source),
      );
      if (!deletion) {
        const state = await this.request(context, 'source-state', undefined, {
          libraryId,
          postKey: post.key,
        });
        if (
          !isObject(state) ||
          typeof state.sourceVersion !== 'number' ||
          !Number.isSafeInteger(state.sourceVersion) ||
          state.sourceVersion < 0
        )
          fail('INVALID_RESPONSE', '게시 대기 삭제 버전을 확인하지 못했습니다.');
        deletion = {
          service: this.options.service,
          ownerId: context.ownerId,
          requestId: randomUUID(),
          source,
          expectedSourceVersion: state.sourceVersion,
        };
        journal = { ...journal, deletions: [...journal.deletions, deletion] };
        this.assert(context);
        await this.options.store.write(journal);
      }
      let response: unknown;
      try {
        response = await this.request(context, 'source-deletions', undefined, {
          requestId: deletion.requestId,
          source: deletion.source,
          expectedSourceVersion: deletion.expectedSourceVersion,
        });
      } catch (error) {
        if (
          error instanceof ServiceApiError &&
          error.status === 409 &&
          ['SOURCE_CHANGED', 'SOURCE_VERSION_CONFLICT', 'STALE_SOURCE'].includes(error.code)
        ) {
          this.assert(context);
          await this.options.store.write({
            ...journal,
            deletions: journal.deletions.filter((e) => e !== deletion),
          });
        }
        throw error;
      }
      if (
        !isObject(response) ||
        !isObject(response.deletion) ||
        response.deletion.requestId !== deletion.requestId ||
        JSON.stringify(response.deletion.source) !== JSON.stringify(source) ||
        !timestamp(response.deletion.completedAt) ||
        !Array.isArray(response.deletion.cancelledIds) ||
        !response.deletion.cancelledIds.every(uuid) ||
        !Array.isArray(response.deletion.preservedIds) ||
        !response.deletion.preservedIds.every(uuid)
      )
        fail('INVALID_RESPONSE', '게시 대기 취소를 확인하지 못해 로컬 삭제를 진행하지 않았습니다.');
      // Keep the receipt id for a local-worker retry; clear only its now cancelled
      // pending uploads. Started/published remote snapshots remain on the server.
      this.assert(context);
      await this.options.store.write({
        ...journal,
        pending: journal.pending.filter(
          (e) =>
            !(
              this.scoped(e, context) &&
              e.request.source.libraryId === libraryId &&
              e.request.source.postKey === post.key &&
              e.request.source.draftCreatedAt === source.draftCreatedAt
            ),
        ),
      });
    } finally {
      this.running = false;
    }
  }
  /** A committed local worker no longer needs the durable server deletion receipt. */
  async afterDelete(libraryId: string, post: Post): Promise<void> {
    if (!post.draft) return;
    const context = await this.options.client.getBusinessContext();
    const journal = await this.journal();
    this.assert(context);
    await this.options.store.write({
      ...journal,
      deletions: journal.deletions.filter(
        (e) =>
          !(
            this.scoped(e, context) &&
            e.source.libraryId === libraryId &&
            e.source.postKey === post.key &&
            e.source.draftCreatedAt === post.draft!.createdAt
          ),
      ),
    });
  }
}
