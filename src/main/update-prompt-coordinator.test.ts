import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpdatePromptCoordinator, type UpdatePromptChoice } from './update-prompt-coordinator';

const update = { releaseName: '0.2.0', updateUrl: 'https://example.test/0.2.0' };
const nextUpdate = { releaseName: '0.2.1', updateUrl: 'https://example.test/0.2.1' };

function setup(choice: UpdatePromptChoice = 'later') {
  const isBusy = vi.fn(() => false);
  const onError = vi.fn();
  const restart = vi.fn();
  const showPrompt = vi.fn(async () => choice);
  const coordinator = new UpdatePromptCoordinator({ isBusy, onError, restart, showPrompt });
  return { coordinator, isBusy, onError, restart, showPrompt };
}

function pendingChoice() {
  let resolve!: (choice: UpdatePromptChoice) => void;
  const promise = new Promise<UpdatePromptChoice>((complete) => (resolve = complete));
  return { promise, resolve };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('UpdatePromptCoordinator', () => {
  it('postpones the update and suppresses repeated notification of that version', async () => {
    const { coordinator, restart, showPrompt } = setup();
    coordinator.notify(update);
    await vi.advanceTimersByTimeAsync(0);
    coordinator.notify(update);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(showPrompt).toHaveBeenCalledOnce();
    expect(restart).not.toHaveBeenCalled();
  });

  it('restarts only after a restart choice and a second idle check', async () => {
    const { coordinator, isBusy, restart } = setup('restart');
    coordinator.notify(update);
    expect(restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(isBusy).toHaveBeenCalledTimes(2);
    expect(restart).toHaveBeenCalledOnce();
    coordinator.notify(nextUpdate);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(restart).toHaveBeenCalledOnce();
  });

  it('waits for work to finish before showing a single update confirmation', async () => {
    const { coordinator, isBusy, restart, showPrompt } = setup();
    isBusy.mockReturnValue(true);
    coordinator.notify(update);
    coordinator.notify(update);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(showPrompt).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
    isBusy.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(showPrompt).toHaveBeenCalledExactlyOnceWith(update);
  });

  it('requires a fresh choice when work starts while the confirmation is open', async () => {
    const { coordinator, isBusy, restart, showPrompt } = setup();
    const firstChoice = pendingChoice();
    showPrompt.mockImplementationOnce(() => firstChoice.promise);
    coordinator.notify(update);
    isBusy.mockReturnValue(true);
    firstChoice.resolve('restart');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(restart).not.toHaveBeenCalled();
    expect(showPrompt).toHaveBeenCalledOnce();
    isBusy.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(showPrompt).toHaveBeenCalledTimes(2);
    expect(restart).not.toHaveBeenCalled();
  });

  it('serializes different updates instead of opening overlapping dialogs', async () => {
    const { coordinator, showPrompt } = setup();
    const firstChoice = pendingChoice();
    showPrompt.mockImplementationOnce(() => firstChoice.promise);
    coordinator.notify(update);
    coordinator.notify(update);
    coordinator.notify(nextUpdate);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(showPrompt).toHaveBeenCalledOnce();
    firstChoice.resolve('later');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(showPrompt.mock.calls).toEqual([[update], [nextUpdate]]);
  });

  it('cancels a pending busy retry when disposed', async () => {
    const { coordinator, isBusy, showPrompt } = setup();
    isBusy.mockReturnValue(true);
    coordinator.notify(update);
    coordinator.dispose();
    isBusy.mockReturnValue(false);
    coordinator.notify(nextUpdate);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(showPrompt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores restart confirmation after the application has disposed updates', async () => {
    const { coordinator, restart, showPrompt } = setup();
    const choice = pendingChoice();
    showPrompt.mockImplementationOnce(() => choice.promise);
    coordinator.notify(update);
    coordinator.dispose();
    choice.resolve('restart');
    await vi.advanceTimersByTimeAsync(0);
    expect(restart).not.toHaveBeenCalled();
  });

  it('handles both rejected and synchronously throwing prompts without restarting', async () => {
    const { coordinator, onError, restart, showPrompt } = setup();
    const error = new Error('window unavailable');
    showPrompt.mockRejectedValueOnce(error).mockImplementationOnce(() => {
      throw error;
    });
    coordinator.notify(update);
    coordinator.notify(nextUpdate);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(restart).not.toHaveBeenCalled();
    coordinator.notify(update);
    expect(showPrompt).toHaveBeenCalledTimes(2);
  });

  it('reports an installer failure without retrying a forced exit', async () => {
    const { coordinator, onError, restart } = setup('restart');
    const error = new Error('installer unavailable');
    restart.mockImplementationOnce(() => {
      throw error;
    });
    coordinator.notify(update);
    await vi.advanceTimersByTimeAsync(0);
    coordinator.notify(update);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(restart).toHaveBeenCalledOnce();
  });

  it('fails closed if the initial work state cannot be read', async () => {
    const { coordinator, isBusy, onError, showPrompt } = setup();
    const error = new Error('state unavailable');
    isBusy.mockImplementationOnce(() => {
      throw error;
    });
    coordinator.notify(update);
    expect(showPrompt).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(showPrompt).toHaveBeenCalledOnce();
  });

  it('fails closed if the work-state recheck throws after restart confirmation', async () => {
    const { coordinator, isBusy, onError, restart } = setup('restart');
    isBusy
      .mockImplementationOnce(() => false)
      .mockImplementationOnce(() => {
        throw new Error('state unavailable');
      });
    coordinator.notify(update);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledOnce();
    expect(restart).not.toHaveBeenCalled();
  });
});
