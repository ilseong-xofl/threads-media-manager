import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DailyDraft, DailyPersona, DailyResult } from '../shared/daily';
import type { MobilePublication } from '../shared/mobile-publications';
import { ViewError } from './collection';
import { DailyController } from './daily';
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
  const server = { offline: false };
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
  } as unknown as Pick<
    ServiceApiClient,
    'getBusinessContext' | 'assertBusinessContext' | 'publicationRequest' | 'managedThreadsRequest'
  >;
  const drafts = (...texts: string[]): DailyDraft[] =>
    texts.map((text) => ({ text, translation: null }));
  const generate = vi.fn<(persona: DailyPersona, recentPosts: string[]) => Promise<DailyDraft[]>>(
    async () => drafts('첫 번째 글', '두 번째 글', '세 번째 글'),
  );
  const translate = vi.fn<(persona: DailyPersona, text: string) => Promise<string>>(
    async (_persona, text) => `뜻: ${text}`,
  );
  const compose = vi.fn<(persona: DailyPersona, korean: string) => Promise<string>>(
    async (_persona, korean) => `EN: ${korean}`,
  );
  let tick = 0;
  const daily = new DailyController({
    client,
    store: new DailyStore(userData),
    service: 'https://service.test',
    generate,
    translate,
    compose,
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
    publicationRequest,
    generate,
    translate,
    compose,
    userData,
    ok,
    persona,
    draft,
    creates,
  };
}

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
      [{ personaId: english.id, text: '글' }, 'daily_input'],
      [{ personaId: randomUUID(), text: '글', fromKorean: false }, 'daily_persona'],
    ] as const)
      expect((await daily.addPost(input)).problem?.code).toBe(code);
    compose.mockRejectedValueOnce(new ViewError('codex_login', 'ChatGPT에 로그인하세요.'));
    const failed = await daily.addPost({ personaId: english.id, text: '글', fromKorean: true });
    expect(failed.problem?.code).toBe('codex_login');
    expect(failed.view.posts).toHaveLength(2);
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
});
