import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ThinkingHistoryStore,
  appendThinkingHint,
  shortRunId,
  type ThinkingHistoryLimits,
  type ThinkingRecord,
} from '../../../src/session/thinking-history';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function freshDir(prefix = 'thinking-hist-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return dir;
}

function store(
  dir: string,
  limits?: Partial<ThinkingHistoryLimits>,
): ThinkingHistoryStore {
  return new ThinkingHistoryStore(dir, limits);
}

function input(overrides: Partial<Parameters<ThinkingHistoryStore['save']>[0]> = {}) {
  const now = Date.now();
  return {
    scope: 'oc_chat1',
    runId: '11111111-2222-3333-4444-555555555555',
    agent: 'codebuddy',
    startedAt: now - 1_000,
    endedAt: now,
    terminal: 'done',
    content: 'first thought\nsecond thought',
    ...overrides,
  };
}

describe('ThinkingHistoryStore', () => {
  it('save → list returns meta newest-first; get by exact runId returns full content', async () => {
    const dir = await freshDir();
    const s = store(dir);
    await s.save(input({ runId: 'aaaaaaaa-1' }));
    await s.save(input({ runId: 'bbbbbbbb-2', content: 'later' }));

    const metas = s.list('oc_chat1');
    expect(metas).toHaveLength(2);
    expect(metas[0]!.runId).toBe('bbbbbbbb-2');
    expect(metas[1]!.runId).toBe('aaaaaaaa-1');
    expect(metas[0]!.hasThinking).toBe(true);

    const found = s.get('oc_chat1', 'aaaaaaaa-1');
    expect(found.kind).toBe('found');
    if (found.kind === 'found') {
      expect(found.record.content).toBe('first thought\nsecond thought');
      expect(found.record.scope).toBe('oc_chat1');
    }
  });

  it('get resolves unique runId prefix; reports ambiguous and missing distinctly', async () => {
    const dir = await freshDir();
    const s = store(dir);
    await s.save(input({ runId: 'aaaaaaaa-1' }));
    await s.save(input({ runId: 'abbbbbbb-2' }));

    expect(s.get('oc_chat1', 'aaaaaaaa').kind).toBe('found');
    const ambiguous = s.get('oc_chat1', 'a');
    expect(ambiguous.kind).toBe('ambiguous');
    if (ambiguous.kind === 'ambiguous') {
      expect(ambiguous.candidateIds.sort()).toEqual(['aaaaaaaa-1', 'abbbbbbb-2']);
    }
    expect(s.get('oc_chat1', 'fffffff').kind).toBe('missing');
  });

  it('records are isolated per scope: runId lookup in another scope is missing', async () => {
    const dir = await freshDir();
    const s = store(dir);
    await s.save(input({ scope: 'oc_chat1', runId: 'aaaaaaaa-1' }));
    expect(s.get('oc_other', 'aaaaaaaa-1').kind).toBe('missing');
    expect(s.list('oc_other')).toHaveLength(0);
  });

  it('run without thinking is recorded (hasThinking=false) so latest-run semantics stay honest', async () => {
    const dir = await freshDir();
    const s = store(dir);
    await s.save(input({ runId: 'aaaaaaaa-1', content: '' }));
    const metas = s.list('oc_chat1');
    expect(metas).toHaveLength(1);
    expect(metas[0]!.hasThinking).toBe(false);
    const found = s.get('oc_chat1', 'aaaaaaaa-1');
    if (found.kind === 'found') expect(found.record.content).toBe('');
  });

  it('keeps at most maxRunsPerScope records per scope, dropping the oldest', async () => {
    const dir = await freshDir();
    const s = store(dir, { maxRunsPerScope: 3 });
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      await s.save(input({ runId: `run-${i}`, endedAt: base + i }));
    }
    expect(s.list('oc_chat1').map((m) => m.runId)).toEqual(['run-4', 'run-3', 'run-2']);
    expect(s.get('oc_chat1', 'run-0').kind).toBe('missing');
    expect(s.get('oc_chat1', 'run-1').kind).toBe('missing');
  });

  it('drops records older than maxAgeMs lazily on list/get', async () => {
    const dir = await freshDir();
    const now = { value: 10_000 };
    const s = new ThinkingHistoryStore(dir, { maxAgeMs: 1_000 }, () => now.value);
    await s.save(input({ runId: 'old-run', endedAt: 5_000 }));
    now.value = 20_000;
    expect(s.list('oc_chat1')).toHaveLength(0);
    expect(s.get('oc_chat1', 'old-run').kind).toBe('missing');
  });

  it('marks partial records explicitly when content exceeds maxCharsPerRun (head preserved)', async () => {
    const dir = await freshDir();
    const s = store(dir, { maxCharsPerRun: 100 });
    const content = `${'x'.repeat(90)}😀${'y'.repeat(50)}TAIL_LOST`;
    await s.save(input({ runId: 'big-run', content }));
    const found = s.get('oc_chat1', 'big-run');
    expect(found.kind).toBe('found');
    if (found.kind === 'found') {
      const r: ThinkingRecord = found.record;
      expect(r.partial).toBe(true);
      expect(r.originalChars).toBe(content.length);
      expect(r.storedChars).toBe(r.content.length);
      expect(r.storedChars).toBeLessThanOrEqual(101);
      // Stored head must be a prefix of the original (surrogate-safe cut).
      expect(content.startsWith(r.content)).toBe(true);
      expect(r.content.includes('😀')).toBe(true);
    }
  });

  it('survives reload: records persist to the profile dir and load again', async () => {
    const dir = await freshDir();
    const s1 = store(dir);
    await s1.save(input({ runId: 'aaaaaaaa-1', content: ' persisted '.trim() }));
    await s1.flush();

    const s2 = store(dir);
    await s2.load();
    const found = s2.get('oc_chat1', 'aaaaaaaa-1');
    expect(found.kind).toBe('found');
    if (found.kind === 'found') expect(found.record.content).toBe('persisted');
  });

  it('tolerates a corrupt scope file on load instead of crashing startup', async () => {
    const dir = await freshDir();
    await writeFile(join(dir, 'corrupt-file.json'), '{not json', 'utf8');
    const s = store(dir);
    await expect(s.load()).resolves.toBeUndefined();
    expect(s.list('oc_anything')).toHaveLength(0);
  });

  it('save reports failure (false) when the directory cannot be created', async () => {
    const dir = await freshDir();
    // Occupy the thinking dir path with a *file* so mkdir fails.
    const blocker = join(dir, 'not-a-dir');
    await writeFile(blocker, 'occupied', 'utf8');
    const s = store(blocker);
    await expect(s.save(input())).resolves.toBe(false);
  });

  it('re-saving the same runId replaces the record instead of duplicating', async () => {
    const dir = await freshDir();
    const s = store(dir);
    await s.save(input({ runId: 'aaaaaaaa-1', content: 'v1' }));
    await s.save(input({ runId: 'aaaaaaaa-1', content: 'v2' }));
    expect(s.list('oc_chat1')).toHaveLength(1);
    const found = s.get('oc_chat1', 'aaaaaaaa-1');
    if (found.kind === 'found') expect(found.record.content).toBe('v2');
  });

  it('unicode content roundtrips exactly through save → get', async () => {
    const dir = await freshDir();
    const s = store(dir);
    const content = '中文思考 🧠\n```js\ncode\n```\ne\u0301 combining';
    await s.save(input({ runId: 'aaaaaaaa-1', content }));
    await s.flush();
    const s2 = store(dir);
    await s2.load();
    const found = s2.get('oc_chat1', 'aaaaaaaa-1');
    if (found.kind === 'found') expect(found.record.content).toBe(content);
  });
});

describe('shortRunId / appendThinkingHint', () => {
  it('shortRunId returns a stable short prefix', () => {
    expect(shortRunId('11111111-2222-3333-4444-555555555555')).toBe('11111111');
    expect(shortRunId('short')).toBe('short');
  });

  it('appendThinkingHint only decorates the notice when saved with content', () => {
    const base = '✅ 完成 · 耗时 1m · 0 工具 · /doctor 查详情';
    expect(appendThinkingHint(base, { saved: true, hasThinking: true, runId: '11111111-2222' })).toBe(
      `${base} · /thinking 11111111 查看思考记录`,
    );
    expect(appendThinkingHint(base, { saved: true, hasThinking: false, runId: '11111111' })).toBe(base);
    expect(appendThinkingHint(base, { saved: false, hasThinking: true, runId: '11111111' })).toBe(base);
  });
});
