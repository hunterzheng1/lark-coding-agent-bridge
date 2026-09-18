import type { Readable } from 'node:stream';
import type { AgentCapability } from './capability';
import type { ProfileConfig } from '../config/profile-schema';
import { mergeProcessEnv, spawnProcess } from '../platform/spawn';
import { log } from '../core/logger';
import { discoverCodexModels } from './codex/models';
import { discoverCodeBuddyModels } from './codebuddy/models';
import { discoverClaudeModels } from './claude/models';

/**
 * OPT-07 Slice B: unified model-catalog discovery.
 *
 * Shared bot/card/command code imports ONLY this façade, never the per-backend
 * runners, so the layering contract (`commands/index.ts` must not reference
 * `agent/codex` / `agent/codebuddy`) holds. Each backend discovers its own
 * candidates and reports provenance; a candidate listing is never a claim that
 * the current account can actually call it.
 */

export type ModelSource = 'cli' | 'help' | 'static';
export type ModelCatalogStatus = 'ok' | 'failed' | 'static';

export interface ModelCandidate {
  /** Value passed to `--model`. */
  id: string;
  displayName: string;
  source: ModelSource;
}

export interface ModelCatalogResult {
  agentId: string;
  status: ModelCatalogStatus;
  candidates: ModelCandidate[];
  /** Epoch ms when the underlying list was obtained (for the cache/provenance). */
  fetchedAt: number;
  /** Human-readable provenance; never contains credentials or full config. */
  note: string;
  /** True when the list is NOT an account-real-time, verified result. */
  unverified: boolean;
}

export interface ReadOnlyExecOptions {
  binary: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface ReadOnlyExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export type ReadOnlyRunner = (options: ReadOnlyExecOptions) => Promise<ReadOnlyExecResult>;

export interface ProviderInput {
  run: ReadOnlyRunner;
  timeoutMs: number;
  now: () => number;
}

export interface DiscoverModelsInput {
  capability: AgentCapability;
  profileConfig: ProfileConfig;
  cwd?: string;
  now?: () => number;
  /** Bypass the cache and re-query (the card's 刷新列表 button). */
  forceRefresh?: boolean;
  /** Injectable for tests; defaults to spawning the real binary read-only. */
  run?: ReadOnlyRunner;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { result: ModelCatalogResult; expiresAt: number }>();

export async function discoverModelCatalog(
  input: DiscoverModelsInput,
): Promise<ModelCatalogResult> {
  const now = input.now ?? Date.now;
  const run = input.run ?? defaultReadOnlyRunner;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const key = cacheKey(input);

  if (!input.forceRefresh) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) return hit.result;
  }

  let result: ModelCatalogResult;
  try {
    result = await discoverForAgent(input, { run, timeoutMs, now });
  } catch (err) {
    log.warn('model', 'catalog-discovery-failed', {
      agent: input.capability.agentId,
      message: err instanceof Error ? err.message : String(err),
    });
    result = failureResult(input.capability.agentId, now());
  }

  // Only a fresh success replaces the cache; a failure lets the caller keep
  // showing the last good list (handled above via cache hit before discovery).
  if (result.status !== 'failed') {
    cache.set(key, { result, expiresAt: now() + CACHE_TTL_MS });
  }
  return result;
}

/** Test seam + card 刷新 support. */
export function clearModelCatalogCache(): void {
  cache.clear();
}

async function discoverForAgent(
  input: DiscoverModelsInput,
  provider: ProviderInput,
): Promise<ModelCatalogResult> {
  const { capability, profileConfig } = input;
  if (capability.agentId === 'codex') {
    const codex = profileConfig.codex;
    if (!codex) return failureResult('codex', provider.now());
    // `--bundled` reads the offline catalog shipped with the binary and does
    // not touch CODEX_HOME, so discovery needs no credential-bearing config.
    return discoverCodexModels({
      ...provider,
      binary: codex.binaryPath,
    });
  }
  if (capability.agentId === 'codebuddy') {
    return discoverCodeBuddyModels({
      ...provider,
      binary: process.env.LARK_CHANNEL_CODEBUDDY_BIN ?? 'codebuddy',
    });
  }
  return discoverClaudeModels(provider);
}

function failureResult(agentId: string, now: number): ModelCatalogResult {
  return {
    agentId,
    status: 'failed',
    candidates: [],
    fetchedAt: now,
    note: '模型列表获取失败，可稍后刷新或直接手动输入模型 ID。',
    unverified: true,
  };
}

function cacheKey(input: DiscoverModelsInput): string {
  const { capability, profileConfig } = input;
  const app = profileConfig.accounts.app;
  return [capability.agentId, agentBinary(profileConfig), app.tenant, app.id].join('|');
}

function agentBinary(profileConfig: ProfileConfig): string {
  if (profileConfig.agentKind === 'codex') return profileConfig.codex?.binaryPath ?? '';
  if (profileConfig.agentKind === 'codebuddy') {
    return process.env.LARK_CHANNEL_CODEBUDDY_BIN ?? 'codebuddy';
  }
  return process.env.LARK_CHANNEL_CLAUDE_BIN ?? 'claude';
}

const defaultReadOnlyRunner: ReadOnlyRunner = (options) =>
  new Promise<ReadOnlyExecResult>((resolve) => {
    let child: ReturnType<typeof spawnProcess>;
    try {
      child = spawnProcess(options.binary, options.args, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: mergeProcessEnv(process.env, options.env ?? {}),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        ok: false,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        code: null,
        timedOut: false,
      });
      return;
    }

    const out = readAll(child.stdout as Readable);
    const err = readAll(child.stderr as Readable);
    let settled = false;
    const finish = (result: ReadOnlyExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      finish({ ok: false, stdout: '', stderr: '', code: null, timedOut: true });
    }, options.timeoutMs);

    child.once('error', (e: Error) => {
      finish({ ok: false, stdout: '', stderr: e.message, code: null, timedOut: false });
    });
    child.once('exit', async (code) => {
      const [stdout, stderr] = await Promise.all([out, err]);
      finish({ ok: code === 0, stdout, stderr, code, timedOut: false });
    });
  });

function readAll(stream: Readable): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    stream.on('data', (chunk: Buffer | string) => {
      buf += chunk.toString('utf8');
    });
    stream.on('end', () => resolve(buf));
    stream.on('error', () => resolve(buf));
  });
}
