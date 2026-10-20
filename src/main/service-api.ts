import { randomUUID } from 'node:crypto';
import {
  ACCOUNT_PASSWORD_MAX_LENGTH,
  ACCOUNT_PASSWORD_MIN_LENGTH,
  serviceEmailFromId,
  type AppAuthState,
} from '../shared/service-auth';
import type { AuthTokenStore } from './auth-token-store';

export class ServiceApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ServiceApiError';
  }
}

export function serviceBaseUrl(value: string, packaged: boolean): string | null {
  try {
    const url = new URL(value || (!packaged ? 'http://127.0.0.1:4191' : ''));
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    if (
      url.protocol !== 'https:' &&
      !(
        !packaged &&
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      )
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
const serviceBlocked = (): AppAuthState => ({
  status: 'blocked',
  reason: 'service',
  message: '서비스에 연결할 수 없습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.',
});
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function accessState(value: unknown): AppAuthState {
  if (
    !object(value) ||
    !object(value.user) ||
    typeof value.user.id !== 'string' ||
    typeof value.user.displayName !== 'string' ||
    typeof value.user.email !== 'string' ||
    typeof value.mustChangePassword !== 'boolean' ||
    !object(value.permissions) ||
    value.permissions.app !== true
  ) {
    throw new ServiceApiError('서비스 응답을 확인하지 못했습니다.', 'INVALID_RESPONSE', 502);
  }
  return {
    status: 'authenticated',
    user: { id: value.user.id, displayName: value.user.displayName, email: value.user.email },
    mustChangePassword: value.mustChangePassword,
  };
}

export interface ServiceBusinessContext {
  readonly ownerId: string;
}

/** The Better Auth signed bearer remains in main/OS storage, never renderer state. */
export class ServiceApiClient {
  private epoch = 0;
  private businessAbort = new AbortController();
  private pending?: Promise<AppAuthState>;
  private readonly businessContexts = new WeakMap<
    ServiceBusinessContext,
    { epoch: number; token: string }
  >();
  constructor(
    private readonly baseUrl: string | null,
    private readonly tokenStore: AuthTokenStore,
    private readonly requestFetch: typeof fetch = fetch,
  ) {}
  private advanceEpoch(): number {
    this.businessAbort.abort();
    this.businessAbort = new AbortController();
    return ++this.epoch;
  }

  private async request(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    token?: string | null,
    body?: unknown,
  ): Promise<Response> {
    if (!this.baseUrl)
      throw new ServiceApiError(
        '서비스 주소가 설정되지 않았습니다.',
        'SERVICE_NOT_CONFIGURED',
        503,
      );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      return await this.requestFetch(`${this.baseUrl}${path}`, {
        method,
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Origin: this.baseUrl,
          'X-Client-Request-Id': randomUUID(),
          'x-client-channel': 'desktop',
          'x-threads-request': '1',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ServiceApiError('서비스에 연결할 수 없습니다.', 'SERVICE_UNAVAILABLE', 503);
    } finally {
      clearTimeout(timer);
    }
  }
  private async read(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new ServiceApiError('서비스 응답을 확인하지 못했습니다.', 'INVALID_RESPONSE', 502);
    }
  }
  private async access(token: string | null, epoch: number): Promise<AppAuthState> {
    const response = await this.request('/api/v1/access', 'GET', token);
    if (epoch !== this.epoch) return { status: 'signed-out' };
    if (response.status === 401) {
      await this.tokenStore.clear();
      return { status: 'signed-out' };
    }
    if (response.status === 403)
      return {
        status: 'blocked',
        reason: 'access',
        message: '사용 권한이 없습니다. 관리자에게 확인해 주세요.',
      };
    if (!response.ok) return serviceBlocked();
    const state = accessState(await this.read(response));
    return epoch === this.epoch ? state : { status: 'signed-out' };
  }
  async getAuthState(): Promise<AppAuthState> {
    if (!this.baseUrl)
      return {
        status: 'blocked',
        reason: 'configuration',
        message: '서비스 주소가 설정되지 않았습니다. 관리자에게 확인해 주세요.',
      };
    if (this.pending) return this.pending;
    const epoch = this.epoch;
    const pending = (async (): Promise<AppAuthState> => {
      try {
        const state = await this.access(await this.tokenStore.read(), epoch);
        if (epoch === this.epoch && (state.status !== 'authenticated' || state.mustChangePassword))
          this.advanceEpoch();
        return state;
      } catch {
        if (epoch === this.epoch) this.advanceEpoch();
        return serviceBlocked();
      }
    })();
    this.pending = pending;
    try {
      return await pending;
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }
  /** Main-only capability: never includes the bearer and expires on any auth transition. */
  async getBusinessContext(): Promise<ServiceBusinessContext> {
    const epoch = this.epoch;
    const state = await this.getAuthState();
    if (state.status !== 'authenticated' || state.mustChangePassword || epoch !== this.epoch)
      throw new ServiceApiError('직원 계정으로 다시 로그인해 주세요.', 'AUTH_REQUIRED', 401);
    const token = await this.tokenStore.read();
    if (!token || epoch !== this.epoch)
      throw new ServiceApiError('직원 계정으로 다시 로그인해 주세요.', 'AUTH_REQUIRED', 401);
    const context = Object.freeze({ ownerId: state.user.id });
    this.businessContexts.set(context, { epoch, token });
    return context;
  }
  assertBusinessContext(context: ServiceBusinessContext): void {
    const saved = this.businessContexts.get(context);
    if (!saved || saved.epoch !== this.epoch)
      throw new ServiceApiError(
        '로그인이 변경되었습니다. 다시 확인해 주세요.',
        'AUTH_CHANGED',
        401,
      );
  }
  businessSignal(context: ServiceBusinessContext): AbortSignal {
    this.assertBusinessContext(context);
    return this.businessAbort.signal;
  }
  /** Only the fixed account endpoints are available; no arbitrary URL or Meta transport. */
  async managedThreadsRequest(
    context: ServiceBusinessContext,
    operation: 'list' | 'create' | 'credential' | 'replace' | 'delete' | 'profile',
    accountId?: string,
    body?: unknown,
  ): Promise<unknown> {
    this.assertBusinessContext(context);
    const saved = this.businessContexts.get(context)!;
    if ((await this.tokenStore.read()) !== saved.token)
      throw new ServiceApiError('로그인이 변경되었습니다.', 'AUTH_CHANGED', 401);
    this.assertBusinessContext(context);
    const noId = ['list', 'create'];
    const withId = ['credential', 'replace', 'delete', 'profile'];
    if (
      (!noId.includes(operation) && !withId.includes(operation)) ||
      (withId.includes(operation) && !/^[A-Za-z0-9_-]{1,80}$/.test(accountId ?? '')) ||
      (noId.includes(operation) && accountId !== undefined)
    )
      throw new ServiceApiError('요청 정보를 확인해 주세요.', 'VALIDATION_FAILED', 400);
    const path =
      '/api/v1/threads/accounts' +
      (accountId
        ? `/${accountId}${operation === 'delete' ? '' : operation === 'profile' ? '/profile' : '/credential'}`
        : '');
    const method =
      operation === 'replace'
        ? 'PUT'
        : operation === 'delete'
          ? 'DELETE'
          : operation === 'create' || operation === 'profile'
            ? 'POST'
            : 'GET';
    const response = await this.request(path, method, saved.token, body);
    this.assertBusinessContext(context);
    if (!response.ok) {
      if (response.status === 401) {
        this.advanceEpoch();
        this.pending = undefined;
        await this.tokenStore.clear();
      }
      const failure: unknown = await response.json().catch(() => null);
      if (response.status === 503) {
        this.assertBusinessContext(context);
        if (object(failure) && object(failure.error) && failure.error.code === 'MIGRATION_REQUIRED')
          throw new ServiceApiError(
            '계정 관리 DB 업데이트가 필요합니다. 관리자에게 문의해 주세요.',
            'MIGRATION_REQUIRED',
            503,
          );
      }
      if (
        object(failure) &&
        object(failure.error) &&
        typeof failure.error.code === 'string' &&
        [
          'STALE_LIFECYCLE',
          'OWNERSHIP_REVOKED',
          'LIFECYCLE_CONFLICT',
          'OWNERSHIP_CONFLICT',
        ].includes(failure.error.code)
      )
        throw new ServiceApiError(
          '계정 상태가 변경되었습니다. 최신 상태를 확인해 주세요.',
          failure.error.code,
          response.status,
        );
      const code =
        response.status === 410
          ? 'ACCOUNT_REMOVED'
          : response.status === 409
            ? 'REMOTE_CONFLICT'
            : response.status === 401 || response.status === 403
              ? 'AUTH_REQUIRED'
              : response.status === 404
                ? 'NOT_FOUND'
                : 'SERVICE_UNAVAILABLE';
      throw new ServiceApiError(
        '계정 정보를 처리하지 못했습니다. 다시 확인해 주세요.',
        code,
        response.status,
      );
    }
    const result = await this.read(response);
    this.assertBusinessContext(context);
    return result;
  }
  /** JSON control plane only. Presigned S3 bytes never pass through this client. */
  async publicationRequest(
    context: ServiceBusinessContext,
    operation:
      | 'list'
      | 'get'
      | 'create'
      | 'upload-urls'
      | 'complete'
      | 'recall'
      | 'source-state'
      | 'source-deletions'
      | 'cancel-request'
      | 'statuses'
      | 'comment',
    id?: string,
    body?: unknown,
  ): Promise<unknown> {
    this.assertBusinessContext(context);
    const saved = this.businessContexts.get(context)!;
    if ((await this.tokenStore.read()) !== saved.token)
      throw new ServiceApiError('로그인이 변경되었습니다.', 'AUTH_CHANGED', 401);
    this.assertBusinessContext(context);
    let path = '/api/v1/publications';
    let method: 'GET' | 'POST' = 'POST';
    if (operation === 'list' || operation === 'source-state') {
      if (
        id !== undefined ||
        !object(body) ||
        typeof body.libraryId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(body.libraryId) ||
        typeof body.postKey !== 'string' ||
        !body.postKey ||
        body.postKey.length > 512 ||
        Object.keys(body).length !== 2
      )
        throw new ServiceApiError('게시글 정보를 확인하세요.', 'VALIDATION_FAILED', 400);
      path += `${operation === 'source-state' ? '/source-state' : ''}?${new URLSearchParams({ libraryId: body.libraryId, postKey: body.postKey })}`;
      body = undefined;
      method = 'GET';
    } else if (operation === 'statuses') {
      if (
        id !== undefined ||
        !object(body) ||
        typeof body.libraryId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(body.libraryId) ||
        Object.keys(body).length !== 1
      )
        throw new ServiceApiError('라이브러리 정보를 확인하세요.', 'VALIDATION_FAILED', 400);
      path += `/statuses?${new URLSearchParams({ libraryId: body.libraryId })}`;
      body = undefined;
      method = 'GET';
    } else if (operation === 'create' || operation === 'source-deletions') {
      if (id !== undefined)
        throw new ServiceApiError('요청을 확인하세요.', 'VALIDATION_FAILED', 400);
      if (operation === 'source-deletions') path += '/source-deletions';
    } else {
      if (
        !['get', 'upload-urls', 'complete', 'recall', 'cancel-request', 'comment'].includes(
          operation,
        ) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id ?? '')
      )
        throw new ServiceApiError('전송 정보를 확인하세요.', 'VALIDATION_FAILED', 400);
      path +=
        operation === 'cancel-request'
          ? `/requests/${id}/recall`
          : `/${id}${operation === 'get' ? '' : `/${operation}`}`;
      if (operation === 'get') {
        method = 'GET';
        body = undefined;
      }
    }
    const response = await this.request(path, method, saved.token, body);
    this.assertBusinessContext(context);
    if (!response.ok) {
      if (response.status === 401) {
        this.advanceEpoch();
        this.pending = undefined;
        await this.tokenStore.clear();
      }
      const failure: unknown = await response.json().catch(() => null);
      const code =
        object(failure) &&
        object(failure.error) &&
        typeof failure.error.code === 'string' &&
        /^[A-Z_]{1,80}$/.test(failure.error.code)
          ? failure.error.code
          : 'PUBLICATION_REQUEST_FAILED';
      if (response.status === 401 || response.status === 403)
        throw new ServiceApiError(
          '서비스에 다시 로그인해 주세요.',
          'AUTH_REQUIRED',
          response.status,
        );
      if (
        response.status >= 500 &&
        ![
          'STORAGE_NOT_CONFIGURED',
          'S3_NOT_CONFIGURED',
          'STORAGE_UNAVAILABLE',
          'MIGRATION_REQUIRED',
        ].includes(code)
      )
        throw new ServiceApiError(
          '서비스에 연결할 수 없습니다.',
          'SERVICE_UNAVAILABLE',
          response.status,
        );
      const message =
        response.status === 409
          ? '게시 대기 상태가 변경되었습니다. 최신 상태를 확인한 뒤 다시 진행하세요.'
          : response.status === 410
            ? '계정 또는 게시 대기 연결이 종료되었습니다.'
            : code.includes('CONFIGURED')
              ? '미디어 저장소 설정이 필요합니다. 관리자에게 확인해 주세요.'
              : code === 'MIGRATION_REQUIRED'
                ? '게시 대기 DB 업데이트가 필요합니다. 관리자에게 확인해 주세요.'
                : '게시 대기 요청을 처리하지 못했습니다. 상태를 확인한 뒤 다시 시도해 주세요.';
      throw new ServiceApiError(message, code, response.status);
    }
    const result = await this.read(response);
    this.assertBusinessContext(context);
    return result;
  }
  async signIn(accountId: string, password: string): Promise<AppAuthState> {
    const email = serviceEmailFromId(accountId);
    if (!email || !password || password.length > ACCOUNT_PASSWORD_MAX_LENGTH)
      throw new ServiceApiError('아이디와 비밀번호를 확인해 주세요.', 'AUTH_INVALID', 400);
    const epoch = this.advanceEpoch();
    this.pending = undefined;
    const response = await this.request('/api/auth/sign-in/email', 'POST', null, {
      email,
      password,
      rememberMe: true,
    });
    if (!response.ok)
      throw new ServiceApiError(
        response.status === 429
          ? '로그인 시도가 많습니다. 잠시 후 다시 시도해 주세요.'
          : '아이디 또는 비밀번호를 확인해 주세요.',
        'AUTH_INVALID',
        response.status,
      );
    const token = response.headers.get('set-auth-token')?.trim();
    if (!token || token.length > 8192 || /[\r\n]/.test(token))
      throw new ServiceApiError('로그인 응답에 인증 정보가 없습니다.', 'INVALID_RESPONSE', 502);
    if (epoch !== this.epoch) return { status: 'signed-out' };
    await this.tokenStore.write(token);
    const state = await this.access(token, epoch);
    if (state.status !== 'authenticated') await this.tokenStore.clear();
    return state;
  }
  async signOut(): Promise<AppAuthState> {
    this.advanceEpoch();
    this.pending = undefined;
    const token = await this.tokenStore.read().catch(() => null);
    await this.tokenStore.clear();
    try {
      if (token) await this.request('/api/auth/sign-out', 'POST', token, {});
    } catch {
      /* Local sign-out remains effective during an outage. */
    }
    return { status: 'signed-out' };
  }
  async changePassword(currentPassword: string, newPassword: string): Promise<AppAuthState> {
    if (
      !currentPassword ||
      currentPassword.length > ACCOUNT_PASSWORD_MAX_LENGTH ||
      newPassword.length < ACCOUNT_PASSWORD_MIN_LENGTH ||
      newPassword.length > ACCOUNT_PASSWORD_MAX_LENGTH
    )
      throw new ServiceApiError(
        `새 비밀번호는 ${ACCOUNT_PASSWORD_MIN_LENGTH}~${ACCOUNT_PASSWORD_MAX_LENGTH}자로 입력하세요.`,
        'VALIDATION_FAILED',
        400,
      );
    const token = await this.tokenStore.read();
    if (!token) throw new ServiceApiError('로그인이 필요합니다.', 'AUTH_REQUIRED', 401);
    const response = await this.request('/api/v1/account/password', 'POST', token, {
      currentPassword,
      newPassword,
    });
    if (!response.ok) {
      if (response.status === 401) await this.tokenStore.clear();
      throw new ServiceApiError(
        '비밀번호를 변경하지 못했습니다. 현재 비밀번호와 연결 상태를 확인하세요.',
        'PASSWORD_CHANGE_FAILED',
        response.status,
      );
    }
    const body = await this.read(response);
    if (!object(body) || body.success !== true || body.reauthenticate !== true)
      throw new ServiceApiError(
        '변경 결과를 확인하지 못했습니다. 다시 로그인해 주세요.',
        'INVALID_RESPONSE',
        502,
      );
    this.advanceEpoch();
    this.pending = undefined;
    await this.tokenStore.clear();
    return { status: 'signed-out' };
  }
}
