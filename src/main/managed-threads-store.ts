import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  DeletedManagedThreadsAccount,
  ManagedThreadsAccount,
} from '../shared/managed-threads';
import type { TokenCipher } from './auth-token-store';

export const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
export const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
export const validToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[\x21-\x7e]{1,8192}$/.test(value);
export const validAppId = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{1,40}$/.test(value);
export const validLabel = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 80;
export const validRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2147483647;
export const validDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

export function parseManagedAccount(value: unknown, ownerId: string): ManagedThreadsAccount {
  if (
    !isObject(value) ||
    !validId(value.id) ||
    value.ownerId !== ownerId ||
    !validLabel(value.label) ||
    !validId(value.registrationId) ||
    !validLabel(value.appName) ||
    !(value.appId === null || validAppId(value.appId)) ||
    !(value.threadsUserId === null || validAppId(value.threadsUserId)) ||
    !['pending_validation', 'reported_valid', 'invalid'].includes(String(value.validationStatus)) ||
    typeof value.appIdVerified !== 'boolean' ||
    !validRevision(value.tokenRevision) ||
    !(value.expiresAt === null || validDate(value.expiresAt)) ||
    (value.lifecycleVersion !== undefined && !validRevision(value.lifecycleVersion)) ||
    (value.ownershipVersion !== undefined && !validRevision(value.ownershipVersion)) ||
    !validDate(value.createdAt)
  )
    throw new Error('INVALID_RESPONSE');
  return {
    id: value.id,
    ownerId,
    label: value.label,
    registrationId: value.registrationId,
    appName: value.appName,
    appId: value.appId as string | null,
    threadsUserId: value.threadsUserId as string | null,
    validationStatus: value.validationStatus as ManagedThreadsAccount['validationStatus'],
    appIdVerified: value.appIdVerified,
    tokenRevision: value.tokenRevision,
    expiresAt: value.expiresAt as string | null,
    createdAt: value.createdAt,
    ...(value.lifecycleVersion === undefined
      ? {}
      : { lifecycleVersion: value.lifecycleVersion as number }),
    ...(value.ownershipVersion === undefined
      ? {}
      : { ownershipVersion: value.ownershipVersion as number }),
  };
}
export function parseDeletedManagedAccount(value: unknown): DeletedManagedThreadsAccount {
  if (
    !isObject(value) ||
    !validId(value.id) ||
    !validId(value.registrationId) ||
    !validDate(value.deletedAt)
  )
    throw new Error('INVALID_RESPONSE');
  if (value.ownershipVersion !== undefined && !validRevision(value.ownershipVersion))
    throw new Error('INVALID_RESPONSE');
  return {
    id: value.id,
    registrationId: value.registrationId,
    deletedAt: value.deletedAt,
    ...(value.ownershipVersion === undefined
      ? {}
      : { ownershipVersion: value.ownershipVersion as number }),
  };
}
export interface ManagedThreadsRecord {
  localId: string;
  label: string;
  registrationId: string;
  appName: string;
  appId: string | null;
  /** Retained only while resolving a possibly committed v1 creation by its original App ID. */
  legacyAppId: string | null;
  account: ManagedThreadsAccount | null;
  syncedToken: string | null;
  syncedRevision?: number | null;
  pending: {
    action: 'create' | 'replace';
    token: string;
    expectedRevision: number | null;
    expectedOwnershipVersion?: number;
    expectedLifecycleVersion?: number;
    /** This PC's Meta check of `token`; absent when the check failed (saved as unverified). */
    verification?: { threadsUserId: string; expiresAt: string };
    /** Replacement only. A 'refresh' token exists nowhere else until the server stores it. */
    reason?: 'replace' | 'recheck' | 'refresh';
  } | null;
  pendingDeletion: {
    expectedRevision: number;
    expectedLifecycleVersion?: number;
    expectedOwnershipVersion?: number;
  } | null;
  conflict: boolean;
  missing: boolean;
}
/** Retired v4 intents are never exposed or sent; the next normal save removes them. */
function isRetiredIntent(value: unknown): boolean {
  return (
    isObject(value) &&
    ['suspend', 'resume', 'transfer', 'accept', 'reject', 'cancel'].includes(String(value.action))
  );
}
interface Partition {
  scope: string;
  ownerId: string;
  records: ManagedThreadsRecord[];
  operations: never[];
}
interface StoredFile {
  version: 4;
  partitions: Partition[];
}

