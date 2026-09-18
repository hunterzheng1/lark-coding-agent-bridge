import type { ModelCatalogResult } from '../agent/model-catalog';

/**
 * OPT-07 Slice B: the model selection card. Mirrors the `/config` form pattern
 * (schema 2.0 + form + select_static + input + submit button). Buttons carry a
 * `cmd` and the bound model revision so a stale card cannot overwrite a newer
 * choice. Discovery provenance and the "not account-verified" caveat are shown
 * verbatim — the card never claims a candidate is callable.
 */

export interface ModelCardInput {
  agentName: string;
  /** 作用范围 label, e.g. 当前话题（同话题成员共享）. */
  scopeLabel: string;
  /** Current selection for this scope + backend. */
  current: { value?: string; source: 'override' | 'cli' };
  catalog: ModelCatalogResult;
  /** Bumped on every preference write; re-validated on submit/reset. */
  revision: number;
  /** Operator may apply/reset (bot owner/admin). */
  canManage: boolean;
}

const MAX_OPTIONS = 30;
const MAX_LABEL = 48;
/** Feishu caps option/button labels well below this; truncate defensively. */
const MAX_ID = 120;

function escapeMd(value: string): string {
  return value.replace(/([*_`\\])/g, '\\$1');
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return '未知';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function modelSelectCard(input: ModelCardInput): object {
  const { catalog } = input;
  const elements: object[] = [];

  const selectionLine =
    input.current.source === 'override' && input.current.value
      ? `当前选择：${escapeMd(truncate(input.current.value, MAX_ID))}`
      : '当前选择：跟随 CLI 设置（未覆盖）';
  const statusLine =
    catalog.status === 'failed'
      ? `⚠️ ${escapeMd(catalog.note)}`
      : `候选来源：${escapeMd(catalog.note)} · 更新时间 ${formatTime(catalog.fetchedAt)}`;

  elements.push({
    tag: 'markdown',
    content:
      `🧠 **模型设置 · ${escapeMd(input.agentName)}**\n` +
      `作用范围：${escapeMd(input.scopeLabel)}\n` +
      `${selectionLine}\n` +
      `${statusLine}`,
  });
  elements.push({ tag: 'hr' });

  const optionCandidates = dedupeById(catalog.candidates).slice(0, MAX_OPTIONS);

  if (!input.canManage) {
    elements.push({
      tag: 'markdown',
      content: '_查看模式：切换模型仅管理员或 bot owner 可用。_',
    });
    if (optionCandidates.length > 0) {
      elements.push({
        tag: 'markdown',
        content: optionCandidates
          .map((c) => `• \`${escapeMd(truncate(c.id, MAX_ID))}\`${c.displayName !== c.id ? ` — ${escapeMd(truncate(c.displayName, MAX_LABEL))}` : ''}`)
          .join('\n'),
      });
    }
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '刷新列表' },
      type: 'default',
      behaviors: [{ type: 'callback', value: { cmd: 'model.refresh' } }],
    });
    return shell('模型设置', elements);
  }

  const options = optionCandidates.map((c) => ({
    text: {
      tag: 'plain_text',
      content: truncate(
        c.displayName !== c.id ? `${c.displayName} (${c.id})` : c.id,
        MAX_LABEL + MAX_ID,
      ),
    },
    value: truncate(c.id, MAX_ID),
  }));

  // Keep the dropdown valid when the saved override is not among candidates
  // (e.g. a manual id set earlier).
  if (input.current.source === 'override' && input.current.value) {
    const saved = truncate(input.current.value, MAX_ID);
    if (!options.some((option) => option.value === saved)) {
      options.unshift({
        text: { tag: 'plain_text', content: `${truncate(saved, MAX_LABEL)}（当前）` },
        value: saved,
      });
    }
  }

  const formElements: object[] = [];
  if (options.length > 0) {
    formElements.push({
      tag: 'markdown',
      content: '**选择候选模型**（手动输入优先）',
    });
    formElements.push({
      tag: 'select_static',
      name: 'model',
      ...(input.current.source === 'override' && input.current.value
        ? { initial_option: truncate(input.current.value, MAX_ID) }
        : {}),
      placeholder: { tag: 'plain_text', content: '选择模型' },
      options,
    });
  } else {
    formElements.push({
      tag: 'markdown',
      content: '_暂无候选，可手动输入模型 ID。_',
    });
  }
  formElements.push({
    tag: 'markdown',
    content: '**手动输入模型 ID**（企业/网关模型，或候选未列出时）',
  });
  formElements.push({
    tag: 'input',
    name: 'manual_model',
    placeholder: { tag: 'plain_text', content: '例如 gpt-5 / custom:xxx' },
    input_type: 'text',
    default_value: '',
  });
  formElements.push({
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: 'small',
    columns: [
      {
        tag: 'column',
        width: 'auto',
        elements: [
          {
            tag: 'button',
            name: 'model_submit',
            text: { tag: 'plain_text', content: '应用模型' },
            type: 'primary',
            form_action_type: 'submit',
            behaviors: [
              { type: 'callback', value: { cmd: 'model.submit', arg: String(input.revision) } },
            ],
          },
        ],
      },
      {
        tag: 'column',
        width: 'auto',
        elements: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '跟随 CLI 设置' },
            type: 'default',
            behaviors: [
              { type: 'callback', value: { cmd: 'model.reset', arg: String(input.revision) } },
            ],
          },
        ],
      },
    ],
  });

  elements.push({
    tag: 'form',
    name: 'model_form',
    elements: formElements,
  });
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '刷新列表' },
    type: 'default',
    behaviors: [{ type: 'callback', value: { cmd: 'model.refresh' } }],
  });
  elements.push({
    tag: 'markdown',
    content:
      '_应用后新收到的消息使用新设置；已接收/排队任务保留原设置，不会中断当前任务。列表为候选，未经本账号实际调用验证。_',
  });

  return shell('模型设置', elements);
}

function dedupeById(
  candidates: ModelCatalogResult['candidates'],
): ModelCatalogResult['candidates'] {
  const seen = new Set<string>();
  const out: ModelCatalogResult['candidates'] = [];
  for (const candidate of candidates) {
    if (!candidate.id || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    out.push(candidate);
  }
  return out;
}

function shell(title: string, elements: object[]): object {
  return {
    schema: '2.0',
    config: { summary: { content: title } },
    body: { elements },
  };
}
