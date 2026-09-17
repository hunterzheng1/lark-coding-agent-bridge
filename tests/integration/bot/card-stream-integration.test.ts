import { describe, it, expect, vi } from 'vitest';
import { processAgentStream, awaitRenderAwareStream } from '../../../src/bot/channel';
import type { AgentEvent } from '../../../src/agent/types';
import type { RunHandle } from '../../../src/bot/active-runs';
import { renderCard } from '../../../src/card/run-renderer';
import { initialState } from '../../../src/card/run-state';

function fakeHandle(): RunHandle {
  return {
    run: {
      stop: vi.fn().mockResolvedValue(undefined),
      waitForExit: vi.fn().mockResolvedValue(undefined),
    } as never,
    interrupted: false,
  };
}

async function* eventsFrom(evts: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const e of evts) yield e;
}

const noFlush = vi.fn().mockResolvedValue(undefined);
const noRecord = (_: AgentEvent) => {};

describe('card-stream integration — D + N scenarios (processAgentStream level)', () => {
  it('D2: only tools, no text → all tools render in one bounded container, no C2', async () => {
    const evts: AgentEvent[] = [];
    for (let i = 0; i < 12; i++) {
      evts.push({ type: 'tool_use', id: String(i), name: 'Bash', input: {} } as AgentEvent);
      evts.push({ type: 'tool_result', id: String(i), output: 'ok', isError: false } as AgentEvent);
    }
    evts.push({ type: 'done', terminationReason: 'normal' } as AgentEvent);
    const flush = vi.fn().mockResolvedValue(undefined);
    const onTerminal = vi.fn();
    await processAgentStream(fakeHandle(), eventsFrom(evts), 'scope', undefined, noRecord, flush, {
      onTerminal,
    });
    const lastState = flush.mock.calls[flush.mock.calls.length - 1]![0];
    const toolBlocks = lastState.blocks.filter((b: { kind: string }) => b.kind === 'tool');
    const card = renderCard(lastState);

    expect(toolBlocks).toHaveLength(12);
    expect(toolContainerCount(card)).toBe(1);
    expect(JSON.stringify(card)).toContain('12 个工具调用');
    expect(JSON.stringify(card).length).toBeLessThan(5_000);
    expect(onTerminal.mock.calls[0]![2]).toBe('');
  });

  it('D3: empty run (done immediately) → no heartbeat, notice 0 tools, no C2', async () => {
    const evts: AgentEvent[] = [{ type: 'done', terminationReason: 'normal' } as AgentEvent];
    const onHeartbeat = vi.fn();
    const onTerminal = vi.fn();
    await processAgentStream(fakeHandle(), eventsFrom(evts), 'scope', undefined, noRecord, noFlush, {
      onHeartbeat,
      onTerminal,
    });
    expect(onHeartbeat).not.toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledTimes(1);
    const [state, , fullText] = onTerminal.mock.calls[0]!;
    expect(state.blocks.filter((b: { kind: string }) => b.kind === 'tool').length).toBe(0);
    expect(fullText).toBe('');
  });

  it('N1: 20 tool pairs + long text → one bounded tool container per flush and complete C2', async () => {
    const evts: AgentEvent[] = [];
    for (let i = 0; i < 20; i++) {
      evts.push({ type: 'tool_use', id: String(i), name: 'Read', input: {} } as AgentEvent);
      evts.push({ type: 'tool_result', id: String(i), output: 'ok', isError: false } as AgentEvent);
    }
    const longText = 'x'.repeat(10_000);
    evts.push({ type: 'text', delta: longText } as AgentEvent);
    evts.push({ type: 'done', terminationReason: 'normal' } as AgentEvent);
    const flush = vi.fn().mockResolvedValue(undefined);
    const onTerminal = vi.fn();
    await processAgentStream(fakeHandle(), eventsFrom(evts), 'scope', undefined, noRecord, flush, {
      onTerminal,
    });
    for (const call of flush.mock.calls) {
      const s = call[0];
      const toolBlocks = s.blocks.filter((b: { kind: string }) => b.kind === 'tool');
      const card = renderCard(s);

      expect(toolBlocks.length).toBeGreaterThan(0);
      expect(toolBlocks.length).toBeLessThanOrEqual(20);
      expect(toolContainerCount(card)).toBe(1);
      expect(JSON.stringify(card).length).toBeLessThan(5_000);
    }
    const lastState = flush.mock.calls[flush.mock.calls.length - 1]![0];
    expect(lastState.blocks.filter((b: { kind: string }) => b.kind === 'tool')).toHaveLength(20);
    expect(onTerminal.mock.calls[0]![2]).toBe(longText);
    expect(onTerminal.mock.calls[0]![3]).toBe(true);
  });

  it('N2: short run (< intervalMs) → no heartbeat, notice, not truncated', async () => {
    const evts: AgentEvent[] = [
      { type: 'text', delta: 'hi' } as AgentEvent,
      { type: 'done', terminationReason: 'normal' } as AgentEvent,
    ];
    const onHeartbeat = vi.fn();
    const onTerminal = vi.fn();
    await processAgentStream(fakeHandle(), eventsFrom(evts), 'scope', undefined, noRecord, noFlush, {
      onHeartbeat,
      onTerminal,
      heartbeatIntervalMs: 60_000,
    });
    expect(onHeartbeat).not.toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal.mock.calls[0]![3]).toBe(false);
  });

  it('N3: interrupted → onTerminal fires with interrupted terminal', async () => {
    const evts: AgentEvent[] = [
      { type: 'text', delta: 'partial' } as AgentEvent,
      { type: 'error', message: 'stopped', terminationReason: 'interrupted' } as AgentEvent,
    ];
    const onTerminal = vi.fn();
    await processAgentStream(fakeHandle(), eventsFrom(evts), 'scope', undefined, noRecord, noFlush, {
      onTerminal,
    });
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal.mock.calls[0]![0].terminal).toBe('interrupted');
  });

  it('N4: idle_timeout → onTerminal fires with idle_timeout terminal', async () => {
    const evts: AgentEvent[] = [
      { type: 'text', delta: 'working' } as AgentEvent,
      { type: 'error', message: 'idle', terminationReason: 'timeout' } as AgentEvent,
    ];
    const onTerminal = vi.fn();
    await processAgentStream(fakeHandle(), eventsFrom(evts), 'scope', undefined, noRecord, noFlush, {
      onTerminal,
    });
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal.mock.calls[0]![0].terminal).toBe('idle_timeout');
  });
});