export class ManagedThreadsStorageError extends Error {
  constructor(
    public readonly code: 'STORAGE_UNAVAILABLE' | 'STORAGE_CORRUPT' | 'STORAGE_WRITE_FAILED',
  ) {
    super(
      code === 'STORAGE_CORRUPT'
        ? '계정 보관 파일을 읽을 수 없습니다. 기존 파일은 보존했습니다.'
        : '운영체제 보안 저장소에 계정 정보를 저장하지 못했습니다.',
    );
    this.name = 'ManagedThreadsStorageError';
  }
}
function migrateLegacyFile(value: Record<string, unknown>): unknown {
  if (!Array.isArray(value.partitions)) throw new Error('invalid legacy file');
  return {
    ...value,
    version: 2,
    partitions: value.partitions.map((p) => {
      if (!isObject(p) || !Array.isArray(p.records)) throw new Error('invalid legacy partition');
      return {
        ...p,
        records: p.records.map((r) => {
          if (
            !isObject(r) ||
            !exactKeys(r, [
              'localId',
              'label',
              'appId',
              'account',
              'syncedToken',
              'pending',
              'conflict',
              'missing',
            ]) ||
            !validAppId(r.appId) ||
            !(r.account === null || (isObject(r.account) && r.account.appId === r.appId))
          )
            throw new Error('invalid legacy record');
          const oldAccount = r.account as Record<string, unknown> | null;
          return {
            ...r,
            registrationId: oldAccount?.id ?? r.localId,
            appName: r.appId,
            legacyAppId: oldAccount ? null : r.appId,
            account: oldAccount
              ? { ...oldAccount, registrationId: oldAccount.id, appName: r.appId }
              : null,
          };
        }),
      };
    }),
  };
}
function validateFile(value: unknown): StoredFile {
  if (isObject(value) && value.version === 1) value = migrateLegacyFile(value);
  if (isObject(value) && value.version === 2) {
    if (!Array.isArray(value.partitions)) throw new Error('invalid v2 file');
    value = {
      ...value,
      version: 3,
      partitions: value.partitions.map((p) => {
        if (!isObject(p) || !Array.isArray(p.records)) throw new Error('invalid v2 partition');
        return {
          ...p,
          records: p.records.map((r) => {
            if (!isObject(r) || Object.hasOwn(r, 'pendingDeletion'))
              throw new Error('invalid v2 record');
            return { ...r, pendingDeletion: null };
          }),
        };
      }),
    };
  }
  if (isObject(value) && value.version === 3) {
    if (!Array.isArray(value.partitions)) throw new Error('invalid v3 file');
    value = {
      ...value,
      version: 4,
      partitions: value.partitions.map((p) => {
        if (!isObject(p) || Object.hasOwn(p, 'operations')) throw new Error('invalid v3 partition');
        return { ...p, operations: [] };
      }),
    };
  }
  if (
    !isObject(value) ||
    !exactKeys(value, ['version', 'partitions']) ||
    value.version !== 4 ||
    !Array.isArray(value.partitions)
  )
    throw new Error('invalid file');
  const partitions = value.partitions.map((p): Partition => {
    if (
      !isObject(p) ||
      !exactKeys(p, ['scope', 'ownerId', 'records', 'operations']) ||
      typeof p.scope !== 'string' ||
      !p.scope ||
      p.scope.length > 2048 ||
      !validId(p.ownerId) ||
      !Array.isArray(p.records) ||
      !Array.isArray(p.operations)
    )
      throw new Error('invalid partition');
    const ownerId = p.ownerId;
    const records = p.records.map((r): ManagedThreadsRecord => {
      if (
        !isObject(r) ||
        !exactKeys(r, [
          ...(Object.hasOwn(r, 'syncedRevision') ? ['syncedRevision'] : []),
          'localId',
          'label',
          'appId',
          'registrationId',
          'appName',
          'legacyAppId',
          'account',
          'syncedToken',
          'pending',
          'pendingDeletion',
          'conflict',
          'missing',
        ]) ||
        !validId(r.localId) ||
        !validLabel(r.label) ||
        !(r.appId === null || validAppId(r.appId)) ||
        !validId(r.registrationId) ||
        !validLabel(r.appName) ||
        !(r.legacyAppId === null || validAppId(r.legacyAppId)) ||
        !(r.syncedToken === null || validToken(r.syncedToken)) ||
        (r.syncedRevision !== undefined &&
          r.syncedRevision !== null &&
          !validRevision(r.syncedRevision)) ||
        typeof r.conflict !== 'boolean' ||
        typeof r.missing !== 'boolean'
      )
        throw new Error('invalid record');
      const account = r.account === null ? null : parseManagedAccount(r.account, ownerId);
      if (
        account &&
        (account.appId !== r.appId ||
          account.registrationId !== r.registrationId ||
          account.appName !== r.appName)
      )
        throw new Error('invalid account');
      if (r.legacyAppId !== null && (account || r.legacyAppId !== r.appId))
        throw new Error('invalid legacy marker');
      if (account === null && r.syncedToken !== null) throw new Error('invalid credential');
      let pending: ManagedThreadsRecord['pending'] = null;
      if (r.pending !== null) {
        if (
          !isObject(r.pending) ||
          Object.keys(r.pending).some(
            (k) =>
              ![
                'action',
                'token',
                'expectedRevision',
                'expectedOwnershipVersion',
                'expectedLifecycleVersion',
                'verification',
                'reason',
              ].includes(k),
          ) ||
          (r.pending.verification !== undefined &&
            (!isObject(r.pending.verification) ||
              !exactKeys(r.pending.verification, ['threadsUserId', 'expiresAt']) ||
              !validAppId(r.pending.verification.threadsUserId) ||
              !validDate(r.pending.verification.expiresAt))) ||
          (r.pending.reason !== undefined &&
            (r.pending.action !== 'replace' ||
              !['replace', 'recheck', 'refresh'].includes(String(r.pending.reason)))) ||
          (r.pending.expectedOwnershipVersion !== undefined &&
            !validRevision(r.pending.expectedOwnershipVersion)) ||
          (r.pending.expectedLifecycleVersion !== undefined &&
            !validRevision(r.pending.expectedLifecycleVersion)) ||
          !['create', 'replace'].includes(String(r.pending.action)) ||
          !validToken(r.pending.token) ||
          (r.pending.action === 'create'
            ? r.pending.expectedRevision !== null
            : !validRevision(r.pending.expectedRevision) ||
              r.pending.expectedRevision >= 2147483647)
        )
          throw new Error('invalid pending');
        pending = r.pending as unknown as NonNullable<ManagedThreadsRecord['pending']>;
      }
      if (
        r.pendingDeletion !== null &&
        (!account ||
          !isObject(r.pendingDeletion) ||
          Object.keys(r.pendingDeletion).some(
            (k) =>
              ![
                'expectedRevision',
                'expectedLifecycleVersion',
                'expectedOwnershipVersion',
              ].includes(k),
          ) ||
          !validRevision(r.pendingDeletion.expectedRevision) ||
          (r.pendingDeletion.expectedLifecycleVersion !== undefined &&
            !validRevision(r.pendingDeletion.expectedLifecycleVersion)) ||
          (r.pendingDeletion.expectedOwnershipVersion !== undefined &&
            !validRevision(r.pendingDeletion.expectedOwnershipVersion)))
      )
        throw new Error('invalid pending deletion');
      if (!account && !pending) throw new Error('empty record');
      if (pending?.action === 'replace' && !account) throw new Error('missing replacement account');
      return {
        localId: r.localId,
        label: r.label,
        registrationId: r.registrationId,
        appName: r.appName,
        appId: r.appId as string | null,
        legacyAppId: r.legacyAppId as string | null,
        account,
        syncedToken: r.syncedToken as string | null,
        ...(Object.hasOwn(r, 'syncedRevision')
          ? { syncedRevision: r.syncedRevision as number | null }
          : {}),
        pending,
        pendingDeletion: r.pendingDeletion as ManagedThreadsRecord['pendingDeletion'],
        conflict: r.conflict,
        missing: r.missing,
      };
    });
    for (const key of ['localId', 'registrationId'] as const)
      if (new Set(records.map((r) => r[key])).size !== records.length)
        throw new Error('duplicate record');
    const ids = records.flatMap((r) => (r.account ? [r.account.id] : []));
    if (new Set(ids).size !== ids.length) throw new Error('duplicate account');
    if ((p.operations as unknown[]).some((o) => !isRetiredIntent(o)))
      throw new Error('invalid retired operation');
    const operations: never[] = [];
    return { scope: p.scope, ownerId, records, operations };
  });
  if (
    new Set(partitions.map((p) => JSON.stringify([p.scope, p.ownerId]))).size !== partitions.length
  )
    throw new Error('duplicate partition');
  return { version: 4, partitions };
}

