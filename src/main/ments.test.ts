import { describe, expect, it, vi } from 'vitest';
import { MentController, parseMentCatalog } from './ments';
import { ServiceApiError, type ServiceBusinessContext } from './service-api';

const brandId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const productId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const mentId = '16fd2706-8baf-433b-82eb-8c7fada847da';
const catalog = {
  brands: [
    {
      id: brandId,
      name: '브랜드',
      products: [
        {
          id: productId,
          name: '제품',
          ments: [{ id: mentId, title: '후기형', body: '써 보니\n좋아요' }],
        },
      ],
    },
  ],
};

function setup() {
  const context: ServiceBusinessContext = { ownerId: 'user-a' };
  const client = {
    getBusinessContext: vi.fn(async () => context),
    assertBusinessContext: vi.fn(),
    mentRequest: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => catalog),
  };
  const ments = new MentController(
    client as unknown as ConstructorParameters<typeof MentController>[0],
  );
  return { client, ments, context };
}

describe('ment catalog on this PC', () => {
  it('reads the catalog and ignores fields this version does not know', async () => {
    const { client, ments, context } = setup();
    client.mentRequest.mockResolvedValueOnce({
      brands: [{ ...catalog.brands[0], createdAt: '2026-11-24T00:00:00Z' }],
      revision: 3,
    });
    await expect(ments.list()).resolves.toEqual({ status: 'ok', catalog, problem: null });
    expect(client.mentRequest).toHaveBeenCalledWith(
      context,
      'list',
      undefined,
      undefined,
      undefined,
    );
  });

  it('counts names and texts in code points like the server', () => {
    const emoji = '😀'.repeat(40);
    const named = { brands: [{ id: brandId, name: emoji, products: [] }] };
    expect(parseMentCatalog(named)).toEqual(named);
    // A ment registered by its title alone has an empty body.
    const titled = {
      brands: [
        {
          id: brandId,
          name: '브랜드',
          products: [
            { id: productId, name: '제품', ments: [{ id: mentId, title: '제목', body: '' }] },
          ],
        },
      ],
    };
    expect(parseMentCatalog(titled)).toEqual(titled);
    for (const broken of [
      {},
      { brands: {} },
      { brands: [{ id: 'brand-1', name: '브랜드', products: [] }] },
      { brands: [{ id: brandId, name: '😀'.repeat(41), products: [] }] },
      { brands: [{ id: brandId, name: '', products: [] }] },
      { brands: [{ id: brandId, name: '브랜드' }] },
      {
        brands: [{ ...catalog.brands[0], products: [{ id: productId, name: '제품', ments: {} }] }],
      },
      {
        brands: [
          {
            ...catalog.brands[0],
            products: [
              { id: productId, name: '제품', ments: [{ id: mentId, title: '', body: '본문' }] },
            ],
          },
        ],
      },
      {
        brands: [
          {
            ...catalog.brands[0],
            products: [
              {
                id: productId,
                name: '제품',
                ments: [{ id: mentId, title: '제목', body: 'a'.repeat(501) }],
              },
            ],
          },
        ],
      },
    ])
      expect(() => parseMentCatalog(broken)).toThrow('멘트 목록을 확인하지 못했습니다.');
  });

  it('sends only trimmed fields on fixed operations', async () => {
    const { client, ments, context } = setup();
    await expect(ments.save({ kind: 'brand', id: brandId, name: '  브랜드  ' })).resolves.toEqual({
      status: 'ok',
      catalog,
      problem: null,
    });
    expect(client.mentRequest).toHaveBeenLastCalledWith(context, 'save', 'brand', brandId, {
      name: '브랜드',
    });
    await ments.save({ kind: 'product', id: productId, brandId, name: ' 제품 ' });
    expect(client.mentRequest).toHaveBeenLastCalledWith(context, 'save', 'product', productId, {
      brandId,
      name: '제품',
    });
    await ments.save({
      kind: 'ment',
      id: mentId,
      productId,
      title: ' 후기형 ',
      body: '\n 첫 줄\n\n둘째 줄 \n',
    });
    expect(client.mentRequest).toHaveBeenLastCalledWith(context, 'save', 'ment', mentId, {
      productId,
      title: '후기형',
      body: '첫 줄\n\n둘째 줄',
    });
    // A ment is registered by its title first; its body stays empty until it is written.
    await ments.save({ kind: 'ment', id: mentId, productId, title: '후기형', body: ' \n ' });
    expect(client.mentRequest).toHaveBeenLastCalledWith(context, 'save', 'ment', mentId, {
      productId,
      title: '후기형',
      body: '',
    });
    await ments.delete({ kind: 'product', id: productId });
    expect(client.mentRequest).toHaveBeenLastCalledWith(
      context,
      'delete',
      'product',
      productId,
      undefined,
    );
  });

  it('refuses input that the server would refuse, before any request', async () => {
    const { client, ments } = setup();
    for (const input of [
      null,
      'brand',
      { kind: 'brand', id: brandId },
      { kind: 'brand', id: brandId, name: '브랜드', extra: true },
      { kind: 'brand', id: 'brand-1', name: '브랜드' },
      { kind: 'brand', id: brandId, name: '   ' },
      { kind: 'brand', id: brandId, name: 'a'.repeat(41) },
      { kind: 'product', id: productId, brandId: 'brand', name: '제품' },
      { kind: 'ment', id: mentId, productId, title: '제목', body: 'a'.repeat(501) },
      { kind: 'ment', id: mentId, productId, title: '제목', body: '본문\u0000' },
      { kind: 'ment', id: mentId, productId, title: ' ', body: '본문' },
      { kind: 'brand', id: brandId, name: '반쪽\ud800' },
      { kind: 'ment', id: mentId, productId, title: '제목', body: '반쪽\udc00 본문' },
      { kind: 'account', id: brandId, name: '브랜드' },
    ]) {
      const result = await ments.save(input);
      expect(result).toMatchObject({ status: 'error', catalog: null });
      expect(result.problem?.code).toBe('ment_input');
    }
    await expect(ments.save({ kind: 'brand', id: brandId, name: '한 줄\n두 줄' })).resolves.toEqual(
      {
        status: 'error',
        catalog: null,
        problem: { code: 'ment_input', message: '이름과 제목에는 줄바꿈이나 탭을 쓸 수 없습니다.' },
      },
    );
    for (const input of [
      { kind: 'brand' },
      { kind: 'brand', id: brandId, more: 1 },
      { kind: 'account', id: brandId },
      { kind: 'brand', id: 'x' },
    ])
      expect((await ments.delete(input)).problem?.code).toBe('ment_input');
    expect(client.mentRequest).not.toHaveBeenCalled();
    // A name of 40 emoji is 40 characters.
    await expect(
      ments.save({ kind: 'brand', id: brandId, name: '😀'.repeat(40) }),
    ).resolves.toMatchObject({ status: 'ok' });
  });

  it('reads the catalog again after a failed change so the screen shows what the server has', async () => {
    const { client, ments, context } = setup();
    client.mentRequest.mockRejectedValueOnce(
      new ServiceApiError('같은 이름의 브랜드가 이미 있습니다.', 'MENT_NAME_TAKEN', 409),
    );
    await expect(ments.save({ kind: 'brand', id: brandId, name: '브랜드' })).resolves.toEqual({
      status: 'error',
      catalog,
      problem: { code: 'MENT_NAME_TAKEN', message: '같은 이름의 브랜드가 이미 있습니다.' },
    });
    expect(client.mentRequest).toHaveBeenLastCalledWith(
      context,
      'list',
      undefined,
      undefined,
      undefined,
    );
    // A lost answer: the change may have been made, so the catalog read again tells.
    client.mentRequest.mockRejectedValueOnce(
      new ServiceApiError('서비스에 연결할 수 없습니다.', 'SERVICE_UNAVAILABLE', 503),
    );
    await expect(ments.delete({ kind: 'ment', id: mentId })).resolves.toMatchObject({
      status: 'error',
      catalog,
      problem: { code: 'SERVICE_UNAVAILABLE' },
    });
    // A read that fails too leaves the screen as it is; a lost login or connection on the way back
    // is what is reported, so the app checks its access.
    client.mentRequest
      .mockRejectedValueOnce(new ServiceApiError('x', 'MENT_CONFLICT', 409))
      .mockRejectedValueOnce(new ServiceApiError('y', 'SERVICE_UNAVAILABLE', 503));
    await expect(ments.save({ kind: 'brand', id: brandId, name: '브랜드' })).resolves.toMatchObject(
      {
        status: 'error',
        catalog: null,
        problem: { code: 'SERVICE_UNAVAILABLE' },
      },
    );
    client.mentRequest
      .mockRejectedValueOnce(new ServiceApiError('x', 'MENT_CONFLICT', 409))
      .mockRejectedValueOnce(new ServiceApiError('y', 'AUTH_REQUIRED', 401));
    expect((await ments.save({ kind: 'brand', id: brandId, name: '브랜드' })).problem?.code).toBe(
      'AUTH_REQUIRED',
    );
    client.mentRequest
      .mockRejectedValueOnce(new ServiceApiError('x', 'MENT_CONFLICT', 409))
      .mockRejectedValueOnce(new ServiceApiError('y', 'INVALID_RESPONSE', 502));
    expect((await ments.save({ kind: 'brand', id: brandId, name: '브랜드' })).problem?.code).toBe(
      'MENT_CONFLICT',
    );
  });

  it('keeps the screen after a login change or on a server without the catalog', async () => {
    for (const code of ['AUTH_REQUIRED', 'AUTH_CHANGED', 'MENT_UNAVAILABLE']) {
      const { client, ments } = setup();
      client.mentRequest.mockRejectedValueOnce(new ServiceApiError('message', code, 401));
      await expect(ments.save({ kind: 'brand', id: brandId, name: '브랜드' })).resolves.toEqual({
        status: 'error',
        catalog: null,
        problem: { code, message: 'message' },
      });
      expect(client.mentRequest).toHaveBeenCalledTimes(1);
    }
    const { client, ments } = setup();
    client.mentRequest.mockRejectedValueOnce(new Error('secret detail'));
    await expect(ments.list()).resolves.toEqual({
      status: 'error',
      catalog: null,
      problem: {
        code: 'ment_failed',
        message: '멘트 작업을 끝내지 못했습니다. 다시 시도해 주세요.',
      },
    });
  });
});
