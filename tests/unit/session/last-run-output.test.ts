import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/session/store';

describe('SessionStore lastRunOutput', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
  });

  async function fresh(path?: string): Promise<{ store: SessionStore; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'sess-last-'));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const store = new SessionStore(path ?? join(dir, 'sessions.json'));
    await store.load();
    return { store, dir };
  }

  it('set/get lastRunOutput', async () => {
    const { store } = await fresh();
    store.setLastRunOutput('chat-1', 'line1\nline2\nline3');
    expect(store.getLastRunOutput('chat-1')).toBe('line1\nline2\nline3');
  });

  it('returns undefined when no lastRunOutput', async () => {
    const { store } = await fresh();
    expect(store.getLastRunOutput('chat-1')).toBeUndefined();
  });

  it('clear removes lastRunOutput', async () => {
    const { store } = await fresh();
    store.setLastRunOutput('chat-1', 'result');
    store.clear('chat-1');
    expect(store.getLastRunOutput('chat-1')).toBeUndefined();
  });

  it('set() preserves lastRunOutput across run starts', async () => {
    const { store } = await fresh();
    store.setLastRunOutput('chat-1', 'old result');
    store.set('chat-1', 'sess-1', '/cwd');
    expect(store.getLastRunOutput('chat-1')).toBe('old result');
  });

  it('setLastRunOutput preserves existing session fields', async () => {
    const { store } = await fresh();
    store.set('chat-1', 'sess-1', '/cwd');
    store.setLastRunOutput('chat-1', 'final text');
    expect(store.getRaw('chat-1')?.sessionId).toBe('sess-1');
    expect(store.getLastRunOutput('chat-1')).toBe('final text');
  });

  it('persists across load', async () => {
    const { store, dir } = await fresh();
    const path = join(dir, 'sessions.json');
    store.setLastRunOutput('chat-1', 'persisted');
    await store.flush();
    const s2 = new SessionStore(path);
    await s2.load();
    expect(s2.getLastRunOutput('chat-1')).toBe('persisted');
  });
});
