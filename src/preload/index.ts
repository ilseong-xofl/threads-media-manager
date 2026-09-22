import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type ThreadsMediaApi } from '../shared/contracts';
const api: ThreadsMediaApi = {
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
  generateCaption: (input) => ipcRenderer.invoke(IPC.generateCaption, input),
  cancelCaption: () => ipcRenderer.invoke(IPC.cancelCaption),
};
contextBridge.exposeInMainWorld('threadsMedia', Object.freeze(api));
