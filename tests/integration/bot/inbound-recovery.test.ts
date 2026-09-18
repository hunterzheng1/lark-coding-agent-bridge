import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import type { AgentEvent } from '../../../src/agent/types';
import { InboundJournal } from '../../../src/bot/inbound-journal.js';
import { log } from '../../../src/core/logger.js';
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
  cardAction?: (evt: unknown) => Promise<void> | void;
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
  /** Set true when getChatMode is called; cleared by tests before gating. */
  chatModeRequested: boolean;
  /** When set, getChatMode parks on it — deterministic intake gating. */
  chatModeGate: Promise<void> | undefined;
  /** Incremented on every send entry (before parking); tests reset to observe. */
  sendRequested: number;
  /** When set, send parks on it before recording — recovery-notice gating. */
  sendGate: Promise<void> | undefined;
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
  journalDir?: string;
  /** Externally seeded journal — takes precedence over journalDir. */
  journal?: InboundJournal;
  events?: AgentEvent[];
  /** startChannel's shutdownDrainWarnMs (stuck-drain warn escalation only). */
  drainWarnMs?: number;
}

async function startBridge(deps: HarnessDeps): Promise<{
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  journal: InboundJournal;
  sessions: SessionStore;
  bridge: Awaited<ReturnType<typeof startChannel>>;
  profileDir: string;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
}> {
  const tmp = await createTmpProfile('inbound-e2e-');
  const workspace = await realpath(tmp.workspace);
  cleanups.push(() => tmp.cleanup());
  const journal = deps.journal ?? new InboundJournal(deps.journalDir!);
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
    shutdownDrainWarnMs: deps.drainWarnMs,
  });
  cleanups.push(() => bridge.disconnect());

  return { channel, agent, journal, sessions, bridge, profileDir: tmp.profile, profileConfig };
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
    await waitFor(() => h.agent.runs.length === 1, 8000);
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
    chatModeRequested: false,
    chatModeGate: undefined,
    sendRequested: 0,
    sendGate: undefined,
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
      channel.chatModeRequested = true;
      if (channel.chatModeGate) await channel.chatModeGate;
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
      channel.sendRequested += 1;
      if (channel.sendGate) await channel.sendGate;
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

/** Journal whose pre-spawn claim can be parked mid-flight, so tests can
 * observe state strictly between flush start and executor.submit. */
class GatedClaimJournal extends InboundJournal {
  claimReached = false;
  gate: Promise<void> | undefined;
  override async markClaimed(
    scope: string,
    messageIds: readonly string[],
    runId: string,
  ): Promise<boolean> {
    this.claimReached = true;
    if (this.gate) await this.gate;
    return super.markClaimed(scope, messageIds, runId);
  }
}

/** Journal whose redo can be parked mid-persistence, so tests can start
 * disconnect strictly while the redo write is still in flight (评审九轮). */
class GatedRedoJournal extends InboundJournal {
  redoReached = false;
  gate: Promise<void> | undefined;
  override async redo(
    scope: string,
    messageId: string,
    opts?: { contentOverride?: string; senderId?: string; resetSession?: boolean },
  ): Promise<string | undefined> {
    this.redoReached = true;
    if (this.gate) await this.gate;
    return super.redo(scope, messageId, opts);
  }
}

