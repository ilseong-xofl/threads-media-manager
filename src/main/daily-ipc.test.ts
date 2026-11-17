import { expect, it, vi } from 'vitest';
import { IPC } from '../shared/contracts';
import { handleDailyRequest } from './daily-ipc';

const actions = () => ({
  state: vi.fn(),
  savePersona: vi.fn(),
  deletePersona: vi.fn(),
  generate: vi.fn(),
  savePost: vi.fn(),
  deletePost: vi.fn(),
  send: vi.fn(),
  cancelSend: vi.fn(),
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
    [IPC.saveDailyPost, [{}, {}]],
    [IPC.deleteDailyPost, []],
    [IPC.sendDailyPost, [{}, { accountId: 'other-account' }]],
    [IPC.cancelDailySend, []],
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
    [IPC.saveDailyPost, daily.savePost],
    [IPC.deleteDailyPost, daily.deletePost],
    [IPC.sendDailyPost, daily.send],
    [IPC.cancelDailySend, daily.cancelSend],
  ] as const) {
    handleDailyRequest(channel, [input], daily);
    expect(action).toHaveBeenCalledWith(input);
  }
});
