import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC, type ThreadsMediaApi } from '../shared/contracts';
import { AUTH_STATE_CHANGED } from '../shared/service-auth';

const electron = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(),
  extract: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
  webUtils: { getPathForFile: electron.extract },
}));
import './index';
const api = electron.expose.mock.calls[0][1] as ThreadsMediaApi;
it('exposes only fixed publication actions, never direct URL or file-path upload calls', async () => {
  const send = {
    postKey: 'post',
    expectedRevision: 1,
    expectedDraftCreatedAt: '2026-10-19T00:00:00Z',
    expectedCommentUpdatedAt: null,
    accountId: 'account',
  };
  await api.sendMobilePublication(send);
  expect(electron.invoke).toHaveBeenLastCalledWith(IPC.sendMobilePublication, send);
  await api.getMobilePublications({ postKey: 'post' });
  expect(electron.invoke).toHaveBeenLastCalledWith(IPC.mobilePublications, { postKey: 'post' });
  await api.getMobilePublicationStatuses();
  expect(electron.invoke).toHaveBeenLastCalledWith(IPC.mobilePublicationStatuses);
  await api.cancelPendingMobilePublication({ requestId: 'request' });
  expect(electron.invoke).toHaveBeenLastCalledWith(IPC.cancelPendingMobilePublication, {
    requestId: 'request',
  });
  expect(Object.keys(api)).not.toContain('publicationRequest');
  expect(Object.keys(api)).not.toContain('uploadPublicationFile');
});
it('reaches daily posts only through fixed channels that carry no account token or URL', async () => {
  await api.getDaily();
  expect(electron.invoke).toHaveBeenLastCalledWith(IPC.daily);
  const persona = {
    name: '이름',
    accountId: 'account',
    language: 'ko' as const,
    description: '설명',
  };
  await api.saveDailyPersona(persona);
  expect(electron.invoke).toHaveBeenLastCalledWith(IPC.saveDailyPersona, persona);
  await api.getMents();
  expect(electron.invoke).toHaveBeenLastCalledWith(IPC.ments);
  const brand = { kind: 'brand' as const, id: 'brand', name: '브랜드' };
  await api.saveMent(brand);
  expect(electron.invoke).toHaveBeenLastCalledWith(IPC.saveMent, brand);
  await api.deleteMent({ kind: 'brand', id: 'brand' });
  expect(electron.invoke).toHaveBeenLastCalledWith(IPC.deleteMent, { kind: 'brand', id: 'brand' });
  await api.generateDailyPosts({ personaId: 'persona' });
  expect(electron.invoke).toHaveBeenLastCalledWith(IPC.generateDailyPosts, {
    personaId: 'persona',
  });
  const added = { personaId: 'persona', text: '직접 쓴 글', fromKorean: true };
  await api.addDailyPost(added);
  expect(electron.invoke).toHaveBeenLastCalledWith(IPC.addDailyPost, added);
  await api.translateDailyPost({ postId: 'post' });
  expect(electron.invoke).toHaveBeenLastCalledWith(IPC.translateDailyPost, { postId: 'post' });
  await api.sendDailyPost({ postId: 'post' });
  expect(electron.invoke).toHaveBeenLastCalledWith(IPC.sendDailyPost, { postId: 'post' });
  await api.cancelDailySend({ postId: 'post', abandon: true });
  expect(electron.invoke).toHaveBeenLastCalledWith(IPC.cancelDailySend, {
    postId: 'post',
    abandon: true,
  });
  expect(IPC.daily).toBe('tmm:daily:state');
});
it('renames an account only through its fixed channel', async () => {
  const input = { accountId: 'account', label: '이름', appName: '앱' };
  await api.updateManagedThreadsAccount(input);
  expect(electron.invoke).toHaveBeenLastCalledWith(IPC.updateManagedThreadsAccount, input);
});
it('re-checks and refreshes a token only through fixed channels that carry no token', async () => {
  const input = { accountId: 'account' };
  await api.recheckManagedThreadsAccount(input);
  expect(electron.invoke).toHaveBeenLastCalledWith(IPC.recheckManagedThreadsAccount, input);
  await api.refreshManagedThreadsToken(input);
  expect(electron.invoke).toHaveBeenLastCalledWith(IPC.refreshManagedThreadsToken, input);
  expect(IPC.recheckManagedThreadsAccount).toBe('tmm:managed-threads:recheck');
  expect(IPC.refreshManagedThreadsToken).toBe('tmm:managed-threads:refresh-token');
});
beforeEach(() => {
  electron.invoke
    .mockReset()
    .mockResolvedValue({ status: 'selected', selectionId: 'a'.repeat(32), files: [] });
  electron.extract.mockReset();
});