describe('重头重做 resetSession 意图（评审四轮）', () => {
  it('disconnect covers a batch parked in the pre-spawn claim (no tracking dead zone)', async () => {
    const dir = await mkdtempInbound();
    const journal = new GatedClaimJournal(dir);
    let release!: () => void;
    journal.gate = new Promise<void>((r) => (release = r));
    const h = await startBridge({ journal });

    await h.channel.handlers.message?.(message('parked claim task'));
    await waitFor(() => journal.claimReached, 8000);

    // Disconnect while the batch sits between flush start and spawn — the
    // window where only the inner processAgentStream promises used to be
    // tracked. Release shortly after so the drain loop keeps waiting on the
    // tracked batch lifecycle instead of seeing an empty settle set.
    const disconnecting = h.bridge.disconnect();
    await new Promise((r) => setTimeout(r, 300));
    release();
    await disconnecting;

    // disconnect returned ⇒ the whole batch already ran to completion:
    // the post-claim submit hit the disconnect pause, the rejection settled
    // the record. An untracked batch would have flushed the journal while
    // it still read 'queued'.
    const onDisk = new InboundJournal(dir);
    await onDisk.load();
    expect(onDisk.list('oc_dm')[0]?.status).toBe('terminal');
    expect(onDisk.list('oc_dm')[0]?.terminalState).toBe('rejected');
  });

  it('crash-replayed redo record resets the session before claim/spawn', async () => {
    const dir = await mkdtempInbound();
    // Process A: accepted + claimed, then died without a terminal event.
    const journal = new GatedClaimJournal(dir);
    await journal.recordAccepted({
      messageId: 'om_dead',
      scope: 'oc_dm',
      chatId: 'oc_dm',
      senderId: 'ou_user',
      content: 'interrupted redo task',
      acceptedAt: Date.now(),
      chatType: 'p2p',
    });
    await journal.markClaimed('oc_dm', ['om_dead'], 'run-lost');
    await journal.flush();

    // Process B's view: uncertain → the user clicks 重头重做 (redo carries
    // the resetSession intent) — then this process dies before the re-run.
    await journal.load();
    await journal.recoverOnStartup();
    const redoId = await journal.redo('oc_dm', 'om_dead', {
      resetSession: true,
      senderId: 'ou_user',
    });
    expect(redoId).toBeTruthy();
    await journal.flush();

    // Process C: startup recovery replays the flagged queued record. Park
    // the pre-spawn claim so we can inspect state right after the reset.
    let release!: () => void;
    journal.claimReached = false;
    journal.gate = new Promise<void>((r) => (release = r));
    const h = await startBridge({ journal });
    // A resumable old session exists — the reported bug was replay using it.
    h.sessions.set('oc_dm', 'sess-old', 'C:/old');

    await waitFor(() => journal.claimReached, 8000);
    // Claim is parked: the reset already ran before resume resolution/claim.
    expect(h.sessions.getRaw('oc_dm')?.sessionId).toBeUndefined();
    expect(journal.getRecord('oc_dm', redoId!)?.resetSession).toBe(false);
    release();

    await waitFor(() => h.agent.runs.length === 1, 8000);
    expect(h.agent.runOptions[0]!.prompt).toContain('interrupted redo task');
    await waitFor(() => journal.getRecord('oc_dm', redoId!)?.status === 'terminal', 8000);
  });
});

