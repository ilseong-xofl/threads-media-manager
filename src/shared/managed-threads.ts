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

export type ManagedThreadsTokenOperation = 'register' | 'replace' | 'recheck' | 'refresh';
/** Why a Meta token request (debug_token or refresh_access_token) did not succeed. */
export type MetaTokenOutcome =
  'invalid_token' | 'rejected' | 'network' | 'not_sent' | 'timeout' | 'bad_response';
export type MetaTokenDetail = 'expired' | 'short_lived' | 'permission';
/** Safe scalar facts from a Meta failure. Never contains a token or a request URL. */
export interface MetaTokenFailureDetails {
  detail: MetaTokenDetail | null;
  httpStatus: number | null;
  metaCode: number | null;
  metaSubcode: number | null;
  metaType: string | null;
  metaMessage: string | null;
  fbtraceId: string | null;
  networkCode: string | null;
}
/** The latest PC token check of one row, read from the plaintext check log. */
export interface ManagedThreadsTokenCheck extends MetaTokenFailureDetails {
  at: string;
  operation: ManagedThreadsTokenOperation;
  result: 'success' | 'duplicate' | 'mismatch' | MetaTokenOutcome;
  expiresAt: string | null;
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
  pendingReason: 'replace' | 'recheck' | 'refresh' | null;
  pendingDeletion: boolean;
  lastCheck: ManagedThreadsTokenCheck | null;
}

export interface ManagedThreadsResult {
  status: 'ok' | 'error';
  accounts: ManagedThreadsAccountRow[];
  problem: { code: string; message: string } | null;
  /** Seconds until this employee may send the next Meta token request (server-enforced). */
  metaRequestRetryAfterSeconds: number;
  refreshWindowDays: number;
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
/** Display names only; the token and its check state are unchanged. */
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
/** Re-check or refresh the stored token of one synchronized account. */
export interface ManagedThreadsTokenActionInput {
  accountId: string;
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
  recheckManagedThreadsAccount(
    input: ManagedThreadsTokenActionInput,
  ): Promise<ManagedThreadsResult>;
  refreshManagedThreadsToken(input: ManagedThreadsTokenActionInput): Promise<ManagedThreadsResult>;
  retryManagedThreadsAccount(
    input: PendingManagedThreadsAccountInput,
  ): Promise<ManagedThreadsResult>;
  discardPendingManagedThreadsAccount(
    input: PendingManagedThreadsAccountInput,
  ): Promise<ManagedThreadsResult>;
}
