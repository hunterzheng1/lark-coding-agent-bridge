import {
  classifyDeliveryError,
  isPermanentDeliveryError,
} from './delivery-errors';

export interface CardUpdateResult {
  rolledOver: boolean;
  messageId?: string;
}

interface ResilientCardUpdaterOptions {
  sendSuccessor: (card: object) => Promise<{ messageId: string }>;
  updateMessage: (messageId: string, card: object) => Promise<void>;
  onRollover?: (previousMessageId: string | undefined, nextMessageId: string) => void;
  maxAttempts?: number;
  /** Injectable delay (tests). Used between rate-limited retry attempts. */
  sleep?: (ms: number) => Promise<void>;
  /** Backoff ceiling for rate-limited retries (ms). */
  maxBackoffMs?: number;
}

type UpdateCard = (card: object) => Promise<void>;

const DEFAULT_MAX_BACKOFF_MS = 1_000;

/**
 * Serializes progress-card updates, retries transient failures, and switches to
 * a newly sent successor card when the active stream/card can no longer update.
 *
 * OPT-02: failures are classified. Permanent content/permission errors do not
 * burn retries and never trigger rollover — the same payload would fail in a
 * successor card too, so the error is surfaced for the fallback path instead.
 * Rate-limited attempts back off between tries (capped); other failures keep
 * the original retry-then-rollover behavior.
 */
export class ResilientCardUpdater {
  private readonly maxAttempts: number;
  private readonly sendSuccessor: ResilientCardUpdaterOptions['sendSuccessor'];
  private readonly updateMessage: ResilientCardUpdaterOptions['updateMessage'];
  private readonly onRollover: ResilientCardUpdaterOptions['onRollover'];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxBackoffMs: number;
  private activeUpdate: UpdateCard | undefined;
  private activeMessageId: string | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private rollovers = 0;
  private lastCategory: string | undefined;

  constructor(options: ResilientCardUpdaterOptions) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    this.sendSuccessor = options.sendSuccessor;
    this.updateMessage = options.updateMessage;
    this.onRollover = options.onRollover;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  }

  attachPrimary(messageId: string | undefined, update: UpdateCard): void {
    this.activeMessageId = messageId;
    this.activeUpdate = update;
  }

  /** Number of successor-card switches this updater has performed. */
  get rolloverCount(): number {
    return this.rollovers;
  }

  /** Delivery error category of the most recent failure (observability). */
  get lastErrorCategory(): string | undefined {
    return this.lastCategory;
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
      } catch (err) {
        this.lastCategory = classifyDeliveryError(err);
        // Same invalid content would fail in a successor card as well —
        // surface immediately instead of retrying or rolling over.
        if (isPermanentDeliveryError(classifyDeliveryError(err))) throw err;
        if (this.lastCategory === 'rate_limited' && attempt < this.maxAttempts) {
          await this.sleep(Math.min(this.maxBackoffMs, 250 * attempt));
        }
        if (attempt === this.maxAttempts) break;
      }
    }
    const previousMessageId = this.activeMessageId;
    const successor = await this.sendSuccessor(card);
    this.activeMessageId = successor.messageId;
    this.activeUpdate = (next) => this.updateMessage(successor.messageId, next);
    this.rollovers += 1;
    this.onRollover?.(previousMessageId, successor.messageId);
    return { rolledOver: true, messageId: successor.messageId };
  }
}
