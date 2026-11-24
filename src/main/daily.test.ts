import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DailyDraft,
  DailyPersona,
  DailyRepliesResult,
  DailyReplyThread,
  DailyResult,
  DailyUpload,
} from '../shared/daily';
import type { MobilePublication } from '../shared/mobile-publications';
import { ViewError } from './collection';
import { DailyController, dailyReplyBatch } from './daily';
import type { StoredDailyMedia } from './daily-media';
import { DAILY_FILE_NAME, DailyStore } from './daily-store';
import type { MediaRegistry } from './media';
import type { PublicationRequest } from './mobile-publication-data';
import type { uploadPublicationFile } from './publication-s3-upload';
import { ServiceApiError, type ServiceApiClient } from './service-api';
import type { ThreadsUploadFile } from './threads-media';

interface ServerAnswer {
  id: string;
  replyThreadsId: string;
  text: string;
  status: 'queued' | 'failed' | 'unknown' | 'published' | 'cancelled';
  threadsId: string | null;
  errorCode: number | null;
  createdAt: string;
  publishedAt: string | null;
}
type AnswerFault = 'lose' | 'down' | 'pending';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const context = { ownerId: 'employee-a' };
const account = (id: string) => ({
  id,
  ownerId: context.ownerId,
  registrationId: randomUUID(),
  label: id,
  appName: `${id}-app`,
  appId: null,
  threadsUserId: null,
  validationStatus: 'reported_valid',
  tokenRevision: 1,
  expiresAt: null,
  createdAt: '2026-11-17T00:00:00.000Z',
  lifecycleVersion: 1,
  ownershipVersion: 1,
});
async function setup() {
  const userData = await mkdtemp(join(tmpdir(), 'tmm-daily-test-'));
  roots.push(userData);
  const rows: MobilePublication[] = [];
  const accounts = [account('account-a'), account('account-b')];
  const server = {
    offline: false,
    /** Only the persona routes fail: 'down' as an outage, 'migration' as a missing table. */
    personas: 'up' as 'up' | 'down' | 'migration',
    /** The next create is stored and its answer lost. */
    loseAnswer: false,
    /** Holds the next persona list until released, to look at a sync under way. */
    hold: null as Promise<void> | null,
    /** The reply routes: 'old' as a build without them, 'migration' as a missing table. */
    replies: 'up' as 'up' | 'down' | 'old' | 'migration' | 'auth',
    /** The server's file upload (2026-11-24): off for every call, or only when completing. */
    storage: 'on' as 'on' | 'off' | 'off-at-complete',
  };
  /** The server's reply summary and the replies of each publication. */
  const summary: { postKey: string; publicationId: string; fetchedAt: string; count: number }[] =
    [];
  const threads = new Map<
    string,
    { fetchedAt: string | null; rootThreadsId: string; replies: unknown[] }
  >();
  /** The persona's answers the server holds, by publication. */
  const answers = new Map<string, ServerAnswer[]>();
  /** Consumed one per answer save: 'lose' stores it and loses the reply, 'down' stores nothing. */
  const answerFaults: (AnswerFault | undefined)[] = [];
  /** Looked at by each answer save before it is handled, to see what this PC wrote first. */
  const beforeAnswer = vi.fn<(body: unknown) => Promise<void>>(async () => {});
  const open = (status: string) => ['queued', 'failed', 'unknown'].includes(status);
  const replyRequest = vi.fn(
    async (_context: unknown, operation: string, id?: string, body?: unknown) => {
      if (operation === 'answer') {
        await beforeAnswer(body);
        const fault = answerFaults.shift();
        if (fault === 'down')
          throw new ServiceApiError('서비스에 연결할 수 없습니다.', 'SERVICE_UNAVAILABLE', 503);
        if (fault === 'pending')
          throw new ServiceApiError('끝나지 않은 답글이 있습니다.', 'ANSWER_PENDING', 409);
        const input = body as { id: string; replyThreadsId: string; text: string };
        const list = answers.get(id!) ?? [];
        answers.set(id!, list);
        let row = list.find((item) => item.id === input.id);
        if (!row) {
          if (
            list.some((item) => item.replyThreadsId === input.replyThreadsId && open(item.status))
          )
            throw new ServiceApiError('끝나지 않은 답글이 있습니다.', 'ANSWER_PENDING', 409);
          row = {
            ...input,
            status: 'queued',
            threadsId: null,
            errorCode: null,
            createdAt: '2026-11-21T06:00:00.000Z',
            publishedAt: null,
          };
          list.push(row);
        }
        if (fault === 'lose')
          throw new ServiceApiError('서비스에 연결할 수 없습니다.', 'SERVICE_UNAVAILABLE', 503);
        return { answer: row };
      }
      if (operation === 'cancel') {
        const fault = answerFaults.shift();
        if (fault === 'down')
          throw new ServiceApiError('서비스에 연결할 수 없습니다.', 'SERVICE_UNAVAILABLE', 503);
        const row = [...answers.values()].flat().find((item) => item.id === id);
        if (!row) throw new ServiceApiError('답글을 찾을 수 없습니다.', 'NOT_FOUND', 404);
        if (row.status === 'unknown' || row.status === 'published')
          throw new ServiceApiError('취소할 수 없습니다.', 'ANSWER_NOT_CANCELLABLE', 409);
        row.status = 'cancelled';
        if (fault === 'lose')
          throw new ServiceApiError('서비스에 연결할 수 없습니다.', 'SERVICE_UNAVAILABLE', 503);
        return { answer: row };
      }
      if (server.replies === 'down')
        throw new ServiceApiError('서비스에 연결할 수 없습니다.', 'SERVICE_UNAVAILABLE', 503);
      if (server.replies === 'old')
        throw new ServiceApiError('댓글을 불러오지 못했습니다.', 'REPLY_REQUEST_FAILED', 404);
      if (server.replies === 'migration')
        throw new ServiceApiError('서버 업데이트가 필요합니다.', 'MIGRATION_REQUIRED', 503);
      if (server.replies === 'auth')
        throw new ServiceApiError('다시 로그인해 주세요.', 'AUTH_REQUIRED', 401);
      if (operation === 'summary')
        return {
          posts: summary.map((row) => {
            const list = answers.get(row.publicationId) ?? [];
            const count = (status: string) => list.filter((item) => item.status === status).length;
            return {
              ...row,
              answers: {
                queued: count('queued'),
                failed: count('failed'),
                unknown: count('unknown'),
              },
            };
          }),
        };
      const thread = threads.get(id!);
      if (!thread) throw new ServiceApiError('댓글을 찾을 수 없습니다.', 'NOT_FOUND', 404);
      return { ...thread, answers: answers.get(id!) ?? [] };
    },
  );
  /** The personas the server holds. */
  const remote: DailyPersona[] = [];
  const personaRequest = vi.fn(
    async (_context: unknown, operation: string, id?: string, body?: unknown) => {
      if (server.offline || server.personas === 'down')
        throw new ServiceApiError('서비스에 연결할 수 없습니다.', 'SERVICE_UNAVAILABLE', 503);
      if (server.personas === 'migration')
        throw new ServiceApiError('서버 업데이트가 필요합니다.', 'MIGRATION_REQUIRED', 503);
      const taken = (accountId: string, self: string) =>
        remote.some((row) => row.accountId === accountId && row.id !== self);
      if (operation === 'list') {
        await server.hold;
        return { personas: remote.map((row) => ({ ...row, updatedAt: row.createdAt })) };
      }
      if (operation === 'create') {
        const input = body as DailyPersona;
        const existing = remote.find((row) => row.id === input.id);
        if (existing) return { persona: existing };
        if (taken(input.accountId, input.id))
          throw new ServiceApiError('쓰는 계정입니다.', 'PERSONA_ACCOUNT_TAKEN', 409);
        remote.push({ ...input });
        if (server.loseAnswer) {
          server.loseAnswer = false;
          throw new ServiceApiError('서비스에 연결할 수 없습니다.', 'SERVICE_UNAVAILABLE', 503);
        }
        return { persona: input };
      }
      const row = remote.find((item) => item.id === id);
      if (operation === 'update') {
        if (!row) throw new ServiceApiError('없습니다.', 'PERSONA_NOT_FOUND', 404);
        const input = body as Pick<DailyPersona, 'accountId'>;
        if (taken(input.accountId, row.id))
          throw new ServiceApiError('쓰는 계정입니다.', 'PERSONA_ACCOUNT_TAKEN', 409);
        return { persona: Object.assign(row, body) };
      }
      if (operation === 'delete') {
        if (row) remote.splice(remote.indexOf(row), 1);
        return {};
      }
      throw new Error(`unexpected ${operation}`);
    },
  );
  const publicationRequest = vi.fn(
    async (_context: unknown, operation: string, id?: string, body?: unknown) => {
      if (server.offline)
        throw new ServiceApiError('서비스에 연결할 수 없습니다.', 'SERVICE_UNAVAILABLE', 503);
      if (operation === 'list') {
        const { postKey } = body as { postKey: string };
        return { publications: rows.filter((row) => row.source.postKey === postKey) };
      }
      if (operation === 'create') {
        const request = body as PublicationRequest;
        let row = rows.find((item) => item.requestId === request.requestId);
        if (!row) {
          // The server looks for the request first and only then for its storage.
          if (request.media.length && server.storage === 'off')
            throw new ServiceApiError('저장소가 없습니다.', 'STORAGE_NOT_CONFIGURED', 503);
          const files = request.media.length > 0;
          row = {
            id: randomUUID(),
            requestId: request.requestId,
            version: 1,
            accountId: request.accountId,
            source: request.source,
            status: files ? 'uploading' : 'ready',
            caption: request.caption,
            comment: null,
            media: structuredClone(request.media),
            sentAt: files ? null : '2026-11-17T01:00:00.000Z',
            deadlineAt: files ? null : '2026-11-24T01:00:00.000Z',
            rootStatus: 'queued',
            commentStatus: 'not_required',
          };
          rows.push(row);
        }
        // A server that keeps topics returns the key on every publication (2026-11-23).
        return { publication: { ...row, topic: request.topic ?? null } };
      }
      if (operation === 'upload-urls') {
        const row = rows.find((item) => item.id === id)!;
        if (server.storage !== 'on')
          throw new ServiceApiError('저장소가 없습니다.', 'STORAGE_NOT_CONFIGURED', 503);
        const { mediaIds } = body as { mediaIds: string[] };
        return {
          uploads: row.media
            .filter((m) => mediaIds.includes(m.id))
            .map((m) => ({
              mediaId: m.id,
              method: 'PUT',
              url: `https://test-bucket.s3.ap-northeast-2.amazonaws.com/staging/${m.id}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=synthetic`,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              headers: {
                'content-type': m.contentType,
                'content-length': String(m.size),
                'x-amz-checksum-sha256': Buffer.from(m.sha256, 'hex').toString('base64'),
                'if-none-match': '*',
              },
            })),
        };
      }
      if (operation === 'complete') {
        const row = rows.find((item) => item.id === id)!;
        if (server.storage !== 'on')
          throw new ServiceApiError('저장소가 없습니다.', 'STORAGE_NOT_CONFIGURED', 503);
        Object.assign(row, {
          status: 'ready',
          version: row.version + 1,
          sentAt: '2026-11-17T01:00:00.000Z',
          deadlineAt: '2026-11-24T01:00:00.000Z',
        });
        return { publication: row };
      }
      if (operation === 'recall') {
        const row = rows.find((item) => item.id === id)!;
        const input = body as { expectedVersion: number; abandonUnresolved?: true };
        if (
          input.expectedVersion !== row.version ||
          (row.status === 'started' && !input.abandonUnresolved)
        )
          throw new ServiceApiError('상태가 변경되었습니다.', 'PUBLICATION_STARTED', 409);
        Object.assign(row, {
          status: 'cancelled',
          rootStatus: 'cancelled',
          version: row.version + 1,
        });
        return { publication: row };
      }
      if (operation === 'cancel-request')
        return {
          publication: rows.find((item) => item.requestId === id) ?? null,
          requestCancelled: true,
        };
      throw new Error(`unexpected ${operation}`);
    },
  );
  const client = {
    getBusinessContext: vi.fn(async () => context),
    assertBusinessContext: vi.fn(),
    businessSignal: vi.fn(() => new AbortController().signal),
    managedThreadsRequest: vi.fn(async () => ({ accounts })),
    publicationRequest,
    personaRequest,
    replyRequest,
  } as unknown as Pick<
    ServiceApiClient,
    | 'getBusinessContext'
    | 'assertBusinessContext'
    | 'businessSignal'
    | 'publicationRequest'
    | 'managedThreadsRequest'
    | 'personaRequest'
    | 'replyRequest'
  >;
  const drafts = (...texts: string[]): DailyDraft[] =>
    texts.map((text) => ({ text, translation: null }));
  const generate = vi.fn<
    (persona: DailyPersona, recentPosts: string[], today: string) => Promise<DailyDraft[]>
  >(async () => drafts('첫 번째 글', '두 번째 글', '세 번째 글'));
  const translate = vi.fn<(persona: DailyPersona, text: string) => Promise<string>>(
    async (_persona, text) => `뜻: ${text}`,
  );
  const compose = vi.fn<(persona: DailyPersona, korean: string) => Promise<string>>(
    async (_persona, korean) => `EN: ${korean}`,
  );
  const translateReplies = vi.fn<
    (
      persona: DailyPersona,
      post: string,
      replies: { id: string; text: string }[],
    ) => Promise<{ id: string; korean: string }[]>
  >(async (_persona, _post, replies) =>
    replies.map((reply) => ({ id: reply.id, korean: `뜻: ${reply.text}` })),
  );
  const composeAnswer = vi.fn<(persona: DailyPersona, korean: string) => Promise<string>>(
    async (_persona, korean) => `EN reply: ${korean}`,
  );
  const openExternal = vi.fn<(url: string) => Promise<void>>(async () => {});
  /**
   * The attachment library of this PC (2026-11-24), kept in memory: what dialogs staged, what
   * saves kept and removed, and the bytes the upload preparation would copy now.
   */
  const library = {
    known: new Map<string, StoredDailyMedia>(),
    staged: new Map<string, Map<string, StoredDailyMedia>>(),
    commits: [] as { selectionId: string; kept: string[] }[],
    removed: [] as string[],
    missing: new Set<string>(),
    bytes: new Map<string, string>(),
    /** A work folder is set. */
    ready: true,
  };
  /** Files a post dialog added, as one selection. */
  const stage = (...names: string[]) => {
    const selectionId = randomUUID().replaceAll('-', '');
    const files = names.map((name): StoredDailyMedia => {
      const id = randomUUID().replaceAll('-', '');
      const kind = name.endsWith('.mp4') ? 'video' : 'image';
      const file = {
        id,
        kind,
        relativePath: `media/files/${selectionId}/${id}.${kind === 'video' ? 'mp4' : 'png'}`,
        size: 10,
        sha256: 'a'.repeat(64),
        name,
      } as const;
      library.known.set(id, file);
      return file;
    });
    library.staged.set(selectionId, new Map(files.map((file) => [file.id, file])));
    return { selectionId, ids: files.map((file) => file.id) };
  };
  const media = {
    ready: () => library.ready,
    pick: vi.fn(),
    add: vi.fn(),
    discard: vi.fn(async () => {}),
    staged: (_scope: unknown, selectionId: string) => library.staged.get(selectionId) ?? null,
    commit: vi.fn(async (_scope: unknown, selectionId: string, kept: ReadonlySet<string>) => {
      library.commits.push({ selectionId, kept: [...kept] });
      library.staged.delete(selectionId);
    }),
    track: vi.fn(
      async (_scope: unknown, files: readonly StoredDailyMedia[]) =>
        new Set(files.map((file) => file.id).filter((id) => !library.missing.has(id))),
    ),
    url: (id: string) => `threads-daily://file/${id}`,
    uploadSource: () => ({ registry: {} as MediaRegistry, root: '/work/daily-media/part' }),
    remove: vi.fn(async (_scope: unknown, files: readonly StoredDailyMedia[]) => {
      library.removed.push(...files.map((file) => file.id));
    }),
    sweep: vi.fn(async () => {}),
    reset: vi.fn(),
  };
  const prepareUpload = vi.fn(async (_source: unknown, ids: string[], directory: string) => {
    const prepared: ThreadsUploadFile[] = [];
    for (const id of ids) {
      const file = library.known.get(id)!;
      const content = library.bytes.get(id) ?? `bytes of ${id}`;
      const extension = file.kind === 'video' ? 'mp4' : 'png';
      const path = join(directory, `${id}.${extension}`);
      await writeFile(path, content);
      prepared.push({
        path,
        size: Buffer.byteLength(content),
        contentType: file.kind === 'video' ? 'video/mp4' : 'image/png',
        extension,
        kind: file.kind,
        mediaId: id,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    }
    return prepared;
  });
  const workDirectory = vi.fn(async (requestId: string) => {
    const directory = join(userData, 'outbox', requestId);
    await mkdir(directory, { recursive: true });
    return directory;
  });
  const upload = vi.fn<typeof uploadPublicationFile>(async () => {});
  const onUpload = vi.fn<(progress: DailyUpload | null) => void>();
  let tick = 0;
  const daily = new DailyController({
    client,
    store: new DailyStore(userData),
    service: 'https://service.test',
    generate,
    translate,
    compose,
    translateReplies,
    composeAnswer,
    openExternal,
    now: () => new Date(Date.UTC(2026, 10, 17, 0, 0, tick++)),
    media,
    prepareUpload,
    workDirectory,
    upload,
    onUpload,
  });
  const ok = (result: DailyResult) => {
    expect(result.problem).toBeNull();
    return result.view;
  };
  const persona = async (accountId = 'account-a', name = '아들맘') =>
    ok(
      await daily.savePersona({ name, accountId, language: 'ko', description: '30세, 아들 둘' }),
    ).personas.find((p) => p.accountId === accountId)!;
  const draft = async (personaId: string) =>
    ok(await daily.generate({ personaId })).posts.find((p) => p.personaId === personaId)!;
  const creates = () =>
    publicationRequest.mock.calls.filter((call) => call[1] === 'create').map((call) => call[3]);
  return {
    daily,
    rows,
    accounts,
    server,
    remote,
    personaRequest,
    publicationRequest,
    generate,
    translate,
    compose,
    userData,
    ok,
    persona,
    draft,
    creates,
    summary,
    threads,
    replyRequest,
    translateReplies,
    openExternal,
    client,
    answers,
    answerFaults,
    beforeAnswer,
    composeAnswer,
    library,
    stage,
    media,
    prepareUpload,
    workDirectory,
    upload,
    onUpload,
  };
}

describe('personas kept on the server', () => {
  const file = async (userData: string) =>
    JSON.parse(await readFile(join(userData, DAILY_FILE_NAME), 'utf8')).partitions[0];
  const calls = (mock: { mock: { calls: unknown[][] } }, operation: string) =>
    mock.mock.calls.filter((call) => call[1] === operation);

  it('saves and deletes on the server first, and leaves this PC alone when the server refuses', async () => {
    const { daily, remote, server, userData, ok, persona } = await setup();
    const mom = await persona();
    expect(remote).toEqual([mom]);
    ok(
      await daily.savePersona({
        personaId: mom.id,
        name: '연년생 아들맘',
        accountId: 'account-a',
        language: 'en',
        description: '45세',
      }),
    );
    expect(remote[0]).toMatchObject({ id: mom.id, name: '연년생 아들맘', language: 'en' });
    expect(remote[0].createdAt).toBe(mom.createdAt);
    server.personas = 'down';
    const refused = await daily.savePersona({
      personaId: mom.id,
      name: '바뀐 이름',
      accountId: 'account-a',
      language: 'en',
      description: '45세',
    });
    expect(refused.problem?.code).toBe('SERVICE_UNAVAILABLE');
    expect(refused.view.personas[0].name).toBe('연년생 아들맘');
    expect((await daily.deletePersona({ personaId: mom.id })).problem?.code).toBe(
      'SERVICE_UNAVAILABLE',
    );
    expect((await file(userData)).personas).toHaveLength(1);
    server.personas = 'up';
    expect(ok(await daily.deletePersona({ personaId: mom.id })).personas).toEqual([]);
    expect(remote).toEqual([]);
  });

  it('moves the personas only this PC has to the server once, without rewriting them', async () => {
    const { daily, remote, personaRequest, userData, ok, persona, accounts } = await setup();
    const mom = await persona();
    const gone = await persona('account-b', '없어진 계정');
    // Older data: the server has never seen them, and one account has since been deleted.
    remote.length = 0;
    accounts.pop();
    const before = await readFile(join(userData, DAILY_FILE_NAME), 'utf8');
    const view = ok(await daily.state());
    expect(remote).toEqual([mom, gone]);
    expect(view.personas).toEqual([mom, gone]);
    expect(view.unsyncedPersonas).toBe(0);
    expect(await readFile(join(userData, DAILY_FILE_NAME), 'utf8')).toBe(before);
    personaRequest.mockClear();
    ok(await daily.state());
    expect(calls(personaRequest, 'create')).toHaveLength(0);
  });

  it('takes in the server personas on a new PC and does not write the file again after that', async () => {
    const { daily, remote, userData, ok } = await setup();
    remote.push({
      id: randomUUID(),
      name: '서버 페르소나',
      accountId: 'account-a',
      language: 'ja',
      description: '',
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    expect(ok(await daily.state()).personas).toEqual(remote);
    expect((await file(userData)).personas).toEqual([{ ...remote[0], synced: true }]);
    expect((await daily.persona('account-a'))?.name).toBe('서버 페르소나');
    const update = vi.spyOn(DailyStore.prototype, 'update');
    ok(await daily.state());
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
  });

  it('follows the server where both have a persona, keeping fields it does not know, and never overwrites the server from an old file', async () => {
    const { daily, remote, personaRequest, userData, ok, persona } = await setup();
    const mom = await persona();
    const path = join(userData, DAILY_FILE_NAME);
    const stored = JSON.parse(await readFile(path, 'utf8'));
    stored.partitions[0].personas[0].future = { kept: true };
    await writeFile(path, JSON.stringify(stored));
    // The server copy was edited after this file was written (a restored backup, another PC).
    remote[0] = { ...mom, name: '서버에서 고친 이름', description: '서버 설명' };
    personaRequest.mockClear();
    expect(ok(await daily.state()).personas[0]).toEqual(remote[0]);
    expect((await file(userData)).personas[0]).toEqual({
      ...remote[0],
      synced: true,
      future: { kept: true },
    });
    expect(calls(personaRequest, 'create')).toHaveLength(0);
    expect(calls(personaRequest, 'update')).toHaveLength(0);
  });

  it.each(['down', 'migration'] as const)(
    'keeps working from the file while the persona routes are %s, and says the phone may not see them',
    async (state) => {
      const { daily, remote, server, ok, persona, draft } = await setup();
      const mom = await persona();
      server.personas = state;
      remote.length = 0;
      const view = ok(await daily.state());
      expect(view.personas).toEqual([mom]);
      // Confirmed when it was saved, so an outage alone does not raise the notice.
      expect(view.unsyncedPersonas).toBe(0);
      expect((await daily.persona('account-a'))?.id).toBe(mom.id);
      expect((await draft(mom.id)).text).toBe('첫 번째 글');
      server.personas = 'up';
      expect(ok(await daily.state()).unsyncedPersonas).toBe(0);
      expect(remote).toEqual([mom]);
    },
  );

  it('counts the personas of a file written before the server kept them, until they are uploaded', async () => {
    const { daily, remote, server, userData, ok, persona } = await setup();
    const mom = await persona();
    // A file from the version before this one: no mark, and the server has nothing.
    const path = join(userData, DAILY_FILE_NAME);
    const stored = JSON.parse(await readFile(path, 'utf8'));
    delete stored.partitions[0].personas[0].synced;
    await writeFile(path, JSON.stringify(stored));
    remote.length = 0;
    server.personas = 'migration';
    expect(ok(await daily.state()).unsyncedPersonas).toBe(1);
    server.personas = 'up';
    expect(ok(await daily.state()).unsyncedPersonas).toBe(0);
    expect(remote).toEqual([mom]);
    expect((await file(userData)).personas[0].synced).toBe(true);
  });

  it('never changes on this PC alone a persona the server has held', async () => {
    const { daily, remote, server, personaRequest, userData, ok, persona } = await setup();
    const mom = await persona();
    const missing = () =>
      personaRequest.mockRejectedValueOnce(
        new ServiceApiError('저장하지 못했습니다.', 'PERSONA_REQUEST_FAILED', 404),
      );
    // The server was rolled back to a build without the routes; its data is still there.
    missing();
    const edited = await daily.savePersona({
      personaId: mom.id,
      name: '롤백 중에 고친 이름',
      accountId: 'account-a',
      language: 'ko',
      description: '30세',
    });
    expect(edited.problem?.code).toBe('PERSONA_REQUEST_FAILED');
    missing();
    expect((await daily.deletePersona({ personaId: mom.id })).problem?.code).toBe(
      'PERSONA_REQUEST_FAILED',
    );
    server.personas = 'migration';
    expect((await daily.deletePersona({ personaId: mom.id })).problem?.code).toBe(
      'MIGRATION_REQUIRED',
    );
    server.personas = 'up';
    expect(ok(await daily.state()).personas).toEqual([mom]);
    expect((await file(userData)).personas[0]).toEqual({ ...mom, synced: true });
    expect(remote).toEqual([mom]);
  });

  it('surfaces a sign-in the server refuses instead of answering from the file', async () => {
    const { daily, personaRequest, persona } = await setup();
    await persona();
    personaRequest.mockRejectedValueOnce(
      new ServiceApiError('서비스에 다시 로그인해 주세요.', 'AUTH_REQUIRED', 403),
    );
    expect((await daily.state()).problem?.code).toBe('AUTH_REQUIRED');
  });

  it('keeps changes on this PC while the server has no persona storage, and uploads them later', async () => {
    const { daily, remote, server, personaRequest, ok, persona } = await setup();
    // An older server: the table is missing, or the routes are (a bare 404).
    server.personas = 'migration';
    const mom = await persona();
    personaRequest.mockRejectedValueOnce(
      new ServiceApiError('저장하지 못했습니다.', 'PERSONA_REQUEST_FAILED', 404),
    );
    const view = ok(
      await daily.savePersona({
        personaId: mom.id,
        name: '서버 없이 고친 이름',
        accountId: 'account-a',
        language: 'ko',
        description: '30세',
      }),
    );
    expect(view.personas[0].name).toBe('서버 없이 고친 이름');
    expect(view.unsyncedPersonas).toBe(1);
    const other = await persona('account-b', '지울 페르소나');
    expect(ok(await daily.deletePersona({ personaId: other.id })).personas).toHaveLength(1);
    expect(remote).toEqual([]);
    server.personas = 'up';
    expect(ok(await daily.state()).unsyncedPersonas).toBe(0);
    expect(remote).toEqual([{ ...mom, name: '서버 없이 고친 이름', description: '30세' }]);
  });

  it('shows a persona the server saved although its answer was lost', async () => {
    const { daily, remote, server } = await setup();
    server.loseAnswer = true;
    const result = await daily.savePersona({
      name: '아들맘',
      accountId: 'account-a',
      language: 'ko',
      description: '30세',
    });
    expect(result.problem?.code).toBe('SERVICE_UNAVAILABLE');
    expect(result.view.personas).toEqual(remote);
    expect(remote).toHaveLength(1);
    expect(result.view.unsyncedPersonas).toBe(0);
  });

  it('creates a changed persona the server has lost instead of failing', async () => {
    const { daily, remote, ok, persona } = await setup();
    const mom = await persona();
    remote.length = 0;
    ok(
      await daily.savePersona({
        personaId: mom.id,
        name: '다시 올린 이름',
        accountId: 'account-a',
        language: 'ko',
        description: '30세',
      }),
    );
    expect(remote).toEqual([{ ...mom, name: '다시 올린 이름', description: '30세' }]);
  });

  it('leaves out a server persona whose account another persona here uses, and counts both', async () => {
    const { daily, remote, ok, persona } = await setup();
    const mine = await persona();
    // Another PC bound the same account to a different persona and this one was removed there.
    remote.splice(0, 1, { ...mine, id: randomUUID(), name: '다른 PC의 페르소나' });
    const view = ok(await daily.state());
    expect(view.personas).toEqual([mine]);
    expect(view.unsyncedPersonas).toBe(2);
    expect(remote).toHaveLength(1);
  });

  it('holds changes until a sync under way has finished, and counts as busy meanwhile', async () => {
    const { daily, remote, server, ok, persona } = await setup();
    const mom = await persona();
    let release = () => {};
    server.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const looking = daily.state();
    await vi.waitFor(() => expect(daily.busy).toBe(true));
    const deleting = daily.deletePersona({ personaId: mom.id });
    server.hold = null;
    release();
    ok(await looking);
    expect(ok(await deleting).personas).toEqual([]);
    expect(remote).toEqual([]);
    expect(daily.busy).toBe(false);
  });

  it('ignores a persona list it cannot trust', async () => {
    const { daily, personaRequest, ok, persona } = await setup();
    const mom = await persona();
    personaRequest.mockResolvedValueOnce({
      personas: [
        { ...mom, updatedAt: mom.createdAt, name: '믿을 수 없는 값', language: 'fr' as 'ko' },
      ],
    });
    expect(ok(await daily.state()).personas).toEqual([mom]);
  });
});

describe('daily personas', () => {
  it('binds one account to one persona and refuses accounts the user does not own', async () => {
    const { daily, persona } = await setup();
    await persona();
    const taken = await daily.savePersona({
      name: '다이어터',
      accountId: 'account-a',
      language: 'ko',
      description: '29세 직장인',
    });
    expect(taken.problem?.code).toBe('daily_account_taken');
    expect(taken.view.personas).toHaveLength(1);
    const foreign = await daily.savePersona({
      name: '다이어터',
      accountId: 'account-z',
      language: 'ko',
      description: '29세 직장인',
    });
    expect(foreign.problem?.code).toBe('daily_account');
  });
  it('locks the account once the persona has a post, unless that account is gone', async () => {
    const { daily, accounts, persona, draft, ok } = await setup();
    const p = await persona();
    const edit = { personaId: p.id, name: p.name, language: 'ko', description: p.description };
    expect(
      ok(await daily.savePersona({ ...edit, accountId: 'account-b' })).personas[0].accountId,
    ).toBe('account-b');
    await draft(p.id);
    const locked = await daily.savePersona({ ...edit, accountId: 'account-a' });
    expect(locked.problem?.code).toBe('daily_account_locked');
    accounts.splice(1, 1);
    expect(
      ok(await daily.savePersona({ ...edit, accountId: 'account-a' })).personas[0].accountId,
    ).toBe('account-a');
  });
  it('keeps a persona with a waiting post and deletes its drafts with it otherwise', async () => {
    const { daily, persona, draft, ok } = await setup();
    const p = await persona();
    const post = await draft(p.id);
    ok(await daily.send({ postId: post.id }));
    expect((await daily.deletePersona({ personaId: p.id })).problem?.code).toBe(
      'daily_persona_waiting',
    );
    ok(await daily.cancelSend({ postId: post.id }));
    const view = ok(await daily.deletePersona({ personaId: p.id }));
    expect(view.personas).toHaveLength(0);
    expect(view.posts).toHaveLength(0);
  });
});

describe('daily drafts', () => {
  it('adds three drafts and hands the newest earlier posts to the writer', async () => {
    const { daily, generate, persona, ok } = await setup();
    const p = await persona();
    ok(await daily.generate({ personaId: p.id }));
    generate.mockResolvedValueOnce(
      ['넷', '다섯', '여섯'].map((text) => ({ text, translation: null })),
    );
    const view = ok(await daily.generate({ personaId: p.id }));
    expect(view.posts.map((post) => post.state)).toEqual(Array(6).fill('draft'));
    expect(view.generatingPersonaId).toBeNull();
    expect(generate.mock.calls[1][1]).toEqual(['첫 번째 글', '두 번째 글', '세 번째 글']);
    expect(generate.mock.calls[1][0]).toMatchObject({ id: p.id, language: 'ko' });
    // The writer gets the PC's calendar date for the season (the day depends on the time zone).
    expect(generate.mock.calls[1][2]).toMatch(/^2026-11-1[67]$/);
  });
  it('reports a failed generation as finished, so the board can start another', async () => {
    const { daily, generate, persona, ok } = await setup();
    const p = await persona();
    generate.mockRejectedValueOnce(new ViewError('codex_login', 'ChatGPT에 로그인하세요.'));
    const failed = await daily.generate({ personaId: p.id });
    expect(failed.problem?.code).toBe('codex_login');
    expect(failed.view.generatingPersonaId).toBeNull();
    expect(failed.view.personas).toHaveLength(1);
    expect(daily.generating).toBe(false);
    expect(ok(await daily.generate({ personaId: p.id })).posts).toHaveLength(3);
  });
  it('keeps the Korean rendering of a post until its text is edited', async () => {
    const { daily, generate, persona, ok, creates } = await setup();
    const p = await persona();
    generate.mockResolvedValueOnce([
      { text: 'First post', translation: '첫 글' },
      { text: 'Second post', translation: '둘째 글' },
      { text: 'Third post', translation: '셋째 글' },
    ]);
    const view = ok(await daily.generate({ personaId: p.id }));
    expect(view.posts.map((post) => post.translation)).toEqual(['첫 글', '둘째 글', '셋째 글']);
    const [first, second] = view.posts;
    const same = ok(await daily.savePost({ postId: first.id, text: ' First post ' }));
    expect(same.posts.find((post) => post.id === first.id)?.translation).toBe('첫 글');
    const edited = ok(await daily.savePost({ postId: second.id, text: 'Second post, edited' }));
    expect(edited.posts.find((post) => post.id === second.id)?.translation).toBeNull();
    // The rendering stays on this PC: the send request carries the post text only.
    ok(await daily.send({ postId: first.id }));
    expect(JSON.stringify(creates().at(-1))).not.toContain('첫 글');
    generate.mockResolvedValueOnce([
      { text: 'Fourth', translation: ' ' },
      { text: 'Fifth', translation: '다섯째' },
      { text: 'Sixth', translation: '여섯째' },
    ]);
    expect((await daily.generate({ personaId: p.id })).problem?.code).toBe('daily_generation');
  });
  it('writes the Korean rendering of a post in another language again', async () => {
    const { daily, generate, translate, persona, ok } = await setup();
    const korean = await persona();
    const [koreanPost] = ok(await daily.generate({ personaId: korean.id })).posts;
    expect((await daily.translatePost({ postId: koreanPost.id })).problem?.code).toBe(
      'daily_input',
    );
    const english = ok(
      await daily.savePersona({
        name: 'Renter',
        accountId: 'account-b',
        language: 'en',
        description: '나이: 27세',
      }),
    ).personas.find((p) => p.accountId === 'account-b')!;
    generate.mockResolvedValueOnce([
      { text: 'First post', translation: '첫 글' },
      { text: 'Second post', translation: '둘째 글' },
      { text: 'Third post', translation: '셋째 글' },
    ]);
    const post = ok(await daily.generate({ personaId: english.id })).posts.find(
      (item) => item.text === 'First post',
    )!;
    ok(await daily.savePost({ postId: post.id, text: 'First post, edited' }));
    const view = ok(await daily.translatePost({ postId: post.id }));
    expect(view.posts.find((item) => item.id === post.id)?.translation).toBe(
      '뜻: First post, edited',
    );
    expect(view.translatingPostId).toBeNull();
    expect(translate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: english.id, language: 'en' }),
      'First post, edited',
    );
    // A failure leaves the post without a rendering and the work marked as over.
    ok(await daily.savePost({ postId: post.id, text: 'Edited again' }));
    translate.mockRejectedValueOnce(new ViewError('codex_login', 'ChatGPT에 로그인하세요.'));
    const failed = await daily.translatePost({ postId: post.id });
    expect(failed.problem?.code).toBe('codex_login');
    expect(failed.view.translatingPostId).toBeNull();
    expect(failed.view.posts.find((item) => item.id === post.id)?.translation).toBeNull();
    expect(daily.generating).toBe(false);
    // The text changed while ChatGPT was writing: the rendering of the old text is not kept.
    let finish!: (value: string) => void;
    translate.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const pending = daily.translatePost({ postId: post.id });
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(3));
    expect(daily.generating).toBe(true);
    expect((await daily.generate({ personaId: english.id })).problem?.code).toBe('daily_busy');
    // Nothing is edited or written by hand while ChatGPT writes.
    for (const refused of [
      await daily.savePost({ postId: post.id, text: 'Edited a third time' }),
      await daily.addPost({ personaId: english.id, text: 'By hand', fromKorean: false }),
      await daily.addPost({ personaId: english.id, text: '손으로 쓴 글', fromKorean: true }),
    ])
      expect(refused.problem?.code).toBe('daily_busy');
    finish('뜻: Edited again');
    expect(ok(await pending).posts.find((item) => item.id === post.id)).toMatchObject({
      text: 'Edited again',
      translation: '뜻: Edited again',
    });
  });
  it('adds a draft written by hand, as written or from Korean', async () => {
    const { daily, compose, persona, ok } = await setup();
    const korean = await persona();
    const direct = ok(
      await daily.addPost({ personaId: korean.id, text: '  손으로 쓴 글  ', fromKorean: false }),
    );
    expect(direct.posts).toMatchObject([
      { personaId: korean.id, text: '손으로 쓴 글', translation: null, state: 'draft' },
    ]);
    // A Korean persona has nothing to be written into.
    expect(
      (await daily.addPost({ personaId: korean.id, text: '글', fromKorean: true })).problem?.code,
    ).toBe('daily_input');
    const english = ok(
      await daily.savePersona({
        name: 'Renter',
        accountId: 'account-b',
        language: 'en',
        description: '나이: 27세',
      }),
    ).personas.find((p) => p.accountId === 'account-b')!;
    const composed = ok(
      await daily.addPost({ personaId: english.id, text: ' 냉동실 정리 ', fromKorean: true }),
    );
    expect(composed.posts.find((post) => post.personaId === english.id)).toMatchObject({
      text: 'EN: 냉동실 정리',
      translation: '냉동실 정리',
      state: 'draft',
    });
    expect(compose).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: english.id, language: 'en' }),
      '냉동실 정리',
    );
    for (const [input, code] of [
      [{ personaId: english.id, text: '   ', fromKorean: false }, 'daily_text'],
      [{ personaId: english.id, text: 'a'.repeat(501), fromKorean: true }, 'daily_text'],
      // English comes out about twice as long, so its Korean draft is held to 200 characters.
      [{ personaId: english.id, text: '가'.repeat(201), fromKorean: true }, 'daily_text'],
      [{ personaId: english.id, text: '글' }, 'daily_input'],
      [{ personaId: randomUUID(), text: '글', fromKorean: false }, 'daily_persona'],
    ] as const)
      expect((await daily.addPost(input)).problem?.code).toBe(code);
    expect(compose).toHaveBeenCalledOnce();
    ok(await daily.addPost({ personaId: english.id, text: '가'.repeat(200), fromKorean: true }));
    ok(await daily.addPost({ personaId: english.id, text: 'a'.repeat(201), fromKorean: false }));
    compose.mockRejectedValueOnce(new ViewError('codex_login', 'ChatGPT에 로그인하세요.'));
    const failed = await daily.addPost({ personaId: english.id, text: '글', fromKorean: true });
    expect(failed.problem?.code).toBe('codex_login');
    expect(failed.view.posts).toHaveLength(4);
    expect(daily.generating).toBe(false);
    compose.mockResolvedValueOnce('a'.repeat(501));
    expect(
      (await daily.addPost({ personaId: english.id, text: '글', fromKorean: true })).problem?.code,
    ).toBe('daily_generation');
  });
  it('edits and deletes drafts only', async () => {
    const { daily, persona, draft, ok } = await setup();
    const post = await draft((await persona()).id);
    expect(
      ok(await daily.savePost({ postId: post.id, text: '  고친 글  ' })).posts.find(
        (item) => item.id === post.id,
      )?.text,
    ).toBe('고친 글');
    expect((await daily.savePost({ postId: post.id, text: 'a'.repeat(501) })).problem?.code).toBe(
      'daily_text',
    );
    ok(await daily.send({ postId: post.id }));
    expect((await daily.savePost({ postId: post.id, text: '또 고침' })).problem?.code).toBe(
      'daily_post_sent',
    );
    expect((await daily.deletePost({ postId: post.id })).problem?.code).toBe('daily_post_sent');
  });
  it('keeps one topic on a draft without its leading #, and refuses one Threads would not take', async () => {
    const { daily, persona, draft } = await setup();
    const post = await draft((await persona()).id);
    const topic = async (value?: string) => {
      const result = await daily.savePost({
        postId: post.id,
        text: post.text,
        ...(value === undefined ? {} : { topic: value }),
      });
      return {
        code: result.problem?.code ?? null,
        topic: result.view.posts.find((item) => item.id === post.id)?.topic,
      };
    };
    expect(post.topic).toBeNull();
    expect(await topic(' #Mom Threads ')).toEqual({ code: null, topic: 'Mom Threads' });
    // A save without the field leaves the topic as it is.
    expect(await topic()).toEqual({ code: null, topic: 'Mom Threads' });
    expect(await topic('가'.repeat(50))).toEqual({ code: null, topic: '가'.repeat(50) });
    for (const refused of ['가'.repeat(51), 'Mom.Threads', 'Mom & Dad', 'Mom\tDad'])
      expect(await topic(refused)).toEqual({ code: 'daily_topic', topic: '가'.repeat(50) });
    expect(await topic('  #  ')).toEqual({ code: null, topic: null });
    expect(
      (await daily.savePost({ postId: post.id, text: post.text, topic: 1 })).problem?.code,
    ).toBe('daily_input');
  });
});

