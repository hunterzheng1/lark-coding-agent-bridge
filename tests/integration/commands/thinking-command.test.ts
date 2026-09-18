import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { SessionStore } from '../../../src/session/store.js';
import { ThinkingHistoryStore } from '../../../src/session/thinking-history.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface Harness {
  channel: FakeChannel;
  history: ThinkingHistoryStore;
  activeRuns: ActiveRuns;
  run(content: string, overrides?: { scope?: string; chatId?: string }): Promise<boolean>;
  /** All markdown replies sent so far, in order. */
  replies(): string[];
  lastReply(): string;
}

async function createHarness(): Promise<Harness> {
  const tmp = await createTmpProfile('thinking-cmd-');
  const channel = createFakeChannel();
  const workspaceRealpath = await realpath(tmp.workspace);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const history = new ThinkingHistoryStore(join(tmp.profile, 'thinking'));
  await history.load();
  const activeRuns = new ActiveRuns();
  const profileConfig: ProfileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'], allowedUsers: ['ou-user'] },
  });
  profileConfig.workspaces.default = workspaceRealpath;
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.root, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  workspaces.setCwd('chat-1', workspaceRealpath);

  const run = (
    content: string,
    overrides: { scope?: string; chatId?: string } = {},
  ): Promise<boolean> => {
    const chatId = overrides.chatId ?? 'chat-1';
    const scope = overrides.scope ?? chatId;
    const ctx: CommandContext = {
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content, chatId),
      scope,
      chatMode: 'p2p',
      sessions,
      workspaces,
      agent: createFakeAgent(),
      activeRuns,
      controls,
      thinkingHistory: history,
    };
    return tryHandleCommand(ctx);
  };

  const replies = (): string[] =>
    channel.sent
      .map((s) =>
        s.content && typeof s.content === 'object' && 'markdown' in (s.content as object)
          ? String((s.content as { markdown?: string }).markdown ?? '')
          : '',
      )
      .filter((md) => md !== '');

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush(), history.flush()]);
    await tmp.cleanup();
  });

  return {
    channel,
    history,
    activeRuns,
    run,
    replies,
    lastReply: () => {
      const all = replies();
      return all[all.length - 1] ?? '';
    },
  };
}

function message(content: string, chatId: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId,
    chatType: 'p2p',
    senderId: 'ou-admin',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  } as unknown as NormalizedMessage;
}

/** Page body = everything between the header block and the footer line. */
function pageBody(reply: string): string {
  const start = reply.indexOf('\n\n');
  const footer = reply.lastIndexOf('\n\n📄');
  const end = footer === -1 ? reply.length : footer;
  return reply.slice(start + 2, end);
}

function totalPages(reply: string): number {
  const m = reply.match(/第 1\/(\d+) 页/);
  if (!m) throw new Error(`reply has no page marker: ${reply.slice(0, 120)}`);
  return Number.parseInt(m[1]!, 10);
}

const RUN_A = 'aaaaaaaa-1111-4444-8888-aaaaaaaaaaaa';
const RUN_B = 'bbbbbbbb-2222-4444-8888-bbbbbbbbbbbb';

async function save(
  h: Harness,
  overrides: Partial<Parameters<ThinkingHistoryStore['save']>[0]>,
): Promise<void> {
  const now = Date.now();
  await h.history.save({
    scope: 'chat-1',
    runId: RUN_A,
    agent: 'claude',
    startedAt: now - 1_000,
    endedAt: now,
    terminal: 'done',
    content: '',
    ...overrides,
  });
}

