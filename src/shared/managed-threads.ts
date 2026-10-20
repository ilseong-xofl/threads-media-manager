/** Public metadata only. Tokens and encrypted credential records never return through IPC. */
export interface ManagedThreadsAccount {
  id: string;
  ownerId: string;
  label: string;
  registrationId: string;
  appName: string;
  appId: string | null;
  threadsUserId: string | null;
  validationStatus: 'pending_validation' | 'reported_valid' | 'invalid';
  appIdVerified: boolean;
  tokenRevision: number;
  expiresAt: string | null;
  createdAt: string;
  lifecycleVersion?: number;
  ownershipVersion?: number;
}

export interface DeletedManagedThreadsAccount {
  id: string;
  registrationId: string;
  deletedAt: string;
  ownershipVersion?: number;
}

export interface ManagedThreadsAccountRow {
  localId: string;
  label: string;
  registrationId: string;
  appName: string;
  appId: string | null;
  account: ManagedThreadsAccount | null;
  localRevision: number | null;
  localState: 'synced' | 'pending' | 'conflict' | 'missing';
  pendingAction: 'create' | 'replace' | null;
  pendingDeletion: boolean;
}

export interface ManagedThreadsResult {
  status: 'ok' | 'error';
  accounts: ManagedThreadsAccountRow[];
  problem: { code: string; message: string } | null;
}

export interface RegisterManagedThreadsAccountInput {
  label: string;
  appName: string;
  token: string;
}
export interface ReplaceManagedThreadsTokenInput {
  accountId: string;
  expectedRevision: number;
  token: string;
}
/** Display names only; the token and the phone check are unchanged. */
export interface UpdateManagedThreadsAccountInput {
  accountId: string;
  label: string;
  appName: string;
}
export interface DeleteManagedThreadsAccountInput {
  accountId: string;
  expectedRevision: number;
}
export interface PendingManagedThreadsAccountInput {
  localId: string;
}

export interface ManagedThreadsMethods {
  getManagedThreadsAccounts(): Promise<ManagedThreadsResult>;
  deleteManagedThreadsAccount(
    input: DeleteManagedThreadsAccountInput,
  ): Promise<ManagedThreadsResult>;
  registerManagedThreadsAccount(
    input: RegisterManagedThreadsAccountInput,
  ): Promise<ManagedThreadsResult>;
  replaceManagedThreadsToken(input: ReplaceManagedThreadsTokenInput): Promise<ManagedThreadsResult>;
  updateManagedThreadsAccount(
    input: UpdateManagedThreadsAccountInput,
  ): Promise<ManagedThreadsResult>;
  retryManagedThreadsAccount(
    input: PendingManagedThreadsAccountInput,
  ): Promise<ManagedThreadsResult>;
  discardPendingManagedThreadsAccount(
    input: PendingManagedThreadsAccountInput,
  ): Promise<ManagedThreadsResult>;
}
