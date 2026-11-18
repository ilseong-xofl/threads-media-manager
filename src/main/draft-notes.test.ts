import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectionView, Post, PostDraft } from '../shared/contracts';
import type { MobilePublication, PendingMobilePublication } from '../shared/mobile-publications';
import { lockedPublicationAccount } from '../shared/mobile-publications';
import { DRAFT_NOTE_FILE_NAME, DraftNoteStore } from './draft-note-store';
import { DraftNotes } from './draft-notes';
import type { ServiceApiClient } from './service-api';

const LIBRARY = 'a'.repeat(32);
const KEY = '["sample","post"]';
const CREATED = '2026-11-18T01:00:00.000Z';
const context = { ownerId: 'user-1' };
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const draft = (revision = 1, createdAt = CREATED): PostDraft => ({
  caption: 'caption',
  mediaIds: ['b'.repeat(32)],
  createdAt,
  updatedAt: createdAt,
  revision,
});
const post = (value?: PostDraft, commentUpdatedAt?: string): Post =>
  ({
    key: KEY,
    account: 'sample',
    postId: 'post',
    caption: '원문',
    ...(value ? { draft: value } : {}),
    ...(commentUpdatedAt
      ? { comment: { caption: '댓글', link: '', updatedAt: commentUpdatedAt } }
      : {}),
  }) as unknown as Post;
const view = (item: Post): CollectionView =>
  ({ error: null, snapshot: { libraryId: LIBRARY, posts: [item] } }) as unknown as CollectionView;
const account = (id: string) => ({
  id,
  ownerId: context.ownerId,
  label: id,
  registrationId: `registration-${id}`,
  appName: 'App',
  appId: null,
  threadsUserId: null,
  validationStatus: 'reported_valid',
  tokenRevision: 1,
  lifecycleVersion: 1,
  ownershipVersion: 1,
  expiresAt: null,
  validatedAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
});
const publication = (change: Partial<MobilePublication> = {}): MobilePublication => ({
  id: 'publication-1',
  requestId: '11111111-1111-4111-8111-111111111111',
  version: 1,
  accountId: 'account-a',
  source: {
    libraryId: LIBRARY,
    postKey: KEY,
    draftCreatedAt: CREATED,
    draftRevision: 1,
    commentUpdatedAt: null,
  },
  status: 'published',
  caption: 'caption',
  comment: null,
  media: [],
  sentAt: CREATED,
  deadlineAt: null,
  rootStatus: 'published',
  commentStatus: 'not_required',
  ...change,
});

async function setup(accounts: unknown[] = [account('account-a'), account('account-b')]) {
  const userData = await mkdtemp(join(tmpdir(), 'tmm-notes-'));
  directories.push(userData);
  const history = {
    publications: [] as MobilePublication[],
    pending: [] as PendingMobilePublication[],
  };
  const client = {
    getBusinessContext: vi.fn(async () => context),
    assertBusinessContext: vi.fn(),
    managedThreadsRequest: vi.fn(async () => ({ accounts })),
  } as unknown as Pick<
    ServiceApiClient,
    'getBusinessContext' | 'assertBusinessContext' | 'managedThreadsRequest'
  >;
  const notes = new DraftNotes({
    client,
    store: new DraftNoteStore(userData),
    service: 'https://service.test',
    history: async () => history,
  });
  const read = async (item: Post) => {
    const result = await notes.read(view(item), { postKey: KEY });
    if (result.status !== 'ok') throw new Error(result.problem.code);
    return result.note;
  };
  return { notes, history, userData, read, context };
}

describe('the account a publication history holds', () => {
  it('counts only the same registration and every state that may have reached Threads', () => {
    const lock = (change: Partial<MobilePublication>) =>
      lockedPublicationAccount([publication(change)], [], CREATED);
    for (const status of ['uploading', 'ready', 'started', 'published'] as const)
      expect(lock({ status, rootStatus: 'queued' })).toBe('account-a');
    // A copy cancelled after the phone lost the answer may still be on Threads.
    for (const rootStatus of ['sending', 'unknown', 'uncertain', 'published'])
      expect(lock({ status: 'cancelled', rootStatus })).toBe('account-a');
    for (const rootStatus of ['queued', 'cancelled', 'failed'])
      expect(lock({ status: 'cancelled', rootStatus })).toBeNull();
    expect(lock({ status: 'expired', rootStatus: 'queued' })).toBeNull();
    // The same post registered again is another registration.
    expect(lockedPublicationAccount([publication()], [], '2026-11-19T00:00:00.000Z')).toBeNull();
    const pending = [
      { requestId: 'r', accountId: 'account-b', source: publication().source },
    ] as PendingMobilePublication[];
    expect(lockedPublicationAccount([], pending, CREATED)).toBe('account-b');
  });
});

