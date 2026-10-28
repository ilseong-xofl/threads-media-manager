import { IPC } from '../shared/contracts';
import type { ManagedThreadsResult } from '../shared/managed-threads';

interface ManagedAccountActions {
  getAccounts(): Promise<ManagedThreadsResult>;
  deleteAccount(input: unknown): Promise<ManagedThreadsResult>;
  register(input: unknown): Promise<ManagedThreadsResult>;
  replace(input: unknown): Promise<ManagedThreadsResult>;
  update(input: unknown): Promise<ManagedThreadsResult>;
  recheck(input: unknown): Promise<ManagedThreadsResult>;
  refreshToken(input: unknown): Promise<ManagedThreadsResult>;
  retry(input: unknown): Promise<ManagedThreadsResult>;
  discardPending(input: unknown): Promise<ManagedThreadsResult>;
}

/** Called only after the main frame and service-access checks. No arbitrary endpoint IPC. */
export function handleManagedThreadsRequest(
  channel: string,
  args: unknown[],
  manager: ManagedAccountActions,
): Promise<ManagedThreadsResult> {
  if (channel === IPC.managedThreadsAccounts) {
    if (args.length) throw new Error('Unexpected arguments');
    return manager.getAccounts();
  }
  if (args.length !== 1) throw new Error('Unexpected arguments');
  switch (channel) {
    case IPC.deleteManagedThreadsAccount:
      return manager.deleteAccount(args[0]);
    case IPC.registerManagedThreadsAccount:
      return manager.register(args[0]);
    case IPC.replaceManagedThreadsToken:
      return manager.replace(args[0]);
    case IPC.updateManagedThreadsAccount:
      return manager.update(args[0]);
    case IPC.recheckManagedThreadsAccount:
      return manager.recheck(args[0]);
    case IPC.refreshManagedThreadsToken:
      return manager.refreshToken(args[0]);
    case IPC.retryManagedThreadsAccount:
      return manager.retry(args[0]);
    case IPC.discardPendingManagedThreadsAccount:
      return manager.discardPending(args[0]);
    default:
      throw new Error('Unsupported account operation');
  }
}
