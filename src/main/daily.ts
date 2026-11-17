import { randomUUID } from 'node:crypto';
import type { CaptionLanguage } from '../shared/contracts';
import {
  DAILY_DESCRIPTION_LIMIT,
  DAILY_NAME_LIMIT,
  type DailyDraft,
  type DailyPersona,
  type DailyPost,
  type DailyResult,
  type DailyView,
  type DailyWaitingNote,
} from '../shared/daily';
import type { MobilePublication } from '../shared/mobile-publications';
import { ViewError } from './collection';
import {
  DAILY_LIBRARY_ID,
  validDailyText,
  validDailyTranslation,
  type DailyPartition,
  type DailyScope,
  type StoredDailyPost,
} from './daily-store';
import { exactKeys, isObject, parseManagedAccount, validId } from './managed-threads-store';
import {
  parsePublicationResponse,
  parsePublications,
  uuid,
  type PublicationRequest,
} from './mobile-publication-data';
import { ServiceApiError, type ServiceApiClient, type ServiceBusinessContext } from './service-api';

type Client = Pick<
  ServiceApiClient,
  'getBusinessContext' | 'assertBusinessContext' | 'publicationRequest' | 'managedThreadsRequest'
>;
interface Store {
  read(scope: DailyScope): Promise<DailyPartition>;
  update<T>(scope: DailyScope, change: (partition: DailyPartition) => T): Promise<T>;
}
interface Options {
  client: Client;
  store: Store;
  service: string;
  /** Writes three posts for the persona. Throws a ViewError the user can read. */
  generate(persona: DailyPersona, recentPosts: string[]): Promise<DailyDraft[]>;
  /** Says in Korean what one post of the persona says. Throws a ViewError the user can read. */
  translate(persona: DailyPersona, text: string): Promise<string>;
  /** Writes a Korean draft as a post in the persona's language. Throws a readable ViewError. */
  compose(persona: DailyPersona, korean: string): Promise<string>;
  now?: () => Date;
}
/** What the server last said about one send. Memory only; rebuilt by `state()`. */
interface Remote {
  requestId: string;
  note: DailyWaitingNote | null;
  started: boolean;
}

const RECENT_POSTS = 30;
const LANGUAGES: CaptionLanguage[] = ['ko', 'ja', 'en'];
const EMPTY: DailyView = {
  personas: [],
  posts: [],
  generatingPersonaId: null,
  translatingPostId: null,
};

function fail(code: string, message: string): never {
  throw new ViewError(code, message);
}
const invalid = (): never => fail('daily_input', '입력한 내용을 확인해 주세요.');
const safeProblem = (error: unknown) =>
  error instanceof ViewError || error instanceof ServiceApiError
    ? { code: error.code, message: error.message }
    : { code: 'daily_failed', message: '일상 글 작업을 끝내지 못했습니다. 다시 시도해 주세요.' };

/** A send of this PC that must not stay postable once another send of the post is published. */
interface Leftover {
  requestId: string;
  row: { id: string; version: number } | null;
}
type Verdict =
  | { kind: 'published'; sentAt: string | null; leftover: Leftover | null }
  | { kind: 'draft' }
  | { kind: 'waiting'; sentAt: string | null; note: DailyWaitingNote | null; started: boolean }
  | { kind: 'unchanged' };

/** Reads the server's publications of one post. The server, not this PC, decides the state. */
export function dailyVerdict(post: StoredDailyPost, rows: MobilePublication[]): Verdict {
  // A cancelled send that the phone posted anyway still ends as a published root.
  const published = rows.find((row) => row.rootStatus === 'published');
  const row = post.send
    ? rows.find((item) => item.requestId === post.send!.request.requestId)
    : undefined;
  if (published) {
    // The post was sent again after a cancel, and the cancelled send was the one posted.
    const leftover =
      post.send && row?.id !== published.id && (!row || row.rootStatus === 'queued')
        ? {
            requestId: post.send.request.requestId,
            row: row ? { id: row.id, version: row.version } : null,
          }
        : null;
    return { kind: 'published', sentAt: published.sentAt, leftover };
  }
  if (!post.send) return { kind: 'unchanged' };
  if (!row || row.status === 'uploading')
    return { kind: 'waiting', sentAt: null, note: 'unconfirmed', started: false };
  if (row.status === 'cancelled') return { kind: 'draft' };
  if (row.status === 'started')
    return {
      kind: 'waiting',
      sentAt: row.sentAt,
      note: row.rootStatus === 'failed' ? 'failed' : 'check_phone',
      started: true,
    };
  return {
    kind: 'waiting',
    sentAt: row.sentAt,
    note: row.status === 'expired' ? 'expired' : null,
    started: false,
  };
}

