import { IPC } from '../shared/contracts';
import type { MentResult } from '../shared/ments';

interface MentActions {
  list(): Promise<MentResult>;
  save(input: unknown): Promise<MentResult>;
  delete(input: unknown): Promise<MentResult>;
}

/** Called only after the main frame and service-access checks. No arbitrary endpoint IPC. */
export function handleMentRequest(
  channel: string,
  args: unknown[],
  ments: MentActions,
): Promise<MentResult> {
  if (channel === IPC.ments) {
    if (args.length) throw new Error('Unexpected arguments');
    return ments.list();
  }
  if (args.length !== 1) throw new Error('Unexpected arguments');
  switch (channel) {
    case IPC.saveMent:
      return ments.save(args[0]);
    case IPC.deleteMent:
      return ments.delete(args[0]);
    default:
      throw new Error('Unsupported ment operation');
  }
}
