import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isStreamingModeError,
  startStreamingCardSession,
} from '../../../src/card/streaming-session.js';

function makeChannel(overrides?: {
  updateCardById?: ReturnType<typeof vi.fn>;
  settings?: ReturnType<typeof vi.fn>;
}) {
  const updateCardById =
    overrides?.updateCardById ?? vi.fn(async (_cardId: string, _card: object, _seq: number) => {});
  const settings =
    overrides?.settings ??
    vi.fn(async (_args: { path: { card_id: string }; data: Record<string, unknown> }) => ({}));
  return {
    createCard: vi.fn(async () => ({ cardId: 'card_1' })),
    send: vi.fn(async () => ({ messageId: 'om_1' })),
    updateCardById,
    rawClient: {
      cardkit: {
        v1: {
          card: { settings },
        },
      },
    },
    settings,
  };
}

describe('isStreamingModeError', () => {
  it('detects Feishu codes 200850 and 300309', () => {
    expect(isStreamingModeError({ code: 200850 })).toBe(true);
    expect(isStreamingModeError({ code: 300309 })).toBe(true);
    expect(isStreamingModeError({ code: 123 })).toBe(false);
  });

  it('detects streaming timeout/closed messages', () => {
    expect(isStreamingModeError(new Error('Card streaming timeout'))).toBe(true);
    expect(isStreamingModeError(new Error('streaming closed'))).toBe(true);
  });
});