describe('优雅停机显式取消（评审五轮）', () => {
  it('disconnect waits a batch parked past the old 3s cap until it settles on disk', async () => {
    const dir = await mkdtempInbound();
    const journal = new GatedClaimJournal(dir);
    let release!: () => void;
    journal.gate = new Promise<void>((r) => (release = r));
    const h = await startBridge({ journal });

    await h.channel.handlers.message?.(message('parked past 3s'));
    await waitFor(() => journal.claimReached, 8000);

    // Park 4.2s — beyond the removed fixed 3s drain cap. The claim/terminal
    // path is local work and is never raced away, so disconnect must keep
    // waiting instead of flushing early and returning.
    const startedAt = Date.now();
    const disconnecting = h.bridge.disconnect();
    setTimeout(release, 4200);
    await disconnecting;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4000);

    // disconnect returned ⇒ the settled record is already on disk.
    const onDisk = new InboundJournal(dir);
    await onDisk.load();
    expect(onDisk.list('oc_dm')[0]?.status).toBe('terminal');
    expect(onDisk.list('oc_dm')[0]?.terminalState).toBe('rejected');
    expect(h.agent.runs).toHaveLength(0);
  }, 30_000);

  it('disconnect cancels a slow pre-spawn quote fetch but keeps tracking its side effects', async () => {
    const dir = await mkdtempInbound();
    const h = await startBridge({ journalDir: dir });
    // The quote fetch's REST call cannot be aborted (no AbortSignal in the
    // SDK). It only settles after 700ms — disconnect must wait for that
    // abandoned side effect instead of returning the moment the batch
    // breaks out (评审六轮 P2).
    let quoteRequested = false;
    (h.channel as unknown as { fetchRawMessage: () => Promise<unknown> }).fetchRawMessage = () => {
      quoteRequested = true;
      return new Promise((resolve) => setTimeout(() => resolve([]), 700));
    };
    await h.channel.handlers.message?.(
      {
        ...message('quoted hang task'),
        replyToMessageId: 'om_quoted_target',
      } as unknown as NormalizedMessage,
    );
    // Deterministically parked inside fetchQuotedContext when we disconnect.
    await waitFor(() => quoteRequested, 8000);

    const failSpy = vi.spyOn(log, 'fail');
    const infoSpy = vi.spyOn(log, 'info');
    const startedAt = Date.now();
    await h.bridge.disconnect();
    const elapsed = Date.now() - startedAt;
    // Waited for the abandoned fetch to settle...
    expect(elapsed).toBeGreaterThanOrEqual(500);
    // ...but the batch itself broke out at the abort (no 3s-cap wait).
    expect(elapsed).toBeLessThan(3000);
    expect(h.agent.runs).toHaveLength(0);
    // The never-dispatched record stays queued → next start replays it.
    const onDisk = new InboundJournal(dir);
    await onDisk.load();
    expect(onDisk.list('oc_dm')[0]?.status).toBe('queued');
    // Expected shutdown cancellation must not surface as an error/failure
    // (评审六轮 P2 observability) — it is an info-level cancellation.
    expect(
      failSpy.mock.calls.some((c) => String((c[1] as Error | undefined)?.message ?? c[1]).includes('bridge-shutdown')),
    ).toBe(false);
    expect(
      infoSpy.mock.calls.some((c) => c[0] === 'flush' && c[1] === 'cancelled-by-shutdown'),
    ).toBe(true);
  }, 15_000);

  it('stuck drain escalates to warnings but never flushes or returns early', async () => {
    const dir = await mkdtempInbound();
    const journal = new GatedClaimJournal(dir);
    let release!: () => void;
    journal.gate = new Promise<void>((r) => (release = r));
    // Warn threshold well below the parking time so the escalation branch
    // (the old silent flush-and-return path) is exercised.
    const h = await startBridge({ journal, drainWarnMs: 300 });

    await h.channel.handlers.message?.(message('stuck drain proof'));
    await waitFor(() => journal.claimReached, 8000);

    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const startedAt = Date.now();
    const disconnecting = h.bridge.disconnect();
    setTimeout(release, 1500);
    await disconnecting;

    expect(
      warnSpy.mock.calls.filter((c) => c[0] === 'disconnect' && c[1] === 'drain-stuck').length,
    ).toBeGreaterThanOrEqual(1);
    // The warn did NOT turn into an early return: disconnect waited out the
    // whole stuck period and the settled record is on disk.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1400);
    const onDisk = new InboundJournal(dir);
    await onDisk.load();
    expect(onDisk.list('oc_dm')[0]?.status).toBe('terminal');
    expect(onDisk.list('oc_dm')[0]?.terminalState).toBe('rejected');
  }, 20_000);
});

