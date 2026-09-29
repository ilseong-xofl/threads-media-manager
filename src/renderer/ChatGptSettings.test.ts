import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ChatGptResult, ChatGptState } from '../shared/contracts';
import {
  ChatGptSettingsControls,
  createChatGptSettingsSession,
  type ChatGptSettingsSnapshot,
} from './ChatGptSettings';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const signedOut: ChatGptState = { status: 'signed_out' };
const signedIn: ChatGptState = { status: 'signed_in' };
function setup() {
  const api = {
    chatGptState: vi.fn<() => Promise<ChatGptState>>().mockResolvedValue(signedOut),
    loginChatGpt: vi
      .fn<() => Promise<ChatGptResult>>()
      .mockResolvedValue({ status: 'ok', state: signedIn }),
    cancelChatGptLogin: vi
      .fn<() => Promise<ChatGptResult>>()
      .mockResolvedValue({ status: 'cancelled', state: signedOut }),
    logoutChatGpt: vi
      .fn<() => Promise<ChatGptResult>>()
      .mockResolvedValue({ status: 'ok', state: signedOut }),
  };
  const update = vi.fn<(value: ChatGptSettingsSnapshot) => void>();
  const notify = vi.fn();
  const session = createChatGptSettingsSession(api, update, notify);
  return { api, update, notify, session };
}