describe('daily sends', () => {
  it('sends a text-only publication with its own source and no comment or media', async () => {
    const { daily, persona, draft, ok, creates } = await setup();
    const post = await draft((await persona()).id);
    const sent = ok(await daily.send({ postId: post.id })).posts.find((p) => p.id === post.id)!;
    expect(sent).toMatchObject({
      state: 'waiting',
      note: null,
      started: false,
      sentAt: '2026-11-17T01:00:00.000Z',
    });
    expect(creates()[0]).toMatchObject({
      accountId: 'account-a',
      caption: post.text,
      comment: null,
      media: [],
      source: { libraryId: 'daily', postKey: post.id, draftRevision: 1, commentUpdatedAt: null },
    });
  });
  it('takes a topic with a post written by hand', async () => {
    const { daily, persona, ok } = await setup();
    const personaId = (await persona()).id;
    const add = (topic?: unknown) =>
      daily.addPost({
        personaId,
        text: 'written by hand',
        fromKorean: false,
        ...(topic === undefined ? {} : { topic }),
      });
    expect(ok(await add(' #Mom Threads ')).posts.map((post) => post.topic)).toEqual([
      'Mom Threads',
    ]);
    expect(ok(await add()).posts.map((post) => post.topic)).toEqual(['Mom Threads', null]);
    expect(ok(await add('  ')).posts).toHaveLength(3);
    const refused = await add('Mom.Threads');
    expect(refused.problem?.code).toBe('daily_topic');
    expect(refused.view.posts).toHaveLength(3);
    expect((await add(1)).problem?.code).toBe('daily_input');
  });
  it('sends the topic only for a post that has one', async () => {
    const { daily, server, persona, ok, creates } = await setup();
    const p = await persona();
    const [plain, tagged] = ok(await daily.generate({ personaId: p.id })).posts;
    ok(await daily.savePost({ postId: tagged.id, text: tagged.text, topic: '#Mom Threads' }));
    ok(await daily.send({ postId: plain.id }));
    expect(creates()[0]).not.toHaveProperty('topic');
    server.offline = true;
    expect((await daily.send({ postId: tagged.id })).problem?.code).toBe('SERVICE_UNAVAILABLE');
    server.offline = false;
    const sent = ok(await daily.send({ postId: tagged.id })).posts.find((p) => p.id === tagged.id);
    expect(sent).toMatchObject({ state: 'waiting', note: null, topic: 'Mom Threads' });
    expect(creates()[1]).toMatchObject({ topic: 'Mom Threads', caption: tagged.text });
    expect(creates()[2]).toEqual(creates()[1]);
  });
  it('stores the whole request before the network call and repeats it unchanged', async () => {
    const { daily, server, userData, persona, draft, ok, creates } = await setup();
    const post = await draft((await persona()).id);
    server.offline = true;
    const failed = await daily.send({ postId: post.id });
    expect(failed.problem?.code).toBe('SERVICE_UNAVAILABLE');
    expect(failed.view.posts.find((p) => p.id === post.id)).toMatchObject({
      state: 'waiting',
      note: 'unconfirmed',
    });
    const stored = JSON.parse(await readFile(join(userData, DAILY_FILE_NAME), 'utf8'));
    const saved = stored.partitions[0].posts.find((p: { id: string }) => p.id === post.id).send;
    expect(saved.confirmed).toBe(false);
    server.offline = false;
    const retried = ok(await daily.send({ postId: post.id })).posts.find((p) => p.id === post.id);
    expect(retried).toMatchObject({ state: 'waiting', note: null });
    expect(creates()).toHaveLength(2);
    expect(creates()[1]).toEqual(creates()[0]);
    expect(creates()[1]).toEqual(saved.request);
  });
  it('takes a queued send back to a draft, and still ends published if the phone posted it', async () => {
    const { daily, rows, publicationRequest, persona, draft, ok } = await setup();
    const post = await draft((await persona()).id);
    ok(await daily.send({ postId: post.id }));
    const cancelled = ok(await daily.cancelSend({ postId: post.id }));
    expect(cancelled.posts.find((p) => p.id === post.id)?.state).toBe('draft');
    expect(publicationRequest.mock.calls.at(-1)?.slice(1)).toEqual([
      'recall',
      rows[0].id,
      { expectedVersion: 1 },
    ]);
    // The phone was already publishing when the PC cancelled; its late result lands on the row.
    rows[0].rootStatus = 'published';
    const later = ok(await daily.state()).posts.find((p) => p.id === post.id);
    expect(later).toMatchObject({ state: 'published', sentAt: '2026-11-17T01:00:00.000Z' });
    expect((await daily.send({ postId: post.id })).problem?.code).toBe('daily_post_sent');
  });
  it('never sends a cancelled post again once the phone posted the cancelled send', async () => {
    const { daily, rows, persona, draft, ok, creates } = await setup();
    const post = await draft((await persona()).id);
    ok(await daily.send({ postId: post.id }));
    ok(await daily.cancelSend({ postId: post.id }));
    rows[0].rootStatus = 'published';
    // No refresh happened in between: the board still shows a draft.
    const again = await daily.send({ postId: post.id });
    expect(again.problem?.code).toBe('daily_post_sent');
    expect(again.view.posts.find((p) => p.id === post.id)?.state).toBe('published');
    expect(creates()).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });
  it('withdraws the second send when the cancelled first one turns out posted', async () => {
    const { daily, rows, publicationRequest, persona, draft, ok } = await setup();
    const post = await draft((await persona()).id);
    ok(await daily.send({ postId: post.id }));
    ok(await daily.cancelSend({ postId: post.id }));
    ok(await daily.send({ postId: post.id }));
    expect(rows.map((row) => row.status)).toEqual(['cancelled', 'ready']);
    rows[0].rootStatus = 'published';
    const view = ok(await daily.state());
    expect(view.posts.find((p) => p.id === post.id)?.state).toBe('published');
    // The phone must not be left with a second, postable copy the PC no longer shows.
    expect(rows[1].status).toBe('cancelled');
    expect(publicationRequest.mock.calls.at(-1)?.slice(1)).toEqual([
      'recall',
      rows[1].id,
      { expectedVersion: 1 },
    ]);
  });
  it('shows the post as started when a cancel is refused, so the warning can open', async () => {
    const { daily, rows, publicationRequest, persona, draft, ok } = await setup();
    const post = await draft((await persona()).id);
    const waiting = ok(await daily.send({ postId: post.id })).posts.find((p) => p.id === post.id);
    expect(waiting?.started).toBe(false);
    // The phone tried after the board was last read.
    Object.assign(rows[0], { status: 'started', rootStatus: 'unknown' });
    const refused = await daily.cancelSend({ postId: post.id });
    expect(refused.problem?.code).toBe('daily_send_started');
    expect(refused.view.posts.find((p) => p.id === post.id)).toMatchObject({
      state: 'waiting',
      note: 'check_phone',
      started: true,
    });
    expect(publicationRequest.mock.calls.some((call) => call[1] === 'recall')).toBe(false);
  });
  it('needs the confirmed warning before ending work the phone already started', async () => {
    const { daily, rows, publicationRequest, persona, draft, ok } = await setup();
    const post = await draft((await persona()).id);
    ok(await daily.send({ postId: post.id }));
    Object.assign(rows[0], { status: 'started', rootStatus: 'failed' });
    expect(ok(await daily.state()).posts.find((p) => p.id === post.id)).toMatchObject({
      state: 'waiting',
      note: 'failed',
      started: true,
    });
    const refused = await daily.cancelSend({ postId: post.id });
    expect(refused.problem?.code).toBe('daily_send_started');
    expect(refused.view.posts.find((p) => p.id === post.id)?.state).toBe('waiting');
    const view = ok(await daily.cancelSend({ postId: post.id, abandon: true }));
    expect(view.posts.find((p) => p.id === post.id)?.state).toBe('draft');
    expect(publicationRequest.mock.calls.at(-1)?.[3]).toEqual({
      expectedVersion: 1,
      abandonUnresolved: true,
    });
  });
  it('cancels a send the server never recorded through the request id', async () => {
    const { daily, server, publicationRequest, persona, draft, ok } = await setup();
    const post = await draft((await persona()).id);
    server.offline = true;
    await daily.send({ postId: post.id });
    server.offline = false;
    const view = ok(await daily.cancelSend({ postId: post.id }));
    expect(view.posts.find((p) => p.id === post.id)?.state).toBe('draft');
    expect(publicationRequest.mock.calls.at(-1)?.[1]).toBe('cancel-request');
  });
  it('follows the server: phone unanswered, expired without a silent return, cancelled by the server', async () => {
    const { daily, rows, persona, draft, ok } = await setup();
    const post = await draft((await persona()).id);
    ok(await daily.send({ postId: post.id }));
    const read = async () => ok(await daily.state()).posts.find((p) => p.id === post.id);
    Object.assign(rows[0], { status: 'started', rootStatus: 'unknown' });
    expect(await read()).toMatchObject({ state: 'waiting', note: 'check_phone', started: true });
    Object.assign(rows[0], { status: 'expired', rootStatus: 'queued' });
    expect(await read()).toMatchObject({ state: 'waiting', note: 'expired', started: false });
    Object.assign(rows[0], { status: 'cancelled', rootStatus: 'cancelled' });
    expect(await read()).toMatchObject({ state: 'draft', note: null });
  });
  it('refuses to cancel a post that already reached Threads and shows it as published', async () => {
    const { daily, rows, persona, draft, ok } = await setup();
    const post = await draft((await persona()).id);
    ok(await daily.send({ postId: post.id }));
    Object.assign(rows[0], { status: 'published', rootStatus: 'published' });
    const result = await daily.cancelSend({ postId: post.id });
    expect(result.problem?.code).toBe('daily_post_sent');
    expect(result.view.posts.find((p) => p.id === post.id)?.state).toBe('published');
  });
  it('rejects a server answer that belongs to another post or carries media', async () => {
    const { daily, rows, persona, draft, ok } = await setup();
    const post = await draft((await persona()).id);
    ok(await daily.send({ postId: post.id }));
    rows[0].source = { ...rows[0].source, libraryId: 'library-a' };
    expect((await daily.state()).problem?.code).toBe('INVALID_RESPONSE');
  });
});

