import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  protocol,
  powerMonitor,
  safeStorage,
  session,
  shell,
} from 'electron';
import { AUTH_STATE_CHANGED, type AppAuthState } from '../shared/service-auth';
import { EncryptedAuthTokenStore } from './auth-token-store';
import { ServiceApiClient, ServiceApiError, serviceBaseUrl } from './service-api';
import { MobilePublicationsController } from './mobile-publications';
import { cleanupPublicationOutbox } from './publication-outbox';
import { mobilePublicationBlocks } from './publication-work-gate';
import { validPublicationJournal, type PublicationJournal } from './mobile-publication-data';
import { ServiceAccess } from './service-access';
import { ManagedThreadsManager } from './managed-threads';
import { EncryptedManagedThreadsStore } from './managed-threads-store';
import { handleManagedThreadsRequest } from './managed-threads-ipc';
import squirrelStartup from 'electron-squirrel-startup';
import { configureRuntime } from './runtime';
import { configureAutoUpdates } from './updates';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IPC, MEDIA_SCHEME, IMPORT_MEDIA_SCHEME } from '../shared/contracts';
import {
  CollectionController,
  problem,
  readRootSetting,
  readRuntime,
  rememberRoot,
  ViewError,
} from './collection';
import { MediaRegistry } from './media';
import { ThreadsAccountManager } from './threads-account';
import { createDesktopThreadsClient } from './desktop-threads';
import { FileServerStorage } from './file-server-storage';
import { EncryptedLocalStore } from './threads-secret-store';
import {
  ThreadsPublishingController,
  validThreadsHistory,
  type ThreadsHistory,
} from './threads-publishing';
import { prepareThreadsMedia } from './threads-media';
import { launchWebpToPng } from './webp-png';
import { DownloadController, launchWorker } from './download';
import { isLocalRequest, isTrustedFrame } from './security';
import { PostExportController, launchExport } from './post-export';
import { MediaEditController, launchMediaEdit } from './media-edit';
import { MediaDeleteController, launchMediaDelete, mediaDeleteConfirmation } from './media-delete';
import { PostCommentController, launchPostComment } from './post-comment';
import { openPostLink } from './open-post-link';
import { PostDraftController, launchPostDraft } from './post-draft';
import {
  LocalPostController,
  LOCAL_POST_EXTENSIONS,
  launchLocalPost,
  launchLocalPostRecovery,
} from './local-post';
import { CaptionGenerator } from './caption-generator';
import { CodexConnection } from './codex-connection';
import { ContentGenerator, parseContentInput } from './content-generator';
import {
  PostDraftDeleteController,
  launchPostDraftDelete,
  postDraftDeleteConfirmation,
} from './post-draft-delete';
import { LibraryMaintenanceController, launchLibraryMaintenance } from './library-maintenance';
import { readLibraryPublications, saveLibraryPublications } from './library-publications';

const runtimeRoot = configureRuntime(app.isPackaged, app.getAppPath(), process.resourcesPath);
const appIconPath = join(
  app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'assets'),
  process.platform === 'win32' ? 'app-icon.ico' : 'app-icon.png',
);
const rendererEntry = app.isPackaged
  ? pathToFileURL(join(__dirname, '..', 'renderer', 'main_window', 'index.html')).href
  : MAIN_WINDOW_WEBPACK_ENTRY;