export class DailyController {
  private mutating = false;
  private generatingPersonaId: string | null = null;
  private translatingPostId: string | null = null;
  private composing = false;
  private readonly remote = new Map<string, Remote>();
  constructor(private readonly options: Options) {}
  /** A send, cancel or save is talking to the server or the file. */
  get busy(): boolean {
    return this.mutating;
  }
  /** ChatGPT is writing: posts, a Korean rendering, or a post from a Korean draft. */
  get generating(): boolean {
    return this.generatingPersonaId !== null || this.translatingPostId !== null || this.composing;
  }
  get active(): boolean {
    return this.mutating || this.generating;
  }
  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
  private scope(context: ServiceBusinessContext): DailyScope {
    return { service: this.options.service, ownerId: context.ownerId };
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
  private async list(context: ServiceBusinessContext, postId: string) {
    const rows = parsePublications(
      await this.request(context, 'list', undefined, {
        libraryId: DAILY_LIBRARY_ID,
        postKey: postId,
      }),
      0,
    );
    if (
      rows.some(
        (row) =>
          row.source.libraryId !== DAILY_LIBRARY_ID ||
          row.source.postKey !== postId ||
          row.media.length ||
          row.comment,
      )
    )
      fail('INVALID_RESPONSE', '다른 글의 응답을 받았습니다.');
    return rows;
  }
  private async accounts(context: ServiceBusinessContext) {
    const raw = await this.options.client.managedThreadsRequest(context, 'list');
    this.assert(context);
    if (!isObject(raw) || !Array.isArray(raw.accounts))
      return fail('INVALID_RESPONSE', '계정 목록을 확인하지 못했습니다.');
    try {
      return raw.accounts.map((account) => parseManagedAccount(account, context.ownerId));
    } catch {
      return fail('INVALID_RESPONSE', '계정 목록을 확인하지 못했습니다.');
    }
  }
  private view(partition: DailyPartition): DailyView {
    return {
      personas: partition.personas.map((persona) => ({
        id: persona.id,
        name: persona.name,
        accountId: persona.accountId,
        language: persona.language,
        description: persona.description,
        createdAt: persona.createdAt,
      })),
      posts: partition.posts.map((post): DailyPost => {
        const base = {
          id: post.id,
          personaId: post.personaId,
          text: post.text,
          translation: post.translation ?? null,
          createdAt: post.createdAt,
        };
        if (post.published)
          return {
            ...base,
            state: 'published',
            note: null,
            started: false,
            sentAt: post.published.sentAt,
          };
        if (!post.send)
          return { ...base, state: 'draft', note: null, started: false, sentAt: null };
        const remote = this.remote.get(post.id);
        const known = remote?.requestId === post.send.request.requestId ? remote : null;
        return {
          ...base,
          state: 'waiting',
          note: known ? known.note : post.send.confirmed ? null : 'unconfirmed',
          started: known?.started ?? false,
          sentAt: post.send.sentAt,
        };
      }),
      generatingPersonaId: this.generatingPersonaId,
      translatingPostId: this.translatingPostId,
    };
  }
  /** Writes one server verdict into the stored post. The post may have changed meanwhile. */
  private static apply(post: StoredDailyPost, requestId: string | null, verdict: Verdict) {
    if (verdict.kind === 'published') {
      post.published = { sentAt: verdict.sentAt };
      post.send = null;
      post.sentBefore = false;
      return;
    }
    if (!post.send || post.send.request.requestId !== requestId) return;
    if (verdict.kind === 'draft') {
      post.send = null;
      post.sentBefore = true;
    } else if (verdict.kind === 'waiting' && verdict.note !== 'unconfirmed') {
      post.send.confirmed = true;
      post.send.sentAt = verdict.sentAt;
    }
  }
  private remember(post: StoredDailyPost, verdict: Verdict) {
    if (verdict.kind === 'waiting' && post.send)
      this.remote.set(post.id, {
        requestId: post.send.request.requestId,
        note: verdict.note,
        started: verdict.started,
      });
    else if (verdict.kind !== 'unchanged') this.remote.delete(post.id);
  }
  /**
   * The post is already on Threads through another send, so the send this PC still holds is
   * withdrawn. Best effort: if the phone has started it too, nothing here can stop it.
   */
  private async withdraw(context: ServiceBusinessContext, verdict: Verdict) {
    if (verdict.kind !== 'published' || !verdict.leftover) return;
    const { requestId, row } = verdict.leftover;
    try {
      if (row) await this.request(context, 'recall', row.id, { expectedVersion: row.version });
      else await this.request(context, 'cancel-request', requestId, {});
    } catch (error) {
      if (!(error instanceof ServiceApiError) || error.status < 400 || error.status >= 500)
        throw error;
    }
  }
  /** Asks the server about every post whose outcome is still open. */
  private async refresh(context: ServiceBusinessContext): Promise<DailyPartition> {
    const scope = this.scope(context);
    const before = await this.options.store.read(scope);
    const open = before.posts.filter((post) => !post.published && (post.send || post.sentBefore));
    const verdicts: { id: string; requestId: string | null; verdict: Verdict }[] = [];
    for (const post of open) {
      const verdict = dailyVerdict(post, await this.list(context, post.id));
      await this.withdraw(context, verdict);
      this.remember(post, verdict);
      verdicts.push({ id: post.id, requestId: post.send?.request.requestId ?? null, verdict });
    }
    if (!verdicts.some((item) => item.verdict.kind !== 'unchanged')) return before;
    this.assert(context);
    return this.options.store.update(scope, (partition) => {
      for (const item of verdicts) {
        const post = partition.posts.find((candidate) => candidate.id === item.id);
        if (post && !post.published) DailyController.apply(post, item.requestId, item.verdict);
      }
      return partition;
    });
  }
  /** Runs one action and always answers with the best view that can still be read. */
  private async respond(
    action: (context: ServiceBusinessContext) => Promise<DailyPartition>,
  ): Promise<DailyResult> {
    let context: ServiceBusinessContext | undefined;
    try {
      context = await this.options.client.getBusinessContext();
      return { status: 'ok', view: this.view(await action(context)), problem: null };
    } catch (error) {
      let view = EMPTY;
      if (context)
        try {
          this.assert(context);
          view = this.view(await this.options.store.read(this.scope(context)));
        } catch {
          /* No data is shown after an auth change or when the file cannot be read. */
        }
      return { status: 'error', view, problem: safeProblem(error) };
    }
  }
  private mutate(action: (context: ServiceBusinessContext) => Promise<DailyPartition>) {
    if (this.mutating)
      return this.respond(() => fail('daily_busy', '진행 중인 작업이 끝난 뒤 시도하세요.'));
    this.mutating = true;
    return this.respond(action).finally(() => {
      this.mutating = false;
    });
  }

  state(): Promise<DailyResult> {
    return this.respond((context) => this.refresh(context));
  }

  savePersona(input: unknown): Promise<DailyResult> {
    return this.mutate(async (context) => {
      if (
        !isObject(input) ||
        !exactKeys(input, [
          'name',
          'accountId',
          'language',
          'description',
          ...(input.personaId === undefined ? [] : ['personaId']),
        ]) ||
        (input.personaId !== undefined && !uuid(input.personaId)) ||
        typeof input.name !== 'string' ||
        typeof input.description !== 'string' ||
        !validId(input.accountId) ||
        !LANGUAGES.includes(input.language as CaptionLanguage)
      )
        return invalid();
      const name = input.name.trim();
      const description = input.description.trim();
      if (!name || name.length > DAILY_NAME_LIMIT)
        fail('daily_persona_name', `페르소나 이름을 ${DAILY_NAME_LIMIT}자 이내로 입력하세요.`);
      if (!description || description.length > DAILY_DESCRIPTION_LIMIT)
        fail(
          'daily_persona_description',
          `페르소나 설명을 ${DAILY_DESCRIPTION_LIMIT}자 이내로 입력하세요.`,
        );
      const accountId = input.accountId;
      const language = input.language as CaptionLanguage;
      const personaId = input.personaId as string | undefined;
      const accounts = await this.accounts(context);
      if (!accounts.some((account) => account.id === accountId))
        fail('daily_account', '본인이 등록한 게시 계정을 선택하세요.');
      const createdAt = this.now();
      return this.options.store.update(this.scope(context), (partition) => {
        if (partition.personas.some((p) => p.accountId === accountId && p.id !== personaId))
          fail('daily_account_taken', '다른 페르소나가 이미 쓰고 있는 계정입니다.');
        if (!personaId) {
          partition.personas.push({
            id: randomUUID(),
            name,
            accountId,
            language,
            description,
            createdAt,
          });
          return partition;
        }
        const persona = partition.personas.find((p) => p.id === personaId);
        if (!persona) return fail('daily_persona', '페르소나를 찾을 수 없습니다.');
        if (
          persona.accountId !== accountId &&
          partition.posts.some((post) => post.personaId === personaId) &&
          accounts.some((account) => account.id === persona.accountId)
        )
          fail('daily_account_locked', '글이 있는 페르소나는 연동 계정을 바꿀 수 없습니다.');
        Object.assign(persona, { name, accountId, language, description });
        return partition;
      });
    });
  }

  deletePersona(input: unknown): Promise<DailyResult> {
    return this.mutate(async (context) => {
      if (!isObject(input) || !exactKeys(input, ['personaId']) || !uuid(input.personaId))
        return invalid();
      const personaId = input.personaId;
      if (this.generatingPersonaId === personaId)
        fail('daily_busy', '글 생성이 끝난 뒤 삭제하세요.');
      return this.options.store.update(this.scope(context), (partition) => {
        if (!partition.personas.some((p) => p.id === personaId))
          fail('daily_persona', '페르소나를 찾을 수 없습니다.');
        if (partition.posts.some((post) => post.personaId === personaId && post.send))
          fail('daily_persona_waiting', '휴대폰 대기 중인 글을 먼저 취소하세요.');
        partition.personas = partition.personas.filter((p) => p.id !== personaId);
        partition.posts = partition.posts.filter((post) => post.personaId !== personaId);
        return partition;
      });
    });
  }

  /** Long-running, so it does not hold the mutation lock. One generation at a time. */
  async generate(input: unknown): Promise<DailyResult> {
    if (this.generating)
      return this.respond(() => fail('daily_busy', '진행 중인 글 생성이 끝난 뒤 시도하세요.'));
    if (!isObject(input) || !exactKeys(input, ['personaId']) || !uuid(input.personaId))
      return this.respond(invalid);
    const personaId = input.personaId;
    this.generatingPersonaId = personaId;
    try {
      return await this.respond(async (context) => {
        const scope = this.scope(context);
        let drafts: DailyDraft[];
        try {
          const before = await this.options.store.read(scope);
          const persona = before.personas.find((p) => p.id === personaId);
          if (!persona) return fail('daily_persona', '페르소나를 찾을 수 없습니다.');
          const recent = before.posts
            .filter((post) => post.personaId === personaId)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, RECENT_POSTS)
            .map((post) => post.text);
          drafts = await this.options.generate(persona, recent);
        } finally {
          // Every view built from here on, for success or failure, shows the work as over.
          this.generatingPersonaId = null;
        }
        this.assert(context);
        if (
          !drafts.length ||
          !drafts.every(
            (draft) =>
              validDailyText(draft.text) &&
              (draft.translation === null || validDailyTranslation(draft.translation)),
          )
        )
          fail('daily_generation', '생성된 글의 형식을 확인하지 못했습니다. 다시 시도하세요.');
        const createdAt = this.now();
        return this.options.store.update(scope, (partition) => {
          if (!partition.personas.some((p) => p.id === personaId))
            fail('daily_persona', '페르소나를 찾을 수 없습니다.');
          for (const draft of drafts)
            partition.posts.push({
              id: randomUUID(),
              personaId,
              text: draft.text,
              translation: draft.translation,
              createdAt,
              send: null,
              sentBefore: false,
              published: null,
            });
          return partition;
        });
      });
    } finally {
      this.generatingPersonaId = null;
    }
  }

