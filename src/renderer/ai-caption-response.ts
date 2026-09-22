import type { GenerateCaptionResult } from '../shared/contracts';
import { validDraftCaption } from '../shared/post-draft';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).sort().join(',') === [...expected].sort().join(',');

export function parseAICaptionResponse(value: unknown): GenerateCaptionResult {
  if (object(value)) {
    if (value.status === 'generated') {
      // Renderer HMR can outlive the main process running the previous IPC contract.
      if (typeof value.caption === 'string' && value.captions === undefined)
        throw new Error(
          '앱의 실행 버전과 화면 버전이 달라 캡션 제안을 표시하지 못했습니다. 작성 내용을 저장한 뒤 앱을 완전히 종료하고 다시 실행해 주세요.',
        );
      if (
        keys(value, ['status', 'captions']) &&
        Array.isArray(value.captions) &&
        value.captions.length === 3 &&
        Array.from(value.captions).every(validDraftCaption)
      ) {
        const captions = value.captions.map((caption) => caption.trim().normalize('NFC'));
        if (
          captions.every((caption) => caption.length > 0 && validDraftCaption(caption)) &&
          new Set(captions).size === 3
        )
          return { status: 'generated', captions: [captions[0], captions[1], captions[2]] };
      }
    }
    if (value.status === 'cancelled' && keys(value, ['status'])) return { status: 'cancelled' };
    if (value.status === 'error' && keys(value, ['status', 'problem']) && object(value.problem)) {
      const problem = value.problem;
      if (
        Object.keys(problem).every((key) => ['code', 'message', 'source'].includes(key)) &&
        typeof problem.code === 'string' &&
        /^[a-z][a-z0-9_]{0,63}$/.test(problem.code) &&
        typeof problem.message === 'string' &&
        problem.message.trim().length > 0 &&
        problem.message.length <= 2000 &&
        validDraftCaption(problem.message) &&
        (problem.source === undefined ||
          (typeof problem.source === 'string' && problem.source.length <= 2048))
      )
        return { status: 'error', problem: { code: problem.code, message: problem.message } };
    }
  }
  throw new Error(
    'AI 캡션 응답 형식을 확인하지 못했습니다. 작성 내용은 유지됩니다. 다시 생성해 주세요.',
  );
}