describe('StreamingCardSession', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('UT-001: start then update calls updateCardById with sequence 1', async () => {
    const ch = makeChannel();
    const session = await startStreamingCardSession(ch as never, 'oc_chat', { schema: '2.0' });
    expect(session.cardId).toBe('card_1');
    expect(session.messageId).toBe('om_1');
    expect(ch.createCard).toHaveBeenCalledOnce();
    expect(ch.send).toHaveBeenCalledWith('oc_chat', { cardId: 'card_1' }, undefined);

    await session.update({ body: 'a' });
    expect(ch.updateCardById).toHaveBeenCalledWith('card_1', { body: 'a' }, 1);
    session.dispose();
  });

  it('UT-002: renewEveryMs elapsed triggers settings streaming_mode true before next update', async () => {
    vi.useFakeTimers();
    const ch = makeChannel();
    let now = 1_000;
    const session = await startStreamingCardSession(ch as never, 'oc_chat', { schema: '2.0' }, {
      renewEveryMs: 100,
      now: () => now,
    });

    await session.update({ body: '1' });
    expect(ch.settings).not.toHaveBeenCalled();

    now += 150;
    await vi.advanceTimersByTimeAsync(150);
    await session.update({ body: '2' });

    expect(ch.settings).toHaveBeenCalled();
    const settingsCall = ch.settings.mock.calls[0]![0] as {
      path: { card_id: string };
      data: { settings: string; sequence: number };
    };
    expect(settingsCall.path.card_id).toBe('card_1');
    expect(JSON.parse(settingsCall.data.settings)).toEqual({
      config: { streaming_mode: true },
    });
    expect(ch.updateCardById).toHaveBeenLastCalledWith('card_1', { body: '2' }, expect.any(Number));
    const seqs = ch.updateCardById.mock.calls.map((c) => c[2] as number);
    const settingsSeqs = ch.settings.mock.calls.map(
      (c) => (c[0] as { data: { sequence: number } }).data.sequence,
    );
    const all = [...seqs, ...settingsSeqs].sort((a, b) => a - b);
    expect(new Set(all).size).toBe(all.length);
    session.dispose();
  });

  it('UT-003: update 200850 renews then retries update', async () => {
    const updateCardById = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 200850 }))
      .mockResolvedValue(undefined);
    const ch = makeChannel({ updateCardById });
    const session = await startStreamingCardSession(ch as never, 'oc_chat', { schema: '2.0' });

    await session.update({ body: 'x' });

    expect(ch.settings).toHaveBeenCalledOnce();
    expect(updateCardById).toHaveBeenCalledTimes(2);
    session.dispose();
  });

  it('UT-004: update 300309 renews then retries', async () => {
    const updateCardById = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('closed'), { code: 300309 }))
      .mockResolvedValue(undefined);
    const ch = makeChannel({ updateCardById });
    const session = await startStreamingCardSession(ch as never, 'oc_chat', { schema: '2.0' });

    await session.update({ body: 'x' });
    expect(ch.settings).toHaveBeenCalledOnce();
    expect(updateCardById).toHaveBeenCalledTimes(2);
    session.dispose();
  });

  it('UT-005: renew then retry still failing propagates', async () => {
    const updateCardById = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('timeout'), { code: 200850 }));
    const ch = makeChannel({ updateCardById });
    const session = await startStreamingCardSession(ch as never, 'oc_chat', { schema: '2.0' });

    await expect(session.update({ body: 'x' })).rejects.toMatchObject({ code: 200850 });
    expect(ch.settings).toHaveBeenCalledOnce();
    session.dispose();
  });

  it('UT-006: update after close rejects and does not call updateCardById', async () => {
    const ch = makeChannel();
    const session = await startStreamingCardSession(ch as never, 'oc_chat', { schema: '2.0' });
    await session.close();
    await expect(session.update({ body: 'late' })).rejects.toThrow(/closed/i);
    expect(ch.updateCardById).toHaveBeenCalledTimes(0);
    session.dispose();
  });

  it('Y1: close is idempotent and only sends streaming_mode false once', async () => {
    const ch = makeChannel();
    const session = await startStreamingCardSession(ch as never, 'oc_chat', { schema: '2.0' });
    await session.close();
    await session.close();
    expect(ch.settings).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it('UT-007: close sets streaming_mode false with increasing sequence', async () => {
    const ch = makeChannel();
    const session = await startStreamingCardSession(ch as never, 'oc_chat', { schema: '2.0' });
    await session.update({ body: 'a' });
    await session.close('done summary');

    expect(ch.settings).toHaveBeenCalledOnce();
    const call = ch.settings.mock.calls[0]![0] as {
      data: { settings: string; sequence: number };
    };
    expect(JSON.parse(call.data.settings)).toEqual({
      config: { streaming_mode: false, summary: { content: 'done summary' } },
    });
    expect(call.data.sequence).toBeGreaterThan(1);
    session.dispose();
  });

  it('UT-008: dispose clears timer so no further settings', async () => {
    vi.useFakeTimers();
    const ch = makeChannel();
    let now = 0;
    const session = await startStreamingCardSession(ch as never, 'oc_chat', { schema: '2.0' }, {
      renewEveryMs: 50,
      now: () => now,
    });
    session.dispose();
    now += 200;
    await vi.advanceTimersByTimeAsync(200);
    expect(ch.settings).not.toHaveBeenCalled();
  });

  it('UT-009: update+renew+close sequences are strictly increasing', async () => {
    vi.useFakeTimers();
    const ch = makeChannel();
    let now = 0;
    const session = await startStreamingCardSession(ch as never, 'oc_chat', { schema: '2.0' }, {
      renewEveryMs: 10,
      now: () => now,
    });
    await session.update({ body: '1' });
    now += 20;
    await vi.advanceTimersByTimeAsync(20);
    await session.update({ body: '2' });
    await session.close();

    const updateSeqs = ch.updateCardById.mock.calls.map((c) => c[2] as number);
    const settingsSeqs = ch.settings.mock.calls.map(
      (c) => (c[0] as { data: { sequence: number } }).data.sequence,
    );
    const merged = [...updateSeqs, ...settingsSeqs].sort((a, b) => a - b);
    for (let i = 1; i < merged.length; i++) {
      expect(merged[i]!).toBeGreaterThan(merged[i - 1]!);
    }
    session.dispose();
  });
});