describe('停机关闭任务生产入口（评审七轮）', () => {
  it('disconnect inside the startup-recovery grace cancels replay and recovery cards', async () => {
    const dir = await mkdtempInbound();
    const seeded = new InboundJournal(dir);
    await seeded.recordAccepted({
      messageId: 'om_replay',
      scope: 'oc_dm',
      chatId: 'oc_dm',
      senderId: 'ou_user',
      content: 'replay bait',
      acceptedAt: Date.now(),
      chatType: 'p2p',
    });
    await seeded.recordAccepted({
      messageId: 'om_uncertain',
      scope: 'oc_dm',
      chatId: 'oc_dm',
      senderId: 'ou_user',
      content: 'uncertain bait',
      acceptedAt: Date.now(),
      chatType: 'p2p',
    });
    await seeded.markClaimed('oc_dm', ['om_uncertain'], 'run-lost');
    await seeded.flush();

    const h = await startBridge({ journalDir: dir });
    // The tracked recovery task sits in its 1.5s handshake grace — the exact
    // window where pendingSettles used to look empty while a replay +
    // notification were about to be produced.
    const startedAt = Date.now();
    await h.bridge.disconnect();
    // The grace woke early on abort instead of being waited out (or, worse,
    // returned while still untracked).
    expect(Date.now() - startedAt).toBeLessThan(1000);

    // Past the 1.5s grace + replay debounce: nothing may have been produced.
    await new Promise((r) => setTimeout(r, 2200));
    expect(h.agent.runs).toHaveLength(0);
    expect(
      h.channel.sent.some((s) => JSON.stringify(s.content).includes('未自动重跑')),
    ).toBe(false);
    const onDisk = new InboundJournal(dir);
    await onDisk.load();
    expect(onDisk.getRecord('oc_dm', 'om_replay')?.status).toBe('queued');
  }, 20_000);

  it('disconnect waits a gated intake and the resumed handler stops before journaling/dispatch', async () => {
    const dir = await mkdtempInbound();
    const h = await startBridge({ journalDir: dir });
    let releaseGate!: () => void;
    h.channel.chatModeGate = new Promise<void>((r) => (releaseGate = r));
    h.channel.chatModeRequested = false;
    const delivered = Promise.resolve(
      h.channel.handlers.message?.(message('gated intake task')),
    );
    await waitFor(() => h.channel.chatModeRequested, 8000);

    const startedAt = Date.now();
    const disconnecting = h.bridge.disconnect();
    setTimeout(releaseGate, 900);
    await disconnecting;
    await delivered;

    // Intake is lifecycle-tracked from entry: disconnect waited for it to
    // resume instead of draining an empty set and flushing early.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(800);
    // The resumed handler re-checked the shutdown gate: no journal record,
    // no armed dispatch.
    const onDisk = new InboundJournal(dir);
    await onDisk.load();
    expect(onDisk.list('oc_dm')).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 900)); // past any debounce window
    expect(h.agent.runs).toHaveLength(0);
  }, 20_000);
});

