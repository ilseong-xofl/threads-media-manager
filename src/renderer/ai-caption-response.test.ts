import { describe, expect, it } from 'vitest';
import { parseAICaptionResponse } from './ai-caption-response';

describe('AI caption IPC response boundary', () => {
  it('accepts the new main response and copies three normalized suggestions', () => {
    const response = {
      status: 'generated',
      captions: [' 첫 제안 \n', 'Cafe\u0301', '마지막 제안'],
    };
    const before = structuredClone(response);
    const result = parseAICaptionResponse(response);
    expect(result).toEqual({ status: 'generated', captions: ['첫 제안', 'Café', '마지막 제안'] });
    expect(response).toEqual(before);
    if (result.status === 'generated') expect(result.captions).not.toBe(response.captions);
  });

  it('reports a full restart for an old main response instead of passing undefined to the modal', () => {
    const response: unknown = { status: 'generated', caption: '이전 프로세스의 단일 캡션' };
    expect(() => parseAICaptionResponse(response)).toThrow('앱을 완전히 종료하고 다시 실행');
    expect(() => parseAICaptionResponse(response)).not.toThrow('Cannot read properties');
  });

  it('does not carry a legacy failure into a later response from the restarted main process', () => {
    expect(() => parseAICaptionResponse({ status: 'generated', caption: '이전 응답' })).toThrow();
    expect(
      parseAICaptionResponse({ status: 'generated', captions: ['첫째', '둘째', '셋째'] }),
    ).toEqual({
      status: 'generated',
      captions: ['첫째', '둘째', '셋째'],
    });
  });

  it('accepts cancellation and preserves safe backend error messages', () => {
    expect(parseAICaptionResponse({ status: 'cancelled' })).toEqual({ status: 'cancelled' });
    expect(
      parseAICaptionResponse({
        status: 'error',
        problem: { code: 'codex_login', message: 'Codex CLI 로그인이 필요합니다.' },
      }),
    ).toEqual({
      status: 'error',
      problem: { code: 'codex_login', message: 'Codex CLI 로그인이 필요합니다.' },
    });
  });

  it('accepts the exact UTF-16 caption length limit', () => {
    const captions = ['가'.repeat(10_000), '🌿'.repeat(5000), '셋째'];
    expect(parseAICaptionResponse({ status: 'generated', captions })).toEqual({
      status: 'generated',
      captions,
    });
  });

  it.each([
    undefined,
    null,
    [],
    'generated',
    {},
    { status: 'unknown' },
    { status: 'generated' },
    { status: 'generated', captions: undefined },
    { status: 'generated', captions: 'single string' },
    { status: 'generated', captions: [] },
    { status: 'generated', captions: ['a'] },
    { status: 'generated', captions: ['a', 'b'] },
    { status: 'generated', captions: ['a', 'b', 'c', 'd'] },
    { status: 'generated', captions: ['a', 'b', null] },
    { status: 'generated', captions: Object.assign(new Array(3), { 1: 'b', 2: 'c' }) },
    { status: 'generated', captions: ['a', 'b', 1] },
    { status: 'generated', captions: ['a', 'b', ''] },
    { status: 'generated', captions: ['a', 'b', ' \t\n '] },
    { status: 'generated', captions: ['a', 'b', ' a '] },
    { status: 'generated', captions: ['Café', 'Cafe\u0301', 'third'] },
    { status: 'generated', captions: ['한글', '\u1112\u1161\u11ab\u1100\u1173\u11af', 'third'] },
    { status: 'generated', captions: ['a', 'b', 'c'.repeat(10_001)] },
    { status: 'generated', captions: ['a', 'b', '🌿'.repeat(5001)] },
    { status: 'generated', captions: ['a', 'b', '\x00bad'] },
    { status: 'generated', captions: ['a', 'b', 'bad\x7f'] },
    { status: 'generated', captions: ['a', 'b', 'c'], caption: 'mixed contract' },
    { status: 'cancelled', captions: ['a', 'b', 'c'] },
    { status: 'error' },
    { status: 'error', problem: null },
    { status: 'error', problem: { code: 'codex_login' } },
    { status: 'error', problem: { code: 'codex_login', message: '' } },
    { status: 'error', problem: { code: 'codex_login', message: 'bad\x00' } },
    { status: 'error', problem: { code: 'codex_login', message: 'a'.repeat(2001) } },
  ])('rejects malformed IPC data without returning a missing captions value', (response) => {
    expect(() => parseAICaptionResponse(response)).toThrow(
      'AI 캡션 응답 형식을 확인하지 못했습니다',
    );
  });
});
