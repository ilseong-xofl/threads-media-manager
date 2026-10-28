import { randomUUID } from 'node:crypto';
import type {
  ManagedThreadsAccount,
  ManagedThreadsAccountRow,
  ManagedThreadsResult,
  ManagedThreadsTokenCheck,
  ManagedThreadsTokenOperation,
} from '../shared/managed-threads';
import { ServiceApiError, type ServiceApiClient, type ServiceBusinessContext } from './service-api';
import {
  EncryptedManagedThreadsStore,
  ManagedThreadsStorageError,
  exactKeys,
  isObject,
  parseManagedAccount,
  parseDeletedManagedAccount,
  validId,
  validLabel,
  validRevision,
  validToken,
  type ManagedThreadsRecord,
} from './managed-threads-store';
import {
  MetaTokenError,
  metaTokenFailureSummary,
  type MetaTokenClient,
  type MetaTokenFailure,
} from './meta-token-client';
import type { MetaTokenLog } from './meta-token-log';

type Client = Pick<
  ServiceApiClient,
  'getBusinessContext' | 'assertBusinessContext' | 'managedThreadsRequest'
>;
type Store = Pick<EncryptedManagedThreadsStore, 'read' | 'write'>;
export interface ManagedThreadsOptions {
  meta: Pick<MetaTokenClient, 'debugToken' | 'refreshToken'>;
  log: Pick<MetaTokenLog, 'append' | 'latest'>;
  now?: () => number;
  refreshWindowDays?: number;
}
type Pending = NonNullable<ManagedThreadsRecord['pending']>;
type Synced = ManagedThreadsRecord & { account: ManagedThreadsAccount; syncedToken: string };
type Checked<T> =
  { value: T; failure?: undefined } | { value?: undefined; failure: MetaTokenFailure };
const DAY_MS = 86_400_000;
const DEFAULT_REFRESH_WINDOW_DAYS = 14;

/** Packaged builds always use 14 days; a development run may change it for real-account checks. */
export function tokenRefreshWindowDays(packaged: boolean, value: string | undefined): number {
  if (packaged || !value || !/^\d{1,2}$/.test(value)) return DEFAULT_REFRESH_WINDOW_DAYS;
  const days = Number(value);
  return days >= 1 && days <= 60 ? days : DEFAULT_REFRESH_WINDOW_DAYS;
}

class ManagedProblem extends Error {
  constructor(
    readonly code: string,
    /** Replaces the fixed message, e.g. with the Meta failure summary or a duplicate's name. */
    readonly detail?: string,
  ) {
    super(code);
  }
}
const fail = (code: string, detail?: string): never => {
  throw new ManagedProblem(code, detail);
};
const messages: Record<string, string> = {
  STALE_LIFECYCLE: '계정 상태나 담당자가 변경되었습니다. 최신 상태에서 다시 선택해 주세요.',
  OWNERSHIP_REVOKED: '이 계정의 담당자가 변경되었습니다. 계정 관리 창을 다시 열어 주세요.',
  LIFECYCLE_CONFLICT: '계정 상태나 담당자가 변경되었습니다. 최신 상태에서 다시 선택해 주세요.',
  OWNERSHIP_CONFLICT: '계정 담당자가 변경되었습니다. 최신 상태를 확인해 주세요.',
  VALIDATION_FAILED: 'Meta 앱 이름·계정 이름·장기 토큰 입력을 확인해 주세요.',
  LEGACY_REGISTRATION_PENDING:
    '이전 App ID 방식의 저장 결과를 확인하지 못했습니다. 목록 동기화 후 보류 입력을 취소하고 앱 이름으로 다시 등록해 주세요.',
  AUTH_REQUIRED: '직원 계정으로 다시 로그인해 주세요.',
  AUTH_CHANGED: '로그인이 변경되었습니다. 계정 목록을 다시 확인해 주세요.',
  INVALID_RESPONSE: '서버의 계정 정보를 확인하지 못했습니다. 다시 시도해 주세요.',
  SERVICE_UNAVAILABLE:
    '서비스에 연결하지 못했습니다. 저장된 전송 대기 정보를 다시 시도할 수 있습니다.',
  MIGRATION_REQUIRED: '계정 관리 DB 업데이트가 필요합니다. 관리자에게 문의해 주세요.',
  REMOTE_CONFLICT: '계정 정보가 변경되었거나 이미 등록되었습니다. 최신 상태를 확인해 주세요.',
  STALE_CREDENTIAL:
    '서버 토큰이 변경되었습니다. 대기 입력을 취소하거나 최신 상태에서 다시 등록해 주세요.',
  NOT_FOUND: '계정 정보를 찾을 수 없습니다. 목록을 다시 확인해 주세요.',
  ACCOUNT_REMOVED: '삭제된 계정입니다. 계정 관리 창을 다시 열어 주세요.',
  DELETION_PENDING: '계정 삭제가 대기 중입니다. [삭제 재시도]를 눌러 주세요.',
  DELETE_CONFLICT:
    '토큰 정보가 변경되었습니다. 최신 목록을 확인한 뒤 계정 삭제를 다시 선택해 주세요.',
  LOCAL_DELETE_SYNC_PENDING:
    '서버에서 계정을 삭제했지만 이 PC의 사본을 정리하지 못했습니다. 서버와 다시 동기화해 주세요.',
  STORAGE_UNAVAILABLE: '운영체제 보안 저장소를 사용할 수 없습니다.',
  STORAGE_CORRUPT: '계정 보관 파일을 읽을 수 없습니다. 기존 파일은 보존했습니다.',
  STORAGE_WRITE_FAILED: '계정 정보를 안전하게 저장하지 못했습니다. 다시 시도해 주세요.',
  LOCAL_SYNC_PENDING:
    '서버에는 반영되었지만 로컬 저장을 완료하지 못했습니다. 목록을 새로고침해 주세요.',
  META_REQUEST_COOLDOWN:
    'Meta 토큰 요청 간격이 남아 있습니다. "다음 토큰 확인·갱신까지" 시간이 지난 뒤 다시 시도해 주세요.',
  ACCOUNT_BUSY:
    '휴대폰에서 이 계정으로 등록 중인 글이 있습니다. 등록이 끝난 뒤 다시 시도해 주세요.',
  DUPLICATE_ACCOUNT: '이미 등록된 Threads 계정입니다. 같은 계정은 한 번만 등록할 수 있습니다.',
  SAME_TOKEN:
    '지금 저장된 토큰과 같습니다. 토큰 확인이 필요한 계정이면 토큰 확인 칸의 [재확인]을 눌러 주세요.',
  ACCOUNT_MISMATCH: '이 계정에 등록된 Threads 계정과 다른 계정의 토큰입니다.',
  ACCOUNT_IDENTITY_MISMATCH: '이 계정에 등록된 Threads 계정과 다른 계정의 토큰입니다.',
  ALREADY_REGISTERED: '이미 다른 곳에 등록된 Threads 계정입니다. 관리자에게 확인해 주세요.',
  TOKEN_CHECK_FAILED: '토큰을 확인하지 못했습니다. 서버의 계정 정보는 바뀌지 않았습니다.',
  TOKEN_CHECK_FAILED_SAVED: '토큰을 확인하지 못해 "확인 필요"로 저장했습니다.',
  TOKEN_REFRESH_FAILED: '토큰을 갱신하지 못했습니다. 서버의 토큰은 바뀌지 않았습니다.',
  TOKEN_REFRESH_UNSAVED:
    '갱신한 토큰을 이 PC에 저장하지 못했고 서버 저장도 확인하지 못해 새 토큰이 사라졌을 수 있습니다. 서버에는 기존 토큰이 그대로 있으니, 요청 간격이 지난 뒤 [갱신]을 다시 눌러 주세요. 그래도 안 되면 토큰을 교체해 주세요.',
  REFRESH_PENDING_LOCKED:
    '갱신한 새 토큰이 아직 서버에 반영되지 않았습니다. [갱신 재시도]를 먼저 눌러 주세요.',
  RESEND_SERVER_CHANGED:
    '서버에 보내지 못한 사이 서버의 토큰이 바뀌어, 이 PC의 변경 대신 서버의 토큰을 사용합니다.',
  RESEND_ACCOUNT_MISSING: '서버 목록에서 이 계정을 찾을 수 없어 이 PC에 남은 변경을 정리했습니다.',
  RESEND_LEGACY_DROPPED:
    '예전 버전에서 남은 등록 입력이라 서버에 보낼 수 없어 정리했습니다. 필요하면 계정을 다시 추가해 주세요.',
  PENDING_CHANGE: '서버에 반영하지 못한 갱신이 있습니다. [갱신 재시도]를 먼저 눌러 주세요.',
  REFRESH_NOT_AVAILABLE: '확인됨 상태이고 만료가 가까운(만료 전) 계정만 갱신할 수 있습니다.',
};
const sameName = (a: string, b: string) =>
  a.normalize('NFKC').trim().toLowerCase() === b.normalize('NFKC').trim().toLowerCase();