describe('回调与恢复通知纳入排空跟踪（评审八轮）', () => {
  it('disconnect waits an in-flight recovery notice instead of letting it fly untracked', async () => {
    const dir = await mkdtempInbound();
    const seeded = new InboundJournal(dir);
    await seeded.recordAccepted({
      messageId: 'om_uncertain',
      scope: 'oc_dm',
      chatId: 'oc_dm',
      senderId: 'ou_user',
      content: 'uncertain bait',
      acceptedAt: Date.now(),
      chatType: 'p2p',
    });
    await seeded.markClaimed('oc_dm', ['om_uncertain'], 'run-lost');
    await seeded.flush();

    const h = await startBridge({ journalDir: dir });
    let releaseSend!: () => void;
    h.channel.sendGate = new Promise<void>((r) => (releaseSend = r));
    h.channel.sendRequested = 0;
    // The tracked recovery task reaches the notice send (after the 1.5s
    // grace) and parks there. Before 评审八轮 the task did `void send` and
    // left pendingSettles while the card was still in flight.
    await waitFor(() => h.channel.sendRequested > 0, 8000);

    const startedAt = Date.now();
    const disconnecting = h.bridge.disconnect();
    setTimeout(releaseSend, 900);
    await disconnecting;
    // The drain waited for the notice to complete...
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(800);
    // ...and by the time disconnect returned the card had fully gone out.
    expect(
      h.channel.sent.some((s) => JSON.stringify(s.content).includes('未自动重跑')),
    ).toBe(true);
  }, 20_000);

  it('disconnect waits a gated cardAction and the resumed click stops before journaling/dispatch', async () => {
    const dir = await mkdtempInbound();
    const seeded = new InboundJournal(dir);
    await seeded.recordAccepted({
      messageId: 'om_uncertain',
      scope: 'oc_dm',
      chatId: 'oc_dm',
      senderId: 'ou_user',
      content: 'continuation bait',
      acceptedAt: Date.now(),
      chatType: 'p2p',
    });
    await seeded.markClaimed('oc_dm', ['om_uncertain'], 'run-lost');
    await seeded.flush();

    const h = await startBridge({ journalDir: dir });
    // Let startup recovery finish — the only producer left must be the click.
    await waitFor(
      () => h.channel.sent.some((s) => JSON.stringify(s.content).includes('未自动重跑')),
      8000,
    );
    // The fake channel answers chat mode 'group' — allow the chat so the
    // click reaches the shutdown/dispatch boundary, not the access gate.
    h.profileConfig.access.allowedChats.push('oc_dm');
    let releaseGate!: () => void;
    h.channel.chatModeGate = new Promise<void>((r) => (releaseGate = r));
    h.channel.chatModeRequested = false;

    const delivered = Promise.resolve(
      h.channel.handlers.cardAction?.({
        chatId: 'oc_dm',
        messageId: 'om_card',
        operator: { openId: 'ou_user', name: 'User' },
        action: { value: { cmd: 'inbound.continue', arg: 'om_uncertain' } },
      }),
    );
    // Deterministically parked inside resolveScope's chat-mode lookup.
    await waitFor(() => h.channel.chatModeRequested, 8000);

    const startedAt = Date.now();
    const disconnecting = h.bridge.disconnect();
    setTimeout(releaseGate, 900);
    await disconnecting;
    await delivered;

    // cardAction is lifecycle-tracked from entry: the drain waited for the
    // in-flight callback instead of seeing an empty set and flushing early.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(800);
    // The resumed click hit the shutdown gate: no redo journalled, no new
    // record, no armed dispatch, no success wording.
    expect(h.journal.list('oc_dm')).toHaveLength(1);
    expect(h.journal.getRecord('oc_dm', 'om_uncertain')?.status).toBe('uncertain');
    await new Promise((r) => setTimeout(r, 900)); // past any debounce window
    expect(h.agent.runs).toHaveLength(0);
    expect(
      h.channel.sent.some((s) => markdownOf(s)?.includes('已在原会话提交继续请求')),
    ).toBe(false);
  }, 20_000);
});

describe('停机期间恢复动作不再重建派发定时器（评审九轮）', () => {
  it('a disconnect during journal.redo leaves the redo record queued and never dispatches', async () => {
    const dir = await mkdtempInbound();
    const journal = new GatedRedoJournal(dir);
    await journal.recordAccepted({
      messageId: 'om_uncertain',
      scope: 'oc_dm',
      chatId: 'oc_dm',
      senderId: 'ou_user',
      content: 'redo race bait',
      acceptedAt: Date.now(),
      chatType: 'p2p',
    });
    await journal.markClaimed('oc_dm', ['om_uncertain'], 'run-lost');

    const h = await startBridge({ journal });
    await waitFor(
      () => h.channel.sent.some((s) => JSON.stringify(s.content).includes('未自动重跑')),
      8000,
    );
    h.profileConfig.access.allowedChats.push('oc_dm');
    let release!: () => void;
    journal.gate = new Promise<void>((r) => (release = r));

    const delivered = Promise.resolve(
      h.channel.handlers.cardAction?.({
        chatId: 'oc_dm',
        messageId: 'om_card',
        operator: { openId: 'ou_user', name: 'User' },
        action: { value: { cmd: 'inbound.continue', arg: 'om_uncertain' } },
      }),
    );
    // Deterministically parked INSIDE the journal.redo persistence — the
    // pre-redo gate has already passed at this point.
    await waitFor(() => journal.redoReached, 8000);

    const startedAt = Date.now();
    const disconnecting = h.bridge.disconnect();
    setTimeout(release, 900);
    await disconnecting;
    await delivered;
    // The tracked callback drained before disconnect returned.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(800);

    // The post-redo gate fired: the fresh redo record is persisted QUEUED
    // (never dispatched → next startup replays it) and pending.push was
    // skipped, so no debounce timer survives on the old instance.
    const onDisk = new InboundJournal(dir);
    await onDisk.load();
    expect(onDisk.list('oc_dm').some((rec) => rec.status === 'queued')).toBe(true);
    expect(onDisk.getRecord('oc_dm', 'om_uncertain')?.status).toBe('terminal');
    await new Promise((r) => setTimeout(r, 1200)); // well past the debounce window
    expect(h.agent.runs).toHaveLength(0);
    expect(
      h.channel.sent.some((s) => markdownOf(s)?.includes('已在原会话提交继续请求')),
    ).toBe(false);
  }, 20_000);
});

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

