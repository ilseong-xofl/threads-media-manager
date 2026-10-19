import { afterEach, expect, it, vi } from 'vitest';
import { createDesktopThreadsClient } from './desktop-threads';

afterEach(() => vi.unstubAllGlobals());
it('blocks profile, validation, refresh, posting, replies, status and statistics before transport', async () => {
  const network = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', network);
  const client = createDesktopThreadsClient();
  const token = 'synthetic-token-never-sent';
  for (const operation of [
    () => client.me(token),
    () => client.debugToken(token),
    () => client.refreshAccessToken(token),
    () => client.createContainer(token, '123', { media_type: 'TEXT', text: 'synthetic' }),
    () =>
      client.createContainer(token, '123', {
        media_type: 'TEXT',
        text: 'synthetic',
        reply_to_id: '456',
      }),
    () => client.publishContainer(token, '123', '456'),
    () => client.containerStatus(token, '456'),
    () => client.insights(token, '456'),
    () => client.retrieveMedia(token, '456'),
  ])
    await expect(operation()).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
});
