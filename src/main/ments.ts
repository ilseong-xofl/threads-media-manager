import type { Problem } from '../shared/contracts';
import {
  MENT_BODY_LIMIT,
  MENT_NAME_LIMIT,
  MENT_TITLE_LIMIT,
  mentLength,
  type Ment,
  type MentBrand,
  type MentCatalog,
  type MentKind,
  type MentProduct,
  type MentResult,
} from '../shared/ments';
import { exactKeys, isObject } from './managed-threads-store';
import { uuid } from './mobile-publication-data';
import { ServiceApiError, type ServiceApiClient, type ServiceBusinessContext } from './service-api';

type Client = Pick<
  ServiceApiClient,
  'getBusinessContext' | 'assertBusinessContext' | 'mentRequest'
>;

class MentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function fail(code: string, message: string): never {
  throw new MentError(code, message);
}
const invalid = (): never => fail('ment_input', '입력한 내용을 확인해 주세요.');
const unreadable = (): never => fail('INVALID_RESPONSE', '멘트 목록을 확인하지 못했습니다.');
const KINDS: readonly string[] = ['brand', 'product', 'ment'];
/** Half of a broken character: the server refuses it, as stored text it would turn into "�". */
const LONE_SURROGATE = /\p{Cs}/u;

/** A name or a title as it is kept: one line, without spaces around it, within the limit. */
function line(value: unknown, limit: number): string {
  if (typeof value !== 'string') return invalid();
  const text = value.trim();
  if (/\p{Cc}/u.test(text))
    return fail('ment_input', '이름과 제목에는 줄바꿈이나 탭을 쓸 수 없습니다.');
  if (!text || mentLength(text) > limit || LONE_SURROGATE.test(text)) return invalid();
  return text;
}
function mentBody(value: unknown): string {
  if (typeof value !== 'string') return invalid();
  const text = value.trim();
  if (
    !text ||
    mentLength(text) > MENT_BODY_LIMIT ||
    text.includes('\u0000') ||
    LONE_SURROGATE.test(text)
  )
    return invalid();
  return text;
}

/** One save as the server takes it: the item's kind, its id and the body to send. */
function saveRequest(value: unknown): { kind: MentKind; id: string; body: Record<string, string> } {
  if (!isObject(value) || !uuid(value.id)) return invalid();
  if (value.kind === 'brand' && exactKeys(value, ['kind', 'id', 'name']))
    return { kind: 'brand', id: value.id, body: { name: line(value.name, MENT_NAME_LIMIT) } };
  if (
    value.kind === 'product' &&
    exactKeys(value, ['kind', 'id', 'brandId', 'name']) &&
    uuid(value.brandId)
  )
    return {
      kind: 'product',
      id: value.id,
      body: { brandId: value.brandId, name: line(value.name, MENT_NAME_LIMIT) },
    };
  if (
    value.kind === 'ment' &&
    exactKeys(value, ['kind', 'id', 'productId', 'title', 'body']) &&
    uuid(value.productId)
  )
    return {
      kind: 'ment',
      id: value.id,
      body: {
        productId: value.productId,
        title: line(value.title, MENT_TITLE_LIMIT),
        body: mentBody(value.body),
      },
    };
  return invalid();
}
function deleteRequest(value: unknown): { kind: MentKind; id: string } {
  if (
    !isObject(value) ||
    !exactKeys(value, ['kind', 'id']) ||
    typeof value.kind !== 'string' ||
    !KINDS.includes(value.kind) ||
    !uuid(value.id)
  )
    return invalid();
  return { kind: value.kind as MentKind, id: value.id };
}

