export interface CardUpdateResult {
  rolledOver: boolean;
  messageId?: string;
}

interface ResilientCardUpdaterOptions {
  sendSuccessor: (card: object) => Promise<{ messageId: string }>;
  updateMessage: (messageId: string, card: object) => Promise<void>;
  onRollover?: (previousMessageId: string | undefined, nextMessageId: string) => void;
  maxAttempts?: number;
}

type UpdateCard = (card: object) => Promise<void>;

/**
 * Serializes progress-card updates, retries transient failures, and switches to
 * a newly sent successor card when the active stream/card can no longer update.
 */
export class ResilientCardUpdater {
  private readonly maxAttempts: number;
  private readonly sendSuccessor: ResilientCardUpdaterOptions['sendSuccessor'];
  private readonly updateMessage: ResilientCardUpdaterOptions['updateMessage'];
  private readonly onRollover: ResilientCardUpdaterOptions['onRollover'];
  private activeUpdate: UpdateCard | undefined;
  private activeMessageId: string | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: ResilientCardUpdaterOptions) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    this.sendSuccessor = options.sendSuccessor;
    this.updateMessage = options.updateMessage;
    this.onRollover = options.onRollover;
  }

  attachPrimary(messageId: string | undefined, update: UpdateCard): void {
    this.activeMessageId = messageId;
    this.activeUpdate = update;
  }

  update(card: object): Promise<CardUpdateResult> {
    const task = this.tail.then(() => this.apply(card));
    this.tail = task.catch(() => undefined);
    return task;
  }

  private async apply(card: object): Promise<CardUpdateResult> {
    if (!this.activeUpdate) return { rolledOver: false };

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await this.activeUpdate(card);
        return { rolledOver: false, messageId: this.activeMessageId };
      } catch {
        if (attempt === this.maxAttempts) break;
      }
    }

    const previousMessageId = this.activeMessageId;
    const successor = await this.sendSuccessor(card);
    this.activeMessageId = successor.messageId;
    this.activeUpdate = (next) => this.updateMessage(successor.messageId, next);
    this.onRollover?.(previousMessageId, successor.messageId);
    return { rolledOver: true, messageId: successor.messageId };
  }
}
