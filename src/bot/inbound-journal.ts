import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

/**
 * Write-ahead journal for inbound messages (OPT-04).
 *
 * Messages are journaled when accepted, before they enter the in-memory
 * PendingQueue — a crash or restart can no longer silently drop them. Status
 * tracks the delivery pipeline: `queued` (accepted, never dispatched), then
 * `claimed` (dispatched into a run — side effects may exist), then
 * `terminal` (run reached a known end). A `claimed` record without a terminal
 * event is `uncertain` on recovery: the run's outcome is unknown, so it is
 * never auto-rerun (OPT-04 recovery principle). `expired` marks queued
 * records too old to re-dispatch responsibly.
 *
 * Records are keyed Profile (implicit) + scope + platform messageId; duplicate
 * delivery of the same event is a no-op. One JSON file per scope, atomic
 * writes, 0600 — same durability pattern as SessionStore.
 */

export type InboundStatus = 'queued' | 'claimed' | 'terminal' | 'uncertain' | 'expired';

export interface InboundRecord {
  messageId: string;
  scope: string;
  chatId: string;
  senderId: string;
  content: string;
  acceptedAt: number;
  status: InboundStatus;
  threadId?: string;
  chatType?: 'p2p' | 'group';
  runId?: string;
  claimedAt?: number;
  settledAt?: number;
  /** Set when the run reached a known terminal state. */
  terminalState?: string;
}

export interface InboundJournalLimits {
  maxAgeMs: number;
  /** Queued records younger than this may be re-dispatched on startup. */
  requeueMaxAgeMs: number;
}

export const DEFAULT_INBOUND_LIMITS: Readonly<InboundJournalLimits> = {
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  requeueMaxAgeMs: 10 * 60 * 1000,
};

export interface RecoverySets {
  requeue: InboundRecord[];
  uncertain: InboundRecord[];
  expired: InboundRecord[];
}

interface JournalFile {
  version: 1;
  records: InboundRecord[];
}

export class InboundJournal {
  private readonly limits: InboundJournalLimits;
  private readonly records = new Map<string, InboundRecord>(); // `${scope}\u0000${messageId}`
  private readonly persistQueue = new Map<string, Promise<boolean>>();

  constructor(
    private readonly dir: string,
    limits: Partial<InboundJournalLimits> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.limits = { ...DEFAULT_INBOUND_LIMITS, ...limits };
  }

