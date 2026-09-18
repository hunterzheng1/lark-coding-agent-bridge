import { readFile } from 'node:fs/promises';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';

export interface ModelPreference {
  /** Bridge-level `--model` override for the next run on this scope. */
  model: string;
  /** When this choice was saved (ms epoch). */
  savedAt: number;
}

export interface SessionEntry {
  /** May be absent if the entry was created by /timeout before any run
   * recorded a session id. Treat absence as "no resumable session". */
  sessionId?: string;
  /** Pinned cwd for the resumable session. Absent for the same reason. */
  cwd?: string;
  updatedAt: number;
  /** Per-scope idle-timeout override (minutes). 0 = explicitly off for this
   * scope, undefined = follow global default. Session resets preserve this
   * scope preference while removing the resumable session id/cwd. */
  idleTimeoutMinutes?: number;
  /** Final agent text of the last completed run on this scope (for /last). */
  lastRunOutput?: string;
  /** OPT-07: bridge model override, isolated per Agent backend so switching
   * backends never reuses another backend's model id. Absent = follow the
   * CLI's own resolution (no `--model` passed). Preserved across /new and
   * /resume like idleTimeoutMinutes. */
  modelPreferences?: Record<string, ModelPreference>;
  /** OPT-07 Slice B: monotonic per-scope counter bumped on every model
   * preference write. Selection cards bind it so a stale card cannot
   * overwrite a newer choice. */
  modelRevision?: number;
}

type SessionMap = Record<string, SessionEntry>;

