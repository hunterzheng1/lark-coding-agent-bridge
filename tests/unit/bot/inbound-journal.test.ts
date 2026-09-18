import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InboundJournal,
  type InboundRecord,
  type InboundStatus,
} from '../../../src/bot/inbound-journal';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function freshDir(prefix = 'inbound-j-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return dir;
}

function accepted(overrides: Partial<Parameters<InboundJournal['recordAccepted']>[0]> = {}) {
  const now = Date.now();
  return {
    messageId: 'om_1',
    scope: 'oc_chat1',
    chatId: 'oc_chat1',
    senderId: 'ou_user',
    content: '请帮我跑测试',
    acceptedAt: now,
    ...overrides,
  };
}

describe('InboundJournal', () => {
  it('records accepted messages and dedups by messageId', async () => {
    const dir = await freshDir();
    const j = new InboundJournal(dir);
    expect(await j.recordAccepted(accepted())).toBe('recorded');
    // Feishu redelivery of the same event must not create a second record.
    expect(await j.recordAccepted(accepted())).toBe('duplicate');
    expect(j.list('oc_chat1')).toHaveLength(1);
    expect(j.list('oc_chat1')[0]!.status).toBe<InboundStatus>('queued');
  });

  it('claim marks a batch of messages with the run id; terminal closes them', async () => {
    const dir = await freshDir();
    const j = new InboundJournal(dir);
    await j.recordAccepted(accepted({ messageId: 'om_1' }));
    await j.recordAccepted(accepted({ messageId: 'om_2' }));
    await j.markClaimed('oc_chat1', ['om_1', 'om_2'], 'run-1');
    expect(j.list('oc_chat1').every((r) => r.status === 'claimed' && r.runId === 'run-1')).toBe(true);
    await j.markTerminal('oc_chat1', 'run-1', 'done');
    expect(j.list('oc_chat1').every((r) => r.status === 'terminal')).toBe(true);
  });

  it('records are isolated per scope', async () => {
    const dir = await freshDir();
    const j = new InboundJournal(dir);
    await j.recordAccepted(accepted({ scope: 'oc_a', chatId: 'oc_a' }));
    expect(j.list('oc_b')).toHaveLength(0);
    await j.markClaimed('oc_b', ['om_1'], 'run-x'); // must not touch oc_a
    expect(j.list('oc_a')[0]!.status).toBe('queued');
  });

  it('recoverOnStartup: queued within window → requeue; stale queued → expired; claimed → uncertain; terminal pruned', async () => {
    const dir = await freshDir();
    const now = Date.now();
    const j = new InboundJournal(dir);
    await j.recordAccepted(accepted({ messageId: 'om_fresh', acceptedAt: now - 60_000 }));
    await j.recordAccepted(accepted({ messageId: 'om_stale', acceptedAt: now - 60 * 60_000 }));
    await j.recordAccepted(accepted({ messageId: 'om_claimed' }));
    await j.markClaimed('oc_chat1', ['om_claimed'], 'run-9');
    await j.recordAccepted(accepted({ messageId: 'om_done' }));
    await j.markClaimed('oc_chat1', ['om_done'], 'run-8');
    await j.markTerminal('oc_chat1', 'run-8', 'done');

    const recovery = await j.recoverOnStartup();
    const byId = (id: string): InboundRecord | undefined =>
      [...recovery.requeue, ...recovery.uncertain, ...recovery.expired].find(
        (r) => r.messageId === id,
      );
    expect(byId('om_fresh')?.status).toBe('queued');
    expect(byId('om_stale')?.status).toBe('expired');
    expect(byId('om_claimed')?.status).toBe('uncertain');
    // Terminal records are not surfaced for any recovery action.
    expect(byId('om_done')).toBeUndefined();
  });

  it('survives reload from the profile dir', async () => {
    const dir = await freshDir();
    const j1 = new InboundJournal(dir);
    await j1.recordAccepted(accepted({ messageId: 'om_persist' }));
    await j1.flush();

    const j2 = new InboundJournal(dir);
    await j2.load();
    expect(j2.list('oc_chat1').map((r) => r.messageId)).toEqual(['om_persist']);
  });

  it('tolerates a corrupt journal file on load', async () => {
    const dir = await freshDir();
    await writeFile(join(dir, 'broken.json'), '{nope', 'utf8');
    const j = new InboundJournal(dir);
    await expect(j.load()).resolves.toBeUndefined();
    expect(j.list('oc_any')).toHaveLength(0);
  });

  it("recordAccepted reports 'failed' when the directory cannot be created", async () => {
    const dir = await freshDir();
    const blocker = join(dir, 'occupied');
    await writeFile(blocker, 'x', 'utf8');
    const j = new InboundJournal(blocker);
    expect(await j.recordAccepted(accepted())).toBe('failed');
  });

  it('a failed write rolls back only its own reservation, never a replacement', async () => {
    const dir = await freshDir();
    const blocker = join(dir, 'occupied');
    await writeFile(blocker, 'x', 'utf8');
    const j = new InboundJournal(blocker);
    const inflight = j.recordAccepted(accepted({ messageId: 'om_k' }));
    // While mkdir is in flight the old reservation was cleared (/new) and the
    // SAME id re-accepted as a newer record — the failed write's rollback
    // must not evict it.
    const records = (j as unknown as { records: Map<string, InboundRecord> }).records;
    records.set('oc_chat1\u0000om_k', { ...accepted({ messageId: 'om_k' }), status: 'queued' });
    expect(await inflight).toBe('failed');
    expect(j.getRecord('oc_chat1', 'om_k')).toBeDefined();
  });

  it('clearQueued removes only queued records for the scope (/new semantics)', async () => {
    const dir = await freshDir();
    const j = new InboundJournal(dir);
    await j.recordAccepted(accepted({ messageId: 'om_q' }));
    await j.recordAccepted(accepted({ messageId: 'om_c' }));
    await j.markClaimed('oc_chat1', ['om_c'], 'run-1');
    await j.clearQueued('oc_chat1');
    expect(j.list('oc_chat1').map((r) => r.messageId)).toEqual(['om_c']);
  });

  it('retention prunes records older than maxAgeMs', async () => {
    const dir = await freshDir();
    const now = { value: 1_000_000 };
    const j = new InboundJournal(dir, { maxAgeMs: 5_000 }, () => now.value);
    await j.recordAccepted(accepted({ messageId: 'om_old', acceptedAt: 500 }));
    now.value = 2_000_000;
    expect(j.list('oc_chat1')).toHaveLength(0);
  });
});

