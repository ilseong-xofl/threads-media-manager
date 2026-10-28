import { describe, expect, it, vi } from 'vitest';
import {
  createMetaTokenClient,
  MetaTokenError,
  metaTokenFailureSummary,
  type MetaTokenFailure,
} from './meta-token-client';

const NOW = Date.parse('2026-10-28T00:00:00.000Z');
const TOKEN = 'THAAsynthetic-tester-token';
const seconds = (days: number) => Math.floor((NOW + days * 86_400_000) / 1000);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function client(response: Response | (() => Promise<Response>), timeoutMs?: number) {
  const fetcher = vi.fn<typeof fetch>(async () =>
    typeof response === 'function' ? response() : response,
  );
  return { fetcher, meta: createMetaTokenClient({ fetch: fetcher, now: () => NOW, timeoutMs }) };
}
async function failureOf(work: Promise<unknown>): Promise<MetaTokenFailure> {
  const error = await work.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(MetaTokenError);
  const failure = (error as MetaTokenError).failure;
  // Neither the URL with its token parameters nor the token may leave as error data.
  const visible = `${(error as Error).message} ${JSON.stringify(failure)}`;
  expect(visible).not.toContain('graph.threads.com');
  expect(visible).not.toContain(TOKEN);
  expect(visible).not.toContain('access_token=TH');
  expect((error as Error).cause).toBeUndefined();
  return failure;
}
const valid = (fields: Record<string, unknown> = {}) =>
  json({
    data: {
      type: 'USER',
      application: 'Synthetic app',
      is_valid: true,
      user_id: '1234567890',
      expires_at: seconds(55),
      issued_at: seconds(-5),
      ...fields,
    },
  });

