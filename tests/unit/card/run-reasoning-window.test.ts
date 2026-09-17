import { describe, it, expect } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer';
import { initialState, reduce, windowState, type RunState } from '../../../src/card/run-state';

/**
 * OPT-01A regression tests: the reasoning panel must show the LATEST
 * thinking content once the accumulated transcript exceeds the display
 * window. On the research baseline (003f01e) the panel kept the FIRST
 * 1500 UTF-16 code units, so new thinking never changed the visible
 * card — these tests fail there by construction.
 */

const REASONING_MAX = 1500;

function thinking(state: RunState, delta: string): RunState {
  return reduce(state, { type: 'thinking', delta });
}

/** Pull the markdown body of the 🧠 collapsible panel out of a rendered card. */
function reasoningBody(card: object): string {
  const elements = (card as { body: { elements: Array<Record<string, unknown>> } }).body
    .elements;
  for (const el of elements) {
    if (el.tag !== 'collapsible_panel') continue;
    const header = el.header as { title?: { content?: string } } | undefined;
    if (header?.title?.content?.includes('思考')) {
      const inner = el.elements as Array<{ content?: string }>;
      return inner[0]?.content ?? '';
    }
  }
  return '';
}

function cardFor(state: RunState): object {
  return renderCard(windowState(state, { maxTextChars: 4000 }));
}

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      const prev = i > 0 ? s.charCodeAt(i - 1) : 0;
      if (prev < 0xd800 || prev > 0xdbff) return true;
    }
  }
  return false;
}

describe('OPT-01A: reasoning tail window (red-light sample from 03-verification)', () => {
  it('a new thinking delta past the window changes the rendered card and is visible', () => {
    const before = thinking(initialState, 'A'.repeat(1600));
    const after = thinking(before, '\nLATEST_PROGRESS_MARKER');
    const first = JSON.stringify(cardFor(before));
    const latest = JSON.stringify(cardFor(after));
    expect(latest).not.toBe(first);
    expect(reasoningBody(cardFor(after))).toContain('LATEST_PROGRESS_MARKER');
  });

  it('stored thinking content is not modified by windowing or rendering', () => {
    const content = 'A'.repeat(1600) + '\nLATEST_PROGRESS_MARKER';
    const state = thinking(initialState, content);
    cardFor(state);
    expect(state.reasoning.content).toBe(content);
    expect(state.reasoning.content.length).toBe(content.length);
  });
});

describe('OPT-01A: window boundaries', () => {
  it('1499 chars: shown verbatim, no hidden-prefix notice', () => {
    const state = thinking(initialState, 'x'.repeat(1499));
    const body = reasoningBody(cardFor(state));
    expect(body).toBe('x'.repeat(1499));
  });

  it(`1500 chars: shown verbatim, no hidden-prefix notice`, () => {
    const state = thinking(initialState, 'x'.repeat(1500));
    const body = reasoningBody(cardFor(state));
    expect(body).toBe('x'.repeat(1500));
  });

  it('1501 chars: tail window with an explicit hidden-prefix notice', () => {
    const state = thinking(initialState, `HEAD${'x'.repeat(1497)}TAIL_MARKER`);
    const body = reasoningBody(cardFor(state));
    expect(body).toContain('TAIL_MARKER');
    expect(body).not.toContain('HEAD');
    expect(body).toMatch(/显示最近思考/);
    expect(body).toMatch(/前文已隐藏/);
  });

  it('100k chars: marker appended after the window stays visible and budget is held', () => {
    const state = thinking(initialState, `${'中'.repeat(99_000)}\nEND_MARKER_唯一尾部`);
    const body = reasoningBody(cardFor(state));
    expect(body).toContain('END_MARKER_唯一尾部');
    expect(body.length).toBeLessThanOrEqual(REASONING_MAX);
  });

  it('active and completed panels share the same window semantics', () => {
    const active = thinking(initialState, `HEAD${'x'.repeat(1497)}TAIL_MARKER`);
    const done = reduce(active, { type: 'done', terminationReason: 'normal' });
    const activeBody = reasoningBody(cardFor(active));
    const doneBody = reasoningBody(cardFor(done));
    expect(doneBody).toContain('TAIL_MARKER');
    expect(doneBody).not.toContain('HEAD');
    // Same visible content modulo the panel title — completion must not
    // suddenly reveal the full transcript.
    expect(doneBody).toBe(activeBody);
  });
});

describe('OPT-01A: Unicode safety', () => {
  it('does not split surrogate pairs at the window cut (emoji)', () => {
    const state = thinking(initialState, `😀${'x'.repeat(1500)}😀TAIL_END`);
    const body = reasoningBody(cardFor(state));
    expect(body).toContain('TAIL_END');
    expect(hasLoneSurrogate(body)).toBe(false);
  });

  it('keeps combining sequences intact when they straddle the cut', () => {
    // "é" as e + U+0301 combining acute, laid across the cut point.
    const combined = 'e\u0301'.repeat(800);
    const state = thinking(initialState, `${combined}END_OK`);
    const body = reasoningBody(cardFor(state));
    expect(body).toContain('END_OK');
    // The visible window must start at a base character, not an orphan mark.
    const afterNotice = body.split('\n').slice(1).join('\n');
    expect(afterNotice.charCodeAt(0)).toBe(0x65);
  });

  it('multi-line CJK content: window starts on a clean line boundary', () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push(`第${i}行：${'内容'.repeat(5)}`);
    lines.push('最后一行标记');
    const state = thinking(initialState, lines.join('\n'));
    const body = reasoningBody(cardFor(state));
    expect(body).toContain('最后一行标记');
    // After the notice line, the window must begin at a line start.
    const afterNotice = body.split('\n').slice(1).join('\n');
    expect(afterNotice.startsWith('第')).toBe(true);
  });
});

describe('OPT-01A: markdown/code-fence repair', () => {
  it('cut inside a fenced code block reopens the fence so the panel stays renderable', () => {
    const content = `${'a'.repeat(1500)}\`\`\`js\ncode line\n\`\`\`\nTAIL_AFTER_FENCE`;
    const state = thinking(initialState, content);
    const body = reasoningBody(cardFor(state));
    expect(body).toContain('TAIL_AFTER_FENCE');
    const fences = body.split('\n').filter((l) => l.trimStart().startsWith('```')).length;
    // Opening fence was cut away; the repaired window must re-balance it.
    expect(fences % 2).toBe(0);
  });

  it('does not add a fence when the tail is already balanced', () => {
    // Window starts before a complete fenced block → even fence count → the
    // repair must stay hands-off.
    const content = `${'a'.repeat(1550)}plain\n\`\`\`\nblock\n\`\`\`\nTAIL_BALANCED`;
    const state = thinking(initialState, content);
    const body = reasoningBody(cardFor(state));
    expect(body).toContain('TAIL_BALANCED');
    const fences = body.split('\n').filter((l) => l.trimStart().startsWith('```')).length;
    expect(fences).toBe(2);
  });
});
