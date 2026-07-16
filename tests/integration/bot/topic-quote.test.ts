import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { SessionStore } from '../../../src/session/store.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  streams: Array<{ chatId: string; options: unknown }>;
  botIdentity: { openId: string; name: string };
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    im: {
      v1: {
        message: {
          list: ReturnType<typeof vi.fn>;
        };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  getAppInfo: ReturnType<typeof vi.fn>;
  listChats: ReturnType<typeof vi.fn>;
  fetchRawMessage: ReturnType<typeof vi.fn>;
  recallMessage: ReturnType<typeof vi.fn>;
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<{ messageId: string }>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('topic message quote handling', () => {
  it('does not quote the topic root when a user directly mentions the bot inside the topic', async () => {
    const h = await createHarness();

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_direct_at',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
        threadId: 'omt_topic',
        content: '@Bridge 继续说一下',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.agent.runOptions).toHaveLength(1);
    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('"threadId":"omt_topic"');
    expect(prompt).not.toContain('<quoted_messages>');
    expect(prompt).not.toContain('topic root content');
    expect(h.channel.fetchRawMessage).not.toHaveBeenCalled();
  });

  it('recalls a streamed reply when the agent finishes without visible content', async () => {
    const h = await createHarness({
      chatMode: 'group',
      agentEvents: [{ type: 'done', terminationReason: 'normal' }],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_empty',
        rootId: 'om_empty',
        parentId: 'om_empty',
        content: '@Bridge ping',
      }),
    );
    await waitFor(() => h.channel.recallMessage.mock.calls.length === 1);

    expect(h.channel.recallMessage).toHaveBeenCalledWith('om_stream_1');
  });

  it('keeps the streamed reply when the agent produced visible content', async () => {
    const h = await createHarness({
      chatMode: 'group',
      agentEvents: [
        { type: 'text', delta: 'visible answer' },
        { type: 'done', terminationReason: 'normal' },
      ],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_visible',
        rootId: 'om_visible',
        parentId: 'om_visible',
        content: '@Bridge question',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.channel.recallMessage).not.toHaveBeenCalled();
  });

  it('backfills a missing threadId before routing a topic reply', async () => {
    const h = await createHarness({
      chatMode: 'topic',
      rawThreadIds: { om_topic_start: 'omt_backfilled' },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_topic_start',
        rootId: 'om_topic_start',
        parentId: 'om_topic_start',
        content: '@Bridge start topic',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.channel.fetchRawMessage).toHaveBeenCalledWith('om_topic_start');
    expect(h.agent.runOptions[0]?.prompt).toContain('"threadId":"omt_backfilled"');
    await waitFor(() => h.channel.streams.length === 1);
    expect(h.channel.streams[0]?.options).toMatchObject({
      replyTo: 'om_topic_start',
      replyInThread: true,
    });
  });

  it('keeps explicit thread routing when the cached chat mode is stale', async () => {
    const h = await createHarness({
      chatMode: 'group',
      threadMessages: [
        {
          message_id: 'om_topic_root',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: 'latest topic context' }) },
          sender: { id: 'ou_asker', sender_type: 'user' },
          create_time: '1760000000000',
          thread_id: 'omt_explicit',
        },
      ],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_explicit_thread',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
        threadId: 'omt_explicit',
        content: '@Bridge continue',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.agent.runOptions[0]?.prompt).toContain('latest topic context');
    expect(h.channel.streams[0]?.options).toMatchObject({ replyInThread: true });
  });

  it('falls back to chat routing when a topic threadId cannot be recovered', async () => {
    const h = await createHarness({ chatMode: 'topic' });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_no_thread',
        rootId: 'om_no_thread',
        parentId: 'om_no_thread',
        content: '@Bridge no thread',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.channel.fetchRawMessage).toHaveBeenCalledWith('om_no_thread');
    await waitFor(() => h.channel.streams.length === 1);
    expect(h.channel.streams[0]?.options).not.toMatchObject({ replyInThread: true });
  });

  it('injects topic history on the first run in a topic scope', async () => {
    const h = await createHarness({
      chatMode: 'topic',
      threadMessages: [
        {
          message_id: 'om_topic_root',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: 'upstream question' }) },
          sender: { id: 'ou_asker', sender_type: 'user' },
          create_time: '1760000000000',
          thread_id: 'omt_topic',
        },
        {
          message_id: 'om_topic_at',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: '@Bridge review' }) },
          sender: { id: 'ou_user', sender_type: 'user' },
          create_time: '1760000001000',
          thread_id: 'omt_topic',
        },
      ],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_topic_at',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
        threadId: 'omt_topic',
        content: '@Bridge review',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('<topic_context>');
    expect(prompt).toContain('upstream question');
    const context = prompt.slice(prompt.indexOf('<topic_context>'), prompt.indexOf('</topic_context>'));
    expect(context).not.toContain('om_topic_at');
  });

  it('still injects topic history when SessionStore only contains preferences', async () => {
    const h = await createHarness({
      chatMode: 'topic',
      threadMessages: [
        {
          message_id: 'om_topic_root',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: 'context despite timeout preference' }) },
          sender: { id: 'ou_asker', sender_type: 'user' },
          create_time: '1760000000000',
          thread_id: 'omt_preferences',
        },
      ],
    });
    h.sessions.setIdleTimeoutMinutes('oc_topic_chat:omt_preferences', 5);
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_preferences',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
        threadId: 'omt_preferences',
        content: '@Bridge review',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.agent.runOptions[0]?.prompt).toContain('context despite timeout preference');
  });

  it('uses the latest messages from a long topic', async () => {
    const threadMessages = Array.from({ length: 205 }, (_, index) => {
      const number = index + 1;
      return {
        message_id: `om_history_${number}`,
        msg_type: 'text',
        body: { content: JSON.stringify({ text: `topic message ${number}` }) },
        sender: { id: 'ou_asker', sender_type: 'user' },
        create_time: String(1760000000000 + number),
        thread_id: 'omt_long',
      };
    });
    const h = await createHarness({ chatMode: 'topic', threadMessages });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_long_trigger',
        rootId: 'om_history_1',
        parentId: 'om_history_205',
        threadId: 'omt_long',
        content: '@Bridge summarize latest',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('topic message 204');
    expect(prompt).not.toContain('topic message 164');
    expect(h.channel.rawClient.im.v1.message.list).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ sort_type: 'ByCreateTimeDesc' }),
      }),
    );
  });

  it('does not reinject topic history after the topic scope has a session', async () => {
    const h = await createHarness({
      chatMode: 'topic',
      threadMessages: [
        {
          message_id: 'om_topic_root',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: 'upstream question' }) },
          sender: { id: 'ou_asker', sender_type: 'user' },
          create_time: '1760000000000',
          thread_id: 'omt_existing',
        },
      ],
    });
    h.sessions.set('oc_topic_chat:omt_existing', 'sess_existing', await realpath(h.tmp.workspace));
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_followup',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
        threadId: 'omt_existing',
        content: '@Bridge continue',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.channel.rawClient.im.v1.message.list).not.toHaveBeenCalled();
    expect(h.agent.runOptions[0]?.prompt).not.toContain('<topic_context>');
  });

  it('does not reinject topic history after a Codex thread is catalogued', async () => {
    const h = await createHarness({
      agentKind: 'codex',
      chatMode: 'topic',
      threadMessages: [
        {
          message_id: 'om_topic_root',
          msg_type: 'text',
          body: { content: JSON.stringify({ text: 'upstream question' }) },
          sender: { id: 'ou_asker', sender_type: 'user' },
          create_time: '1760000000000',
          thread_id: 'omt_codex',
        },
      ],
      agentEventRuns: [
        [
          { type: 'system', threadId: 'codex-thread-1' },
          { type: 'final_text', content: 'first answer' },
          { type: 'done', threadId: 'codex-thread-1', terminationReason: 'normal' },
        ],
        [
          { type: 'system', threadId: 'codex-thread-1' },
          { type: 'final_text', content: 'second answer' },
          { type: 'done', threadId: 'codex-thread-1', terminationReason: 'normal' },
        ],
      ],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_first_codex',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
        threadId: 'omt_codex',
        content: '@Bridge first',
      }),
    );
    await waitFor(() => h.sessionCatalog.entries().some((entry) => entry.threadId === 'codex-thread-1'));
    h.channel.rawClient.im.v1.message.list.mockClear();

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_second_codex',
        rootId: 'om_topic_root',
        parentId: 'om_topic_root',
        threadId: 'omt_codex',
        content: '@Bridge second',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.channel.rawClient.im.v1.message.list).not.toHaveBeenCalled();
  });

  it('keeps regular group reply quotes as quoted context', async () => {
    const h = await createHarness({
      chatMode: 'group',
      quotedMessages: {
        om_quote_target: 'regular quoted content',
      },
    });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_group_reply',
        rootId: 'om_quote_target',
        parentId: 'om_quote_target',
        content: '@Bridge 看这条',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('<quoted_messages>');
    expect(prompt).toContain('regular quoted content');
    expect(h.channel.fetchRawMessage).toHaveBeenCalledWith(
      'om_quote_target',
      expect.objectContaining({ cardContentType: 'user_card_content' }),
    );
  });

  it('keeps non-root reply quotes in topic chats', async () => {
    const h = await createHarness({
      quotedMessages: {
        om_topic_parent: 'topic parent content',
      },
    });

    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_topic_reply',
        rootId: 'om_topic_root',
        parentId: 'om_topic_parent',
        threadId: 'omt_topic',
        content: '@Bridge 看父消息',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('<quoted_messages>');
    expect(prompt).toContain('topic parent content');
    expect(h.channel.fetchRawMessage).toHaveBeenCalledWith(
      'om_topic_parent',
      expect.objectContaining({ cardContentType: 'user_card_content' }),
    );
  });
});

