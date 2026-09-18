import type { ModelCatalogResult, ProviderInput } from '../model-catalog';

/**
 * Claude Code exposes `--model` (alias or full name) but has no verified,
 * stable non-interactive catalog command, so we do not fabricate a "live"
 * list. We surface a short, well-known alias set purely as input hints; the
 * CLI's own resolver is authoritative and account policy (`availableModels`)
 * may still replace or reject a choice. Manual full-name entry stays available.
 */
const CLAUDE_ALIAS_HINTS = ['sonnet', 'opus', 'haiku'] as const;

export async function discoverClaudeModels(
  input: ProviderInput,
): Promise<ModelCatalogResult> {
  return {
    agentId: 'claude',
    status: 'static',
    candidates: CLAUDE_ALIAS_HINTS.map((alias) => ({
      id: alias,
      displayName: alias,
      source: 'static' as const,
    })),
    fetchedAt: input.now(),
    note: 'Claude 无稳定列表命令：以下为常见别名提示，实际以 CLI 解析为准，也可手动输入完整模型名。',
    unverified: true,
  };
}
