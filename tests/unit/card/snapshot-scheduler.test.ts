import { describe, it, expect } from 'vitest';
import { SnapshotScheduler, type SnapshotSchedulerStats } from '../../../src/card/snapshot-scheduler';

/**
 * OPT-02: the delivery scheduler must keep at most one in-flight send and one
 * pending snapshot (always the latest), give terminal snapshots priority, and
 * surface delivery observability — without ever blocking the event producer.
 */

interface FakeStats {
  stats: SnapshotSchedulerStats;
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeScheduler(overrides: {
  send?: (snapshot: string, meta: { isTerminal: boolean }) => Promise<void>;
  now?: () => number;
} = {}): {
  scheduler: SnapshotScheduler<string>;
  sent: Array<{ snapshot: string; terminal: boolean }>;
  results: Array<{ ok: boolean; err?: unknown }>;
  gates: Array<ReturnType<typeof deferred>>;
} {
  const sent: Array<{ snapshot: string; terminal: boolean }> = [];
  const results: Array<{ ok: boolean; err?: unknown }> = [];
  const gates: Array<ReturnType<typeof deferred>> = [];
  let clock = 1_000;
  const scheduler = new SnapshotScheduler<string>({
    send: overrides.send ??
      (async (snapshot, meta) => {
        sent.push({ snapshot, terminal: meta.isTerminal });
        const gate = deferred();
        gates.push(gate);
        await gate.promise;
      }),
    now: overrides.now ?? (() => ++clock),
    onResult: (ok, err) => results.push({ ok, err }),
  });
  return { scheduler, sent, results, gates };
}

async function until(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out waiting for scheduler condition');
}

describe('SnapshotScheduler', () => {
  it('coalesces offers made while a send is in flight to the latest snapshot', async () => {
    const h = makeScheduler();
    h.scheduler.offer('s1');
    await until(() => h.gates.length >= 1);
    h.scheduler.offer('s2');
    h.scheduler.offer('s3');
    h.scheduler.offer('s4');
    expect(h.sent.map((s) => s.snapshot)).toEqual(['s1']);
    h.gates[0]!.resolve();
    await until(() => h.gates.length >= 2);
    expect(h.sent.map((s) => s.snapshot)).toEqual(['s1', 's4']);
    h.gates[1]!.resolve();
    await h.scheduler.idle();
    // Only the latest pending snapshot is delivered; intermediates dropped.
    expect(h.sent.map((s) => s.snapshot)).toEqual(['s1', 's4']);
    expect(h.scheduler.getStats().offered).toBe(4);
    expect(h.scheduler.getStats().coalesced).toBe(2);
    expect(h.scheduler.getStats().delivered).toBe(2);
  });

  it('never runs two sends concurrently', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    let delivered = 0;
    const h = makeScheduler({
      send: async () => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((r) => setTimeout(r, 3));
        inFlight--;
        delivered++;
      },
    });
    for (let i = 0; i < 20; i++) {
      h.scheduler.offer(`s${i}`);
      // Spread offers out so each send finishes before the next offer —
      // a synchronous burst would legitimately coalesce.
      await new Promise((r) => setTimeout(r, 5));
    }
    await h.scheduler.idle();
    expect(maxConcurrent).toBe(1);
    expect(delivered).toBe(20);
    expect(h.scheduler.getStats().delivered).toBe(20);
    expect(h.scheduler.getStats().coalesced).toBe(0);
  });

  it('finish() sends the terminal snapshot last; later offers are ignored', async () => {
    const h = makeScheduler();
    h.scheduler.offer('running-1');
    await until(() => h.gates.length >= 1);
    const finished = h.scheduler.finish('terminal');
    h.scheduler.offer('stale-after-terminal');
    h.gates[0]!.resolve();
    await until(() => h.gates.length >= 2);
    h.gates[1]!.resolve();
    await finished;
    expect(h.sent.map((s) => s.snapshot)).toEqual(['running-1', 'terminal']);
    expect(h.sent[1]!.terminal).toBe(true);
    expect(h.scheduler.getStats().coalesced).toBe(1);
  });

  it('finish() is awaitable and resolves only after the terminal snapshot is delivered', async () => {
    const h = makeScheduler();
    h.scheduler.offer('a');
    await until(() => h.gates.length >= 1);
    let resolved = false;
    const finished = h.scheduler.finish('final').then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    h.gates[0]!.resolve();
    await until(() => h.gates.length >= 2);
    h.gates[1]!.resolve();
    await finished;
    expect(resolved).toBe(true);
    expect(h.scheduler.getStats().lastDeliverySuccessAt).toBeDefined();
  });

  it('retries a failed terminal snapshot up to maxAttempts, then gives up without hanging', async () => {
    let attempts = 0;
    const h = makeScheduler({
      send: async (_snapshot, meta) => {
        if (meta.isTerminal) {
          attempts++;
          throw new Error('delivery down');
        }
      },
    });
    h.scheduler.offer('running');
    await h.scheduler.finish('final', { maxAttempts: 3 });
    expect(attempts).toBe(3);
    const stats = h.scheduler.getStats();
    expect(stats.failures).toBe(3);
    expect(stats.delivered).toBe(1); // the running snapshot
  });

  it('a failed running snapshot does not stall the pump; the latest still arrives', async () => {
    const h = makeScheduler({
      send: async (snapshot) => {
        if (snapshot === 'bad') throw new Error('transient');
      },
    });
    h.scheduler.offer('bad');
    h.scheduler.offer('good');
    await h.scheduler.idle();
    expect(h.scheduler.getStats().delivered).toBe(1);
    expect(h.scheduler.getStats().failures).toBe(1);
    expect(h.results.some((r) => !r.ok)).toBe(true);
    expect(h.results.some((r) => r.ok)).toBe(true);
  });

  it('finish() after a resolved finish does not resend', async () => {
    const h = makeScheduler({
      send: async () => {},
    });
    await h.scheduler.finish('final');
    await h.scheduler.finish('final');
    expect(h.scheduler.getStats().offered).toBe(0);
    expect(h.scheduler.getStats().delivered).toBe(1);
  });

  it('tracks observability stats (offered/delivered/coalesced/failures/timestamps)', async () => {
    let clock = 10;
    const h = makeScheduler({
      now: () => (clock += 10),
      send: async () => {},
    });
    h.scheduler.offer('x');
    await h.scheduler.idle();
    const stats: SnapshotSchedulerStats = h.scheduler.getStats();
    expect(stats.offered).toBe(1);
    expect(stats.delivered).toBe(1);
    expect(stats.lastOfferAt).toBeDefined();
    expect(stats.lastDeliverySuccessAt).toBeGreaterThan(stats.lastOfferAt!);
  });
});
