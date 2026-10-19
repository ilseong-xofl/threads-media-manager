import { describe, expect, it, vi } from 'vitest';
import { ServiceApiClient, serviceBaseUrl } from './service-api';
import type { AuthTokenStore } from './auth-token-store';
import { ServiceAccess } from './service-access';

const account = {
  user: { id: 'user-a', displayName: '담당자', email: 'employee@ilscp.net' },
  mustChangePassword: false,
  permissions: { app: true },
};
function store(initial: string | null = null) {
  let token = initial;
  const value: AuthTokenStore = {
    read: vi.fn(async () => token),
    write: vi.fn(async (next) => {
      token = next;
    }),
    clear: vi.fn(async () => {
      token = null;
    }),
  };
  return value;
}
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('service login boundary reused from local-video-manager', () => {
  it.each(['blocked', 'offline'])(
    'revokes an existing business capability and upload signal on %s without erasing the saved login',
    async (failure) => {
      const tokens = store('signed-session');
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(account));
      const client = new ServiceApiClient('https://admin.example.test', tokens, fetcher);
      const context = await client.getBusinessContext();
      const signal = client.businessSignal(context);
      if (failure === 'blocked') fetcher.mockResolvedValueOnce(json({}, 403));
      else fetcher.mockRejectedValueOnce(new Error('offline'));
      expect((await client.getAuthState()).status).toBe('blocked');
      expect(signal.aborted).toBe(true);
      expect(() => client.assertBusinessContext(context)).toThrow();
      expect(await tokens.read()).toBe('signed-session');
      const restored = await client.getBusinessContext();
      expect(client.businessSignal(restored).aborted).toBe(false);
      expect(() => client.assertBusinessContext(context)).toThrow();
    },
  );
  it('limits publication calls to fixed JSON endpoints and preserves storage failures separately from service access', async () => {
    const tokens = store('signed-session');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(account));
    const client = new ServiceApiClient('https://admin.example.test', tokens, fetcher);
    const context = await client.getBusinessContext();
    fetcher.mockResolvedValueOnce(json({ publications: [] }));
    await client.publicationRequest(context, 'list', undefined, {
      libraryId: 'library-a',
      postKey: '["sample","one"]',
    });
    expect(String(fetcher.mock.lastCall![0])).toBe(
      'https://admin.example.test/api/v1/publications?libraryId=library-a&postKey=%5B%22sample%22%2C%22one%22%5D',
    );
    expect(fetcher.mock.lastCall![1]?.body).toBeUndefined();
    await expect(
      client.publicationRequest(context, 'get', 'https://graph.threads.com/'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    fetcher.mockResolvedValueOnce(
      json({ error: { code: 'STORAGE_UNAVAILABLE', message: 'private upstream detail' } }, 503),
    );
    await expect(client.publicationRequest(context, 'create', undefined, {})).rejects.toMatchObject(
      { code: 'STORAGE_UNAVAILABLE' },
    );
    expect(client.businessSignal(context).aborted).toBe(false);
  });
  it('requires HTTPS in distributed builds and accepts only loopback HTTP in development', () => {
    expect(serviceBaseUrl('', false)).toBe('http://127.0.0.1:4191');
    expect(serviceBaseUrl('', true)).toBeNull();
    expect(serviceBaseUrl('https://admin.example.test', true)).toBe('https://admin.example.test');
    for (const url of [
      'http://127.0.0.1:4191',
      'http://admin.example.test',
      'https://name:secret@admin.example.test',
      'https://admin.example.test/path',
      'https://admin.example.test?token=secret',
    ])
      expect(serviceBaseUrl(url, true)).toBeNull();
    expect(serviceBaseUrl('http://192.168.1.10:4191', false)).toBeNull();
  });
  it('stores signed bearer in main only, requests access, and returns a whitelisted user state', async () => {
    const tokens = store();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ token: 'raw-token-must-not-be-used' }, 200, { 'set-auth-token': 'signed-session' }),
      )
      .mockResolvedValueOnce(json({ ...account, extraSecret: 'hidden' }));
    const client = new ServiceApiClient('https://admin.example.test', tokens, fetcher);
    const result = await client.signIn('Employee', 'password-123');
    expect(tokens.write).toHaveBeenCalledExactlyOnceWith('signed-session');
    expect(result).toEqual({
      status: 'authenticated',
      user: account.user,
      mustChangePassword: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/session|token|hidden/);
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({
      email: 'employee@ilscp.net',
      password: 'password-123',
      rememberMe: true,
    });
    const headers = new Headers(fetcher.mock.calls[1][1]!.headers);
    expect(headers.get('Authorization')).toBe('Bearer signed-session');
    expect(headers.get('x-client-channel')).toBe('desktop');
    expect(headers.get('x-threads-request')).toBe('1');
    expect(headers.has('User-Agent')).toBe(false);
    expect(fetcher.mock.calls.every((call) => call[1]?.redirect === 'error')).toBe(true);
  });
  it('never substitutes raw response token when Better Auth signed header is missing', async () => {
    const tokens = store();
    const client = new ServiceApiClient(
      'https://admin.example.test',
      tokens,
      vi.fn<typeof fetch>().mockResolvedValue(json({ token: 'raw-token' })),
    );
    await expect(client.signIn('employee', 'password-123')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    expect(tokens.write).not.toHaveBeenCalled();
  });
  it('fails closed on every protected check after connectivity or permission changes', async () => {
    const tokens = store('signed-session');
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(account))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(json({ ...account, mustChangePassword: true }))
      .mockResolvedValueOnce(json({}, 403))
      .mockResolvedValueOnce(json({}, 401));
    const changes = vi.fn();
    const guard = new ServiceAccess(
      new ServiceApiClient('https://admin.example.test', tokens, fetcher),
      changes,
    );
    await expect(guard.require()).resolves.toBeUndefined();
    await expect(guard.require()).rejects.toThrow();
    await expect(guard.allowed()).resolves.toBe(false);
    await expect(guard.allowed()).resolves.toBe(false);
    await expect(guard.allowed()).resolves.toBe(false);
    expect(tokens.clear).toHaveBeenCalled();
    expect(changes.mock.calls.map((call) => call[0].status)).toEqual([
      'authenticated',
      'blocked',
      'authenticated',
      'blocked',
      'signed-out',
    ]);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it('clears local session on sign-out even if service is unreachable', async () => {
    const tokens = store('signed-session');
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    const client = new ServiceApiClient('https://admin.example.test', tokens, fetcher);
    expect(await client.signOut()).toEqual({ status: 'signed-out' });
    expect(await tokens.read()).toBeNull();
    expect(fetcher.mock.calls[0][0]).toBe('https://admin.example.test/api/auth/sign-out');
  });
  it('changes password with current/new credentials and requires login after revocation', async () => {
    const tokens = store('signed-session');
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ success: true, reauthenticate: true }));
    const client = new ServiceApiClient('https://admin.example.test', tokens, fetcher);
    expect(await client.changePassword('previous-pass', 'replacement-pass')).toEqual({
      status: 'signed-out',
    });
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({
      currentPassword: 'previous-pass',
      newPassword: 'replacement-pass',
    });
    expect(await tokens.read()).toBeNull();
  });
  it('invalidates an in-flight access result when logging out', async () => {
    let complete!: (response: Response) => void;
    const tokens = store('signed-session');
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue(json({ success: true }));
    const client = new ServiceApiClient('https://admin.example.test', tokens, fetcher);
    const pending = client.getAuthState();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await client.signOut();
    complete(json(account));
    expect(await pending).toEqual({ status: 'signed-out' });
    expect(await tokens.read()).toBeNull();
  });
  it('binds business requests to an opaque authenticated employee context and fixed paths', async () => {
    const tokens = store('signed-session');
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(account))
      .mockResolvedValue(json({ accounts: [] }));
    const client = new ServiceApiClient('https://admin.example.test', tokens, fetcher);
    const context = await client.getBusinessContext();
    expect(context).toEqual({ ownerId: 'user-a' });
    await client.managedThreadsRequest(context, 'list');
    expect(fetcher.mock.calls[1][0]).toBe('https://admin.example.test/api/v1/threads/accounts');
    expect(fetcher.mock.calls[1][1]?.redirect).toBe('error');
    await expect(
      client.managedThreadsRequest(context, 'credential', '../other'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(client.managedThreadsRequest({ ownerId: 'user-a' }, 'list')).rejects.toMatchObject(
      { code: 'AUTH_CHANGED' },
    );
    await client.signOut();
    await expect(client.managedThreadsRequest(context, 'list')).rejects.toMatchObject({
      code: 'AUTH_CHANGED',
    });
  });
  it('sends account deletion only to the fixed owned service path and retains gone as a distinct result', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(account))
      .mockResolvedValueOnce(json({ deletedAccount: {} }))
      .mockResolvedValueOnce(json({ error: 'never expose' }, 410));
    const client = new ServiceApiClient(
      'https://admin.example.test',
      store('signed-session'),
      fetcher,
    );
    const context = await client.getBusinessContext();
    await client.managedThreadsRequest(context, 'delete', 'account-1', { expectedRevision: 2 });
    expect(fetcher.mock.calls[1][0]).toBe(
      'https://admin.example.test/api/v1/threads/accounts/account-1',
    );
    expect(fetcher.mock.calls[1][1]).toMatchObject({
      method: 'DELETE',
      body: JSON.stringify({ expectedRevision: 2 }),
      redirect: 'error',
    });
    await expect(
      client.managedThreadsRequest(context, 'delete', '../outside'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      client.managedThreadsRequest(context, 'credential', 'account-1'),
    ).rejects.toMatchObject({ code: 'ACCOUNT_REMOVED' });
  });
  it('whitelists only the migration-required code for a schema 503 without exposing server text', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(account))
      .mockResolvedValueOnce(
        json({ error: { code: 'MIGRATION_REQUIRED', message: 'secret-database-detail' } }, 503),
      )
      .mockResolvedValueOnce(
        json({ error: { code: 'secret-unknown-code', message: 'secret-error-detail' } }, 503),
      )
      .mockRejectedValueOnce(new Error('secret-network-detail'));
    const tokens = store('signed-session');
    const client = new ServiceApiClient('https://admin.example.test', tokens, fetcher);
    const context = await client.getBusinessContext();
    await expect(client.managedThreadsRequest(context, 'list')).rejects.toMatchObject({
      code: 'MIGRATION_REQUIRED',
      message: '계정 관리 DB 업데이트가 필요합니다. 관리자에게 문의해 주세요.',
      status: 503,
    });
    for (let index = 0; index < 2; index += 1)
      await expect(client.managedThreadsRequest(context, 'list')).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        status: 503,
      });
    expect(tokens.clear).not.toHaveBeenCalled();
  });
  it('rejects password-change-required context before any business API request', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ ...account, mustChangePassword: true }));
    const client = new ServiceApiClient(
      'https://admin.example.test',
      store('signed-session'),
      fetcher,
    );
    await expect(client.getBusinessContext()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not copy malicious backend errors or secrets into business errors', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(account))
      .mockResolvedValueOnce(
        json({ error: { code: 'token-secret', message: 'private-token' } }, 409),
      );
    const client = new ServiceApiClient(
      'https://admin.example.test',
      store('signed-session'),
      fetcher,
    );
    const context = await client.getBusinessContext();
    await expect(
      client.managedThreadsRequest(context, 'create', undefined, {}),
    ).rejects.toMatchObject({ code: 'REMOTE_CONFLICT' });
  });
  it('rejects all retired lifecycle and recipient endpoints before any network request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(account));
    const client = new ServiceApiClient(
      'https://admin.example.test',
      store('signed-session'),
      fetcher,
    );
    const context = await client.getBusinessContext();
    const count = fetcher.mock.calls.length;
    for (const retired of [
      'suspend',
      'resume',
      'operation',
      'transfer',
      'transfers',
      'recipients',
      'accept',
      'reject',
      'cancel',
    ])
      await expect(
        client.managedThreadsRequest(
          context,
          retired as Parameters<ServiceApiClient['managedThreadsRequest']>[1],
          'account',
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(fetcher).toHaveBeenCalledTimes(count);
  });
});
