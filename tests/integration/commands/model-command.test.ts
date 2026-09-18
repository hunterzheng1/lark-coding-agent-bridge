import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import {
  commandKeepsPendingQueue,
  tryHandleCommand,
  type CommandContext,
  type Controls,
} from '../../../src/commands';
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

async function makeStore(): Promise<SessionStore> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-model-'));
  roots.push(root);
  const store = new SessionStore(join(root, 'sessions.json'));
  await store.load();
  return store;
}

function controls(owner: string, admins: string[]): Controls {
  const profileConfig = profile(owner, admins);
  return {
    profile: 'claude',
    profileConfig,
    botOwnerId: owner,
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'self',
    async restart() {},
    async exit() {},
  };
}

function profile(owner: string, admins: string[]): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    access: { admins },
  });
  config.workspaces.default = join(tmpdir(), 'unused');
  void owner;
  return config;
}

interface CtxArgs {
  channel: FakeChannel;
  sessions: SessionStore;
  activeRuns: ActiveRuns;
  content: string;
  senderId?: string;
  agentId?: string;
  hasPendingForScope?: (scope: string) => boolean;
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
    hasPendingForScope: args.hasPendingForScope,
    controls: controls('ou-owner', ['ou-admin']),
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

function lastMarkdown(channel: FakeChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: string } | undefined;
  return content?.markdown ?? '';
}

describe('/model command (OPT-07 slice A)', () => {
  it('view reports "follow CLI" when nothing is set, without changing state', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    const handled = await tryHandleCommand(
      commandContext({ channel, sessions, activeRuns: new ActiveRuns(), content: '/model' }),
    );
    expect(handled).toBe(true);
    expect(lastMarkdown(channel)).toContain('跟随 CLI 设置');
    expect(sessions.getModelPreference('chat-1', 'claude')).toBeUndefined();
  });

  it('persists a selection for admins and reads it back', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    const handled = await tryHandleCommand(
      commandContext({
        channel,
        sessions,
        activeRuns: new ActiveRuns(),
        content: '/model claude-sonnet-4',
      }),
    );
    expect(handled).toBe(true);
    expect(sessions.getModelPreference('chat-1', 'claude')?.model).toBe('claude-sonnet-4');
    expect(lastMarkdown(channel)).toContain('已保存');

    await tryHandleCommand(
      commandContext({ channel, sessions, activeRuns: new ActiveRuns(), content: '/model' }),
    );
    expect(lastMarkdown(channel)).toContain('claude-sonnet-4');
  });

  it('preserves model id casing', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    await tryHandleCommand(
      commandContext({ channel, sessions, activeRuns: new ActiveRuns(), content: '/model MyModel-V1' }),
    );
    expect(sessions.getModelPreference('chat-1', 'claude')?.model).toBe('MyModel-V1');
  });

  it('denies set for non-admins but leaves the preference untouched', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    await tryHandleCommand(
      commandContext({
        channel,
        sessions,
        activeRuns: new ActiveRuns(),
        content: '/model gpt-5',
        senderId: 'ou-not-admin',
      }),
    );
    expect(lastMarkdown(channel)).toContain('仅管理员');
    expect(sessions.getModelPreference('chat-1', 'claude')).toBeUndefined();
  });

  it('allows non-admins to view', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    const handled = await tryHandleCommand(
      commandContext({
        channel,
        sessions,
        activeRuns: new ActiveRuns(),
        content: '/model',
        senderId: 'ou-not-admin',
      }),
    );
    expect(handled).toBe(true);
    expect(lastMarkdown(channel)).toContain('模型设置');
  });

  it('reset clears the override', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    await sessions.setModelPreference('chat-1', 'claude', 'gpt-5');
    await tryHandleCommand(
      commandContext({ channel, sessions, activeRuns: new ActiveRuns(), content: '/model reset' }),
    );
    expect(sessions.getModelPreference('chat-1', 'claude')).toBeUndefined();
    expect(lastMarkdown(channel)).toContain('已恢复');
  });

  it('rejects changes while a run is active, keeping the old value', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    await sessions.setModelPreference('chat-1', 'claude', 'old-model');
    const activeRuns = new ActiveRuns();
    const agent = new FakeAgentAdapter({ id: 'claude' });
    activeRuns.register('chat-1', agent.run({ runId: 'r1', prompt: 'x' }));
    await tryHandleCommand(
      commandContext({
        channel,
        sessions,
        activeRuns,
        content: '/model new-model',
      }),
    );
    expect(lastMarkdown(channel)).toContain('正在运行');
    expect(sessions.getModelPreference('chat-1', 'claude')?.model).toBe('old-model');
  });

  it('rejects changes while messages are queued for the scope', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    await tryHandleCommand(
      commandContext({
        channel,
        sessions,
        activeRuns: new ActiveRuns(),
        content: '/model new-model',
        hasPendingForScope: () => true,
      }),
    );
    expect(lastMarkdown(channel)).toContain('排队中');
    expect(sessions.getModelPreference('chat-1', 'claude')).toBeUndefined();
  });

  it('still allows viewing while busy', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    await sessions.setModelPreference('chat-1', 'claude', 'busy-model');
    const activeRuns = new ActiveRuns();
    const agent = new FakeAgentAdapter({ id: 'claude' });
    activeRuns.register('chat-1', agent.run({ runId: 'r1', prompt: 'x' }));
    const handled = await tryHandleCommand(
      commandContext({ channel, sessions, activeRuns, content: '/model' }),
    );
    expect(handled).toBe(true);
    expect(lastMarkdown(channel)).toContain('busy-model');
  });

  it('rejects malformed model ids', async () => {
    const channel = createFakeChannel();
    const sessions = await makeStore();
    await tryHandleCommand(
      commandContext({ channel, sessions, activeRuns: new ActiveRuns(), content: '/model --evil' }),
    );
    expect(sessions.getModelPreference('chat-1', 'claude')).toBeUndefined();
    expect(lastMarkdown(channel)).toContain('不能以');
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
      }),
    );
    // A codex-backend context on the same scope sees no override.
    await tryHandleCommand(
      commandContext({
        channel,
        sessions,
        activeRuns: new ActiveRuns(),
        content: '/model',
        agentId: 'codex',
      }),
    );
    expect(sessions.getModelPreference('chat-1', 'codex')).toBeUndefined();
    expect(lastMarkdown(channel)).toContain('跟随 CLI 设置');
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
