import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../../../src/session/store';

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
});
