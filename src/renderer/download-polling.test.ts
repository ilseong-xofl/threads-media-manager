import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDownloadPolling, downloadPollingDelay } from './download-polling';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

it('polls idle status only every 30 seconds and switches to quick updates while a download runs', async () => {
  let active = false;
  const poll = vi.fn().mockResolvedValue(undefined);
  const polling = createDownloadPolling({
    enabled: () => true,
    delay: () => downloadPollingDelay(active),
    poll,
  });
  polling.wake();
  await settle();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(poll).toHaveBeenCalledTimes(3);
  active = true;
  polling.wake();
  await settle();
  await vi.advanceTimersByTimeAsync(900);
  expect(poll).toHaveBeenCalledTimes(7);
  active = false;
  polling.wake();
  await settle();
  const completedCount = poll.mock.calls.length;
  await vi.advanceTimersByTimeAsync(29_999);
  expect(poll).toHaveBeenCalledTimes(completedCount);
  polling.stop();
});

it('stops protected reads while locked and refreshes immediately on reconnect', async () => {
  let enabled = true;
  const poll = vi.fn().mockResolvedValue(undefined);
  const polling = createDownloadPolling({ enabled: () => enabled, delay: () => 300, poll });
  polling.wake();
  await settle();
  enabled = false;
  polling.wake();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(poll).toHaveBeenCalledOnce();
  enabled = true;
  polling.wake();
  await settle();
  expect(poll).toHaveBeenCalledTimes(2);
  polling.stop();
});

it('never overlaps requests when activity changes during a slow response', async () => {
  let resolve!: () => void;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  const poll = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined);
  const polling = createDownloadPolling({ enabled: () => true, delay: () => 300, poll });
  polling.wake();
  for (let i = 0; i < 10; i++) polling.wake();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(poll).toHaveBeenCalledOnce();
  resolve();
  await settle();
  expect(poll).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(300);
  expect(poll).toHaveBeenCalledTimes(3);
  polling.stop();
});

it('does not spin on a failed idle request or restart after disposal', async () => {
  const poll = vi.fn().mockRejectedValue(new Error('service unavailable'));
  const polling = createDownloadPolling({
    enabled: () => true,
    delay: () => downloadPollingDelay(false),
    poll,
  });
  polling.wake();
  await settle();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(poll).toHaveBeenCalledOnce();
  polling.stop();
  polling.wake();
  await vi.advanceTimersByTimeAsync(90_000);
  expect(poll).toHaveBeenCalledOnce();
});