describe('desktop Meta token client', () => {
  it('checks a tester token with itself on the fixed debug_token GET', async () => {
    const { fetcher, meta } = client(valid());
    expect(await meta.debugToken(TOKEN)).toEqual({
      userId: '1234567890',
      expiresAt: new Date(seconds(55) * 1000).toISOString(),
      issuedAt: new Date(seconds(-5) * 1000).toISOString(),
    });
    const [url, init] = fetcher.mock.calls[0];
    const target = new URL(String(url));
    expect(`${target.origin}${target.pathname}`).toBe('https://graph.threads.com/v1.0/debug_token');
    expect(Object.fromEntries(target.searchParams)).toEqual({
      input_token: TOKEN,
      access_token: TOKEN,
    });
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init).not.toHaveProperty('body');
  });
  it('refreshes on the fixed GET and dates the new expiry from the request start', async () => {
    const { fetcher, meta } = client(
      json({ access_token: 'THAAnew-token', token_type: 'bearer', expires_in: 5_183_944 }),
    );
    expect(await meta.refreshToken(TOKEN)).toEqual({
      token: 'THAAnew-token',
      expiresAt: new Date(NOW + 5_183_944_000).toISOString(),
    });
    const target = new URL(String(fetcher.mock.calls[0][0]));
    expect(`${target.origin}${target.pathname}`).toBe(
      'https://graph.threads.com/refresh_access_token',
    );
    expect(Object.fromEntries(target.searchParams)).toEqual({
      grant_type: 'th_refresh_token',
      access_token: TOKEN,
    });
  });
  it('classifies error 190 as an invalid token and keeps only safe, redacted facts', async () => {
    const { meta } = client(
      json(
        {
          error: {
            message: `Error validating access token: Session has expired. access_token=${TOKEN}&x=1 input_token=abc ${TOKEN}`,
            type: 'OAuthException',
            code: 190,
            error_subcode: 463,
            fbtrace_id: 'AbC_12-x',
          },
        },
        400,
      ),
    );
    const failure = await failureOf(meta.debugToken(TOKEN));
    expect(failure).toEqual({
      outcome: 'invalid_token',
      detail: null,
      httpStatus: 400,
      metaCode: 190,
      metaSubcode: 463,
      metaType: 'OAuthException',
      metaMessage:
        'Error validating access token: Session has expired. access_token=[토큰]&x=1 input_token=[토큰] [토큰]',
      fbtraceId: 'AbC_12-x',
      networkCode: null,
    });
    expect(metaTokenFailureSummary(failure)).toBe(
      'Meta가 토큰을 유효하지 않다고 응답했습니다 (HTTP 400 · 코드 190 · 하위 코드 463 · OAuthException · fbtrace_id AbC_12-x). 새 장기 토큰으로 교체해 주세요.',
    );
  });
  it('captures data.error of an is_valid=false check as an invalid token', async () => {
    const { meta } = client(
      json({
        data: {
          is_valid: false,
          error: { code: 190, subcode: 460, message: `Password changed for ${TOKEN}` },
        },
      }),
    );
    expect(await failureOf(meta.debugToken(TOKEN))).toMatchObject({
      outcome: 'invalid_token',
      httpStatus: 200,
      metaCode: 190,
      metaSubcode: 460,
      metaMessage: 'Password changed for [토큰]',
    });
  });
  it('rejects an expired token and one with less than 24 hours left', async () => {
    const expired = await failureOf(
      client(valid({ expires_at: seconds(0) })).meta.debugToken(TOKEN),
    );
    expect(expired).toMatchObject({ outcome: 'invalid_token', detail: 'expired', httpStatus: 200 });
    expect(metaTokenFailureSummary(expired)).toContain('토큰이 만료되었습니다');
    const short = await failureOf(
      client(valid({ expires_at: seconds(0) + 3600 })).meta.debugToken(TOKEN),
    );
    expect(short).toMatchObject({ outcome: 'invalid_token', detail: 'short_lived' });
    expect(metaTokenFailureSummary(short)).toBe(
      '남은 기간이 24시간보다 짧습니다. 1시간짜리 단기 토큰이거나 곧 만료되는 토큰입니다. 장기 토큰을 다시 발급해 주세요.',
    );
    expect(
      await client(valid({ expires_at: seconds(1) + 1 })).meta.debugToken(TOKEN),
    ).toMatchObject({ userId: '1234567890' });
  });
  it.each([10, 200])('explains permission error %i with the tester invitation', async (code) => {
    const failure = await failureOf(
      client(
        json({ error: { code, type: 'OAuthException', message: 'denied' } }, 403),
      ).meta.debugToken(TOKEN),
    );
    expect(failure).toMatchObject({ outcome: 'rejected', detail: 'permission', metaCode: code });
    expect(metaTokenFailureSummary(failure)).toContain(
      '해당 Meta 앱의 Threads 테스터로 등록하고 초대를 수락한 계정의 토큰인지 확인하세요.',
    );
  });
  it('treats other Meta errors and non-JSON failures as rejections with the HTTP status', async () => {
    expect(
      await failureOf(
        client(json({ error: { code: 100, message: 'Unsupported get request' } })).meta.debugToken(
          TOKEN,
        ),
      ),
    ).toMatchObject({ outcome: 'rejected', detail: null, httpStatus: 200, metaCode: 100 });
    const gateway = await failureOf(
      client(new Response('<html>Bad gateway</html>', { status: 502 })).meta.refreshToken(TOKEN),
    );
    expect(gateway).toMatchObject({ outcome: 'rejected', httpStatus: 502, metaCode: null });
    expect(metaTokenFailureSummary(gateway)).toBe('Meta가 요청을 거절했습니다 (HTTP 502).');
  });
  it.each([
    ['ENOTFOUND', 'not_sent'],
    ['EAI_AGAIN', 'not_sent'],
    ['ECONNREFUSED', 'not_sent'],
    ['ECONNRESET', 'network'],
    ['UND_ERR_SOCKET', 'network'],
  ])('classifies a transport failure with cause %s as %s', async (code, outcome) => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error(`getaddrinfo ${code} graph.threads.com`), { code }),
    });
    const failure = await failureOf(
      createMetaTokenClient({
        fetch: async () => Promise.reject(error),
        now: () => NOW,
      }).debugToken(TOKEN),
    );
    expect(failure).toMatchObject({ outcome, networkCode: code });
    expect(metaTokenFailureSummary(failure)).toContain(`네트워크 코드 ${code}`);
  });
  it('treats an unknown transport failure as network and a dropped body as sent', async () => {
    const unknown = await failureOf(
      createMetaTokenClient({
        fetch: async () => Promise.reject(new TypeError('fetch failed')),
      }).debugToken(TOKEN),
    );
    expect(unknown).toMatchObject({ outcome: 'network', networkCode: null });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(Object.assign(new Error('socket'), { code: 'ECONNREFUSED' }));
      },
    });
    expect(
      await failureOf(client(new Response(body, { status: 200 })).meta.debugToken(TOKEN)),
    ).toMatchObject({ outcome: 'network', networkCode: 'ECONNREFUSED' });
  });
  it('times out an unanswered request and aborts it', async () => {
    let signal: AbortSignal | undefined;
    const meta = createMetaTokenClient({
      timeoutMs: 20,
      fetch: (_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      },
    });
    const failure = await failureOf(meta.refreshToken(TOKEN));
    expect(failure.outcome).toBe('timeout');
    expect(signal?.aborted).toBe(true);
    expect(metaTokenFailureSummary(failure)).toContain('요청이 처리됐는지 알 수 없습니다');
    const aborted = await failureOf(
      createMetaTokenClient({
        fetch: async () => Promise.reject(new DOMException('aborted', 'AbortError')),
      }).debugToken(TOKEN),
    );
    expect(aborted.outcome).toBe('timeout');
  });
  it.each([
    ['unparsable', () => new Response('not json')],
    ['oversized', () => new Response('x'.repeat(2 * 1024 * 1024 + 1))],
    [
      'declared oversized',
      () => new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } }),
    ],
    ['an app token', () => valid({ type: 'APP' })],
    ['a non-numeric user', () => valid({ user_id: 'me' })],
    ['a missing expiry', () => valid({ expires_at: 0 })],
    ['an unbounded expiry', () => valid({ expires_at: 300_000_000_000 })],
  ])('reports %s debug responses as bad responses', async (_name, response) => {
    expect(await failureOf(client(response()).meta.debugToken(TOKEN))).toMatchObject({
      outcome: 'bad_response',
      httpStatus: 200,
    });
  });
  it.each([
    { access_token: 'has space', expires_in: 100 },
    { access_token: 'THAAok', expires_in: 0 },
    { access_token: 'THAAok', expires_in: 61 * 86_400 + 1 },
    { access_token: 'THAAok', expires_in: 1.5 },
    { expires_in: 100 },
  ])('reports an invalid refresh response %j as a bad response', async (body) => {
    expect(await failureOf(client(json(body)).meta.refreshToken(TOKEN))).toMatchObject({
      outcome: 'bad_response',
    });
  });
  it('limits the Meta message to 300 characters after redaction', async () => {
    const failure = await failureOf(
      client(
        json({ error: { code: 1, message: `${TOKEN} ${'긴 설명 '.repeat(200)}` } }),
      ).meta.debugToken(TOKEN),
    );
    expect(failure.metaMessage).toHaveLength(300);
    expect(failure.metaMessage!.startsWith('[토큰] 긴 설명')).toBe(true);
  });
  it('never sends a malformed token', async () => {
    const { fetcher, meta } = client(valid());
    expect((await failureOf(meta.debugToken('bad token'))).outcome).toBe('not_sent');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('summarizes uncertain, unsent and unreadable results distinctly', () => {
    const base: MetaTokenFailure = {
      outcome: 'network',
      detail: null,
      httpStatus: null,
      metaCode: null,
      metaSubcode: null,
      metaType: null,
      metaMessage: null,
      fbtraceId: null,
      networkCode: 'ECONNRESET',
    };
    expect(metaTokenFailureSummary(base)).toBe(
      'Meta와 통신하지 못했습니다 (네트워크 코드 ECONNRESET). 요청이 처리됐는지 알 수 없습니다.',
    );
    expect(
      metaTokenFailureSummary({ ...base, outcome: 'not_sent', networkCode: 'ENOTFOUND' }),
    ).toBe(
      'Meta에 요청을 보내지 못했습니다 (네트워크 코드 ENOTFOUND). 인터넷 연결을 확인해 주세요.',
    );
    expect(
      metaTokenFailureSummary({
        ...base,
        outcome: 'bad_response',
        networkCode: null,
        httpStatus: 200,
      }),
    ).toBe('Meta 응답을 확인하지 못했습니다 (HTTP 200).');
  });
});
