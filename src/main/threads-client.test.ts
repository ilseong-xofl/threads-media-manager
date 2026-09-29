import { describe, expect, it, vi } from 'vitest';
import { ThreadsApiError, ThreadsClient, type ThreadsContainerFields } from './threads-client';

const TOKEN = 'synthetic-test-token';
function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers });
}
function setup(responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return { fetch, client: new ThreadsClient({ fetch }) };
}

async function failure(promise: Promise<unknown>): Promise<ThreadsApiError> {
  try {
    await promise;
    throw new Error('Expected a Threads request failure');
  } catch (error) {
    expect(error).toBeInstanceOf(ThreadsApiError);
    return error as ThreadsApiError;
  }
}

describe('Threads HTTP client', () => {
  it('keeps GET authentication inside a fixed HTTPS origin and rejects redirects', async () => {
    const { client, fetch } = setup([json({ id: '123', username: 'demo' })]);
    expect(await client.me(TOKEN)).toEqual({ id: '123', username: 'demo' });
    const [input, options] = fetch.mock.calls[0];
    const url = new URL(String(input));
    expect(url.origin).toBe('https://graph.threads.com');
    expect(url.pathname).toBe('/v1.0/me');
    expect(url.searchParams.get('fields')).toBe('id,username');
    expect(url.searchParams.get('access_token')).toBe(TOKEN);
    expect(options).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('reads the real token expiry with the same tester token in both debug parameters', async () => {
    const expiresAt = 1752254132;
    const { client, fetch } = setup([
      json({
        data: {
          type: 'USER',
          is_valid: true,
          user_id: '123',
          expires_at: expiresAt,
          issued_at: 1747070132,
          data_access_expires_at: 1754846089,
        },
      }),
    ]);
    expect(await client.debugToken(TOKEN)).toEqual({ userId: '123', expiresAt });
    const [input, options] = fetch.mock.calls[0];
    const url = new URL(String(input));
    expect(url.origin).toBe('https://graph.threads.com');
    expect(url.pathname).toBe('/v1.0/debug_token');
    expect(url.searchParams.get('input_token')).toBe(TOKEN);
    expect(url.searchParams.get('access_token')).toBe(TOKEN);
    expect(options).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('recognizes an invalid or expired token even when the other metadata is absent', async () => {
    const { client } = setup([json({ data: { is_valid: false } })]);
    expect(await failure(client.debugToken(TOKEN))).toMatchObject({
      code: 'auth_expired',
      maybeSent: false,
    });
  });

  it.each([
    {},
    { data: null },
    { data: [] },
    { data: { type: 'USER', user_id: '123', expires_at: 1752254132 } },
    { data: { is_valid: true, type: 'APP', user_id: '123', expires_at: 1752254132 } },
    { data: { is_valid: true, type: 'USER', user_id: 'invalid', expires_at: 1752254132 } },
    { data: { is_valid: true, type: 'USER', user_id: '123' } },
    { data: { is_valid: true, type: 'USER', user_id: '123', data_access_expires_at: 1754846089 } },
    ...[0, -1, 1.5, '1752254132', Number.MAX_SAFE_INTEGER + 1, 8640000000001].map((expires_at) => ({
      data: { is_valid: true, type: 'USER', user_id: '123', expires_at },
    })),
  ])(
    'rejects missing or malformed token metadata without guessing the expiry',
    async (response) => {
      const { client } = setup([json(response)]);
      expect(await failure(client.debugToken(TOKEN))).toMatchObject({
        code: 'invalid_response',
        maybeSent: false,
      });
    },
  );

  it('returns a safe permission error when the token cannot authenticate a debug request', async () => {
    const { client, fetch } = setup([
      json(
        {
          error: {
            code: 10,
            message: `debug_token?input_token=${TOKEN}&access_token=${TOKEN}`,
          },
        },
        403,
      ),
    ]);
    const error = await failure(client.debugToken(TOKEN));
    expect(error).toMatchObject({ code: 'permission_missing', maybeSent: false });
    expect(error.message).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(error.cause).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('exchanges the existing token for the server supplied token and expiry', async () => {
    const { client, fetch } = setup([
      json({
        access_token: 'synthetic-refreshed-token',
        expires_in: 5184000,
        token_type: 'bearer',
      }),
    ]);
    expect(await client.refreshAccessToken(TOKEN)).toEqual({
      accessToken: 'synthetic-refreshed-token',
      expiresIn: 5184000,
    });
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.pathname).toBe('/refresh_access_token');
    expect(url.searchParams.get('grant_type')).toBe('th_refresh_token');
  });

  it('creates a reply and publishes once with encoded form data and no token in the POST URL', async () => {
    const { client, fetch } = setup([json({ id: '456' }), json({ id: '789' })]);
    expect(
      await client.createContainer(TOKEN, '123', {
        media_type: 'TEXT',
        text: '한글 & ? + = 댓글',
        reply_to_id: '321',
      }),
    ).toEqual({ id: '456' });
    expect(await client.publishContainer(TOKEN, '123', '456')).toEqual({ id: '789' });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [input, options] = fetch.mock.calls[0];
    expect(String(input)).toBe('https://graph.threads.com/v1.0/123/threads');
    expect(options?.method).toBe('POST');
    const form = new URLSearchParams(String(options?.body));
    expect(Object.fromEntries(form)).toEqual({
      media_type: 'TEXT',
      text: '한글 & ? + = 댓글',
      reply_to_id: '321',
      access_token: TOKEN,
    });
    expect(new URLSearchParams(String(fetch.mock.calls[1][1]?.body)).get('creation_id')).toBe(
      '456',
    );
  });

  it('encodes carousel child IDs and image URLs as form values', async () => {
    const { client, fetch } = setup([json({ id: '456' }), json({ id: '789' })]);
    await client.createContainer(TOKEN, '123', {
      media_type: 'IMAGE',
      image_url: 'https://media.example.test/a.jpg?part=1&name=example',
      is_carousel_item: true,
    });
    await client.createContainer(TOKEN, '123', {
      media_type: 'CAROUSEL',
      children: ['456', '654'],
    });
    const image = new URLSearchParams(String(fetch.mock.calls[0][1]?.body));
    expect(image.get('image_url')).toBe('https://media.example.test/a.jpg?part=1&name=example');
    expect(image.get('is_carousel_item')).toBe('true');
    expect(new URLSearchParams(String(fetch.mock.calls[1][1]?.body)).get('children')).toBe(
      '456,654',
    );
  });

  it('preserves missing insights as unknown while accepting a real zero', async () => {
    const { client, fetch } = setup([
      json({
        data: [
          { name: 'likes', values: [{ value: 0 }] },
          { name: 'replies', values: [{ value: 8 }] },
        ],
      }),
      json({ data: [] }),
    ]);
    expect(await client.insights(TOKEN, '456')).toEqual({ views: null, likes: 0, replies: 8 });
    expect(await client.insights(TOKEN, '789')).toEqual({
      views: null,
      likes: null,
      replies: null,
    });
    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get('metric')).toBe(
      'views,likes,replies',
    );
  });

  it('reads only safe container state and ignores remote error messages', async () => {
    const { client, fetch } = setup([json({ id: '456', status: 'ERROR', error_message: TOKEN })]);
    expect(await client.containerStatus(TOKEN, '456')).toEqual({ id: '456', status: 'ERROR' });
    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get('fields')).toBe('id,status');
  });

  it('returns media ownership and reply identity for caller reconciliation', async () => {
    const { client } = setup([
      json({
        id: '789',
        text: 'Saved caption',
        username: 'demo',
        owner: { id: '123' },
        is_reply: true,
        replied_to: { id: '321' },
        permalink: 'https://www.threads.com/@demo/post/example',
      }),
    ]);
    expect(await client.retrieveMedia(TOKEN, '789')).toEqual({
      id: '789',
      text: 'Saved caption',
      username: 'demo',
      ownerId: '123',
      isReply: true,
      repliedToId: '321',
      permalink: 'https://www.threads.com/@demo/post/example',
      timestamp: null,
      mediaType: null,
    });
  });

  it.each([
    [400, 190, 'auth_expired'],
    [403, 200, 'permission_missing'],
    [429, 4, 'rate_limited'],
    [400, 613, 'rate_limited'],
    [403, 4, 'rate_limited'],
    [404, 100, 'not_found'],
    [400, 100, 'remote_rejected'],
    [503, 2, 'remote_unavailable'],
  ])(
    'classifies HTTP %s / API %s without leaking raw response details',
    async (status, apiCode, code) => {
      const { client, fetch } = setup([
        json(
          {
            error: {
              code: apiCode,
              message: `https://secret.example/?access_token=${TOKEN}`,
              fbtrace_id: TOKEN,
            },
          },
          Number(status),
          { 'retry-after': '120' },
        ),
      ]);
      const error = await failure(client.publishContainer(TOKEN, '123', '456'));
      expect(error.code).toBe(code);
      expect(error.retryAfterSeconds).toBe(120);
      expect(error.maybeSent).toBe(status === 503);
      expect(JSON.stringify(error)).not.toContain(TOKEN);
      expect(error.message).not.toContain('secret.example');
      expect(error.cause).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('never retries a lost publish response and marks its outcome uncertain', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error(`Request failed ${TOKEN}`));
    const client = new ThreadsClient({ fetch });
    const error = await failure(client.publishContainer(TOKEN, '123', '456'));
    expect(error).toMatchObject({ code: 'network', maybeSent: true });
    expect(error.message).not.toContain(TOKEN);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await failure(client.me(TOKEN))).toMatchObject({ code: 'network', maybeSent: false });
  });

  it('times out and aborts a stalled request without retry or raw errors', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(() => new Promise(() => {}));
      const client = new ThreadsClient({ fetch, timeoutMs: 50 });
      const pending = failure(client.publishContainer(TOKEN, '123', '456'));
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toMatchObject({ code: 'timeout', maybeSent: true });
      expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a malformed success body or missing publish ID as uncertain', async () => {
    const { client } = setup([new Response(`not-json-${TOKEN}`), json({})]);
    expect(await failure(client.publishContainer(TOKEN, '123', '456'))).toMatchObject({
      code: 'invalid_response',
      maybeSent: true,
    });
    expect(
      await failure(client.createContainer(TOKEN, '123', { media_type: 'TEXT', text: 'Example' })),
    ).toMatchObject({ code: 'invalid_response', maybeSent: true });
  });

  it.each([
    { id: '456', status: 'unexpected' },
    { data: [{ name: 'likes', values: [{ value: -1 }] }] },
    { data: [{ name: 'likes', values: [{ value: '12' }] }] },
    {
      data: [
        { name: 'likes', values: [{ value: 1 }] },
        { name: 'likes', values: [{ value: 2 }] },
      ],
    },
  ])('rejects malformed structured results without copying their values', async (response) => {
    const { client } = setup([json(response)]);
    expect(
      await failure(
        'status' in response ? client.containerStatus(TOKEN, '456') : client.insights(TOKEN, '456'),
      ),
    ).toMatchObject({ code: 'invalid_response', maybeSent: false });
  });

  it.each(['../me', '123/threads', 'https://evil.test', '', '123?access_token=other'])(
    'rejects an invalid remote ID before sending: %s',
    async (id) => {
      const { client, fetch } = setup([]);
      expect(await failure(client.publishContainer(TOKEN, id, '456'))).toMatchObject({
        code: 'invalid_input',
        maybeSent: false,
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { media_type: 'TEXT', text: '' },
    { media_type: 'IMAGE', image_url: 'file:///secret.jpg' },
    { media_type: 'VIDEO', video_url: 'https://user:pass@example.test/video.mp4' },
    { media_type: 'CAROUSEL', children: ['123'] },
  ])('rejects invalid container input before a network request', async (fields) => {
    const { client, fetch } = setup([]);
    expect(
      await failure(client.createContainer(TOKEN, '123', fields as ThreadsContainerFields)),
    ).toMatchObject({ code: 'invalid_input', maybeSent: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});
