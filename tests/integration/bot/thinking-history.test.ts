import type { NormalizedMessage } from '@larksuite/channel';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import type { AgentEvent } from '../../../src/agent/types';
import { SessionStore } from '../../../src/session/store.js';
import { ThinkingHistoryStore } from '../../../src/session/thinking-history.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

/**
 * OPT-01B end-to-end: agent thinking events must survive the run into a
 * per-scope persisted record, with the terminal notice advertising the
 * `/thinking <runId>` entry only when the record was actually saved.
 */

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

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  rawClient: unknown;
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  createCard(cardJson: unknown): Promise<{ cardId: string }>;
  updateCardById(cardId: string, cardJson: unknown, sequence: number): Promise<void>;
  updateCard(messageId: string, card: unknown): Promise<void>;
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<{ messageId: string }>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const THINKING_CONTENT = `${'深度思考'.repeat(40)}\nFINAL_THOUGHT_MARKER`;

function thinkingEvents(): AgentEvent[] {
  return [
    { type: 'thinking', delta: THINKING_CONTENT } as AgentEvent,
    { type: 'text', delta: '最终回答' } as AgentEvent,
    { type: 'done', terminationReason: 'normal' } as AgentEvent,
  ];
}

interface Harness {
  channel: FakeLarkChannel;
  history: ThinkingHistoryStore;
  profileDir: string;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
}

async function createHarness(options: {
  historyDir?: string;
  events?: AgentEvent[];
} = {}): Promise<Harness> {
  const tmp = await createTmpProfile('thinking-e2e-');
  const workspace = await realpath(tmp.workspace);
  cleanups.push(() => tmp.cleanup());
  const history = new ThinkingHistoryStore(
    options.historyDir ?? join(tmp.profile, 'thinking'),
  );
  await history.load();
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'] },
    preferences: { messageReply: 'card' },
  });
  profileConfig.workspaces.default = workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: 'claude',
    displayName: 'Claude Code',
    events: [options.events ?? thinkingEvents()],
  });
  const channel = createFakeLarkChannel();
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush(), history.flush()]);
  });

  const bridge = await startChannel({
    cfg: profileConfig,
    agent,
    sessions,
    sessionCatalog: undefined,
    workspaces,
    thinkingHistory: history,
    controls,
  });
  cleanups.push(() => bridge.disconnect());

  return { channel, history, profileDir: tmp.profile, profileConfig };
}

async function runCommand(
  h: Harness,
  content: string,
): Promise<void> {
  await tryHandleCommand({
    channel: h.channel as unknown as CommandContext['channel'],
    msg: message(content),
    scope: 'oc_dm',
    chatMode: 'p2p',
    sessions: new SessionStore(join(h.profileDir, 'sessions.json')),
    workspaces: new WorkspaceStore(join(h.profileDir, 'workspaces.json')),
    agent: { displayName: 'Claude Code' } as never,
    activeRuns: new ActiveRuns(),
    controls: createControls(h.profileConfig),
    thinkingHistory: h.history,
  });
}

