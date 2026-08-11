import type { RunState, ToolEntry } from './run-state';
import { summarizeToolCalls } from './tool-summary';

/**
 * Render `RunState` as plain markdown text — used in `messageReply: 'text'`
 * mode where we stream a markdown message instead of a card.
 *
 * Differences vs `renderCard`:
 *   - No collapsible panels, no buttons (markdown messages have neither)
 *   - Every tool-call set renders as one bounded aggregate summary
 *   - No reasoning / thinking output (no place to fold it; would be noise)
 *   - Footer is appended inline at the bottom while running
 */
export function renderText(state: RunState): string {
  const parts: string[] = [];
  const allTools = state.blocks
    .filter((block): block is Extract<RunState['blocks'][number], { kind: 'tool' }> => block.kind === 'tool')
    .map((block) => block.tool);
  let renderedToolSummary = false;

  for (const block of state.blocks) {
    if (block.kind === 'text') {
      const content = block.content.trim();
      if (content) parts.push(content);
    } else if (!renderedToolSummary) {
      parts.push(toolSummaryQuote(allTools, state.terminal !== 'running'));
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

function toolSummaryQuote(tools: ToolEntry[], finalized: boolean): string {
  const summary = summarizeToolCalls(tools, finalized);
  return [summary.title, ...summary.body.split('\n')]
    .map((line) => `> ${line}`)
    .join('\n');
}

function footerLine(status: Exclude<RunState['footer'], null>): string {
  if (status === 'thinking') return '_🧠 正在思考…_';
  if (status === 'tool_running') return '_🧰 正在调用工具…_';
  if (status === 'streaming') return '_✍️ 正在输出…_';
  return '_⏳ 正在收尾…_';
}
