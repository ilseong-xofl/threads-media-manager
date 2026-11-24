import { IPC } from '../shared/contracts';

/**
 * Account reads/reconciliation can coexist with the publication control plane. So can the ment
 * catalog (2026-11-24): it only talks to the server and touches no publication or local file.
 */
export function mobilePublicationBlocks(channel: string, active: boolean): boolean {
  return (
    active &&
    !channel.startsWith('tmm:mobile-publications:') &&
    !channel.startsWith('tmm:ments:') &&
    ![
      IPC.current,
      IPC.downloadStatus,
      IPC.threadsState,
      IPC.capabilities,
      IPC.managedThreadsAccounts,
      IPC.daily,
      IPC.dailyReplies,
      IPC.openDailyReplyLink,
      IPC.draftNote,
    ].some((read) => read === channel)
  );
}