describe('thinking history end-to-end (OPT-01B)', () => {
  it('saves thinking on terminal, advertises /thinking in the notice, and pages reconstruct the record', async () => {
    const h = await createHarness();
    await h.channel.handlers.message?.(message('run something'));
    await waitFor(() => h.channel.sent.some((s) => (markdownOf(s) ?? '').includes('完成')));

    // Notice carries the runId-bound entry.
    const notice = h.channel.sent.map((s) => markdownOf(s) ?? '').find((md) => md.includes('完成'));
    expect(notice).toBeTruthy();
    const m = notice!.match(/\/thinking ([0-9a-f]{8}) 查看思考记录/);
    expect(m).not.toBeNull();

    // Record persisted under the run's scope with exact content.
    const metas = h.history.list('oc_dm');
    expect(metas).toHaveLength(1);
    expect(metas[0]!.hasThinking).toBe(true);
    const found = h.history.get('oc_dm', metas[0]!.runId);
    expect(found.kind).toBe('found');
    if (found.kind === 'found') expect(found.record.content).toBe(THINKING_CONTENT);

    // Query by the advertised short id; every page concatenated equals the
    // content the bridge actually received.
    const shortId = m![1]!;
    await runCommand(h, `/thinking ${shortId}`);
    const replies = h.channel.sent
      .map((s) => markdownOf(s) ?? '')
      .filter((md) => md.includes(`run ${shortId}`));
    expect(replies.length).toBeGreaterThanOrEqual(1);
    const first = replies[replies.length - 1]!;
    const total = Number.parseInt(first.match(/第 1\/(\d+) 页/)![1]!, 10);
    const pages = [pageBody(first)];
    for (let p = 2; p <= total; p++) {
      const before = h.channel.sent.length;
      await runCommand(h, `/thinking ${shortId} ${p}`);
      const newReplies = h.channel.sent
        .slice(before)
        .map((s) => markdownOf(s) ?? '')
        .filter(Boolean);
      expect(newReplies).toHaveLength(1);
      pages.push(pageBody(newReplies[0]!));
    }
    expect(pages.join('')).toBe(THINKING_CONTENT);
  });

  it('a run without thinking does not advertise /thinking', async () => {
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'plain answer' } as AgentEvent,
        { type: 'done', terminationReason: 'normal' } as AgentEvent,
      ],
    });
    await h.channel.handlers.message?.(message('no thinking please'));
    await waitFor(() => h.channel.sent.some((s) => (markdownOf(s) ?? '').includes('完成')));
    const notice = h.channel.sent.map((s) => markdownOf(s) ?? '').find((md) => md.includes('完成'));
    expect(notice).not.toContain('/thinking');
    // Meta record still exists so /thinking answers honestly about this run.
    expect(h.history.list('oc_dm')).toHaveLength(1);
  });

  it('a failed save does not block the final notice and does not advertise the entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'thinking-e2e-block-'));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    // The store's directory is occupied by a file → every save fails.
    const blocker = join(dir, 'not-a-dir');
    await writeFile(blocker, 'occupied', 'utf8');
    const h = await createHarness({ historyDir: blocker });
    await h.channel.handlers.message?.(message('save will fail'));
    await waitFor(() => h.channel.sent.some((s) => (markdownOf(s) ?? '').includes('完成')));
    const notice = h.channel.sent.map((s) => markdownOf(s) ?? '').find((md) => md.includes('完成'));
    expect(notice).toBeTruthy();
    expect(notice).not.toContain('/thinking');
  });
});

// ─── harness helpers (modeled on run-output-fragmentation.test.ts) ──────────

function createFakeLarkChannel(): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  const cardById = new Map<string, unknown>();
  let nextCard = 1;
  const channel: FakeLarkChannel = {
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    handlers,
    sent,
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
      cardkit: {
        v1: {
          card: {
            async settings() {
              return {};
            },
          },
        },
      },
      im: {
        v1: {
          message: { get: vi.fn(async () => ({ data: { items: [] } })) },
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
    async createCard(cardJson) {
      const cardId = `card_fake_${nextCard++}`;
      cardById.set(cardId, cardJson);
      return { cardId };
    },
    async updateCardById(cardId, cardJson) {
      cardById.set(cardId, cardJson);
    },
    async updateCard() {},
    async send(chatId, content, options) {
      const cardId = (content as { cardId?: unknown } | undefined)?.cardId;
      const resolved =
        typeof cardId === 'string' && cardById.has(cardId)
          ? { card: cardById.get(cardId) }
          : content;
      sent.push({ chatId, content: resolved, options });
      return { messageId: `om_sent_${sent.length}` };
    },
    async stream() {
      return { messageId: `om_stream_${sent.length}` };
    },
    async addReaction() {
      return 'reaction_1';
    },
    async removeReaction() {},
  };
  return channel;
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'claude',
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

function message(content: string): NormalizedMessage {
  return {
    messageId: `om_${content.replace(/\W+/g, '-').slice(0, 24)}`,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function markdownOf(s: { content: unknown }): string | undefined {
  const c = s.content as { markdown?: string } | undefined;
  return typeof c?.markdown === 'string' ? c.markdown : undefined;
}

function pageBody(reply: string): string {
  const start = reply.indexOf('\n\n');
  const footer = reply.lastIndexOf('\n\n📄');
  const end = footer === -1 ? reply.length : footer;
  return reply.slice(start + 2, end);
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