describe('InboundJournal recovery actions (recovery card)', () => {
  async function seeded(dir: string): Promise<InboundJournal> {
    const j = new InboundJournal(dir);
    await j.recordAccepted(accepted({ messageId: 'om_u' }));
    await j.markClaimed('oc_chat1', ['om_u'], 'run-lost');
    // force uncertain
    await j.recoverOnStartup();
    return j;
  }

  it('markRedone settles the old record and journals a fresh queued copy', async () => {
    const dir = await freshDir();
    const j = await seeded(dir);
    const rec = j.getRecord('oc_chat1', 'om_u');
    expect(rec?.status).toBe('uncertain');

    const nextId = await j.redo('oc_chat1', 'om_u');
    expect(nextId).not.toBe('om_u');
    expect(j.getRecord('oc_chat1', 'om_u')?.status).toBe('terminal');
    expect(j.getRecord('oc_chat1', 'om_u')?.terminalState).toBe('redone');
    const fresh = j.getRecord('oc_chat1', nextId!);
    expect(fresh?.status).toBe('queued');
    expect(fresh?.content).toBe(rec?.content);
  });

  it('markDismissed settles the record as dismissed; redo on settled record fails', async () => {
    const dir = await freshDir();
    const j = await seeded(dir);
    await j.markDismissed('oc_chat1', 'om_u');
    expect(j.getRecord('oc_chat1', 'om_u')?.terminalState).toBe('dismissed');
    expect(await j.redo('oc_chat1', 'om_u')).toBeUndefined();
  });

  it('redo works on expired records too; unknown ids return undefined', async () => {
    const dir = await freshDir();
    const j = new InboundJournal(dir, {}, () => Date.now());
    await j.recordAccepted(accepted({ messageId: 'om_old', acceptedAt: Date.now() - 60 * 60_000 }));
    await j.recoverOnStartup(); // expired (outside requeue window)
    expect(j.getRecord('oc_chat1', 'om_old')?.status).toBe('expired');
    expect(await j.redo('oc_chat1', 'om_old')).toBeTruthy();
    expect(await j.redo('oc_chat1', 'om_nope')).toBeUndefined();
  });

  it('redo can carry a resetSession intent on the fresh record only', async () => {
    const dir = await freshDir();
    const j = await seeded(dir);
    const newId = await j.redo('oc_chat1', 'om_u', { resetSession: true });
    expect(j.getRecord('oc_chat1', newId!)?.resetSession).toBe(true);
    expect(j.getRecord('oc_chat1', 'om_u')?.resetSession).toBeUndefined();
    // Without the opt nothing is flagged (继续对话 / expired plain redo).
    await j.recordAccepted(accepted({ messageId: 'om_u2' }));
    await j.markClaimed('oc_chat1', ['om_u2'], 'run-2');
    await j.recoverOnStartup();
    const plainId = await j.redo('oc_chat1', 'om_u2');
    expect(j.getRecord('oc_chat1', plainId!)?.resetSession).toBeUndefined();
  });
});

