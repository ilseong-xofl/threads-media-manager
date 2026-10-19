import { ThreadsClient } from './threads-client';

/** Keep legacy history/controllers intact while disabling every desktop Meta transport. */
export function createDesktopThreadsClient(): ThreadsClient {
  return new ThreadsClient({
    fetch: async () => {
      throw new Error('Desktop Meta requests are disabled');
    },
  });
}
