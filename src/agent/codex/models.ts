import type { ModelCatalogResult, ProviderInput } from '../model-catalog';

interface CodexModelsProviderInput extends ProviderInput {
  binary: string;
}

/** `codex debug models --bundled` renders the offline catalog shipped with the
 * binary as JSON. `--bundled` skips the network refresh, so the result is an
 * offline candidate list, not an account-real-time authorization — the caller
 * must keep presenting it as unverified. */
export async function discoverCodexModels(
  input: CodexModelsProviderInput,
): Promise<ModelCatalogResult> {
  const exec = await input.run({
    binary: input.binary,
    args: ['debug', 'models', '--bundled'],
    timeoutMs: input.timeoutMs,
  });
  if (!exec.ok || exec.timedOut) {
    throw new Error(
      exec.timedOut ? 'codex debug models timed out' : `codex debug models failed (code=${exec.code})`,
    );
  }
  const parsed = JSON.parse(exec.stdout) as unknown;
  const models = Array.isArray(parsed)
    ? parsed
    : ((parsed as { models?: unknown })?.models ?? null);
  if (!Array.isArray(models)) {
    throw new Error('codex debug models returned no models array');
  }

  const seen = new Set<string>();
  const rows: Array<{ id: string; displayName: string; priority: number }> = [];
  for (const raw of models) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const visibility = typeof entry.visibility === 'string' ? entry.visibility : '';
    if (visibility === 'hidden' || visibility === 'hide') continue;
    const id = typeof entry.slug === 'string' ? entry.slug.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName =
      typeof entry.display_name === 'string' && entry.display_name.trim()
        ? entry.display_name.trim()
        : id;
    const priority = typeof entry.priority === 'number' ? entry.priority : Number.MAX_SAFE_INTEGER;
    rows.push({ id, displayName, priority });
  }
  rows.sort((a, b) => a.priority - b.priority);

  const fetchedAt = input.now();
  return {
    agentId: 'codex',
    status: 'ok',
    candidates: rows.map((row) => ({ id: row.id, displayName: row.displayName, source: 'cli' as const })),
    fetchedAt,
    note: '来源：随二进制附带的离线目录（--bundled）。未经过本账号实时调用验证。',
    unverified: true,
  };
}
