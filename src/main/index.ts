import { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } from 'electron';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { IPC, MEDIA_SCHEME } from '../shared/contracts';
import {
  CollectionController,
  problem,
  readRootSetting,
  readRuntime,
  rememberRoot,
} from './collection';
import { MediaRegistry } from './media';
import { DownloadController, launchWorker } from './download';
import { isLocalRequest, isTrustedFrame } from './security';
import { PostExportController, launchExport } from './post-export';
import { MediaEditController, launchMediaEdit } from './media-edit';
import { MediaDeleteController, launchMediaDelete, mediaDeleteConfirmation } from './media-delete';
import { PostCommentController, launchPostComment } from './post-comment';
import { openPostLink } from './open-post-link';

app.setName('Threads Media Manager');
app.setAppUserModelId('com.threadsmediamanager.desktop');
const testUserData = !app.isPackaged ? process.env.TMM_USER_DATA : undefined;
app.setPath(
  'userData',
  testUserData && isAbsolute(testUserData)
    ? testUserData
    : join(app.getPath('appData'), 'ThreadsMediaManager'),
);
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

let window: BrowserWindow | null = null;
const registry = new MediaRegistry();
const controller = new CollectionController(
  (root) => readRuntime(app.getAppPath(), root),
  (root, files) => registry.adopt(root, files),
);