// ─── OPT-02: delivery scheduling inside processAgentStream ─────────────────

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
}

describe('OPT-02: slow API + event burst coalescing', () => {
  it('keeps draining events while a flush is in flight; delivers the latest state once', async () => {
    const gate = deferred();
    const flushCalls: string[] = [];
    const flush = async (state: { blocks: Array<{ kind: string; content?: string }> }) => {
      const text = state.blocks.map((b) => b.content ?? '').join('');
      flushCalls.push(text);
      if (flushCalls.length === 1) await gate.promise;
    };
    const evts: AgentEvent[] = [
      { type: 'text', delta: 'a' } as AgentEvent,
      { type: 'text', delta: 'b' } as AgentEvent,
      { type: 'text', delta: 'c' } as AgentEvent,
      { type: 'done', terminationReason: 'normal' } as AgentEvent,
    ];
    const done = processAgentStream(fakeHandle(), eventsFrom(evts), 'scope', undefined, noRecord, flush);

    // First flush is stuck on the slow API; the remaining events must still
    // drain (they do not wait for the network).
    await waitFor(() => flushCalls.length >= 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(flushCalls).toHaveLength(1);

    gate.resolve();
    await done;
    // One in-flight snapshot + the coalesced latest terminal snapshot — not
    // one send per event chasing the API.
    expect(flushCalls).toHaveLength(2);
    expect(flushCalls[1]).toBe('abc');
  });

  it('a transient flush failure does not stall the stream; terminal state still delivered', async () => {
    const failures: unknown[] = [];
    const flush = async (state: {
      terminal: string;
      blocks: Array<{ kind: string; content?: string }>;
    }) => {
      const text = state.blocks.map((b) => b.content ?? '').join('');
      if (text === 'ab' && state.terminal === 'running') throw new Error('transient network');
    };
    const evts: AgentEvent[] = [
      { type: 'text', delta: 'a' } as AgentEvent,
      { type: 'text', delta: 'b' } as AgentEvent,
      { type: 'text', delta: 'c' } as AgentEvent,
      { type: 'done', terminationReason: 'normal' } as AgentEvent,
    ];
    const finalState = await processAgentStream(
      fakeHandle(),
      eventsFrom(evts),
      'scope',
      undefined,
      noRecord,
      flush,
      {
        onFlushError: (err) => failures.push(err),
      },
    );
    expect(finalState.terminal).toBe('done');
    expect(failures).toHaveLength(1);
  });

  it('terminal snapshot is never overwritten by an older running snapshot', async () => {
    const order: string[] = [];
    const gates: Deferred[] = [];
    const flush = async (state: { terminal: string; blocks: Array<{ kind: string; content?: string }> }) => {
      const text = state.blocks.map((b) => b.content ?? '').join('');
      order.push(`${state.terminal}:${text}`);
      if (order.length === 1) {
        const gate = deferred();
        gates.push(gate);
        await gate.promise;
      }
    };
    const evts: AgentEvent[] = [
      { type: 'text', delta: 'progress' } as AgentEvent,
      { type: 'done', terminationReason: 'normal' } as AgentEvent,
    ];
    const done = processAgentStream(fakeHandle(), eventsFrom(evts), 'scope', undefined, noRecord, flush);
    await waitFor(() => order.length >= 1);
    gates[0]!.resolve();
    await done;
    expect(order[order.length - 1]).toMatch(/^done:/);
  });
});

function toolContainerCount(card: object): number {
  const elements = (card as {
    body?: {
      elements?: Array<{
        tag?: string;
        header?: { title?: { content?: string } };
      }>;
    };
  }).body?.elements ?? [];
  return elements.filter(
    (element) =>
      element.tag === 'collapsible_panel'
      && element.header?.title?.content?.includes('工具调用'),
  ).length;
}

describe('N5: awaitRenderAwareStream fallback on stream failure', () => {
  it('invokes fallback with final state when the card stream rejects', async () => {
    const fallback = vi.fn().mockResolvedValue(undefined);
    const finalState = { ...initialState, terminal: 'done' as const };
    await awaitRenderAwareStream({
      mode: 'card',
      streamDone: Promise.reject(new Error('stream failed')),
      renderDone: Promise.resolve(finalState),
      producerStarted: () => false,
      fallback,
    });
    expect(fallback).toHaveBeenCalledWith(finalState);
  });
});
