import { describe, expect, it } from 'vitest';
import { modelSelectCard, type ModelCardInput } from '../../../src/card/model-card';
import type { ModelCatalogResult } from '../../../src/agent/model-catalog';

function catalog(count: number): ModelCatalogResult {
  return {
    agentId: 'claude',
    status: 'ok',
    candidates: Array.from({ length: count }, (_, i) => ({
      id: `model-${i}`,
      displayName: `Model ${i}`,
      source: 'cli',
    })),
    fetchedAt: 1_700_000_000_000,
    note: '来源：测试。未验证。',
    unverified: true,
  };
}

function base(overrides: Partial<ModelCardInput> = {}): ModelCardInput {
  return {
    agentName: 'Claude Code',
    scopeLabel: '当前私聊',
    current: { source: 'cli' },
    catalog: catalog(3),
    revision: 7,
    canManage: true,
    ...overrides,
  };
}

function findSelectOptions(card: object): Array<{ value: string }> {
  let found: Array<{ value: string }> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      const rec = node as Record<string, unknown>;
      if (rec.tag === 'select_static' && Array.isArray(rec.options)) {
        found = rec.options as Array<{ value: string }>;
      }
      Object.values(rec).forEach(walk);
    }
  };
  walk(card);
  return found;
}

describe('modelSelectCard (OPT-07 slice B)', () => {
  it('binds the revision into submit and reset callbacks', () => {
    const json = JSON.stringify(modelSelectCard(base()));
    expect(json).toContain('"cmd":"model.submit"');
    expect(json).toContain('"cmd":"model.reset"');
    expect(json).toContain('"cmd":"model.refresh"');
    expect(json).toContain('"arg":"7"');
  });

  it('renders candidates as a dropdown and keeps the current override selectable', () => {
    const card = modelSelectCard(base({ current: { value: 'manual-xyz', source: 'override' } }));
    const options = findSelectOptions(card);
    expect(options.some((o) => o.value === 'model-0')).toBe(true);
    expect(options.some((o) => o.value === 'manual-xyz')).toBe(true);
  });

  it('caps the dropdown at 30 options within card budget', () => {
    const card = modelSelectCard(base({ catalog: catalog(50) }));
    expect(findSelectOptions(card).length).toBe(30);
  });

  it('hides apply/reset for viewers without manage rights but still offers refresh', () => {
    const json = JSON.stringify(modelSelectCard(base({ canManage: false })));
    expect(json).not.toContain('"cmd":"model.submit"');
    expect(json).not.toContain('"cmd":"model.reset"');
    expect(json).toContain('"cmd":"model.refresh"');
    expect(json).toContain('查看模式');
  });

  it('surfaces a failed catalog without pretending there are verified candidates', () => {
    const failed: ModelCatalogResult = {
      agentId: 'claude',
      status: 'failed',
      candidates: [],
      fetchedAt: 0,
      note: '模型列表获取失败，可刷新或手动输入。',
      unverified: true,
    };
    const json = JSON.stringify(modelSelectCard(base({ catalog: failed })));
    expect(json).toContain('模型列表获取失败');
    expect(json).toContain('手动输入模型 ID');
  });

  it('renders a stale catalog with its original fetch time and usable candidates', () => {
    const stale: ModelCatalogResult = {
      ...catalog(2),
      status: 'stale',
      note: '刷新失败，以下为上次获取的候选列表（可能已过期）。',
    };
    const card = modelSelectCard(base({ catalog: stale }));
    const json = JSON.stringify(card);
    expect(json).toContain('刷新失败');
    expect(json).toContain('上次更新');
    // The last good list stays selectable instead of collapsing to manual-only.
    const options = findSelectOptions(card);
    expect(options.some((o) => o.value === 'model-0')).toBe(true);
    expect(options.some((o) => o.value === 'model-1')).toBe(true);
  });
});
