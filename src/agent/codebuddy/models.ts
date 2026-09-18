import type { ModelCatalogResult, ProviderInput } from '../model-catalog';

interface CodeBuddyModelsProviderInput extends ProviderInput {
  binary: string;
}

/**
 * CodeBuddy has no verified machine-readable model API. Its `--help` prints the
 * `--model` description with a `Currently supported: (id, id, …)` list, which we
 * reuse as a compatible fallback. This is help text, not an account authorization
 * proof, and the parsing is not a stable protocol — a failure here must not take
 * down `/model` (the façade degrades to manual input).
 */
export async function discoverCodeBuddyModels(
  input: CodeBuddyModelsProviderInput,
): Promise<ModelCatalogResult> {
  const exec = await input.run({
    binary: input.binary,
    args: ['--help'],
    timeoutMs: input.timeoutMs,
  });
  if (!exec.ok || exec.timedOut) {
    throw new Error(
      exec.timedOut ? 'codebuddy --help timed out' : `codebuddy --help failed (code=${exec.code})`,
    );
  }
  const ids = parseCodeBuddyHelp(exec.stdout);
  if (ids.length === 0) {
    throw new Error('codebuddy --help did not expose a supported-model list');
  }

  return {
    agentId: 'codebuddy',
    status: 'ok',
    candidates: ids.map((id) => ({ id, displayName: id, source: 'help' as const })),
    fetchedAt: input.now(),
    note: '来源：CodeBuddy `--help` 文本。非稳定接口，且未验证本账号可调用。',
    unverified: true,
  };
}

export function parseCodeBuddyHelp(help: string): string[] {
  const match = help.match(/Currently supported:\s*\(([^)]*)\)/i);
  if (!match) return [];
  const body = match[1] ?? '';
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const token of body.split(',')) {
    const id = token.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