describe('daily replies', () => {
  const reply = (threadsId: string, text: string, extra: Record<string, unknown> = {}) => ({
    threadsId,
    parentThreadsId: '900',
    username: `user${threadsId}`,
    text,
    permalink: `https://www.threads.com/@user${threadsId}/post/${threadsId}`,
    mediaType: 'TEXT_POST',
    ownedByMe: false,
    postedAt: `2026-11-21T0${9 - Number(threadsId.length)}:00:00.000Z`,
    ...extra,
  });
  /** A published post of a persona writing in `language`, with fetched replies on the server. */
  async function published(language: 'ko' | 'en' = 'en') {
    const tools = await setup();
    const { daily, rows, ok, summary, threads } = tools;
    const persona = ok(
      await daily.savePersona({
        name: 'Renter',
        accountId: 'account-a',
        language,
        description: '나이: 27세',
      }),
    ).personas[0];
    const [post] = ok(await daily.generate({ personaId: persona.id })).posts;
    ok(await daily.send({ postId: post.id }));
    rows[0].rootStatus = 'published';
    summary.push({
      postKey: post.id,
      publicationId: rows[0].id,
      fetchedAt: '2026-11-21T05:02:11.000Z',
      count: 3,
    });
    threads.set(rows[0].id, {
      fetchedAt: '2026-11-21T05:02:11.000Z',
      rootThreadsId: '900',
      replies: [
        reply('1', 'Cute!'),
        reply('2', 'Thank you', { ownedByMe: true, parentThreadsId: '1' }),
        reply('3', '', { mediaType: 'IMAGE' }),
        reply('4', 'Me too', { permalink: null }),
      ],
    });
    // The window opens from a card of the board, which read the summary.
    ok(await daily.state());
    return { ...tools, persona, post };
  }

  it('skips a summary row of a post this PC did not write and keeps the rest strict', async () => {
    const { daily, ok, post, summary, rows } = await published();
    const shown = async () => ok(await daily.state()).posts.find((p) => p.id === post.id)?.replies;
    const row = { publicationId: rows[0].id, fetchedAt: '2026-11-21T06:00:00.000Z', count: 1 };
    summary.unshift({ ...row, postKey: '["sample","one"]' });
    summary[1].count = 4;
    expect(await shown()).toMatchObject({ count: 4 });
    // Any other malformed field still makes the whole summary untrusted; the last one stays.
    summary.push({ ...row, postKey: randomUUID(), count: -1 });
    summary[1].count = 5;
    expect(await shown()).toMatchObject({ count: 4 });
  });
  it('shows the replies of published posts from one summary read per look, and hides them on a server without replies', async () => {
    const { daily, server, ok, post, replyRequest } = await published();
    const shown = async () => ok(await daily.state()).posts.find((p) => p.id === post.id)?.replies;
    replyRequest.mockClear();
    expect(await shown()).toEqual({
      fetchedAt: '2026-11-21T05:02:11.000Z',
      count: 3,
      fresh: 3,
      answers: { queued: 0, failed: 0, unknown: 0 },
    });
    expect(replyRequest.mock.calls.map((call) => call[1])).toEqual(['summary']);
    // Changes answer from the file without reading replies again.
    const [draft] = ok(await daily.generate({ personaId: post.personaId })).posts.filter(
      (p) => p.state === 'draft',
    );
    expect(draft.replies).toBeNull();
    expect(replyRequest).toHaveBeenCalledTimes(1);
    server.replies = 'down';
    expect(await shown()).toEqual({
      fetchedAt: '2026-11-21T05:02:11.000Z',
      count: 3,
      fresh: 3,
      answers: { queued: 0, failed: 0, unknown: 0 },
    });
    for (const missing of ['old', 'migration'] as const) {
      server.replies = 'up';
      expect(await shown()).not.toBeNull();
      server.replies = missing;
      expect(await shown()).toBeNull();
    }
    server.replies = 'auth';
    expect((await daily.state()).problem?.code).toBe('AUTH_REQUIRED');
  });
  it('writes one chosen reply in Korean, and leaves it out of the next whole run', async () => {
    const { daily, post, translateReplies } = await published();
    await daily.replies({ postId: post.id });
    const one = await daily.translateReplies({ postId: post.id, threadsId: '4' });
    expect(one.problem).toBeNull();
    expect(translateReplies).toHaveBeenCalledTimes(1);
    expect(translateReplies.mock.lastCall![2]).toEqual([{ id: '4', text: 'Me too' }]);
    expect(one.thread!.replies.map((r) => r.translation)).toEqual([null, null, null, '뜻: Me too']);
    // Already written, our own reply, a reply without text, an unknown one: nothing is asked.
    for (const threadsId of ['4', '2', '3', '999'])
      expect((await daily.translateReplies({ postId: post.id, threadsId })).problem?.code).toBe(
        'daily_replies_translated',
      );
    expect(
      (await daily.translateReplies({ postId: post.id, threadsId: 'x' })).problem,
    ).not.toBeNull();
    expect(translateReplies).toHaveBeenCalledTimes(1);
    // The whole run takes only what is left.
    await daily.translateReplies({ postId: post.id });
    expect(translateReplies.mock.lastCall![2]).toEqual([{ id: '1', text: 'Cute!' }]);
  });
  it('counts the replies that came since the window was last opened, and marks them while it is open', async () => {
    const { daily, ok, post, threads, rows, summary, userData } = await published();
    const shown = async () => ok(await daily.state()).posts.find((p) => p.id === post.id)?.replies;
    const fetched = (at: string, count: number) => {
      threads.get(rows[0].id)!.fetchedAt = at;
      Object.assign(summary[0], { fetchedAt: at, count });
    };
    const fresh = (result: Awaited<ReturnType<typeof daily.replies>>) =>
      result.thread!.replies.filter((r) => r.fresh).map((r) => r.threadsId);
    fetched('2026-11-21T08:30:00.000Z', 3);
    // Never opened: every reply by someone else is new, and the first look has nothing older.
    expect(await shown()).toMatchObject({ count: 3, fresh: 3 });
    expect(fresh(await daily.replies({ postId: post.id }))).toEqual(['1', '2', '3', '4']);
    expect(await shown()).toMatchObject({ count: 3, fresh: 0 });
    // The phone fetched again: two more by others and one of ours.
    const later = { postedAt: '2026-11-21T09:00:00.000Z' };
    threads
      .get(rows[0].id)!
      .replies.unshift(
        reply('7', 'New!', later),
        reply('6', 'Thanks', { ...later, ownedByMe: true, parentThreadsId: '1' }),
        reply('5', 'Same here', later),
      );
    fetched('2026-11-21T09:10:00.000Z', 5);
    expect(await shown()).toMatchObject({ count: 5, fresh: 2 });
    expect(fresh(await daily.replies({ postId: post.id }))).toEqual(['7', '6', '5']);
    expect(await shown()).toMatchObject({ count: 5, fresh: 0 });
    // Work in the open window keeps the marks; opening it again has nothing new.
    expect(fresh(await daily.translateReplies({ postId: post.id }))).toEqual(['7', '6', '5']);
    expect(fresh(await daily.replies({ postId: post.id }))).toEqual([]);
    const stored = JSON.parse(await readFile(join(userData, DAILY_FILE_NAME), 'utf8'))
      .partitions[0];
    expect(stored.replySeen).toEqual([
      { postId: post.id, fetchedAt: '2026-11-21T09:10:00.000Z', count: 5 },
    ]);
  });
  it("reads one post's replies with this PC's renderings, and drops a rendering once the reply changed", async () => {
    const { daily, post, threads, rows, translateReplies, userData } = await published();
    const first = await daily.replies({ postId: post.id });
    expect(first.problem).toBeNull();
    expect(first.thread).toMatchObject({ postId: post.id, rootThreadsId: '900' });
    expect(
      first.thread!.replies.map((r) => [r.threadsId, r.translation, r.hasLink, r.ownedByMe]),
    ).toEqual([
      ['1', null, true, false],
      ['2', null, true, true],
      ['3', null, true, false],
      ['4', null, false, false],
    ]);
    // Only other people's replies with text go to ChatGPT, newest first, with the post as context.
    const translated = await daily.translateReplies({ postId: post.id });
    expect(translated.problem).toBeNull();
    expect(translateReplies).toHaveBeenCalledWith(
      expect.objectContaining({ id: post.personaId }),
      post.text,
      [
        { id: '1', text: 'Cute!' },
        { id: '4', text: 'Me too' },
      ],
    );
    expect(translated.view.translatingRepliesPostId).toBeNull();
    expect(translated.thread!.replies.map((r) => r.translation)).toEqual([
      '뜻: Cute!',
      null,
      null,
      '뜻: Me too',
    ]);
    // The rendering is kept with the text it was written for; no copy of the replies is stored.
    const stored = JSON.parse(await readFile(join(userData, DAILY_FILE_NAME), 'utf8'))
      .partitions[0];
    expect(stored.replyNotes).toEqual([
      { postId: post.id, threadsId: '1', text: 'Cute!', translation: '뜻: Cute!' },
      { postId: post.id, threadsId: '4', text: 'Me too', translation: '뜻: Me too' },
    ]);
    expect(JSON.stringify(stored)).not.toContain('user1');
    threads.get(rows[0].id)!.replies[0] = reply('1', 'So cute!');
    const edited = await daily.replies({ postId: post.id });
    expect(edited.thread!.replies.map((r) => r.translation)).toEqual([
      null,
      null,
      null,
      '뜻: Me too',
    ]);
    await daily.translateReplies({ postId: post.id });
    expect(translateReplies.mock.lastCall![2]).toEqual([{ id: '1', text: 'So cute!' }]);
    const done = await daily.translateReplies({ postId: post.id });
    expect(done.problem?.code).toBe('daily_replies_translated');
    // A refusal still answers with the replies last read, so the window keeps showing them.
    expect(done.thread?.replies.map((r) => r.translation)).toEqual([
      '뜻: So cute!',
      null,
      null,
      '뜻: Me too',
    ]);
    expect(translateReplies).toHaveBeenCalledTimes(2);
  });
  it('writes replies in Korean only for a persona of another language, and refuses a malformed answer', async () => {
    const korean = await published('ko');
    expect((await korean.daily.translateReplies({ postId: korean.post.id })).problem?.code).toBe(
      'daily_input',
    );
    expect(korean.translateReplies).not.toHaveBeenCalled();
    const { daily, post, translateReplies, threads, rows } = await published();
    translateReplies.mockResolvedValueOnce([
      { id: '1', korean: ' ' },
      { id: '4', korean: '뜻' },
    ]);
    expect((await daily.translateReplies({ postId: post.id })).problem?.code).toBe(
      'daily_generation',
    );
    threads.get(rows[0].id)!.replies.push({ threadsId: 'not-a-number' });
    expect((await daily.replies({ postId: post.id })).problem?.code).toBe('INVALID_RESPONSE');
    expect((await daily.replies({ postId: randomUUID() })).problem?.code).toBe('daily_replies');
  });
  it('hands ChatGPT at most 4,000 characters of replies at once', () => {
    const replies = Array.from({ length: 9 }, (_, index) => ({
      threadsId: String(index + 1),
      parentThreadsId: '900',
      username: 'someone',
      text: 'あ'.repeat(500),
      translation: null,
      mediaType: 'TEXT_POST',
      hasLink: true,
      ownedByMe: false,
      postedAt: '2026-11-21T05:00:00.000Z',
    }));
    expect(dailyReplyBatch(replies).map((r) => r.threadsId)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
    ]);
    replies[0].translation = '뜻' as never;
    expect(dailyReplyBatch(replies)).toHaveLength(8);
    expect(dailyReplyBatch(replies)[0].threadsId).toBe('2');
  });
  it('opens on Threads only a reply of the replies last read', async () => {
    const { daily, post, openExternal } = await published();
    expect((await daily.openReplyLink({ postId: post.id, threadsId: '1' })).problem?.code).toBe(
      'link_invalid',
    );
    await daily.replies({ postId: post.id });
    expect(await daily.openReplyLink({ postId: post.id, threadsId: '1' })).toEqual({
      status: 'ok',
      problem: null,
    });
    expect(openExternal).toHaveBeenCalledWith('https://www.threads.com/@user1/post/1');
    for (const input of [
      { postId: post.id, threadsId: '4' },
      { postId: randomUUID(), threadsId: '1' },
      { postId: post.id, threadsId: '1', url: 'https://example.test' },
    ])
      expect((await daily.openReplyLink(input)).problem?.code).toBe('link_invalid');
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
  it('opens only Threads pages, whatever address a reply carries', async () => {
    const { daily, post, openExternal, threads, rows } = await published();
    const replies = threads.get(rows[0].id)!.replies;
    replies.push(
      reply('11', 'a', { permalink: 'https://evil.test/@user/post/11' }),
      reply('12', 'b', { permalink: 'https://threads.net.evil.test/@user/post/12' }),
      reply('13', 'c', { permalink: 'https://user@www.threads.com/@user/post/13' }),
      reply('14', 'd', { permalink: 'https://threads.net/@user/post/14' }),
    );
    await daily.replies({ postId: post.id });
    for (const threadsId of ['11', '12', '13'])
      expect(await daily.openReplyLink({ postId: post.id, threadsId })).toEqual({
        status: 'error',
        problem: {
          code: 'link_invalid',
          message: 'Threads 링크를 열 수 없습니다. 댓글 창을 다시 열어 주세요.',
        },
      });
    expect(openExternal).not.toHaveBeenCalled();
    expect((await daily.openReplyLink({ postId: post.id, threadsId: '14' })).status).toBe('ok');
    expect(openExternal).toHaveBeenCalledWith('https://threads.net/@user/post/14');
  });
  it('does not open the replies read for another user', async () => {
    const { daily, post, openExternal, client } = await published();
    await daily.replies({ postId: post.id });
    vi.mocked(client.getBusinessContext).mockResolvedValueOnce({ ownerId: 'employee-b' });
    expect((await daily.openReplyLink({ postId: post.id, threadsId: '1' })).problem?.code).toBe(
      'link_invalid',
    );
    vi.mocked(client.getBusinessContext).mockRejectedValueOnce(
      new ServiceApiError('직원 계정으로 다시 로그인해 주세요.', 'AUTH_REQUIRED', 401),
    );
    expect((await daily.openReplyLink({ postId: post.id, threadsId: '1' })).problem?.code).toBe(
      'link_invalid',
    );
    expect(openExternal).not.toHaveBeenCalled();
    expect((await daily.openReplyLink({ postId: post.id, threadsId: '1' })).status).toBe('ok');
  });
  it("counts writing replies in Korean as work from the server read to ChatGPT's answer, like a post's rendering", async () => {
    const { daily, post, replyRequest, translateReplies, translate } = await published();
    const seen: boolean[] = [];
    const read = replyRequest.getMockImplementation()!;
    replyRequest.mockImplementationOnce(async (...args) => {
      seen.push(daily.active);
      return read(...args);
    });
    translateReplies.mockImplementationOnce(async (_persona, _post, replies) => {
      seen.push(daily.active);
      return replies.map((item) => ({ id: item.id, korean: `뜻: ${item.text}` }));
    });
    const running = daily.translateReplies({ postId: post.id });
    seen.push(daily.active);
    expect((await running).problem).toBeNull();
    expect([...seen, daily.active]).toEqual([true, true, true, false]);
    seen.length = 0;
    translate.mockImplementationOnce(async (_persona, text) => {
      seen.push(daily.active);
      return `뜻: ${text}`;
    });
    const rendering = daily.translatePost({ postId: post.id });
    seen.push(daily.active);
    expect((await rendering).problem).toBeNull();
    expect([...seen, daily.active]).toEqual([true, true, false]);
  });

  describe('answers', () => {
    const done = (result: DailyRepliesResult) => {
      expect(result.problem).toBeNull();
      return result.thread!;
    };
    /** A published post whose replies window is open. */
    async function opened(language: 'ko' | 'en' = 'en') {
      const tools = await published(language);
      done(await tools.daily.replies({ postId: tools.post.id }));
      const publicationId = tools.rows[0].id;
      const stored = async (): Promise<Record<string, unknown>[]> =>
        JSON.parse(await readFile(join(tools.userData, DAILY_FILE_NAME), 'utf8')).partitions[0]
          .answers ?? [];
      const add = async (replyThreadsId: string, text: string, fromKorean = false) =>
        done(
          await tools.daily.addAnswer({ postId: tools.post.id, replyThreadsId, text, fromKorean }),
        ).answers.find((answer) => answer.replyThreadsId === replyThreadsId)!;
      const send = (...answerIds: string[]) =>
        tools.daily.sendAnswers({ postId: tools.post.id, answerIds });
      const card = async () =>
        tools.ok(await tools.daily.state()).posts.find((p) => p.id === tools.post.id)!.replies!
          .answers;
      return { ...tools, publicationId, stored, add, send, card };
    }

    it('writes a draft as written, or from Korean with only the Korean and the persona handed to ChatGPT', async () => {
      const { daily, post, add, composeAnswer, stored } = await opened();
      expect(await add('1', '  Thanks so much!  ')).toMatchObject({
        text: 'Thanks so much!',
        translation: null,
        state: 'draft',
        errorCode: null,
        postedBefore: false,
      });
      expect(composeAnswer).not.toHaveBeenCalled();
      expect(await add('4', '나도 그래요', true)).toMatchObject({
        text: 'EN reply: 나도 그래요',
        translation: '나도 그래요',
        state: 'draft',
      });
      // The reply being answered is never part of what ChatGPT reads.
      expect(composeAnswer).toHaveBeenCalledTimes(1);
      expect(composeAnswer.mock.calls[0]).toHaveLength(2);
      expect(composeAnswer.mock.calls[0][1]).toBe('나도 그래요');
      expect(JSON.stringify(composeAnswer.mock.calls)).not.toContain('Me too');
      for (const [replyThreadsId, text, fromKorean, code] of [
        ['1', 'Again', false, 'daily_answer_exists'],
        ['2', 'Hi', false, 'daily_input'],
        ['999', 'Hi', false, 'daily_reply'],
        ['3', '가'.repeat(201), true, 'daily_text'],
        ['3', ' ', false, 'daily_text'],
      ] as const) {
        const result = await daily.addAnswer({ postId: post.id, replyThreadsId, text, fromKorean });
        expect(result.problem?.code).toBe(code);
      }
      expect(composeAnswer).toHaveBeenCalledTimes(1);
      expect(await stored()).toHaveLength(2);
    });
    it('writes nothing from Korean for a Korean persona', async () => {
      const { daily, post, composeAnswer } = await opened('ko');
      const result = await daily.addAnswer({
        postId: post.id,
        replyThreadsId: '1',
        text: '고마워요',
        fromKorean: true,
      });
      expect(result.problem?.code).toBe('daily_input');
      expect(composeAnswer).not.toHaveBeenCalled();
    });
    it('edits and deletes drafts only, and an edit drops the Korean it was written from', async () => {
      const { daily, post, add, send, stored } = await opened();
      const a = await add('1', '고마워요', true);
      let thread = done(
        await daily.saveAnswer({ postId: post.id, answerId: a.id, text: ' EN reply: 고마워요 ' }),
      );
      expect(thread.answers[0].translation).toBe('고마워요');
      thread = done(
        await daily.saveAnswer({ postId: post.id, answerId: a.id, text: 'Thank you!' }),
      );
      expect(thread.answers[0]).toMatchObject({ text: 'Thank you!', translation: null });
      const b = await add('4', 'Same here');
      done(await send(b.id));
      expect(
        (await daily.saveAnswer({ postId: post.id, answerId: b.id, text: 'x' })).problem?.code,
      ).toBe('daily_answer_sent');
      expect((await daily.deleteAnswer({ postId: post.id, answerId: b.id })).problem?.code).toBe(
        'daily_answer_sent',
      );
      thread = done(await daily.deleteAnswer({ postId: post.id, answerId: a.id }));
      expect(thread.answers.map((answer) => answer.id)).toEqual([b.id]);
      expect((await stored()).map((answer) => answer.id)).toEqual([b.id]);
    });
    it('sends the drafts one by one in the order written, writing each send down first, and stops at the first refusal', async () => {
      const { add, send, stored, answers, answerFaults, beforeAnswer, publicationId, card } =
        await opened();
      const a = await add('1', 'One');
      const b = await add('3', 'Two');
      const c = await add('4', 'Three');
      const seen: unknown[] = [];
      beforeAnswer.mockImplementation(async (body) => {
        const { id } = body as { id: string };
        seen.push([id, (await stored()).find((answer) => answer.id === id)?.send]);
      });
      answerFaults.push(undefined, 'pending');
      const result = await send(c.id, a.id, b.id);
      expect(result.problem?.code).toBe('ANSWER_PENDING');
      expect(seen).toEqual([
        [a.id, { confirmed: false }],
        [b.id, { confirmed: false }],
      ]);
      expect(answers.get(publicationId)!.map((x) => [x.id, x.replyThreadsId, x.text])).toEqual([
        [a.id, '1', 'One'],
      ]);
      // The refused one goes back to a draft under its own id; the rest were not sent.
      expect(result.thread!.answers.map((x) => [x.id, x.state])).toEqual([
        [a.id, 'queued'],
        [b.id, 'draft'],
        [c.id, 'draft'],
      ]);
      expect((await stored()).map((x) => x.send)).toEqual([{ confirmed: true }, null, null]);
      const rest = done(await send(b.id, c.id));
      expect(rest.answers.map((x) => x.state)).toEqual(['queued', 'queued', 'queued']);
      // The card counts what waits on the phone.
      expect(await card()).toEqual({ queued: 3, failed: 0, unknown: 0 });
    });
    it('keeps a send whose answer was lost as unconfirmed and repeats it under the same id', async () => {
      const { daily, post, add, send, stored, answers, answerFaults, publicationId, replyRequest } =
        await opened();
      const a = await add('1', 'One');
      const b = await add('4', 'Two');
      answerFaults.push('lose', 'down');
      for (const id of [a.id, b.id]) {
        const result = await send(id);
        expect(result.problem?.code).toBe('SERVICE_UNAVAILABLE');
        expect(result.thread!.answers.find((x) => x.id === id)!.state).toBe('unconfirmed');
        expect((await stored()).find((x) => x.id === id)!.send).toEqual({ confirmed: false });
      }
      // The server decides: it kept the first and never got the second.
      let thread = done(await daily.replies({ postId: post.id }));
      expect(thread.answers.map((x) => [x.id, x.state])).toEqual([
        [a.id, 'queued'],
        [b.id, 'unconfirmed'],
      ]);
      expect((await stored()).map((x) => x.send)).toEqual([
        { confirmed: true },
        { confirmed: false },
      ]);
      thread = done(await send(b.id));
      expect(thread.answers.map((x) => x.state)).toEqual(['queued', 'queued']);
      expect(answers.get(publicationId)!.map((x) => x.id)).toEqual([a.id, b.id]);
      expect(
        replyRequest.mock.calls
          .filter((call) => call[1] === 'answer')
          .map((call) => (call[3] as { id: string }).id),
      ).toEqual([a.id, b.id, b.id]);
    });
    it("follows the server's states, and forgets an answer once it is on Threads", async () => {
      const { daily, post, add, send, stored, answers, publicationId, threads, card } =
        await opened();
      const a = await add('1', 'One');
      const b = await add('3', 'Two');
      const c = await add('4', 'Three');
      done(await send(a.id, b.id, c.id));
      const [ra, rb, rc] = answers.get(publicationId)!;
      Object.assign(ra, { status: 'failed', errorCode: 190 });
      rb.status = 'unknown';
      Object.assign(rc, { status: 'published', threadsId: '77' });
      threads
        .get(publicationId)!
        .replies.push(reply('77', 'Three', { ownedByMe: true, parentThreadsId: '4' }));
      const thread = done(await daily.replies({ postId: post.id }));
      expect(thread.answers.map((x) => [x.id, x.state, x.errorCode])).toEqual([
        [a.id, 'failed', 190],
        [b.id, 'unknown', null],
      ]);
      expect(thread.replies.find((r) => r.threadsId === '77')?.ownedByMe).toBe(true);
      expect((await stored()).map((x) => x.id)).toEqual([a.id, b.id]);
      expect(await card()).toEqual({ queued: 0, failed: 1, unknown: 1 });
    });
    it('cancels back to a draft under a new id, and notes a cancelled send the phone posted anyway', async () => {
      const { daily, post, add, send, stored, answers, answerFaults, publicationId } =
        await opened();
      const a = await add('1', 'One');
      done(await send(a.id));
      let thread = done(await daily.cancelAnswer({ postId: post.id, answerId: a.id }));
      const [draft] = thread.answers;
      expect(draft).toMatchObject({ replyThreadsId: '1', text: 'One', state: 'draft' });
      expect(draft.postedBefore).toBe(false);
      expect(draft.id).not.toBe(a.id);
      expect(answers.get(publicationId)![0]).toMatchObject({ id: a.id, status: 'cancelled' });
      expect((await stored())[0]).toMatchObject({ id: draft.id, send: null, cancelledIds: [a.id] });
      // The phone was already posting it.
      Object.assign(answers.get(publicationId)![0], { status: 'published', threadsId: '55' });
      thread = done(await daily.replies({ postId: post.id }));
      expect(thread.answers).toEqual([{ ...draft, postedBefore: true }]);
      // A cancel whose reply was lost is finished by the next read, again under a new id.
      done(await send(draft.id));
      answerFaults.push('lose');
      expect(
        (await daily.cancelAnswer({ postId: post.id, answerId: draft.id })).problem?.code,
      ).toBe('SERVICE_UNAVAILABLE');
      thread = done(await daily.replies({ postId: post.id }));
      expect(thread.answers).toEqual([expect.objectContaining({ state: 'draft', text: 'One' })]);
      expect(thread.answers[0].id).not.toBe(draft.id);
      expect((await stored())[0].cancelledIds).toEqual([a.id, draft.id]);
    });
    it('leaves an answer the phone already tried to the phone, and cancels one the server never got', async () => {
      const { daily, post, add, send, answers, answerFaults, publicationId, stored } =
        await opened();
      const a = await add('1', 'One');
      const b = await add('4', 'Two');
      done(await send(a.id));
      answers.get(publicationId)![0].status = 'unknown';
      const refused = await daily.cancelAnswer({ postId: post.id, answerId: a.id });
      expect(refused.problem?.code).toBe('ANSWER_NOT_CANCELLABLE');
      expect(refused.thread!.answers[0]).toMatchObject({ id: a.id, state: 'unknown' });
      answerFaults.push('down');
      expect((await send(b.id)).problem?.code).toBe('SERVICE_UNAVAILABLE');
      // Nothing of it reached the server, so it is a draft again under the same id: a first
      // request that arrives late is then the same answer, never a second one.
      let thread = done(await daily.cancelAnswer({ postId: post.id, answerId: b.id }));
      expect(thread.answers[1]).toEqual(
        expect.objectContaining({ id: b.id, state: 'draft', text: 'Two' }),
      );
      expect((await stored())[1]).toMatchObject({ id: b.id, send: null });
      expect((await stored())[1].cancelledIds).toBeUndefined();
      expect(answers.get(publicationId)!.map((x) => x.id)).toEqual([a.id]);
      done(await daily.saveAnswer({ postId: post.id, answerId: b.id, text: 'Two, edited' }));
      answers.get(publicationId)!.push({
        id: b.id,
        replyThreadsId: '4',
        text: 'Two',
        status: 'queued',
        threadsId: null,
        errorCode: null,
        createdAt: '2026-11-21T06:00:00.000Z',
        publishedAt: null,
      });
      // The server holds it after all: its state and its text win.
      thread = done(await daily.replies({ postId: post.id }));
      expect(thread.answers[1]).toEqual(
        expect.objectContaining({ id: b.id, state: 'queued', text: 'Two' }),
      );
      expect((await stored())[1]).toMatchObject({
        id: b.id,
        text: 'Two',
        send: { confirmed: true },
      });
    });
    it("shows a posted answer as the persona's reply before the replies are fetched again, once only", async () => {
      const { daily, post, add, send, answers, publicationId, threads } = await opened();
      const a = await add('1', 'One');
      const b = await add('4', 'Two');
      done(await send(a.id, b.id));
      const [ra, rb] = answers.get(publicationId)!;
      Object.assign(ra, {
        status: 'published',
        threadsId: '77',
        publishedAt: '2026-11-21T07:00:00.000Z',
      });
      // Confirmed by hand on the phone: no number yet.
      rb.status = 'published';
      const mine = (thread: DailyReplyThread) =>
        thread.replies
          .filter((r) => r.ownedByMe)
          .map((r) => [r.threadsId, r.parentThreadsId, r.text, r.fromAnswer ?? false]);
      let thread = done(await daily.replies({ postId: post.id }));
      expect(mine(thread)).toEqual([
        ['2', '1', 'Thank you', false],
        ['77', '1', 'One', true],
        [b.id, '4', 'Two', true],
      ]);
      expect(thread.replies.find((r) => r.threadsId === '77')).toMatchObject({
        hasLink: false,
        postedAt: '2026-11-21T07:00:00.000Z',
      });
      // Both replies may be answered again.
      expect(thread.answers).toEqual([]);
      // Once fetched, each shows as the stored reply only.
      threads
        .get(publicationId)!
        .replies.push(
          reply('77', 'One', { ownedByMe: true, parentThreadsId: '1' }),
          reply('78', ' Two ', { ownedByMe: true, parentThreadsId: '4' }),
        );
      thread = done(await daily.replies({ postId: post.id }));
      expect(mine(thread)).toEqual([
        ['2', '1', 'Thank you', false],
        ['77', '1', 'One', false],
        ['78', '4', ' Two ', false],
      ]);
    });
    it('settles the answers on every read of a post, writing replies in Korean too', async () => {
      const { daily, post, add, send, answers, publicationId, stored } = await opened();
      const a = await add('1', 'One');
      done(await send(a.id));
      answers.get(publicationId)![0].status = 'published';
      const translated = await daily.translateReplies({ postId: post.id });
      expect(translated.problem).toBeNull();
      expect(await stored()).toEqual([]);
    });
    it('keeps the replies read for each post apart, so a late read of another does not replace them', async () => {
      const tools = await opened();
      const { daily, post, rows, summary, threads, ok, persona } = tools;
      const other = ok(await daily.state()).posts.find(
        (p) => p.personaId === persona.id && p.state === 'draft',
      )!;
      ok(await daily.send({ postId: other.id }));
      rows[1].rootStatus = 'published';
      summary.push({
        postKey: other.id,
        publicationId: rows[1].id,
        fetchedAt: '2026-11-21T05:02:11.000Z',
        count: 1,
      });
      threads.set(rows[1].id, {
        fetchedAt: '2026-11-21T05:02:11.000Z',
        rootThreadsId: '901',
        replies: [reply('21', 'Hello', { parentThreadsId: '901' })],
      });
      ok(await daily.state());
      done(await daily.replies({ postId: other.id }));
      // The window of the first post answers late, after the other one opened.
      done(await daily.replies({ postId: post.id }));
      const added = await daily.addAnswer({
        postId: other.id,
        replyThreadsId: '21',
        text: 'Hi!',
        fromKorean: false,
      });
      expect(added.problem).toBeNull();
      expect(added.thread!.answers.map((x) => x.replyThreadsId)).toEqual(['21']);
      expect((await daily.openReplyLink({ postId: other.id, threadsId: '21' })).status).toBe('ok');
      expect((await daily.openReplyLink({ postId: post.id, threadsId: '1' })).status).toBe('ok');
    });
    it('updates the card from the read after a send or a cancel, without reading the summary again', async () => {
      const { daily, post, add, send, replyRequest } = await opened();
      const a = await add('1', 'One');
      replyRequest.mockClear();
      const card = (result: DailyRepliesResult) =>
        result.view.posts.find((p) => p.id === post.id)!.replies!.answers;
      expect(card(await send(a.id))).toEqual({ queued: 1, failed: 0, unknown: 0 });
      expect(card(await daily.cancelAnswer({ postId: post.id, answerId: a.id }))).toEqual({
        queued: 0,
        failed: 0,
        unknown: 0,
      });
      expect(replyRequest.mock.calls.map((call) => call[1])).not.toContain('summary');
    });
    it('shows an unfinished answer only the server holds, and can take it back', async () => {
      const { daily, post, answers, publicationId, stored } = await opened();
      const id = randomUUID();
      answers.set(publicationId, [
        {
          id,
          replyThreadsId: '4',
          text: 'From elsewhere',
          status: 'failed',
          threadsId: null,
          errorCode: 100,
          createdAt: '2026-11-21T06:00:00.000Z',
          publishedAt: null,
        },
      ]);
      let thread = done(await daily.replies({ postId: post.id }));
      expect(thread.answers).toEqual([
        {
          id,
          replyThreadsId: '4',
          text: 'From elsewhere',
          translation: null,
          state: 'failed',
          errorCode: 100,
          postedBefore: false,
        },
      ]);
      thread = done(await daily.cancelAnswer({ postId: post.id, answerId: id }));
      expect(thread.answers).toEqual([]);
      expect(await stored()).toEqual([]);
    });
    it('keeps a persona while an answer is on the phone, and deletes its drafts and renderings with it', async () => {
      const { daily, post, persona, add, send, userData, ok } = await opened();
      ok(await daily.translateReplies({ postId: post.id }));
      const a = await add('1', 'One');
      await add('4', 'Two');
      done(await send(a.id));
      const refused = await daily.deletePersona({ personaId: persona.id });
      expect(refused.problem).toEqual({
        code: 'daily_persona_answers',
        message: '답글을 먼저 취소하거나 올려 주세요.',
      });
      done(await daily.cancelAnswer({ postId: post.id, answerId: a.id }));
      ok(await daily.deletePersona({ personaId: persona.id }));
      const file = JSON.parse(await readFile(join(userData, DAILY_FILE_NAME), 'utf8'))
        .partitions[0];
      expect(file.posts).toEqual([]);
      expect(file.answers).toEqual([]);
      expect(file.replyNotes).toEqual([]);
    });
  });
});

describe('daily storage boundaries', () => {
  it('keeps each service and user apart and never overwrites a file it cannot read', async () => {
    const { daily, userData, persona } = await setup();
    await persona();
    const store = new DailyStore(userData);
    expect(
      (await store.read({ service: 'https://other.test', ownerId: 'employee-a' })).personas,
    ).toEqual([]);
    expect(
      (await store.read({ service: 'https://service.test', ownerId: 'employee-a' })).personas,
    ).toHaveLength(1);
    const path = join(userData, DAILY_FILE_NAME);
    await writeFile(path, '{"version":1,"partitions":"broken"}');
    const result = await daily.savePersona({
      name: '새 페르소나',
      accountId: 'account-b',
      language: 'ja',
      description: '설명',
    });
    expect(result.problem?.code).toBe('daily_storage');
    expect(await readFile(path, 'utf8')).toBe('{"version":1,"partitions":"broken"}');
  });
  it('reads posts of files written before topics, and refuses a stored topic Threads would not take', async () => {
    const { daily, userData, persona, ok } = await setup();
    const p = await persona();
    ok(await daily.generate({ personaId: p.id }));
    const path = join(userData, DAILY_FILE_NAME);
    const file = JSON.parse(await readFile(path, 'utf8'));
    expect(file.partitions[0].posts[0]).not.toHaveProperty('topic');
    expect(ok(await daily.state()).posts.map((post) => post.topic)).toEqual([null, null, null]);
    file.partitions[0].posts[0].topic = 'Mom Threads';
    file.partitions[0].posts[1].topic = null;
    await writeFile(path, JSON.stringify(file));
    expect(ok(await daily.state()).posts.map((post) => post.topic)).toEqual([
      'Mom Threads',
      null,
      null,
    ]);
    file.partitions[0].posts[0].topic = 'Mom.Threads';
    await writeFile(path, JSON.stringify(file));
    expect((await daily.state()).problem?.code).toBe('daily_storage');
  });
  it('preserves fields a later version added', async () => {
    const { daily, userData, persona, ok } = await setup();
    const p = await persona();
    const path = join(userData, DAILY_FILE_NAME);
    const file = JSON.parse(await readFile(path, 'utf8'));
    file.partitions[0].personas[0].future = { kept: true };
    await writeFile(path, JSON.stringify(file));
    ok(await daily.generate({ personaId: p.id }));
    const after = JSON.parse(await readFile(path, 'utf8'));
    expect(after.partitions[0].personas[0].future).toEqual({ kept: true });
    expect(after.partitions[0].posts).toHaveLength(3);
  });
  it('reads reply renderings beside a file of an earlier version and drops those whose post is gone', async () => {
    const { daily, userData, persona, ok } = await setup();
    const p = await persona();
    const [post] = ok(await daily.generate({ personaId: p.id })).posts;
    const path = join(userData, DAILY_FILE_NAME);
    const file = JSON.parse(await readFile(path, 'utf8'));
    expect(file.partitions[0].replyNotes).toBeUndefined();
    // An earlier version deleted a persona and kept the field it did not know.
    const kept = { postId: post.id, threadsId: '1', text: 'Cute!', translation: '귀엽다' };
    const left = { postId: randomUUID(), threadsId: '2', text: 'Hi', translation: '안녕' };
    file.partitions[0].replyNotes = [kept, left];
    await writeFile(path, JSON.stringify(file));
    ok(await daily.savePost({ postId: post.id, text: '고친 글' }));
    expect(JSON.parse(await readFile(path, 'utf8')).partitions[0].replyNotes).toEqual([kept]);
    file.partitions[0].replyNotes = [{ ...kept, translation: '' }];
    await writeFile(path, JSON.stringify(file));
    expect((await daily.state()).problem?.code).toBe('daily_storage');
  });
  it('keeps answers through a file an earlier version wrote back, and drops those whose post is gone', async () => {
    const { daily, userData, persona, ok } = await setup();
    const p = await persona();
    const [post] = ok(await daily.generate({ personaId: p.id })).posts;
    const path = join(userData, DAILY_FILE_NAME);
    const file = JSON.parse(await readFile(path, 'utf8'));
    expect(file.partitions[0].answers).toBeUndefined();
    const kept = {
      id: randomUUID(),
      postId: post.id,
      publicationId: randomUUID(),
      replyThreadsId: '17',
      text: 'Hi',
      translation: '안녕',
      createdAt: '2026-11-21T00:00:00.000Z',
      send: { confirmed: true },
      cancelledIds: [randomUUID()],
      future: { kept: true },
    };
    // An earlier version deleted a persona and kept the field it did not know.
    file.partitions[0].answers = [kept, { ...kept, id: randomUUID(), postId: randomUUID() }];
    await writeFile(path, JSON.stringify(file));
    ok(await daily.savePost({ postId: post.id, text: '고친 글' }));
    expect(JSON.parse(await readFile(path, 'utf8')).partitions[0].answers).toEqual([kept]);
    for (const broken of [
      [{ ...kept, send: {} }],
      [{ ...kept, replyThreadsId: 'x' }],
      [kept, kept],
    ]) {
      file.partitions[0].answers = broken;
      await writeFile(path, JSON.stringify(file));
      expect((await daily.state()).problem?.code).toBe('daily_storage');
    }
  });
});

describe('attachments of daily posts (2026-11-24)', () => {
  const scope = { service: 'https://service.test', ownerId: 'employee-a' };
  const version = async (userData: string) =>
    JSON.parse(await readFile(join(userData, DAILY_FILE_NAME), 'utf8')).version;
  const calls = (mock: { mock: { calls: unknown[][] } }, operation: string) =>
    mock.mock.calls.filter((call) => call[1] === operation);

  it('adds a post of attachments without text and marks the file for newer versions only', async () => {
    const { daily, ok, persona, stage, library, userData } = await setup();
    const mom = await persona();
    const { selectionId, ids } = stage('a.png', 'b.png', 'c.mp4');
    const post = ok(
      await daily.addPost({
        personaId: mom.id,
        text: '  ',
        fromKorean: false,
        media: [ids[2], ids[0]],
        selectionId,
      }),
    ).posts[0];
    expect(post.text).toBe('');
    expect(post.media).toEqual([
      { id: ids[2], kind: 'video', name: 'c.mp4', url: `threads-daily://file/${ids[2]}` },
      { id: ids[0], kind: 'image', name: 'a.png', url: `threads-daily://file/${ids[0]}` },
    ]);
    // The dialog's other file goes; the post keeps the two it chose.
    expect(library.commits).toEqual([{ selectionId, kept: [ids[2], ids[0]] }]);
    expect(await version(userData)).toBe(2);
    // Without attachments the text is required as before; unknown files are refused.
    expect(
      (await daily.addPost({ personaId: mom.id, text: ' ', fromKorean: false })).problem?.code,
    ).toBe('daily_text');
    expect(
      (
        await daily.addPost({
          personaId: mom.id,
          text: '글',
          fromKorean: false,
          media: ['f'.repeat(32)],
          selectionId,
        })
      ).problem?.code,
    ).toBe('daily_media');
    // A file that is gone is shown as such.
    library.missing.add(ids[0]);
    expect(ok(await daily.state()).posts[0].media[1].url).toBeNull();
  });

  it('edits a draft’s attachments and deletes the files it no longer has after saving', async () => {
    const { daily, ok, persona, stage, library } = await setup();
    const mom = await persona();
    const first = stage('a.png', 'b.png');
    const post = ok(
      await daily.addPost({
        personaId: mom.id,
        text: '사진 두 장',
        fromKorean: false,
        media: first.ids,
        selectionId: first.selectionId,
      }),
    ).posts[0];
    const second = stage('c.png');
    const saved = ok(
      await daily.savePost({
        postId: post.id,
        text: '사진 두 장',
        media: [first.ids[1], second.ids[0]],
        selectionId: second.selectionId,
      }),
    ).posts[0];
    expect(saved.media.map((file) => file.id)).toEqual([first.ids[1], second.ids[0]]);
    expect(library.removed).toEqual([first.ids[0]]);
    // Leaving `media` out keeps them; taking all away needs text again.
    expect(
      ok(await daily.savePost({ postId: post.id, text: '본문만 고침' })).posts[0].media,
    ).toHaveLength(2);
    expect((await daily.savePost({ postId: post.id, text: '', media: [] })).problem?.code).toBe(
      'daily_text',
    );
    expect(library.removed).toEqual([first.ids[0]]);
  });

  it('uploads one file per fresh address and completes the post', async () => {
    const {
      daily,
      ok,
      persona,
      stage,
      creates,
      publicationRequest,
      upload,
      onUpload,
      workDirectory,
    } = await setup();
    const mom = await persona();
    const { selectionId, ids } = stage('a.png', 'b.mp4');
    const post = ok(
      await daily.addPost({
        personaId: mom.id,
        text: '',
        fromKorean: false,
        media: ids,
        selectionId,
        topic: 'Mom Threads',
      }),
    ).posts[0];
    const sent = ok(await daily.send({ postId: post.id })).posts[0];
    expect(sent.state).toBe('waiting');
    const [request] = creates() as PublicationRequest[];
    // The server gets its own ids; the order and the bytes are the post's.
    expect(request.media.map((m) => [m.ordinal, m.kind, m.contentType])).toEqual([
      [0, 'image', 'image/png'],
      [1, 'video', 'video/mp4'],
    ]);
    expect(request.media.every((m) => !ids.includes(m.id))).toBe(true);
    expect(request.media[0].sha256).toBe(
      createHash('sha256').update(`bytes of ${ids[0]}`).digest('hex'),
    );
    expect(calls(publicationRequest, 'upload-urls').map((call) => call[3])).toEqual([
      { mediaIds: [request.media[0].id] },
      { mediaIds: [request.media[1].id] },
    ]);
    expect(upload.mock.calls.map((call) => call[1].id)).toEqual(request.media.map((m) => m.id));
    // Completing many files takes the server long: the wait grows with them.
    expect(calls(publicationRequest, 'complete')[0][4]).toEqual({ timeoutMs: 75_000 });
    expect(onUpload.mock.calls.map((call) => call[0])).toEqual([
      { postId: post.id, done: 0, total: 2 },
      { postId: post.id, done: 1, total: 2 },
      { postId: post.id, done: 2, total: 2 },
      null,
    ]);
    // The prepared copies do not stay.
    await expect(stat(await workDirectory.mock.results[0].value)).rejects.toThrow();
  });

  it('continues an interrupted upload with the same bytes and refuses changed ones', async () => {
    const { daily, ok, persona, stage, creates, upload, library, rows } = await setup();
    const mom = await persona();
    const { selectionId, ids } = stage('a.png', 'b.png');
    const post = ok(
      await daily.addPost({
        personaId: mom.id,
        text: '글',
        fromKorean: false,
        media: ids,
        selectionId,
      }),
    ).posts[0];
    upload.mockRejectedValueOnce(new ViewError('mobile_publication_upload', '끊겼습니다.'));
    expect((await daily.send({ postId: post.id })).problem?.code).toBe('mobile_publication_upload');
    expect(ok(await daily.state()).posts[0]).toMatchObject({
      state: 'waiting',
      note: 'unconfirmed',
    });
    expect(rows[0].status).toBe('uploading');
    // [다시 보내기] repeats the request and finishes the files.
    ok(await daily.send({ postId: post.id }));
    const [first, again] = creates() as PublicationRequest[];
    expect(again).toEqual(first);
    expect(rows[0].status).toBe('ready');
    // Bytes that differ from the first send are not uploaded for it.
    const other = stage('c.png');
    const next = ok(
      await daily.addPost({
        personaId: mom.id,
        text: '다른 글',
        fromKorean: false,
        media: other.ids,
        selectionId: other.selectionId,
      }),
    ).posts.find((item) => item.text === '다른 글')!;
    upload.mockRejectedValueOnce(new ViewError('mobile_publication_upload', '끊겼습니다.'));
    await daily.send({ postId: next.id });
    library.bytes.set(other.ids[0], 'changed');
    expect((await daily.send({ postId: next.id })).problem?.code).toBe('daily_media_changed');
  });

  it('turns a post back to a draft only when the server holds no request of it', async () => {
    const { daily, ok, persona, stage, server, rows } = await setup();
    const mom = await persona();
    const { selectionId, ids } = stage('a.png');
    const post = ok(
      await daily.addPost({
        personaId: mom.id,
        text: '',
        fromKorean: false,
        media: ids,
        selectionId,
      }),
    ).posts[0];
    server.storage = 'off';
    const refused = await daily.send({ postId: post.id });
    expect(refused.problem).toEqual({
      code: 'daily_storage_off',
      message: '서버의 파일 업로드 설정이 꺼져 있습니다. 관리자에게 확인해 주세요.',
    });
    expect(refused.view.posts[0].state).toBe('draft');
    expect(rows).toHaveLength(0);
    // Created first and refused while completing: the request is there, so the send stays.
    server.storage = 'off-at-complete';
    expect((await daily.send({ postId: post.id })).problem?.code).toBe('daily_storage_off');
    expect(ok(await daily.state()).posts[0]).toMatchObject({
      state: 'waiting',
      note: 'unconfirmed',
    });
    server.storage = 'on';
    expect(ok(await daily.send({ postId: post.id })).posts[0].note).toBeNull();
    expect(rows).toHaveLength(1);
  });

  it('reads an earlier cancelled send with other attachments and sends the post again', async () => {
    const { daily, ok, persona, stage, rows } = await setup();
    const mom = await persona();
    const first = stage('a.png');
    const post = ok(
      await daily.addPost({
        personaId: mom.id,
        text: '글',
        fromKorean: false,
        media: first.ids,
        selectionId: first.selectionId,
      }),
    ).posts[0];
    ok(await daily.send({ postId: post.id }));
    ok(await daily.cancelSend({ postId: post.id }));
    const second = stage('b.png');
    ok(
      await daily.savePost({
        postId: post.id,
        text: '글',
        media: second.ids,
        selectionId: second.selectionId,
      }),
    );
    expect(ok(await daily.send({ postId: post.id })).posts[0].state).toBe('waiting');
    expect(rows.map((row) => row.status)).toEqual(['cancelled', 'ready']);
    expect(ok(await daily.state()).posts[0].state).toBe('waiting');
  });

  it('deletes a published post with its answers and files, but not while it waits or has a sent answer', async () => {
    const { daily, ok, persona, stage, library, rows, userData } = await setup();
    const mom = await persona();
    const { selectionId, ids } = stage('a.png');
    const post = ok(
      await daily.addPost({
        personaId: mom.id,
        text: '글',
        fromKorean: false,
        media: ids,
        selectionId,
      }),
    ).posts[0];
    ok(await daily.send({ postId: post.id }));
    expect((await daily.deletePost({ postId: post.id })).problem?.code).toBe('daily_post_sent');
    rows[0].rootStatus = 'published';
    expect(ok(await daily.state()).posts[0].state).toBe('published');
    const store = new DailyStore(userData);
    const answer = {
      id: randomUUID(),
      postId: post.id,
      publicationId: rows[0].id,
      replyThreadsId: '123',
      text: '감사합니다',
      createdAt: '2026-11-24T00:00:00.000Z',
      send: { confirmed: true },
    };
    await store.update(scope, (partition) => {
      partition.answers = [answer];
      partition.replySeen = [{ postId: post.id, fetchedAt: '2026-11-24T00:00:00.000Z', count: 1 }];
    });
    expect((await daily.deletePost({ postId: post.id })).problem?.code).toBe('daily_post_answers');
    await store.update(scope, (partition) => {
      partition.answers = [{ ...answer, send: null }];
    });
    expect(ok(await daily.deletePost({ postId: post.id })).posts).toEqual([]);
    const after = await store.read(scope);
    expect([after.answers, after.replySeen]).toEqual([[], []]);
    expect(library.removed).toEqual(ids);
    // The file stays 2: the cancelled sends of attachments are still on the server.
    expect(await version(userData)).toBe(2);
  });

  it('refuses a server row of this send whose attachments differ from what was sent', async () => {
    const { daily, ok, persona, stage, rows } = await setup();
    const mom = await persona();
    const { selectionId, ids } = stage('a.png');
    const post = ok(
      await daily.addPost({
        personaId: mom.id,
        text: '글',
        fromKorean: false,
        media: ids,
        selectionId,
      }),
    ).posts[0];
    ok(await daily.send({ postId: post.id }));
    rows[0].media[0].sha256 = 'b'.repeat(64);
    expect((await daily.state()).problem?.code).toBe('INVALID_RESPONSE');
  });

  it('keeps a draft’s files without a work folder, but takes no new ones then', async () => {
    const { daily, ok, persona, stage, library } = await setup();
    const mom = await persona();
    const first = stage('a.png');
    const post = ok(
      await daily.addPost({
        personaId: mom.id,
        text: '글',
        fromKorean: false,
        media: first.ids,
        selectionId: first.selectionId,
      }),
    ).posts[0];
    library.ready = false;
    const saved = ok(await daily.savePost({ postId: post.id, text: '고친 글', media: first.ids }));
    expect(saved.posts[0]).toMatchObject({
      text: '고친 글',
      media: [{ id: first.ids[0], url: null }],
    });
    expect(saved.mediaReady).toBe(false);
    library.ready = true;
    const second = stage('b.png');
    library.ready = false;
    expect(
      (
        await daily.savePost({
          postId: post.id,
          text: '고친 글',
          media: [...first.ids, ...second.ids],
          selectionId: second.selectionId,
        })
      ).problem?.code,
    ).toBe('daily_media_unavailable');
  });

  it('cleans unsaved attachments only when daily.json was there before the sync wrote one', async () => {
    const { daily, ok, remote, media } = await setup();
    // A moved PC: the server has the persona, this PC has no daily.json yet.
    remote.push({
      id: randomUUID(),
      name: '아들맘',
      accountId: 'account-a',
      language: 'ko',
      description: '30세',
      createdAt: '2026-11-17T00:00:00.000Z',
    });
    expect(ok(await daily.state()).personas).toHaveLength(1);
    ok(await daily.state());
    expect(media.sweep).not.toHaveBeenCalled();
  });

  it('keeps posts without text out of Korean renderings and of the posts handed to the writer', async () => {
    const { daily, ok, stage, generate, translate } = await setup();
    const english = ok(
      await daily.savePersona({
        name: 'Mia',
        accountId: 'account-a',
        language: 'en',
        description: '나이: 30대',
      }),
    ).personas[0];
    const { selectionId, ids } = stage('a.png');
    const post = ok(
      await daily.addPost({
        personaId: english.id,
        text: '',
        fromKorean: true,
        media: ids,
        selectionId,
      }),
    ).posts[0];
    expect(post.text).toBe('');
    expect((await daily.translatePost({ postId: post.id })).problem?.code).toBe('daily_text');
    expect(translate).not.toHaveBeenCalled();
    ok(await daily.generate({ personaId: english.id }));
    expect(generate.mock.calls[0][1]).toEqual([]);
  });
});
