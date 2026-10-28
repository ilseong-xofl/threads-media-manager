import type { MetaTokenFailureDetails, MetaTokenOutcome } from '../shared/managed-threads';

const API_ORIGIN = 'https://graph.threads.com';
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const DAY_MS = 86_400_000;
const MAX_REFRESH_SECONDS = 61 * 86_400;
/** Unix seconds of 9999-12-31T23:59:59Z, the last instant an ISO date can hold. */
const MAX_UNIX_SECONDS = 253_402_300_799;
/** The connection never opened, so Meta cannot have seen the request. */
const NOT_SENT_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'];

export interface MetaTokenFailure extends MetaTokenFailureDetails {
  outcome: MetaTokenOutcome;
}
/** Carries only classified scalar facts; never the request URL, token or a transport cause. */
export class MetaTokenError extends Error {
  constructor(readonly failure: MetaTokenFailure) {
    super(`Meta token request failed: ${failure.outcome}`);
    this.name = 'MetaTokenError';
  }
}
export interface MetaTokenDebug {
  userId: string;
  expiresAt: string;
  issuedAt: string | null;
}
export interface MetaTokenRefresh {
  token: string;
  expiresAt: string;
}
export interface MetaTokenClient {
  debugToken(token: string): Promise<MetaTokenDebug>;
  refreshToken(token: string): Promise<MetaTokenRefresh>;
}
type ObjectValue = Record<string, unknown>;

const object = (value: unknown): ObjectValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : null;
const validToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[\x21-\x7e]{1,8192}$/.test(value);
const integer = (value: unknown): number | null =>
  Number.isSafeInteger(value) ? Number(value) : null;
const unixSeconds = (value: unknown): number | null =>
  Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= MAX_UNIX_SECONDS
    ? Number(value)
    : null;

function failure(
  outcome: MetaTokenOutcome,
  fields: Partial<MetaTokenFailureDetails> = {},
): MetaTokenError {
  return new MetaTokenError({
    outcome,
    detail: null,
    httpStatus: null,
    metaCode: null,
    metaSubcode: null,
    metaType: null,
    metaMessage: null,
    fbtraceId: null,
    networkCode: null,
    ...fields,
  });
}

/** Meta may echo the request; hide the token and any token parameter before keeping 300 chars. */
function safeMessage(value: unknown, token: string): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .split(token)
    .join('[토큰]')
    .replace(/(access_token|input_token)=[^&\s"']*/gi, '$1=[토큰]')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 300) : null;
}

function metaError(httpStatus: number, error: ObjectValue, token: string): MetaTokenError {
  const fields: Partial<MetaTokenFailureDetails> = {
    httpStatus,
    metaCode: integer(error.code),
    metaSubcode: integer(error.error_subcode),
    metaType:
      typeof error.type === 'string' && /^[A-Za-z0-9_.]{1,80}$/.test(error.type)
        ? error.type
        : null,
    metaMessage: safeMessage(error.message, token),
    fbtraceId:
      typeof error.fbtrace_id === 'string' && /^[A-Za-z0-9_+/=-]{1,128}$/.test(error.fbtrace_id)
        ? error.fbtrace_id
        : null,
  };
  if (fields.metaCode === 190) return failure('invalid_token', fields);
  if (fields.metaCode === 10 || fields.metaCode === 200)
    return failure('rejected', { ...fields, detail: 'permission' });
  return failure('rejected', fields);
}

function networkCode(error: unknown): string | null {
  const cause = object(object(error)?.cause);
  const candidates = [
    cause?.code,
    object(error)?.code,
    Array.isArray(cause?.errors) ? object(cause.errors[0])?.code : undefined,
  ];
  const code = candidates.find((value) => typeof value === 'string');
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : null;
}

function transportFailure(error: unknown, timedOut: boolean, received: boolean): MetaTokenError {
  const name = object(error)?.name;
  if (timedOut || name === 'AbortError' || name === 'TimeoutError') return failure('timeout');
  const code = networkCode(error);
  if (!received && code && NOT_SENT_CODES.includes(code))
    return failure('not_sent', { networkCode: code });
  return failure('network', { networkCode: code });
}

async function readLimited(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > RESPONSE_LIMIT) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESPONSE_LIMIT) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * The only desktop Meta transport: two fixed GET requests for the managed-account token check and
 * manual refresh. The tester token authenticates its own debug_token call; no App Secret is used.
 */
