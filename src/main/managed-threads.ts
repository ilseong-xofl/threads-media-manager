import { randomUUID } from 'node:crypto';
import type {
  ManagedThreadsAccount,
  ManagedThreadsAccountRow,
  ManagedThreadsResult,
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

type Client = Pick<
  ServiceApiClient,
  'getBusinessContext' | 'assertBusinessContext' | 'managedThreadsRequest'
>;
type Store = Pick<EncryptedManagedThreadsStore, 'read' | 'write'>;
class ManagedProblem extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const fail = (code: string): never => {
  throw new ManagedProblem(code);
};
const messages: Record<string, string> = {
  STALE_LIFECYCLE: '계정 상태나 담당자가 변경되었습니다. 최신 상태에서 다시 선택해 주세요.',
  OWNERSHIP_REVOKED: '이 계정의 담당자가 변경되었습니다. 서버와 동기화해 주세요.',
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
  ACCOUNT_REMOVED: '삭제된 계정입니다. 서버와 동기화하여 이 PC의 사본을 정리해 주세요.',
  DELETION_PENDING: '계정 삭제가 대기 중입니다. 서버와 동기화하거나 삭제를 다시 시도해 주세요.',
  DELETE_CONFLICT:
    '토큰 정보가 변경되었습니다. 최신 목록을 확인한 뒤 계정 삭제를 다시 선택해 주세요.',
  LOCAL_DELETE_SYNC_PENDING:
    '서버에서 계정을 삭제했지만 이 PC의 사본을 정리하지 못했습니다. 서버와 다시 동기화해 주세요.',
  STORAGE_UNAVAILABLE: '운영체제 보안 저장소를 사용할 수 없습니다.',
  STORAGE_CORRUPT: '계정 보관 파일을 읽을 수 없습니다. 기존 파일은 보존했습니다.',
  STORAGE_WRITE_FAILED: '계정 정보를 안전하게 저장하지 못했습니다. 다시 시도해 주세요.',
  LOCAL_SYNC_PENDING:
    '서버에는 반영되었지만 로컬 저장을 완료하지 못했습니다. 목록을 새로고침해 주세요.',
};
function rows(records: ManagedThreadsRecord[]): ManagedThreadsAccountRow[] {
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
    pendingDeletion: r.pendingDeletion !== null,
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
  constructor(
    private readonly client: Client,
    private readonly store: Store,
    private readonly serviceScope: string,
  ) {}
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
          accounts: rows(records),
          problem: null,
        };
      } catch (error) {
        let code =
          error instanceof ManagedProblem ||
          error instanceof ServiceApiError ||
          error instanceof ManagedThreadsStorageError
            ? error.code
            : 'SERVICE_UNAVAILABLE';
        let accounts: ManagedThreadsAccountRow[] = [];
        if (context) {
          try {
            this.client.assertBusinessContext(context);
            accounts = rows(await this.store.read(this.serviceScope, context.ownerId));
            this.client.assertBusinessContext(context);
          } catch (readError) {
            accounts = [];
            if (readError instanceof ServiceApiError) code = readError.code;
          }
        }
        return {
          status: 'error',
          accounts,
          problem: {
            code: Object.hasOwn(messages, code) ? code : 'SERVICE_UNAVAILABLE',
            message: messages[code] ?? messages.SERVICE_UNAVAILABLE,
          },
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
          const confirmed =
            token === pending.token &&
            (pending.action === 'create' || account.tokenRevision > pending.expectedRevision!);
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
    const value =
      pending.action === 'create'
        ? await this.client.managedThreadsRequest(context, 'create', undefined, {
            label: record.label,
            registrationId: record.registrationId,
            appName: record.appName,
            token: pending.token,
          })
        : await this.client.managedThreadsRequest(context, 'replace', record.account!.id, {
            expectedRevision: pending.expectedRevision,
            token: pending.token,
            expectedOwnershipVersion: pending.expectedOwnershipVersion ?? 1,
            expectedLifecycleVersion: pending.expectedLifecycleVersion ?? 1,
          });
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
  register(input: unknown): Promise<ManagedThreadsResult> {
    return this.run(async (context, records) => {
      const data = objectInput(input, ['label', 'appName', 'token']);
      if (!validLabel(data.label) || !validLabel(data.appName) || !validToken(data.token))
        fail('VALIDATION_FAILED');
      const record: ManagedThreadsRecord = {
        localId: randomUUID(),
        label: (data.label as string).trim(),
        registrationId: randomUUID(),
        appName: (data.appName as string).trim(),
        appId: null,
        legacyAppId: null,
        account: null,
        syncedToken: null,
        pending: { action: 'create', token: data.token as string, expectedRevision: null },
        pendingDeletion: null,
        conflict: false,
        missing: false,
      };
      records.push(record);
      await this.save(context, records);
      await this.refresh(context, records);
      const current = records.find((r) => r.localId === record.localId);
      if (!current) fail('ACCOUNT_REMOVED');
      await this.send(context, records, current!);
    });
  }
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
      const record = records.find((r) => r.account?.id === data.accountId);
      if (!record || record.missing) fail('NOT_FOUND');
      const target = record!;
      if (target.pendingDeletion) fail('DELETION_PENDING');
      if (target.account!.tokenRevision !== data.expectedRevision) fail('STALE_CREDENTIAL');
      target.pending = {
        action: 'replace',
        token: data.token as string,
        expectedRevision: data.expectedRevision as number,
        expectedOwnershipVersion: target.account!.ownershipVersion ?? 1,
        expectedLifecycleVersion: target.account!.lifecycleVersion ?? 1,
      };
      target.conflict = false;
      await this.save(context, records);
      await this.refresh(context, records);
      const current = records.find((r) => r.localId === target.localId);
      if (!current) fail('ACCOUNT_REMOVED');
      await this.send(context, records, current!);
    });
  }
  /**
   * Names are display labels only. A rename is idempotent, so it needs no pending record: a lost
   * response shows the new names on the next list sync. Token state stays untouched.
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
  discardPending(input: unknown): Promise<ManagedThreadsResult> {
    return this.run(async (context, records) => {
      const data = objectInput(input, ['localId']);
      if (!validId(data.localId)) fail('VALIDATION_FAILED');
      await this.refresh(context, records);
      const index = records.findIndex((r) => r.localId === data.localId);
      if (index < 0) fail('NOT_FOUND');
      const record = records[index];
      if (record.pendingDeletion) fail('DELETION_PENDING');
      if (!record.account) records.splice(index, 1);
      else {
        record.pending = null;
        record.conflict = false;
      }
      await this.save(context, records);
    });
  }
}