/**
 * One Meta app holds one Threads account, so a token, app name or account name that another of
 * this employee's accounts already uses is refused before any Meta request spends the interval.
 * A different token of an already registered account is still caught after Meta by its user ID.
 */
function duplicateProblem(
  records: ManagedThreadsRecord[],
  candidate: { token?: string; appName?: string; label?: string },
  except?: ManagedThreadsRecord,
): string | null {
  const others = records.filter((r) => r !== except && !r.missing);
  const owner = (r: ManagedThreadsRecord) => `${r.appName} · ${r.label}`;
  const { token, appName, label } = candidate;
  const byToken =
    token && others.find((r) => r.syncedToken === token || r.pending?.token === token);
  if (byToken)
    return `이미 등록된 토큰입니다(${owner(byToken)}). 같은 계정은 한 번만 등록할 수 있습니다.`;
  const byApp = appName && others.find((r) => sameName(r.appName, appName));
  if (byApp)
    return `같은 Meta 앱 이름의 계정이 이미 있습니다(${owner(byApp)}). Meta 앱 하나에는 Threads 계정 하나만 등록합니다.`;
  const byLabel = label && others.find((r) => sameName(r.label, label));
  if (byLabel) return `같은 Threads 계정 이름이 이미 등록되어 있습니다(${owner(byLabel)}).`;
  return null;
}
function rows(
  records: ManagedThreadsRecord[],
  checks: Map<string, ManagedThreadsTokenCheck>,
): ManagedThreadsAccountRow[] {
  return records.map((r) => ({
    localId: r.localId,
    label: r.label,
    registrationId: r.registrationId,
    appName: r.appName,
    appId: r.appId,
    account: r.account,
    localRevision:
      r.syncedRevision === undefined ? (r.account?.tokenRevision ?? null) : r.syncedRevision,
    localState: r.missing ? 'missing' : r.conflict ? 'conflict' : r.pending ? 'pending' : 'synced',
    pendingAction: r.pending?.action ?? null,
    pendingReason: r.pending?.reason ?? null,
    pendingDeletion: r.pendingDeletion !== null,
    lastCheck: checks.get(r.localId) ?? null,
  }));
}
function accountFrom(value: unknown, owner: string): ManagedThreadsAccount {
  try {
    return parseManagedAccount(value, owner);
  } catch {
    return fail('INVALID_RESPONSE');
  }
}
function objectInput(value: unknown, keys: string[]): Record<string, unknown> {
  if (!isObject(value) || !exactKeys(value, keys)) return fail('VALIDATION_FAILED');
  return value;
}