async function createHarness(options: {
  chatMode?: 'group' | 'topic';
  quotedMessages?: Record<string, string>;
  agentEvents?: AgentEvent[];
  agentEventRuns?: AgentEvent[][];
  agentKind?: 'claude' | 'codex';
  rawThreadIds?: Record<string, string>;
  threadMessages?: Array<Record<string, unknown>>;
} = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel & { handlers: MessageHandlerMap };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  sessionCatalog: SessionCatalog;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('topic-quote-');
  const workspace = await realpath(tmp.workspace);
  const agentKind = options.agentKind ?? 'claude';
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind,
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedChats: ['oc_topic_chat'],
      allowedUsers: ['ou_user'],
    },
    ...(agentKind === 'codex' ? { codex: { binaryPath: '/usr/local/bin/codex' } } : {}),
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const sessionCatalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: agentKind,
    events:
      options.agentEventRuns ??
      options.agentEvents ??
      [{ type: 'done', terminationReason: 'normal' }],
  });
  const channel = createFakeLarkChannel(options);
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), sessionCatalog.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    sessionCatalog,
    workspaces,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  sessionCatalog: SessionCatalog;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    sessionCatalog: h.sessionCatalog,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(options: {
  chatMode?: 'group' | 'topic';
  quotedMessages?: Record<string, string>;
  rawThreadIds?: Record<string, string>;
  threadMessages?: Array<Record<string, unknown>>;
} = {}): FakeLarkChannel & { handlers: MessageHandlerMap } {
  const handlers: MessageHandlerMap = {};
  const streams: Array<{ chatId: string; options: unknown }> = [];
  const chatMode = options.chatMode ?? 'topic';
  const quotedMessages = options.quotedMessages ?? {
    om_topic_root: 'topic root content',
  };
  const rawThreadIds = options.rawThreadIds ?? {};
  const threadMessages = options.threadMessages ?? [];
  return {
    handlers,
    streams,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      im: {
        v1: {
          message: {
            list: vi.fn(async (request: { params?: Record<string, unknown> }) => {
              const params = request.params ?? {};
              const ordered =
                params.sort_type === 'ByCreateTimeDesc'
                  ? [...threadMessages].reverse()
                  : [...threadMessages];
              const offset = Number(params.page_token ?? 0);
              const pageSize = Number(params.page_size ?? 50);
              const items = ordered.slice(offset, offset + pageSize);
              const nextOffset = offset + items.length;
              const hasMore = nextOffset < ordered.length;
              return {
                data: {
                  items,
                  has_more: hasMore,
                  ...(hasMore ? { page_token: String(nextOffset) } : {}),
                },
              };
            }),
          },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    getAppInfo: vi.fn(async () => ({ ownerId: 'ou_owner' })),
    listChats: vi.fn(async () => []),
    fetchRawMessage: vi.fn(async (messageId: string) => [
      {
        message_id: messageId,
        msg_type: 'text',
        body: {
          content: JSON.stringify({
            text: quotedMessages[messageId] ?? 'quoted content',
          }),
        },
        create_time: '1760000000000',
        sender: { id: 'ou_quote_sender' },
        ...(rawThreadIds[messageId] ? { thread_id: rawThreadIds[messageId] } : {}),
      },
    ]),
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return chatMode;
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send() {
      return { messageId: 'om_sent_1' };
    },
    async stream(chatId, input, options) {
      streams.push({ chatId, options });
      if (isMarkdownStreamInput(input)) {
        await input.markdown({ setContent: async () => {} });
      }
      return { messageId: 'om_stream_1' };
    },
    recallMessage: vi.fn(async () => {}),
  };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'test',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(input: {
  messageId: string;
  rootId: string;
  parentId: string;
  threadId?: string;
  content: string;
}): NormalizedMessage {
  return {
    messageId: input.messageId,
    chatId: 'oc_topic_chat',
    chatType: 'group',
    senderId: 'ou_user',
    senderName: 'User',
    content: input.content,
    rawContentType: 'text',
    resources: [],
    mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }],
    mentionAll: false,
    mentionedBot: true,
    rootId: input.rootId,
    parentId: input.parentId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    replyToMessageId: input.parentId,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

interface MarkdownStreamInput {
  markdown(ctrl: { setContent(markdown: string): Promise<void> }): Promise<void> | void;
}

function isMarkdownStreamInput(input: unknown): input is MarkdownStreamInput {
  return Boolean(input && typeof input === 'object' && 'markdown' in input);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
