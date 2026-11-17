import { describe, expect, it, vi } from 'vitest';
import type { DailyResult, DailyView } from '../shared/daily';
import { createDailyController } from './use-daily';

const view = (name: string, generatingPersonaId: string | null = null): DailyView => ({
  personas: [
    { id: name, name, accountId: 'a', language: 'ko', description: '', createdAt: '2026-11-17' },
  ],
  posts: [],
  generatingPersonaId,
  translatingPostId: null,
});
const ok = (name: string): DailyResult => ({ status: 'ok', view: view(name), problem: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function setup() {
  const api = {
    getDaily: vi.fn().mockResolvedValue(ok('read')),
    saveDailyPersona: vi.fn().mockResolvedValue(ok('saved')),
    deleteDailyPersona: vi.fn().mockResolvedValue(ok('deleted')),
    generateDailyPosts: vi.fn().mockResolvedValue(ok('generated')),
    addDailyPost: vi.fn().mockResolvedValue(ok('added')),
    saveDailyPost: vi.fn().mockResolvedValue(ok('post')),
    translateDailyPost: vi.fn().mockResolvedValue(ok('translated')),
    deleteDailyPost: vi.fn().mockResolvedValue(ok('post-deleted')),
    sendDailyPost: vi.fn().mockResolvedValue(ok('sent')),
    cancelDailySend: vi.fn().mockResolvedValue(ok('cancelled')),
  };
  const effects = { notify: vi.fn() };
  return { api, effects, controller: createDailyController(api, effects) };
}
const shownName = (controller: ReturnType<typeof setup>['controller']) =>
  controller.getSnapshot().view.personas[0]?.name;
async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe('daily board requests', () => {
  it('calls nothing while disabled and reads once enabled', async () => {
    const { api, controller } = setup();
    expect(await controller.send('post-1')).toBe(false);
    expect(await controller.refresh()).toBe(false);
    expect(api.sendDailyPost).not.toHaveBeenCalled();
    controller.setEnabled(true);
    await settle();
    expect(api.getDaily).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({ loaded: true, busy: false });
    expect(shownName(controller)).toBe('read');
  });

  it('shows an error result’s problem as a toast and still applies its view', async () => {
    const { api, controller, effects } = setup();
    controller.setEnabled(true);
    await settle();
    api.sendDailyPost.mockResolvedValueOnce({
      status: 'error',
      view: view('after-error'),
      problem: { code: 'SEND_FAILED', message: '서버에 보내지 못했습니다.' },
    });
    expect(await controller.send('post-1')).toBe(false);
    expect(effects.notify).toHaveBeenCalledWith('서버에 보내지 못했습니다.', true);
    expect(shownName(controller)).toBe('after-error');
  });

  it('passes cancel input unchanged, including the confirmed abandon flag', async () => {
    const { api, controller } = setup();
    controller.setEnabled(true);
    await settle();
    await controller.cancel({ postId: 'post-1' });
    await controller.cancel({ postId: 'post-2', abandon: true });
    expect(api.cancelDailySend.mock.calls).toEqual([
      [{ postId: 'post-1' }],
      [{ postId: 'post-2', abandon: true }],
    ]);
  });

  it('writes the Korean rendering again after a post in another language is edited', async () => {
    const { api, controller } = setup();
    controller.setEnabled(true);
    await settle();
    const edited = (language: 'ko' | 'en', translation: string | null): DailyResult => ({
      status: 'ok',
      problem: null,
      view: {
        ...view('post'),
        personas: [{ ...view('post').personas[0], id: 'p1', language }],
        posts: [
          {
            id: 'post-1',
            personaId: 'p1',
            text: 'Edited',
            translation,
            createdAt: '2026-11-17',
            state: 'draft',
            note: null,
            started: false,
            sentAt: null,
          },
        ],
      },
    });
    // Unchanged text keeps its rendering, and a Korean persona never has one.
    api.saveDailyPost.mockResolvedValueOnce(edited('en', '고친 글'));
    expect(await controller.savePost('post-1', 'Edited')).toBe(true);
    api.saveDailyPost.mockResolvedValueOnce(edited('ko', null));
    expect(await controller.savePost('post-1', '고침')).toBe(true);
    await settle();
    expect(api.translateDailyPost).not.toHaveBeenCalled();
    const translated = deferred<DailyResult>();
    api.translateDailyPost.mockReturnValueOnce(translated.promise);
    api.saveDailyPost.mockResolvedValueOnce(edited('en', null));
    expect(await controller.savePost('post-1', 'Edited')).toBe(true);
    expect(api.translateDailyPost).toHaveBeenCalledExactlyOnceWith({ postId: 'post-1' });
    expect(controller.getSnapshot()).toMatchObject({ busy: false, translating: 'post-1' });
    // ChatGPT writes one thing at a time.
    expect(await controller.generate('p1')).toBe(false);
    translated.resolve(edited('en', '고친 글'));
    await settle();
    expect(controller.getSnapshot().translating).toBeNull();
    expect(controller.getSnapshot().view.posts[0].translation).toBe('고친 글');
    // A post written by hand in the persona's language gets its rendering the same way.
    controller.setEnabled(false);
    controller.setEnabled(true);
    await settle();
    api.translateDailyPost.mockClear();
    api.addDailyPost.mockResolvedValueOnce(edited('en', null));
    expect(await controller.addPost('p1', 'Edited', false)).toBe(true);
    expect(api.addDailyPost).toHaveBeenLastCalledWith({
      personaId: 'p1',
      text: 'Edited',
      fromKorean: false,
    });
    expect(api.translateDailyPost).toHaveBeenCalledExactlyOnceWith({ postId: 'post-1' });
    await settle();
  });
  it('has a Korean draft written in the persona language as one long call', async () => {
    const { api, controller } = setup();
    controller.setEnabled(true);
    await settle();
    const composed = deferred<DailyResult>();
    api.addDailyPost.mockReturnValueOnce(composed.promise);
    const adding = controller.addPost('p1', '한국어로 쓴 글', true);
    expect(controller.getSnapshot()).toMatchObject({ busy: false, composing: true });
    expect(await controller.generate('p1')).toBe(false);
    expect(await controller.addPost('p1', '또 다른 글', true)).toBe(false);
    composed.resolve(ok('added'));
    expect(await adding).toBe(true);
    expect(controller.getSnapshot().composing).toBe(false);
    expect(api.addDailyPost).toHaveBeenCalledExactlyOnceWith({
      personaId: 'p1',
      text: '한국어로 쓴 글',
      fromKorean: true,
    });
    expect(api.translateDailyPost).not.toHaveBeenCalled();
  });
  it('runs one change at a time but lets the board change while posts are generated', async () => {
    const { api, controller } = setup();
    controller.setEnabled(true);
    await settle();
    const generated = deferred<DailyResult>();
    api.generateDailyPosts.mockReturnValueOnce(generated.promise);
    const generating = controller.generate('p1');
    expect(controller.getSnapshot().generating).toBe('p1');
    expect(await controller.generate('p2')).toBe(false);
    const sent = deferred<DailyResult>();
    api.sendDailyPost.mockReturnValueOnce(sent.promise);
    const sending = controller.send('post-1');
    expect(controller.getSnapshot().busy).toBe(true);
    expect(await controller.deletePost('post-2')).toBe(false);
    sent.resolve(ok('sent'));
    expect(await sending).toBe(true);
    generated.resolve(ok('generated'));
    expect(await generating).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ busy: false, generating: null });
    expect(shownName(controller)).toBe('generated');
    expect(api.generateDailyPosts).toHaveBeenCalledOnce();
    expect(api.deleteDailyPost).not.toHaveBeenCalled();
  });

  it('drops a read that a finished change overtook', async () => {
    const { api, controller } = setup();
    controller.setEnabled(true);
    await settle();
    const read = deferred<DailyResult>();
    api.getDaily.mockReturnValueOnce(read.promise);
    const reading = controller.refresh();
    await controller.savePost('post-1', '본문');
    read.resolve(ok('stale-read'));
    expect(await reading).toBe(false);
    expect(shownName(controller)).toBe('post');
  });

  it('reads again once after refresh requests that arrived during a read', async () => {
    const { api, controller } = setup();
    const read = deferred<DailyResult>();
    api.getDaily.mockReturnValueOnce(read.promise);
    controller.setEnabled(true);
    await controller.refresh();
    await controller.refresh();
    read.resolve(ok('first'));
    await settle();
    expect(api.getDaily).toHaveBeenCalledTimes(2);
    expect(shownName(controller)).toBe('read');
  });

  it('ignores a result from before re-enabling and reads the current state instead', async () => {
    const { api, controller } = setup();
    controller.setEnabled(true);
    await settle();
    const generated = deferred<DailyResult>();
    api.generateDailyPosts.mockReturnValueOnce(generated.promise);
    const generating = controller.generate('p1');
    controller.setEnabled(false);
    controller.setEnabled(true);
    await settle();
    api.getDaily.mockResolvedValue(ok('fresh'));
    generated.resolve(ok('late'));
    expect(await generating).toBe(false);
    await settle();
    expect(shownName(controller)).toBe('fresh');
    expect(controller.getSnapshot().generating).toBeNull();
  });

  it('reports a lost answer and reads the board again', async () => {
    const { api, controller, effects } = setup();
    controller.setEnabled(true);
    await settle();
    api.sendDailyPost.mockRejectedValueOnce(new Error('IPC failed'));
    api.getDaily.mockResolvedValue(ok('after-loss'));
    expect(await controller.send('post-1')).toBe(false);
    await settle();
    expect(effects.notify).toHaveBeenCalledWith(
      expect.stringContaining('확인하지 못했습니다'),
      true,
    );
    expect(api.getDaily).toHaveBeenCalledTimes(2);
    expect(shownName(controller)).toBe('after-loss');
  });
});
