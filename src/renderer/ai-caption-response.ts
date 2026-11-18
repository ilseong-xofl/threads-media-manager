import type {
  GenerateCaptionResult,
  GeneratePostCommentResult,
  Problem,
} from '../shared/contracts';
import { validDraftCaption } from '../shared/post-draft';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).sort().join(',') === [...expected].sort().join(',');

/** Three trimmed NFC texts, or null. `distinct` refuses repeated suggestions. */
function three(value: unknown, distinct: boolean): [string, string, string] | null {
  if (!Array.isArray(value) || value.length !== 3 || !Array.from(value).every(validDraftCaption))
    return null;
  const texts = value.map((text) => text.trim().normalize('NFC'));
  if (
    !texts.every((text) => text.length > 0 && validDraftCaption(text)) ||
    (distinct && new Set(texts).size !== 3)
  )
    return null;
  return [texts[0], texts[1], texts[2]];
}

/** Three suggestions under `field`, with three optional Korean renderings. */
function generated(value: Record<string, unknown>, field: string) {
  const withTranslations = value.translations !== undefined;
  if (!keys(value, ['status', field, ...(withTranslations ? ['translations'] : [])])) return null;
  const texts = three(value[field], true);
  const translations = withTranslations ? three(value.translations, false) : undefined;
  if (!texts || translations === null) return null;
  return { texts, translations };
}

function problem(value: Record<string, unknown>): Problem | null {
  if (!keys(value, ['status', 'problem']) || !object(value.problem)) return null;
  const problem = value.problem;
  return Object.keys(problem).every((key) => ['code', 'message', 'source'].includes(key)) &&
    typeof problem.code === 'string' &&
    /^[a-z][a-z0-9_]{0,63}$/.test(problem.code) &&
    typeof problem.message === 'string' &&
    problem.message.trim().length > 0 &&
    problem.message.length <= 2000 &&
    validDraftCaption(problem.message) &&
    (problem.source === undefined ||
      (typeof problem.source === 'string' && problem.source.length <= 2048))
    ? { code: problem.code, message: problem.message }
    : null;
}

export function parseAICaptionResponse(value: unknown): GenerateCaptionResult {
  if (object(value)) {
    if (value.status === 'generated') {
      // Renderer HMR can outlive the main process running the previous IPC contract.
      if (typeof value.caption === 'string' && value.captions === undefined)
        throw new Error(
          '앱의 실행 버전과 화면 버전이 달라 캡션 제안을 표시하지 못했습니다. 작성 내용을 저장한 뒤 앱을 완전히 종료하고 다시 실행해 주세요.',
        );
      const result = generated(value, 'captions');
      if (result)
        return {
          status: 'generated',
          captions: result.texts,
          ...(result.translations ? { translations: result.translations } : {}),
        };
    }
    if (value.status === 'cancelled' && keys(value, ['status'])) return { status: 'cancelled' };
    const failure = value.status === 'error' ? problem(value) : null;
    if (failure) return { status: 'error', problem: failure };
  }
  throw new Error(
    'AI 캡션 응답 형식을 확인하지 못했습니다. 작성 내용은 유지됩니다. 다시 생성해 주세요.',
  );
}

export function parseAICommentResponse(value: unknown): GeneratePostCommentResult {
  if (object(value)) {
    const result = value.status === 'generated' ? generated(value, 'comments') : null;
    if (result)
      return {
        status: 'generated',
        comments: result.texts,
        ...(result.translations ? { translations: result.translations } : {}),
      };
    if (value.status === 'cancelled' && keys(value, ['status'])) return { status: 'cancelled' };
    const failure = value.status === 'error' ? problem(value) : null;
    if (failure) return { status: 'error', problem: failure };
  }
  throw new Error(
    'AI 댓글 응답 형식을 확인하지 못했습니다. 작성 내용은 유지됩니다. 다시 생성해 주세요.',
  );
}