describe('draft notes', () => {
  it('holds an account only for the revision it was saved with', async () => {
    const { notes, read } = await setup();
    expect(await read(post(draft(1)))).toEqual({
      accountId: null,
      translation: null,
      commentTranslation: null,
    });
    expect(await notes.recordDraft(LIBRARY, KEY, draft(1), 'account-b', '뜻')).toBe(true);
    expect(await read(post(draft(1)))).toMatchObject({ accountId: 'account-b', translation: '뜻' });
    // A restore or a save whose note failed leaves another revision: nothing is on record.
    expect(await read(post(draft(2)))).toMatchObject({ accountId: null, translation: null });
    // Registered again: another registration.
    expect(await read(post(draft(1, '2026-11-19T00:00:00.000Z')))).toMatchObject({
      accountId: null,
    });
    expect(await read(post())).toMatchObject({ accountId: null });
  });

  it('keeps the rendering of a comment only while that comment is the saved one', async () => {
    const { notes, read } = await setup();
    const at = '2026-11-18T02:00:00.000Z';
    await notes.recordDraft(LIBRARY, KEY, draft(1), 'account-a', null);
    await notes.recordComment(
      LIBRARY,
      post(draft(1)),
      { caption: 'c', link: '', updatedAt: at },
      '댓글 뜻',
    );
    expect(await read(post(draft(1), at))).toEqual({
      accountId: 'account-a',
      translation: null,
      commentTranslation: '댓글 뜻',
    });
    expect((await read(post(draft(1), '2026-11-18T03:00:00.000Z'))).commentTranslation).toBeNull();
    // A draft revision does not touch the comment's rendering, and the other way round.
    expect((await read(post(draft(2), at))).commentTranslation).toBe('댓글 뜻');
    await notes.recordComment(
      LIBRARY,
      post(draft(1)),
      { caption: 'c', link: '', updatedAt: at },
      null,
    );
    expect(await read(post(draft(1), at))).toMatchObject({
      accountId: 'account-a',
      commentTranslation: null,
    });
  });

  it('accepts only an own account and keeps the account of a sent post', async () => {
    const { notes, history } = await setup();
    await expect(notes.requireAccount(LIBRARY, post(), 'account-a')).resolves.toBeUndefined();
    await expect(notes.requireAccount(LIBRARY, post(), 'someone-else')).rejects.toMatchObject({
      code: 'draft_account',
    });
    history.publications = [publication()];
    await expect(
      notes.requireAccount(LIBRARY, post(draft(2)), 'account-a'),
    ).resolves.toBeUndefined();
    await expect(notes.requireAccount(LIBRARY, post(draft(2)), 'account-b')).rejects.toMatchObject({
      code: 'draft_account_locked',
    });
    // History of an earlier registration of the same post holds nothing.
    await expect(
      notes.requireAccount(LIBRARY, post(draft(1, '2026-11-19T00:00:00.000Z')), 'account-b'),
    ).resolves.toBeUndefined();
  });

  it('sends only to the account on record and records one for a post that has none', async () => {
    const { notes, read, context: owner } = await setup();
    const empty = { publications: [], pending: [] };
    const item = post(draft(1));
    await notes.confirmSendAccount(owner, LIBRARY, item, 'account-b', empty);
    expect((await read(item)).accountId).toBe('account-b');
    await expect(
      notes.confirmSendAccount(owner, LIBRARY, item, 'account-a', empty),
    ).rejects.toMatchObject({ code: 'mobile_publication_account_changed' });
    await expect(
      notes.confirmSendAccount(owner, LIBRARY, item, 'account-b', empty),
    ).resolves.toBeUndefined();
    // What was already sent for this registration wins over the note.
    await expect(
      notes.confirmSendAccount(owner, LIBRARY, item, 'account-b', {
        publications: [publication()],
        pending: [],
      }),
    ).rejects.toMatchObject({ code: 'mobile_publication_account_changed' });
  });

  it('forgets a deleted registration and never overwrites a file it cannot read', async () => {
    const { notes, read, userData, context } = await setup();
    await notes.recordDraft(LIBRARY, KEY, draft(1), 'account-a', null);
    await notes.forget(LIBRARY, post(draft(1)));
    expect((await read(post(draft(1)))).accountId).toBeNull();
    const path = join(userData, DRAFT_NOTE_FILE_NAME);
    await writeFile(path, '{ broken');
    expect(await notes.recordDraft(LIBRARY, KEY, draft(1), 'account-a', null)).toBe(false);
    // An unreadable record is an error to show, and nothing is sent on a guess.
    await expect(notes.read(view(post(draft(1))), { postKey: KEY })).resolves.toMatchObject({
      status: 'error',
      problem: { code: 'draft_note_storage' },
    });
    await expect(
      notes.confirmSendAccount(context, LIBRARY, post(draft(1)), 'account-a', {
        publications: [],
        pending: [],
      }),
    ).rejects.toMatchObject({ code: 'mobile_publication_account_unknown' });
    expect(await readFile(path, 'utf8')).toBe('{ broken');
  });

  it('keeps notes of different users apart', async () => {
    const { notes, userData } = await setup();
    await notes.recordDraft(LIBRARY, KEY, draft(1), 'account-a', null);
    const other = new DraftNotes({
      client: {
        getBusinessContext: async () => ({ ownerId: 'user-2' }),
        assertBusinessContext: () => {},
        managedThreadsRequest: async () => ({ accounts: [] }),
      } as never,
      store: new DraftNoteStore(userData),
      service: 'https://service.test',
      history: async () => ({ publications: [], pending: [] }),
    });
    const result = await other.read(view(post(draft(1))), { postKey: KEY });
    expect(result).toEqual({
      status: 'ok',
      note: { accountId: null, translation: null, commentTranslation: null },
    });
  });
});
