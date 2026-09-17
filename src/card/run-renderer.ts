import type { Block, FooterStatus, RunState, ToolEntry } from './run-state';
import { summarizeToolCalls } from './tool-summary';

const REASONING_MAX = 1500;
const REASONING_HIDDEN_NOTICE = '_（显示最近思考，前文已隐藏）_';
const CODE_FENCE = '```';

export interface RunCardRenderOptions {
  signCallback?: (action: string) => string;
  progress?: RunCardProgress;
}

export interface RunCardProgress {
  elapsedMs: number;
  idleMs: number;
  currentTool?: string;
  completedTools: number;
  inFlightTools: number;
}

export function renderCard(state: RunState, options: RunCardRenderOptions = {}): object {
  const elements: object[] = [];
  const allTools = state.blocks
    .filter((block): block is Extract<Block, { kind: 'tool' }> => block.kind === 'tool')
    .map((block) => block.tool);
  let renderedToolSummary = false;

  if (state.terminal === 'running' && options.progress) {
    elements.push(progressStatus(options.progress));
  }

  if (state.reasoning.content) {
    elements.push(reasoningPanel(state.reasoning.content, state.reasoning.active));
  }

  for (const block of state.blocks) {
    if (block.kind === 'text') {
      if (block.content.trim()) {
        elements.push(markdown(block.content));
      }
    } else if (!renderedToolSummary) {
      elements.push(collapsedToolSummary(allTools, state.terminal !== 'running'));
      renderedToolSummary = true;
    }
  }

  if (state.terminal === 'interrupted') {
    elements.push(noteMd('_⏹ 已被中断_'));
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteMd(`_⏱ ${mins} 分钟无响应,已自动终止_`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`⚠️ agent 失败：${state.errorMsg}`));
  } else if (state.terminal === 'done' && elements.length === 0) {
    elements.push(noteMd('_（未返回内容）_'));
  }

  if (state.terminal === 'running') {
    if (state.footer) elements.push(footerStatus(state.footer));
    elements.push(stopButton(options));
  }

  return {
    schema: '2.0',
    config: {
      streaming_mode: state.terminal === 'running',
      summary: { content: summaryText(state) },
    },
    body: { elements },
  };
}

function reasoningPanel(content: string, active: boolean): object {
  const title = active ? '🧠 **思考中**' : '🧠 **思考完成，点击查看**';
  return collapsiblePanel({
    title,
    expanded: active,
    border: 'grey',
    body: reasoningWindow(content),
  });
}

/**
 * Tail display window for the reasoning panel (OPT-01A). Thinking keeps
 * accumulating in RunState; once it exceeds `REASONING_MAX`, the panel shows
 * the most recent content behind an explicit notice instead of freezing on
 * the first 1500 code units. The original state is never modified here.
 *
 * Window assembly is bounded: notice + optional fence repair + tail all fit
 * inside `REASONING_MAX`. The cut is Unicode-safe (no split surrogate pairs,
 * no orphaned combining marks) and snaps forward to a line boundary when one
 * exists. A cut inside a fenced code block reopens the fence (fence-line
 * parity heuristic) so the panel stays renderable.
 */
function reasoningWindow(content: string): string {
  if (content.length <= REASONING_MAX) return content;
  const notice = `${REASONING_HIDDEN_NOTICE}\n`;
  const budget = REASONING_MAX - notice.length - (CODE_FENCE.length + 1);
  let start = content.length - budget;
  if (isLowSurrogate(content.charCodeAt(start))) start -= 1;
  while (start > 0 && isCombiningMark(content.codePointAt(start)!)) start -= 1;
  const nl = content.indexOf('\n', start);
  const lineStart = nl === -1 ? start : nl + 1;
  // Snapping must never consume the whole window (content ending in "\n").
  if (lineStart < content.length) start = lineStart;
  let tail = content.slice(start);
  if (countFenceLines(tail) % 2 === 1) {
    tail = `${CODE_FENCE}\n${tail}`;
  }
  return `${notice}${tail}`;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isCombiningMark(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    cp === 0x200d ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  );
}

function countFenceLines(s: string): number {
  let n = 0;
  for (const line of s.split('\n')) {
    if (line.trimStart().startsWith(CODE_FENCE)) n += 1;
  }
  return n;
}

/**
 * Render every tool call in the run as one collapsed, bounded summary. Calls
 * are aggregated by type and status; only current, recent, and failed headers
 * are retained inside this same panel.
 *
 * Why no bodies: with full input/output panels nested, the serialized JSON
 * can easily exceed Feishu's per-element size limit (~30KB), causing 400
 * errors that abort the entire card stream. Tool details are still in the
 * file log; users who really need them can `/doctor` to inspect.
 *
 * The latest-running tool stays visible in the summary body instead of being
 * split into a second expanded panel.
 */
function collapsedToolSummary(tools: ToolEntry[], finalized: boolean): object {
  const summary = summarizeToolCalls(tools, finalized);
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: panelHeader(summary.title),
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: summary.body, text_size: 'notation' }],
  };
}

interface PanelOpts {
  title: string;
  expanded: boolean;
  border: 'grey' | 'red' | 'blue';
  body: string;
}

function collapsiblePanel(opts: PanelOpts): object {
  return {
    tag: 'collapsible_panel',
    expanded: opts.expanded,
    header: panelHeader(opts.title),
    border: { color: opts.border, corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: opts.body, text_size: 'notation' }],
  };
}

function panelHeader(titleMd: string): object {
  return {
    title: { tag: 'markdown', content: titleMd },
    vertical_align: 'center',
    icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
    icon_position: 'follow_text',
    icon_expanded_angle: -180,
  };
}

function markdown(content: string): object {
  return { tag: 'markdown', content };
}

function noteMd(content: string): object {
  return { tag: 'markdown', content, text_size: 'notation' };
}

function stopButton(options: RunCardRenderOptions): object {
  const value: Record<string, unknown> = { cmd: 'stop' };
  if (options.signCallback) {
    value.__bridge_cb = true;
    value.bridge_token = options.signCallback('stop');
  }
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '⏹ 终止' },
    type: 'danger',
    behaviors: [{ type: 'callback', value }],
  };
}

function footerStatus(status: Exclude<FooterStatus, null>): object {
  const text =
    status === 'thinking'
      ? '🧠 正在思考'
      : status === 'tool_running'
        ? '🧰 正在调用工具'
        : status === 'streaming'
          ? '✍️ 正在输出'
          : '⏳ 正在收尾';
  return noteMd(text);
}

function progressStatus(progress: RunCardProgress): object {
  const activity =
    progress.currentTool && progress.inFlightTools > 0
      ? `🧰 当前工具 ${progress.currentTool}`
      : '🟢 进程仍在运行';
  const content = [
    `⏳ 运行中 · 已 ${formatMinutes(progress.elapsedMs)} · 静默 ${formatMinutes(progress.idleMs)}`,
    `${activity} · 已完成 ${progress.completedTools} 个工具`,
  ].join('\n');
  return noteMd(content);
}

function formatMinutes(ms: number): string {
  if (ms < 60_000) return '<1m';
  return `${Math.floor(ms / 60_000)}m`;
}

function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '出错';
  if (state.terminal === 'done') return '已完成';
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  if (state.footer === 'closing') return '正在收尾';
  return '思考中';
}