describe('/thinking command', () => {
  it('replies that no records exist yet', async () => {
    const h = await createHarness();
    await h.run('/thinking');
    expect(h.lastReply()).toContain('暂无');
  });

  it('shows the latest run record; all pages concatenate back to the stored content', async () => {
    const h = await createHarness();
    const content = `甲${'x'.repeat(6000)}\nPAGE_BREAK_MARKER\n乙尾`;
    await save(h, { runId: RUN_A, content });

    await h.run('/thinking');
    const first = h.lastReply();
    expect(first).toContain('run aaaaaaaa');
    expect(first).toContain('第 1/');
    const total = totalPages(first);

    const pages: string[] = [pageBody(first)];
    for (let p = 2; p <= total; p++) {
      await h.run(`/thinking aaaaaaaa ${p}`);
      pages.push(pageBody(h.lastReply()));
    }
    expect(pages.join('')).toBe(content);
  });

  it('latest run without thinking does not leak the previous run content', async () => {
    const h = await createHarness();
    await save(h, { runId: RUN_A, content: 'secret previous thoughts' });
    await save(h, { runId: RUN_B, content: '' });

    await h.run('/thinking');
    const reply = h.lastReply();
    expect(reply).toContain('bbbbbbbb');
    expect(reply).toContain('没有思考');
    expect(reply).not.toContain('secret previous thoughts');
    // Older runs stay reachable explicitly via the advertised command form.
    expect(reply).toMatch(/\/thinking\s+[0-9a-f]/);
  });

  it('queries an explicit run by id prefix; missing and ambiguous are distinct', async () => {
    const h = await createHarness();
    await save(h, { runId: RUN_A, content: 'run A thoughts' });

    await h.run('/thinking aaaaaaaa');
    expect(h.lastReply()).toContain('run A thoughts');

    await save(h, { runId: RUN_B, content: 'run B thoughts' });
    await h.run('/thinking bbbbbbbb 1');
    expect(h.lastReply()).toContain('run B thoughts');

    await h.run('/thinking nosuchrun');
    expect(h.lastReply()).toContain('未找到');

    await h.run('/thinking b');
    expect(h.lastReply()).toContain('不唯一');
  });

  it('rejects out-of-range page numbers without inventing content', async () => {
    const h = await createHarness();
    await save(h, { runId: RUN_A, content: 'short' });
    await h.run('/thinking 9');
    expect(h.lastReply()).toContain('页码');
  });

  it('marks partial records instead of presenting them as complete', async () => {
    const h = await createHarness();
    await save(h, { runId: RUN_A, content: 'x'.repeat(150_000) });
    await h.run('/thinking');
    expect(h.lastReply()).toContain('部分');
    expect(h.lastReply()).toContain('150000');
  });

  it('scope isolation: another scope cannot read this scope’s runs', async () => {
    const h = await createHarness();
    await save(h, { runId: RUN_A, content: 'chat-1 private thoughts' });
    await h.run('/thinking aaaaaaaa', { scope: 'chat-2', chatId: 'chat-2' });
    expect(h.lastReply()).toContain('未找到');
    expect(h.lastReply()).not.toContain('chat-1 private thoughts');
  });

  it('degrades gracefully when no store is wired', async () => {
    const tmp: TmpProfile = await createTmpProfile('thinking-cmd-nostore-');
    cleanups.push(() => tmp.cleanup());
    const channel = createFakeChannel();
    const profileConfig = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
      access: { admins: ['ou-admin'] },
    });
    profileConfig.workspaces.default = await realpath(tmp.workspace);
    const controls = {
      profile: 'claude',
      profileConfig,
      ownerRefreshState: 'ok',
      async refreshOwner() {},
      restart: vi.fn(async () => {}),
      exit: vi.fn(async () => {}),
      configPath: join(tmp.root, 'config.json'),
      cfg: profileConfig,
      processId: 'proc-1',
    } satisfies Controls;
    await tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message('/thinking', 'chat-1'),
      scope: 'chat-1',
      chatMode: 'p2p',
      sessions: new SessionStore(join(tmp.profile, 'sessions.json')),
      workspaces: new WorkspaceStore(join(tmp.profile, 'workspaces.json')),
      agent: createFakeAgent(),
      activeRuns: new ActiveRuns(),
      controls,
    });
    const markdowns = channel.sent
      .map((s) =>
        s.content && typeof s.content === 'object' && 'markdown' in (s.content as object)
          ? String((s.content as { markdown?: string }).markdown ?? '')
          : '',
      )
      .filter(Boolean);
    expect(markdowns.some((md) => md.includes('不可用'))).toBe(true);
  });
});

describe('/thinking while a run is active (评审修复)', () => {
  it('says the current run is not saved yet and labels the reply as the previous round', async () => {
    const h = await createHarness();
    await save(h, { runId: RUN_A, content: 'previous round thoughts' });
    const agent = createFakeAgent();
    h.activeRuns.register('chat-1', agent.run({ runId: 'run-live', prompt: 'busy' }));

    await h.run('/thinking');
    const reply = h.lastReply();
    expect(reply).toContain('正在运行');
    expect(reply).toContain('上一轮');
    expect(reply).toContain('previous round thoughts');
  });

  it('running with no saved records says so without showing anything stale', async () => {
    const h = await createHarness();
    const agent = createFakeAgent();
    h.activeRuns.register('chat-1', agent.run({ runId: 'run-live', prompt: 'busy' }));

    await h.run('/thinking');
    expect(h.lastReply()).toContain('正在运行');
    expect(h.lastReply()).not.toContain('上一轮');
  });
});