describe('InboundJournal redo contentOverride (继续对话)', () => {
  it('override replaces the dispatched content in the fresh record', async () => {
    const dir = await freshDir();
    const j = new InboundJournal(dir);
    await j.recordAccepted(accepted({ messageId: 'om_c' }));
    await j.markClaimed('oc_chat1', ['om_c'], 'run-x');
    await j.recoverOnStartup();
    const newId = await j.redo('oc_chat1', 'om_c', { contentOverride: '【恢复】继续' });
    const fresh = j.getRecord('oc_chat1', newId!);
    expect(fresh?.content).toBe('【恢复】继续');
    // Old record keeps its original content for audit.
    expect(j.getRecord('oc_chat1', 'om_c')?.content).toBe('请帮我跑测试');
  });
});

describe('InboundJournal pre-spawn claim + bindRun (评审修复)', () => {
  it('markClaimed reports persistence success; bindRun rebinds provisional → real run id', async () => {
    const dir = await freshDir();
    const j = new InboundJournal(dir);
    await j.recordAccepted(accepted({ messageId: 'om_p' }));
    // Claim before spawn with a provisional run id (persisted = true).
    expect(await j.markClaimed('oc_chat1', ['om_p'], 'pending:123')).toBe(true);
    expect(j.getRecord('oc_chat1', 'om_p')?.runId).toBe('pending:123');
    // Bind the real run id; terminal settle then matches by it.
    expect(await j.bindRun('oc_chat1', ['om_p'], 'run-real')).toBe(true);
    expect(j.getRecord('oc_chat1', 'om_p')?.runId).toBe('run-real');
    expect(await j.markTerminal('oc_chat1', 'run-real', 'done')).toBe(true);
    expect(j.getRecord('oc_chat1', 'om_p')?.status).toBe('terminal');
  });

  it('concurrent writes to one scope are serialized — no state is lost', async () => {
    const dir = await freshDir();
    const j = new InboundJournal(dir);
    // Fire two saves without awaiting the first: without per-scope
    // serialization the second atomic write could clobber the first.
    const [a, b] = await Promise.all([
      j.recordAccepted(accepted({ messageId: 'om_a' })),
      j.recordAccepted(accepted({ messageId: 'om_b' })),
    ]);
    expect(a).toBe('recorded');
    expect(b).toBe('recorded');
    await j.flush();
    const j2 = new InboundJournal(dir);
    await j2.load();
    expect(j2.list('oc_chat1').map((r) => r.messageId).sort()).toEqual(['om_a', 'om_b']);
  });
});

