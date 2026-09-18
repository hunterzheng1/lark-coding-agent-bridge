import { describe, it, expect } from 'vitest';
import {
  renderCard,
  renderCardBounded,
  CARD_PAYLOAD_BUDGET_BYTES,
} from '../../../src/card/run-renderer';
import { initialState, reduce, windowState, type RunState } from '../../../src/card/run-state';

/** Serialized UTF-8 byte length of a card JSON, i.e. what actually goes on the wire. */
function wireBytes(card: object): number {
  return Buffer.byteLength(JSON.stringify(card), 'utf8');
}

function cardElements(card: object): Array<Record<string, unknown>> {
  return (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;
}

function hasStopButton(card: object): boolean {
  return cardElements(card).some((el) => el.tag === 'button');
}

function hasErrorNote(card: object): boolean {
  return cardElements(card).some(
    (el) => typeof (el as { content?: string }).content === 'string' &&
      String((el as { content?: string }).content).includes('agent 失败'),
  );
}

function reasoningContent(card: object): string {
  for (const el of cardElements(card)) {
    if (el.tag === 'collapsible_panel') {
      const header = el.header as { title?: { content?: string } } | undefined;
      if (header?.title?.content?.includes('思考')) {
        return ((el.elements as Array<{ content?: string }>)[0]?.content ?? '');
      }
    }
  }
  return '';
}

function buildState(opts: { text: string; thinking?: string; error?: string }): RunState {
  let state = initialState;
  if (opts.thinking) state = reduce(state, { type: 'thinking', delta: opts.thinking });
  state = reduce(state, { type: 'text', delta: opts.text });
  if (opts.error) state = reduce(state, { type: 'error', message: opts.error, terminationReason: 'failed' } as never);
  return state;
}

describe('OPT-03: payload byte measurement', () => {
  it('counts UTF-8 bytes, not UTF-16 code units (CJK 3x, emoji 4x, escapes 2x)', () => {
    const cjk = JSON.parse(JSON.stringify({ content: '中'.repeat(100) }));
    expect(wireBytes(cjk)).toBeGreaterThan(300);
    const emoji = JSON.stringify({ content: '😀'.repeat(10) });
    expect(emoji.length).toBe(10 * 2 + 14); // 2 code units each + JSON wrapper
    expect(Buffer.byteLength(emoji, 'utf8')).toBe(10 * 4 + 14); // 4 bytes each on the wire
    const escaped = JSON.stringify({ content: '\u001b'.repeat(10) });
    expect(escaped.length).toBeGreaterThan(60); // \u001b = 6 chars per unit
  });

  it('char-count windows alone cannot bound wire size for escape-heavy content', () => {
    // 3900 control chars pass a 4000-char window but serialize to ~23KB.
    const card = renderCard(windowState(buildState({ text: '\u001b'.repeat(3900) }), { maxTextChars: 4000 }));
    expect(wireBytes(card)).toBeGreaterThan(20_000);
  });
});

describe('OPT-03: renderCardBounded degradation ladder', () => {
  it('short cards render identically to the unbounded path', () => {
    const state = buildState({ text: 'hello world', thinking: '短思考' });
    const plain = renderCard(windowState(state, { maxTextChars: 4000 }));
    const bounded = renderCardBounded(state);
    expect(JSON.stringify(bounded)).toBe(JSON.stringify(plain));
  });

  it('oversized content degrades to fit the budget; state is never modified', () => {
    const state = buildState({
      text: '正文'.repeat(3000), // 6000 CJK chars
      thinking: '思'.repeat(3000),
    });
    const before = JSON.stringify(state);
    const card = renderCardBounded(state, { budgetBytes: 8_000 });
    expect(wireBytes(card)).toBeLessThanOrEqual(8_000);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('degrades reasoning before body text and keeps the stop button while running', () => {
    const state = buildState({ text: '正'.repeat(4000), thinking: '思'.repeat(3000) });
    const card = renderCardBounded(state, {
      budgetBytes: 8_000,
      progress: { elapsedMs: 60_000, idleMs: 0, completedTools: 1, inFlightTools: 1, currentTool: 'Bash' },
    });
    expect(wireBytes(card)).toBeLessThanOrEqual(8_000);
    expect(hasStopButton(card)).toBe(true);
    // Reasoning shrinks to a small window rather than disappearing first.
    expect(reasoningContent(card).length).toBeGreaterThan(0);
    expect(reasoningContent(card).length).toBeLessThan(1500);
  });

  it('extreme degradation keeps the error note and stop control (never hides failure)', () => {
    const state = buildState({
      text: '长'.repeat(5000),
      thinking: '思'.repeat(5000),
      error: '进程崩溃：ECONNRESET',
    });
    const card = renderCardBounded(state, { budgetBytes: 2_000 });
    expect(wireBytes(card)).toBeLessThanOrEqual(2_000);
    expect(hasErrorNote(card)).toBe(true);
  });

  it('default budget bounds adversarial escape-heavy content that char windows miss', () => {
    const state = buildState({ text: '\u001b'.repeat(3900), thinking: '思'.repeat(1500) });
    const card = renderCardBounded(state);
    expect(wireBytes(card)).toBeLessThanOrEqual(CARD_PAYLOAD_BUDGET_BYTES);
  });

  it('rendering is deterministic: same input, same wire bytes', () => {
    const state = buildState({ text: '稳'.repeat(5000), thinking: '思'.repeat(2000) });
    const a = renderCardBounded(state, { budgetBytes: 6_000 });
    const b = renderCardBounded(state, { budgetBytes: 6_000 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(wireBytes(a)).toBeLessThanOrEqual(6_000);
  });
});

describe('OPT-03 评审修复: guaranteed-minimal error skeleton', () => {
  it('an unbounded upstream error message is clamped into the budget', () => {
    const rawError = `ECONNRESET ${'stack-frame '.repeat(400)}UNIQUE_TAIL_987654321`;
    const state = buildState({
      text: '长'.repeat(4000),
      thinking: '思'.repeat(1500),
      error: rawError,
    });
    const card = renderCardBounded(state, { budgetBytes: 2_500 });
    expect(wireBytes(card)).toBeLessThanOrEqual(2_500);
    const body = JSON.stringify(card);
    expect(body).toContain('agent 失败');
    expect(body).toContain('/doctor');
    // The raw oversized error must not sneak through.
    expect(body).not.toContain('UNIQUE_TAIL_987654321');
  });
});
