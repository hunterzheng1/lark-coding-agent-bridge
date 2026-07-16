import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import type { AgentEvent } from '../../../src/agent/types';
import { SessionStore } from '../../../src/session/store.js';
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
  return { ...actual, createLarkChannel: sdkMock.createLarkChannel };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeStreamRecord {
  chatId: string;
  input: unknown;
  options: unknown;
  markdownContents: string[];
  cardUpdates: unknown[];
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  streams: FakeStreamRecord[];
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: { v6: { application: { get: ReturnType<typeof vi.fn> } } };
    im: {
      v1: {
        message: { get: ReturnType<typeof vi.fn> };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<{ messageId: string }>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

// Narration longer than maxTextChars (4000) so the run is truncated and the
// old code would dump the whole transcript as a standalone message.
const NARRATION = 'N'.repeat(4500);
const FINAL_REPLY = 'final answer';
const FULL_TEXT = NARRATION + FINAL_REPLY;

describe('run output fragmentation — text mode', () => {
  it('INT-001: posts only the final reply, no fullText dump, notice mentions /last, /last recall stores fullText', async () => {
    const h = await createHarness('text');
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_one', 'do the thing'));
    await waitFor(() => h.channel.sent.some((s) => markdownOf(s)?.includes('✅ 完成')));

    // No standalone fullText dump (the bug this change fixes).
    expect(h.channel.sent.find((s) => markdownOf(s) === FULL_TEXT)).toBeUndefined();
    // Text mode posts only the final reply (text after the last tool).
    expect(h.channel.sent.find((s) => markdownOf(s) === FINAL_REPLY)).toBeTruthy();
    // No outbound message carries the long narration prefix.
    expect(
      h.channel.sent.filter((s) => (markdownOf(s) ?? '').includes(NARRATION.slice(0, 100))),
    ).toHaveLength(0);
    // Completion notice flags /last because the run was truncated.
    const notice = h.channel.sent
      .map((s) => markdownOf(s) ?? '')
      .find((md) => md.includes('✅ 完成'));
    expect(notice).toContain('/last');
    // /last recall still stores the whole run transcript.
    expect(h.sessions.getLastRunOutput('oc_dm')).toBe(FULL_TEXT);
  });
});

describe('run output fragmentation — markdown mode', () => {
  it('INT-002: streams the bounded window, no fullText dump, notice mentions /last', async () => {
    const h = await createHarness('markdown');
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_one', 'do the thing'));
    await waitFor(() => h.channel.sent.some((s) => markdownOf(s)?.includes('✅ 完成')));

    expect(h.channel.sent.find((s) => markdownOf(s) === FULL_TEXT)).toBeUndefined();
    const notice = h.channel.sent
      .map((s) => markdownOf(s) ?? '')
      .find((md) => md.includes('✅ 完成'));
    expect(notice).toContain('/last');

    expect(h.channel.streams.length).toBeGreaterThan(0);
    const streamMd = h.channel.streams[0]!.markdownContents.at(-1) ?? '';
    expect(streamMd).not.toContain(FINAL_REPLY);
    expect(streamMd.length).toBeLessThan(NARRATION.length);
    expect(h.channel.sent.some((sent) => markdownOf(sent) === FINAL_REPLY)).toBe(true);
  });

  it('delivers the final answer even when the progress stream fails', async () => {
    const h = await createHarness('markdown', {
      streamFailure: new Error('progress stream failed'),
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_stream_fail', 'do the thing'));
    await waitFor(() => h.channel.sent.some((sent) => markdownOf(sent) === FINAL_REPLY));

    expect(h.channel.sent.some((sent) => markdownOf(sent) === FINAL_REPLY)).toBe(true);
  });

  it('delivers the final answer when a live progress update fails', async () => {
    const h = await createHarness('markdown', {
      streamUpdateFailure: new Error('progress update failed'),
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_update_fail', 'do the thing'));
    await waitFor(() => h.channel.sent.some((sent) => markdownOf(sent) === FINAL_REPLY));

    expect(h.sessions.getLastRunOutput('oc_dm')).toBe(FULL_TEXT);
  });

  it('falls back to a visible Claude answer when a later progress update fails', async () => {
    const claudeAnswer = 'claude final answer';
    const h = await createHarness('markdown', {
      agentKind: 'claude',
      agentEvents: [
        { type: 'text', delta: claudeAnswer },
        { type: 'done', terminationReason: 'normal' },
      ],
      streamUpdateFailureAfter: 2,
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_claude_update_fail', 'do the thing'));
    await waitFor(() => h.channel.sent.some((sent) => markdownOf(sent) === claudeAnswer));

    expect(h.channel.sent.some((sent) => markdownOf(sent) === claudeAnswer)).toBe(true);
  });

  it('does not duplicate a Claude answer after a transient progress update failure recovers', async () => {
    const claudeAnswer = 'claude recovered answer';
    const h = await createHarness('markdown', {
      agentKind: 'claude',
      agentEvents: [
        { type: 'text', delta: claudeAnswer },
        { type: 'done', terminationReason: 'normal' },
      ],
      streamUpdateFailureOnceAt: 2,
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_claude_update_recovered', 'do the thing'));
    await waitFor(() => h.channel.streams[0]?.markdownContents.at(-1) === claudeAnswer);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.channel.sent.some((sent) => markdownOf(sent) === claudeAnswer)).toBe(false);
  });

  it('does not let a stuck empty progress stream block the final answer', async () => {
    const h = await createHarness('markdown', {
      streamNeverSettles: true,
      narration: '',
      includeTools: false,
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_stream_stuck', 'do the thing'));
    await waitFor(
      () => h.channel.sent.some((sent) => markdownOf(sent) === FINAL_REPLY),
      5000,
    );

    expect(h.channel.sent.some((sent) => markdownOf(sent) === FINAL_REPLY)).toBe(true);
  });
});

describe('run output fragmentation — card mode', () => {
  it('sends the reserved Codex final answer as a dedicated final card', async () => {
    const h = await createHarness('card');
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_card', 'do the thing'));
    await waitFor(() =>
      h.channel.sent.some((sent) => JSON.stringify(sent.content).includes(FINAL_REPLY)),
    );

    const finalCard = h.channel.sent.find((sent) =>
      JSON.stringify(sent.content).includes(FINAL_REPLY),
    );
    expect(finalCard?.content).toHaveProperty('card');
    expect(h.sessions.getLastRunOutput('oc_dm')).toBe(FULL_TEXT);
  });

  it('adds a /last hint when the reserved final card is truncated', async () => {
    const longFinal = 'F'.repeat(4500);
    const h = await createHarness('card', { narration: 'short progress', finalReply: longFinal });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_long_final', 'do the thing'));
    await waitFor(() =>
      h.channel.sent.some((sent) => JSON.stringify(sent.content).includes('F'.repeat(100))),
    );

    expect(h.channel.sent.some((sent) => (markdownOf(sent) ?? '').includes('/last'))).toBe(true);
    expect(h.sessions.getLastRunOutput('oc_dm')).toBe(`short progress${longFinal}`);
  });
});

interface Harness {
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}

async function createHarness(
  replyMode: 'text' | 'markdown' | 'card',
  options: {
    streamFailure?: Error;
    streamUpdateFailure?: Error;
    streamNeverSettles?: boolean;
    narration?: string;
    finalReply?: string;
    includeTools?: boolean;
    agentKind?: 'claude' | 'codex';
    agentEvents?: AgentEvent[];
    streamUpdateFailureAfter?: number;
    streamUpdateFailureOnceAt?: number;
  } = {},
): Promise<Harness> {
  const tmp = await createTmpProfile('run-output-fragmentation-');
  const workspace = await realpath(tmp.workspace);
  const agentKind = options.agentKind ?? 'codex';
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
      allowedUsers: ['ou_user'],
    },
    ...(agentKind === 'codex' ? { codex: { binaryPath: '/usr/local/bin/codex' } } : {}),
    preferences: {
      messageReply: replyMode,
      // Pre-0.1.27 `text` meant streaming markdown; set the migrated marker so
      // getMessageReplyMode returns true `text` for the text-mode scenario.
      ...(replyMode === 'text' ? { messageReplyMigrated: true } : {}),
    },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const runEvents: AgentEvent[] = [
    { type: 'text', delta: options.narration ?? NARRATION },
    ...(options.includeTools === false
      ? []
      : [
          { type: 'tool_use', id: '1', name: 'Bash', input: {} } as AgentEvent,
          { type: 'tool_result', id: '1', output: 'ok', isError: false } as AgentEvent,
        ]),
    { type: 'final_text', content: options.finalReply ?? FINAL_REPLY },
    { type: 'done', terminationReason: 'normal' },
  ];
  const agent = new FakeAgentAdapter({
    id: agentKind,
    displayName: agentKind === 'codex' ? 'Codex' : 'Claude Code',
    events: [options.agentEvents ?? runEvents],
  });
  const channel = createFakeLarkChannel(options);
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(streamBehavior: {
  streamFailure?: Error;
  streamUpdateFailure?: Error;
  streamUpdateFailureAfter?: number;
  streamUpdateFailureOnceAt?: number;
  streamNeverSettles?: boolean;
}): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  const streams: FakeLarkChannel['streams'] = [];
  let streamUpdateCount = 0;
  const maybeFailStreamUpdate = (): void => {
    streamUpdateCount++;
    if (streamBehavior.streamUpdateFailure) throw streamBehavior.streamUpdateFailure;
    if (streamUpdateCount === streamBehavior.streamUpdateFailureOnceAt) {
      throw new Error('transient progress update failed');
    }
    if (
      streamBehavior.streamUpdateFailureAfter !== undefined &&
      streamUpdateCount >= streamBehavior.streamUpdateFailureAfter
    ) {
      throw new Error('progress update failed');
    }
  };
  const channel: FakeLarkChannel = {
    handlers,
    sent,
    streams,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({
              data: { app: { owner: { owner_id: 'ou_owner' } } },
            })),
          },
        },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
          },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
      return { messageId: `om_sent_${sent.length}` };
    },
    async stream(chatId, input, options) {
      const record: FakeStreamRecord = {
        chatId,
        input,
        options,
        markdownContents: [],
        cardUpdates: [],
      };
      streams.push(record);
      const producer = (
        input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }
      ).markdown;
      if (producer) {
        await producer({
          setContent: async (markdown: string) => {
            maybeFailStreamUpdate();
            record.markdownContents.push(markdown);
          },
        });
      }
      const cardProducer = (
        input as {
          card?: {
            producer?: (ctrl: { update(card: unknown): Promise<void> }) => Promise<void>;
          };
        }
      ).card?.producer;
      if (cardProducer) {
        await cardProducer({
          update: async (card: unknown) => {
            maybeFailStreamUpdate();
            record.cardUpdates.push(card);
          },
        });
      }
      if (streamBehavior.streamNeverSettles) {
        return await new Promise<{ messageId: string }>(() => {});
      }
      if (streamBehavior.streamFailure) throw streamBehavior.streamFailure;
      return { messageId: `om_stream_${streams.length}` };
    },
    async addReaction(messageId, emojiType) {
      const r = await channel.rawClient.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return (r as { data?: { reaction_id?: string } })?.data?.reaction_id ?? '';
    },
    async removeReaction(messageId, reactionId) {
      await channel.rawClient.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    },
  };
  return channel;
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'codex',
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

function message(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function markdownOf(s: { content: unknown }): string | undefined {
  const c = s.content as { markdown?: string } | undefined;
  return typeof c?.markdown === 'string' ? c.markdown : undefined;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