describe('ChatGPT settings session', () => {
  it('reads state before login and prevents repeated login requests while waiting', async () => {
    const { api, update, notify, session } = setup();
    const login = deferred<ChatGptResult>();
    api.loginChatGpt.mockReturnValue(login.promise);
    await session.refresh();
    const pending = session.login();
    await session.login();
    await session.refresh();
    await session.logout();
    expect(api.loginChatGpt).toHaveBeenCalledTimes(1);
    expect(api.chatGptState).toHaveBeenCalledTimes(1);
    expect(api.logoutChatGpt).not.toHaveBeenCalled();
    expect(update).toHaveBeenLastCalledWith({ state: signedOut, operation: 'login' });
    login.resolve({ status: 'ok', state: signedIn });
    await pending;
    expect(update).toHaveBeenLastCalledWith({ state: signedIn, operation: null });
    expect(notify).toHaveBeenCalledWith({ message: expect.stringContaining('연결했습니다') });
  });

  it('allows cancellation and retry without a late completed login replacing newer state', async () => {
    const { api, update, notify, session } = setup();
    const first = deferred<ChatGptResult>();
    const second = deferred<ChatGptResult>();
    api.loginChatGpt.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await session.refresh();
    const original = session.login();
    await session.cancel();
    const retry = session.login();
    first.resolve({ status: 'ok', state: signedIn });
    await original;
    expect(update).toHaveBeenLastCalledWith({ state: signedOut, operation: 'login' });
    expect(notify).not.toHaveBeenCalled();
    second.resolve({ status: 'ok', state: signedIn });
    await retry;
    expect(update).toHaveBeenLastCalledWith({ state: signedIn, operation: null });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(api.cancelChatGptLogin).toHaveBeenCalledTimes(1);
  });

  it('cancels on closing and never updates or displays a success for its late reply', async () => {
    const { api, update, notify, session } = setup();
    const login = deferred<ChatGptResult>();
    api.loginChatGpt.mockReturnValue(login.promise);
    await session.refresh();
    const pending = session.login();
    session.dispose();
    expect(api.cancelChatGptLogin).toHaveBeenCalledTimes(1);
    const updates = update.mock.calls.length;
    login.resolve({ status: 'ok', state: signedIn });
    await pending;
    await session.refresh();
    await session.login();
    expect(update).toHaveBeenCalledTimes(updates);
    expect(notify).not.toHaveBeenCalled();
    expect(api.loginChatGpt).toHaveBeenCalledTimes(1);
  });

  it('ignores a late state read after closing without cancelling a newer login', async () => {
    const { api, update, session } = setup();
    const state = deferred<ChatGptState>();
    api.chatGptState.mockReturnValue(state.promise);
    const pending = session.refresh();
    session.dispose();
    state.resolve({ status: 'signing_in' });
    await pending;
    expect(api.cancelChatGptLogin).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('leaves failed state checks retryable and reports failures through the common toast', async () => {
    const { api, update, notify, session } = setup();
    api.chatGptState.mockRejectedValueOnce(new Error('unavailable'));
    await session.refresh();
    expect(notify).toHaveBeenLastCalledWith({ error: true, message: expect.any(String) });
    await session.refresh();
    expect(update).toHaveBeenLastCalledWith({ state: signedOut, operation: null });
    const problem = { code: 'login_failed', message: '다시 로그인해 주세요.' };
    api.loginChatGpt.mockResolvedValueOnce({ status: 'error', state: signedOut, problem });
    await session.login();
    expect(notify).toHaveBeenLastCalledWith({ error: true, message: problem.message });
    await session.login();
    expect(update).toHaveBeenLastCalledWith({ state: signedIn, operation: null });
  });

  it('allows retrying a failed cancel and then logging out of a completed connection', async () => {
    const { api, update, notify, session } = setup();
    api.chatGptState.mockResolvedValueOnce({ status: 'signing_in' });
    await session.refresh();
    api.cancelChatGptLogin.mockResolvedValueOnce({
      status: 'error',
      state: { status: 'signing_in' },
      problem: { code: 'cancel_failed', message: '취소하지 못했습니다.' },
    });
    await session.cancel();
    expect(notify).toHaveBeenLastCalledWith({ error: true, message: '취소하지 못했습니다.' });
    await session.cancel();
    expect(update).toHaveBeenLastCalledWith({ state: signedOut, operation: null });
    await session.login();
    await session.logout();
    expect(update).toHaveBeenLastCalledWith({ state: signedOut, operation: null });
    expect(notify).toHaveBeenLastCalledWith({
      message: expect.stringContaining('로그아웃했습니다'),
    });
  });
});

function markup(snapshot: ChatGptSettingsSnapshot, enabled = true) {
  return renderToStaticMarkup(
    createElement(ChatGptSettingsControls, {
      snapshot,
      enabled,
      onLogin: () => {},
      onLogout: () => {},
      onRefresh: () => {},
      onCancel: () => {},
    }),
  );
}
describe('ChatGPT settings controls', () => {
  it('offers browser login without asking for tokens or terminal setup', () => {
    const html = markup({ state: signedOut, operation: null });
    expect(html).toContain('ChatGPT 로그인');
    expect(html).toContain('로그인 필요');
    expect(html).not.toMatch(/<input|터미널|CLI|https?:|token|로그아웃/);
  });
  it('shows logout and recheck only when connected', () => {
    const html = markup({ state: signedIn, operation: null });
    expect(html).toContain('연결됨');
    expect(html).toContain('로그아웃');
    expect(html).toContain('연결 상태 다시 확인');
    expect(html).not.toContain('ChatGPT 로그인');
  });
  it('keeps cancel usable while waiting even if another app operation disables normal controls', () => {
    const html = markup({ state: signedOut, operation: 'login' }, false);
    expect(html).toContain('브라우저에서 로그인을 완료해 주세요');
    expect(html).toContain('이 창을 닫으면 로그인을 취소합니다');
    expect(html).toMatch(/<button type="button">로그인 취소<\/button>/);
    expect(html).not.toContain('role="alert"');
  });
  it('keeps unavailable details in the toast and provides a retry without enabling login', () => {
    const html = markup({
      state: {
        status: 'unavailable',
        problem: { code: 'unavailable', message: '알림에서만 표시' },
      },
      operation: null,
    });
    expect(html).toMatch(/class="primary" disabled="">ChatGPT 로그인/);
    expect(html).toMatch(/<button type="button">연결 상태 다시 확인/);
    expect(html).not.toContain('알림에서만 표시');
  });
});
