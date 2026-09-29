import { app, autoUpdater, dialog, type BrowserWindow, type MessageBoxOptions } from 'electron';
import { updateElectronApp, UpdateSourceType, type IUpdateInfo } from 'update-electron-app';

import {
  UpdatePromptCoordinator,
  type UpdateNotification,
  type UpdatePromptChoice,
} from './update-prompt-coordinator';

interface AutoUpdateOptions {
  getWindow: () => BrowserWindow | null;
  isBusy: () => boolean;
  repository: string;
  onBeforeRestart?: () => void;
  onRestartError?: () => void;
}

function toUpdateNotification(info: IUpdateInfo): UpdateNotification {
  return {
    releaseName: typeof info.releaseName === 'string' ? info.releaseName.trim() : '',
    updateUrl: typeof info.updateURL === 'string' ? info.updateURL : '',
  };
}

async function showUpdatePrompt(
  parent: BrowserWindow,
  update: UpdateNotification,
): Promise<UpdatePromptChoice> {
  const versionLabel = update.releaseName ? ` ${update.releaseName}` : '';
  const options: MessageBoxOptions = {
    type: 'info',
    title: '업데이트 준비 완료',
    message: `새 버전${versionLabel} 업데이트가 준비되었습니다.`,
    detail:
      "'지금 재시작'을 선택하면 업데이트를 바로 적용합니다. '나중에'를 선택하면 앱을 다음에 실행할 때 자동으로 적용됩니다.",
    buttons: ['나중에', '지금 재시작'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const result = await dialog.showMessageBox(parent, options);
  return result.response === 1 ? 'restart' : 'later';
}

/** Call once after app readiness. Mac and development runs never start update checks. */
export function configureAutoUpdates(options: AutoUpdateOptions): () => void {
  if (!app.isPackaged || process.platform !== 'win32') return () => undefined;

  const repository = options.repository.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    console.info('[updates] GitHub repository is not embedded; update checks are disabled.');
    return () => undefined;
  }

  let disposed = false;
  let stopUpdates: (() => void) | null = null;
  const stopPolling = () => {
    stopUpdates?.();
    stopUpdates = null;
  };
  const getWindow = () => {
    const window = options.getWindow();
    return window && !window.isDestroyed() ? window : null;
  };
  const coordinator = new UpdatePromptCoordinator({
    isBusy: () => !getWindow() || options.isBusy(),
    showPrompt: (update) => {
      const window = getWindow();
      if (!window) throw new Error('The update prompt has no available parent window.');
      return showUpdatePrompt(window, update);
    },
    restart: () => {
      try {
        options.onBeforeRestart?.();
        autoUpdater.quitAndInstall();
      } catch (error) {
        options.onRestartError?.();
        throw error;
      }
    },
    onError: (error) => console.error('[updates] Failed to confirm the update.', error),
  });

  // Squirrel holds an installation lock during --squirrel-firstrun. The same
  // startup delay used by Local Video Manager also keeps initial rendering free.
  const startupTimer = setTimeout(() => {
    if (disposed) return;
    try {
      ({ stopUpdates } = updateElectronApp({
        updateSource: {
          type: UpdateSourceType.ElectronPublicUpdateService,
          repo: repository,
        },
        notifyUser: true,
        onNotifyUser: (info) => {
          if (disposed) return;
          // Keep Squirrel free for installation while a downloaded update waits
          // for the user's choice; later hourly checks would use the same process.
          stopPolling();
          coordinator.notify(toUpdateNotification(info));
        },
        updateInterval: '1 hour',
        logger: console,
      }));
    } catch (error) {
      // A missing feed or updater initialization problem must not stop local work.
      console.error('[updates] Failed to start background update checks.', error);
    }
  }, 10_000);
  startupTimer.unref?.();

  return () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(startupTimer);
    coordinator.dispose();
    stopPolling();
  };
}
