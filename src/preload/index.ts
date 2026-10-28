import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { AUTH_STATE_CHANGED, type AppAuthState } from '../shared/service-auth';
import { IPC, type ThreadsMediaApi } from '../shared/contracts';
const api: ThreadsMediaApi = {
  getAuthState: () => ipcRenderer.invoke(IPC.getAuthState),
  getManagedThreadsAccounts: () => ipcRenderer.invoke(IPC.managedThreadsAccounts),
  deleteManagedThreadsAccount: (input) =>
    ipcRenderer.invoke(IPC.deleteManagedThreadsAccount, input),
  registerManagedThreadsAccount: (input) =>
    ipcRenderer.invoke(IPC.registerManagedThreadsAccount, input),
  replaceManagedThreadsToken: (input) => ipcRenderer.invoke(IPC.replaceManagedThreadsToken, input),
  updateManagedThreadsAccount: (input) =>
    ipcRenderer.invoke(IPC.updateManagedThreadsAccount, input),
  recheckManagedThreadsAccount: (input) =>
    ipcRenderer.invoke(IPC.recheckManagedThreadsAccount, input),
  refreshManagedThreadsToken: (input) => ipcRenderer.invoke(IPC.refreshManagedThreadsToken, input),
  retryManagedThreadsAccount: (input) => ipcRenderer.invoke(IPC.retryManagedThreadsAccount, input),
  getMobilePublications: (input) => ipcRenderer.invoke(IPC.mobilePublications, input),
  getMobilePublicationStatuses: () => ipcRenderer.invoke(IPC.mobilePublicationStatuses),
  sendMobilePublication: (input) => ipcRenderer.invoke(IPC.sendMobilePublication, input),
  retryMobilePublication: (input) => ipcRenderer.invoke(IPC.retryMobilePublication, input),
  cancelPendingMobilePublication: (input) =>
    ipcRenderer.invoke(IPC.cancelPendingMobilePublication, input),
  recallMobilePublication: (input) => ipcRenderer.invoke(IPC.recallMobilePublication, input),
  signIn: (accountId, password) => ipcRenderer.invoke(IPC.signIn, accountId, password),
  signOut: () => ipcRenderer.invoke(IPC.signOut),
  changePassword: (currentPassword, newPassword) =>
    ipcRenderer.invoke(IPC.changePassword, currentPassword, newPassword),
  onAuthStateChanged: (listener) => {
    const callback = (_event: unknown, state: AppAuthState) => listener(state);
    ipcRenderer.on(AUTH_STATE_CHANGED, callback);
    return () => ipcRenderer.removeListener(AUTH_STATE_CHANGED, callback);
  },
  reportUpdateBlocked: (blocked) => ipcRenderer.invoke(IPC.reportUpdateBlocked, blocked),
  chatGptState: () => ipcRenderer.invoke(IPC.chatGptState),
  loginChatGpt: () => ipcRenderer.invoke(IPC.loginChatGpt),
  cancelChatGptLogin: () => ipcRenderer.invoke(IPC.cancelChatGptLogin),
  logoutChatGpt: () => ipcRenderer.invoke(IPC.logoutChatGpt),
  threadsState: () => ipcRenderer.invoke(IPC.threadsState),
  connectThreads: (input) => ipcRenderer.invoke(IPC.connectThreads, input),
  disconnectThreads: () => ipcRenderer.invoke(IPC.disconnectThreads),
  connectFileServer: (input) => ipcRenderer.invoke(IPC.connectFileServer, input),
  disconnectFileServer: () => ipcRenderer.invoke(IPC.disconnectFileServer),
  publishThreadsPost: (input) => ipcRenderer.invoke(IPC.publishThreadsPost, input),
  publishThreadsComment: (input) => ipcRenderer.invoke(IPC.publishThreadsComment, input),
  syncThreadsInsights: () => ipcRenderer.invoke(IPC.syncThreadsInsights),
  reconcileThreadsPublication: (input) =>
    ipcRenderer.invoke(IPC.reconcileThreadsPublication, input),
  capabilities: () => ipcRenderer.invoke(IPC.capabilities),
  current: () => ipcRenderer.invoke(IPC.current),
  chooseFolder: () => ipcRenderer.invoke(IPC.choose),
  refresh: () => ipcRenderer.invoke(IPC.refresh),
  downloadStatus: () => ipcRenderer.invoke(IPC.downloadStatus),
  prepareDownload: (account) => ipcRenderer.invoke(IPC.downloadPrepare, account),
  startDownload: () => ipcRenderer.invoke(IPC.downloadStart),
  resumeDownloads: () => ipcRenderer.invoke(IPC.downloadResume),
  recoverDownloads: () => ipcRenderer.invoke(IPC.downloadRecover),
  libraryRoot: () => ipcRenderer.invoke(IPC.libraryRoot),
  backupDatabase: () => ipcRenderer.invoke(IPC.backupDatabase),
  restoreDatabase: () => ipcRenderer.invoke(IPC.restoreDatabase),
  reconnectLibrary: () => ipcRenderer.invoke(IPC.reconnectLibrary),
  exportPost: (postKey) => ipcRenderer.invoke(IPC.exportPost, postKey),
  exportPostDraft: (input) => ipcRenderer.invoke(IPC.exportPostDraft, input),
  deletePostDraft: (input) => ipcRenderer.invoke(IPC.deletePostDraft, input),
  saveMediaEdit: (input) => ipcRenderer.invoke(IPC.saveMediaEdit, input),
  deleteMedia: (input) => ipcRenderer.invoke(IPC.deleteMedia, input),
  recoverDeletions: () => ipcRenderer.invoke(IPC.recoverDeletions),
  savePostComment: (input) => ipcRenderer.invoke(IPC.savePostComment, input),
  openPostLink: (input) => ipcRenderer.invoke(IPC.openPostLink, input),
  savePostDraft: (input) => ipcRenderer.invoke(IPC.savePostDraft, input),
  pickLocalPostMedia: () => ipcRenderer.invoke(IPC.pickLocalPostMedia),
  addLocalPostMedia: async (files, current) => {
    try {
      if (!Array.isArray(files) || files.length < 1 || files.length > 100)
        throw new Error('Invalid drop');
      // Only Electron can extract the native path from a real dropped File.
      // Never expose a renderer-callable path-string import or return these paths.
      const paths = files.map((file) => webUtils.getPathForFile(file));
      if (paths.some((path) => !path)) throw new Error('No native file');
      return await ipcRenderer.invoke(IPC.addLocalPostMedia, {
        paths,
        ...(current === undefined ? {} : { current }),
      });
    } catch {
      return {
        status: 'error',
        problem: {
          code: 'local_post_drop',
          message: '내 컴퓨터의 이미지·영상 파일을 최대 100개까지 끌어다 놓으세요.',
        },
      };
    }
  },
  createLocalPost: (input) => ipcRenderer.invoke(IPC.createLocalPost, input),
  discardLocalPostMedia: (selectionId) =>
    ipcRenderer.invoke(IPC.discardLocalPostMedia, selectionId),
  generateCaption: (input) => ipcRenderer.invoke(IPC.generateCaption, input),
  cancelCaption: () => ipcRenderer.invoke(IPC.cancelCaption),
  generateContent: (input) => ipcRenderer.invoke(IPC.generateContent, input),
  loadContent: (input) => ipcRenderer.invoke(IPC.loadContent, input),
  revealContent: (input) => ipcRenderer.invoke(IPC.revealContent, input),
  cancelContent: () => ipcRenderer.invoke(IPC.cancelContent),
  copyContentCaption: (input) => ipcRenderer.invoke(IPC.copyContentCaption, input),
};
contextBridge.exposeInMainWorld('threadsMedia', Object.freeze(api));
