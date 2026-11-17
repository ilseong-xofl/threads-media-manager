import { IPC } from '../shared/contracts';
import type { DailyResult } from '../shared/daily';

interface DailyActions {
  state(): Promise<DailyResult>;
  savePersona(input: unknown): Promise<DailyResult>;
  deletePersona(input: unknown): Promise<DailyResult>;
  generate(input: unknown): Promise<DailyResult>;
  addPost(input: unknown): Promise<DailyResult>;
  savePost(input: unknown): Promise<DailyResult>;
  translatePost(input: unknown): Promise<DailyResult>;
  deletePost(input: unknown): Promise<DailyResult>;
  send(input: unknown): Promise<DailyResult>;
  cancelSend(input: unknown): Promise<DailyResult>;
}

/** Called only after the main frame and service-access checks. No arbitrary endpoint IPC. */
export function handleDailyRequest(
  channel: string,
  args: unknown[],
  daily: DailyActions,
): Promise<DailyResult> {
  if (channel === IPC.daily) {
    if (args.length) throw new Error('Unexpected arguments');
    return daily.state();
  }
  if (args.length !== 1) throw new Error('Unexpected arguments');
  switch (channel) {
    case IPC.saveDailyPersona:
      return daily.savePersona(args[0]);
    case IPC.deleteDailyPersona:
      return daily.deletePersona(args[0]);
    case IPC.generateDailyPosts:
      return daily.generate(args[0]);
    case IPC.addDailyPost:
      return daily.addPost(args[0]);
    case IPC.saveDailyPost:
      return daily.savePost(args[0]);
    case IPC.translateDailyPost:
      return daily.translatePost(args[0]);
    case IPC.deleteDailyPost:
      return daily.deletePost(args[0]);
    case IPC.sendDailyPost:
      return daily.send(args[0]);
    case IPC.cancelDailySend:
      return daily.cancelSend(args[0]);
    default:
      throw new Error('Unsupported daily operation');
  }
}
