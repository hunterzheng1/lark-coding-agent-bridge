import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import {
  commandKeepsPendingQueue,
  runCommandHandler,
  tryHandleCommand,
  type CommandContext,
  type Controls,
} from '../../../src/commands';
import type { ModelCatalogResult } from '../../../src/agent/model-catalog';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel';
import { FakeAgentAdapter } from '../../helpers/fake-agent';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const CANNED: ModelCatalogResult = {
  agentId: 'claude',
  status: 'ok',
  candidates: [
    { id: 'm1', displayName: 'Model One', source: 'cli' },
    { id: 'm2', displayName: 'Model Two', source: 'cli' },
  ],
  fetchedAt: 1_700_000_000_000,
  note: '候选来源：测试。未经本账号验证。',
  unverified: true,
};

function stubDiscover(catalog: ModelCatalogResult = CANNED) {
  return async (): Promise<ModelCatalogResult> => catalog;
}

async function makeStore(): Promise<SessionStore> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-model-'));
  roots.push(root);
  const store = new SessionStore(join(root, 'sessions.json'));
  await store.load();
  return store;
}

function controls(admins: string[]): Controls {
  const profileConfig = profile(admins);
  return {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'self',
    async restart() {},
    async exit() {},
  };
}

function profile(admins: string[]): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    access: { admins },
  });
  config.workspaces.default = join(tmpdir(), 'unused');
  return config;
}

interface CtxArgs {
  channel: FakeChannel;
  sessions: SessionStore;
  activeRuns: ActiveRuns;
  content: string;
  senderId?: string;
  agentId?: string;
  discoverModels?: (input: never) => Promise<ModelCatalogResult>;
  formValue?: Record<string, unknown>;
  scope?: string;
}

function commandContext(args: CtxArgs): CommandContext {
  return {
    channel: args.channel as unknown as CommandContext['channel'],
    msg: message(args.senderId ?? 'ou-admin', args.content),
    scope: args.scope ?? 'chat-1',
    chatMode: 'p2p',
    sessions: args.sessions,
    workspaces: new WorkspaceStore('/tmp/ws.json'),
    agent: new FakeAgentAdapter({ id: args.agentId ?? 'claude', displayName: 'Claude Code' }),
    activeRuns: args.activeRuns,
    discoverModels: args.discoverModels as CommandContext['discoverModels'],
    formValue: args.formValue,
    controls: controls(['ou-admin']),
  };
}

