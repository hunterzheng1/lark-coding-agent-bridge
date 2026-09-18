import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ModelRevisionConflictError,
  SessionStore,
} from '../../../src/session/store';

describe('SessionStore model revision (OPT-07 slice B)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
  });

  async function fresh(): Promise<{ store: SessionStore; path: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'sess-rev-'));
    const path = join(dir, 'sessions.json');
    const store = new SessionStore(path);
    cleanups.push(async () => {
      await store.flush();
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    await store.load();
    return { store, path };
  }

  it('starts at 0 and increments on each set', async () => {
    const { store } = await fresh();
    expect(store.getModelRevision('chat-1')).toBe(0);
    await store.setModelPreference('chat-1', 'claude', 'a');
    expect(store.getModelRevision('chat-1')).toBe(1);
    await store.setModelPreference('chat-1', 'codex', 'b');
    expect(store.getModelRevision('chat-1')).toBe(2);
  });

  it('increments on reset too', async () => {
    const { store } = await fresh();
    await store.setModelPreference('chat-1', 'claude', 'a');
    expect(await store.clearModelPreference('chat-1', 'claude')).toBe(true);
    expect(store.getModelRevision('chat-1')).toBe(2);
  });

  it('survives /new (clear) and reload so stale cards stay stale', async () => {
    const { store, path } = await fresh();
    await store.setModelPreference('chat-1', 'claude', 'a');
    store.clear('chat-1');
    expect(store.getModelRevision('chat-1')).toBe(1);
    await store.flush();
    const reloaded = new SessionStore(path);
    await reloaded.load();
    expect(reloaded.getModelRevision('chat-1')).toBe(1);
  });

  it('rejects a commit when expectedRevision no longer matches, without state change', async () => {
    const { store } = await fresh();
    await store.setModelPreference('chat-1', 'claude', 'a'); // revision -> 1
    // A card bound to revision 0 must lose at COMMIT time, not just at the
    // earlier guard read (TOCTOU: guard and write sit across an await).
    await expect(
      store.setModelPreference('chat-1', 'claude', 'b', 0),
    ).rejects.toBeInstanceOf(ModelRevisionConflictError);
    expect(store.getModelPreference('chat-1', 'claude')?.model).toBe('a');
    expect(store.getModelRevision('chat-1')).toBe(1);
    // A matching expectation still commits.
    await store.setModelPreference('chat-1', 'claude', 'b', 1);
    expect(store.getModelPreference('chat-1', 'claude')?.model).toBe('b');
    expect(store.getModelRevision('chat-1')).toBe(2);
  });

  it('clearModelPreference honors expectedRevision too', async () => {
    const { store } = await fresh();
    await store.setModelPreference('chat-1', 'claude', 'a'); // revision -> 1
    await expect(
      store.clearModelPreference('chat-1', 'claude', 0),
    ).rejects.toBeInstanceOf(ModelRevisionConflictError);
    expect(store.getModelPreference('chat-1', 'claude')?.model).toBe('a');
    expect(store.getModelRevision('chat-1')).toBe(1);
    expect(await store.clearModelPreference('chat-1', 'claude', 1)).toBe(true);
    expect(store.getModelPreference('chat-1', 'claude')).toBeUndefined();
    expect(store.getModelRevision('chat-1')).toBe(2);
  });

  it('serializes concurrent writes so the last caller wins with a consistent revision', async () => {
    const { store } = await fresh();
    await Promise.all([
      store.setModelPreference('chat-1', 'claude', 'first'),
      store.setModelPreference('chat-1', 'claude', 'second'),
    ]);
    expect(store.getModelPreference('chat-1', 'claude')?.model).toBe('second');
    expect(store.getModelRevision('chat-1')).toBe(2);
  });
});