  async load(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return; // first boot — nothing journaled yet
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await readFile(join(this.dir, file), 'utf8')) as JournalFile;
        if (raw.version !== 1 || !Array.isArray(raw.records)) continue;
        for (const record of raw.records) {
          if (!record || typeof record.messageId !== 'string' || typeof record.scope !== 'string') {
            continue;
          }
          this.records.set(key(record.scope, record.messageId), record);
        }
      } catch (err) {
        log.warn('inbound', 'load-corrupt-skipped', {
          file,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Journal an accepted message before it enters the in-memory queue.
   * Resolves 'failed' when persistence failed — callers must not claim
   * durable receipt in that case. 'duplicate' is the idempotent no-op for a
   * redelivered event.
   *
   * The reservation is registered synchronously before the first await: two
   * concurrent deliveries of the same event id cannot both pass the check.
   * On any failure the reservation is rolled back so a later delivery (or
   * restart replay) can retry cleanly.
   */
  async recordAccepted(input: {
    messageId: string;
    scope: string;
    chatId: string;
    senderId: string;
    content: string;
    acceptedAt: number;
    threadId?: string;
    chatType?: 'p2p' | 'group';
  }): Promise<'recorded' | 'duplicate' | 'failed'> {
    const k = key(input.scope, input.messageId);
    if (this.records.has(k)) return 'duplicate'; // duplicate delivery — idempotent
    // Synchronous reservation — no await before this point.
    this.records.set(k, { ...input, status: 'queued' });
    try {
      await mkdir(this.dir, { recursive: true });
    } catch (err) {
      this.records.delete(k); // roll back the reservation
      log.fail('inbound', err, { step: 'mkdir', scope: input.scope });
      return 'failed';
    }
    const persisted = await this.persistScope(input.scope);
    if (!persisted) {
      // Roll back the reservation: a failed write must not make later
      // deliveries of the same id look like duplicates forever.
      this.records.delete(k);
      return 'failed';
    }
    return 'recorded';
  }

  async markClaimed(
    scope: string,
    messageIds: readonly string[],
    runId: string,
  ): Promise<boolean> {
    const now = this.now();
    let touched = false;
    for (const messageId of messageIds) {
      const record = this.records.get(key(scope, messageId));
      // A missing record means the message was never durably accepted (e.g.
      // the journal is unwritable) — the run must not start, or a crash
      // could replay a task whose side effects already happened.
      if (!record) return false;
      if (record.status === 'queued') {
        record.status = 'claimed';
        record.runId = runId;
        record.claimedAt = now;
        touched = true;
      } else if (record.status !== 'claimed' && record.status !== 'terminal') {
        // uncertain/expired records must not be claimed by dispatch.
        return false;
      }
    }
    if (!touched) return true;
    return this.persistScope(scope);
  }

  /**
   * Re-bind claimed records from the provisional pre-spawn claim id to the
   * real run id after the executor accepted the run. Failure is safe in the
   * conservative direction: the record stays claimed (→ uncertain on
   * restart, never auto-rerun), it must just be reported.
   */
  async bindRun(scope: string, messageIds: readonly string[], runId: string): Promise<boolean> {
    let touched = false;
    for (const messageId of messageIds) {
      const record = this.records.get(key(scope, messageId));
      if (!record || record.status !== 'claimed') continue;
      record.runId = runId;
      touched = true;
    }
    if (!touched) return true;
    return this.persistScope(scope);
  }

  async markTerminal(scope: string, runId: string, terminal: string): Promise<boolean> {
    const now = this.now();
    let touched = false;
    for (const record of this.records.values()) {
      if (record.scope !== scope || record.runId !== runId) continue;
      record.status = 'terminal';
      record.settledAt = now;
      record.terminalState = terminal;
      touched = true;
    }
    if (!touched) return true;
    return this.persistScope(scope);
  }

  /**
   * Settle records whose intake was rejected (policy denial, submit refusal)
   * so a restart does not replay them into the same rejection. Covers both
   * queued (rejected before spawn) and claimed (claim persisted but the
   * executor refused — no agent ever started).
   */
  async markRejected(scope: string, messageIds: readonly string[]): Promise<boolean> {
    const now = this.now();
    let touched = false;
    for (const messageId of messageIds) {
      const record = this.records.get(key(scope, messageId));
      if (!record) continue;
      if (record.status !== 'queued' && record.status !== 'claimed') continue;
      record.status = 'terminal';
      record.settledAt = now;
      record.terminalState = 'rejected';
      touched = true;
    }
    if (!touched) return true;
    return this.persistScope(scope);
  }

  /** /new semantics: drop queued (never-dispatched) records for the scope. */
  async clearQueued(scope: string): Promise<void> {
    let touched = false;
    for (const [k, record] of [...this.records]) {
      if (record.scope === scope && record.status === 'queued') {
        this.records.delete(k);
        touched = true;
      }
    }
    if (touched) await this.persistScope(scope);
  }

  list(scope: string): InboundRecord[] {
    return [...this.records.values()]
      .filter((r) => r.scope === scope && this.now() - r.acceptedAt <= this.limits.maxAgeMs)
      .sort((a, b) => a.acceptedAt - b.acceptedAt);
  }

  getRecord(scope: string, messageId: string): InboundRecord | undefined {
    return this.records.get(key(scope, messageId));
  }

  /**
   * Recovery-card actions (OPT-04): settle the old uncertain/expired record
   * as `redone` and journal a fresh queued copy, so the re-dispatched message
   * runs through the normal claim → terminal lifecycle (with fresh policy
   * checks at dispatch). `contentOverride` replaces the dispatched content —
   * used by 继续对话 to send a continuation prompt instead of the raw task.
   * Resolves the new messageId, or undefined when the record is
   * missing/already settled.
   */
  async redo(
    scope: string,
    messageId: string,
    opts?: { contentOverride?: string; senderId?: string },
  ): Promise<string | undefined> {
    const record = this.records.get(key(scope, messageId));
    if (!record) return undefined;
    if (record.status !== 'uncertain' && record.status !== 'expired') return undefined;
    const prevStatus = record.status;
    record.status = 'terminal';
    record.terminalState = 'redone';
    record.settledAt = this.now();
    const newId = `redo-${this.now()}-${messageId}`;
    this.records.set(key(scope, newId), {
      messageId: newId,
      scope: record.scope,
      chatId: record.chatId,
      // The re-dispatch belongs to the actor who clicked the recovery card.
      senderId: opts?.senderId ?? record.senderId,
      content: opts?.contentOverride ?? record.content,
      acceptedAt: this.now(),
      status: 'queued',
      ...(record.threadId ? { threadId: record.threadId } : {}),
      ...(record.chatType ? { chatType: record.chatType } : {}),
    });
    const persisted = await this.persistScope(scope);
    if (!persisted) {
      // Roll back the in-memory mutations: the record must stay actionable
      // (the recovery card remains valid and the user can retry).
      record.status = prevStatus;
      record.terminalState = undefined;
      record.settledAt = undefined;
      this.records.delete(key(scope, newId));
      return undefined;
    }
    return newId;
  }

  /**
   * Recovery-card "忽略": settle an uncertain/expired record as dismissed.
   * Resolves false when persistence failed (the in-memory mutation is rolled
   * back so the record stays actionable and the card remains truthful).
   */
  async markDismissed(scope: string, messageId: string): Promise<boolean> {
    const record = this.records.get(key(scope, messageId));
    if (!record) return true;
    if (record.status !== 'uncertain' && record.status !== 'expired') return true;
    const prevStatus = record.status;
    record.status = 'terminal';
    record.terminalState = 'dismissed';
    record.settledAt = this.now();
    const persisted = await this.persistScope(scope);
    if (!persisted) {
      record.status = prevStatus;
      record.terminalState = undefined;
      record.settledAt = undefined;
      return false;
    }
    return true;
  }

  /**
   * Classify journal leftovers at startup. Queued records inside the
   * re-dispatch window are safe to run again (they never spawned an agent);
   * claimed records without a known terminal are uncertain — the run's
   * outcome and side effects are unknown, so they are reported, never rerun.
   */
  async recoverOnStartup(): Promise<RecoverySets> {
    const now = this.now();
    const sets: RecoverySets = { requeue: [], uncertain: [], expired: [] };
    let touched = false;
    for (const record of this.records.values()) {
      if (record.status === 'terminal') continue; // pruned lazily by retention
      if (this.now() - record.acceptedAt > this.limits.maxAgeMs) continue;
      if (record.status === 'queued') {
        if (now - record.acceptedAt <= this.limits.requeueMaxAgeMs) {
          sets.requeue.push(record);
        } else {
          record.status = 'expired';
          record.settledAt = now;
          sets.expired.push(record);
          touched = true;
        }
      } else if (record.status === 'claimed') {
        record.status = 'uncertain';
        record.settledAt = now;
        sets.uncertain.push(record);
        touched = true;
      }
    }
    if (touched) {
      const scopes = new Set([...sets.uncertain, ...sets.expired].map((r) => r.scope));
      for (const scope of scopes) await this.persistScope(scope);
    }
    return sets;
  }

  async flush(): Promise<void> {
    await Promise.all([...this.persistQueue.values()]);
  }

  /**
   * Serialize all writes per scope: each persist task chains on the previous
   * one for the same scope, so concurrent state transitions can never write
   * a stale snapshot over a newer one (last executed task always dumps the
   * most recent full state).
   */
  private persistScope(scope: string): Promise<boolean> {
    const prev = this.persistQueue.get(scope) ?? Promise.resolve(true);
    const task = prev.then(() => this.writeScope(scope));
    this.persistQueue.set(scope, task);
    return task;
  }

  private async writeScope(scope: string): Promise<boolean> {
    const records = [...this.records.values()]
      .filter((r) => r.scope === scope)
      .sort((a, b) => a.acceptedAt - b.acceptedAt);
    const file: JournalFile = { version: 1, records };
    try {
      await writeFileAtomic(this.fileFor(scope), `${JSON.stringify(file)}\n`, { mode: 0o600 });
      return true;
    } catch (err) {
      log.fail('inbound', err, { step: 'persist', scope });
      return false;
    }
  }

  private fileFor(scope: string): string {
    const prefix = scope.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
    const hash = createHash('sha256').update(scope).digest('hex').slice(0, 12);
    return join(this.dir, `inbound-${prefix}-${hash}.json`);
  }
}

function key(scope: string, messageId: string): string {
  return `${scope}\u0000${messageId}`;
}

/**
 * Rebuild a replayable normalized message from a journal record — used by the
 * startup recovery replay and the recovery card's 重做 button. Pass a
 * different messageId when re-dispatching under a fresh identity.
 */
export function recoveryMessageFrom(record: InboundRecord, messageId = record.messageId): {
  messageId: string;
  chatId: string;
  scope: string;
  content: string;
  senderId: string;
  threadId?: string;
  chatType: 'p2p' | 'group';
} {
  return {
    messageId,
    chatId: record.chatId,
    scope: record.scope,
    content: record.content,
    senderId: record.senderId,
    ...(record.threadId ? { threadId: record.threadId } : {}),
    chatType: record.chatType ?? 'group',
  };
}
