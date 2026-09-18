import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../../../src/session/store';

describe('SessionStore model preference (OPT-07)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c()));
  });

  async function fresh(): Promise<{ store: SessionStore; path: string; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'sess-model-'));
    const path = join(dir, 'sessions.json');
    const store = new SessionStore(path);
    cleanups.push(async () => {
      await store.flush();
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    await store.load();
    return { store, path, dir };
  }

  it('sets and reads back per-agent selection', async () => {
    const { store } = await fresh();
    await store.setModelPreference('chat-1', 'claude', 'claude-sonnet-4');
    expect(store.getModelPreference('chat-1', 'claude')?.model).toBe('claude-sonnet-4');
  });

  it('isolates selections per Agent backend', async () => {
    const { store } = await fresh();
    await store.setModelPreference('chat-1', 'claude', 'claude-sonnet-4');
    await store.setModelPreference('chat-1', 'codex', 'gpt-5');
    expect(store.getModelPreference('chat-1', 'claude')?.model).toBe('claude-sonnet-4');
    expect(store.getModelPreference('chat-1', 'codex')?.model).toBe('gpt-5');
    expect(store.getModelPreference('chat-1', 'codebuddy')).toBeUndefined();
  });

  it('returns undefined for an unset backend', async () => {
    const { store } = await fresh();
    expect(store.getModelPreference('chat-1', 'claude')).toBeUndefined();
  });

  it('is resolved only after the value is durably on disk', async () => {
    const { store, path } = await fresh();
    await store.setModelPreference('chat-1', 'claude', 'model-x');
    // A brand-new store loading the same file must see the value without the
    // original instance flushing again — proves the setter awaited the write.
    const reloaded = new SessionStore(path);
    await reloaded.load();
    expect(reloaded.getModelPreference('chat-1', 'claude')?.model).toBe('model-x');
  });

  it('preserves the preference across /new (clear) but drops the session id', async () => {
    const { store } = await fresh();
    store.set('chat-1', 'sess-1', '/cwd');
    store.setLastRunOutput('chat-1', 'previous result');
    await store.setModelPreference('chat-1', 'claude', 'model-y');
    store.clear('chat-1');
    expect(store.getRaw('chat-1')?.sessionId).toBeUndefined();
    expect(store.getLastRunOutput('chat-1')).toBeUndefined();
    expect(store.getModelPreference('chat-1', 'claude')?.model).toBe('model-y');
  });

  it('persists a lone preference across reload after clear', async () => {
    const { store, path } = await fresh();
    store.set('chat-1', 'sess-1', '/cwd');
    await store.setModelPreference('chat-1', 'codex', 'thread-model');
    store.clear('chat-1');
    await store.flush();
    const reloaded = new SessionStore(path);
    await reloaded.load();
    expect(reloaded.getModelPreference('chat-1', 'codex')?.model).toBe('thread-model');
    expect(reloaded.getRaw('chat-1')?.sessionId).toBeUndefined();
  });

  it('preserves the preference across run starts (set)', async () => {
    const { store } = await fresh();
    await store.setModelPreference('chat-1', 'claude', 'stable-model');
    store.set('chat-1', 'sess-2', '/cwd2');
    expect(store.getModelPreference('chat-1', 'claude')?.model).toBe('stable-model');
  });

  it('clearModelPreference removes only the targeted backend', async () => {
    const { store } = await fresh();
    await store.setModelPreference('chat-1', 'claude', 'a');
    await store.setModelPreference('chat-1', 'codex', 'b');
    expect(await store.clearModelPreference('chat-1', 'claude')).toBe(true);
    expect(store.getModelPreference('chat-1', 'claude')).toBeUndefined();
    expect(store.getModelPreference('chat-1', 'codex')?.model).toBe('b');
  });

  it('clearModelPreference resolves false when nothing was set', async () => {
    const { store } = await fresh();
    expect(await store.clearModelPreference('chat-1', 'claude')).toBe(false);
    store.set('chat-1', 'sess-1', '/cwd');
    expect(await store.clearModelPreference('chat-1', 'claude')).toBe(false);
    expect(store.getRaw('chat-1')?.sessionId).toBe('sess-1');
  });

  it('keeps profiles isolated (separate store files never share selections)', async () => {
    const profileA = await fresh();
    const profileB = await fresh();
    await profileA.store.setModelPreference('chat-1', 'claude', 'profile-a-model');
    expect(profileA.store.getModelPreference('chat-1', 'claude')?.model).toBe('profile-a-model');
    // A different Profile is a different sessions file; nothing bleeds over.
    expect(profileB.store.getModelPreference('chat-1', 'claude')).toBeUndefined();
  });

  it('keeps regular-group and topic scopes isolated within a profile', async () => {
    const { store } = await fresh();
    await store.setModelPreference('chat-1', 'claude', 'group-model');
    await store.setModelPreference('chat-1:thread-9', 'claude', 'topic-model');
    expect(store.getModelPreference('chat-1', 'claude')?.model).toBe('group-model');
    expect(store.getModelPreference('chat-1:thread-9', 'claude')?.model).toBe('topic-model');
  });

  it('drops malformed model preference records on load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sess-model-bad-'));
    cleanups.push(async () =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    );
    const path = join(dir, 'sessions.json');
    await (await import('node:fs/promises')).writeFile(
      path,
      JSON.stringify({
        'chat-1': {
          updatedAt: 1,
          modelPreferences: {
            claude: { model: 'ok' }, // missing savedAt → dropped
            codex: { model: 'good', savedAt: 2 },
            codebuddy: 'not-an-object',
          },
        },
      }),
      'utf8',
    );
    const store = new SessionStore(path);
    await store.load();
    expect(store.getModelPreference('chat-1', 'claude')).toBeUndefined();
    expect(store.getModelPreference('chat-1', 'codebuddy')).toBeUndefined();
    expect(store.getModelPreference('chat-1', 'codex')?.model).toBe('good');
  });
});
