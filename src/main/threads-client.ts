const API_ORIGIN = 'https://graph.threads.com';
const API_VERSION = '/v1.0';
const RESPONSE_LIMIT = 2 * 1024 * 1024;

export type ThreadsApiErrorCode =
  | 'invalid_input'
  | 'auth_expired'
  | 'permission_missing'
  | 'rate_limited'
  | 'not_found'
  | 'network'
  | 'timeout'
  | 'remote_unavailable'
  | 'remote_rejected'
  | 'invalid_response';

const ERROR_MESSAGES: Record<ThreadsApiErrorCode, string> = {
  invalid_input: 'Threads 요청 정보를 확인해 주세요.',
  auth_expired: 'Threads 연결이 만료되었거나 유효하지 않습니다. 토큰을 다시 등록해 주세요.',
  permission_missing: '이 작업에 필요한 Threads 권한이 없습니다.',
  rate_limited: 'Threads 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.',
  not_found: 'Threads에서 해당 게시물이나 계정을 확인할 수 없습니다.',
  network: 'Threads 서버와 통신하지 못했습니다.',
  timeout: 'Threads 응답을 기다리는 시간이 초과되었습니다.',
  remote_unavailable: 'Threads 서버가 일시적으로 요청을 처리하지 못했습니다.',
  remote_rejected: 'Threads가 요청을 처리하지 못했습니다. 등록 정보와 게시 조건을 확인해 주세요.',
  invalid_response: 'Threads 응답을 확인할 수 없습니다.',
};

/** Only fixed messages and safe scalar metadata may leave the HTTP boundary. */
export class ThreadsApiError extends Error {
  readonly code: ThreadsApiErrorCode;
  readonly maybeSent: boolean;
  readonly retryAfterSeconds?: number;
  readonly httpStatus?: number;

  constructor(
    code: ThreadsApiErrorCode,
    options: { maybeSent?: boolean; retryAfterSeconds?: number; httpStatus?: number } = {},
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ThreadsApiError';
    this.code = code;
    this.maybeSent = options.maybeSent ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.httpStatus = options.httpStatus;
  }
}

export interface ThreadsContainerFields {
  media_type: 'TEXT' | 'IMAGE' | 'VIDEO' | 'CAROUSEL';
  text?: string;
  image_url?: string;
  video_url?: string;
  children?: string[];
  is_carousel_item?: boolean;
  reply_to_id?: string;
}

export interface ThreadsMedia {
  id: string;
  text: string | null;
  permalink: string | null;
  username: string | null;
  timestamp: string | null;
  mediaType: string | null;
  ownerId: string | null;
  isReply: boolean | null;
  repliedToId: string | null;
}

export interface ThreadsInsights {
  views: number | null;
  likes: number | null;
  replies: number | null;
}

export type ThreadsContainerStatus = 'IN_PROGRESS' | 'FINISHED' | 'PUBLISHED' | 'ERROR' | 'EXPIRED';
export type ThreadsFetch = typeof globalThis.fetch;
type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : null;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{1,40}$/.test(value);
}

function requireId(value: unknown): string {
  if (!validId(value)) throw new ThreadsApiError('invalid_input');
  return value;
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/\s/.test(value);
}

function responseId(value: unknown, maybeSent = false): string {
  if (!validId(value)) throw new ThreadsApiError('invalid_response', { maybeSent });
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : undefined;
}

function remoteError(status: number, payload: unknown, mutation: boolean, retry: string | null) {
  const error = object(object(payload)?.error);
  const code = error?.code;
  let safeCode: ThreadsApiErrorCode = 'remote_rejected';
  if (status === 401 || code === 190 || code === 102) safeCode = 'auth_expired';
  else if (status === 429 || [4, 17, 32, 613].includes(Number(code))) safeCode = 'rate_limited';
  else if (status === 403 || code === 10 || code === 200) safeCode = 'permission_missing';
  else if (status === 404) safeCode = 'not_found';
  else if (status >= 500 || code === 1 || code === 2 || error?.is_transient === true)
    safeCode = 'remote_unavailable';
  return new ThreadsApiError(safeCode, {
    maybeSent: mutation && (status >= 500 || safeCode === 'remote_unavailable'),
    retryAfterSeconds: retryAfter(retry),
    httpStatus: status,
  });
}

function mediaUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 16384 || /[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function containerParameters(fields: ThreadsContainerFields): Record<string, string> {
  if (!object(fields) || !['TEXT', 'IMAGE', 'VIDEO', 'CAROUSEL'].includes(fields.media_type))
    throw new ThreadsApiError('invalid_input');
  const result: Record<string, string> = { media_type: fields.media_type };
  if (fields.text !== undefined) {
    if (typeof fields.text !== 'string' || fields.text.length > 10000)
      throw new ThreadsApiError('invalid_input');
    result.text = fields.text;
  }
  for (const field of ['image_url', 'video_url'] as const) {
    if (fields[field] !== undefined) {
      if (!mediaUrl(fields[field])) throw new ThreadsApiError('invalid_input');
      result[field] = fields[field];
    }
  }
  if (fields.children !== undefined) {
    if (
      !Array.isArray(fields.children) ||
      fields.children.length < 2 ||
      fields.children.length > 20
    )
      throw new ThreadsApiError('invalid_input');
    result.children = fields.children.map(requireId).join(',');
  }
  if (fields.is_carousel_item !== undefined) {
    if (typeof fields.is_carousel_item !== 'boolean') throw new ThreadsApiError('invalid_input');
    result.is_carousel_item = String(fields.is_carousel_item);
  }
  if (fields.reply_to_id !== undefined) result.reply_to_id = requireId(fields.reply_to_id);
  if (
    (fields.media_type === 'TEXT' && !fields.text?.trim()) ||
    (fields.media_type === 'IMAGE' && !fields.image_url) ||
    (fields.media_type === 'VIDEO' && !fields.video_url) ||
    (fields.media_type === 'CAROUSEL' && !fields.children)
  )
    throw new ThreadsApiError('invalid_input');
  return result;
}

export class ThreadsClient {
  private readonly fetch: ThreadsFetch;
  private readonly timeoutMs: number;

  constructor(options: { fetch?: ThreadsFetch; timeoutMs?: number } = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1)
      throw new ThreadsApiError('invalid_input');
  }

  async me(token: string): Promise<{ id: string; username: string }> {
    const data = await this.request(token, '/me', { fields: 'id,username' });
    if (typeof data.username !== 'string' || !data.username)
      throw new ThreadsApiError('invalid_response');
    return { id: responseId(data.id), username: data.username };
  }

  async debugToken(token: string): Promise<{ userId: string; expiresAt: number }> {
    const response = await this.request(token, '/debug_token', { input_token: token });
    const data = object(response.data);
    if (data?.is_valid === false) throw new ThreadsApiError('auth_expired');
    if (
      !data ||
      data.is_valid !== true ||
      data.type !== 'USER' ||
      !validId(data.user_id) ||
      !Number.isSafeInteger(data.expires_at) ||
      Number(data.expires_at) <= 0 ||
      !Number.isFinite(new Date(Number(data.expires_at) * 1000).getTime())
    )
      throw new ThreadsApiError('invalid_response');
    return { userId: data.user_id, expiresAt: Number(data.expires_at) };
  }

  async refreshAccessToken(token: string): Promise<{ accessToken: string; expiresIn: number }> {
    const data = await this.request(token, '/refresh_access_token', {
      grant_type: 'th_refresh_token',
    });
    if (
      !validToken(data.access_token) ||
      !Number.isSafeInteger(data.expires_in) ||
      Number(data.expires_in) <= 0
    )
      throw new ThreadsApiError('invalid_response');
    return { accessToken: data.access_token, expiresIn: Number(data.expires_in) };
  }

  async createContainer(token: string, userId: string, fields: ThreadsContainerFields) {
    const data = await this.request(
      token,
      `/${requireId(userId)}/threads`,
      containerParameters(fields),
      true,
    );
    return { id: responseId(data.id, true) };
  }

  async publishContainer(token: string, userId: string, creationId: string) {
    const data = await this.request(
      token,
      `/${requireId(userId)}/threads_publish`,
      { creation_id: requireId(creationId) },
      true,
    );
    return { id: responseId(data.id, true) };
  }

  async containerStatus(
    token: string,
    id: string,
  ): Promise<{ id: string; status: ThreadsContainerStatus }> {
    const data = await this.request(token, `/${requireId(id)}`, { fields: 'id,status' });
    if (!['IN_PROGRESS', 'FINISHED', 'PUBLISHED', 'ERROR', 'EXPIRED'].includes(String(data.status)))
      throw new ThreadsApiError('invalid_response');
    return { id: responseId(data.id), status: data.status as ThreadsContainerStatus };
  }

  async insights(token: string, id: string): Promise<ThreadsInsights> {
    const data = await this.request(token, `/${requireId(id)}/insights`, {
      metric: 'views,likes,replies',
    });
    if (!Array.isArray(data.data)) throw new ThreadsApiError('invalid_response');
    const result: ThreadsInsights = { views: null, likes: null, replies: null };
    for (const entry of data.data) {
      const metric = object(entry);
      if (!metric || !['views', 'likes', 'replies'].includes(String(metric.name))) continue;
      const name = metric.name as keyof ThreadsInsights;
      const value = Array.isArray(metric.values) ? object(metric.values[0])?.value : undefined;
      if (!Number.isSafeInteger(value) || Number(value) < 0 || result[name] !== null)
        throw new ThreadsApiError('invalid_response');
      result[name] = Number(value);
    }
    return result;
  }

  async retrieveMedia(token: string, id: string): Promise<ThreadsMedia> {
    const data = await this.request(token, `/${requireId(id)}`, {
      fields: 'id,text,permalink,username,timestamp,media_type,owner,is_reply,replied_to',
    });
    return {
      id: responseId(data.id),
      text: optionalString(data.text),
      permalink: optionalString(data.permalink),
      username: optionalString(data.username),
      timestamp: optionalString(data.timestamp),
      mediaType: optionalString(data.media_type),
      ownerId: validId(object(data.owner)?.id) ? String(object(data.owner)?.id) : null,
      isReply: typeof data.is_reply === 'boolean' ? data.is_reply : null,
      repliedToId: validId(object(data.replied_to)?.id)
        ? String(object(data.replied_to)?.id)
        : null,
    };
  }

  private async request(
    token: string,
    path: string,
    parameters: Record<string, string>,
    mutation = false,
  ): Promise<ObjectValue> {
    if (!validToken(token)) throw new ThreadsApiError('invalid_input');
    const controller = new AbortController();
    const url = new URL(
      path === '/refresh_access_token' ? path : `${API_VERSION}${path}`,
      API_ORIGIN,
    );
    const form = new URLSearchParams({ ...parameters, access_token: token });
    // Match Threads' documented token transport. Never log URLs, forms, or remote error bodies.
    if (!mutation) url.search = form.toString();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new ThreadsApiError('timeout', { maybeSent: mutation }));
        controller.abort();
      }, this.timeoutMs);
    });
    const execute = async (): Promise<ObjectValue> => {
      try {
        const response = await this.fetch(url, {
          method: mutation ? 'POST' : 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: mutation
            ? { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }
            : { Accept: 'application/json' },
          ...(mutation ? { body: form.toString() } : {}),
        });
        const text = await response.text();
        let payload: unknown;
        if (text.length <= RESPONSE_LIMIT) {
          try {
            payload = JSON.parse(text);
          } catch {
            // Preserve only the response class, never parser errors containing response text.
          }
        }
        if (!response.ok || object(payload)?.error)
          throw remoteError(
            response.status,
            payload,
            mutation,
            response.headers.get('retry-after'),
          );
        const data = object(payload);
        if (!data) throw new ThreadsApiError('invalid_response', { maybeSent: mutation });
        return data;
      } catch (error) {
        if (error instanceof ThreadsApiError) throw error;
        throw new ThreadsApiError('network', { maybeSent: mutation });
      }
    };
    try {
      return await Promise.race([execute(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
