import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer.js';
import {
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
  windowState,
  type RunState,
} from '../../../src/card/run-state.js';
import { renderText } from '../../../src/card/text-renderer.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { normalizeCard } from '../../helpers/card-normalize.js';

describe('run card renderer snapshots', () => {
  it('renders initial running state', () => {
    expectCard(initialState).toMatchSnapshot();
  });

  it('renders active and completed thinking', () => {
    expectCard(stateFrom([{ type: 'thinking', delta: 'checking options' }])).toMatchSnapshot();
    expectCard(stateFrom([
      { type: 'thinking', delta: 'checking options' },
      { type: 'text', delta: 'final answer' },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('renders tool running, done, and error states', () => {
    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/missing.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'ENOENT', isError: true },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('collapses consecutive tools while preserving the latest running tool', () => {
    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'a', isError: false },
      { type: 'tool_use', id: 'tool-3', name: 'Edit', input: { file_path: '/repo/a.ts' } },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'a', isError: false },
      { type: 'tool_use', id: 'tool-3', name: 'Edit', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-3', output: 'ok', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('keeps large completed tool groups bounded and informative in cards', () => {
    const card = JSON.stringify(renderCard(stateFrom(manyToolEvents())));

    expect(card).toContain('89 个工具调用');
    expect(card).toContain('87 成功');
    expect(card).toContain('2 失败');
    expect(card).toContain('Bash ×30');
    expect(card).toContain('Grep ×4');
    expect(card).toContain('pattern-88');
    expect(card).not.toContain('command-0');
    expect(card.length).toBeLessThan(5_000);
  });

  it('keeps large completed tool groups bounded and informative in text replies', () => {
    const text = renderText(stateFrom(manyToolEvents()));

    expect(text).toContain('89 个工具调用');
    expect(text).toContain('87 成功');
    expect(text).toContain('2 失败');
    expect(text).toContain('Bash ×30');
    expect(text).toContain('Grep ×4');
    expect(text).toContain('pattern-88');
    expect(text).not.toContain('command-0');
    expect(text.length).toBeLessThan(2_500);
  });

  it('summarizes tool calls once even when text appears between calls', () => {
    const state = stateFrom(interleavedToolEvents());
    const card = JSON.stringify(renderCard(state));
    const text = renderText(state);

    expect(card.match(/4 个工具调用/g)).toHaveLength(1);
    expect(text.match(/4 个工具调用/g)).toHaveLength(1);
    expect(card).toContain('step-0');
    expect(card).toContain('step-3');
    expect(text).toContain('step-0');
    expect(text).toContain('step-3');
    expect(card).not.toContain('command-0');
    expect(text).not.toContain('command-0');
  });

  it('keeps the actual running tool visible when later tools already completed', () => {
    const state = stateFrom([
      { type: 'tool_use', id: 'tool-running', name: 'Bash', input: { command: 'long-running' } },
      { type: 'tool_use', id: 'tool-done-1', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-done-1', output: 'a', isError: false },
      { type: 'tool_use', id: 'tool-done-2', name: 'Edit', input: { file_path: '/repo/b.ts' } },
      { type: 'tool_result', id: 'tool-done-2', output: 'ok', isError: false },
    ]);
    const card = JSON.stringify(renderCard(state));
    const text = renderText(state);

    expect(card.match(/3 个工具调用/g)).toHaveLength(1);
    expect(card).toContain('1 运行中');
    expect(card).toContain('long-running');
    expect(card).not.toContain('"expanded":true');
    expect(text.match(/3 个工具调用/g)).toHaveLength(1);
    expect(text).toContain('1 运行中');
    expect(text).toContain('long-running');
    expect(text.split('\n').some((line) => line.startsWith('> ⏳'))).toBe(false);
  });

  it.each([1, 2, 3, 8, 9, 11, 89, 257])(
    'renders %i tool calls in exactly one bounded container after windowing',
    (toolCount) => {
      const state = windowState(stateFrom(runningToolEvents(toolCount)), {
        maxTextChars: 10_000,
      });
      const renderedCard = renderCard(state) as {
        body: { elements: Array<{ tag?: string; expanded?: boolean }> };
      };
      const toolPanels = renderedCard.body.elements.filter(
        (element) => element.tag === 'collapsible_panel',
      );
      const card = JSON.stringify(renderedCard);
      const text = renderText(state);

      expect(toolPanels).toHaveLength(1);
      expect(card.match(new RegExp(`${toolCount} 个工具调用`, 'g'))).toHaveLength(1);
      expect(card).toContain('1 运行中');
      expect(card).not.toContain('"expanded":true');
      expect(card.length).toBeLessThan(5_000);

      expect(text.match(new RegExp(`${toolCount} 个工具调用`, 'g'))).toHaveLength(1);
      expect(text).toContain('1 运行中');
      expect(text.split('\n').some((line) => line.startsWith('> ⏳'))).toBe(false);
      expect(text.length).toBeLessThan(2_500);
    },
  );

  it('never exposes every header at the three-call summary threshold', () => {
    const state = stateFrom([
      { type: 'tool_use', id: 'tool-0', name: 'Bash', input: { command: 'command-0' } },
      { type: 'tool_result', id: 'tool-0', output: 'failed-0', isError: true },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'command-1' } },
      { type: 'tool_result', id: 'tool-1', output: 'failed-1', isError: true },
      { type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'command-2' } },
      { type: 'tool_result', id: 'tool-2', output: 'failed-2', isError: true },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const card = JSON.stringify(renderCard(state));
    const text = renderText(state);

    expect(card).toContain('3 失败');
    expect(text).toContain('3 失败');
    expect(card).not.toContain('command-0');
    expect(text).not.toContain('command-0');
    expect(card.match(/command-2/g)).toHaveLength(1);
    expect(text.match(/command-2/g)).toHaveLength(1);
  });

  it('renders done, error, interrupted, and idle-timeout terminal states', () => {
    expectCard(stateFrom([{ type: 'done', terminationReason: 'normal' }])).toMatchSnapshot();
    expectCard(stateFrom([{ type: 'error', message: 'process failed', terminationReason: 'failed' }])).toMatchSnapshot();
    expectCard(markInterrupted(stateFrom([{ type: 'text', delta: 'partial' }]))).toMatchSnapshot();
    expectCard(markIdleTimeout(stateFrom([{ type: 'text', delta: 'partial' }]), 15)).toMatchSnapshot();
  });

  it('renders markdown text mode without card-only controls', () => {
    const state = stateFrom([
      { type: 'thinking', delta: 'hidden reasoning' },
      { type: 'text', delta: 'Answer' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'text', delta: 'Done' },
    ]);

    expect(renderText(state)).toMatchSnapshot();
    expect(renderText(markInterrupted(state))).toMatchSnapshot();
    expect(renderText(markIdleTimeout(state, 10))).toMatchSnapshot();
    expect(renderText(stateFrom([{ type: 'error', message: 'process failed', terminationReason: 'failed' }]))).toMatchSnapshot();
  });

  it('injects signed bridge callback values for managed run controls', () => {
    const card = renderCard(initialState, {
      signCallback: (action) => `token-for-${action}`,
    }) as {
      body?: { elements?: Array<{ tag?: string; behaviors?: Array<{ value?: Record<string, unknown> }> }> };
    };
    const button = card.body?.elements?.find((element) => element.tag === 'button');

    expect(button?.behaviors?.[0]?.value).toEqual({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: 'token-for-stop',
    });
  });

  it('renders durable progress telemetry on a running card', () => {
    const card = JSON.stringify(
      renderCard(initialState, {
        progress: {
          elapsedMs: 12 * 60_000,
          idleMs: 4 * 60_000,
          currentTool: 'Bash',
          completedTools: 3,
          inFlightTools: 1,
        },
      }),
    );

    expect(card).toContain('已 12m');
    expect(card).toContain('静默 4m');
    expect(card).toContain('Bash');
    expect(card).toContain('已完成 3 个工具');
  });

  it('keeps local paths in user-visible cards and text fallbacks', () => {
    const sensitivePath = '/Users/example/private/customer/repo/secret.txt';
    const state = stateFrom([
      { type: 'text', delta: `I read ${sensitivePath}` },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: sensitivePath } },
      { type: 'tool_result', id: 'tool-1', output: `content from ${sensitivePath}`, isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);

    const card = JSON.stringify(renderCard(state));
    const text = renderText(state);
    expect(card).toContain(sensitivePath);
    expect(text).toContain(sensitivePath);
  });
});

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}

function manyToolEvents(): AgentEvent[] {
  const names = [
    ...Array<string>(30).fill('Bash'),
    ...Array<string>(25).fill('Read'),
    ...Array<string>(20).fill('Edit'),
    ...Array<string>(10).fill('Write'),
    ...Array<string>(4).fill('Grep'),
  ];
  const events: AgentEvent[] = [];

  names.forEach((name, index) => {
    const input = name === 'Bash'
      ? { command: `command-${index}` }
      : name === 'Grep'
        ? { pattern: `pattern-${index}`, path: '/repo' }
        : { file_path: `/repo/file-${index}.ts` };
    const isError = index === 10 || index === 88;
    events.push(
      { type: 'tool_use', id: `tool-${index}`, name, input },
      { type: 'tool_result', id: `tool-${index}`, output: isError ? 'failed' : 'ok', isError },
    );
  });
  events.push({ type: 'done', terminationReason: 'normal' });
  return events;
}

function interleavedToolEvents(): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (let index = 0; index < 4; index += 1) {
    events.push(
      { type: 'tool_use', id: `tool-${index}`, name: 'Bash', input: { command: `command-${index}` } },
      { type: 'tool_result', id: `tool-${index}`, output: 'ok', isError: false },
      { type: 'text', delta: `step-${index}` },
    );
  }
  events.push({ type: 'done', terminationReason: 'normal' });
  return events;
}

function runningToolEvents(toolCount: number): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (let index = 0; index < toolCount; index += 1) {
    events.push({
      type: 'tool_use',
      id: `tool-${index}`,
      name: index % 2 === 0 ? 'Bash' : 'Read',
      input: index % 2 === 0
        ? { command: `command-${index}` }
        : { file_path: `/repo/file-${index}.ts` },
    });
    if (index < toolCount - 1) {
      events.push({
        type: 'tool_result',
        id: `tool-${index}`,
        output: 'ok',
        isError: false,
      });
    }
    if (index === 2) events.push({ type: 'text', delta: 'interleaved progress' });
  }
  return events;
}

function expectCard(state: RunState) {
  return expect(normalizeCard(renderCard(state)));
}
