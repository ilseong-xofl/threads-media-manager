import { randomUUID } from 'node:crypto';
import {
  EncryptedLocalStore,
  SecretStoreError,
  type ThreadsAccountEncryption,
} from './threads-secret-store';
export type { ThreadsAccountEncryption } from './threads-secret-store';

const DAY = 86_400_000;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const date = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
const token = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9._~+/-]{16,8192}={0,2}$/.test(value);

export interface ThreadsAccountClient {
  debugToken(accessToken: string): Promise<{ userId: string; expiresAt: number }>;
  me(accessToken: string): Promise<{ id: string; username: string }>;
  refresh(accessToken: string): Promise<{ accessToken: string; expiresIn: number }>;
}
export interface ThreadsAccountProblem {
  code: string;
  message: string;
}
export interface ConnectedThreadsAccount {
  id: string;
  username: string;
  connectedAt: string;
  expiresAt: string;
  lastRefreshedAt: string | null;
  lastRefreshAttemptAt: string | null;
  requiresReconnect: boolean;
}
export interface ThreadsAccountHistory {
  accountId: string;
  username: string;
  action: 'connected' | 'replaced' | 'disconnected' | 'refreshed' | 'refresh_failed';
  at: string;
  problemCode?: string;
}
export interface ThreadsAccountView {
  account: ConnectedThreadsAccount | null;
  history: ThreadsAccountHistory[];
  problem: ThreadsAccountProblem | null;
  busy: boolean;
}
export interface ConnectThreadsAccountInput {
  accessToken: string;
}
interface SavedAccount extends ConnectedThreadsAccount {
  accessToken: string;
  generation: string;
}
interface SavedState {
  version: 1;
  account: SavedAccount | null;
  history: ThreadsAccountHistory[];
  problem: ThreadsAccountProblem | null;
}
interface MissingExpiryAccount extends Omit<SavedAccount, 'expiresAt'> {
  expiresAt?: null;
}
interface ReadableState extends Omit<SavedState, 'account'> {
  account: SavedAccount | MissingExpiryAccount | null;
}
export interface ThreadsAccountOptions {
  userData: string;
  encryption: ThreadsAccountEncryption;
  client: ThreadsAccountClient;
  now?: () => number;
}

const messages: Record<string, string> = {
  account_input: '올바른 Threads 장기 토큰을 입력하세요.',
  account_unavailable: '이 기기의 보안 저장소를 사용할 수 없습니다.',
  account_storage: '계정 정보를 안전하게 저장하지 못했습니다. 기존 정보는 보존했습니다.',
  account_corrupt:
    '저장된 계정 정보를 읽지 못했습니다. 기존 파일을 보존했으며 변경을 중단했습니다.',
  account_response: 'Threads 계정 응답을 확인하지 못했습니다.',
  account_debug_permission:
    '토큰 정보를 조회할 권한이 없습니다. 해당 Meta 앱의 Threads 테스터로 등록하고 초대를 수락한 계정의 토큰인지 확인하세요.',
  account_request: 'Threads에 연결하지 못했습니다. 연결 상태를 확인하고 다시 시도하세요.',
  account_auth: 'Threads 연결이 만료되거나 해제되었습니다. 토큰을 다시 등록하세요.',
  account_permission: 'Threads 권한이 부족합니다. 필요한 권한이 포함된 토큰을 다시 등록하세요.',
  account_rate_limit: 'Threads 요청이 제한되었습니다. 다음 자동 확인에서 다시 시도합니다.',
  account_expired: 'Threads 토큰이 만료되었습니다. 새 장기 토큰을 등록하세요.',
  account_expiry:
    '토큰 만료 정보를 확인하지 못했습니다. 연결 권한을 확인하거나 새 토큰을 등록하세요.',
};
export class ThreadsAccountError extends Error {
  constructor(readonly code: string) {
    super(messages[code] ?? messages.account_request);
  }
}
function problem(error: unknown): ThreadsAccountProblem {
  const apiCodes: Record<string, string> = {
    invalid_input: 'account_input',
    auth_expired: 'account_auth',
    permission_missing: 'account_permission',
    rate_limited: 'account_rate_limit',
    invalid_response: 'account_response',
  };
  const code =
    error instanceof SecretStoreError
      ? (
          {
            unavailable: 'account_unavailable',
            corrupt: 'account_corrupt',
            storage: 'account_storage',
          } as const
        )[error.code]
      : error instanceof ThreadsAccountError && Object.hasOwn(messages, error.code)
        ? error.code
        : object(error) && typeof error.code === 'string' && Object.hasOwn(apiCodes, error.code)
          ? apiCodes[error.code]
          : 'account_request';
  return { code, message: messages[code] };
}
function accountProfile(
  value: unknown,
): value is Record<string, unknown> & { id: string; username: string } {
  return (
    object(value) &&
    typeof value.id === 'string' &&
    /^\d{1,40}$/.test(value.id) &&
    typeof value.username === 'string' &&
    /^[A-Za-z0-9._]{1,100}$/.test(value.username)
  );
}
function validState(value: unknown): value is ReadableState {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.history)) return false;
  if (value.account !== null) {
    const current = value.account;
    if (
      !accountProfile(current) ||
      !object(current) ||
      !token(current.accessToken) ||
      typeof current.generation !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(current.generation) ||
      !date(current.connectedAt) ||
      !(current.expiresAt === undefined || current.expiresAt === null || date(current.expiresAt)) ||
      !(current.lastRefreshedAt === null || date(current.lastRefreshedAt)) ||
      !(current.lastRefreshAttemptAt === null || date(current.lastRefreshAttemptAt)) ||
      typeof current.requiresReconnect !== 'boolean'
    )
      return false;
  }
  if (!(
    value.problem === null ||
    (object(value.problem) &&
      typeof value.problem.code === 'string' &&
      Object.hasOwn(messages, value.problem.code) &&
      value.problem.message === messages[value.problem.code])
  ))
    return false;
  return value.history.every(
    (entry) =>
      object(entry) &&
      accountProfile({ id: entry.accountId, username: entry.username }) &&
      date(entry.at) &&
      ['connected', 'replaced', 'disconnected', 'refreshed', 'refresh_failed'].includes(
        String(entry.action),
      ) &&
      (entry.problemCode === undefined ||
        (typeof entry.problemCode === 'string' && Object.hasOwn(messages, entry.problemCode))),
  );
}