  /**
   * Adds a draft the user wrote. A Korean draft for a persona of another language is written in
   * that language first (long-running like `generate`) and kept as the post's Korean rendering.
   */
  async addPost(input: unknown): Promise<DailyResult> {
    if (
      !isObject(input) ||
      !exactKeys(input, ['personaId', 'text', 'fromKorean']) ||
      !uuid(input.personaId) ||
      typeof input.text !== 'string' ||
      typeof input.fromKorean !== 'boolean'
    )
      return this.respond(invalid);
    if (this.generating)
      return this.respond(() => fail('daily_busy', '진행 중인 글 생성이 끝난 뒤 시도하세요.'));
    const personaId = input.personaId;
    const written = input.text.trim();
    const add = (scope: DailyScope, text: string, translation: string | null) => {
      const createdAt = this.now();
      return this.options.store.update(scope, (partition) => {
        if (!partition.personas.some((p) => p.id === personaId))
          fail('daily_persona', '페르소나를 찾을 수 없습니다.');
        partition.posts.push({
          id: randomUUID(),
          personaId,
          text,
          translation,
          createdAt,
          send: null,
          sentBefore: false,
          published: null,
        });
        return partition;
      });
    };
    if (!input.fromKorean)
      return this.mutate(async (context) => {
        if (!validDailyText(written)) fail('daily_text', '본문은 1~500자로 작성하세요.');
        return add(this.scope(context), written, null);
      });
    this.composing = true;
    try {
      return await this.respond(async (context) => {
        const scope = this.scope(context);
        let text: string;
        try {
          if (!validDailyText(written)) fail('daily_text', '본문은 1~500자로 작성하세요.');
          const before = await this.options.store.read(scope);
          const persona = before.personas.find((p) => p.id === personaId);
          if (!persona) return fail('daily_persona', '페르소나를 찾을 수 없습니다.');
          if (persona.language === 'ko') return invalid();
          text = await this.options.compose(persona, written);
        } finally {
          this.composing = false;
        }
        this.assert(context);
        if (!validDailyText(text))
          fail('daily_generation', '바꾼 글의 형식을 확인하지 못했습니다. 다시 시도하세요.');
        return add(scope, text, written);
      });
    } finally {
      this.composing = false;
    }
  }

