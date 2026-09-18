import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileAtomic } from '../../../src/platform/atomic-write';
import {
  ModelRevisionConflictError,
  SessionStore,
} from '../../../src/session/store';

// Controlled fault injection for the durable model-preference writes: the
// store's real atomic write is replaced so tests can sequence successes and
// failures deterministically (the Slice A record noted real-disk fault
// injection was still missing).
vi.mock('../../../src/platform/atomic-write', () => ({
  writeFileAtomic: vi.fn(),
}));

const mockedWrite = vi.mocked(writeFileAtomic);

describe('SessionStore durable model preference (OPT-07 评审修复)', () => {
  beforeEach(() => {
    mockedWrite.mockReset();
    mockedWrite.mockResolvedValue(undefined);
  });

  function freshStore(): SessionStore {
    return new SessionStore('/tmp/fake-profile/sessions.json');
  }

  it('a failed write rolls back without clobbering a later successful write', async () => {
    const store = freshStore();
    let failFirstWrite: (err: unknown) => void = () => {};
    mockedWrite.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          failFirstWrite = reject;
        }),
    );

    const first = store.setModelPreference('chat-1', 'claude', 'doomed');
    // Queued behind the in-flight write by the per-store serialization.
    const second = store.setModelPreference('chat-1', 'claude', 'winner');

    await vi.waitFor(() => expect(mockedWrite).toHaveBeenCalledTimes(1));
    failFirstWrite(new Error('EACCES: read-only filesystem'));
    await expect(first).rejects.toThrow('EACCES');
    await expect(second).resolves.toBeUndefined();

    // The rollback ran BEFORE the second write read its previous state, so
    // the survivor is the second value — not a resurrected pre-first value
    // clobbering it, and not the rolled-back first value either.
    expect(store.getModelPreference('chat-1', 'claude')?.model).toBe('winner');
    expect(store.getModelRevision('chat-1')).toBe(1);
  });

  it('a commit-time revision conflict rejects without attempting a write', async () => {
    const store = freshStore();
    await store.setModelPreference('chat-1', 'claude', 'a'); // revision -> 1
    const writesSoFar = mockedWrite.mock.calls.length;

    await expect(
      store.setModelPreference('chat-1', 'claude', 'b', 0),
    ).rejects.toBeInstanceOf(ModelRevisionConflictError);

    expect(mockedWrite.mock.calls.length).toBe(writesSoFar);
    expect(store.getModelPreference('chat-1', 'claude')?.model).toBe('a');
    expect(store.getModelRevision('chat-1')).toBe(1);
  });

  it('reports success only after the durable write resolves', async () => {
    const store = freshStore();
    let releaseWrite: () => void = () => {};
    mockedWrite.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseWrite = resolve;
        }),
    );

    const pending = store.setModelPreference('chat-1', 'claude', 'slow');
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // The write is in flight but unresolved.
    await vi.waitFor(() => expect(mockedWrite).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    releaseWrite();
    await expect(pending).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });
});