export class SessionStore {
  private data: SessionMap = {};
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string = paths.sessionsFile) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const raw = JSON.parse(text) as Record<string, Partial<SessionEntry>>;
      this.data = {};
      for (const [chatId, entry] of Object.entries(raw)) {
        if (!entry || typeof entry.updatedAt !== 'number') continue;
        // Drop entries without a `cwd`/`sessionId` pair *unless* there's
        // some other persisted state worth keeping (e.g. an idle-timeout
        // override). Resuming a session whose cwd we don't know about
        // would hang claude on a missing jsonl, so resume keys still need
        // the full pair; but a bare timeout override is fine on its own.
        const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : undefined;
        const cwd = typeof entry.cwd === 'string' ? entry.cwd : undefined;
        const idleTimeoutMinutes =
          typeof entry.idleTimeoutMinutes === 'number' ? entry.idleTimeoutMinutes : undefined;
        const lastRunOutput =
          typeof entry.lastRunOutput === 'string' ? entry.lastRunOutput : undefined;
        const modelPreferences = parseModelPreferences(entry.modelPreferences);
        const modelRevision =
          typeof entry.modelRevision === 'number' ? entry.modelRevision : undefined;
        const hasSession = sessionId !== undefined && cwd !== undefined;
        if (
          !hasSession &&
          idleTimeoutMinutes === undefined &&
          lastRunOutput === undefined &&
          modelPreferences === undefined
        ) {
          continue;
        }
        this.data[chatId] = {
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          updatedAt: entry.updatedAt,
          ...(idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes } : {}),
          ...(lastRunOutput !== undefined ? { lastRunOutput } : {}),
          ...(modelPreferences !== undefined ? { modelPreferences } : {}),
          ...(modelRevision !== undefined ? { modelRevision } : {}),
        };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  /**
   * Return the session id for this chat if it was created in the given cwd.
   * Sessions recorded in a different cwd are stale — claude can't resume
   * them from a different working directory.
   */
  resumeFor(chatId: string, cwd: string): string | undefined {
    const entry = this.data[chatId];
    if (!entry) return undefined;
    if (entry.cwd !== cwd) return undefined;
    return entry.sessionId;
  }

  getRaw(chatId: string): SessionEntry | undefined {
    return this.data[chatId];
  }

  set(chatId: string, sessionId: string, cwd: string): void {
    // Preserve idleTimeoutMinutes across run starts — it's a per-scope
    // preference, not per-run-instance state. /new (clear) wipes it.
    const prev = this.data[chatId];
    this.data[chatId] = {
      sessionId,
      cwd,
      updatedAt: Date.now(),
      ...(prev?.idleTimeoutMinutes !== undefined
        ? { idleTimeoutMinutes: prev.idleTimeoutMinutes }
        : {}),
      ...(prev?.lastRunOutput !== undefined ? { lastRunOutput: prev.lastRunOutput } : {}),
      ...(prev?.modelPreferences !== undefined
        ? { modelPreferences: prev.modelPreferences }
        : {}),
      ...(prev?.modelRevision !== undefined ? { modelRevision: prev.modelRevision } : {}),
    };
    this.schedulePersist();
  }

  clear(chatId: string): void {
    const prev = this.data[chatId];
    if (!prev) return;
    // /new clears the resumable session (sessionId/cwd) and last-run output,
    // but keeps per-scope preferences: idle-timeout override and the OPT-07
    // model preference + revision.
    const keepModel = prev.modelPreferences !== undefined || prev.modelRevision !== undefined;
    if (prev.idleTimeoutMinutes === undefined && !keepModel) {
      delete this.data[chatId];
      this.schedulePersist();
      return;
    }
    this.data[chatId] = {
      ...(prev.idleTimeoutMinutes !== undefined
        ? { idleTimeoutMinutes: prev.idleTimeoutMinutes }
        : {}),
      ...(prev.modelPreferences !== undefined
        ? { modelPreferences: prev.modelPreferences }
        : {}),
      ...(prev.modelRevision !== undefined ? { modelRevision: prev.modelRevision } : {}),
      updatedAt: Date.now(),
    };
    this.schedulePersist();
  }

  /** Per-scope idle-timeout override. `undefined` means no override set. */
  getIdleTimeoutMinutes(chatId: string): number | undefined {
    return this.data[chatId]?.idleTimeoutMinutes;
  }

  setIdleTimeoutMinutes(chatId: string, minutes: number): void {
    const clamped = Math.min(Math.max(Math.floor(minutes), 0), 120);
    const prev = this.data[chatId];
    this.data[chatId] = {
      ...(prev ?? { updatedAt: Date.now() }),
      idleTimeoutMinutes: clamped,
      updatedAt: Date.now(),
    };
    this.schedulePersist();
  }

  /** Remove the override so this scope falls back to the global default.
   * Returns true if something was actually removed. */
  clearIdleTimeoutOverride(chatId: string): boolean {
    const prev = this.data[chatId];
    if (!prev || prev.idleTimeoutMinutes === undefined) return false;
    const { idleTimeoutMinutes: _, ...rest } = prev;
    this.data[chatId] = { ...rest, updatedAt: Date.now() };
    this.schedulePersist();
    return true;
  }

  /** Final agent text of the last completed run on this scope (for /last). */
  getLastRunOutput(chatId: string): string | undefined {
    return this.data[chatId]?.lastRunOutput;
  }

  setLastRunOutput(chatId: string, text: string): void {
    const prev = this.data[chatId];
    this.data[chatId] = {
      ...(prev ?? { updatedAt: Date.now() }),
      lastRunOutput: text,
      updatedAt: Date.now(),
    };
    this.schedulePersist();
  }

  /** OPT-07: bridge model override for this scope + Agent backend. */
  getModelPreference(chatId: string, agentId: string): ModelPreference | undefined {
    return this.data[chatId]?.modelPreferences?.[agentId];
  }

  /** OPT-07 Slice B: current per-scope model revision (0 when never written). */
  getModelRevision(chatId: string): number {
    return this.data[chatId]?.modelRevision ?? 0;
  }

  /**
   * Save the model override and wait until it is durably on disk before
   * resolving (rule: acknowledge success only after persistence). On write
   * failure the previous value is restored and the error rethrown.
   */
  async setModelPreference(chatId: string, agentId: string, model: string): Promise<void> {
    const prev = this.data[chatId];
    const next: SessionEntry = {
      ...(prev ?? { updatedAt: Date.now() }),
      modelPreferences: {
        ...(prev?.modelPreferences ?? {}),
        [agentId]: { model, savedAt: Date.now() },
      },
      modelRevision: (prev?.modelRevision ?? 0) + 1,
      updatedAt: Date.now(),
    };
    await this.commitPreference(chatId, prev, next);
  }

  /**
   * Remove the override so the scope follows the CLI's own model resolution.
   * Resolves false when nothing was set (no write). Resolves true only after
   * the removal is durably persisted; restores the prior value on write
   * failure and rethrows.
   */
  async clearModelPreference(chatId: string, agentId: string): Promise<boolean> {
    const prev = this.data[chatId];
    const existing = prev?.modelPreferences?.[agentId];
    if (!prev || !existing) return false;
    const remaining = { ...prev.modelPreferences };
    delete remaining[agentId];
    const { modelPreferences: _drop, ...rest } = prev;
    const next: SessionEntry = {
      ...rest,
      ...(Object.keys(remaining).length > 0 ? { modelPreferences: remaining } : {}),
      modelRevision: (prev.modelRevision ?? 0) + 1,
      updatedAt: Date.now(),
    };
    await this.commitPreference(chatId, prev, next);
    return true;
  }

  private async commitPreference(
    chatId: string,
    prev: SessionEntry | undefined,
    next: SessionEntry,
  ): Promise<void> {
    this.data[chatId] = next;
    try {
      await this.persist();
    } catch (err) {
      if (prev) this.data[chatId] = prev;
      else delete this.data[chatId];
      throw err;
    }
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  /** Chain a write after all in-flight writes; resolves on success, rejects
   * this caller on failure while the shared chain keeps advancing. */
  private persist(): Promise<void> {
    const next = this.saving.then(() =>
      writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`, {
        mode: 0o600,
      }),
    );
    this.saving = next.catch(() => {});
    return next;
  }

  private schedulePersist(): void {
    this.persist().catch((err: unknown) => {
      log.fail('session', err, { step: 'persist' });
    });
  }
}

function parseModelPreferences(
  raw: unknown,
): Record<string, ModelPreference> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, ModelPreference> = {};
  let count = 0;
  for (const [agentId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.model !== 'string' || entry.model.length === 0) continue;
    if (typeof entry.savedAt !== 'number') continue;
    out[agentId] = { model: entry.model, savedAt: entry.savedAt };
    count += 1;
  }
  return count > 0 ? out : undefined;
}