describe('OPT-07 Slice C：模型快照与合批', () => {
  it('splits one flush into sequential runs by per-message snapshot (busy switch)', async () => {
    const dir = await mkdtempInbound();
    const h = await startBridge({ journalDir: dir });
    await h.sessions.setModelPreference('oc_dm', 'claude', 'modelA');
    await h.channel.handlers.message?.(message('alpha task'));
    // Slice C: switching while the first message is still queued is allowed,
    // but must NOT rewrite alpha's frozen snapshot — only beta adopts modelB.
    await h.sessions.setModelPreference('oc_dm', 'claude', 'modelB');
    await h.channel.handlers.message?.(message('beta task'));

    await waitFor(() => h.agent.runs.length === 2, 8000);
    expect(h.agent.runOptions[0]?.model).toBe('modelA');
    expect(h.agent.runOptions[1]?.model).toBe('modelB');
    expect(h.agent.runOptions[0]?.prompt).toContain('alpha task');
    expect(h.agent.runOptions[1]?.prompt).toContain('beta task');
  }, 20_000);

  it('replays a crash-queued record with its ORIGINAL snapshot, not current pref', async () => {
    const dir = await mkdtempInbound();
    const seeded = new InboundJournal(dir);
    await seeded.recordAccepted({
      messageId: 'om_snap',
      scope: 'oc_dm',
      chatId: 'oc_dm',
      senderId: 'ou_user',
      content: 'snapshotted task',
      acceptedAt: Date.now(),
      chatType: 'p2p',
      model: 'frozen-model',
    });
    await seeded.flush();

    const h = await startBridge({ journalDir: dir });
    // Current preference deliberately differs from the frozen snapshot.
    await h.sessions.setModelPreference('oc_dm', 'claude', 'current-model');
    await waitFor(() => h.agent.runs.length === 1, 8000);
    expect(h.agent.runOptions[0]?.model).toBe('frozen-model');
    expect(h.agent.runOptions[0]?.prompt).toContain('snapshotted task');
  }, 20_000);

  it('a record with no snapshot field (pre-C log) runs with no override', async () => {
    const dir = await mkdtempInbound();
    const seeded = new InboundJournal(dir);
    await seeded.recordAccepted({
      messageId: 'om_legacy',
      scope: 'oc_dm',
      chatId: 'oc_dm',
      senderId: 'ou_user',
      content: 'legacy no-snapshot task',
      acceptedAt: Date.now(),
      chatType: 'p2p',
    });
    await seeded.flush();

    const h = await startBridge({ journalDir: dir });
    // Even with a current preference, the legacy record's missing snapshot means
    // dispatch must NOT pass a model override (old-behaviour compatibility).
    await h.sessions.setModelPreference('oc_dm', 'claude', 'should-be-ignored');
    await waitFor(() => h.agent.runs.length === 1, 8000);
    expect(h.agent.runOptions[0]?.model).toBeUndefined();
  }, 20_000);
});