function message(senderId: string, content: string): NormalizedMessage {
  return {
    messageId: 'om-model',
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId,
    senderName: 'User',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function lastContent(channel: FakeChannel): Record<string, unknown> {
  return (channel.sent.at(-1)?.content ?? {}) as Record<string, unknown>;
}
function lastMarkdown(channel: FakeChannel): string {
  return String((lastContent(channel).markdown as string | undefined) ?? '');
}
function lastCard(channel: FakeChannel): Record<string, unknown> | undefined {
  return lastContent(channel).card as Record<string, unknown> | undefined;
}

describe('/model selection card (OPT-07 slice B)', () => {
  it('/model with no args sends the selection card, not a run', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    const handled = await tryHandleCommand(
      commandContext({
        channel,
        sessions,
        activeRuns: new ActiveRuns(),
        content: '/model',
        discoverModels: stubDiscover(),
      }),
    );
    expect(handled).toBe(true);
    expect(lastCard(channel)).toBeTruthy();
    expect(sessions.getModelPreference('chat-1', 'claude')).toBeUndefined();
  });

  it('/model list prints candidates as text for the text-reply path', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    await tryHandleCommand(
      commandContext({
        channel,
        sessions,
        activeRuns: new ActiveRuns(),
        content: '/model list',
        discoverModels: stubDiscover(),
      }),
    );
    expect(lastMarkdown(channel)).toContain('m1');
    expect(lastMarkdown(channel)).toContain('跟随 CLI 设置');
  });

  it('card submit applies the dropdown choice and bumps revision', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    const ok = await runCommandHandler(
      'model',
      'submit 0',
      commandContext({
        channel,
        sessions,
        activeRuns: new ActiveRuns(),
        content: '',
        formValue: { model: 'm2' },
        discoverModels: stubDiscover(),
      }),
    );
    expect(ok).toBe(true);
    expect(sessions.getModelPreference('chat-1', 'claude')?.model).toBe('m2');
    expect(sessions.getModelRevision('chat-1')).toBe(1);
    expect(lastMarkdown(channel)).toContain('已保存');
  });

  it('manual input wins over the dropdown', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    await runCommandHandler(
      'model',
      'submit 0',
      commandContext({
        channel,
        sessions,
        activeRuns: new ActiveRuns(),
        content: '',
        formValue: { model: 'm1', manual_model: 'custom:mine' },
        discoverModels: stubDiscover(),
      }),
    );
    expect(sessions.getModelPreference('chat-1', 'claude')?.model).toBe('custom:mine');
  });

  it('manual input may submit a reserved word verbatim', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    await runCommandHandler(
      'model',
      'submit 0',
      commandContext({
        channel,
        sessions,
        activeRuns: new ActiveRuns(),
        content: '',
        formValue: { manual_model: 'reset' },
        discoverModels: stubDiscover(),
      }),
    );
    expect(sessions.getModelPreference('chat-1', 'claude')?.model).toBe('reset');
  });

  it('a stale card (old revision) is rejected without changing state', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    await sessions.setModelPreference('chat-1', 'claude', 'current'); // revision -> 1
    await runCommandHandler(
      'model',
      'submit 0',
      commandContext({
        channel,
        sessions,
        activeRuns: new ActiveRuns(),
        content: '',
        formValue: { model: 'm1' },
        discoverModels: stubDiscover(),
      }),
    );
    expect(sessions.getModelPreference('chat-1', 'claude')?.model).toBe('current');
    expect(lastMarkdown(channel)).toContain('过期');
  });

  it('card submit from a non-admin is denied', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    await runCommandHandler(
      'model',
      'submit 0',
      commandContext({
        channel,
        sessions,
        activeRuns: new ActiveRuns(),
        content: '',
        senderId: 'ou-not-admin',
        formValue: { model: 'm1' },
        discoverModels: stubDiscover(),
      }),
    );
    expect(sessions.getModelPreference('chat-1', 'claude')).toBeUndefined();
    expect(lastMarkdown(channel)).toContain('仅管理员');
  });

  it('card submit applies even while a run is active (slice C: busy switching)', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    await sessions.setModelPreference('chat-1', 'claude', 'old'); // revision -> 1
    const activeRuns = new ActiveRuns();
    const agent = new FakeAgentAdapter({ id: 'claude' });
    // An in-flight run on the same scope must NOT block a model change; the
    // running task keeps the snapshot it was dispatched with (verified at the
    // dispatch layer), only future messages adopt the new choice.
    activeRuns.register('chat-1', agent.run({ runId: 'r', prompt: 'x' }));
    await runCommandHandler(
      'model',
      'submit 1',
      commandContext({
        channel,
        sessions,
        activeRuns,
        content: '',
        formValue: { model: 'm1' },
        discoverModels: stubDiscover(),
      }),
    );
    expect(sessions.getModelPreference('chat-1', 'claude')?.model).toBe('m1');
    expect(sessions.getModelRevision('chat-1')).toBe(2);
    expect(lastMarkdown(channel)).toContain('已保存');
  });
});