/** Whole-file OS encryption, separate service/user partitions and no corruption repair by deletion. */
export class EncryptedManagedThreadsStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly filePath: string,
    private readonly cipher: TokenCipher,
  ) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }
  private async load(): Promise<StoredFile> {
    if (!(await this.cipher.isEncryptionAvailable()))
      throw new ManagedThreadsStorageError('STORAGE_UNAVAILABLE');
    try {
      const stat = await lstat(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024)
        throw new Error('invalid file');
      return validateFile(
        JSON.parse(await this.cipher.decryptString(await readFile(this.filePath))),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 4, partitions: [] };
      throw new ManagedThreadsStorageError('STORAGE_CORRUPT');
    }
  }
  read(scope: string, ownerId: string): Promise<ManagedThreadsRecord[]> {
    return this.serial(async () =>
      structuredClone(
        (await this.load()).partitions.find((p) => p.scope === scope && p.ownerId === ownerId)
          ?.records ?? [],
      ),
    );
  }
  write(scope: string, ownerId: string, records: ManagedThreadsRecord[]): Promise<void> {
    return this.serial(async () => {
      const file = await this.load(); // Corrupt existing data must never be replaced.
      const found = file.partitions.find((p) => p.scope === scope && p.ownerId === ownerId);
      if (found) found.records = records;
      else file.partitions.push({ scope, ownerId, records, operations: [] });
      await this.persist(file);
    });
  }
  private async persist(file: StoredFile): Promise<void> {
    const checked = validateFile(file);
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      const ciphertext = await this.cipher.encryptString(JSON.stringify(checked));
      if (ciphertext.length > 32 * 1024 * 1024) throw new Error('file too large');
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(ciphertext);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.filePath);
    } catch {
      throw new ManagedThreadsStorageError('STORAGE_WRITE_FAILED');
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
