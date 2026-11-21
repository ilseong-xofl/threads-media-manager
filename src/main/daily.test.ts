import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DailyDraft, DailyPersona, DailyResult } from '../shared/daily';
import type { MobilePublication } from '../shared/mobile-publications';
import { ViewError } from './collection';
import { DailyController, dailyReplyBatch } from './daily';
import { DAILY_FILE_NAME, DailyStore } from './daily-store';
import type { PublicationRequest } from './mobile-publication-data';
import { ServiceApiError, type ServiceApiClient } from './service-api';

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
  };
  /** The server's reply summary and the replies of each publication. */
  const summary: { postKey: string; publicationId: string; fetchedAt: string; count: number }[] =
    [];
  const threads = new Map<
    string,
    { fetchedAt: string | null; rootThreadsId: string; replies: unknown[] }
  >();
  const replyRequest = vi.fn(async (_context: unknown, operation: string, id?: string) => {
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
        posts: summary.map((row) => ({ ...row, answers: { queued: 0, failed: 0, unknown: 0 } })),
      };
    const thread = threads.get(id!);
    if (!thread) throw new ServiceApiError('댓글을 찾을 수 없습니다.', 'NOT_FOUND', 404);
    return { ...thread, answers: [] };
  });
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
          row = {
            id: randomUUID(),
            requestId: request.requestId,
            version: 1,
            accountId: request.accountId,
            source: request.source,
            status: 'ready',
            caption: request.caption,
            comment: null,
            media: [],
            sentAt: '2026-11-17T01:00:00.000Z',
            deadlineAt: '2026-11-24T01:00:00.000Z',
            rootStatus: 'queued',
            commentStatus: 'not_required',
          };
          rows.push(row);
        }
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
    managedThreadsRequest: vi.fn(async () => ({ accounts })),
    publicationRequest,
    personaRequest,
    replyRequest,
  } as unknown as Pick<
    ServiceApiClient,
    | 'getBusinessContext'
    | 'assertBusinessContext'
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
  const openExternal = vi.fn<(url: string) => Promise<void>>(async () => {});
  let tick = 0;
  const daily = new DailyController({
    client,
    store: new DailyStore(userData),
    service: 'https://service.test',
    generate,
    translate,
    compose,
    translateReplies,
    openExternal,
    now: () => new Date(Date.UTC(2026, 10, 17, 0, 0, tick++)),
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

  it('shows the replies of published posts from one summary read per look, and hides them on a server without replies', async () => {
    const { daily, server, ok, post, replyRequest } = await published();
    const shown = async () => ok(await daily.state()).posts.find((p) => p.id === post.id)?.replies;
    replyRequest.mockClear();
    expect(await shown()).toEqual({ fetchedAt: '2026-11-21T05:02:11.000Z', count: 3 });
    expect(replyRequest.mock.calls.map((call) => call[1])).toEqual(['summary']);
    // Changes answer from the file without reading replies again.
    const [draft] = ok(await daily.generate({ personaId: post.personaId })).posts.filter(
      (p) => p.state === 'draft',
    );
    expect(draft.replies).toBeNull();
    expect(replyRequest).toHaveBeenCalledTimes(1);
    server.replies = 'down';
    expect(await shown()).toEqual({ fetchedAt: '2026-11-21T05:02:11.000Z', count: 3 });
    for (const missing of ['old', 'migration'] as const) {
      server.replies = 'up';
      expect(await shown()).not.toBeNull();
      server.replies = missing;
      expect(await shown()).toBeNull();
    }
    server.replies = 'auth';
    expect((await daily.state()).problem?.code).toBe('AUTH_REQUIRED');
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
    expect(done.thread).toBeNull();
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
});