describe('InboundJournal 并发与持久化失败回滚（评审二轮）', () => {
  it('concurrent duplicate deliveries: exactly one recorded, one duplicate', async () => {
    const dir = await freshDir();
    const j = new InboundJournal(dir);
    // True concurrency — both enter recordAccepted before either persists.
    const [r1, r2] = await Promise.all([
      j.recordAccepted(accepted({ messageId: 'om_race' })),
      j.recordAccepted(accepted({ messageId: 'om_race' })),
    ]);
    const results = [r1, r2].sort();
    expect(results).toEqual(['duplicate', 'recorded']);
    expect(j.list('oc_chat1')).toHaveLength(1);
  });

  it('concurrent distinct deliveries are all recorded', async () => {
    const dir = await freshDir();
    const j = new InboundJournal(dir);
    const [r1, r2] = await Promise.all([
      j.recordAccepted(accepted({ messageId: 'om_x' })),
      j.recordAccepted(accepted({ messageId: 'om_y' })),
    ]);
    expect([r1, r2]).toEqual(['recorded', 'recorded']);
    expect(j.list('oc_chat1')).toHaveLength(2);
  });

  it('markDismissed persist failure returns false and keeps the record actionable', async () => {
    const dir = await freshDir();
    const j = new InboundJournal(dir);
    await j.recordAccepted(accepted({ messageId: 'om_d' }));
    await j.markClaimed('oc_chat1', ['om_d'], 'run-1');
    await j.recoverOnStartup(); // → uncertain
    // Break the journal dir: replace it with a file so writes fail.
    await rm(dir, { recursive: true, force: true });
    await writeFile(dir, 'occupied', 'utf8');

    expect(await j.markDismissed('oc_chat1', 'om_d')).toBe(false);
    // In-memory mutation rolled back — the record stays actionable.
    expect(j.getRecord('oc_chat1', 'om_d')?.status).toBe('uncertain');
  });

  it('redo persist failure returns undefined and keeps the record actionable', async () => {
    const dir = await freshDir();
    const j = new InboundJournal(dir);
    await j.recordAccepted(accepted({ messageId: 'om_r' }));
    await j.markClaimed('oc_chat1', ['om_r'], 'run-1');
    await j.recoverOnStartup();
    await rm(dir, { recursive: true, force: true });
    await writeFile(dir, 'occupied', 'utf8');

    expect(await j.redo('oc_chat1', 'om_r')).toBeUndefined();
    expect(j.getRecord('oc_chat1', 'om_r')?.status).toBe('uncertain');
  });
});

describe('InboundJournal 写入失败后重投（评审三轮）', () => {
  it('persist failure rolls back the reservation; a later delivery records cleanly', async () => {
    const dir = await freshDir();
    const j = new InboundJournal(dir);
    await j.recordAccepted(accepted({ messageId: 'om_retry' }));
    // Break the journal dir so the NEXT write fails.
    await rm(dir, { recursive: true, force: true });
    await writeFile(dir, 'occupied', 'utf8');

    // Deliver a new message — persist fails, reservation must be rolled back.
    expect(
      await j.recordAccepted(accepted({ messageId: 'om_new', content: 'fresh task' })),
    ).toBe('failed');
    // The failed reservation must not shadow a later delivery of the same id.
    expect(j.getRecord('oc_chat1', 'om_new')).toBeUndefined();

    // Journal recovers (dir writable again) — the same id is NOT a duplicate.
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'keep'), 'dir-holder', 'utf8');
    expect(
      await j.recordAccepted(accepted({ messageId: 'om_new', content: 'fresh task' })),
    ).toBe('recorded');
    expect(j.getRecord('oc_chat1', 'om_new')?.content).toBe('fresh task');
  });
});
