import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

/**
 * Per-run thinking records backing the `/thinking` entry (OPT-01B).
 *
 * Records hold exactly what the bridge received on the `thinking` event
 * stream — never model-internal reasoning the upstream did not emit. Identity
 * is Profile (implicit — the store lives under the profile dir) + Scope +
 * runId, so an old card's entry keeps resolving to its own run instead of
 * silently sliding to the latest one. Storage is one JSON file per scope
 * under the profile's thinking dir, atomic-write with 0600, bounded by
 * DEFAULT_THINKING_LIMITS (run count per scope, chars per run, age).
 */

export interface ThinkingRecordMeta {
  runId: string;
  agent: string;
  startedAt: number;
  endedAt: number;
  terminal: string;
  hasThinking: boolean;
  originalChars: number;
  storedChars: number;
  /** true when the storage cap cut the record — head preserved, marked. */
  partial: boolean;
}

export interface ThinkingRecord extends ThinkingRecordMeta {
  scope: string;
  content: string;
}

export type ThinkingLookup =
  | { kind: 'found'; record: ThinkingRecord }
  | { kind: 'ambiguous'; candidateIds: string[] }
  | { kind: 'missing' };

export interface ThinkingHistoryLimits {
  maxRunsPerScope: number;
  maxCharsPerRun: number;
  maxAgeMs: number;
}

export const DEFAULT_THINKING_LIMITS: Readonly<ThinkingHistoryLimits> = {
  maxRunsPerScope: 20,
  maxCharsPerRun: 100_000,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
};

interface ScopeFile {
  version: 1;
  records: ThinkingRecord[];
}

export class ThinkingHistoryStore {
  private readonly limits: ThinkingHistoryLimits;
  private readonly scopes = new Map<string, ThinkingRecord[]>();
  private readonly persistQueue = new Map<string, Promise<boolean>>();

  constructor(
    private readonly dir: string,
    limits: Partial<ThinkingHistoryLimits> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.limits = { ...DEFAULT_THINKING_LIMITS, ...limits };
  }

  /** Load persisted records. One corrupt file is skipped, not fatal. */
  async load(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return; // no thinking dir yet — first boot
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await readFile(join(this.dir, file), 'utf8')) as ScopeFile;
        if (raw.version !== 1 || !Array.isArray(raw.records)) continue;
        for (const record of raw.records) {
          if (!record || typeof record.runId !== 'string' || typeof record.content !== 'string') {
            continue;
          }
          const list = this.scopes.get(record.scope) ?? [];
          list.push(record);
          this.scopes.set(record.scope, list);
        }
      } catch (err) {
        log.warn('thinking', 'load-corrupt-skipped', {
          file,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Persist one terminal run's thinking (possibly empty — empty records keep
   * the latest-run semantics honest). Resolves false when persistence failed;
   * callers must not advertise a saved record then.
   */
  async save(input: {
    scope: string;
    runId: string;
    agent: string;
    startedAt: number;
    endedAt: number;
    terminal: string;
    content: string;
  }): Promise<boolean> {
    try {
      await mkdir(this.dir, { recursive: true });
    } catch (err) {
      log.fail('thinking', err, { step: 'mkdir', scope: input.scope });
      return false;
    }
    const capped = capContent(input.content, this.limits.maxCharsPerRun);
    const record: ThinkingRecord = {
      runId: input.runId,
      scope: input.scope,
      agent: input.agent,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      terminal: input.terminal,
      hasThinking: input.content.length > 0,
      originalChars: input.content.length,
      storedChars: capped.content.length,
      partial: capped.partial,
      content: capped.content,
    };
    const list = this.scopes.get(input.scope) ?? [];
    const existingIdx = list.findIndex((r) => r.runId === record.runId);
    if (existingIdx >= 0) list[existingIdx] = record;
    else list.push(record);
    const alive = list.filter((r) => this.now() - r.endedAt <= this.limits.maxAgeMs);
    const trimmed = alive.slice(-this.limits.maxRunsPerScope);
    this.scopes.set(input.scope, trimmed);

    const prev = this.persistQueue.get(input.scope) ?? Promise.resolve(true);
    const task = prev.then(() => this.persistScope(input.scope));
    this.persistQueue.set(input.scope, task);
    return task;
  }

  /** Metadata (no content) newest-first; expired records are dropped lazily. */
  list(scope: string): ThinkingRecordMeta[] {
    return this.alive(scope)
      .slice()
      .reverse()
      .map(({ content: _content, ...meta }) => meta);
  }

  /**
   * Look up a run by exact id or unique prefix, restricted to one scope —
   * a runId is never an authorization token, and cross-scope lookups
   * structurally miss.
   */
  get(scope: string, runIdOrPrefix: string): ThinkingLookup {
    const records = this.alive(scope);
    const exact = records.find((r) => r.runId === runIdOrPrefix);
    if (exact) return { kind: 'found', record: exact };
    if (runIdOrPrefix.length < 2) {
      return { kind: 'ambiguous', candidateIds: records.map((r) => r.runId) };
    }
    const matches = records.filter((r) => r.runId.startsWith(runIdOrPrefix));
    if (matches.length === 1) return { kind: 'found', record: matches[0]! };
    if (matches.length > 1) {
      return { kind: 'ambiguous', candidateIds: matches.map((r) => r.runId) };
    }
    return { kind: 'missing' };
  }

  async flush(): Promise<void> {
    await Promise.all([...this.persistQueue.values()]);
  }

  private alive(scope: string): ThinkingRecord[] {
    const records = this.scopes.get(scope) ?? [];
    return records.filter((r) => this.now() - r.endedAt <= this.limits.maxAgeMs);
  }

  private async persistScope(scope: string): Promise<boolean> {
    const records = this.scopes.get(scope) ?? [];
    const file: ScopeFile = { version: 1, records };
    try {
      await writeFileAtomic(this.fileFor(scope), `${JSON.stringify(file)}\n`, { mode: 0o600 });
      return true;
    } catch (err) {
      log.fail('thinking', err, { step: 'persist', scope });
      return false;
    }
  }

  private fileFor(scope: string): string {
    // Windows-safe, bounded-length name: sanitized prefix + hash of the full
    // scope (injective in practice, avoids %XX-expanded path blowups).
    const prefix = scope.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
    const hash = createHash('sha256').update(scope).digest('hex').slice(0, 12);
    return join(this.dir, `thinking-${prefix}-${hash}.json`);
  }
}

/** Cut stored content at a cap without splitting a surrogate pair. */
function capContent(content: string, max: number): { content: string; partial: boolean } {
  if (content.length <= max) return { content, partial: false };
  let cut = max;
  const last = content.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return { content: content.slice(0, cut), partial: true };
}

export function shortRunId(runId: string): string {
  return runId.slice(0, 8);
}

/**
 * Decorate a terminal notice with the `/thinking <runId>` entry — only when
 * the record was actually saved and actually has content. A failed save must
 * not advertise a working history entry.
 */
export function appendThinkingHint(
  notice: string,
  opts: { saved: boolean; hasThinking: boolean; runId: string },
): string {
  if (!opts.saved || !opts.hasThinking) return notice;
  return `${notice} · /thinking ${shortRunId(opts.runId)} 查看思考记录`;
}