export function createMetaTokenClient(
  options: { fetch?: typeof fetch; timeoutMs?: number; now?: () => number } = {},
): MetaTokenClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid Meta timeout');

  async function request(
    path: '/v1.0/debug_token' | '/refresh_access_token',
    query: Record<string, string>,
    token: string,
  ): Promise<{ status: number; body: ObjectValue }> {
    if (!validToken(token)) throw failure('not_sent');
    const url = new URL(path, API_ORIGIN);
    url.search = new URLSearchParams(query).toString();
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(failure('timeout'));
      }, timeoutMs);
    });
    const execute = async () => {
      let response: Response;
      try {
        response = await fetcher(url, {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
      } catch (error) {
        throw transportFailure(error, timedOut, false);
      }
      let text: string | null;
      try {
        text = await readLimited(response);
      } catch (error) {
        throw transportFailure(error, timedOut, true);
      }
      const status = response.status;
      if (text === null) throw failure('bad_response', { httpStatus: status });
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        // Keep only the response class; parser messages may quote the body.
      }
      const body = object(payload);
      const error = object(body?.error);
      if (error) throw metaError(status, error, token);
      if (!response.ok) throw failure('rejected', { httpStatus: status });
      if (!body) throw failure('bad_response', { httpStatus: status });
      return { status, body };
    };
    try {
      return await Promise.race([execute(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async debugToken(token) {
      const { status, body } = await request(
        '/v1.0/debug_token',
        { input_token: token, access_token: token },
        token,
      );
      const data = object(body.data);
      if (data?.is_valid === false) {
        const error = object(data.error);
        throw failure('invalid_token', {
          httpStatus: status,
          metaCode: integer(error?.code),
          metaSubcode: integer(error?.subcode),
          metaMessage: safeMessage(error?.message, token),
        });
      }
      const expiresAt = unixSeconds(data?.expires_at);
      if (
        !data ||
        data.is_valid !== true ||
        data.type !== 'USER' ||
        typeof data.user_id !== 'string' ||
        !/^\d{1,40}$/.test(data.user_id) ||
        expiresAt === null
      )
        throw failure('bad_response', { httpStatus: status });
      const remaining = expiresAt * 1000 - now();
      if (remaining <= 0) throw failure('invalid_token', { httpStatus: status, detail: 'expired' });
      // A 1-hour short-lived token or one about to lapse cannot serve the phone for long.
      if (remaining < DAY_MS)
        throw failure('invalid_token', { httpStatus: status, detail: 'short_lived' });
      const issuedAt = unixSeconds(data.issued_at);
      return {
        userId: data.user_id,
        expiresAt: new Date(expiresAt * 1000).toISOString(),
        issuedAt: issuedAt === null ? null : new Date(issuedAt * 1000).toISOString(),
      };
    },
    async refreshToken(token) {
      const started = now();
      const { status, body } = await request(
        '/refresh_access_token',
        { grant_type: 'th_refresh_token', access_token: token },
        token,
      );
      const seconds = integer(body.expires_in);
      if (
        !validToken(body.access_token) ||
        seconds === null ||
        seconds < 1 ||
        seconds > MAX_REFRESH_SECONDS
      )
        throw failure('bad_response', { httpStatus: status });
      return {
        token: body.access_token,
        expiresAt: new Date(started + seconds * 1000).toISOString(),
      };
    },
  };
}

const DEBUG_PERMISSION =
  '해당 Meta 앱의 Threads 테스터로 등록하고 초대를 수락한 계정의 토큰인지 확인하세요.';

/** One Korean sentence for toasts and dialogs; detailed fields stay in the check log. */
export function metaTokenFailureSummary(failure: MetaTokenFailure): string {
  const parts = [
    failure.httpStatus === null ? null : `HTTP ${failure.httpStatus}`,
    failure.metaCode === null ? null : `코드 ${failure.metaCode}`,
    failure.metaSubcode === null ? null : `하위 코드 ${failure.metaSubcode}`,
    failure.metaType,
    failure.fbtraceId ? `fbtrace_id ${failure.fbtraceId}` : null,
    failure.networkCode ? `네트워크 코드 ${failure.networkCode}` : null,
  ].filter((part): part is string => !!part);
  const facts = parts.length ? ` (${parts.join(' · ')})` : '';
  switch (failure.outcome) {
    case 'invalid_token':
      if (failure.detail === 'expired')
        return '토큰이 만료되었습니다. 새 장기 토큰을 발급해 교체해 주세요.';
      if (failure.detail === 'short_lived')
        return '남은 기간이 24시간보다 짧습니다. 1시간짜리 단기 토큰이거나 곧 만료되는 토큰입니다. 장기 토큰을 다시 발급해 주세요.';
      return `Meta가 토큰을 유효하지 않다고 응답했습니다${facts}. 새 장기 토큰으로 교체해 주세요.`;
    case 'rejected':
      return failure.detail === 'permission'
        ? `토큰 정보를 조회할 권한이 없습니다${facts}. ${DEBUG_PERMISSION}`
        : `Meta가 요청을 거절했습니다${facts}.`;
    case 'timeout':
      return 'Meta 응답을 기다리는 시간이 초과되었습니다. 요청이 처리됐는지 알 수 없습니다.';
    case 'network':
      return `Meta와 통신하지 못했습니다${facts}. 요청이 처리됐는지 알 수 없습니다.`;
    case 'not_sent':
      return `Meta에 요청을 보내지 못했습니다${facts}. 인터넷 연결을 확인해 주세요.`;
    case 'bad_response':
      return `Meta 응답을 확인하지 못했습니다${facts}.`;
  }
}
