import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import type { AgentEvent } from '../../../src/agent/types';
import { InboundJournal } from '../../../src/bot/inbound-journal.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

/**
 * OPT-04 end-to-end: accepted messages survive a restart (journal → replay),
 * runs that lost their terminal event are reported as uncertain instead of
 * being rerun, and a full message→run→terminal lifecycle settles the journal.
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

function doneEvents(text = 'recovery answer'): AgentEvent[] {
  return [
    { type: 'text', delta: text } as AgentEvent,
    { type: 'done', terminationReason: 'normal' } as AgentEvent,
  ];
}

interface HarnessDeps {
  journalDir: string;
  events?: AgentEvent[];
}

async function startBridge(deps: HarnessDeps): Promise<{
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  journal: InboundJournal;
  profileDir: string;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
}> {
  const tmp = await createTmpProfile('inbound-e2e-');
  const workspace = await realpath(tmp.workspace);
  cleanups.push(() => tmp.cleanup());
  const journal = new InboundJournal(deps.journalDir);
  await journal.load();
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'] },
    preferences: { messageReply: 'text' },
  });
  profileConfig.workspaces.default = workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({ id: 'claude', displayName: 'Claude Code', events: [deps.events ?? doneEvents()] });
  const channel = createFakeLarkChannel();
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush(), journal.flush()]);
  });

  const bridge = await startChannel({
    cfg: profileConfig,
    agent,
    sessions,
    workspaces,
    thinkingHistory: undefined,
    inboundJournal: journal,
    controls,
  });
  cleanups.push(() => bridge.disconnect());

  return { channel, agent, journal, profileDir: tmp.profile, profileConfig };
}

describe('inbound journal end-to-end (OPT-04)', () => {
  it('full lifecycle: accepted → claimed → terminal leaves nothing to recover', async () => {
    const dir = await mkdtempInbound();
    const h = await startBridge({ journalDir: dir });
    await h.channel.handlers.message?.(message('run this task'));
    await waitFor(() => h.agent.runs.length === 1);

    const records = h.journal.list('oc_dm');
    expect(records).toHaveLength(1);
    await waitFor(() => h.journal.list('oc_dm')[0]!.status === 'terminal');
    expect(h.journal.list('oc_dm')[0]!.terminalState).toBe('done');
    const recovery = await h.journal.recoverOnStartup();
    expect(recovery.requeue).toHaveLength(0);
    expect(recovery.uncertain).toHaveLength(0);
  });

  it('a message journaled before a crash is replayed through the normal flow on restart', async () => {
    const dir = await mkdtempInbound();
    // Simulate the crash window: message journaled (queued), process died
    // before the debounce flush. Seed the journal directly.
    const seeded = new InboundJournal(dir);
    await seeded.recordAccepted({
      messageId: 'om_crash',
      scope: 'oc_dm',
      chatId: 'oc_dm',
      senderId: 'ou_user',
      content: 'crash window task',
      acceptedAt: Date.now(),
      chatType: 'p2p',
    });
    await seeded.flush();

    const h = await startBridge({ journalDir: dir });
    // Recovery replays after a short delay, through pending → run flow.
    await waitFor(() => h.agent.runs.length === 1, 6000);
    const prompt = h.agent.runOptions[0]!.prompt;
    expect(prompt).toContain('crash window task');
    // And the replayed message claims + settles like a normal one.
    await waitFor(() => h.journal.list('oc_dm')[0]!.status === 'terminal');
  });

  it('claimed without terminal → uncertain: notified, never rerun', async () => {
    const dir = await mkdtempInbound();
    const seeded = new InboundJournal(dir);
    await seeded.recordAccepted({
      messageId: 'om_side_effect',
      scope: 'oc_dm',
      chatId: 'oc_dm',
      senderId: 'ou_user',
      content: 'possibly-deployed task',
      acceptedAt: Date.now(),
      chatType: 'p2p',
    });
    await seeded.markClaimed('oc_dm', ['om_side_effect'], 'run-lost');
    await seeded.flush();

    const h = await startBridge({ journalDir: dir });
    await waitFor(
      () => h.channel.sent.some((s) => JSON.stringify(s.content).includes('未自动重跑')),
      6000,
    );
    // The recovery notice is a structured card with continue/redo/dismiss actions.
    const card = h.channel.sent.find((s) => JSON.stringify(s.content).includes('未自动重跑'));
    expect(JSON.stringify(card)).toContain('inbound.continue');
    expect(JSON.stringify(card)).toContain('inbound.redo');
    expect(JSON.stringify(card)).toContain('inbound.dismiss');
    expect(JSON.stringify(card)).toContain('om_side_effect');
    // The uncertain task must not spawn a new run.
    await new Promise((r) => setTimeout(r, 200));
    expect(h.agent.runs).toHaveLength(0);
    const recovery = await h.journal.recoverOnStartup();
    expect(recovery.uncertain).toHaveLength(0); // already settled as uncertain at startup
  });

  it('duplicate delivery of the same message id does not double-journal', async () => {
    const dir = await mkdtempInbound();
    const h = await startBridge({ journalDir: dir });
    await h.channel.handlers.message?.(message('dupe task'));
    await h.channel.handlers.message?.(message('dupe task')); // same messageId
    await waitFor(() => h.agent.runs.length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(h.journal.list('oc_dm')).toHaveLength(1);
  });
});

// ─── harness helpers (modeled on thinking-history e2e) ──────────────────────

async function mkdtempInbound(): Promise<string> {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'inbound-journal-'));
  cleanups.push(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return dir;
}

function createFakeLarkChannel(): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
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
      cardkit: { v1: { card: { async settings() { return {}; } } } },
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
    async createCard() {
      return { cardId: 'card_fake' };
    },
    async updateCardById() {},
    async updateCard() {},
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
      return { messageId: `om_sent_${sent.length}` };
    },
    async stream() {
      return { messageId: 'om_stream' };
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
    createTime: Date.now(),
  } as unknown as NormalizedMessage;
}

// The fake channel records sent items; extract markdown payloads.
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

describe('inbound journal review fixes (阻断 1/2)', () => {
  it('a redelivered message whose run already finished does not execute again', async () => {
    const h = await startBridge({ journalDir: await mkdtempInbound() });
    await h.channel.handlers.message?.(message('once only'));
    await waitFor(() => h.agent.runs.length === 1);
    await waitFor(() => h.journal.list('oc_dm')[0]!.status === 'terminal');

    // Feishu redelivers the same event id (message() derives it from content).
    await h.channel.handlers.message?.(message('once only'));
    await new Promise((r) => setTimeout(r, 700)); // past the debounce window
    expect(h.agent.runs).toHaveLength(1);
  });

  it('two rapid redeliveries within the debounce window produce exactly one run', async () => {
    const h = await startBridge({ journalDir: await mkdtempInbound() });
    await h.channel.handlers.message?.(message('rapid dupe'));
    await h.channel.handlers.message?.(message('rapid dupe'));
    await waitFor(() => h.agent.runs.length >= 1);
    await new Promise((r) => setTimeout(r, 400));
    expect(h.agent.runs).toHaveLength(1);
  });

  it('an unpersistable claim aborts the run before spawn and informs the user', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'inbound-broken-'));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    const blocker = join(dir, 'occupied');
    await writeFile(blocker, 'occupied', 'utf8');

    const h = await startBridge({ journalDir: blocker });
    await h.channel.handlers.message?.(message('side effect task'));
    await waitFor(
      () => h.channel.sent.some((s) => JSON.stringify(s.content).includes('取消本次启动')),
      6000,
    );
    expect(h.agent.runs).toHaveLength(0);
  });
});
