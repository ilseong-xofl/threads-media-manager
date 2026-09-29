export interface UpdateNotification {
  releaseName: string;
  updateUrl: string;
}

export type UpdatePromptChoice = 'later' | 'restart';

interface UpdatePromptCoordinatorOptions {
  isBusy: () => boolean;
  onError: (error: unknown) => void;
  restart: () => void;
  showPrompt: (update: UpdateNotification) => Promise<UpdatePromptChoice>;
}

function notificationKey(update: UpdateNotification): string {
  return `${update.releaseName}\n${update.updateUrl}`;
}

/** A downloaded update must never interrupt active work or restart without a fresh choice. */
export class UpdatePromptCoordinator {
  private readonly handledNotifications = new Set<string>();
  private readonly pending = new Map<string, UpdateNotification>();
  private disposed = false;
  private restarting = false;
  private promptingKey: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(private readonly options: UpdatePromptCoordinatorOptions) {}

  public notify(update: UpdateNotification): void {
    const key = notificationKey(update);
    if (
      this.disposed ||
      this.restarting ||
      this.handledNotifications.has(key) ||
      this.promptingKey === key
    ) {
      return;
    }
    this.pending.set(key, update);
    this.drain();
  }

  public dispose(): void {
    this.disposed = true;
    this.pending.clear();
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private scheduleRetry(): void {
    if (this.disposed || this.restarting || this.retryTimer !== null || !this.pending.size) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.drain();
    }, 1_000);
    this.retryTimer.unref?.();
  }

  private drain(): void {
    if (this.disposed || this.restarting || this.promptingKey !== null || !this.pending.size)
      return;
    try {
      if (this.options.isBusy()) {
        this.scheduleRetry();
        return;
      }
    } catch (error) {
      // An unavailable work state cannot authorize a restart.
      this.options.onError(error);
      this.scheduleRetry();
      return;
    }
    const [key, update] = this.pending.entries().next().value!;
    this.pending.delete(key);
    this.promptingKey = key;
    void this.prompt(update, key);
  }

  private async prompt(update: UpdateNotification, key: string): Promise<void> {
    try {
      const choice = await this.options.showPrompt(update);
      if (this.disposed) return;
      if (choice === 'restart') {
        // A background job can start while the native confirmation is open.
        // Re-prompt after it finishes; do not retain authorization to quit later.
        if (this.options.isBusy()) {
          this.pending.set(key, update);
          return;
        }
        this.options.restart();
        this.restarting = true;
      }
      this.handledNotifications.add(key);
    } catch (error) {
      if (!this.disposed) {
        this.handledNotifications.add(key);
        this.options.onError(error);
      }
    } finally {
      this.promptingKey = null;
      this.scheduleRetry();
    }
  }
}