  savePost(input: unknown): Promise<DailyResult> {
    return this.mutate(async (context) => {
      if (
        !isObject(input) ||
        !exactKeys(input, ['postId', 'text']) ||
        !uuid(input.postId) ||
        typeof input.text !== 'string'
      )
        return invalid();
      // Nothing is edited while ChatGPT writes; the board does not open the editor either.
      if (this.generating) fail('daily_busy', '글 생성이 끝난 뒤 수정하세요.');
      const text = input.text.trim();
      if (!validDailyText(text)) fail('daily_text', '본문은 1~500자로 작성하세요.');
      const postId = input.postId;
      return this.options.store.update(this.scope(context), (partition) => {
        const post = partition.posts.find((item) => item.id === postId);
        if (!post) return fail('daily_post', '글을 찾을 수 없습니다.');
        if (post.send || post.published) fail('daily_post_sent', '초안만 수정할 수 있습니다.');
        // The Korean rendering described the old text; an edited post no longer has one.
        if (post.text !== text) post.translation = null;
        post.text = text;
        return partition;
      });
    });
  }

  /**
   * Writes the Korean rendering of a post in another language: after an edit dropped the old
   * one, or for a post made before renderings existed. Long-running like `generate`.
   */
  async translatePost(input: unknown): Promise<DailyResult> {
    if (this.generating)
      return this.respond(() => fail('daily_busy', '진행 중인 글 생성이 끝난 뒤 시도하세요.'));
    if (!isObject(input) || !exactKeys(input, ['postId']) || !uuid(input.postId))
      return this.respond(invalid);
    const postId = input.postId;
    this.translatingPostId = postId;
    try {
      return await this.respond(async (context) => {
        const scope = this.scope(context);
        let text: string;
        let translation: string;
        try {
          const before = await this.options.store.read(scope);
          const post = before.posts.find((item) => item.id === postId);
          if (!post) return fail('daily_post', '글을 찾을 수 없습니다.');
          const persona = before.personas.find((p) => p.id === post.personaId);
          if (!persona || persona.language === 'ko') return invalid();
          text = post.text;
          translation = await this.options.translate(persona, text);
        } finally {
          // Every view built from here on, for success or failure, shows the work as over.
          this.translatingPostId = null;
        }
        this.assert(context);
        if (!validDailyTranslation(translation))
          fail('daily_generation', '한국어 뜻의 형식을 확인하지 못했습니다. 다시 시도하세요.');
        return this.options.store.update(scope, (partition) => {
          const post = partition.posts.find((item) => item.id === postId);
          // A post edited or deleted meanwhile does not get the rendering of its old text.
          if (post && post.text === text) post.translation = translation;
          return partition;
        });
      });
    } finally {
      this.translatingPostId = null;
    }
  }

