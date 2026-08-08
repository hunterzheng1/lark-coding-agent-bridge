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

export interface ToolDisplayPlan {
  summaryTools: ToolEntry[];
  liveTool?: ToolEntry;
}

/** Select the actual latest running tool instead of assuming array order. */
export function planToolDisplay(tools: ToolEntry[], finalized: boolean): ToolDisplayPlan {
  if (finalized) return { summaryTools: tools };

  let liveIndex = -1;
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    if (tools[index]?.status === 'running') {
      liveIndex = index;
      break;
    }
  }
  if (liveIndex < 0) return { summaryTools: tools };

  return {
    summaryTools: tools.filter((_, index) => index !== liveIndex),
    liveTool: tools[liveIndex],
  };
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
  // Once a collection crosses the summary threshold, never reveal every
  // header through a combination of recent and failure sections.
  const visibleHeaderBudget = Math.min(
    MAX_VISIBLE_TOOL_HEADERS,
    Math.max(0, tools.length - 1),
  );
  const failed = tools.filter((tool) => tool.status === 'error');
  const visibleFailed = failed.slice(-Math.min(MAX_FAILED_TOOLS, visibleHeaderBudget));
  const recentBudget = Math.min(
    MAX_RECENT_TOOLS,
    visibleHeaderBudget - visibleFailed.length,
  );
  const recent = recentBudget > 0
    ? tools
        .filter((tool) => tool.status !== 'error')
        .slice(-recentBudget)
    : [];
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