const downloads = new DownloadController(launchWorker(app.getAppPath()), () =>
  controller.refresh(),
);
const archives = new PostExportController(
  (root) => controller.refresh(root),
  async (fileName) => {
    if (!window) return null;
    const choice = await dialog.showSaveDialog(window, {
      title: '게시글 ZIP 다운로드',
      defaultPath: join(app.getPath('downloads'), fileName),
      buttonLabel: '저장',
      filters: [{ name: 'ZIP 압축파일', extensions: ['zip'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent'],
      showsTagField: false,
    });
    return choice.canceled ? null : choice.filePath;
  },
  launchExport(app.getAppPath()),
);
let selectingFolder = false;
const edits: MediaEditController = new MediaEditController(
  (root) => controller.refresh(root),
  launchMediaEdit(app.getAppPath()),
  () =>
    selectingFolder ||
    controller.loading ||
    downloads.active ||
    archives.active ||
    deletions.active ||
    comments.active,
);
const deletions: MediaDeleteController = new MediaDeleteController(
  (root) => controller.refresh(root),
  launchMediaDelete(app.getAppPath()),
  async (input, plan, signal) => {
    if (!window || signal.aborted) return false;
    const choice = await dialog.showMessageBox(
      window,
      mediaDeleteConfirmation(input, plan, signal),
    );
    return choice.response === 1 && !signal.aborted;
  },
  () =>
    selectingFolder ||
    controller.loading ||
    downloads.active ||
    archives.active ||
    edits.active ||
    comments.active,
);
const comments: PostCommentController = new PostCommentController(
  (root) => controller.refresh(root),
  launchPostComment(app.getAppPath()),
  () =>
    selectingFolder ||
    controller.loading ||
    downloads.active ||
    archives.active ||
    edits.active ||
    deletions.active,
);
let closing = false;
function deletionNeedsRecovery(): boolean {
  return (
    controller.view.error?.code === 'deletion_recovery_required' ||
    !!controller.view.snapshot?.warnings.some((item) => item.code === 'deletion_recovery_required')
  );
}
function currentRoot(): string {
  const view = controller.view;
  if (!view.snapshot || view.error || controller.root !== view.snapshot.root)
    throw new Error('Refresh a valid collection before downloading');
  return view.snapshot.root;
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 940,
    minHeight: 650,
    show: false,
    backgroundColor: '#f5f6f8',
    title: 'Threads Media Manager',
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.once('ready-to-show', () => window?.show());
  window.on('close', (event) => {
    if (
      (!downloads.active &&
        !archives.active &&
        !edits.active &&
        !deletions.active &&
        !comments.active) ||
      closing
    )
      return;
    event.preventDefault();
    void Promise.all([
      downloads.shutdown(),
      archives.shutdown(),
      edits.shutdown(),
      deletions.shutdown(),
      comments.shutdown(),
    ]).finally(() => {
      closing = true;
      window?.close();
      closing = false;
    });
  });
  window.on('closed', () => {
    window = null;
  });
  void window.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  void app
    .whenReady()
    .then(async () => {
      // Dedicated dev session: no remote images, fonts, service requests, or navigation.
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !isLocalRequest(details.url, MAIN_WINDOW_WEBPACK_ENTRY) }),
      );
      protocol.handle(MEDIA_SCHEME, (request) => registry.respond(request));
      const userData = app.getPath('userData');
      try {
        const settings =
          !app.isPackaged && process.env.TMM_SETTINGS_PATH
            ? process.env.TMM_SETTINGS_PATH
            : join(homedir(), '.threads-media-manager', 'settings.json');
        const root =
          (await readRootSetting(join(userData, 'view-settings.json'))) ??
          (await readRootSetting(settings));
        if (root) await controller.refresh(root);
      } catch (error) {
        controller.view = { snapshot: null, error: problem(error) };
      }
      for (const channel of Object.values(IPC)) {
        ipcMain.handle(channel, async (event, ...args: unknown[]) => {
          if (
            !window ||
            !isTrustedFrame(
              event.sender.id,
              window.webContents.id,
              event.senderFrame === window.webContents.mainFrame,
              event.senderFrame?.url ?? '',
              MAIN_WINDOW_WEBPACK_ENTRY,
            )
          )
            throw new Error('Unauthorized request');
          if (channel === IPC.openPostLink) {
            if (args.length !== 1)
              return {
                status: 'error',
                problem: { code: 'link_input', message: '열 링크의 게시글 정보를 확인하세요.' },
              };
            return openPostLink(controller.view, args[0], (url) =>
              shell.openExternal(url, { activate: true }),
            );
          }
          if (channel === IPC.downloadPrepare) {
            if (
              args.length !== 1 ||
              typeof args[0] !== 'string' ||
              args[0].length > 64 ||
              !controller.view.snapshot?.posts.some((p) => p.account === args[0])
            )
              throw new Error('Invalid account');
          } else if (channel === IPC.exportPost) {
            if (
              args.length !== 1 ||
              typeof args[0] !== 'string' ||
              args[0].length > 512 ||
              !controller.view.snapshot?.posts.some((post) => post.key === args[0])
            )
              throw new Error('Invalid post');
          } else if (
            channel === IPC.saveMediaEdit ||
            channel === IPC.deleteMedia ||
            channel === IPC.savePostComment
          ) {
            if (args.length !== 1) throw new Error('Unexpected arguments');
          } else if (args.length) throw new Error('Unexpected arguments');
          if (channel === IPC.current) return controller.view;
          if (channel === IPC.downloadStatus) return downloads.view;
          if (channel === IPC.downloadStop) return downloads.stop();
          if (channel === IPC.deleteMedia || channel === IPC.recoverDeletions) {
            if (!controller.root)
              return {
                status: 'error',
                problem: { code: 'delete_source', message: '수집 폴더를 연결한 뒤 삭제하세요.' },
              };
            const result =
              channel === IPC.deleteMedia
                ? await deletions.delete(controller.root, args[0])
                : await deletions.recover(controller.root);
            if (result.status === 'deleted') controller.view = result.view;
            return result;
          }
          if (
            deletionNeedsRecovery() &&
            [
              IPC.saveMediaEdit,
              IPC.savePostComment,
              IPC.exportPost,
              IPC.downloadPrepare,
              IPC.downloadStart,
              IPC.downloadRecover,
            ].some((blocked) => blocked === channel)
          ) {
            if (channel.startsWith('tmm:download:')) return downloads.view;
            return {
              status: 'error',
              problem: {
                code: 'deletion_recovery_required',
                message: '중단된 삭제 작업을 먼저 복구하세요.',
              },
            };
          }
          if (channel === IPC.savePostComment) {
            if (!controller.root)
              return {
                status: 'error',
                problem: {
                  code: 'comment_source',
                  message: '수집 폴더를 연결한 뒤 댓글을 저장하세요.',
                },
              };
            const result = await comments.save(controller.root, args[0]);
            if (result.status === 'saved') controller.view = result.view;
            return result;
          }
          if (channel === IPC.saveMediaEdit) {
            if (!controller.root)
              return {
                status: 'error',
                problem: {
                  code: 'edit_source',
                  message: '수집 폴더를 연결한 뒤 편집본을 저장하세요.',
                },
              };
            return edits.save(controller.root, args[0]);
          }
          if (channel === IPC.exportPost) {
            if (
              selectingFolder ||
              controller.loading ||
              downloads.active ||
              edits.active ||
              deletions.active ||
              comments.active ||
              !controller.root
            )
              return {
                status: 'error',
                problem: {
                  code: 'export_busy',
                  message: '진행 중인 작업이 끝난 뒤 ZIP을 저장하세요.',
                },
              };
            return archives.export(controller.root, args[0] as string);
          }
          if (archives.active || edits.active || deletions.active || comments.active)
            return channel.startsWith('tmm:download:') ? downloads.view : controller.view;
          if (selectingFolder || controller.loading) {
            return channel.startsWith('tmm:download:') ? downloads.view : controller.view;
          }
          if (channel === IPC.downloadPrepare)
            return downloads.prepare(currentRoot(), args[0] as string);
          if (channel === IPC.downloadStart) return downloads.startAll(currentRoot());
          if (channel === IPC.downloadRecover) {
            if (!controller.root) throw new Error('Connect a collection before recovery');
            return downloads.recover(controller.root);
          }
          if (downloads.active) return controller.view;
          if (channel === IPC.refresh) return controller.refresh();
          selectingFolder = true;
          try {
            const selection = await dialog.showOpenDialog(window, {
              title: '수집 폴더 연결',
              properties: ['openDirectory'],
            });
            if (selection.canceled || !selection.filePaths[0]) return controller.view;
            const view = await controller.refresh(selection.filePaths[0]);
            if (!view.error && view.snapshot) {
              downloads.resetForRoot(view.snapshot.root);
              try {
                await rememberRoot(userData, view.snapshot.root);
              } catch {
                controller.view = {
                  ...view,
                  error: {
                    code: 'settings_save_failed',
                    message:
                      '자료를 읽었지만 폴더 위치를 기억하지 못했습니다. 다음 실행에서 다시 연결하세요.',
                  },
                };
              }
            }
          } finally {
            selectingFolder = false;
          }
          return controller.view;
        });
      }
      createWindow();
      app.on('activate', () => {
        if (!window) createWindow();
      });
    })
    .catch(() => {
      dialog.showErrorBox(
        'Threads Media Manager',
        '앱을 시작할 수 없습니다. 개발 환경을 확인하세요.',
      );
      app.quit();
    });
  app.on('before-quit', (event) => {
    if (
      (!downloads.active &&
        !archives.active &&
        !edits.active &&
        !deletions.active &&
        !comments.active) ||
      closing
    )
      return;
    event.preventDefault();
    void Promise.all([
      downloads.shutdown(),
      archives.shutdown(),
      edits.shutdown(),
      deletions.shutdown(),
      comments.shutdown(),
    ]).finally(() => {
      closing = true;
      app.quit();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
