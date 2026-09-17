import { log } from '../core/logger';
import { classifyDeliveryError } from './delivery-errors';

/**
 * Delivery scheduler between event consumption and card delivery (OPT-02).
 *
 * The agent event loop calls `offer(snapshot)` on every state change and
 * never waits for the network. At most one send is in flight and at most one
 * snapshot is pending — always the latest, so a slow API coalesces progress
 * instead of building an unbounded backlog. `finish(terminal)` installs a
 * terminal barrier: it is awaited by the caller, sends the terminal snapshot
 * after whatever is in flight (older running snapshots can never overwrite
 * it), offers are ignored once the barrier is set, and it retries the
 * terminal send a bounded number of times before giving up — a final
 * delivery failure is recorded, never hidden behind an infinite wait.
 */

export interface SnapshotSchedulerStats {
  offered: number;
  delivered: number;
  /** Offers dropped because a newer snapshot was already pending (or the terminal barrier was set). */
  coalesced: number;
  failures: number;
  lastOfferAt?: number;
  lastDeliverySuccessAt?: number;
  lastErrorCategory?: string;
}

export interface SnapshotSchedulerOptions<T> {
  send: (snapshot: T, meta: { isTerminal: boolean }) => Promise<void>;
  onResult?: (ok: boolean, err?: unknown) => void;
  now?: () => number;
}

export interface FinishOptions {
  /** Bounded attempts for the terminal snapshot before giving up. */
  maxAttempts?: number;
}

const DEFAULT_TERMINAL_ATTEMPTS = 3;

export class SnapshotScheduler<T> {
  private readonly sendFn: SnapshotSchedulerOptions<T>['send'];
  private readonly onResult?: SnapshotSchedulerOptions<T>['onResult'];
  private readonly now: () => number;
  private pending: { snapshot: T; terminal: boolean } | undefined;
  private terminalSet = false;
  private terminalAttempts = DEFAULT_TERMINAL_ATTEMPTS;
  private pumping = false;
  private pumpPromise: Promise<void> = Promise.resolve();
  private readonly stats: SnapshotSchedulerStats = {
    offered: 0,
    delivered: 0,
    coalesced: 0,
    failures: 0,
  };

  constructor(options: SnapshotSchedulerOptions<T>) {
    this.sendFn = options.send;
    this.onResult = options.onResult;
    this.now = options.now ?? Date.now;
  }

  /** Hand the latest snapshot to the scheduler; never blocks the caller. */
  offer(snapshot: T): void {
    if (this.terminalSet) {
      // Terminal barrier: a stale running snapshot must never queue behind
      // (or replace) the terminal one.
      this.stats.offered += 1;
      this.stats.coalesced += 1;
      return;
    }
    this.stats.offered += 1;
    this.stats.lastOfferAt = this.now();
    if (this.pending) {
      this.pending = { snapshot, terminal: false };
      this.stats.coalesced += 1;
      return;
    }
    this.pending = { snapshot, terminal: false };
    this.kick();
  }

  /**
   * Install the terminal snapshot, wait for it to be delivered (or for the
   * bounded retries to be exhausted), and resolve. Idempotent: a second call
   * with the barrier already set resolves without resending.
   */
  async finish(snapshot: T, opts?: FinishOptions): Promise<void> {
    if (this.terminalSet) {
      await this.pumpPromise;
      return;
    }
    this.terminalSet = true;
    this.terminalAttempts = Math.max(1, opts?.maxAttempts ?? DEFAULT_TERMINAL_ATTEMPTS);
    this.stats.lastOfferAt = this.now();
    if (this.pending) this.stats.coalesced += 1;
    this.pending = { snapshot, terminal: true };
    this.kick();
    await this.pumpPromise;
    // If the terminal send exhausted its attempts inside the pump, we still
    // resolve — the failure is recorded in stats and surfaced via onResult.
  }

  /** Resolves once nothing is in flight and nothing is pending. */
  idle(): Promise<void> {
    return this.pumpPromise;
  }

  getStats(): SnapshotSchedulerStats {
    return { ...this.stats };
  }

  private kick(): void {
    if (this.pumping) return;
    this.pumping = true;
    this.pumpPromise = this.pump();
  }

  private async pump(): Promise<void> {
    try {
      while (this.pending) {
        const task = this.pending;
        this.pending = undefined;
        if (task.terminal) {
          await this.sendTerminal(task.snapshot);
        } else {
          await this.sendOrdinary(task.snapshot);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async sendOrdinary(snapshot: T): Promise<void> {
    try {
      await this.sendFn(snapshot, { isTerminal: false });
      this.stats.delivered += 1;
      this.stats.lastDeliverySuccessAt = this.now();
      this.onResult?.(true);
    } catch (err) {
      this.stats.failures += 1;
      this.stats.lastErrorCategory = classifyDeliveryError(err);
      this.onResult?.(false, err);
      log.fail('stream', err, { step: 'delivery-snapshot' });
    }
  }

  private async sendTerminal(snapshot: T): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.terminalAttempts; attempt++) {
      try {
        await this.sendFn(snapshot, { isTerminal: true });
        this.stats.delivered += 1;
        this.stats.lastDeliverySuccessAt = this.now();
        this.onResult?.(true);
        return;
      } catch (err) {
        lastErr = err;
        this.stats.failures += 1;
        this.onResult?.(false, err);
      }
    }
    this.stats.lastErrorCategory = classifyDeliveryError(lastErr);
    log.fail('stream', lastErr, { step: 'delivery-terminal', attempts: this.terminalAttempts });
  }
}