  deletePost(input: unknown): Promise<DailyResult> {
    return this.mutate(async (context) => {
      if (!isObject(input) || !exactKeys(input, ['postId']) || !uuid(input.postId))
        return invalid();
      const postId = input.postId;
      return this.options.store.update(this.scope(context), (partition) => {
        const post = partition.posts.find((item) => item.id === postId);
        if (!post) return fail('daily_post', '글을 찾을 수 없습니다.');
        if (post.send || post.published) fail('daily_post_sent', '초안만 삭제할 수 있습니다.');
        partition.posts = partition.posts.filter((item) => item.id !== postId);
        return partition;
      });
    });
  }

  send(input: unknown): Promise<DailyResult> {
    return this.mutate(async (context) => {
      if (!isObject(input) || !exactKeys(input, ['postId']) || !uuid(input.postId))
        return invalid();
      const postId = input.postId;
      const scope = this.scope(context);
      const before = await this.options.store.read(scope);
      const current = before.posts.find((item) => item.id === postId);
      if (!current) return fail('daily_post', '글을 찾을 수 없습니다.');
      if (current.published) fail('daily_post_sent', '이미 등록된 글입니다.');
      let request = current.send?.request;
      if (!request && current.sentBefore) {
        // The phone may have posted a cancelled send after all. Never send that post again.
        const earlier = dailyVerdict(current, await this.list(context, postId));
        if (earlier.kind === 'published') {
          this.assert(context);
          await this.options.store.update(scope, (partition) => {
            const post = partition.posts.find((item) => item.id === postId);
            if (post && !post.published) DailyController.apply(post, null, earlier);
          });
          fail(
            'daily_post_sent',
            '취소했던 전송이 이미 Threads에 등록되어 다시 보내지 않았습니다.',
          );
        }
      }
      if (!request) {
        const persona = before.personas.find((p) => p.id === current.personaId);
        const account = (await this.accounts(context)).find((a) => a.id === persona?.accountId);
        if (!persona || !account)
          return fail(
            'daily_account',
            '연동된 게시 계정을 찾을 수 없습니다. 페르소나 설정에서 계정을 다시 연동하세요.',
          );
        const created: PublicationRequest = {
          requestId: randomUUID(),
          accountId: account.id,
          expectedLifecycleVersion: account.lifecycleVersion ?? 1,
          expectedOwnershipVersion: account.ownershipVersion ?? 1,
          source: {
            libraryId: DAILY_LIBRARY_ID,
            postKey: postId,
            draftCreatedAt: this.now(),
            draftRevision: 1,
            commentUpdatedAt: null,
          },
          caption: current.text,
          comment: null,
          media: [],
        };
        request = created;
        // The whole request is saved before the network call so a retry can repeat it exactly.
        this.assert(context);
        await this.options.store.update(scope, (partition) => {
          const post = partition.posts.find((item) => item.id === postId);
          if (!post || post.send || post.published || post.text !== created.caption)
            fail('daily_post_changed', '보내는 중 글이 변경되었습니다. 다시 확인하세요.');
          post!.send = { request: created, confirmed: false, sentAt: null };
        });
      }
      const sent = request;
      const publication = parsePublicationResponse(
        await this.request(context, 'create', undefined, sent),
        0,
      );
      if (
        publication.requestId !== sent.requestId ||
        publication.accountId !== sent.accountId ||
        publication.caption !== sent.caption ||
        JSON.stringify(publication.source) !== JSON.stringify(sent.source) ||
        publication.comment ||
        publication.media.length
      )
        fail('INVALID_RESPONSE', '전송 요청과 서버에 저장된 글이 다릅니다.');
      this.assert(context);
      await this.options.store.update(scope, (partition) => {
        const post = partition.posts.find((item) => item.id === postId);
        if (post?.send?.request.requestId === sent.requestId) {
          post.send.confirmed = true;
          post.send.sentAt = publication.sentAt;
        }
      });
      return this.refresh(context);
    });
  }

