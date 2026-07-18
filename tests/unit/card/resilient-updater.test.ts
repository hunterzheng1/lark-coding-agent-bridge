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
});
