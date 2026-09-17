import { describe, expect, it, vi } from 'vitest';
import { ResilientCardUpdater } from '../../../src/card/resilient-updater.js';

describe('ResilientCardUpdater', () => {
  it('retries the current card before creating a successor', async () => {
    const primaryUpdate = vi
      .fn<(card: object) => Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(undefined);
    const sendSuccessor = vi.fn().mockResolvedValue({ messageId: 'om_successor' });
    const updateMessage = vi.fn().mockResolvedValue(undefined);
    const updater = new ResilientCardUpdater({ sendSuccessor, updateMessage });
    updater.attachPrimary('om_primary', primaryUpdate);

    await updater.update({ body: 'progress' });

    expect(primaryUpdate).toHaveBeenCalledTimes(2);
    expect(sendSuccessor).not.toHaveBeenCalled();
  });

  it('continues on a successor card after persistent update failures', async () => {
    const primaryUpdate = vi.fn().mockRejectedValue(new Error('expired stream'));
    const sendSuccessor = vi.fn().mockResolvedValue({ messageId: 'om_successor' });
    const updateMessage = vi.fn().mockResolvedValue(undefined);
    const updater = new ResilientCardUpdater({ sendSuccessor, updateMessage });
    updater.attachPrimary('om_primary', primaryUpdate);

    const rollover = await updater.update({ body: 'progress' });
    await updater.update({ body: 'later' });

    expect(primaryUpdate).toHaveBeenCalledTimes(2);
    expect(sendSuccessor).toHaveBeenCalledTimes(1);
    expect(sendSuccessor).toHaveBeenCalledWith({ body: 'progress' });
    expect(updateMessage).toHaveBeenCalledWith('om_successor', { body: 'later' });
    expect(rollover).toEqual({ rolledOver: true, messageId: 'om_successor' });
  });

  // ─── OPT-02: error-class-aware behavior ──────────────────────────────────

  it('does not roll over on permanent payload errors and surfaces the error', async () => {
    const primaryUpdate = vi.fn().mockRejectedValue({ code: 230028, msg: 'audit reject' });
    const sendSuccessor = vi.fn().mockResolvedValue({ messageId: 'om_successor' });
    const updateMessage = vi.fn().mockResolvedValue(undefined);
    const updater = new ResilientCardUpdater({ sendSuccessor, updateMessage });
    updater.attachPrimary('om_primary', primaryUpdate);

    await expect(updater.update({ body: 'bad payload' })).rejects.toBeTruthy();
    expect(primaryUpdate).toHaveBeenCalledTimes(1);
    expect(sendSuccessor).not.toHaveBeenCalled();
    expect(updater.rolloverCount).toBe(0);
  });

  it('does not roll over on permission errors', async () => {
    const primaryUpdate = vi.fn().mockRejectedValue(new Error('permission denied'));
    const sendSuccessor = vi.fn().mockResolvedValue({ messageId: 'om_successor' });
    const updater = new ResilientCardUpdater({ sendSuccessor, updateMessage: vi.fn() });
    updater.attachPrimary('om_primary', primaryUpdate);

    await expect(updater.update({ body: 'x' })).rejects.toBeTruthy();
    expect(sendSuccessor).not.toHaveBeenCalled();
  });

  it('backs off between attempts on rate limiting using the injected sleep', async () => {
    const primaryUpdate = vi.fn().mockRejectedValue({ code: 9499, msg: 'too many requests' });
    const sendSuccessor = vi.fn().mockResolvedValue({ messageId: 'om_successor' });
    const sleeps: number[] = [];
    const updater = new ResilientCardUpdater({
      sendSuccessor,
      updateMessage: vi.fn(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    updater.attachPrimary('om_primary', primaryUpdate);

    const rollover = await updater.update({ body: 'x' });
    expect(rollover.rolledOver).toBe(true); // rate limit still allows rollover after retries
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(2000);
    expect(updater.rolloverCount).toBe(1);
  });

  it('counts rollovers for observability', async () => {
    const primaryUpdate = vi.fn().mockRejectedValue(new Error('streaming card session closed'));
    const sendSuccessor = vi.fn().mockResolvedValue({ messageId: 'om_s1' });
    const updater = new ResilientCardUpdater({
      sendSuccessor,
      updateMessage: vi.fn().mockRejectedValue(new Error('streaming timeout')),
    });
    updater.attachPrimary('om_primary', primaryUpdate);
    await updater.update({ body: 'a' });
    expect(updater.rolloverCount).toBe(1);
    expect(updater.lastErrorCategory).toBe('stream_closed');
  });
});
