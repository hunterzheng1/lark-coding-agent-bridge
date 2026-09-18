import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { groupBatchByModelSnapshot } from '../../../src/bot/channel';
import { formatModelNoticeSegment } from '../../../src/card/run-state';
import { InboundJournal } from '../../../src/bot/inbound-journal';

function msg(id: string): NormalizedMessage {
  return { messageId: id, chatId: 'c', senderId: 'u', content: id, resources: [] } as unknown as NormalizedMessage;
}

describe('groupBatchByModelSnapshot (OPT-07 slice C)', () => {
  it('merges consecutive same-snapshot messages and keeps order', () => {
    const snap = new Map([['m1', 'a'], ['m2', 'a'], ['m3', 'b']]);
    const groups = groupBatchByModelSnapshot(
      [msg('m1'), msg('m2'), msg('m3')],
      (m) => snap.get(m.messageId),
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]?.model).toBe('a');
    expect(groups[0]?.messages.map((m) => m.messageId)).toEqual(['m1', 'm2']);
    expect(groups[1]?.model).toBe('b');
  });

  it('does NOT merge same snapshots separated by a different one (no reorder)', () => {
    const snap = new Map([['m1', 'a'], ['m2', 'b'], ['m3', 'a']]);
    const groups = groupBatchByModelSnapshot(
      [msg('m1'), msg('m2'), msg('m3')],
      (m) => snap.get(m.messageId),
    );
    expect(groups.map((g) => g.model)).toEqual(['a', 'b', 'a']);
    expect(groups[2]?.messages[0]?.messageId).toBe('m3');
  });

  it('treats absent snapshot (undefined) as its own group', () => {
    const groups = groupBatchByModelSnapshot(
      [msg('m1'), msg('m2'), msg('m3')],
      (m) => (m.messageId === 'm2' ? 'b' : undefined),
    );
    expect(groups.map((g) => g.model)).toEqual([undefined, 'b', undefined]);
  });

  it('returns nothing for an empty batch', () => {
    expect(groupBatchByModelSnapshot([], () => 'a')).toEqual([]);
  });
});

describe('formatModelNoticeSegment (OPT-07 slice C)', () => {
  it('prefers the upstream-reported model', () => {
    expect(formatModelNoticeSegment({ reportedModel: 'gpt-5', requestedModel: 'gpt-4' })).toBe(
      ' · 本次模型：gpt-5',
    );
  });
  it('flags a requested override that was not confirmed', () => {
    expect(formatModelNoticeSegment({ requestedModel: 'gpt-4' })).toBe(
      ' · 请求模型：gpt-4（未收到实际模型确认）',
    );
  });
  it('stays silent when nothing was requested or reported', () => {
    expect(formatModelNoticeSegment({})).toBe('');
  });
});

describe('InboundJournal model snapshot (OPT-07 slice C)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
  });

  async function fresh(): Promise<{ journal: InboundJournal; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'inbound-model-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    const journal = new InboundJournal(dir);
    await journal.load();
    return { journal, dir };
  }

  it('freezes the model at acceptance and persists it across reload', async () => {
    const { journal, dir } = await fresh();
    await journal.recordAccepted({
      messageId: 'om1', scope: 'oc', chatId: 'oc', senderId: 'u',
      content: 'hi', acceptedAt: 1, chatType: 'p2p', model: 'frozen',
    });
    await journal.flush();
    const reopened = new InboundJournal(dir);
    await reopened.load();
    expect(reopened.getRecord('oc', 'om1')?.model).toBe('frozen');
  });

  it('redo preserves the ORIGINAL snapshot (no silent re-target)', async () => {
    const { journal } = await fresh();
    await journal.recordAccepted({
      messageId: 'om1', scope: 'oc', chatId: 'oc', senderId: 'u',
      content: 'x', acceptedAt: Date.now(), chatType: 'p2p', model: 'orig',
    });
    await journal.markClaimed('oc', ['om1'], 'run-1');
    await journal.recoverOnStartup(); // claimed → uncertain
    const redoId = await journal.redo('oc', 'om1', { senderId: 'u' });
    expect(redoId).toBeTruthy();
    expect(journal.getRecord('oc', redoId!)?.model).toBe('orig');
  });
});
