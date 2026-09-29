import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { IUpdateElectronAppOptions, IUpdateInfo } from 'update-electron-app';

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true },
  showMessageBox: vi.fn(async () => ({ response: 0 })),
  quitAndInstall: vi.fn(),
  updateElectronApp: vi.fn(),
  stopUpdates: vi.fn(),
}));
vi.mock('electron', () => ({
  app: mocks.app,
  autoUpdater: { quitAndInstall: mocks.quitAndInstall },
  dialog: { showMessageBox: mocks.showMessageBox },
}));
vi.mock('update-electron-app', () => ({
  updateElectronApp: mocks.updateElectronApp,
  UpdateSourceType: { ElectronPublicUpdateService: 0 },
}));

import { configureAutoUpdates } from './updates';

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
const removers: (() => void)[] = [];

function configure() {
  const window = { isDestroyed: vi.fn(() => false) } as unknown as BrowserWindow;
  const options = {
    repository: 'ilseong-xofl/threads-media-manager',
    getWindow: vi.fn((): BrowserWindow | null => window),
    isBusy: vi.fn(() => false),
    onBeforeRestart: vi.fn(),
    onRestartError: vi.fn(),
  };
  const stop = configureAutoUpdates(options);
  removers.push(stop);
  return { window, options, stop };
}

function notifyDownloaded() {
  const options = mocks.updateElectronApp.mock.calls.at(-1)![0] as IUpdateElectronAppOptions;
  options.onNotifyUser!({ releaseName: ' 0.2.0 ', updateURL: '' } as IUpdateInfo);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: 'win32' });
  mocks.app.isPackaged = true;
  mocks.updateElectronApp.mockReturnValue({ stopUpdates: mocks.stopUpdates });
  mocks.showMessageBox.mockResolvedValue({ response: 0 });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  removers.splice(0).forEach((stop) => stop());
  Object.defineProperty(process, 'platform', platformDescriptor);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('configureAutoUpdates', () => {
  it.each([
    ['darwin', false],
    ['darwin', true],
    ['win32', false],
    ['linux', true],
  ])('does not check updates on %s with packaged=%s', async (platform, packaged) => {
    Object.defineProperty(process, 'platform', { value: platform });
    mocks.app.isPackaged = packaged;
    configure();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.updateElectronApp).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('delays startup for the Squirrel installation lock and uses the LVM update service', async () => {
    configure();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(mocks.updateElectronApp).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.updateElectronApp).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        updateSource: { type: 0, repo: 'ilseong-xofl/threads-media-manager' },
        updateInterval: '1 hour',
        notifyUser: true,
        onNotifyUser: expect.any(Function),
      }),
    );
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.quitAndInstall).not.toHaveBeenCalled();
  });

  it.each(['', 'https://github.com/owner/repo', 'owner/repo/extra', 'owner /repo'])(
    'does not initialize a malformed update repository: %s',
    async (repository) => {
      const stop = configureAutoUpdates({ getWindow: () => null, isBusy: () => false, repository });
      removers.push(stop);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.updateElectronApp).not.toHaveBeenCalled();
    },
  );

  it('offers the downloaded update in a parented Korean dialog with later as the safe default', async () => {
    const { window } = configure();
    await vi.advanceTimersByTimeAsync(10_000);
    notifyDownloaded();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.showMessageBox).toHaveBeenCalledExactlyOnceWith(
      window,
      expect.objectContaining({
        title: '업데이트 준비 완료',
        message: '새 버전 0.2.0 업데이트가 준비되었습니다.',
        buttons: ['나중에', '지금 재시작'],
        defaultId: 0,
        cancelId: 0,
      }),
    );
    expect(mocks.quitAndInstall).not.toHaveBeenCalled();
  });

  it('stops hourly Squirrel checks before a downloaded update waits for the user', async () => {
    const { stop } = configure();
    mocks.showMessageBox.mockImplementationOnce(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(10_000);
    notifyDownloaded();
    expect(mocks.stopUpdates).toHaveBeenCalledOnce();
    expect(mocks.stopUpdates.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.showMessageBox.mock.invocationCallOrder[0],
    );
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(mocks.quitAndInstall).not.toHaveBeenCalled();
    stop();
    expect(mocks.stopUpdates).toHaveBeenCalledOnce();
  });

  it('waits for a usable window and completed work before requesting a restart', async () => {
    const { options, window } = configure();
    options.getWindow.mockReturnValue(null);
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    notifyDownloaded();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    options.getWindow.mockReturnValue(window);
    options.isBusy.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    options.isBusy.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('locks new application work immediately before invoking the installer', async () => {
    const { options } = configure();
    const order: string[] = [];
    options.onBeforeRestart.mockImplementation(() => {
      order.push('lock');
    });
    mocks.quitAndInstall.mockImplementationOnce(() => {
      order.push('install');
    });
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    notifyDownloaded();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['lock', 'install']);
    expect(options.onRestartError).not.toHaveBeenCalled();
  });

  it('unlocks application work if invoking the installer fails', async () => {
    const { options } = configure();
    mocks.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('installer unavailable');
    });
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    notifyDownloaded();
    await vi.advanceTimersByTimeAsync(0);
    expect(options.onBeforeRestart).toHaveBeenCalledOnce();
    expect(options.onRestartError).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledOnce();
  });

  it('does not treat a destroyed parent window as available', async () => {
    const { window } = configure();
    vi.mocked(window.isDestroyed).mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(10_000);
    notifyDownloaded();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it('cancels startup when the app exits during the initial delay', async () => {
    const { stop } = configure();
    stop();
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.updateElectronApp).not.toHaveBeenCalled();
    expect(mocks.stopUpdates).not.toHaveBeenCalled();
  });

  it('stops future checks exactly once and ignores late download completion after disposal', async () => {
    const { stop } = configure();
    await vi.advanceTimersByTimeAsync(10_000);
    stop();
    stop();
    notifyDownloaded();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.stopUpdates).toHaveBeenCalledOnce();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.quitAndInstall).not.toHaveBeenCalled();
  });

  it('logs updater initialization failure without failing app startup or prompting to quit', async () => {
    mocks.updateElectronApp.mockImplementationOnce(() => {
      throw new Error('update service unavailable');
    });
    configure();
    await expect(vi.advanceTimersByTimeAsync(10_000)).resolves.toBeDefined();
    expect(console.error).toHaveBeenCalledOnce();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.quitAndInstall).not.toHaveBeenCalled();
  });
});