/** Tokens remain inside the main process and never appear in the returned views. */
export class ThreadsAccountManager {
  private state: SavedState = { version: 1, account: null, history: [], problem: null };
  private loadPromise?: Promise<void>;
  private loadProblem: ThreadsAccountProblem | null = null;
  private pendingLegacyState: ReadableState | null = null;
  private transientProblem: ThreadsAccountProblem | null = null;
  private writes: Promise<void> = Promise.resolve();
  private refreshPromise?: Promise<ThreadsAccountView>;
  private generation = 0;
  private pending = 0;
  private readonly store: EncryptedLocalStore<ReadableState>;
  private readonly now: () => number;

  constructor(private readonly options: ThreadsAccountOptions) {
    this.store = new EncryptedLocalStore({
      userData: options.userData,
      fileName: 'threads-account.json',
      encryption: options.encryption,
      validate: validState,
    });
    this.now = options.now ?? Date.now;
  }
  get busy(): boolean {
    return this.pending > 0;
  }
  private view(): ThreadsAccountView {
    const saved = this.state.account;
    const account: ConnectedThreadsAccount | null = saved
      ? {
          id: saved.id,
          username: saved.username,
          connectedAt: saved.connectedAt,
          expiresAt: saved.expiresAt,
          lastRefreshedAt: saved.lastRefreshedAt,
          lastRefreshAttemptAt: saved.lastRefreshAttemptAt,
          requiresReconnect: saved.requiresReconnect || Date.parse(saved.expiresAt) <= this.now(),
        }
      : null;
    const expired =
      saved && Date.parse(saved.expiresAt) <= this.now()
        ? problem(new ThreadsAccountError('account_expired'))
        : null;
    return {
      account,
      history: this.state.history.map((entry) => ({
        accountId: entry.accountId,
        username: entry.username,
        action: entry.action,
        at: entry.at,
        ...(entry.problemCode ? { problemCode: entry.problemCode } : {}),
      })),
      problem: this.loadProblem ?? this.transientProblem ?? expired ?? this.state.problem,
      busy: this.busy,
    };
  }
  private async load(): Promise<void> {
    if (!this.loadPromise)
      this.loadPromise = (async () => {
        try {
          const saved = await this.store.read();
          if (!saved) return;
          if (!saved.account) {
            this.state = { ...saved, account: null };
            return;
          }
          const current = saved.account;
          if (date(current.expiresAt)) {
            this.state = { ...saved, account: { ...current, expiresAt: current.expiresAt } };
            return;
          }
          // Keep a validated legacy token separate until its expiry can be verified.
          this.pendingLegacyState = saved;
          this.state = { ...saved, account: null };
          let debug: { userId: string; expiresAt: string };
          try {
            debug = await this.debugExpiry(current.accessToken);
            if (debug.userId !== current.id) throw new ThreadsAccountError('account_response');
          } catch (error) {
            this.transientProblem = problem(
              new ThreadsAccountError(
                error instanceof ThreadsAccountError && error.code === 'account_debug_permission'
                  ? 'account_debug_permission'
                  : 'account_expiry',
              ),
            );
            return;
          }
          const repaired: SavedState = {
            ...saved,
            account: { ...current, expiresAt: debug.expiresAt },
          };
          try {
            await this.store.write(repaired);
          } catch (error) {
            if (
              error instanceof SecretStoreError &&
              ['corrupt', 'unavailable'].includes(error.code)
            )
              this.loadProblem = problem(error);
            else this.transientProblem = problem(error);
            return;
          }
          this.state = repaired;
          this.pendingLegacyState = null;
        } catch (error) {
          this.loadProblem = problem(error);
        }
      })();
    await this.loadPromise;
  }
  private async debugExpiry(accessToken: string): Promise<{ userId: string; expiresAt: string }> {
    let debug: unknown;
    try {
      debug = await this.options.client.debugToken(accessToken);
    } catch (error) {
      if (object(error) && error.code === 'permission_missing')
        throw new ThreadsAccountError('account_debug_permission');
      throw error;
    }
    if (
      !object(debug) ||
      typeof debug.userId !== 'string' ||
      !/^\d{1,40}$/.test(debug.userId) ||
      typeof debug.expiresAt !== 'number' ||
      !Number.isSafeInteger(debug.expiresAt) ||
      debug.expiresAt <= 0 ||
      !Number.isFinite(new Date(debug.expiresAt * 1000).getTime())
    )
      throw new ThreadsAccountError('account_response');
    if (debug.expiresAt * 1000 <= this.now()) throw new ThreadsAccountError('account_expired');
    return { userId: debug.userId, expiresAt: new Date(debug.expiresAt * 1000).toISOString() };
  }
  private async serialize(action: () => Promise<void>): Promise<void> {
    const next = this.writes.then(action);
    this.writes = next.catch(() => {});
    await next;
  }
  private async save(next: SavedState): Promise<void> {
    if (this.loadProblem) throw new ThreadsAccountError(this.loadProblem.code);
    await this.store.write(next);
    this.state = next;
    this.pendingLegacyState = null;
    this.transientProblem = null;
  }
  /** Main-process use only. Never expose this method through IPC. */
  async credentials(): Promise<{ accessToken: string; account: ConnectedThreadsAccount }> {
    await this.load();
    if (this.refreshPromise) await this.refreshPromise;
    await this.writes;
    if (this.loadProblem) throw new ThreadsAccountError(this.loadProblem.code);
    if (this.pendingLegacyState) throw new ThreadsAccountError('account_expiry');
    const current = this.state.account;
    if (!current || current.requiresReconnect) throw new ThreadsAccountError('account_auth');
    if (Date.parse(current.expiresAt) <= this.now())
      throw new ThreadsAccountError('account_expired');
    return { accessToken: current.accessToken, account: this.view().account! };
  }
  async status(): Promise<ThreadsAccountView> {
    await this.load();
    await this.writes;
    return this.view();
  }
  async connect(input: unknown): Promise<ThreadsAccountView> {
    const operation = ++this.generation;
    await this.load();
    if (this.loadProblem) return this.view();
    if (!object(input) || Object.keys(input).length !== 1 || !token(input.accessToken)) {
      this.transientProblem = problem(new ThreadsAccountError('account_input'));
      return this.view();
    }
    const accessToken = input.accessToken;
    if (operation !== this.generation) return this.view();
    const existing = this.state.account;
    if (
      existing?.accessToken === accessToken &&
      !existing.requiresReconnect &&
      Date.parse(existing.expiresAt) > this.now()
    ) {
      this.transientProblem = null;
      return this.view();
    }
    this.pending++;
    try {
      if (!(await this.options.encryption.isAvailable()))
        throw new ThreadsAccountError('account_unavailable');
      if (operation !== this.generation) return this.view();
      const debug = await this.debugExpiry(accessToken);
      if (operation !== this.generation) return this.view();
      const profile = await this.options.client.me(accessToken);
      if (!accountProfile(profile) || profile.id !== debug.userId)
        throw new ThreadsAccountError('account_response');
      const expiresAt = debug.expiresAt;
      if (Date.parse(expiresAt) <= this.now()) throw new ThreadsAccountError('account_expired');
      await this.serialize(async () => {
        if (operation !== this.generation) return;
        const at = new Date(this.now()).toISOString();
        const previous = this.pendingLegacyState?.account ?? this.state.account;
        const history = (this.pendingLegacyState?.history ?? this.state.history).slice();
        if (previous)
          history.push({
            accountId: previous.id,
            username: previous.username,
            action: 'replaced',
            at,
          });
        history.push({
          accountId: profile.id,
          username: profile.username,
          action: 'connected',
          at,
        });
        await this.save({
          version: 1,
          account: {
            ...profile,
            accessToken,
            generation: randomUUID(),
            connectedAt: at,
            expiresAt,
            lastRefreshedAt: null,
            lastRefreshAttemptAt: null,
            requiresReconnect: false,
          },
          history,
          problem: null,
        });
      });
    } catch (error) {
      if (operation === this.generation) this.transientProblem = problem(error);
    } finally {
      this.pending--;
    }
    return this.view();
  }
  async disconnect(): Promise<ThreadsAccountView> {
    const operation = ++this.generation;
    await this.load();
    if (this.loadProblem) return this.view();
    this.pending++;
    try {
      await this.serialize(async () => {
        if (operation !== this.generation) return;
        const current = this.pendingLegacyState?.account ?? this.state.account;
        if (!current) {
          this.transientProblem = null;
          return;
        }
        await this.save({
          version: 1,
          account: null,
          problem: null,
          history: [
            ...(this.pendingLegacyState?.history ?? this.state.history),
            {
              accountId: current.id,
              username: current.username,
              action: 'disconnected',
              at: new Date(this.now()).toISOString(),
            },
          ],
        });
      });
    } catch (error) {
      this.transientProblem = problem(error);
    } finally {
      this.pending--;
    }
    return this.view();
  }
  async refreshIfDue(): Promise<ThreadsAccountView> {
    if (this.refreshPromise) return this.refreshPromise;
    const run = this.refresh();
    this.refreshPromise = run;
    try {
      return await run;
    } finally {
      if (this.refreshPromise === run) this.refreshPromise = undefined;
    }
  }
  private async refresh(): Promise<ThreadsAccountView> {
    await this.load();
    await this.writes;
    const current = this.state.account;
    if (this.loadProblem || !current || current.requiresReconnect) return this.view();
    const now = this.now();
    const remaining = Date.parse(current.expiresAt) - now;
    // A 60-day token in its final 30 days is already older than Meta's 24-hour minimum.
    if (
      remaining <= 0 ||
      remaining > 30 * DAY ||
      (current.lastRefreshAttemptAt && now - Date.parse(current.lastRefreshAttemptAt) < DAY)
    )
      return this.view();
    const operation = this.generation;
    const identity = current.generation;
    const stillCurrent = () =>
      operation === this.generation && this.state.account?.generation === identity;
    this.pending++;
    try {
      await this.serialize(async () => {
        if (!stillCurrent()) return;
        await this.save({
          ...this.state,
          account: { ...current, lastRefreshAttemptAt: new Date(now).toISOString() },
        });
      });
      if (!stillCurrent()) return this.view();
      const refreshed = await this.options.client.refresh(current.accessToken);
      if (
        !token(refreshed.accessToken) ||
        !Number.isInteger(refreshed.expiresIn) ||
        refreshed.expiresIn <= 0 ||
        refreshed.expiresIn > (61 * DAY) / 1000
      )
        throw new ThreadsAccountError('account_response');
      await this.serialize(async () => {
        if (!stillCurrent()) return;
        const at = new Date(this.now()).toISOString();
        await this.save({
          ...this.state,
          account: {
            ...this.state.account!,
            accessToken: refreshed.accessToken,
            expiresAt: new Date(now + refreshed.expiresIn * 1000).toISOString(),
            lastRefreshedAt: at,
          },
          history: [
            ...this.state.history,
            { accountId: current.id, username: current.username, action: 'refreshed', at },
          ],
          problem: null,
        });
      });
    } catch (error) {
      if (stillCurrent()) {
        const issue = problem(error);
        if (issue.code === 'account_storage' || issue.code === 'account_unavailable')
          this.transientProblem = issue;
        else {
          try {
            await this.serialize(async () => {
              if (!stillCurrent()) return;
              await this.save({
                ...this.state,
                account: {
                  ...this.state.account!,
                  requiresReconnect: ['account_auth', 'account_permission'].includes(issue.code),
                },
                problem: issue,
                history: [
                  ...this.state.history,
                  {
                    accountId: current.id,
                    username: current.username,
                    action: 'refresh_failed',
                    at: new Date(this.now()).toISOString(),
                    problemCode: issue.code,
                  },
                ],
              });
            });
          } catch (saveError) {
            this.transientProblem = problem(saveError);
          }
        }
      }
    } finally {
      this.pending--;
    }
    return this.view();
  }
}
