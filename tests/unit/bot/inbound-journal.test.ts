import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
});