  cancelSend(input: unknown): Promise<DailyResult> {
    return this.mutate(async (context) => {
      if (
        !isObject(input) ||
        !exactKeys(input, ['postId', ...(input.abandon === undefined ? [] : ['abandon'])]) ||
        !uuid(input.postId) ||
        (input.abandon !== undefined && input.abandon !== true)
      )
        return invalid();
      const postId = input.postId;
      const scope = this.scope(context);
      const before = await this.options.store.read(scope);
      const current = before.posts.find((item) => item.id === postId);
      if (!current?.send) return fail('daily_post', '취소할 전송을 찾을 수 없습니다.');
      const requestId = current.send.request.requestId;
      const rows = await this.list(context, postId);
      const verdict = dailyVerdict(current, rows);
      const finish = async (result: Verdict, problem?: ViewError) => {
        await this.withdraw(context, result);
        this.remember(current, result);
        this.assert(context);
        const partition = await this.options.store.update(scope, (stored) => {
          const post = stored.posts.find((item) => item.id === postId);
          if (post && !post.published) DailyController.apply(post, requestId, result);
          return stored;
        });
        if (problem) throw problem;
        return partition;
      };
      if (verdict.kind === 'published')
        return finish(
          verdict,
          new ViewError('daily_post_sent', '이미 Threads에 등록된 글이라 취소할 수 없습니다.'),
        );
      if (verdict.kind === 'draft') return finish(verdict);
      const row = rows.find((item) => item.requestId === requestId);
      if (!row) {
        const response = await this.request(context, 'cancel-request', requestId, {});
        if (!isObject(response) || response.requestCancelled !== true)
          fail('INVALID_RESPONSE', '전송 취소 결과를 확인하지 못했습니다.');
        if (response.publication !== null) {
          const late = parsePublicationResponse(response, 0);
          if (late.status !== 'cancelled' && late.status !== 'expired')
            fail('INVALID_RESPONSE', '전송이 취소되지 않았습니다.');
        }
        return finish({ kind: 'draft' });
      }
      // The view returned with this refusal shows the post as started, so the warning can open.
      if (row.status === 'started' && input.abandon !== true)
        return finish(
          verdict,
          new ViewError(
            'daily_send_started',
            '휴대폰이 이미 등록을 시도한 글입니다. 안내를 확인한 뒤 다시 취소하세요.',
          ),
        );
      const recalled = parsePublicationResponse(
        await this.request(context, 'recall', row.id, {
          expectedVersion: row.version,
          ...(row.status === 'started' ? { abandonUnresolved: true } : {}),
        }),
        0,
      );
      if (recalled.id !== row.id || recalled.status !== 'cancelled')
        fail('INVALID_RESPONSE', '취소 결과를 확인하지 못했습니다.');
      return finish({ kind: 'draft' });
    });
  }
}