/** Main-only synchronization. A read only downloads credentials; pending changes require an explicit action. */
export class ManagedThreadsManager {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly revocationChecks = new Map<string, Promise<void>>();
  private readonly meta: ManagedThreadsOptions['meta'];
  private readonly log: ManagedThreadsOptions['log'];
  private readonly now: () => number;
  private readonly refreshWindowDays: number;
  /** Local clock deadline of the server's per-employee Meta request interval. */
  private metaGate: { ownerId: string; availableAt: number } | null = null;
  constructor(
    private readonly client: Client,
    private readonly store: Store,
    private readonly serviceScope: string,
    options: ManagedThreadsOptions,
  ) {
    this.meta = options.meta;
    this.log = options.log;
    this.now = options.now ?? Date.now;
    this.refreshWindowDays = options.refreshWindowDays ?? DEFAULT_REFRESH_WINDOW_DAYS;
  }
  private noteRetryAfter(context: ServiceBusinessContext, seconds: unknown): void {
    if (!Number.isSafeInteger(seconds) || (seconds as number) < 0 || (seconds as number) > 86_400)
      fail('INVALID_RESPONSE');
    this.metaGate = {
      ownerId: context.ownerId,
      availableAt: this.now() + (seconds as number) * 1000,
    };
  }
  private retryAfter(ownerId: string | undefined): number {
    if (!ownerId || this.metaGate?.ownerId !== ownerId) return 0;
    return Math.max(0, Math.ceil((this.metaGate.availableAt - this.now()) / 1000));
  }
  private async rows(ownerId: string, records: ManagedThreadsRecord[]) {
    let checks = new Map<string, ManagedThreadsTokenCheck>();
    try {
      checks = await this.log.latest(ownerId);
    } catch {
      // An unreadable check log only hides the last check result.
    }
    return rows(records, checks);
  }
  private run(
    work: (context: ServiceBusinessContext, records: ManagedThreadsRecord[]) => Promise<void>,
  ): Promise<ManagedThreadsResult> {
    const contextAtInvocation = this.client.getBusinessContext().then(
      (context) => ({ context, error: undefined }),
      (error: unknown) => ({ context: undefined, error }),
    );
    const task = async (): Promise<ManagedThreadsResult> => {
      let context: ServiceBusinessContext | undefined;
      try {
        const captured = await contextAtInvocation;
        if (!captured.context) throw captured.error;
        context = captured.context;
        this.client.assertBusinessContext(context);
        const records = await this.store.read(this.serviceScope, context.ownerId);
        this.client.assertBusinessContext(context);
        await work(context, records);
        this.client.assertBusinessContext(context);
        return {
          status: 'ok',
          accounts: await this.rows(context.ownerId, records),
          problem: null,
          metaRequestRetryAfterSeconds: this.retryAfter(context.ownerId),
          refreshWindowDays: this.refreshWindowDays,
        };
      } catch (error) {
        let code =
          error instanceof ManagedProblem ||
          error instanceof ServiceApiError ||
          error instanceof ManagedThreadsStorageError
            ? error.code
            : 'SERVICE_UNAVAILABLE';
        let detail = error instanceof ManagedProblem ? error.detail : undefined;
        let accounts: ManagedThreadsAccountRow[] = [];
        if (context) {
          try {
            this.client.assertBusinessContext(context);
            const stored = await this.store.read(this.serviceScope, context.ownerId);
            this.client.assertBusinessContext(context);
            accounts = await this.rows(context.ownerId, stored);
          } catch (readError) {
            accounts = [];
            if (readError instanceof ServiceApiError) {
              code = readError.code;
              detail = undefined;
            }
          }
        }
        const known = Object.hasOwn(messages, code);
        return {
          status: 'error',
          accounts,
          problem: {
            code: known ? code : 'SERVICE_UNAVAILABLE',
            message: known ? (detail ?? messages[code]) : messages.SERVICE_UNAVAILABLE,
          },
          metaRequestRetryAfterSeconds: this.retryAfter(context?.ownerId),
          refreshWindowDays: this.refreshWindowDays,
        };
      }
    };
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
  private async save(
    context: ServiceBusinessContext,
    records: ManagedThreadsRecord[],
  ): Promise<void> {
    this.client.assertBusinessContext(context);
    await this.store.write(this.serviceScope, context.ownerId, records);
    this.client.assertBusinessContext(context);
  }
  private async listAndPurgeDeleted(
    context: ServiceBusinessContext,
    records: ManagedThreadsRecord[],
  ): Promise<ManagedThreadsAccount[]> {
    const value = await this.client.managedThreadsRequest(context, 'list');
    if (
      !isObject(value) ||
      !Array.isArray(value.accounts) ||
      value.accounts.length > 2000 ||
      !Array.isArray(value.deletedAccounts) ||
      value.deletedAccounts.length > 100000
    )
      fail('INVALID_RESPONSE');
    // Absent until the server database has the request interval table; then no wait applies.
    const metaRequest = (value as Record<string, unknown>).metaRequest;
    if (metaRequest !== undefined && !isObject(metaRequest)) fail('INVALID_RESPONSE');
    this.noteRetryAfter(context, isObject(metaRequest) ? metaRequest.retryAfterSeconds : 0);
    let deleted: ReturnType<typeof parseDeletedManagedAccount>[];
    try {
      deleted = (value as { deletedAccounts: unknown[] }).deletedAccounts.map(
        parseDeletedManagedAccount,
      );
    } catch {
      return fail('INVALID_RESPONSE');
    }
    const revokedGrants = deleted;
    if (new Set(revokedGrants.map((d) => d.registrationId)).size !== revokedGrants.length)
      fail('INVALID_RESPONSE');
    for (const record of records)
      if (
        record.account &&
        revokedGrants.some(
          (d) =>
            d.id === record.account!.id &&
            d.registrationId !== record.registrationId &&
            (d.ownershipVersion ?? 1) === (record.account!.ownershipVersion ?? 1),
        )
      )
        fail('INVALID_RESPONSE');
    const accounts = (value as { accounts: unknown[] }).accounts.map((a) =>
      accountFrom(a, context.ownerId),
    );
    if (
      new Set(accounts.map((a) => a.id)).size !== accounts.length ||
      new Set(accounts.map((a) => a.registrationId)).size !== accounts.length
    )
      fail('INVALID_RESPONSE');
    const isRevoked = (registrationId: string, account: ManagedThreadsAccount | null) =>
      revokedGrants.some((d) => {
        if (d.registrationId !== registrationId) return false;
        if (
          account &&
          (d.id !== account.id ||
            (d.ownershipVersion !== undefined &&
              d.ownershipVersion !== (account.ownershipVersion ?? 1)))
        )
          fail('INVALID_RESPONSE');
        return true;
      });
    if (accounts.some((a) => isRevoked(a.registrationId, a))) fail('INVALID_RESPONSE');
    // Erase only the explicitly deleted registration generation.
    const retained = records.filter((r) => !isRevoked(r.registrationId, r.account));
    if (retained.length !== records.length) {
      try {
        await this.save(context, retained);
      } catch (error) {
        if (error instanceof ServiceApiError) throw error;
        return fail('LOCAL_DELETE_SYNC_PENDING');
      }
      records.splice(0, records.length, ...retained);
    }
    return accounts;
  }
  private async refresh(
    context: ServiceBusinessContext,
    records: ManagedThreadsRecord[],
  ): Promise<void> {
    const accounts = await this.listAndPurgeDeleted(context, records);
    const fresh: {
      account: ManagedThreadsAccount;
      token: string | null;
      syncedRevision: number | null;
    }[] = [];
    for (const account of accounts) {
      const cached = records.find(
        (r) =>
          r.legacyAppId === null &&
          (r.registrationId === account.registrationId || r.account?.id === account.id),
      );
      if (
        cached?.account &&
        (cached.account.id !== account.id ||
          cached.registrationId !== account.registrationId ||
          account.tokenRevision < cached.account.tokenRevision)
      )
        fail('INVALID_RESPONSE');
      if (
        cached?.account &&
        cached.syncedToken &&
        !cached.pending &&
        account.tokenRevision ===
          (cached.syncedRevision === undefined
            ? cached.account.tokenRevision
            : cached.syncedRevision)
      ) {
        fresh.push({ account, token: cached.syncedToken, syncedRevision: account.tokenRevision });
        continue;
      }
      const credential = await this.client.managedThreadsRequest(context, 'credential', account.id);
      if (!isObject(credential) || !validToken(credential.token)) fail('INVALID_RESPONSE');
      const data = credential as { account: unknown; token: string };
      const current = accountFrom(data.account, context.ownerId);
      if (
        current.id !== account.id ||
        current.registrationId !== account.registrationId ||
        current.tokenRevision < account.tokenRevision
      )
        fail('INVALID_RESPONSE');
      fresh.push({ account: current, token: data.token, syncedRevision: current.tokenRevision });
    }
    const updated = structuredClone(records);
    for (const record of updated)
      record.missing = !!record.account && !fresh.some((f) => f.account.id === record.account!.id);
    for (const { account, token, syncedRevision } of fresh) {
      let record = updated.find(
        (r) =>
          r.legacyAppId === null &&
          (r.registrationId === account.registrationId || r.account?.id === account.id),
      );
      if (!record) {
        const legacy = updated.find(
          (r) => r.legacyAppId !== null && r.legacyAppId === account.appId,
        );
        if (legacy?.pending?.action === 'create' && legacy.pending.token === token) {
          legacy.registrationId = account.registrationId;
          legacy.legacyAppId = null;
          record = legacy;
        } else if (legacy) legacy.conflict = true;
      }
      if (!record) {
        record = {
          localId: randomUUID(),
          label: account.label,
          registrationId: account.registrationId,
          appName: account.appName,
          appId: account.appId,
          legacyAppId: null,
          account,
          syncedToken: token,
          syncedRevision,
          pending: null,
          pendingDeletion: null,
          conflict: false,
          missing: false,
        };
        updated.push(record);
      } else {
        if (
          record.account &&
          (record.account.id !== account.id ||
            record.registrationId !== account.registrationId ||
            account.tokenRevision < record.account.tokenRevision ||
            (account.tokenRevision ===
              (record.syncedRevision === undefined
                ? record.account.tokenRevision
                : record.syncedRevision) &&
              record.syncedToken !== null &&
              token !== null &&
              record.syncedToken !== token))
        )
          fail('INVALID_RESPONSE');
        const pending = record.pending;
        if (pending) {
          // A checked token must also have reached the server as checked, with the same expiry.
          const confirmed =
            token === pending.token &&
            (pending.action === 'create' || account.tokenRevision > pending.expectedRevision!) &&
            (!pending.verification ||
              (account.validationStatus === 'reported_valid' &&
                account.expiresAt === pending.verification.expiresAt));
          if (confirmed) {
            record.pending = null;
            record.conflict = false;
          } else
            record.conflict =
              pending.action === 'create' || account.tokenRevision !== pending.expectedRevision;
        } else record.conflict = false;
        record.label = account.label;
        record.appName = account.appName;
        record.appId = account.appId;
        record.account = account;
        record.syncedToken = token;
        record.syncedRevision = syncedRevision;
        record.missing = false;
        if (
          record.pendingDeletion &&
          (record.pendingDeletion.expectedRevision !== account.tokenRevision ||
            (record.pendingDeletion.expectedLifecycleVersion ?? 1) !==
              (account.lifecycleVersion ?? 1) ||
            (record.pendingDeletion.expectedOwnershipVersion ?? 1) !==
              (account.ownershipVersion ?? 1))
        )
          record.pendingDeletion = null; // Any changed credential, state or ownership generation requires fresh confirmation.
      }
    }
    for (const record of updated) if (record.legacyAppId !== null) record.conflict = true;
    await this.save(context, updated);
    records.splice(0, records.length, ...updated);
  }
  private async send(
    context: ServiceBusinessContext,
    records: ManagedThreadsRecord[],
    record: ManagedThreadsRecord,
  ): Promise<void> {
    if (record.pendingDeletion) fail('DELETION_PENDING');
    const pending = record.pending;
    if (!pending) return;
    if (
      pending.action === 'replace' &&
      ((pending.expectedOwnershipVersion ?? 1) !== (record.account!.ownershipVersion ?? 1) ||
        (pending.expectedLifecycleVersion ?? 1) !== (record.account!.lifecycleVersion ?? 1))
    )
      fail('LIFECYCLE_CONFLICT');
    if (record.legacyAppId !== null) fail('LEGACY_REGISTRATION_PENDING');
    if (record.conflict || record.missing) fail('STALE_CREDENTIAL');
    const checked = pending.verification ? { verification: pending.verification } : {};
    let value: unknown;
    try {
      value =
        pending.action === 'create'
          ? await this.client.managedThreadsRequest(context, 'create', undefined, {
              label: record.label,
              registrationId: record.registrationId,
              appName: record.appName,
              token: pending.token,
              ...checked,
            })
          : await this.client.managedThreadsRequest(context, 'replace', record.account!.id, {
              expectedRevision: pending.expectedRevision,
              token: pending.token,
              expectedOwnershipVersion: pending.expectedOwnershipVersion ?? 1,
              expectedLifecycleVersion: pending.expectedLifecycleVersion ?? 1,
              ...checked,
              ...(pending.reason ? { reason: pending.reason } : {}),
            });
    } catch (error) {
      if (
        error instanceof ServiceApiError &&
        ['ALREADY_REGISTERED', 'ACCOUNT_IDENTITY_MISMATCH'].includes(error.code)
      ) {
        // The server refuses this Threads account itself, so resending the same input cannot help.
        // ACCOUNT_BUSY is different: the pending input stays for an explicit retry.
        if (pending.action === 'create') {
          const index = records.indexOf(record);
          if (index >= 0) records.splice(index, 1);
        } else {
          record.pending = null;
          record.conflict = false;
        }
        await this.save(context, records);
        fail(error.code);
      }
      throw error;
    }
    if (!isObject(value)) fail('INVALID_RESPONSE');
    const account = accountFrom((value as Record<string, unknown>).account, context.ownerId);
    if (
      account.registrationId !== record.registrationId ||
      (pending.action === 'create'
        ? account.label !== record.label || account.appName !== record.appName
        : account.id !== record.account!.id ||
          account.tokenRevision !== pending.expectedRevision! + 1)
    )
      fail('INVALID_RESPONSE');
    if (pending.action === 'create' && account.tokenRevision > 1) {
      // An idempotent retry may race a mobile refresh. Never associate the old submitted token
      // with a newer revision; fetch the canonical credential and reconcile the pending input.
      await this.refresh(context, records);
      const current = records.find((r) => r.localId === record.localId);
      if (!current || current.pending) fail('STALE_CREDENTIAL');
      return;
    }
    record.account = account;
    record.label = account.label;
    record.appName = account.appName;
    record.appId = account.appId;
    record.syncedToken = pending.token;
    record.syncedRevision = account.tokenRevision;
    record.pending = null;
    record.conflict = false;
    try {
      await this.save(context, records);
    } catch (error) {
      if (error instanceof ServiceApiError) throw error;
      fail('LOCAL_SYNC_PENDING');
    }
  }
  /**
   * Every Meta token request shares one server-enforced interval per employee: the caller has just
   * synchronized, so a remaining interval refuses before any reservation or Meta request.
   */
  private async requestMeta<T>(
    context: ServiceBusinessContext,
    records: ManagedThreadsRecord[],
    accountId: string | null,
    request: () => Promise<T>,
  ): Promise<Checked<T>> {
    if (this.retryAfter(context.ownerId) > 0) fail('META_REQUEST_COOLDOWN');
    let reserved: unknown;
    try {
      reserved = await this.client.managedThreadsRequest(
        context,
        'meta-reserve',
        undefined,
        accountId ? { accountId } : {},
      );
    } catch (error) {
      // Another PC of this employee reserved first; read the interval for the button countdown.
      if (error instanceof ServiceApiError && error.code === 'META_REQUEST_COOLDOWN')
        await this.listAndPurgeDeleted(context, records).catch(() => undefined);
      throw error;
    }
    const reservation =
      isObject(reserved) && isObject(reserved.reservation) ? reserved.reservation : null;
    if (!reservation || !validId(reservation.id)) return fail('INVALID_RESPONSE');
    this.noteRetryAfter(context, reservation.retryAfterSeconds);
    try {
      return { value: await request() };
    } catch (error) {
      const failure: MetaTokenFailure =
        error instanceof MetaTokenError
          ? error.failure
          : {
              outcome: 'network',
              detail: null,
              httpStatus: null,
              metaCode: null,
              metaSubcode: null,
              metaType: null,
              metaMessage: null,
              fbtraceId: null,
              networkCode: null,
            };
      // Success keeps the full interval and needs no report.
      if (failure.outcome === 'invalid_token' || failure.outcome === 'not_sent')
        try {
          const reported = await this.client.managedThreadsRequest(
            context,
            'meta-outcome',
            reservation.id,
            { outcome: failure.outcome },
          );
          if (isObject(reported)) this.noteRetryAfter(context, reported.retryAfterSeconds);
        } catch {
          // Best effort: an unreported outcome only keeps the longer interval.
        }
      return { failure };
    }
  }
  /** Plaintext troubleshooting record without the token; its failure never blocks the action. */
  private async logCheck(
    context: ServiceBusinessContext,
    target: {
      localId: string;
      account: ManagedThreadsAccount | null;
      appName: string;
      label: string;
    },
    operation: ManagedThreadsTokenOperation,
    result: ManagedThreadsTokenCheck['result'],
    facts: { expiresAt?: string; failure?: MetaTokenFailure },
  ): Promise<void> {
    const failure = facts.failure;
    await this.log
      .append({
        at: new Date(this.now()).toISOString(),
        ownerId: context.ownerId,
        operation,
        localId: target.localId,
        accountId: target.account?.id ?? null,
        appName: target.appName,
        label: target.label,
        result,
        expiresAt: facts.expiresAt ?? null,
        detail: failure?.detail ?? null,
        httpStatus: failure?.httpStatus ?? null,
        metaCode: failure?.metaCode ?? null,
        metaSubcode: failure?.metaSubcode ?? null,
        metaType: failure?.metaType ?? null,
        metaMessage: failure?.metaMessage ?? null,
        fbtraceId: failure?.fbtraceId ?? null,
        networkCode: failure?.networkCode ?? null,
      })
      .catch(() => undefined);
  }
  /** Meta's user ID identifies the Threads account (per Meta app); a name never does. */
  private async checkIdentity(
    context: ServiceBusinessContext,
    records: ManagedThreadsRecord[],
    target: ManagedThreadsRecord,
    operation: ManagedThreadsTokenOperation,
    checked: { userId: string; expiresAt: string },
  ): Promise<void> {
    const known = target.account?.threadsUserId;
    const other = records.find(
      (r) =>
        r !== target &&
        (r.account?.threadsUserId === checked.userId ||
          r.pending?.verification?.threadsUserId === checked.userId),
    );
    const result = known && known !== checked.userId ? 'mismatch' : other ? 'duplicate' : 'success';
    await this.logCheck(context, target, operation, result, { expiresAt: checked.expiresAt });
    if (result === 'mismatch') fail('ACCOUNT_MISMATCH');
    if (other)
      fail(
        'DUPLICATE_ACCOUNT',
        `이미 등록된 Threads 계정입니다(${other.appName} · ${other.label}). 같은 계정은 한 번만 등록할 수 있습니다.`,
      );
  }
  private syncedTarget(records: ManagedThreadsRecord[], accountId: unknown): Synced {
    const target = records.find((r) => r.account?.id === accountId);
    if (!target?.account || target.missing || !target.syncedToken) return fail('NOT_FOUND');
    if (target.pendingDeletion) fail('DELETION_PENDING');
    if (target.pending || target.conflict) fail('PENDING_CHANGE');
    return target as Synced;
  }
  private replacement(
    account: ManagedThreadsAccount,
    token: string,
    reason: NonNullable<Pending['reason']>,
    verification?: Pending['verification'],
  ): Pending {
    return {
      action: 'replace',
      token,
      expectedRevision: account.tokenRevision,
      expectedOwnershipVersion: account.ownershipVersion ?? 1,
      expectedLifecycleVersion: account.lifecycleVersion ?? 1,
      ...(verification ? { verification } : {}),
      reason,
    };
  }
  getAccounts(): Promise<ManagedThreadsResult> {
    return this.run(async (context, records) => {
      await this.refresh(context, records);
    });
  }
  /** Main-only auth follow-up: no credential downloads, mutation replay, or renderer result. */
  reconcileDeletedAccounts(ownerId: string, authGeneration: number): Promise<void> {
    const key = JSON.stringify([ownerId, authGeneration]);
    const existing = this.revocationChecks.get(key);
    if (existing) return existing;
    const check = this.run(async (context, records) => {
      if (context.ownerId !== ownerId) fail('AUTH_CHANGED');
      await this.listAndPurgeDeleted(context, records);
    })
      .then(() => undefined)
      .finally(() => {
        if (this.revocationChecks.get(key) === check) this.revocationChecks.delete(key);
      });
    this.revocationChecks.set(key, check);
    return check;
  }
  /**
   * The token is checked with Meta, then the account is stored on the server first; this PC keeps
   * it only once the server has it, so a failed send leaves nothing behind. A failed check still
   * registers the account as unverified so the row can offer [재확인] with the same token.
   */
  register(input: unknown): Promise<ManagedThreadsResult> {
    return this.run(async (context, records) => {
      const data = objectInput(input, ['label', 'appName', 'token']);
      if (!validLabel(data.label) || !validLabel(data.appName) || !validToken(data.token))
        fail('VALIDATION_FAILED');
      const token = data.token as string;
      const record: ManagedThreadsRecord = {
        localId: randomUUID(),
        label: (data.label as string).trim(),
        registrationId: randomUUID(),
        appName: (data.appName as string).trim(),
        appId: null,
        legacyAppId: null,
        account: null,
        syncedToken: null,
        pending: { action: 'create', token, expectedRevision: null },
        pendingDeletion: null,
        conflict: false,
        missing: false,
      };
      await this.refresh(context, records);
      const duplicate = duplicateProblem(records, {
        token,
        appName: record.appName,
        label: record.label,
      });
      if (duplicate) fail('DUPLICATE_ACCOUNT', duplicate);
      const checked = await this.requestMeta(context, records, null, () =>
        this.meta.debugToken(token),
      );
      if (checked.failure)
        await this.logCheck(context, record, 'register', checked.failure.outcome, checked);
      else {
        await this.checkIdentity(context, records, record, 'register', checked.value);
        record.pending = {
          action: 'create',
          token,
          expectedRevision: null,
          verification: { threadsUserId: checked.value.userId, expiresAt: checked.value.expiresAt },
        };
      }
      records.push(record);
      await this.send(context, records, record);
      if (checked.failure)
        fail(
          'TOKEN_CHECK_FAILED_SAVED',
          `토큰을 확인하지 못해 계정을 "확인 필요"로 저장했습니다. ${metaTokenFailureSummary(checked.failure)}`,
        );
    });
  }
  /**
   * Server first, like a registration: this PC takes the new token only once the server has it.
   * A failed check of a verified account's new token leaves the server and its working token as
   * they are; an unverified account stores the new token as unverified.
   */
  replace(input: unknown): Promise<ManagedThreadsResult> {
    return this.run(async (context, records) => {
      const data = objectInput(input, ['accountId', 'expectedRevision', 'token']);
      if (
        !validId(data.accountId) ||
        !validRevision(data.expectedRevision) ||
        data.expectedRevision >= 2147483647 ||
        !validToken(data.token)
      )
        fail('VALIDATION_FAILED');
      const token = data.token as string;
      await this.refresh(context, records);
      const record = records.find((r) => r.account?.id === data.accountId);
      if (!record?.account || record.missing) return fail('NOT_FOUND');
      const target = record as ManagedThreadsRecord & { account: ManagedThreadsAccount };
      if (target.pendingDeletion) fail('DELETION_PENDING');
      if (target.pending?.reason === 'refresh') fail('REFRESH_PENDING_LOCKED');
      if (target.account.tokenRevision !== data.expectedRevision) fail('STALE_CREDENTIAL');
      if (token === target.syncedToken) fail('SAME_TOKEN');
      const duplicate = duplicateProblem(records, { token }, target);
      if (duplicate) fail('DUPLICATE_ACCOUNT', duplicate);
      const checked = await this.requestMeta(context, records, target.account.id, () =>
        this.meta.debugToken(token),
      );
      if (checked.failure) {
        await this.logCheck(context, target, 'replace', checked.failure.outcome, checked);
        if (target.account.validationStatus === 'reported_valid')
          fail(
            'TOKEN_CHECK_FAILED',
            `새 토큰을 확인하지 못해 서버의 기존 토큰을 그대로 두었습니다. ${metaTokenFailureSummary(checked.failure)}`,
          );
        target.pending = this.replacement(target.account, token, 'replace');
      } else {
        await this.checkIdentity(context, records, target, 'replace', checked.value);
        target.pending = this.replacement(target.account, token, 'replace', {
          threadsUserId: checked.value.userId,
          expiresAt: checked.value.expiresAt,
        });
      }
      target.conflict = false;
      await this.send(context, records, target);
      if (checked.failure)
        fail(
          'TOKEN_CHECK_FAILED_SAVED',
          `새 토큰을 확인하지 못해 "확인 필요"로 저장했습니다. ${metaTokenFailureSummary(checked.failure)}`,
        );
    });
  }
  /** Checks the stored token again; only a successful check changes the server (revision + 1). Server first. */
  recheck(input: unknown): Promise<ManagedThreadsResult> {
    return this.run(async (context, records) => {
      const data = objectInput(input, ['accountId']);
      if (!validId(data.accountId)) fail('VALIDATION_FAILED');
      await this.refresh(context, records);
      const target = this.syncedTarget(records, data.accountId);
      const token = target.syncedToken;
      const checked = await this.requestMeta(context, records, target.account.id, () =>
        this.meta.debugToken(token),
      );
      if (checked.failure) {
        await this.logCheck(context, target, 'recheck', checked.failure.outcome, checked);
        return fail(
          'TOKEN_CHECK_FAILED',
          `토큰을 확인하지 못했습니다. 서버의 계정 상태는 바뀌지 않았습니다. ${metaTokenFailureSummary(checked.failure)}`,
        );
      }
      await this.checkIdentity(context, records, target, 'recheck', checked.value);
      target.pending = this.replacement(target.account, token, 'recheck', {
        threadsUserId: checked.value.userId,
        expiresAt: checked.value.expiresAt,
      });
      await this.send(context, records, target);
    });
  }
  /**
   * Manual refresh of one verified account close to expiry. Meta returns a new token only once, so
   * it is stored locally first and then sent; one of the two copies must survive. This is the only
   * change that can be left unsent, for [갱신 재시도].
   */
  refreshToken(input: unknown): Promise<ManagedThreadsResult> {
    return this.run(async (context, records) => {
      const data = objectInput(input, ['accountId']);
      if (!validId(data.accountId)) fail('VALIDATION_FAILED');
      await this.refresh(context, records);
      const target = this.syncedTarget(records, data.accountId);
      const account = target.account;
      const threadsUserId = account.threadsUserId;
      const expiresAt = account.expiresAt === null ? Number.NaN : Date.parse(account.expiresAt);
      const now = this.now();
      if (
        account.validationStatus !== 'reported_valid' ||
        !threadsUserId ||
        !(expiresAt > now && expiresAt <= now + this.refreshWindowDays * DAY_MS)
      )
        return fail(
          'REFRESH_NOT_AVAILABLE',
          `확인됨 상태이고 만료까지 ${this.refreshWindowDays}일 이내(만료 전)인 계정만 갱신할 수 있습니다.`,
        );
      const checked = await this.requestMeta(context, records, account.id, () =>
        this.meta.refreshToken(target.syncedToken),
      );
      if (checked.failure) {
        const { outcome } = checked.failure;
        await this.logCheck(context, target, 'refresh', outcome, checked);
        return fail(
          'TOKEN_REFRESH_FAILED',
          outcome === 'timeout' || outcome === 'network'
            ? `${metaTokenFailureSummary(checked.failure)} 서버의 토큰은 그대로입니다. 요청 간격이 지난 뒤 [갱신]을 다시 눌러 주세요. 그래도 안 되면 토큰을 교체해 주세요.`
            : `토큰을 갱신하지 못했습니다. 서버의 토큰은 그대로입니다. ${metaTokenFailureSummary(checked.failure)}`,
        );
      }
      await this.logCheck(context, target, 'refresh', 'success', {
        expiresAt: checked.value.expiresAt,
      });
      target.pending = this.replacement(account, checked.value.token, 'refresh', {
        threadsUserId,
        expiresAt: checked.value.expiresAt,
      });
      let saved = true;
      try {
        // Not bound to the login: this is the owner's only copy of the new token until it is sent.
        await this.store.write(this.serviceScope, context.ownerId, records);
      } catch {
        saved = false;
      }
      try {
        await this.send(context, records, target);
      } catch (error) {
        // send() clears the pending change only once the server has accepted the new token.
        if (!saved && target.pending) fail('TOKEN_REFRESH_UNSAVED');
        throw error;
      }
    });
  }
  /**
   * Names identify nothing for Meta, but stay unique among this employee's accounts. A rename is
   * idempotent, so it needs no pending record: a lost response shows the new names on the next
   * list sync. Token state stays untouched.
   */
  update(input: unknown): Promise<ManagedThreadsResult> {
    return this.run(async (context, records) => {
      const data = objectInput(input, ['accountId', 'label', 'appName']);
      if (!validId(data.accountId) || !validLabel(data.label) || !validLabel(data.appName))
        fail('VALIDATION_FAILED');
      const record = records.find((r) => r.account?.id === data.accountId);
      if (!record || record.missing) fail('NOT_FOUND');
      const target = record!;
      if (target.pendingDeletion) fail('DELETION_PENDING');
      const duplicate = duplicateProblem(
        records,
        { appName: data.appName as string, label: data.label as string },
        target,
      );
      if (duplicate) fail('DUPLICATE_ACCOUNT', duplicate);
      const value = await this.client.managedThreadsRequest(
        context,
        'profile',
        target.account!.id,
        {
          label: (data.label as string).trim(),
          appName: (data.appName as string).trim(),
          expectedLifecycleVersion: target.account!.lifecycleVersion ?? 1,
          expectedOwnershipVersion: target.account!.ownershipVersion ?? 1,
        },
      );
      if (!isObject(value)) fail('INVALID_RESPONSE');
      const account = accountFrom((value as Record<string, unknown>).account, context.ownerId);
      if (
        account.id !== target.account!.id ||
        account.registrationId !== target.registrationId ||
        account.tokenRevision !== target.account!.tokenRevision
      )
        fail('INVALID_RESPONSE');
      target.account = account;
      target.label = account.label;
      target.appName = account.appName;
      try {
        await this.save(context, records);
      } catch (error) {
        if (error instanceof ServiceApiError) throw error;
        fail('LOCAL_SYNC_PENDING');
      }
    });
  }
  retry(input: unknown): Promise<ManagedThreadsResult> {
    return this.run(async (context, records) => {
      const data = objectInput(input, ['localId']);
      if (!validId(data.localId)) fail('VALIDATION_FAILED');
      const existed = records.some((r) => r.localId === data.localId && r.pending);
      if (!existed) fail('NOT_FOUND');
      await this.refresh(context, records);
      const record = records.find((r) => r.localId === data.localId);
      if (!record) return; // A server tombstone has already removed this pending create.
      // One PC per employee, so the server moves on only through the old phone's refresh during
      // the transition, or loses the account. Such a change can never be sent: follow the server.
      if (record.pending && (record.conflict || record.missing)) {
        const code =
          record.legacyAppId !== null
            ? 'RESEND_LEGACY_DROPPED'
            : record.missing
              ? 'RESEND_ACCOUNT_MISSING'
              : 'RESEND_SERVER_CHANGED';
        await this.dropPending(context, records, record);
        fail(code);
      }
      await this.send(context, records, record);
    });
  }
  deleteAccount(input: unknown): Promise<ManagedThreadsResult> {
    return this.run(async (context, records) => {
      const data = objectInput(input, ['accountId', 'expectedRevision']);
      if (!validId(data.accountId) || !validRevision(data.expectedRevision))
        fail('VALIDATION_FAILED');
      const record = records.find((r) => r.account?.id === data.accountId);
      if (!record) fail('NOT_FOUND');
      if (record!.account!.tokenRevision !== data.expectedRevision) fail('DELETE_CONFLICT');
      const grant = record!.registrationId;
      const intent = record!.pendingDeletion ?? {
        expectedRevision: data.expectedRevision as number,
        expectedLifecycleVersion: record!.account!.lifecycleVersion ?? 1,
        expectedOwnershipVersion: record!.account!.ownershipVersion ?? 1,
      };
      const lifecycleVersion = intent.expectedLifecycleVersion ?? 1;
      const ownershipVersion = intent.expectedOwnershipVersion ?? 1;
      record!.pendingDeletion = intent;
      await this.save(context, records);
      await this.refresh(context, records);
      const current = records.find((r) => r.localId === record!.localId);
      if (!current) return; // The server already confirmed deletion, including a lost response.
      if (
        current.registrationId !== grant ||
        (current.account!.lifecycleVersion ?? 1) !== lifecycleVersion ||
        (current.account!.ownershipVersion ?? 1) !== ownershipVersion
      )
        fail('DELETE_CONFLICT');
      if (
        current.account!.tokenRevision !== intent.expectedRevision ||
        intent.expectedRevision !== data.expectedRevision
      )
        fail('DELETE_CONFLICT');
      let result: unknown;
      try {
        result = await this.client.managedThreadsRequest(context, 'delete', current.account!.id, {
          expectedRevision: intent.expectedRevision,
          abandonUnresolved: true,
          expectedOwnershipVersion: ownershipVersion,
          expectedLifecycleVersion: lifecycleVersion,
        });
      } catch (error) {
        if (
          error instanceof ServiceApiError &&
          ['REMOTE_CONFLICT', 'STALE_LIFECYCLE', 'OWNERSHIP_REVOKED'].includes(error.code)
        ) {
          current.pendingDeletion = null;
          await this.save(context, records);
          return fail('DELETE_CONFLICT');
        }
        throw error;
      }
      let deleted: ReturnType<typeof parseDeletedManagedAccount>;
      try {
        deleted = parseDeletedManagedAccount(isObject(result) ? result.deletedAccount : null);
      } catch {
        return fail('INVALID_RESPONSE');
      }
      if (deleted.id !== current.account!.id || deleted.registrationId !== current.registrationId)
        fail('INVALID_RESPONSE');
      const retained = records.filter((r) => r.localId !== current.localId);
      try {
        await this.save(context, retained);
      } catch (error) {
        if (error instanceof ServiceApiError) throw error;
        return fail('LOCAL_DELETE_SYNC_PENDING');
      }
      records.splice(0, records.length, ...retained);
    });
  }
  /** An unsent create disappears; an unsent replacement leaves the server's token in place. */
  private async dropPending(
    context: ServiceBusinessContext,
    records: ManagedThreadsRecord[],
    record: ManagedThreadsRecord,
  ): Promise<void> {
    if (!record.account) records.splice(records.indexOf(record), 1);
    else {
      record.pending = null;
      record.conflict = false;
    }
    await this.save(context, records);
  }
}