describe('dropped File preload boundary', () => {
  it('extracts the whole File batch inside preload and forwards only its internal path payload', async () => {
    const files = [new File(['image'], 'image.png'), new File(['video'], 'video.mp4')];
    const current = { selectionId: 'a'.repeat(32), mediaIds: ['b'.repeat(32)] };
    electron.extract
      .mockReturnValueOnce('/chosen/image.png')
      .mockReturnValueOnce('/chosen/video.mp4');
    const result = await api.addLocalPostMedia(files, current);
    expect(electron.extract.mock.calls).toEqual([[files[0]], [files[1]]]);
    expect(electron.invoke).toHaveBeenCalledExactlyOnceWith(IPC.addLocalPostMedia, {
      paths: ['/chosen/image.png', '/chosen/video.mp4'],
      current,
    });
    expect(JSON.stringify(result)).not.toContain('/chosen/');
  });

  it('never invokes IPC when any File has no native path or extraction rejects a forged value', async () => {
    const native = new File(['image'], 'photo.png');
    const generated = new File(['image'], 'generated.png');
    electron.extract.mockReturnValueOnce('/chosen/photo.png').mockReturnValueOnce('');
    expect(await api.addLocalPostMedia([native, generated])).toMatchObject({
      status: 'error',
      problem: { code: 'local_post_drop' },
    });
    expect(electron.invoke).not.toHaveBeenCalled();
    electron.extract.mockImplementation(() => {
      throw new TypeError('Not a File');
    });
    expect(await api.addLocalPostMedia(['/secret/file.png' as unknown as File])).toMatchObject({
      status: 'error',
      problem: { code: 'local_post_drop' },
    });
    expect(electron.invoke).not.toHaveBeenCalled();
  });

  it('rejects empty or oversized batches before extracting anything', async () => {
    expect((await api.addLocalPostMedia([])).status).toBe('error');
    expect(
      (await api.addLocalPostMedia(Array.from({ length: 101 }, () => new File([], 'image.png'))))
        .status,
    ).toBe('error');
    expect(electron.extract).not.toHaveBeenCalled();
    expect(electron.invoke).not.toHaveBeenCalled();
  });

  it('hands a daily post dialog’s dropped Files over as native paths only (2026-11-24)', async () => {
    const files = [new File(['image'], 'image.png'), new File(['video'], 'video.mp4')];
    electron.extract
      .mockReturnValueOnce('/chosen/image.png')
      .mockReturnValueOnce('/chosen/video.mp4');
    await api.addDailyMedia({ selectionId: 'a'.repeat(32), room: 5, files });
    expect(electron.invoke).toHaveBeenCalledExactlyOnceWith(IPC.addDailyMedia, {
      selectionId: 'a'.repeat(32),
      room: 5,
      paths: ['/chosen/image.png', '/chosen/video.mp4'],
    });
    electron.invoke.mockClear();
    electron.extract.mockReturnValueOnce('');
    expect(
      await api.addDailyMedia({ room: 20, files: [new File(['x'], 'generated.png')] }),
    ).toMatchObject({ status: 'error', problem: { code: 'daily_media_drop' } });
    expect(
      (
        await api.addDailyMedia({
          room: 20,
          files: Array.from({ length: 21 }, () => new File([], 'image.png')),
        })
      ).status,
    ).toBe('error');
    expect(electron.invoke).not.toHaveBeenCalled();
  });
});

it('exposes only named auth calls and strips Electron event objects from notifications', async () => {
  await api.signIn('employee', 'password-123');
  expect(electron.invoke).toHaveBeenLastCalledWith(IPC.signIn, 'employee', 'password-123');
  await api.changePassword('password-123', 'new-password');
  expect(electron.invoke).toHaveBeenLastCalledWith(
    IPC.changePassword,
    'password-123',
    'new-password',
  );
  const listener = vi.fn();
  const remove = api.onAuthStateChanged(listener);
  const callback = electron.on.mock.calls.at(-1)![1];
  callback({ sender: 'privileged' }, { status: 'signed-out' });
  expect(listener).toHaveBeenCalledExactlyOnceWith({ status: 'signed-out' });
  remove();
  expect(electron.removeListener).toHaveBeenCalledWith(AUTH_STATE_CHANGED, callback);
  expect(Object.keys(api)).not.toContain('invoke');
  expect(Object.keys(api)).not.toContain('readToken');
  expect(Object.keys(api)).not.toContain('getCredential');
  expect(Object.keys(api)).not.toContain('managedThreadsRequest');
  expect(Object.keys(api)).not.toContain('fetch');
  expect(Object.keys(api)).not.toContain('openThreadsPublication');
});
