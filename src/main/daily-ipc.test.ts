import { expect, it, vi } from 'vitest';
import { IPC } from '../shared/contracts';
import { handleDailyRequest } from './daily-ipc';

const actions = () => ({
  state: vi.fn(),
  savePersona: vi.fn(),
  deletePersona: vi.fn(),
  generate: vi.fn(),
  addPost: vi.fn(),
  savePost: vi.fn(),
  translatePost: vi.fn(),
  deletePost: vi.fn(),
  send: vi.fn(),
  cancelSend: vi.fn(),
  replies: vi.fn(),
  translateReplies: vi.fn(),
  openReplyLink: vi.fn(),
  addAnswer: vi.fn(),
  saveAnswer: vi.fn(),
  deleteAnswer: vi.fn(),
  sendAnswers: vi.fn(),
  cancelAnswer: vi.fn(),
});

it('rejects unknown daily operations and wrong argument counts before any work', () => {
  const daily = actions();
  for (const [channel, args] of [
    ['tmm:daily:fetch', ['https://graph.threads.net/me']],
    ['tmm:daily:publish', [{ postId: 'post' }]],
    [IPC.daily, [{ ownerId: 'other-user' }]],
    [IPC.saveDailyPersona, []],
    [IPC.saveDailyPersona, [{}, { ownerId: 'other-user' }]],
    [IPC.deleteDailyPersona, []],
    [IPC.generateDailyPosts, []],
    [IPC.addDailyPost, []],
    [IPC.saveDailyPost, [{}, {}]],
    [IPC.translateDailyPost, []],
    [IPC.deleteDailyPost, []],
    [IPC.sendDailyPost, [{}, { accountId: 'other-account' }]],
    [IPC.cancelDailySend, []],
    [IPC.dailyReplies, []],
    [IPC.translateDailyReplies, [{}, {}]],
    [IPC.openDailyReplyLink, [{ postId: 'post' }, 'https://www.threads.com/@someone']],
    [IPC.addDailyAnswer, []],
    [IPC.saveDailyAnswer, [{}, {}]],
    [IPC.deleteDailyAnswer, []],
    [IPC.sendDailyAnswers, [{ postId: 'post' }, 'https://graph.threads.net/me/threads']],
    [IPC.cancelDailyAnswer, []],
  ] as const) {
    expect(() => handleDailyRequest(channel, [...args], daily)).toThrow();
  }
  for (const action of Object.values(daily)) expect(action).not.toHaveBeenCalled();
});

it('routes each fixed channel to its one action', () => {
  const daily = actions();
  const input = { postId: 'post' };
  handleDailyRequest(IPC.daily, [], daily);
  expect(daily.state).toHaveBeenCalledWith();
  for (const [channel, action] of [
    [IPC.saveDailyPersona, daily.savePersona],
    [IPC.deleteDailyPersona, daily.deletePersona],
    [IPC.generateDailyPosts, daily.generate],
    [IPC.addDailyPost, daily.addPost],
    [IPC.saveDailyPost, daily.savePost],
    [IPC.translateDailyPost, daily.translatePost],
    [IPC.deleteDailyPost, daily.deletePost],
    [IPC.sendDailyPost, daily.send],
    [IPC.cancelDailySend, daily.cancelSend],
    [IPC.dailyReplies, daily.replies],
    [IPC.translateDailyReplies, daily.translateReplies],
    [IPC.openDailyReplyLink, daily.openReplyLink],
    [IPC.addDailyAnswer, daily.addAnswer],
    [IPC.saveDailyAnswer, daily.saveAnswer],
    [IPC.deleteDailyAnswer, daily.deleteAnswer],
    [IPC.sendDailyAnswers, daily.sendAnswers],
    [IPC.cancelDailyAnswer, daily.cancelAnswer],
  ] as const) {
    handleDailyRequest(channel, [input], daily);
    expect(action).toHaveBeenCalledWith(input);
  }
});
