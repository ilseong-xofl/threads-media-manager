import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type ThreadsMediaApi } from '../shared/contracts';
const api: ThreadsMediaApi = {
  current: () => ipcRenderer.invoke(IPC.current),
  chooseFolder: () => ipcRenderer.invoke(IPC.choose),
  refresh: () => ipcRenderer.invoke(IPC.refresh),
  downloadStatus: () => ipcRenderer.invoke(IPC.downloadStatus),
  prepareDownload: (account) => ipcRenderer.invoke(IPC.downloadPrepare, account),
  startDownload: () => ipcRenderer.invoke(IPC.downloadStart),
  stopDownload: () => ipcRenderer.invoke(IPC.downloadStop),
  recoverDownloads: () => ipcRenderer.invoke(IPC.downloadRecover),
  exportPost: (postKey) => ipcRenderer.invoke(IPC.exportPost, postKey),
  saveMediaEdit: (input) => ipcRenderer.invoke(IPC.saveMediaEdit, input),
  deleteMedia: (input) => ipcRenderer.invoke(IPC.deleteMedia, input),
  recoverDeletions: () => ipcRenderer.invoke(IPC.recoverDeletions),
  savePostComment: (input) => ipcRenderer.invoke(IPC.savePostComment, input),
  openPostLink: (input) => ipcRenderer.invoke(IPC.openPostLink, input),
};
contextBridge.exposeInMainWorld('threadsMedia', Object.freeze(api));
