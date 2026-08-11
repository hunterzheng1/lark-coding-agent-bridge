import { describe, expect, it } from 'vitest';
import { initialState, reduce } from '../../../src/card/run-state';

describe('run state terminal event schema', () => {
  it('moves from tool-running to closing after the last tool result', () => {
    const running = reduce(initialState, {
      type: 'tool_use',
      id: 'tool-1',
      name: 'Bash',
      input: { command: 'pwd' },
    });
    const closing = reduce(running, {
      type: 'tool_result',
      id: 'tool-1',
      output: '/repo',
      isError: false,
    });

    expect(closing.footer).toBe('closing');
    expect(closing.terminal).toBe('running');
  });

  it('keeps the tool-running footer until every concurrent tool has finished', () => {
    const firstRunning = reduce(initialState, {
      type: 'tool_use',
      id: 'tool-1',
      name: 'Bash',
      input: { command: 'one' },
    });
    const bothRunning = reduce(firstRunning, {
      type: 'tool_use',
      id: 'tool-2',
      name: 'Read',
      input: { file_path: '/repo/two' },
    });
    const oneFinished = reduce(bothRunning, {
      type: 'tool_result',
      id: 'tool-1',
      output: 'one',
      isError: false,
    });
    const allFinished = reduce(oneFinished, {
      type: 'tool_result',
      id: 'tool-2',
      output: 'two',
      isError: false,
    });

    expect(oneFinished.footer).toBe('tool_running');
    expect(allFinished.footer).toBe('closing');
  });

  it('maps done termination reasons onto visible terminal states', () => {
    expect(reduce(initialState, { type: 'done', terminationReason: 'normal' }).terminal).toBe(
      'done',
    );
    expect(
      reduce(initialState, { type: 'done', terminationReason: 'interrupted' }).terminal,
    ).toBe('interrupted');
    expect(reduce(initialState, { type: 'done', terminationReason: 'timeout' }).terminal).toBe(
      'idle_timeout',
    );
  });

  it('maps error termination reasons onto visible terminal states', () => {
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'failed',
        terminationReason: 'failed',
      }).terminal,
    ).toBe('error');
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'stopped',
        terminationReason: 'interrupted',
      }).terminal,
    ).toBe('interrupted');
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'timeout',
        terminationReason: 'timeout',
      }).terminal,
    ).toBe('idle_timeout');
  });
});
