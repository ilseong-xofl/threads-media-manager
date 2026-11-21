import { IPC } from '../shared/contracts';

/** Account reads/reconciliation can coexist with the publication control plane. */
export function mobilePublicationBlocks(channel: string, active: boolean): boolean {
  return (
    active &&
    !channel.startsWith('tmm:mobile-publications:') &&
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
