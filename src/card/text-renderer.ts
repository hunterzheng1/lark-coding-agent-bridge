import type { RunState, ToolEntry } from './run-state';
import { toolHeaderText } from './tool-render';
import { planToolDisplay, summarizeToolCalls, TOOL_SUMMARY_THRESHOLD } from './tool-summary';

/**
 * Render `RunState` as plain markdown text — used in `messageReply: 'text'`
 * mode where we stream a markdown message instead of a card.
 *
 * Differences vs `renderCard`:
 *   - No collapsible panels, no buttons (markdown messages have neither)
 *   - Large tool-call sets collapse to one bounded aggregate summary
 *   - No reasoning / thinking output (no place to fold it; would be noise)
 *   - Footer is appended inline at the bottom while running
 */
export function renderText(state: RunState): string {
  const parts: string[] = [];
  const allTools = state.blocks
    .filter((block): block is Extract<RunState['blocks'][number], { kind: 'tool' }> => block.kind === 'tool')
    .map((block) => block.tool);
  const summarizeAllTools = allTools.length >= TOOL_SUMMARY_THRESHOLD;
  let renderedToolSummary = false;

  for (const block of state.blocks) {
    if (block.kind === 'text') {
      const content = block.content.trim();
      if (content) parts.push(content);
    } else if (!summarizeAllTools) {
      parts.push(toolLine(block.tool));
    } else if (!renderedToolSummary) {
      parts.push(...renderToolGroup(allTools, state.terminal !== 'running'));
      renderedToolSummary = true;
    }
  }

  if (state.terminal === 'interrupted') {
    parts.push('_⏹ 已被中断_');
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    parts.push(`_⏱ ${mins} 分钟无响应,已自动终止_`);
  } else if (state.terminal === 'error' && state.errorMsg) {
    parts.push(`⚠️ agent 失败:${state.errorMsg}`);
  } else if (state.terminal === 'running' && state.footer) {
    parts.push(footerLine(state.footer));
  }

  return parts.join('\n\n');
}

/**
 * One-line summary for a tool call:
 *   `> ⏳ **Bash** — git status`
 *   `> ✅ **Read** — ~/code/foo.ts`
 * Reuses `toolHeaderText` so the format matches the card mode header.
 */
function toolLine(tool: ToolEntry): string {
  return `> ${toolHeaderText(tool)}`;
}

function renderToolGroup(tools: ToolEntry[], finalized: boolean): string[] {
  if (tools.length < TOOL_SUMMARY_THRESHOLD) return tools.map(toolLine);
  if (finalized) return [toolSummaryQuote(tools, true)];

  const plan = planToolDisplay(tools, false);
  const parts: string[] = [];
  if (plan.summaryTools.length > 0) parts.push(toolSummaryQuote(plan.summaryTools, false));
  if (plan.liveTool) parts.push(toolLine(plan.liveTool));
  return parts;
}

function toolSummaryQuote(tools: ToolEntry[], finalized: boolean): string {
  const summary = summarizeToolCalls(tools, finalized);
  return [summary.title, ...summary.body.split('\n')]
    .map((line) => `> ${line}`)
    .join('\n');
}

function footerLine(status: 'thinking' | 'tool_running' | 'streaming'): string {
  if (status === 'thinking') return '_🧠 正在思考…_';
  if (status === 'tool_running') return '_🧰 正在调用工具…_';
  return '_✍️ 正在输出…_';
}
