import type { ToolEntry } from './run-state';
import { toolHeaderText } from './tool-render';

export const TOOL_SUMMARY_THRESHOLD = 3;

const MAX_TOOL_TYPES = 5;
const MAX_RECENT_TOOLS = 2;
const MAX_FAILED_TOOLS = 3;
const MAX_VISIBLE_TOOL_HEADERS = 4;

export interface ToolCallSummary {
  title: string;
  body: string;
}

/**
 * Build a bounded summary for a tool-call collection. The renderer keeps the
 * complete ToolEntry list in RunState for diagnostics, but the user-facing
 * representation stays O(1) as the number of calls grows.
 */
export function summarizeToolCalls(tools: ToolEntry[], finalized: boolean): ToolCallSummary {
  const statusCounts = { done: 0, error: 0, running: 0 };
  const typeCounts = new Map<string, number>();

  for (const tool of tools) {
    statusCounts[tool.status] += 1;
    typeCounts.set(tool.name, (typeCounts.get(tool.name) ?? 0) + 1);
  }

  const statusParts: string[] = [];
  if (statusCounts.done > 0) statusParts.push(`${statusCounts.done} 成功`);
  if (statusCounts.error > 0) statusParts.push(`${statusCounts.error} 失败`);
  if (statusCounts.running > 0) statusParts.push(`${statusCounts.running} 运行中`);

  const suffix = finalized ? '（已结束）' : '';
  const titleParts = [`${tools.length} 个工具调用${suffix}`, ...statusParts];
  const lines = [formatTypeCounts(typeCounts)];
  // Small collections can show every header inside the one container. Once a
  // collection crosses the threshold, keep at least one header hidden so the
  // summary never grows linearly with the number of calls.
  const visibleHeaderBudget = tools.length < TOOL_SUMMARY_THRESHOLD
    ? tools.length
    : Math.min(MAX_VISIBLE_TOOL_HEADERS, Math.max(0, tools.length - 1));
  const running = tools.filter((tool) => tool.status === 'running');
  const visibleRunning = running.slice(-Math.min(1, visibleHeaderBudget));
  let remainingHeaderBudget = visibleHeaderBudget - visibleRunning.length;
  const failed = tools.filter((tool) => tool.status === 'error');
  const visibleFailed = failed.slice(-Math.min(MAX_FAILED_TOOLS, remainingHeaderBudget));
  remainingHeaderBudget -= visibleFailed.length;
  const recentBudget = Math.min(
    MAX_RECENT_TOOLS,
    remainingHeaderBudget,
  );
  const recent = recentBudget > 0
    ? tools
        .filter((tool) => tool.status === 'done')
        .slice(-recentBudget)
    : [];
  if (visibleRunning.length > 0) {
    lines.push(`**当前** ${visibleRunning.map(toolHeaderText).join(' · ')}`);
  }
  if (recent.length > 0) {
    lines.push(`**最近** ${recent.map(toolHeaderText).join(' · ')}`);
  }

  if (failed.length > 0) {
    lines.push('**失败详情**');
    for (const tool of visibleFailed) {
      lines.push(`- ${toolHeaderText(tool)}`);
    }
    if (failed.length > visibleFailed.length) {
      lines.push(`_另有 ${failed.length - visibleFailed.length} 次失败，完整内容请查看日志_`);
    }
  }

  return {
    title: `☕ **${titleParts.join(' · ')}**`,
    body: lines.join('\n'),
  };
}

function formatTypeCounts(typeCounts: Map<string, number>): string {
  const ranked = [...typeCounts.entries()].sort((left, right) => {
    const countDiff = right[1] - left[1];
    return countDiff !== 0 ? countDiff : left[0].localeCompare(right[0]);
  });
  const visible = ranked.slice(0, MAX_TOOL_TYPES);
  const hiddenCount = ranked
    .slice(MAX_TOOL_TYPES)
    .reduce((total, [, count]) => total + count, 0);
  const parts = visible.map(([name, count]) => `${name} ×${count}`);
  if (hiddenCount > 0) parts.push(`其他 ×${hiddenCount}`);
  return `**类型** ${parts.join(' · ')}`;
}
