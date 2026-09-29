import { isValidElement, type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PostLinkResult } from '../shared/contracts';
import type { ThreadsPublication } from '../shared/threads-api';
import { ThreadsPublicationLink } from './ThreadsPublicationLink';

const { notify, setOpening } = vi.hoisted(() => ({ notify: vi.fn(), setOpening: vi.fn() }));
vi.mock('./toast', () => ({ useToast: () => notify }));
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useRef: () => ({ current: false }),
  useState: () => [false, setOpening],
}));
const openPublication = vi.fn<(input: { id: string }) => Promise<PostLinkResult>>();
beforeEach(() => {
  vi.clearAllMocks();
  openPublication.mockResolvedValue({ status: 'opened' });
  vi.stubGlobal('window', { threadsMedia: { openThreadsPublication: openPublication } });
});
afterEach(() => vi.unstubAllGlobals());

function publication(kind: 'post' | 'reply' = 'post'): ThreadsPublication {
  return {
    id: `local-${kind}-entry`,
    postKey: 'source:post',
    accountId: '123',
    username: 'publisher',
    kind,
    text: 'Saved caption',
    draftRevision: 1,
    commentUpdatedAt: null,
    status: 'published',
    remoteId: '456',
    createdAt: '2026-09-28T00:00:00Z',
    publishedAt: '2026-09-28T00:01:00Z',
    metrics: null,
    metricsUpdatedAt: null,
    problem: null,
    metricsProblem: null,
  };
}
function button(item = publication(), disabled = false) {
  const element = ThreadsPublicationLink({ item, disabled });
  const child = element?.props.children.find(
    (value: unknown) => isValidElement(value) && value.type === 'button',
  );
  expect(child).toBeDefined();
  return (
    child as ReactElement<{
      onClick: () => void;
      disabled: boolean;
      'aria-busy': boolean;
      href?: string;
    }>
  ).props;
}

it.each(['post', 'reply'] as const)(
  'opens a published %s using only its local history ID',
  async (kind) => {
    const item = publication(kind);
    const link = button(item);
    expect(link.href).toBeUndefined();
    expect(link.disabled).toBe(false);
    link.onClick();
    expect(openPublication).toHaveBeenCalledExactlyOnceWith({ id: item.id });
    expect(setOpening).toHaveBeenCalledWith(true);
    await vi.waitFor(() => expect(setOpening).toHaveBeenLastCalledWith(false));
    expect(notify).not.toHaveBeenCalled();
  },
);

it('blocks a second click until opening completes and permits the next click', async () => {
  let resolve!: (result: PostLinkResult) => void;
  openPublication.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const link = button();
  link.onClick();
  link.onClick();
  expect(openPublication).toHaveBeenCalledTimes(1);
  resolve({ status: 'opened' });
  await vi.waitFor(() => expect(setOpening).toHaveBeenLastCalledWith(false));
  link.onClick();
  expect(openPublication).toHaveBeenCalledTimes(2);
});

it('does not request a browser link while disabled', () => {
  const link = button(publication(), true);
  expect(link.disabled).toBe(true);
  link.onClick();
  expect(openPublication).not.toHaveBeenCalled();
  expect(setOpening).not.toHaveBeenCalled();
});

it('reports a permalink failure through the toast and permits retry', async () => {
  const problem = { code: 'threads_link', message: '게시글 링크를 확인하지 못했습니다.' };
  openPublication.mockResolvedValueOnce({ status: 'error', problem });
  const link = button();
  link.onClick();
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledExactlyOnceWith({ message: problem.message, error: true }),
  );
  expect(setOpening).toHaveBeenLastCalledWith(false);
  link.onClick();
  expect(openPublication).toHaveBeenCalledTimes(2);
});

it('reports an IPC rejection through the toast without exposing raw errors', async () => {
  openPublication.mockRejectedValueOnce(new Error('internal IPC details'));
  button().onClick();
  await vi.waitFor(() =>
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      message: '게시글 링크를 열지 못했습니다. 다시 시도하세요.',
      error: true,
    }),
  );
  expect(setOpening).toHaveBeenLastCalledWith(false);
});