describe('/model command basics (OPT-07 slice A carried forward)', () => {
  it('text set persists and bumps revision', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    await tryHandleCommand(
      commandContext({
        channel,
        sessions,
        activeRuns: new ActiveRuns(),
        content: '/model claude-sonnet-4',
        discoverModels: stubDiscover(),
      }),
    );
    expect(sessions.getModelPreference('chat-1', 'claude')?.model).toBe('claude-sonnet-4');
    expect(sessions.getModelRevision('chat-1')).toBe(1);
  });

  it('preserves model id casing', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    await tryHandleCommand(
      commandContext({
        channel,
        sessions,
        activeRuns: new ActiveRuns(),
        content: '/model MyModel-V1',
        discoverModels: stubDiscover(),
      }),
    );
    expect(sessions.getModelPreference('chat-1', 'claude')?.model).toBe('MyModel-V1');
  });

  it('text reset clears the override', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    await sessions.setModelPreference('chat-1', 'claude', 'gpt-5');
    await tryHandleCommand(
      commandContext({
        channel,
        sessions,
        activeRuns: new ActiveRuns(),
        content: '/model reset',
        discoverModels: stubDiscover(),
      }),
    );
    expect(sessions.getModelPreference('chat-1', 'claude')).toBeUndefined();
    expect(lastMarkdown(channel)).toContain('已恢复');
  });

  it('denies set for non-admins', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    await tryHandleCommand(
      commandContext({
        channel,
        sessions,
        activeRuns: new ActiveRuns(),
        content: '/model gpt-5',
        senderId: 'ou-not-admin',
        discoverModels: stubDiscover(),
      }),
    );
    expect(lastMarkdown(channel)).toContain('仅管理员');
    expect(sessions.getModelPreference('chat-1', 'claude')).toBeUndefined();
  });

  it('rejects malformed model ids', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    await tryHandleCommand(
      commandContext({
        channel,
        sessions,
        activeRuns: new ActiveRuns(),
        content: '/model --evil',
        discoverModels: stubDiscover(),
      }),
    );
    expect(sessions.getModelPreference('chat-1', 'claude')).toBeUndefined();
    expect(lastMarkdown(channel)).toContain('不能以');
  });

  it('still allows viewing (card) while busy', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    const activeRuns = new ActiveRuns();
    const agent = new FakeAgentAdapter({ id: 'claude' });
    activeRuns.register('chat-1', agent.run({ runId: 'r', prompt: 'x' }));
    const handled = await tryHandleCommand(
      commandContext({
        channel,
        sessions,
        activeRuns,
        content: '/model',
        discoverModels: stubDiscover(),
      }),
    );
    expect(handled).toBe(true);
    expect(lastCard(channel)).toBeTruthy();
  });

  it('isolates selection per backend (agent id)', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    await tryHandleCommand(
      commandContext({
        channel,
        sessions,
        activeRuns: new ActiveRuns(),
        content: '/model claude-only',
        agentId: 'claude',
        discoverModels: stubDiscover(),
      }),
    );
    expect(sessions.getModelPreference('chat-1', 'claude')?.model).toBe('claude-only');
    expect(sessions.getModelPreference('chat-1', 'codex')).toBeUndefined();
  });
});

describe('/model 评审修复 (stale catalog + commit-time conflict)', () => {
  it('/model list shows a stale catalog with its last-updated time and candidates', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    const stale: ModelCatalogResult = {
      ...CANNED,
      status: 'stale',
      note: '刷新失败，以下为上次获取的候选列表（可能已过期）。',
    };
    await tryHandleCommand(
      commandContext({
        channel,
        sessions,
        activeRuns: new ActiveRuns(),
        content: '/model list',
        discoverModels: stubDiscover(stale),
      }),
    );
    const text = lastMarkdown(channel);
    expect(text).toContain('刷新失败');
    expect(text).toContain('上次更新');
    expect(text).toContain('m1');
    expect(text).toContain('跟随 CLI 设置');
  });

  it('two cards bound to the same revision: exactly one submit wins', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    await sessions.setModelPreference('chat-1', 'claude', 'current'); // revision -> 1
    const mkCtx = (formValue: Record<string, unknown>) =>
      commandContext({
        channel,
        sessions,
        activeRuns: new ActiveRuns(),
        content: '',
        formValue,
        discoverModels: stubDiscover(),
      });
    // Both cards were rendered at revision 1; they race through guard → write.
    await Promise.all([
      runCommandHandler('model', 'submit 1', mkCtx({ model: 'm1' })),
      runCommandHandler('model', 'submit 1', mkCtx({ model: 'm2' })),
    ]);
    // Exactly one apply succeeded; the loser was rejected with the stale-card
    // reply (at the guard or, after a lost race, at the commit-time check).
    const replies = channel.sent.map((entry) => String((entry.content as { markdown?: string }).markdown ?? ''));
    expect(replies.filter((text) => text.includes('已保存'))).toHaveLength(1);
    expect(replies.some((text) => text.includes('过期'))).toBe(true);
    expect(sessions.getModelPreference('chat-1', 'claude')?.model).toBe('m1');
    expect(sessions.getModelRevision('chat-1')).toBe(2);
  });
});

describe('commandKeepsPendingQueue', () => {
  it('keeps the queue only for /model', () => {
    expect(commandKeepsPendingQueue('/model')).toBe(true);
    expect(commandKeepsPendingQueue('/model reset')).toBe(true);
    expect(commandKeepsPendingQueue('  /model gpt-5  ')).toBe(true);
    expect(commandKeepsPendingQueue('/new')).toBe(false);
    expect(commandKeepsPendingQueue('/status')).toBe(false);
    expect(commandKeepsPendingQueue('hello')).toBe(false);
  });
});
