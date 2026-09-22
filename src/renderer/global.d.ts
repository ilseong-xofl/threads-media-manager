import type { ThreadsMediaApi } from '../shared/contracts';
declare global {
  interface Window {
    threadsMedia: ThreadsMediaApi;
  }
}