const text = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length > 0 && mentLength(value) <= limit;
function parseMent(value: unknown): Ment {
  if (
    !isObject(value) ||
    !uuid(value.id) ||
    !text(value.title, MENT_TITLE_LIMIT) ||
    !text(value.body, MENT_BODY_LIMIT)
  )
    return unreadable();
  return { id: value.id, title: value.title, body: value.body };
}
function parseProduct(value: unknown): MentProduct {
  if (
    !isObject(value) ||
    !uuid(value.id) ||
    !text(value.name, MENT_NAME_LIMIT) ||
    !Array.isArray(value.ments)
  )
    return unreadable();
  return { id: value.id, name: value.name, ments: value.ments.map(parseMent) };
}
function parseBrand(value: unknown): MentBrand {
  if (
    !isObject(value) ||
    !uuid(value.id) ||
    !text(value.name, MENT_NAME_LIMIT) ||
    !Array.isArray(value.products)
  )
    return unreadable();
  return { id: value.id, name: value.name, products: value.products.map(parseProduct) };
}
/** The whole catalog as the server sends it. Fields this version does not know are ignored. */
export function parseMentCatalog(value: unknown): MentCatalog {
  if (!isObject(value) || !Array.isArray(value.brands)) return unreadable();
  return { brands: value.brands.map(parseBrand) };
}

const safeProblem = (error: unknown): Problem =>
  error instanceof MentError || error instanceof ServiceApiError
    ? { code: error.code, message: error.message }
    : { code: 'ment_failed', message: '멘트 작업을 끝내지 못했습니다. 다시 시도해 주세요.' };
/**
 * Failures after which the screen stays as it is: an input mistake, a login change (the app checks
 * its access) and a server without the catalog. After any other failed change, including a lost
 * answer, the catalog is read again so the screen shows what the server has.
 */
const KEEPS_SCREEN = new Set([
  'ment_input',
  'VALIDATION_FAILED',
  'AUTH_REQUIRED',
  'AUTH_CHANGED',
  'MENT_UNAVAILABLE',
]);
/** Problems after which the app checks its access to the service again. */
const ACCESS_PROBLEMS = new Set(['AUTH_REQUIRED', 'AUTH_CHANGED', 'SERVICE_UNAVAILABLE']);

/**
 * The employee's brands, products and ments (2026-11-24). The server keeps the only copy; this PC
 * only checks what goes out and what comes back.
 */
export class MentController {
  constructor(private readonly client: Client) {}
  list(): Promise<MentResult> {
    return this.run((context) => this.request(context, 'list'), false);
  }
  save(input: unknown): Promise<MentResult> {
    return this.run((context) => {
      const save = saveRequest(input);
      return this.request(context, 'save', save.kind, save.id, save.body);
    }, true);
  }
  delete(input: unknown): Promise<MentResult> {
    return this.run((context) => {
      const target = deleteRequest(input);
      return this.request(context, 'delete', target.kind, target.id);
    }, true);
  }
  private async request(
    context: ServiceBusinessContext,
    operation: 'list' | 'save' | 'delete',
    kind?: MentKind,
    id?: string,
    body?: Record<string, string>,
  ): Promise<MentCatalog> {
    this.client.assertBusinessContext(context);
    const raw = await this.client.mentRequest(context, operation, kind, id, body);
    this.client.assertBusinessContext(context);
    return parseMentCatalog(raw);
  }
  private async run(
    action: (context: ServiceBusinessContext) => Promise<MentCatalog>,
    change: boolean,
  ): Promise<MentResult> {
    let context: ServiceBusinessContext | undefined;
    try {
      context = await this.client.getBusinessContext();
      return { status: 'ok', catalog: await action(context), problem: null };
    } catch (error) {
      let problem = safeProblem(error);
      let catalog: MentCatalog | null = null;
      if (change && context && !KEEPS_SCREEN.has(problem.code))
        try {
          catalog = await this.request(context, 'list');
        } catch (reading) {
          // A login or connection lost on the way back is what the app has to check now.
          const lost = safeProblem(reading);
          if (ACCESS_PROBLEMS.has(lost.code)) problem = lost;
        }
      return { status: 'error', catalog, problem };
    }
  }
}