app.setName('Threads Media Manager');
app.setAppUserModelId(
  process.platform === 'win32'
    ? 'com.squirrel.threads_media_manager.ThreadsMediaManager'
    : 'com.threadsmediamanager.desktop',
);
const aiContentEnabled = !app.isPackaged;
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
  {
    scheme: IMPORT_MEDIA_SCHEME,
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
let rendererUpdateBlocked = true;
let updateQuitting = false;
let stopAutoUpdates: () => void = () => undefined;
const registry = new MediaRegistry(aiContentEnabled);
const controller = new CollectionController(
  (root) => readRuntime(runtimeRoot, root, aiContentEnabled),
  (root, files) => registry.adopt(root, files),
);

const downloads = new DownloadController(launchWorker(runtimeRoot), () => controller.refresh());
const archives = new PostExportController(
  (root) => controller.refresh(root),
  async (fileName) => {
    if (!window || !(await serviceAccess.allowed())) return null;
    const choice = await dialog.showSaveDialog(window, {
      title: '게시글 ZIP 다운로드',
      defaultPath: join(app.getPath('downloads'), fileName),
      buttonLabel: '저장',
      filters: [{ name: 'ZIP 압축파일', extensions: ['zip'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent'],
      showsTagField: false,
    });
    return choice.canceled || !(await serviceAccess.allowed()) ? null : choice.filePath;
  },
  launchExport(runtimeRoot, aiContentEnabled),
);
let initialFolderHint: string | undefined;
const edits: MediaEditController = new MediaEditController(
  (root) => controller.refresh(root),
  launchMediaEdit(runtimeRoot),
  () =>
    maintenance.active ||
    mobilePublications?.active ||
    controller.loading ||
    downloads.active ||
    archives.active ||
    deletions.active ||
    comments.active ||
    drafts.active ||
    localPosts.active ||
    draftDeletions.active ||
    captions.active ||
    content.active,
);
const deletions: MediaDeleteController = new MediaDeleteController(
  (root) => controller.refresh(root),
  launchMediaDelete(runtimeRoot),
  async (input, plan, signal) => {
    if (!window || signal.aborted || !(await serviceAccess.allowed())) return false;
    const choice = await dialog.showMessageBox(
      window,
      mediaDeleteConfirmation(input, plan, signal),
    );
    return choice.response === 1 && !signal.aborted && (await serviceAccess.allowed());
  },
  () =>
    maintenance.active ||
    mobilePublications?.active ||
    controller.loading ||
    downloads.active ||
    archives.active ||
    edits.active ||
    comments.active ||
    drafts.active ||
    localPosts.active ||
    draftDeletions.active ||
    captions.active ||
    content.active,
);
const comments: PostCommentController = new PostCommentController(
  (root) => controller.refresh(root),
  launchPostComment(runtimeRoot),
  () =>
    maintenance.active ||
    mobilePublications?.active ||
    controller.loading ||
    downloads.active ||
    archives.active ||
    edits.active ||
    deletions.active ||
    drafts.active ||
    localPosts.active ||
    draftDeletions.active ||
    captions.active ||
    content.active,
  (view, post, input) =>
    guardPublicationWrite(() =>
      mobilePublications.syncComment(view.snapshot!.libraryId!, post.key, {
        caption: input.caption,
        link: input.link,
      }),
    ),
);
const drafts: PostDraftController = new PostDraftController(
  (root) => controller.refresh(root),
  launchPostDraft(runtimeRoot, aiContentEnabled),
  () =>
    maintenance.active ||
    mobilePublications?.active ||
    controller.loading ||
    downloads.active ||
    archives.active ||
    edits.active ||
    deletions.active ||
    comments.active ||
    localPosts.active ||
    draftDeletions.active ||
    captions.active ||
    content.active,
  (view, post) =>
    guardPublicationWrite(() =>
      mobilePublications.requireEditable(view.snapshot!.libraryId!, post.key),
    ),
);
const draftDeletions: PostDraftDeleteController = new PostDraftDeleteController(
  (root) => controller.refresh(root),
  async (_input, signal, sourceDeleted, origin) => {
    if (!window || signal.aborted || !(await serviceAccess.allowed())) return false;
    const choice = await dialog.showMessageBox(
      window,
      postDraftDeleteConfirmation(sourceDeleted, signal, origin),
    );
    return choice.response === 1 && !signal.aborted && (await serviceAccess.allowed());
  },
  launchPostDraftDelete(runtimeRoot),
  () =>
    maintenance.active ||
    mobilePublications?.active ||
    controller.loading ||
    downloads.active ||
    archives.active ||
    edits.active ||
    deletions.active ||
    comments.active ||
    drafts.active ||
    localPosts.active ||
    captions.active ||
    content.active,
  (view, post) =>
    guardPublicationWrite(() => mobilePublications.beforeDelete(view.snapshot!.libraryId!, post)),
  (view, post) => mobilePublications.afterDelete(view.snapshot!.libraryId!, post),
);
const chatGpt: CodexConnection = new CodexConnection(
  join(app.getPath('userData'), 'codex'),
  undefined,
  () => captions.active || content.active,
);
const captions = new CaptionGenerator(
  runtimeRoot,
  (root) => controller.refresh(root),
  aiContentEnabled,
  chatGpt,
);
const content = new ContentGenerator(
  runtimeRoot,
  (root) => controller.refresh(root),
  (bytes) => {
    const image = nativeImage.createFromBuffer(bytes);
    const { width, height } = image.getSize();
    return !image.isEmpty() && width >= 256 && height >= 256 && width * height <= 40_000_000;
  },
);

const localPosts: LocalPostController = new LocalPostController(
  async () => {
    if (!window || !(await serviceAccess.allowed())) return null;
    const choice = await dialog.showOpenDialog(window, {
      title: '직접 작성할 글의 이미지·영상 선택',
      buttonLabel: '파일 선택',
      filters: [{ name: '이미지·영상', extensions: LOCAL_POST_EXTENSIONS }],
      properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
    });
    return choice.canceled || !(await serviceAccess.allowed()) ? null : choice.filePaths;
  },
  (root) => controller.refresh(root),
  launchLocalPost(runtimeRoot),
  () => controller.root,
  () =>
    maintenance.active ||
    mobilePublications?.active ||
    controller.loading ||
    downloads.active ||
    archives.active ||
    edits.active ||
    deletions.active ||
    comments.active ||
    drafts.active ||
    draftDeletions.active ||
    captions.active ||
    content.active ||
    threads.active,
  launchLocalPostRecovery(runtimeRoot),
);

const maintenance: LibraryMaintenanceController = new LibraryMaintenanceController(
  async (root) => {
    await controller.refresh(root);
    downloads.inspect(root);
    await downloads.settled();
    return controller.view;
  },
  {
    chooseBackup: async (fileName, signal) => {
      if (!window || signal.aborted || !(await serviceAccess.allowed())) return null;
      const choice = await dialog.showSaveDialog(window, {
        title: '데이터베이스 백업 저장',
        defaultPath: join(app.getPath('documents'), fileName),
        buttonLabel: '백업 저장',
        filters: [{ name: 'Threads Media Manager DB 백업', extensions: ['sqlite'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent'],
        showsTagField: false,
      });
      return choice.canceled || signal.aborted || !(await serviceAccess.allowed())
        ? null
        : (choice.filePath ?? null);
    },
    chooseRestore: async (signal) => {
      if (!window || signal.aborted || !(await serviceAccess.allowed())) return null;
      const choice = await dialog.showOpenDialog(window, {
        title: '데이터베이스 백업 선택',
        buttonLabel: '백업 선택',
        filters: [{ name: 'Threads Media Manager DB 백업', extensions: ['sqlite'] }],
        properties: ['openFile', 'dontAddToRecent'],
      });
      return choice.canceled || signal.aborted || !(await serviceAccess.allowed())
        ? null
        : (choice.filePaths[0] ?? null);
    },
    confirmRestore: async (_sourcePath, signal) => {
      if (!window || signal.aborted || !(await serviceAccess.allowed())) return false;
      const choice = await dialog.showMessageBox(window, {
        type: 'warning',
        title: '데이터베이스 복원',
        message: '선택한 백업에서 데이터를 복원할까요?',
        detail:
          '옮긴 작업 폴더와 함께 보관한 백업을 선택하세요. 현재 DB는 먼저 별도 보관하고, 기존 이미지·영상은 다시 다운로드하지 않습니다. 정상 DB의 최신 다운로드·삭제 이력은 유지합니다. Threads 토큰과 파일 서버 연결코드는 새 컴퓨터에서 다시 입력하세요.',
        buttons: ['취소', '복원'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        signal,
      });
      return choice.response === 1 && !signal.aborted && (await serviceAccess.allowed());
    },
    chooseReconnect: async (root, signal) => {
      if (!window || signal.aborted || !(await serviceAccess.allowed())) return null;
      const choice = await dialog.showOpenDialog(window, {
        title: root ? '작업 폴더 재연결' : '처음 사용할 작업 폴더 선택',
        buttonLabel: '폴더 선택',
        defaultPath: root ?? initialFolderHint,
        properties: ['openDirectory', 'dontAddToRecent'],
      });
      return choice.canceled || signal.aborted || !(await serviceAccess.allowed())
        ? null
        : (choice.filePaths[0] ?? null);
    },
  },
  launchLibraryMaintenance(runtimeRoot, app.getVersion()),
  () =>
    mobilePublications?.active ||
    controller.loading ||
    downloads.active ||
    archives.active ||
    edits.active ||
    deletions.active ||
    comments.active ||
    drafts.active ||
    localPosts.active ||
    draftDeletions.active ||
    captions.active ||
    content.active ||
    threads.active,
  {
    backup: async (root, libraryId) => {
      await saveLibraryPublications(root, libraryId, await threads.exportLibraryHistory(libraryId));
    },
    connect: async (root, libraryId) => {
      const history = await readLibraryPublications(root, libraryId);
      if (history) await threads.importLibraryHistory(libraryId, history);
    },
  },
);
let downloadCloseNoticeOpen = false;
const encryption = {
  isAvailable: async () => {
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
      return false;
    return safeStorage.isAsyncEncryptionAvailable();
  },
  encryptString: (value: string) => safeStorage.encryptStringAsync(value),
  decryptString: async (value: Buffer) => (await safeStorage.decryptStringAsync(value)).result,
};
const serviceOrigin = serviceBaseUrl(TMM_SERVICE_URL, app.isPackaged);
const serviceClient = new ServiceApiClient(
  serviceOrigin,
  new EncryptedAuthTokenStore(join(app.getPath('userData'), 'service-session.enc'), {
    isEncryptionAvailable: encryption.isAvailable,
    encryptString: encryption.encryptString,
    decryptString: encryption.decryptString,
  }),
);
const managedThreads = new ManagedThreadsManager(
  serviceClient,
  new EncryptedManagedThreadsStore(join(app.getPath('userData'), 'managed-threads.enc'), {
    isEncryptionAvailable: encryption.isAvailable,
    encryptString: encryption.encryptString,
    decryptString: encryption.decryptString,
  }),
  serviceOrigin ?? 'unconfigured',
);
let managedAccountOperations = 0;
let managedAccountMutations = 0;
let authState: AppAuthState | null = null;
let authMutation = false;
let authGeneration = 0;
function broadcastAuthState(state: AppAuthState): AppAuthState {
  if (JSON.stringify(authState) !== JSON.stringify(state)) {
    authState = state;
    if (state.status !== 'authenticated' || state.mustChangePassword) rendererUpdateBlocked = true;
    if (window && !window.webContents.isDestroyed())
      window.webContents.send(AUTH_STATE_CHANGED, state);
  }
  if (state.status === 'authenticated' && !state.mustChangePassword) {
    // A closed account modal must not retain a token revoked on another PC.
    // The manager coalesces concurrent checks and only consumes explicit tombstones.
    managedAccountOperations += 1;
    void managedThreads.reconcileDeletedAccounts(state.user.id, authGeneration).finally(() => {
      managedAccountOperations -= 1;
    });
  }
  return state;
}
const serviceAccess = new ServiceAccess(serviceClient, broadcastAuthState);
async function mutateAuth(action: () => Promise<AppAuthState>): Promise<AppAuthState> {
  if (authMutation) throw new Error('진행 중인 로그인 작업을 기다려 주세요.');
  authGeneration += 1;
  authMutation = true;
  try {
    return broadcastAuthState(await action());
  } finally {
    authMutation = false;
  }
}
// Legacy account/history code remains readable, but no desktop Meta request is permitted.
const threadsClient = createDesktopThreadsClient();
const threadsAccounts = new ThreadsAccountManager({
  userData: app.getPath('userData'),
  encryption,
  client: {
    me: (token) => threadsClient.me(token),
    debugToken: (token) => threadsClient.debugToken(token),
    refresh: (token) => threadsClient.refreshAccessToken(token),
  },
});
const threadsStorage = new FileServerStorage({
  userData: app.getPath('userData'),
  encryption,
});
const webpToPng = launchWebpToPng(runtimeRoot);
const threads = new ThreadsPublishingController({
  userData: app.getPath('userData'),
  accounts: threadsAccounts,
  storage: threadsStorage,
  client: threadsClient,
  history: new EncryptedLocalStore<ThreadsHistory>({
    userData: app.getPath('userData'),
    fileName: 'threads-publishing.json',
    encryption,
    validate: validThreadsHistory,
  }),
  currentView: () => controller.view,
  refresh: () => controller.refresh(),
  localBusy: () =>
    maintenance.active ||
    mobilePublications?.active ||
    controller.loading ||
    downloads.active ||
    archives.active ||
    edits.active ||
    deletions.active ||
    comments.active ||
    drafts.active ||
    localPosts.active ||
    draftDeletions.active ||
    captions.active ||
    content.active,
  prepareMedia: (root, ids, directory) =>
    prepareThreadsMedia(registry, root, ids, directory, webpToPng),
  confirm: async (summary) => {
    if (!window || !(await serviceAccess.allowed())) return false;
    const choice = await dialog.showMessageBox(window, {
      type: 'question',
      title: summary.kind === 'post' ? 'Threads 게시글 업로드' : 'Threads 댓글 업로드',
      message: `@${summary.username} 계정에 ${summary.kind === 'post' ? '게시글을' : '댓글을'} 올릴까요?`,
      detail: `${summary.kind === 'post' ? `첨부 ${summary.mediaCount}개\n\n` : ''}${summary.text || '(본문 없음)'}`,
      buttons: ['취소', '게시'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return choice.response === 1 && (await serviceAccess.allowed());
  },
});
const mobilePublications: MobilePublicationsController = new MobilePublicationsController({
  client: serviceClient,
  store: new EncryptedLocalStore<PublicationJournal>({
    userData: app.getPath('userData'),
    fileName: 'mobile-publications.json',
    encryption,
    validate: validPublicationJournal,
  }),
  service: serviceOrigin ?? 'unconfigured',
  userData: app.getPath('userData'),
  refresh: () => controller.refresh(),
  libraryId: () => controller.view.snapshot?.libraryId ?? null,
  localBusy: () =>
    maintenance.active ||
    mobilePublications?.active ||
    controller.loading ||
    downloads.active ||
    archives.active ||
    edits.active ||
    deletions.active ||
    comments.active ||
    drafts.active ||
    localPosts.active ||
    draftDeletions.active ||
    captions.active ||
    content.active ||
    chatGpt.active ||
    threads.active ||
    managedAccountMutations > 0,
  prepareMedia: (root, ids, directory) =>
    prepareThreadsMedia(registry, root, ids, directory, webpToPng),
});
async function guardPublicationWrite<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ServiceApiError) {
      if (['AUTH_REQUIRED', 'AUTH_CHANGED', 'SERVICE_UNAVAILABLE'].includes(error.code))
        await serviceAccess.check();
      throw new ViewError(error.code, error.message);
    }
    throw error;
  }
}
let threadsCloseNoticeOpen = false;
let managedAccountCloseNoticeOpen = false;
function explainManagedAccountWork() {
  if (!window || managedAccountCloseNoticeOpen) return;
  managedAccountCloseNoticeOpen = true;
  void dialog
    .showMessageBox(window, {
      type: 'info',
      title: '계정 정보 저장 중',
      message: '계정 정보 저장과 동기화가 끝난 뒤 앱을 종료할 수 있습니다.',
      buttons: ['확인'],
      noLink: true,
    })
    .finally(() => {
      managedAccountCloseNoticeOpen = false;
    });
}
function explainActiveThreads() {
  if (!window || threadsCloseNoticeOpen) return;
  threadsCloseNoticeOpen = true;
  void dialog
    .showMessageBox(window, {
      type: 'info',
      title: 'Threads 작업 중',
      message: '진행 중인 Threads 작업이 끝난 뒤 앱을 종료할 수 있습니다.',
      buttons: ['확인'],
      noLink: true,
    })
    .finally(() => {
      threadsCloseNoticeOpen = false;
    });
}
function explainActiveDownload(): void {
  if (!window || downloadCloseNoticeOpen) return;
  downloadCloseNoticeOpen = true;
  void dialog
    .showMessageBox(window, {
      type: 'info',
      title: '다운로드 진행 중',
      message: '다운로드가 끝난 뒤 앱을 종료할 수 있습니다.',
      buttons: ['확인'],
      noLink: true,
    })
    .finally(() => {
      downloadCloseNoticeOpen = false;
    });
}

let closing = false;
function updateBusy(): boolean {
  return (
    updateQuitting ||
    managedAccountOperations > 0 ||
    closing ||
    rendererUpdateBlocked ||
    !window ||
    window.isDestroyed() ||
    window.webContents.isDestroyed() ||
    mobilePublications?.active ||
    controller.loading ||
    downloads.active ||
    archives.active ||
    edits.active ||
    deletions.active ||
    comments.active ||
    drafts.active ||
    localPosts.active ||
    draftDeletions.active ||
    captions.active ||
    content.active ||
    chatGpt.active ||
    maintenance.active ||
    threads.active ||
    mobilePublications?.active
  );
}
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
  rendererUpdateBlocked = true;
  window = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 940,
    minHeight: 650,
    show: false,
    backgroundColor: '#f5f6f8',
    title: 'Threads Media Manager',
    icon: appIconPath,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  window.webContents.on('did-start-loading', () => {
    rendererUpdateBlocked = true;
    void localPosts.shutdown();
  });
  window.webContents.on('render-process-gone', () => {
    rendererUpdateBlocked = true;
    void localPosts.shutdown();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.once('ready-to-show', () => window?.show());
  window.on('close', (event) => {
    if (managedAccountOperations > 0) {
      event.preventDefault();
      explainManagedAccountWork();
      return;
    }
    if (threads.active || mobilePublications?.active) {
      event.preventDefault();
      explainActiveThreads();
      return;
    }
    if (downloads.active) {
      event.preventDefault();
      explainActiveDownload();
      return;
    }
    if (
      (!maintenance.active &&
        !downloads.active &&
        !archives.active &&
        !edits.active &&
        !deletions.active &&
        !localPosts.active &&
        !localPosts.hasSelection &&
        !(
          comments.active ||
          drafts.active ||
          localPosts.active ||
          draftDeletions.active ||
          captions.active ||
          content.active ||
          chatGpt.active
        )) ||
      closing
    )
      return;
    event.preventDefault();
    void Promise.all([
      maintenance.shutdown(),
      archives.shutdown(),
      edits.shutdown(),
      deletions.shutdown(),
      comments.shutdown(),
      drafts.shutdown(),
      localPosts.shutdown(),
      draftDeletions.shutdown(),
      captions.cancelAndWait(),
      content.cancelAndWait(),
      chatGpt.cancelAndWait(),
    ]).finally(() => {
      closing = true;
      window?.close();
      closing = false;
    });
  });
  window.on('closed', () => {
    rendererUpdateBlocked = true;
    window = null;
  });
  void window.loadURL(rendererEntry);
}

if (squirrelStartup || !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  void app
    .whenReady()
    .then(async () => {
      if (process.platform === 'darwin') app.dock?.setIcon(appIconPath);
      // Only the application renderer and managed local media may load in this session.
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !isLocalRequest(details.url, rendererEntry) }),
      );
      protocol.handle(MEDIA_SCHEME, async (request) => {
        if (authMutation || !(await serviceAccess.allowed()))
          return new Response(null, { status: 403 });
        return request.url.startsWith('threads-media://ai/')
          ? aiContentEnabled
            ? content.respond(request)
            : new Response(null, { status: 404 })
          : registry.respond(request);
      });
      protocol.handle(IMPORT_MEDIA_SCHEME, async (request) => {
        if (authMutation || !(await serviceAccess.allowed()))
          return new Response(null, { status: 403 });
        return localPosts.respond(request);
      });
      const userData = app.getPath('userData');
      await cleanupPublicationOutbox(userData).catch(() => {});
      let libraryInitialization: Promise<void> | undefined;
      function initializeLibrary(): Promise<void> {
        if (!libraryInitialization)
          libraryInitialization = (async () => {
            try {
              const settings =
                !app.isPackaged && process.env.TMM_SETTINGS_PATH
                  ? process.env.TMM_SETTINGS_PATH
                  : join(homedir(), '.threads-media-manager', 'settings.json');
              const root = await readRootSetting(join(userData, 'view-settings.json'));
              if (!root) {
                // Collector settings are a picker hint, not the app's first-use choice.
                try {
                  initialFolderHint = (await readRootSetting(settings)) ?? undefined;
                } catch {
                  initialFolderHint = undefined;
                }
              }
              if (root) {
                await controller.refresh(root);
                downloads.inspect(root);
                await downloads.settled();
              }
            } catch (error) {
              controller.view = { snapshot: null, error: problem(error) };
            }
          })();
        return libraryInitialization;
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
              rendererEntry,
            )
          )
            throw new Error('Unauthorized request');
          if (updateQuitting) throw new Error('업데이트 적용을 위해 앱을 재시작하고 있습니다.');
          if (channel === IPC.reportUpdateBlocked) {
            if (args.length !== 1 || typeof args[0] !== 'boolean') {
              rendererUpdateBlocked = true;
              throw new Error('Invalid update readiness');
            }
            rendererUpdateBlocked = args[0];
            return;
          }
          if (channel === IPC.getAuthState) {
            if (args.length) throw new Error('Unexpected arguments');
            return serviceAccess.check();
          }
          if (
            mobilePublications.active &&
            [IPC.signIn, IPC.signOut, IPC.changePassword].some((c) => c === channel)
          )
            throw new Error('게시 대기 전송이 끝난 뒤 계정 작업을 진행하세요.');
          if (channel === IPC.signIn || channel === IPC.changePassword) {
            if (args.length !== 2 || typeof args[0] !== 'string' || typeof args[1] !== 'string')
              throw new Error('Invalid auth input');
            const first = args[0];
            const second = args[1];
            return mutateAuth(() =>
              channel === IPC.signIn
                ? serviceClient.signIn(first, second)
                : serviceClient.changePassword(first, second),
            );
          }
          if (channel === IPC.signOut) {
            if (args.length) throw new Error('Unexpected arguments');
            return mutateAuth(() => serviceClient.signOut());
          }
          if (authMutation) throw new Error('로그인 상태를 확인 중입니다.');
          const requestAuthGeneration = authGeneration;
          await serviceAccess.require();
          if (authMutation || requestAuthGeneration !== authGeneration)
            throw new Error('로그인이 변경되었습니다. 다시 시도해 주세요.');
          if (mobilePublicationBlocks(channel, mobilePublications.active))
            throw new Error('게시 대기 전송이 끝난 뒤 작업하세요.');
          if (channel.startsWith('tmm:managed-threads:')) {
            managedAccountOperations += 1;
            const mutation = channel !== IPC.managedThreadsAccounts;
            if (mutation) managedAccountMutations += 1;
            try {
              const result = await handleManagedThreadsRequest(channel, args, managedThreads);
              if (authMutation || requestAuthGeneration !== authGeneration)
                throw new Error('로그인이 변경되었습니다. 다시 시도해 주세요.');
              if (
                result.problem &&
                ['AUTH_REQUIRED', 'AUTH_CHANGED', 'SERVICE_UNAVAILABLE'].includes(
                  result.problem.code,
                )
              )
                await serviceAccess.check();
              if (authMutation || requestAuthGeneration !== authGeneration)
                throw new Error('로그인이 변경되었습니다. 다시 시도해 주세요.');
              return result;
            } finally {
              managedAccountOperations -= 1;
              if (mutation) managedAccountMutations -= 1;
            }
          }
          await initializeLibrary();
          if (mobilePublicationBlocks(channel, mobilePublications.active))
            throw new Error('게시 대기 전송이 끝난 뒤 작업하세요.');
          if (channel.startsWith('tmm:mobile-publications:')) {
            if (args.length !== (channel === IPC.mobilePublicationStatuses ? 0 : 1))
              throw new Error('Unexpected arguments');
            const result =
              channel === IPC.mobilePublications
                ? await mobilePublications.get(args[0])
                : channel === IPC.sendMobilePublication
                  ? await mobilePublications.send(args[0])
                  : channel === IPC.retryMobilePublication
                    ? await mobilePublications.retry(args[0])
                    : channel === IPC.cancelPendingMobilePublication
                      ? await mobilePublications.cancelPending(args[0])
                      : channel === IPC.mobilePublicationStatuses
                        ? await mobilePublications.statuses()
                        : await mobilePublications.recall(args[0]);
            if (authMutation || requestAuthGeneration !== authGeneration)
              throw new Error('로그인이 변경되었습니다. 다시 확인하세요.');
            if (
              result.problem &&
              ['AUTH_REQUIRED', 'AUTH_CHANGED', 'SERVICE_UNAVAILABLE'].includes(result.problem.code)
            )
              await serviceAccess.check();
            return result;
          }
          if (channel === IPC.capabilities) {
            if (args.length) throw new Error('Unexpected arguments');
            return { aiContent: aiContentEnabled };
          }
          if (channel.startsWith('tmm:chatgpt:')) {
            if (args.length) throw new Error('Unexpected arguments');
            if (channel === IPC.chatGptState) return chatGpt.state();
            if (channel === IPC.loginChatGpt) return chatGpt.login();
            if (channel === IPC.cancelChatGptLogin) return chatGpt.cancelLogin();
            if (channel === IPC.logoutChatGpt) return chatGpt.logout();
          }
          if (channel.startsWith('tmm:threads:')) {
            const hasInput = [
              IPC.connectThreads,
              IPC.connectFileServer,
              IPC.publishThreadsPost,
              IPC.publishThreadsComment,
              IPC.reconcileThreadsPublication,
            ].some((value) => value === channel);
            if (args.length !== (hasInput ? 1 : 0)) throw new Error('Unexpected arguments');
            if (channel === IPC.threadsState)
              return { ...(await threads.state()), desktopRequestsDisabled: true };
            // All mutations are paused until the mobile/S3 account workflow is connected.
            return {
              status: 'error',
              problem: {
                code: 'desktop_meta_disabled',
                message:
                  'PC의 Threads 게시·토큰 확인·갱신·통계 기능은 중단되었습니다. 모바일 연결 기능을 준비 중입니다.',
              },
            };
            /* Legacy implementation retained for history and migration reference.
            if (channel === IPC.connectThreads) return threads.connect(args[0]);
            if (channel === IPC.disconnectThreads) return threads.disconnect();
            if (channel === IPC.connectFileServer) return threads.connectFileServer(args[0]);
            if (channel === IPC.disconnectFileServer) return threads.disconnectFileServer();
            if (channel === IPC.publishThreadsPost) return threads.publish(args[0], 'post');
            if (channel === IPC.publishThreadsComment) return threads.publish(args[0], 'reply');
            if (channel === IPC.syncThreadsInsights) return threads.sync();
            if (channel === IPC.reconcileThreadsPublication) return threads.reconcile(args[0]);
            */
          }
          if (channel === IPC.discardLocalPostMedia) {
            if (args.length !== 1 || typeof args[0] !== 'string')
              throw new Error('Unexpected arguments');
            await localPosts.discard(args[0]);
            return;
          }
          if (
            threads.publishing &&
            ![IPC.current, IPC.downloadStatus, IPC.libraryRoot, IPC.openPostLink].some(
              (value) => value === channel,
            )
          ) {
            if (channel.startsWith('tmm:download:')) return downloads.view;
            if (channel === IPC.choose || channel === IPC.refresh) return controller.view;
            return {
              status: 'error',
              problem: { code: 'threads_busy', message: 'Threads 업로드가 끝난 뒤 실행하세요.' },
            };
          }
          if (
            !aiContentEnabled &&
            [
              IPC.generateContent,
              IPC.loadContent,
              IPC.revealContent,
              IPC.copyContentCaption,
              IPC.cancelContent,
            ].some((value) => value === channel)
          ) {
            return {
              status: 'error',
              problem: {
                code: 'content_development_only',
                message: 'AI 이미지 생성은 개발 실행에서만 사용할 수 있습니다.',
              },
            };
          }
          if (
            channel === IPC.pickLocalPostMedia ||
            channel === IPC.addLocalPostMedia ||
            channel === IPC.createLocalPost
          ) {
            if (args.length !== (channel === IPC.pickLocalPostMedia ? 0 : 1))
              throw new Error('Unexpected arguments');
            if (!controller.root)
              return {
                status: 'error',
                problem: {
                  code: 'local_post_folder',
                  message: '설정에서 작업 폴더를 연결한 뒤 새 글을 작성하세요.',
                },
              };
            if (deletionNeedsRecovery())
              return {
                status: 'error',
                problem: {
                  code: 'deletion_recovery_required',
                  message: '중단된 삭제 작업을 먼저 복구하세요.',
                },
              };
            if (channel === IPC.pickLocalPostMedia) return localPosts.pick(controller.root);
            if (channel === IPC.addLocalPostMedia) return localPosts.add(controller.root, args[0]);
            const result = await localPosts.create(controller.root, args[0]);
            if (result.status === 'saved') controller.view = result.view;
            return result;
          }
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
            channel === IPC.savePostComment ||
            channel === IPC.savePostDraft ||
            channel === IPC.deletePostDraft ||
            channel === IPC.exportPostDraft ||
            channel === IPC.generateCaption ||
            channel === IPC.generateContent ||
            channel === IPC.loadContent ||
            channel === IPC.revealContent ||
            channel === IPC.copyContentCaption
          ) {
            if (args.length !== 1) throw new Error('Unexpected arguments');
          } else if (args.length) throw new Error('Unexpected arguments');
          if (channel === IPC.current) return controller.view;
          if (channel === IPC.downloadStatus) return downloads.view;
          if (channel === IPC.libraryRoot) return controller.root;

          if (
            [IPC.backupDatabase, IPC.restoreDatabase, IPC.reconnectLibrary, IPC.choose].some(
              (value) => value === channel,
            )
          ) {
            const result =
              channel === IPC.backupDatabase
                ? await maintenance.backup(controller.root)
                : channel === IPC.restoreDatabase
                  ? await maintenance.restore(controller.root)
                  : await maintenance.reconnect(controller.root);
            if (result.status === 'complete') {
              if (channel !== IPC.backupDatabase) await localPosts.shutdown();
              controller.view = result.view;
              if ((channel === IPC.reconnectLibrary || channel === IPC.choose) && controller.root) {
                try {
                  await rememberRoot(userData, controller.root);
                } catch {
                  const failure = {
                    status: 'error' as const,
                    problem: {
                      code: 'settings_save_failed',
                      message: '폴더 위치를 기억하지 못했습니다. 설정에서 다시 연결하세요.',
                    },
                  };
                  if (channel === IPC.choose) {
                    controller.view = { ...controller.view, error: failure.problem };
                    return controller.view;
                  }
                  return failure;
                }
              }
            }
            if (channel === IPC.choose) {
              if (result.status === 'error')
                controller.view = { ...controller.view, error: result.problem };
              return controller.view;
            }
            return result;
          }
          if (channel === IPC.cancelContent) {
            await content.cancelAndWait();
            return;
          }
          if (
            [IPC.generateContent, IPC.loadContent, IPC.revealContent, IPC.copyContentCaption].some(
              (value) => value === channel,
            )
          ) {
            const input = parseContentInput(args[0]);
            if (
              !controller.root ||
              !controller.view.snapshot?.posts.some((p) => p.key === input.postKey)
            )
              return {
                status: 'error',
                problem: { code: 'content_source', message: '원본 게시글을 찾을 수 없습니다.' },
              };
            if (
              maintenance.active ||
              mobilePublications?.active ||
              controller.loading ||
              downloads.active ||
              archives.active ||
              edits.active ||
              deletions.active ||
              comments.active ||
              drafts.active ||
              localPosts.active ||
              draftDeletions.active ||
              captions.active ||
              content.active ||
              deletionNeedsRecovery()
            )
              return {
                status: 'error',
                problem: {
                  code: 'content_busy',
                  message: '진행 중인 작업이 끝난 뒤 AI 초안을 여세요.',
                },
              };
            if (channel === IPC.generateContent) {
              const result = await content.generate(controller.root, input);
              if (result.status === 'generated') await controller.refresh();
              return result;
            }
            const result = await content.load(controller.root, input);
            if (channel === IPC.revealContent || channel === IPC.copyContentCaption) {
              if (result.status !== 'generated')
                return {
                  status: 'error',
                  problem: {
                    code: 'content_saved',
                    message: '저장된 AI 초안을 확인하지 못했습니다.',
                  },
                };
              if (channel === IPC.copyContentCaption) clipboard.writeText(result.draft.caption);
              else shell.showItemInFolder(join(result.draft.directory, 'draft.json'));
              return { status: 'opened' };
            }
            return result;
          }
          if (channel === IPC.cancelCaption) {
            captions.cancel();
            return;
          }
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
              IPC.savePostDraft,
              IPC.deletePostDraft,
              IPC.exportPostDraft,
              IPC.generateCaption,
              IPC.exportPost,
              IPC.downloadPrepare,
              IPC.downloadStart,
              IPC.downloadRecover,
              IPC.downloadResume,
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
          if (channel === IPC.deletePostDraft) {
            if (!controller.root)
              return {
                status: 'error',
                problem: { code: 'draft_source', message: '수집 폴더를 연결한 뒤 삭제하세요.' },
              };
            const result = await draftDeletions.delete(controller.root, args[0]);
            if (result.status === 'deleted') controller.view = result.view;
            return result;
          }
          if (channel === IPC.savePostDraft || channel === IPC.generateCaption) {
            if (!controller.root)
              return {
                status: 'error',
                problem: {
                  code: 'draft_source',
                  message: '수집 폴더를 연결한 뒤 게시글을 등록하세요.',
                },
              };
            if (channel === IPC.generateCaption) {
              if (
                maintenance.active ||
                mobilePublications?.active ||
                controller.loading ||
                downloads.active ||
                archives.active ||
                edits.active ||
                deletions.active ||
                comments.active ||
                drafts.active ||
                localPosts.active ||
                draftDeletions.active ||
                captions.active ||
                content.active ||
                chatGpt.active
              )
                return {
                  status: 'error',
                  problem: {
                    code: 'caption_busy',
                    message: '진행 중인 작업이 끝난 뒤 캡션을 생성하세요.',
                  },
                };
              return captions.generate(controller.root, args[0]);
            }
            const result = await drafts.save(controller.root, args[0]);
            if (result.status === 'saved') controller.view = result.view;
            return result;
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
          if (channel === IPC.exportPost || channel === IPC.exportPostDraft) {
            if (
              maintenance.active ||
              mobilePublications?.active ||
              controller.loading ||
              downloads.active ||
              edits.active ||
              deletions.active ||
              comments.active ||
              drafts.active ||
              localPosts.active ||
              draftDeletions.active ||
              captions.active ||
              content.active ||
              !controller.root
            )
              return {
                status: 'error',
                problem: {
                  code: 'export_busy',
                  message: '진행 중인 작업이 끝난 뒤 ZIP을 저장하세요.',
                },
              };
            return channel === IPC.exportPost
              ? archives.export(controller.root, args[0] as string)
              : archives.exportDraft(controller.root, args[0]);
          }
          if (
            maintenance.active ||
            archives.active ||
            edits.active ||
            deletions.active ||
            comments.active ||
            drafts.active ||
            localPosts.active ||
            draftDeletions.active ||
            captions.active ||
            content.active
          )
            return channel.startsWith('tmm:download:') ? downloads.view : controller.view;
          if (controller.loading) {
            return channel.startsWith('tmm:download:') ? downloads.view : controller.view;
          }
          if (channel === IPC.downloadPrepare)
            return downloads.prepare(currentRoot(), args[0] as string);
          if (channel === IPC.downloadStart) return downloads.startAll(currentRoot());
          if (channel === IPC.downloadResume) {
            if (!controller.root) throw new Error('Connect a collection before recovery');
            return downloads.resume(controller.root);
          }
          if (channel === IPC.downloadRecover) {
            if (!controller.root) throw new Error('Connect a collection before recovery');
            return downloads.recover(controller.root);
          }
          if (downloads.active) return controller.view;
          if (channel === IPC.refresh) {
            await controller.refresh();
            if (controller.root) {
              downloads.inspect(controller.root);
              await downloads.settled();
            }
            return controller.view;
          }
          return controller.view;
        });
      }
      createWindow();
      stopAutoUpdates = configureAutoUpdates({
        getWindow: () => window,
        isBusy: updateBusy,
        repository: TMM_GITHUB_REPOSITORY,
        onBeforeRestart: () => {
          updateQuitting = true;
        },
        onRestartError: () => {
          updateQuitting = false;
        },
      });
      const accessTimer = setInterval(() => {
        if (!updateQuitting && !authMutation) void serviceAccess.check();
      }, 60_000);
      accessTimer.unref();
      powerMonitor.on('resume', () => {
        if (!updateQuitting && !authMutation) void serviceAccess.check();
      });
      // Desktop token refresh and statistics scheduling are intentionally stopped.
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
    if (managedAccountOperations > 0) {
      event.preventDefault();
      explainManagedAccountWork();
      return;
    }
    if (threads.active || mobilePublications?.active) {
      event.preventDefault();
      explainActiveThreads();
      return;
    }
    if (downloads.active) {
      event.preventDefault();
      explainActiveDownload();
      return;
    }
    if (
      (!maintenance.active &&
        !downloads.active &&
        !archives.active &&
        !edits.active &&
        !deletions.active &&
        !localPosts.active &&
        !localPosts.hasSelection &&
        !(
          comments.active ||
          drafts.active ||
          localPosts.active ||
          draftDeletions.active ||
          captions.active ||
          content.active ||
          chatGpt.active
        )) ||
      closing
    )
      return;
    event.preventDefault();
    void Promise.all([
      maintenance.shutdown(),
      archives.shutdown(),
      edits.shutdown(),
      deletions.shutdown(),
      comments.shutdown(),
      drafts.shutdown(),
      localPosts.shutdown(),
      draftDeletions.shutdown(),
      captions.shutdown(),
      content.shutdown(),
      chatGpt.shutdown(),
    ]).finally(() => {
      closing = true;
      app.quit();
    });
  });
  app.on('will-quit', () => stopAutoUpdates());
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
