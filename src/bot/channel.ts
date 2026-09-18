import type {
  LarkChannel,
  LarkChannelOptions,
  NormalizedMessage,
} from '@larksuite/channel';
import { createLarkChannel } from '@larksuite/channel';
import { dirname, join } from 'node:path';
import { capabilityForAgentKind } from '../agent/capability';
import {
  buildAgentPrompt,
  type BridgePromptInteractiveCard,
  type BridgePromptMention,
  type BridgePromptQuotedMessage,
  type BridgePromptTopicMessage,
} from '../agent/prompt';
import type { AgentAdapter, AgentEvent } from '../agent/types';
import { handleCardAction } from '../card/dispatcher';
import { CallbackAuth } from '../card/callback-auth';
import { CallbackNonceStore } from '../card/callback-store';
import { renderCardBounded, type RunCardProgress } from '../card/run-renderer';
import { recoveryCard } from '../card/templates';
import { ResilientCardUpdater } from '../card/resilient-updater';
import { SnapshotScheduler } from '../card/snapshot-scheduler';
import {
  buildTerminalNotice,
  finalizeIfRunning,
  formatModelNoticeSegment,
  finalReplyText,
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
  windowState,
  type RunState,
  type WindowOptions,
} from '../card/run-state';
import {
  startStreamingCardSession,
  type StreamingCardSession,
} from '../card/streaming-session';
import { renderText } from '../card/text-renderer';
import { commandKeepsPendingQueue, tryHandleCommand, type Controls } from '../commands';
import type { AppConfig } from '../config/schema';
import {
  getAgentStopGraceMs,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getShowToolCalls,
} from '../config/schema';
import { resolveAppSecret } from '../config/secret-resolver';
import { log, reportMetric, withTrace } from '../core/logger';
import { MediaCache, type LocalAttachment } from '../media/cache';
import {
  toPolicyAttachment,
  toPromptAttachment,
} from '../media/attachment';
import { canUseDm, canUseGroup } from '../policy/access';
import type { ScopeContext } from '../policy/run-policy';
import { createOwnerRefreshController } from '../policy/owner';
import { RunExecutor } from '../runtime/run-executor';
import type { SessionCatalog } from '../session/catalog';
import type { ThinkingHistoryStore } from '../session/thinking-history';
import { appendThinkingHint } from '../session/thinking-history';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { ActiveRuns, type RunHandle } from './active-runs';
import { ChatModeCache, type ChatMode } from './chat-mode-cache';
import { handleCommentMention } from './comments';
import { InboundJournal, type InboundRecord } from './inbound-journal';
import { recordRunSessionEvent, startRunFlow } from './run-flow';
import { commandSessionCatalogIdentity } from './session-catalog-identity';
import { startKeepalive } from './keepalive';
import { PendingQueue } from './pending-queue';
import { ProcessPool } from './process-pool';
import { fetchQuotedContext, fetchTopicContext, type QuotedContext } from './quote';
import { lookupMessageThreadId } from './thread-id';
import { addWorkingReaction, removeReaction } from './reaction';
import { fetchKnownChats } from './lark-info';
import type { AppPaths } from '../config/app-paths';

const DEBOUNCE_MS = 600;
const STREAM_TERMINAL_GRACE_MS = 3000;
const REACTION_CLEANUP_GRACE_MS = 1000;

/**
 * OPT-07 Slice C: the model snapshot frozen at intake, keyed by the exact
 * queued message object. The inbound journal is the durable snapshot source;
 * this sidecar exists so the flush-time grouping keeps freeze-at-acceptance
 * semantics even when a caller runs without a journal (production always
 * creates one). Entries vanish with their messages (WeakMap).
 */
const intakeModelSnapshots = new WeakMap<NormalizedMessage, string | undefined>();

const BRIDGE_AGENT_INSTRUCTIONS = [
  '你在 bridge 进程中运行，普通 lark-cli 会继承 LARK_CHANNEL=1 并进入 bridge-bound 模式。',
  '不要 unset LARK_CHANNEL / LARK_CHANNEL_HOME / LARK_CHANNEL_PROFILE / LARKSUITE_CLI_CONFIG_DIR，也不要用 env -u LARK_CHANNEL 绕回本机普通配置。',
  'Codex bridge 默认使用 danger-full-access 对齐 Claude bridge 的 bypassPermissions 行为，因此 lark-cli 应能像用户本机终端一样访问 keychain。',
  '如果提示 lark-channel context detected but not bound，停止当前操作并请用户重启 bridge 或运行 bridge doctor/preflight；不要改用普通 profile，不要自行 bind，也不要直接读取 config.json 里的账号或密钥。',
];

// Lark SDK logs API errors at error level even when the caller catches them.
// These specific codes are EXPECTED in our flow (wiki-node lookup that
// usually misses, fileComment.get that we deliberately let fall back to
// .list) and the surrounding noise is already covered by our own logs.
const SUPPRESSED_API_ERROR_CODES = new Set([
  131005, // wiki.space.getNode "not found" — the doc isn't a wiki node
  1069307, // drive.fileComment.get "not exist" — fall back to .list
  1069302, // drive.fileCommentReply.create — whole-doc comments don't accept replies; fall back to fileComment.create
]);

const SUPPRESSED_ENDPOINT_API_ERRORS = [
  {
    code: 99991672,
    urlPart: '/open-apis/wiki/v2/spaces/get_node',
  },
];

function codeFromObj(m: unknown): number | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const top = (m as { code?: unknown }).code;
  if (typeof top === 'number') return top;
  const nested = (m as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  return typeof nested === 'number' ? nested : undefined;
}

function urlFromObj(m: unknown): string | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const configUrl = (m as { config?: { url?: unknown } })?.config?.url;
  if (typeof configUrl === 'string') return configUrl;
  const requestPath = (m as { request?: { path?: unknown } })?.request?.path;
  return typeof requestPath === 'string' ? requestPath : undefined;
}

function isSuppressedSdkMessage(msg: unknown): boolean {
  if (Array.isArray(msg)) return msg.some(isSuppressedSdkMessage);
  const code = codeFromObj(msg);
  if (code === undefined) return false;
  if (SUPPRESSED_API_ERROR_CODES.has(code)) return true;
  const url = urlFromObj(msg);
  return SUPPRESSED_ENDPOINT_API_ERRORS.some(
    (rule) => code === rule.code && url?.includes(rule.urlPart),
  );
}

export function shouldSuppressSdkErrorLog(args: unknown[]): boolean {
  return args.some(isSuppressedSdkMessage);
}

function buildQuietLogger(): {
  error: (...m: unknown[]) => void;
  warn: (...m: unknown[]) => void;
  info: (...m: unknown[]) => void;
  debug: (...m: unknown[]) => void;
  trace: (...m: unknown[]) => void;
} {
  return {
    error: (...args: unknown[]) => {
      if (shouldSuppressSdkErrorLog(args)) return;
      log.warn('sdk', 'error', { args: stringifyArgs(args) });
    },
    warn: (...args: unknown[]) => log.warn('sdk', 'warn', { args: stringifyArgs(args) }),
    info: (...args: unknown[]) => log.info('sdk', 'info', { args: stringifyArgs(args) }),
    debug: () => {},
    trace: () => {},
  };
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

export interface BridgeChannel {
  channel: LarkChannel;
  disconnect(): Promise<void>;
}

export interface StartChannelDeps {
  cfg: AppConfig;
  agent: AgentAdapter;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  thinkingHistory?: ThinkingHistoryStore;
  inboundJournal?: InboundJournal;
  controls: Controls;
  appPaths?: Pick<AppPaths, 'secretsFile' | 'keystoreSaltFile' | 'mediaDir'>;
  /**
   * How long a stuck shutdown drain may go before escalating to repeating
   * `disconnect/drain-stuck` warnings. Observability only — disconnect never
   * flushes or returns before every tracked batch has settled regardless of
   * this value. Default: agent stop grace + 10s.
   */
  shutdownDrainWarnMs?: number;
}

export async function startChannel(deps: StartChannelDeps): Promise<BridgeChannel> {
  const { cfg, agent, sessions, sessionCatalog, workspaces, thinkingHistory, inboundJournal, controls } = deps;
  const activeRuns = new ActiveRuns();
  // ChatModeCache stays per-bridge-instance — invalidated on restart along
  // with everything else. Topic-mode chats only need one chat.get() call ever.
  const chatModeCache = new ChatModeCache();
  // Concurrency cap — reads `preferences.maxConcurrentRuns` on each acquire,
  // so /config bumps take effect for the next run.
  const pool = new ProcessPool(() => getMaxConcurrentRuns(controls.cfg));
  const executor = new RunExecutor({ agent, pool, activeRuns });

  // Resolve the App Secret to plaintext. The config field can be a literal
  // string, a "${VAR}" template, or a {source, id} SecretRef referencing
  // the encrypted keystore / env / file / exec provider. Re-resolved on
  // every startChannel so /account change picks up new secrets.
  const appSecret = await resolveAppSecret(cfg, deps.appPaths);
  const callbackNonceStore = deps.appPaths?.mediaDir
    ? new CallbackNonceStore(join(dirname(deps.appPaths.mediaDir), 'callback-nonces.json'))
    : undefined;
  await callbackNonceStore?.load();
  const callbackAuth = callbackNonceStore
    ? new CallbackAuth({
        keys: [{ version: 1, secret: appSecret }],
        nonceStore: callbackNonceStore,
      })
    : undefined;
  const activePolicyFingerprints = new Map<string, string>();

  const opts: LarkChannelOptions = {
    appId: cfg.accounts.app.id,
    appSecret,
    domain:
      cfg.accounts.app.tenant === 'lark'
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn',
    source: 'lark-channel-bridge',
    logger: buildQuietLogger(),
    policy: {
      dmMode: 'open',
      requireMention: false,
      respondToMentionAll: false,
    },
    // Disable per-chat serialization so we can implement our own
    // debounce + run-chain policy (see pending-queue + runChain below).
    safety: {
      chatQueue: { enabled: false },
    },
    // Attach raw Feishu event body to normalized events so we can read fields
    // the normalizer drops (e.g. action.form_value on CardKit 2.0 form submits).
    includeRawEvent: true,
    outbound: {
      streamThrottleMs: 400,
    },
    // SDK 1.65.0-alpha.3+ knobs.
    wsConfig: {
      // 10s liveness watchdog: allow short event-loop/network jitter without
      // turning a healthy connection into an unnecessary reconnect.
      pingTimeout: 10,
    },
    // 8s handshake timeout (replaces hardcoded 15s). Fast-fail + fast-retry
    // beats slow-fail in unstable networks.
    handshakeTimeoutMs: 8_000,
    // Per-request REST timeout — without a cap a slow API can hang the
    // event-handling thread.
    httpTimeoutMs: 30_000,
    // Route WS + REST through HTTPS_PROXY / HTTP_PROXY when set (no-op otherwise).
    respectProxyEnv: true,
  };

  const channel = createLarkChannel(opts);
  const media = new MediaCache(channel, deps.appPaths?.mediaDir);

  // Pending → run handoff: while a run is active on a chat, block its pending
  // queue so messages keep accumulating without flushing. When the run ends,
  // unblock arms a fresh quiet-window timer. Net effect: at most one run per
  // chat in flight, and everything sent during a run merges into the next
  // batch (only flushed once 600ms of silence has passed *after* the run).
  // OPT-04: lifecycle tracking for graceful shutdown — initialized BEFORE
  // the pending queue because a message arriving immediately after startup
  // can flush (and reach terminal callbacks) before connection completes.
  // The tracker never swallows rejections: the original promise is returned.
  const pendingSettles = new Set<Promise<unknown>>();
  const trackSettle = (p: Promise<unknown>): Promise<unknown> => {
    const shadow = p.then(
      () => undefined,
      () => undefined,
    );
    const entry = shadow.finally(() => {
      pendingSettles.delete(entry);
    });
    pendingSettles.add(entry);
    return p;
  };

  // OPT-04 (评审五轮): graceful shutdown explicitly CANCELS pre-spawn
  // network awaits (chat-mode resolve, media download, quote/topic fetch)
  // instead of relying on a fixed drain timeout. A batch aborted here never
  // spawned an agent, so its journal record stays `queued` and the next
  // startup replays it — exactly the "never dispatched" semantics. Local
  // writes (claim / terminal) are never raced away; disconnect always waits
  // for those to settle.
  const shutdown = new AbortController();

  const pending = new PendingQueue(DEBOUNCE_MS, (scope, batch) => {
    const firstMsg = batch[0];
    if (!firstMsg) return;
    pending.block(scope);
    // The WHOLE batch lifecycle is tracked from creation — mode resolve,
    // media/quote prep, policy, spawn, stream, terminal hooks. Tracking only
    // the inner processAgentStream promises leaves a dead window (disconnect
    // during mode resolve / policy / spawn sees an empty settle set and
    // flushes too early).
    void trackSettle(
      withTrace({ chatId: firstMsg.chatId }, async () => {
        log.info('flush', 'start', { scope, batchSize: batch.length });
        try {
          const resolvedMode = await raceShutdown(
            shutdown.signal,
            'chat-mode',
            chatModeCache.resolve(channel, firstMsg.chatId),
            trackSettle,
          );
          const mode: ChatMode = firstMsg.threadId ? 'topic' : resolvedMode;
          // OPT-07 Slice C: split the batch by each message's frozen model
          // snapshot so different target models never merge into one prompt
          // (rule 6). Groups run SEQUENTIALLY (ActiveRuns allows one in-flight
          // run per scope); a later /model change only affects messages
          // accepted after it, and already-received/queued messages keep their
          // snapshot. A shutdown between groups leaves the not-yet-run records
          // `queued`, so the next startup replays them (rule 7).
          // The journal record is the durable snapshot source; intake also
          // freezes the same value per message object (WeakMap sidecar) so
          // snapshot semantics hold even when a caller runs without a journal.
          const snapshotOf = (m: NormalizedMessage): string | undefined =>
            inboundJournal
              ? inboundJournal.getRecord(scope, m.messageId)?.model
              : intakeModelSnapshots.get(m);
          const groups = groupBatchByModelSnapshot(batch, snapshotOf);
          const batchDeps = {
            channel,
            executor,
            sessions,
            sessionCatalog,
            workspaces,
            thinkingHistory,
            inboundJournal,
            media,
            controls,
            callbackAuth,
            activePolicyFingerprints,
            scope,
            mode,
            trackSettle,
            shutdownSignal: shutdown.signal,
          };
          for (const group of groups) {
            if (shutdown.signal.aborted) throw new BridgeShutdownCancelled('between-groups');
            await runAgentBatch({ ...batchDeps, batch: group.messages, model: group.model });
          }
        } catch (err) {
          if (err instanceof BridgeShutdownCancelled) {
            // Expected graceful-shutdown cancellation, not a failure —
            // keep it out of error telemetry (评审六轮).
            log.info('flush', 'cancelled-by-shutdown', { scope, label: err.label });
          } else {
            log.fail('flush', err);
          }
        } finally {
          pending.unblock(scope);
          log.info('flush', 'end');
        }
      }),
    );
  });

  // OPT-04 startup recovery: journal leftovers from a previous process.
  // Queued (never-dispatched) messages are replayed through the normal
  // pending flow — fresh policy checks at dispatch. Claimed records whose run
  // has no known terminal state are `uncertain`: notified, never auto-rerun.
  if (inboundJournal) {
    // 评审七轮: the recovery task is a producer (pending.push + recovery
    // cards) — it must be lifecycle-tracked from entry and must stop at the
    // shutdown gate, or disconnect can drain (set still empty during the
    // 1.5s grace) and return while the old instance is about to replay.
    void trackSettle((async () => {
      try {
        const recovery = await inboundJournal.recoverOnStartup();
        // Give the WS handshake a moment before replaying or notifying —
        // woke early by shutdown so disconnect never waits out the grace.
        await sleepUntilAbort(shutdown.signal, 1_500);
        if (shutdown.signal.aborted) {
          log.info('inbound', 'startup-recovery-cancelled', {
            requeue: recovery.requeue.length,
            uncertain: recovery.uncertain.length,
            expired: recovery.expired.length,
          });
          return;
        }
        for (const record of recovery.requeue) {
          log.info('inbound', 'recovery-requeue', {
            scope: record.scope,
            messageId: record.messageId,
          });
          pending.push(record.scope, recoveryMessage(record));
        }
        for (const record of recovery.uncertain) {
          // 评审八轮: the notice is part of the recovery task — await it (the
          // task itself is lifecycle-tracked) so disconnect can never return
          // while the old instance is still mid-send. `void send` let the
          // outer task leave pendingSettles before the card went out.
          if (shutdown.signal.aborted) {
            log.info('inbound', 'startup-recovery-cancelled', { stage: 'notice' });
            return;
          }
          log.warn('inbound', 'recovery-uncertain', {
            scope: record.scope,
            messageId: record.messageId,
            runId: record.runId,
          });
          await channel
            .send(
              record.chatId,
              {
                card: recoveryCard({
                  status: 'uncertain',
                  messageId: record.messageId,
                  content: record.content,
                }),
              },
              record.threadId ? { replyInThread: true as const } : undefined,
            )
            .catch((err) => log.fail('inbound', err, { step: 'recovery-notice' }));
        }
        for (const record of recovery.expired) {
          if (shutdown.signal.aborted) {
            log.info('inbound', 'startup-recovery-cancelled', { stage: 'notice' });
            return;
          }
          await channel
            .send(
              record.chatId,
              {
                card: recoveryCard({
                  status: 'expired',
                  messageId: record.messageId,
                  content: record.content,
                }),
              },
              record.threadId ? { replyInThread: true as const } : undefined,
            )
            .catch((err) => log.fail('inbound', err, { step: 'recovery-notice' }));
        }
      } catch (err) {
        log.fail('inbound', err, { step: 'startup-recovery' });
      }
    })());
  }

  // Counter for stdout reconnect escalation; reset on `reconnected`.
  let consecutiveReconnects = 0;

  channel.on({
    message: async (msg) => {
      // 评审七轮: intake is a task PRODUCER. It must be lifecycle-tracked
      // from entry (its chat-mode/thread/command awaits happen long before
      // any batch exists to track) and refused once shutdown started —
      // otherwise disconnect can observe an empty settle set, flush, and
      // return while this handler is still heading for its journal write
      // and pending.push.
      if (shutdown.signal.aborted) {
        log.info('intake', 'rejected-by-shutdown', {
          chatId: msg.chatId,
          msgId: msg.messageId,
        });
        return;
      }
      await trackSettle(
        withTrace({ chatId: msg.chatId, msgId: msg.messageId }, () =>
          intakeMessage({
            channel,
            agent,
            sessions,
            sessionCatalog,
            workspaces,
            thinkingHistory,
            inboundJournal,
            activeRuns,
            pending,
            msg,
            controls,
            chatModeCache,
            executor,
            pool,
            shutdownSignal: shutdown.signal,
          }),
        ).catch((err) => log.fail('intake', err)),
      );
    },
    reject: (evt) => {
      log.info('intake', 'reject', { chatId: evt.chatId, reason: evt.reason });
    },
    cardAction: async (evt) => {
      // Producer entry: card callbacks can journal/claim/dispatch — refuse
      // them wholesale once shutdown started (评审七轮), and lifecycle-track
      // the ones already in flight from entry so disconnect drains them
      // instead of returning mid-callback (评审八轮 P1).
      if (shutdown.signal.aborted) {
        log.info('cardAction', 'rejected-by-shutdown', { messageId: evt.messageId });
        return;
      }
      await trackSettle(
        withTrace({ chatId: evt.chatId, msgId: evt.messageId }, () =>
          handleCardAction({
            channel,
            evt,
            sessions,
            sessionCatalog,
            workspaces,
            thinkingHistory,
            inboundJournal,
            activeRuns,
            agent,
            processPool: pool,
            runExecutor: executor,
            controls,
            pending,
            chatModeCache,
            callbackAuth,
            callbackPolicyFingerprintForScope: (scope) => activePolicyFingerprints.get(scope),
            shutdownSignal: shutdown.signal,
          }),
        ).catch((err) => log.fail('cardAction', err)),
      );
    },
    comment: async (evt) => {
      // Same producer-entry discipline as cardAction (评审八轮 P1).
      if (shutdown.signal.aborted) {
        log.info('comment', 'rejected-by-shutdown', { commentId: evt.commentId });
        return;
      }
      await trackSettle(
        withTrace({ chatId: 'comment' }, () =>
          handleCommentMention({
            channel,
            evt,
            agent,
            sessions,
            sessionCatalog,
            workspaces,
            activeRuns,
            executor,
            controls,
            shutdownSignal: shutdown.signal,
          }),
        ).catch((err) => log.fail('comment', err)),
      );
    },
    reconnecting: () => {
      consecutiveReconnects++;
      log.warn('ws', 'reconnecting', { consecutive: consecutiveReconnects });
      reportMetric('ws_reconnect', 1, { kind: 'ws' });
      // Stdout escalation — surface jitter that's hidden in the file log.
      if (consecutiveReconnects === 3) {
        console.error('⚠️ 已连续重连 3 次,网络可能不稳。');
      } else if (consecutiveReconnects === 10) {
        console.error('❌ 已连续重连 10 次,建议在飞书发 /reconnect 或重启 bot。');
      }
    },
    reconnected: () => {
      if (consecutiveReconnects > 1) {
        log.info('ws', 'recovered', { afterAttempts: consecutiveReconnects });
      } else {
        log.info('ws', 'reconnected');
      }
      consecutiveReconnects = 0;
    },
    // Classify common WS errors into the `network` phase so /doctor and grep
    // can find them without scanning generic `ws.fail` entries.
    error: (err) => {
      const msg = err?.message ?? String(err);
      if (/ENOTFOUND|getaddrinfo/.test(msg)) {
        log.fail('network', err, { kind: 'dns', code: err.code });
      } else if (/handshake|did not complete/.test(msg)) {
        log.fail('network', err, { kind: 'handshake-timeout', code: err.code });
      } else if (/timeout/i.test(msg)) {
        log.fail('network', err, { kind: 'timeout', code: err.code });
      } else {
        log.fail('ws', err, { code: err.code });
      }
    },
  });

  await channel.connect();
  const ownerRefresh = createOwnerRefreshController({
    controls,
    source: channel,
    appId: cfg.accounts.app.id,
  });
  await ownerRefresh.start();
  const knownChatsRefresh = startKnownChatsRefreshTimer(channel, controls);

  const identity = channel.botIdentity;
  // Late-bind the bot's own IM identity into the agent adapter so the system
  // prompt can state "this open_id is you" with the real value. Covers both
  // initial start and credential-swap reconnects (both go through here).
  if (identity?.openId) {
    agent.setBotIdentity?.({
      openId: identity.openId,
      ...(identity.name ? { name: identity.name } : {}),
    });
  }
  log.info('ws', 'connected', {
    bot: identity?.name ?? 'unknown',
    openId: identity?.openId ?? '-',
    agent: `${agent.displayName} (${agent.id})`,
    appId: cfg.accounts.app.id,
    procId: controls.processId,
  });
  console.log('正在监听消息。按 Ctrl+C 退出。\n');

  // App-level keepalive: 15s probe + wake-up detection + HTTP reachability.
  // Defense-in-depth — the SDK's pingTimeout watchdog handles half-dead WS,
  // this catches anything that the SDK misses (silent state stuck, etc.).
  const probeDomain =
    cfg.accounts.app.tenant === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';
  const keepalive = startKeepalive({
    channel,
    domain: probeDomain,
    forceReconnect: () => controls.restart(),
  });

  return {
    channel,
    disconnect: async () => {
      activeRuns.pauseNewRuns('bridge-disconnect');
      ownerRefresh.stop();
      knownChatsRefresh.stop();
      keepalive.stop();
      pending.cancelAll();
      // Phase 0 (评审五轮): explicitly cancel pre-spawn network awaits so
      // every tracked batch can reach its settle point quickly. Batches
      // aborted here never spawned, so their records stay queued and are
      // replayed next start — no terminal write is skipped.
      shutdown.abort();
      // Phase 1: tear down the connection and stop runs.
      const [disconnectResult, stopAllResult] = await Promise.allSettled([
        channel.disconnect(),
        activeRuns.stopAll(),
      ]);
      // Phase 2: wait for ALL tracked batches to genuinely settle (finish,
      // cancel-land, or see their abandoned-but-uncancellable network work
      // run out). There is deliberately NO early-return deadline (评审六轮
      // P1): flushing stores and returning while pendingSettles is non-empty
      // is the exact data-loss window this task exists to close — a wedged
      // writer now keeps shutdown blocked (a force-kill falls back to the
      // journal's crash-recovery semantics), and the threshold below only
      // escalates to repeating warnings for observability.
      const warnEveryMs = deps.shutdownDrainWarnMs ?? getAgentStopGraceMs(controls.cfg) + 10_000;
      let nextWarnAt = Date.now() + warnEveryMs;
      const drainStartedAt = Date.now();
      while (pendingSettles.size > 0) {
        await Promise.race([
          Promise.allSettled([...pendingSettles]),
          new Promise((resolve) => setTimeout(resolve, 100)),
        ]);
        if (pendingSettles.size > 0 && Date.now() >= nextWarnAt) {
          log.warn('disconnect', 'drain-stuck', {
            pending: pendingSettles.size,
            waitedMs: Date.now() - drainStartedAt,
            note: 'shutdown is blocked until these settle; force-kill falls back to crash recovery',
          });
          nextWarnAt = Date.now() + warnEveryMs;
        }
      }
      // Phase 3: flush every store only after all writers have settled.
      const flushResults = await Promise.allSettled([
        sessions.flush(),
        sessionCatalog?.flush(),
        callbackNonceStore?.flush(),
        workspaces.flush(),
        thinkingHistory?.flush(),
        inboundJournal?.flush(),
      ]);
      if (stopAllResult.status === 'rejected') {
        log.fail('disconnect', stopAllResult.reason, { step: 'stopAll' });
      }
      for (const [idx, result] of flushResults.entries()) {
        if (result.status === 'rejected') {
          log.fail('disconnect', result.reason, { step: `flush-${idx}` });
        }
      }
      if (disconnectResult.status === 'rejected') {
        throw disconnectResult.reason;
      }
    },
  };
}

/**
 * OPT-04 (评审七轮): a setTimeout grace that wakes early on shutdown so a
 * fixed delay (e.g. the startup-recovery handshake wait) never blocks
 * disconnect. Resolves on either expiry or abort; always clears the timer.
 */
function sleepUntilAbort(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Expected cancellation raised when graceful shutdown aborts a pre-spawn
 * await. Distinct from failures so the flush path can log it as info
 * instead of error telemetry.
 */
class BridgeShutdownCancelled extends Error {
  constructor(readonly label: string) {
    super(`bridge-shutdown:${label}`);
    this.name = 'BridgeShutdownCancelled';
  }
}

/**
 * OPT-04 (评审五轮/六轮): race a pre-spawn network await against the shutdown
 * signal. When abort fires the batch breaks out immediately, but the
 * underlying task CANNOT be aborted (the SDK's REST/download calls take no
 * AbortSignal) and keeps running — so it is handed to `trackAbandoned`
 * (trackSettle) and graceful shutdown keeps waiting until its side effects
 * (file writes, cache renames) finish. Never return while such work is in
 * flight: a restarted instance must not race the old one over the shared
 * media cache. Only ever wrap PRE-spawn awaits: local claim/terminal writes
 * must be awaited fully, not raced.
 */
function raceShutdown<T>(
  signal: AbortSignal,
  label: string,
  work: Promise<T>,
  trackAbandoned: (p: Promise<unknown>) => void,
): Promise<T> {
  if (signal.aborted) {
    trackAbandoned(work);
    return Promise.reject(new BridgeShutdownCancelled(label));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      trackAbandoned(work);
      reject(new BridgeShutdownCancelled(label));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function startKnownChatsRefreshTimer(
  channel: LarkChannel,
  controls: Controls,
): { stop(): void } {
  const intervalMs = 30 * 60 * 1000;
  const refresh = async (): Promise<void> => {
    const chats = await fetchKnownChats(channel);
    if (chats.length > 0) {
      controls.knownChats = chats;
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), intervalMs);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

async function sendNonAllowedGroupHint(
  channel: LarkChannel,
  chatId: string,
  replyToMessageId: string,
): Promise<void> {
  const text =
    '当前群尚未加入响应列表，所以 bot 不会处理消息。\n' +
    'Bot owner/管理员可在本群发 /invite group 加入白名单。';
  try {
    await channel.send(chatId, { text }, { replyTo: replyToMessageId });
  } catch {
    await channel.send(chatId, { text });
  }
}

interface IntakeDeps {
  channel: LarkChannel;
  agent: AgentAdapter;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  thinkingHistory?: ThinkingHistoryStore;
  inboundJournal?: InboundJournal;
  activeRuns: ActiveRuns;
  pending: PendingQueue;
  msg: NormalizedMessage;
  controls: Controls;
  chatModeCache: ChatModeCache;
  executor: RunExecutor;
  pool: ProcessPool;
  shutdownSignal: AbortSignal;
}

async function intakeMessage(deps: IntakeDeps): Promise<void> {
  const {
    channel,
    agent,
    sessions,
    sessionCatalog,
    workspaces,
    thinkingHistory,
    inboundJournal,
    activeRuns,
    pending,
    msg,
    controls,
    chatModeCache,
    executor,
    pool,
    shutdownSignal,
  } = deps;
  const preview = msg.content.length > 80 ? `${msg.content.slice(0, 80)}…` : msg.content;
  // Resolve scope (and underlying chat mode) once at intake — every
  // downstream consumer keys off these.
  const resolvedMode = await chatModeCache.resolve(channel, msg.chatId);
  let threadId = msg.threadId;
  if (!threadId && resolvedMode === 'topic') {
    threadId = await lookupMessageThreadId(channel, msg.messageId);
    if (threadId) {
      log.info('intake', 'thread-id-backfilled', {
        chatId: msg.chatId,
        msgId: msg.messageId,
        threadId,
      });
    }
  }
  const routedMessage = threadId === msg.threadId ? msg : { ...msg, threadId };
  const chatMode = threadId ? 'topic' : resolvedMode;
  if (threadId && resolvedMode !== 'topic') {
    chatModeCache.invalidate(msg.chatId);
  }
  const scope = chatMode === 'topic' && threadId
    ? `${msg.chatId}:${threadId}`
    : msg.chatId;
  log.info('intake', 'enter', {
    scope,
    chatType: msg.chatType,
    chatMode,
    resolvedMode,
    threadId,
    sender: msg.senderId,
    preview,
    resources: msg.resources.length,
  });

  const accessDecision =
    msg.chatType === 'p2p'
      ? canUseDm(controls.profileConfig, controls, msg.senderId)
      : canUseGroup(controls.profileConfig, controls, msg.chatId, msg.senderId);
  if (!accessDecision.ok) {
    log.info('intake', 'skip-not-allowed-user', {
      scope,
      sender: msg.senderId.slice(-6),
      reason: accessDecision.reason,
    });
    if (msg.chatType !== 'p2p' && accessDecision.reason === 'denied-chat' && msg.mentionedBot) {
      void sendNonAllowedGroupHint(channel, msg.chatId, msg.messageId).catch((err) =>
        log.warn('intake', 'non-allowed-hint-failed', { err: String(err) }),
      );
    }
    return;
  }

  // Group-mention policy. p2p is always unrestricted; in groups (regular and
  // topic) we drop messages that don't @bot when the user has opted into the
  // quiet-by-default behavior. Slash commands are NOT exempt — the user
  // chose strict mode so the group stays uniformly quiet unless mentioned.
  // @全员 is already filtered by SDK (`respondToMentionAll: false`), so any
  // event reaching here is either targeted or undirected chatter.
  if (
    msg.chatType !== 'p2p' &&
    getRequireMentionInGroup(controls.cfg) &&
    !msg.mentionedBot
  ) {
    log.info('intake', 'skip-no-mention', { scope, chatType: msg.chatType });
    return;
  }

  const handled = await tryHandleCommand({
    channel,
    msg: routedMessage,
    scope,
    chatMode,
    sessions,
    workspaces,
    thinkingHistory,
    inboundJournal,
    agent,
    activeRuns,
    sessionCatalog,
    sessionCatalogIdentity: await commandSessionCatalogIdentity({
      msg: routedMessage,
      scope,
      mode: chatMode,
      workspaces,
      controls,
      access: accessDecision,
    }),
    runExecutor: executor,
    processPool: pool,
    controls,
  });
  if (handled) {
    if (commandKeepsPendingQueue(routedMessage.content)) {
      log.info('intake', 'command-keep-queue', { scope });
    } else {
      const dropped = pending.cancel(scope);
      log.info('intake', 'command', { scope, droppedPending: dropped.length });
    }
    return;
  }

  // OPT-04: journal the accepted message before it enters the in-memory
  // queue, so a crash/restart cannot silently drop it. Commands are not
  // journaled — they are not agent dispatches.
  // 评审七轮: re-check the shutdown gate HERE (after the chat-mode / thread
  // lookup / command-context awaits). If disconnect fired while this intake
  // was in flight, the old instance must NOT journal a fresh record or arm a
  // dispatch timer — the incoming event is dropped and the next start replays
  // from the journal's own queued records.
  if (shutdownSignal.aborted) {
    log.info('intake', 'dropped-by-shutdown', { scope, messageId: msg.messageId });
    return;
  }
  // OPT-07 Slice C: freeze the target model ONCE at acceptance. The same
  // value goes to the journal record (durable) and the per-message WeakMap
  // (in-memory fallback for journal-less callers), so a later /model change
  // cannot rewrite this message; dispatch groups by it.
  const acceptedModel = sessions.getModelPreference(scope, agent.id)?.model;
  if (inboundJournal) {
    const result = await inboundJournal
      .recordAccepted({
        messageId: msg.messageId,
        scope,
        chatId: msg.chatId,
        senderId: msg.senderId,
        content: msg.content,
        acceptedAt: msg.createTime || Date.now(),
        model: acceptedModel,
        ...(msg.threadId ? { threadId: msg.threadId } : {}),
        ...(msg.chatType === 'p2p' ? { chatType: 'p2p' as const } : { chatType: 'group' as const }),
      })
      .catch(() => 'failed' as const);
    if (result === 'failed') {
      log.warn('inbound', 'accept-not-durable', { scope, messageId: msg.messageId });
    } else if (result === 'duplicate') {
      // Feishu redelivery of an event we already accepted (queued, claimed or
      // terminal). Dispatching it again could merge it into a running prompt
      // or start a second run — OPT-04: duplicates must not re-execute.
      log.info('inbound', 'duplicate-dropped', { scope, messageId: msg.messageId });
      return;
    }
  }

  // 评审七轮: last gate before arming the dispatch timer. An abort during
  // the recordAccepted await above leaves the record queued (replayed next
  // start); we must not hand the old instance a live dispatch to run.
  if (shutdownSignal.aborted) {
    log.info('intake', 'dispatch-skipped-by-shutdown', { scope, messageId: msg.messageId });
    return;
  }
  intakeModelSnapshots.set(routedMessage, acceptedModel);
  const size = pending.push(scope, routedMessage);
  log.info('intake', 'queued', { scope, queueSize: size, debounceMs: DEBOUNCE_MS });
}

/** Rebuild a replayable message from a journal record (OPT-04 recovery). */
function recoveryMessage(record: InboundRecord): NormalizedMessage {
  return {
    messageId: record.messageId,
    chatId: record.chatId,
    chatType: record.chatType ?? 'group',
    ...(record.threadId ? { threadId: record.threadId } : {}),
    senderId: record.senderId,
    senderName: undefined,
    content: record.content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: record.acceptedAt,
  } as unknown as NormalizedMessage;
}

interface RunBatchDeps {
  channel: LarkChannel;
  executor: RunExecutor;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  thinkingHistory?: ThinkingHistoryStore;
  inboundJournal?: InboundJournal;
  media: MediaCache;
  batch: NormalizedMessage[];
  controls: Controls;
  callbackAuth?: CallbackAuth;
  activePolicyFingerprints: Map<string, string>;
  scope: string;
  mode: ChatMode;
  /** OPT-07 Slice C: the model snapshot for THIS group (all its messages share
   * it). `undefined` = no override (follow CLI). Resolved by the flush handler
   * from each message's journaled snapshot, NOT the live preference. */
  model?: string;
  /** Registers in-flight terminal callbacks so shutdown can await them. */
  trackSettle: (p: Promise<unknown>) => Promise<unknown>;
  /** Aborted at graceful disconnect; cancels pre-spawn network awaits. */
  shutdownSignal: AbortSignal;
}

interface ModelGroup {
  model?: string;
  messages: NormalizedMessage[];
}

/**
 * OPT-07 Slice C: partition a flush into maximal runs of consecutive messages
 * that share the same model snapshot. Order is preserved (a message is never
 * reordered past a differently-targeted neighbour), so two messages that a
 * /model change separated never collapse into one prompt. Exported for tests.
 */
export function groupBatchByModelSnapshot(
  batch: NormalizedMessage[],
  snapshotOf: (msg: NormalizedMessage) => string | undefined,
): ModelGroup[] {
  const groups: ModelGroup[] = [];
  for (const msg of batch) {
    const model = snapshotOf(msg);
    const last = groups[groups.length - 1];
    if (last && last.model === model) last.messages.push(msg);
    else groups.push({ model, messages: [msg] });
  }
  return groups;
}

async function runAgentBatch(deps: RunBatchDeps): Promise<void> {
  const {
    channel,
    executor,
    sessions,
    sessionCatalog,
    workspaces,
    thinkingHistory,
    inboundJournal,
    media,
    batch,
    controls,
    callbackAuth,
    activePolicyFingerprints,
    scope,
    mode,
    model,
    trackSettle,
    shutdownSignal,
  } = deps;
  if (batch.length === 0) return;
  const firstMsg = batch[0];
  const lastMsg = batch[batch.length - 1];
  if (!firstMsg || !lastMsg) return;

  const chatId = firstMsg.chatId;
  const threadId = firstMsg.threadId;

  const resourceItems = batch.flatMap((m) =>
    m.resources.map((r) => ({ messageId: m.messageId, resource: r })),
  );
  const attachments = await raceShutdown(
    shutdownSignal,
    'media-resolve',
    media.resolve(resourceItems, controls.profileConfig.attachments),
    trackSettle,
  );
  if (attachments.length > 0) {
    log.info('media', 'resolved', { count: attachments.length });
    for (const attachment of attachments) {
      log.info('attachment', 'decision', {
        decision: attachment.decision,
        kind: attachment.kind,
        hash: attachment.hash,
        size: attachment.size,
        sourceMessageId: attachment.sourceMessageId,
        reason: attachment.rejectionReason,
      });
    }
  }

  // Collect any reply-quote targets in the batch. Dedup so the same target
  // quoted by multiple messages in one batch only fetches once. Filter out
  // ids that are themselves in the batch — those are already in the prompt.
  const batchIds = new Set(batch.map((m) => m.messageId));
  const quoteTargets = [
    ...new Set(
      batch
        .map((m) => replyQuoteTargetForMessage(m, mode))
        .filter((id): id is string => Boolean(id) && !batchIds.has(id!)),
    ),
  ];
  const quotes: QuotedContext[] = [];
  for (const targetId of quoteTargets) {
    const q = await raceShutdown(
      shutdownSignal,
      'quote-fetch',
      fetchQuotedContext(channel, targetId),
      trackSettle,
    );
    if (q) {
      quotes.push(q);
      log.info('quote', 'fetched', {
        messageId: targetId,
        type: q.rawContentType,
        contentChars: q.content.length,
      });
    }
  }

  // For topic groups: thread the reply so it lands in the same topic as the
  // user's message. Otherwise the SDK posts at top level and the user's
  // topic discussion breaks visually.
  const sendOpts = {
    replyTo: lastMsg.messageId,
    ...(mode === 'topic' && threadId ? { replyInThread: true } : {}),
  };

  const accessDecision =
    firstMsg.chatType === 'p2p'
      ? canUseDm(controls.profileConfig, controls, firstMsg.senderId)
      : canUseGroup(controls.profileConfig, controls, firstMsg.chatId, firstMsg.senderId);
  const scopeContext: ScopeContext = {
    source: 'im',
    chatId,
    actorId: firstMsg.senderId,
    ...(threadId ? { threadId } : {}),
  };
  const capability = capabilityForAgentKind(controls.profileConfig.agentKind, controls.profileConfig);
  // OPT-04 重头重做: a redo record may carry a resetSession intent. Execute it
  // here — before startRunFlow resolves resume state and before the pre-spawn
  // claim — so both the live-flush path and a crash replay reset the scope
  // session (catalog archive + clear, same as /new) deterministically. The
  // flag is cleared in memory and persisted by the claim right after; a crash
  // in between merely re-runs the (idempotent) reset on replay.
  if (inboundJournal) {
    const flagged = batch.filter(
      (m) => inboundJournal.getRecord(scope, m.messageId)?.resetSession,
    );
    if (flagged.length > 0) {
      const identity = await commandSessionCatalogIdentity({
        msg: firstMsg,
        scope,
        mode,
        workspaces,
        controls,
        access: accessDecision,
      });
      if (identity) {
        sessionCatalog?.archiveActive({ ...identity, now: Date.now() });
      }
      sessions.clear(scope);
      for (const m of flagged) {
        inboundJournal.getRecord(scope, m.messageId)!.resetSession = false;
      }
      log.info('inbound', 'recovery-reset-session', {
        scope,
        messageIds: flagged.map((m) => m.messageId),
        archived: Boolean(identity),
      });
    }
  }
  if (shutdownSignal.aborted) {
    throw new BridgeShutdownCancelled('pre-spawn');
  }
  const flow = await startRunFlow({
    scopeId: scope,
    scope: scopeContext,
    beforeSpawn: async () => {
      // OPT-04: claim the batch atomically BEFORE the agent spawns. If the
      // claim cannot be persisted, startRunFlow aborts the run — otherwise a
      // crash here would leave the records queued and a restart would
      // re-execute a task whose side effects already happened.
      const claimed = await inboundJournal?.markClaimed(
        scope,
        batch.map((m) => m.messageId),
        `pending:${Date.now()}`,
      );
      if (inboundJournal && !claimed) {
        throw new Error('inbound journal claim could not be persisted');
      }
    },
    prompt: async ({ resumeFrom }) => {
      let topicContext: QuotedContext[] = [];
      if (mode === 'topic' && threadId && !resumeFrom) {
        topicContext = await raceShutdown(
          shutdownSignal,
          'topic-context',
          fetchTopicContext(channel, threadId, {
            maxMessages: 40,
            excludeIds: new Set([...batchIds, ...quoteTargets]),
          }),
          trackSettle,
        );
        if (topicContext.length > 0) {
          log.info('topic', 'context-fetched', { scope, threadId, count: topicContext.length });
        }
      }
      const prompt = buildPrompt(batch, attachments, quotes, topicContext, channel.botIdentity);
      log.info('prompt', 'built', {
        promptChars: prompt.length,
        quotes: quotes.length,
        topicContext: topicContext.length,
        resumed: Boolean(resumeFrom),
      });
      return prompt;
    },
    attachments: attachments.map(toPolicyAttachment),
    access: accessDecision,
    capability,
    profileConfig: controls.profileConfig,
    sessions,
    sessionCatalog,
    workspaces,
    executor,
    now: Date.now(),
    model,
    stopGraceMs: getAgentStopGraceMs(controls.cfg),
    observability: {
      profile: controls.profile,
      agent: capability.agentId,
      source: 'im',
      stage: 'submit',
    },
  });
  if (!flow.ok) {
    log.info('run-flow', 'rejected', { scope, code: flow.rejectReason.code });
    log.warn('policy', 'denied', {
      scope,
      source: 'im',
      code: flow.rejectReason.code,
    });
    if (flow.rejectReason.code === 'journal-claim-failed') {
      log.warn('inbound', 'claim-abort', { scope });
    }
    // A rejection is final for these messages — settle them so a restart
    // does not replay them into the same rejection. Covers queued records
    // (rejected before spawn) and claimed ones (claim persisted but the
    // executor refused — no agent ever started).
    await inboundJournal
      ?.markRejected(
        scope,
        batch.map((m) => m.messageId),
      )
      .catch((err) => log.fail('inbound', err, { step: 'mark-rejected', scope }));
    await channel.send(chatId, { markdown: flow.rejectReason.userVisible }, sendOpts);
    return;
  }

  const { execution, cwdRealpath: cwd } = flow;
  // OPT-04: bind the pre-spawn provisional claim to the real run id. Failure
  // is conservative-safe (record stays claimed → uncertain on restart) but
  // must be visible.
  await inboundJournal
    ?.bindRun(
      scope,
      batch.map((m) => m.messageId),
      execution.runId,
    )
    .catch((err) => log.fail('inbound', err, { step: 'bind-run', scope, runId: execution.runId }));
  activePolicyFingerprints.set(scope, flow.policy.policyFingerprint);
  const handle = execution.handle;
  const eventStream = execution.subscribe();
  if (flow.resumeFrom) {
    log.info('session', 'resume', { sessionId: flow.resumeFrom, cwd });
  } else {
    log.info('session', 'fresh', { cwd });
  }
  const recordSession = (evt: AgentEvent): void => {
    recordRunSessionEvent({
      scopeId: scope,
      sessions,
      sessionCatalog,
      capability,
      policy: flow.policy,
      event: evt,
    });
    if (evt.type === 'system' && evt.sessionId) {
      log.info('session', 'set', { sessionId: evt.sessionId });
    }
    if (evt.type === 'system' && evt.threadId) {
      log.info('session', 'set-thread', { threadId: evt.threadId });
    }
  };

  // Resolve idle-timeout for this run: scope override (on SessionEntry) wins
  // over global default (preferences). 0 / undefined = no watchdog.
  const scopeOverride = sessions.getIdleTimeoutMinutes(scope);
  const idleTimeoutMs =
    scopeOverride !== undefined
      ? scopeOverride > 0
        ? scopeOverride * 60_000
        : undefined
      : getRunIdleTimeoutMs(controls.cfg);
  if (idleTimeoutMs) {
    log.info('flush', 'idle-watchdog', { idleTimeoutMs });
  }

  const replyMode = getMessageReplyMode(controls.cfg);
  log.info('flush', 'reply-mode', { mode: replyMode });

  // Completion/full-result hook. Silent-period heartbeats are rendered back
  // into the active progress surface by processAgentStream instead of posting
  // separate chat messages.
  const hooks: StreamHooks = {
    onTerminal: (state, elapsedMs, fullText, truncated) => {
      const mins = Math.max(1, Math.round(elapsedMs / 60_000));
      const toolCount = state.blocks.filter((b) => b.kind === 'tool').length;
      // OPT-06: failure evidence from structured tool_result events — a green
      // completion notice must not hide failed tool calls.
      const failedTools = state.blocks.filter(
        (b) => b.kind === 'tool' && b.tool.status === 'error',
      ).length;
      if (fullText.trim()) sessions.setLastRunOutput(scope, fullText);
      // OPT-07 Slice C: report the model truthfully (reported value as-is;
      // request-without-confirmation says so; nothing requested → silent).
      const modelSegment = formatModelNoticeSegment({
        reportedModel: state.reportedModel,
        requestedModel: model,
      });
      const baseNotice = buildTerminalNotice(state, { mins, toolCount, truncated, failedTools }) + modelSegment;
      // Persist the run's thinking before advertising the /thinking entry —
      // a failed save must not produce a dead hint (OPT-01B). Tracked so a
      // graceful shutdown waits for the journal/thinking writes (OPT-04).
      void trackSettle?.((async () => {
        // OPT-04: the run reached a known terminal state — journal it so a
        // restart never classifies this batch as uncertain. A failed settle
        // leaves the record claimed (→ uncertain, never auto-rerun) and is
        // reported.
        const settled = await inboundJournal
          ?.markTerminal(scope, execution.runId, state.terminal)
          .catch((err) => {
            log.fail('inbound', err, { step: 'mark-terminal', scope, runId: execution.runId });
            return false;
          });
        if (inboundJournal && !settled) {
          log.warn('inbound', 'terminal-not-durable', { scope, runId: execution.runId });
        }
        let notice = baseNotice;
        if (thinkingHistory) {
          const endedAt = Date.now();
          const saved = await thinkingHistory
            .save({
              scope,
              runId: execution.runId,
              agent: controls.profileConfig.agentKind,
              startedAt: endedAt - elapsedMs,
              endedAt,
              terminal: state.terminal,
              content: state.reasoning.content,
            })
            .catch(() => false);
          if (!saved) {
            log.warn('thinking', 'save-failed', { scope, runId: execution.runId });
          }
          notice = appendThinkingHint(notice, {
            saved,
            hasThinking: state.reasoning.content.length > 0,
            runId: execution.runId,
          });
        }
        await channel.send(chatId, { markdown: notice }, sendOpts);
      })().catch((err) => log.fail('stream', err, { step: 'completion' })));
    },
  };

  // Re-read prefs on every flush so toggling /config mid-stream takes
  // effect immediately. Cheap object lookups, no allocation when on.
  const filterForPrefs = (state: RunState): RunState => {
    if (getShowToolCalls(controls.cfg)) return state;
    return { ...state, blocks: state.blocks.filter((b) => b.kind !== 'tool') };
  };
  const cardRenderOptions = callbackAuth
    ? {
        signCallback: (action: string) =>
          callbackAuth.sign({
            runId: execution.runId,
            scope,
            chatId,
            operatorOpenId: firstMsg.senderId,
            action,
            policyFingerprint: flow.policy.policyFingerprint,
            ttlMs: 24 * 60 * 60 * 1000,
          }),
      }
    : {};

  // For non-card modes Claude's output doesn't surface visually until either
  // a first streamed token (markdown mode) or the whole run ends (text mode).
  // Add a "Typing" reaction to the triggering message as an instant ack, but
  // never let that outbound API call block agent event draining.
  const reactionPromise =
    replyMode === 'card' ? undefined : addWorkingReaction(channel, lastMsg.messageId);

  try {
    if (replyMode === 'card') {
      let latestState: RunState = initialState;
      let latestProgress: RunCardProgress = {
        elapsedMs: 0,
        idleMs: 0,
        completedTools: 0,
        inFlightTools: 0,
      };
      let progressUpdateFailed = false;
      let fallbackSent = false;
      let cardAttached = false;
      let activeSession: StreamingCardSession | undefined;
      const sessionSendOpts = {
        replyTo: sendOpts.replyTo,
        ...(sendOpts.replyInThread ? { replyInThread: true as const } : {}),
      };
      const renderProgressCard = (state: RunState, progress: RunCardProgress): object =>
        renderCardBounded(filterForPrefs(state), { ...cardRenderOptions, progress });
      const cardUpdater = new ResilientCardUpdater({
        sendSuccessor: async (card) => {
          const prev = activeSession;
          if (prev) {
            try {
              await prev.close();
            } catch {
              /* best-effort finalize of the expired stream */
            }
            prev.dispose();
          }
          const next = await startStreamingCardSession(
            channel,
            chatId,
            card,
            sessionSendOpts,
          );
          activeSession = next;
          return { messageId: next.messageId };
        },
        updateMessage: async (messageId, card) => {
          if (activeSession?.messageId === messageId) {
            await activeSession.update(card);
            return;
          }
          await channel.updateCard(messageId, card);
        },
        onRollover: (previousMessageId, nextMessageId) => {
          log.warn('stream', 'card-rollover', {
            previousMessageId: previousMessageId ?? null,
            nextMessageId,
          });
        },
      });
      const sendCardFallback = async (state: RunState): Promise<void> => {
        if (controls.profileConfig.agentKind === 'codex') return;
        if (renderText(filterForPrefs(state)).trim() === '') return;
        await channel.send(
          chatId,
          { card: renderProgressCard(state, latestProgress) },
          sendOpts,
        );
        fallbackSent = true;
      };
      // Drain agent events immediately so we don't drop output while the
      // CardKit entity is being created. Flushes no-op until cardAttached.
      const renderDone = processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        recordSession,
        async (state, progress) => {
          latestState = state;
          latestProgress = progress;
          if (cardAttached) {
            await cardUpdater.update(renderProgressCard(state, progress));
          }
        },
        {
          ...hooks,
          onFlushError: () => {
            progressUpdateFailed = true;
          },
          onFlushSuccess: () => {
            progressUpdateFailed = false;
          },
        },
      );
      trackSettle(renderDone);
      try {
        try {
          activeSession = await startStreamingCardSession(
            channel,
            chatId,
            renderProgressCard(initialState, latestProgress),
            sessionSendOpts,
          );
          cardAttached = true;
          cardUpdater.attachPrimary(activeSession.messageId, (card) => {
            if (!activeSession) throw new Error('streaming card session missing');
            return activeSession.update(card);
          });
          await cardUpdater.update(renderProgressCard(latestState, latestProgress));
        } catch (err) {
          log.fail('stream', err, {
            mode: replyMode,
            step: cardAttached ? 'card-attach' : 'session-create',
          });
          progressUpdateFailed = true;
        }

        try {
          await renderDone;
        } catch (err) {
          if (controls.profileConfig.agentKind !== 'codex') throw err;
          log.fail('stream', err, { mode: replyMode, step: 'progress-stream' });
        }
        if ((!cardAttached || progressUpdateFailed) && !fallbackSent) {
          await sendCardFallback(latestState);
        }
        const streamDone = Promise.resolve({
          messageId: activeSession?.messageId,
        });
        recallIfEmptyStreamedReply(channel, streamDone, filterForPrefs(latestState), scope);
        if (controls.profileConfig.agentKind === 'codex') {
          await sendReservedFinalReply({
            channel,
            chatId,
            state: latestState,
            replyMode,
            sendOpts,
            cardRenderOptions,
          });
        }
      } finally {
        if (activeSession) {
          try {
            await activeSession.close();
          } catch (err) {
            log.fail('stream', err, { step: 'streaming-close' });
          }
          activeSession.dispose();
        }
      }
    } else if (replyMode === 'markdown') {
      let latestState: RunState = initialState;
      let producerStarted = false;
      let progressUpdateFailed = false;
      let fallbackSent = false;
      let markdownCtrl: { setContent(markdown: string): Promise<void> } | undefined;
      const renderDone = processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        recordSession,
        async (state) => {
          latestState = state;
          if (markdownCtrl) {
            await markdownCtrl.setContent(renderText(filterForPrefs(state)));
          }
        },
        {
          ...hooks,
          onFlushError: () => {
            progressUpdateFailed = true;
          },
          onFlushSuccess: () => {
            progressUpdateFailed = false;
          },
        },
      );
      trackSettle(renderDone);
      const sendMarkdownFallback = async (state: RunState): Promise<void> => {
        if (controls.profileConfig.agentKind === 'codex') return;
        const reply = finalReplyText(filterForPrefs(state));
        if (!reply?.trim()) return;
        await channel.send(chatId, { markdown: reply }, sendOpts);
        fallbackSent = true;
      };
      const streamDone = channel.stream(
        chatId,
        {
          markdown: async (ctrl) => {
            producerStarted = true;
            markdownCtrl = ctrl;
            await ctrl.setContent(renderText(filterForPrefs(latestState)));
            await renderDone;
          },
        },
        sendOpts,
      );
      try {
        await awaitRenderAwareStream({
          mode: replyMode,
          streamDone,
          renderDone,
          producerStarted: () => producerStarted,
          fallback: sendMarkdownFallback,
        });
      } catch (err) {
        if (controls.profileConfig.agentKind !== 'codex') throw err;
        log.fail('stream', err, { mode: replyMode, step: 'progress-stream' });
      }
      if (progressUpdateFailed && !fallbackSent) {
        await sendMarkdownFallback(latestState);
      }
      recallIfEmptyStreamedReply(channel, streamDone, filterForPrefs(latestState), scope);
      if (controls.profileConfig.agentKind === 'codex') {
        await sendReservedFinalReply({
          channel,
          chatId,
          state: latestState,
          replyMode,
          sendOpts,
          cardRenderOptions,
        });
      }
    } else {
      // text mode: drain the agent stream without sending anything during
      // the run, then post only the final reply (text after the last tool)
      // once as a plain markdown message — no card, no streaming, no
      // typewriter, no process-narration dump. `/last` recalls the full run.
      const streamSettled = processAgentStream(
        handle,
        eventStream,
        scope,
        idleTimeoutMs,
        recordSession,
        async () => {},
        hooks,
      );
      trackSettle(streamSettled);
      const finalState = await streamSettled;
      if (controls.profileConfig.agentKind === 'codex') {
        await sendReservedFinalReply({
          channel,
          chatId,
          state: finalState,
          replyMode,
          sendOpts,
          cardRenderOptions,
        });
      } else {
        const reply = finalReplyText(finalState);
        if (reply?.trim()) {
          await channel.send(chatId, { markdown: reply }, sendOpts);
        }
      }
    }
  } catch (err) {
    log.fail('stream', err);
  } finally {
    activePolicyFingerprints.delete(scope);
    scheduleWorkingReactionCleanup(channel, lastMsg.messageId, reactionPromise);
  }
}

function recallIfEmptyStreamedReply(
  channel: LarkChannel,
  streamDone: Promise<unknown>,
  finalState: RunState,
  scope: string,
): void {
  if (renderText(finalState).trim() !== '') return;
  void streamDone
    .then(async (rawResult) => {
      const result = rawResult as { messageId?: string } | undefined;
      const messageId = result?.messageId;
      if (!messageId) return;
      try {
        await channel.recallMessage(messageId);
        log.info('outbound', 'recall-empty', { scope, messageId });
      } catch (err) {
        log.warn('outbound', 'recall-empty-failed', {
          scope,
          messageId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    })
    .catch((err) => {
      log.fail('stream', err, { step: 'recall-empty-stream' });
    });
}

async function sendReservedFinalReply(input: {
  channel: LarkChannel;
  chatId: string;
  state: RunState;
  replyMode: 'card' | 'markdown' | 'text';
  sendOpts: { replyTo: string; replyInThread?: boolean };
  cardRenderOptions: { signCallback?: (action: string) => string };
}): Promise<void> {
  const finalText = input.state.finalText?.trim();
  if (!finalText) return;
  const finalState: RunState = {
    ...initialState,
    blocks: [{ kind: 'text', content: finalText, streaming: false }],
    terminal: 'done',
    footer: null,
  };
  if (input.replyMode === 'card') {
    await input.channel.send(
      input.chatId,
      { card: renderCardBounded(windowState(finalState, WINDOW_OPTS), input.cardRenderOptions) },
      input.sendOpts,
    );
    return;
  }
  const reply = finalReplyText(finalState);
  if (reply?.trim()) {
    await input.channel.send(input.chatId, { markdown: reply }, input.sendOpts);
  }
}

/**
 * Drive the agent's event stream into a stateful RunState, calling `flush`
 * on every state transition. Used by both card and markdown reply modes —
 * the only difference between the two is what `flush` does with the state.
 */
const WINDOW_OPTS: WindowOptions = { maxTextChars: 4000 };

const HEARTBEAT_INTERVAL_MS = 3 * 60_000;

export interface StreamHooks {
  onHeartbeat?: (elapsedMs: number, currentTool: string | undefined) => void | Promise<void>;
  onTerminal?: (state: RunState, elapsedMs: number, fullText: string, truncated: boolean) => void;
  onFlushError?: (error: unknown) => void;
  onFlushSuccess?: () => void;
  heartbeatIntervalMs?: number;
}

export async function processAgentStream(
  handle: RunHandle,
  events: AsyncIterable<AgentEvent>,
  scope: string,
  idleTimeoutMs: number | undefined,
  recordSession: (event: AgentEvent) => void,
  flush: (state: RunState, progress: RunCardProgress) => Promise<void>,
  hooks?: StreamHooks,
): Promise<RunState> {
  const runStart = Date.now();
  let lastActivityAt = runStart;
  let state: RunState = initialState;
  let fullText = '';
  let currentTool: string | undefined;
  let completedTools = 0;
  const inFlightTools = new Set<string>();
  let flushFailureLogged = false;
  const progressSnapshot = (): RunCardProgress => {
    const now = Date.now();
    return {
      elapsedMs: now - runStart,
      idleMs: now - lastActivityAt,
      ...(currentTool ? { currentTool } : {}),
      completedTools,
      inFlightTools: inFlightTools.size,
    };
  };

  // OPT-02 delivery scheduling: event consumption never waits on a network
  // update. Offers coalesce to the newest snapshot while one send is in
  // flight; the terminal snapshot goes out last with bounded retries.
  const delivery = new SnapshotScheduler<RunState>({
    send: (snapshot) => flush(snapshot, progressSnapshot()),
    onResult: (ok, err) => {
      if (ok) {
        try {
          hooks?.onFlushSuccess?.();
        } catch (hookErr) {
          log.fail('stream', hookErr, { step: 'onFlushSuccess' });
        }
        return;
      }
      try {
        hooks?.onFlushError?.(err);
      } catch (hookErr) {
        log.fail('stream', hookErr, { step: 'onFlushError' });
      }
      if (!flushFailureLogged) {
        flushFailureLogged = true;
        log.fail('stream', err, { step: 'progress-update' });
      }
    },
  });
  const safeFlush = (nextState: RunState): void => {
    delivery.offer(nextState);
  };

  // Idle watchdog: claude going silent for `idleTimeoutMs` is treated as
  // "presumed hung", we stop() and surface a timeout marker on the card.
  //
  // BUT — claude can legitimately be silent for a long time when it's
  // waiting on a long-running tool call (e.g. `lark-cli` printing an
  // OAuth URL and blocking until the user clicks authorize). In that
  // case there's no event stream activity from claude itself, only the
  // tool subprocess running. We track which tool_use ids haven't matched
  // a tool_result yet, and pause the watchdog whenever the set is
  // non-empty.
  //
  // The watchdog re-arms when:
  //  - a tool_result drains the in-flight set to zero, OR
  //  - any non-tool event arrives while the set is empty.
  let idleFired = false;
  let timer: NodeJS.Timeout | undefined;
  const armOrPauseIdle = (): void => {
    if (!idleTimeoutMs) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (inFlightTools.size > 0) return;
    timer = setTimeout(() => {
      idleFired = true;
      handle.interrupted = true;
      log.warn('agent', 'idle-timeout', { scope, idleTimeoutMs });
      void handle.run.stop().catch(() => {
        /* stop errors are non-fatal */
      });
    }, idleTimeoutMs);
  };
  armOrPauseIdle();

  // Heartbeat: fires every heartbeatIntervalMs regardless of tool silence
  // (unlike idle watchdog, which pauses during in-flight tools). Gives the
  // user a progress signal during long silent tool calls.
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let heartbeatClosed = false;
  const heartbeatMs = hooks?.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const armHeartbeat = (): void => {
    if (!hooks || heartbeatClosed) return;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = undefined;
      void (async () => {
        safeFlush(windowState(state, WINDOW_OPTS));
        try {
          await hooks.onHeartbeat?.(Date.now() - runStart, currentTool);
        } catch (err) {
          log.fail('stream', err, { step: 'heartbeat' });
        }
        armHeartbeat();
      })();
    }, heartbeatMs);
  };
  const resetHeartbeat = (): void => {
    if (!hooks) return;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    armHeartbeat();
  };
  armHeartbeat();

  try {
    for await (const evt of events) {
      if (handle.interrupted) break;
      lastActivityAt = Date.now();

      // Track tool flight before re-arming the idle timer so the arm step
      // sees the correct set size. tool_use opens a window; tool_result
      // closes it. Other event types are bookkept after the if/else.
      if (evt.type === 'tool_use') {
        inFlightTools.add(evt.id);
        currentTool = evt.name;
        log.info('agent', 'tool-in-flight', {
          tool: evt.name,
          inFlight: inFlightTools.size,
        });
      } else if (evt.type === 'tool_result') {
        if (inFlightTools.delete(evt.id)) completedTools += 1;
        if (inFlightTools.size === 0) currentTool = undefined;
        log.info('agent', 'tool-done', { inFlight: inFlightTools.size });
      }
      armOrPauseIdle();
      resetHeartbeat();
      if (evt.type === 'text') fullText += evt.delta;
      if (evt.type === 'final_text') fullText += evt.content;

      if (evt.type === 'system') {
        recordSession(evt);
        // OPT-07 Slice C: keep the upstream-reported model (only when it
        // actually reports one) so the completion notice can show the real
        // model, distinct from what we requested. Never a guess.
        if (evt.model) state = { ...state, reportedModel: evt.model };
        continue;
      }
      if (evt.type === 'usage') {
        const { costUsd, inputTokens, outputTokens } = evt;
        if (costUsd !== undefined || inputTokens !== undefined || outputTokens !== undefined) {
          log.info('agent', 'usage', {
            ...(costUsd !== undefined ? { costUsd: Number(costUsd.toFixed(4)) } : {}),
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(outputTokens !== undefined ? { outputTokens } : {}),
          });
          if (costUsd !== undefined) reportMetric('cost_usd', costUsd);
          if (inputTokens !== undefined) reportMetric('tokens_in', inputTokens);
          if (outputTokens !== undefined) reportMetric('tokens_out', outputTokens);
        }
        continue;
      }

      const prevTerminal = state.terminal;
      const prevFooter = state.footer;
      state = reduce(state, evt);
      if (state.footer !== prevFooter || state.terminal !== prevTerminal) {
        log.info('card', 'transition', { footer: state.footer, terminal: state.terminal });
      }
      safeFlush(windowState(state, WINDOW_OPTS));
      // Stop iterating as soon as we have a terminal state. Some claude
      // versions don't close stdout immediately after the result event, which
      // would leave the for-await waiting forever otherwise.
      if (state.terminal !== 'running') break;
    }
  } finally {
    if (timer) clearTimeout(timer);
    heartbeatClosed = true;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
  }

  // If state already reached a terminal event (done/error/etc.) before the
  // watchdog or interrupt could land, don't clobber it — that real terminal
  // wins. This avoids "claude finished but flush was slow → timer fired
  // mid-flush → user sees 'idle_timeout' on a successful run".
  if (state.terminal === 'running') {
    if (idleFired) {
      state = markIdleTimeout(state, Math.round(idleTimeoutMs! / 60_000));
    } else if (handle.interrupted) {
      state = markInterrupted(state);
    } else {
      state = finalizeIfRunning(state);
    }
  }
  log.info('card', 'final', { terminal: state.terminal, interrupted: handle.interrupted });
  reportMetric('run_e2e_ms', Date.now() - runStart, { terminal: state.terminal });
  const windowedFinal = windowState(state, WINDOW_OPTS);
  // Terminal barrier: awaited, retried a bounded number of times, and always
  // the last snapshot on the wire (older running snapshots can't cover it).
  await delivery.finish(windowedFinal);
  const deliveryStats = delivery.getStats();
  const deliveryLagMs = deliveryStats.lastDeliverySuccessAt
    ? deliveryStats.lastDeliverySuccessAt - lastActivityAt
    : undefined;
  log.info('stream', 'delivery-stats', {
    offered: deliveryStats.offered,
    delivered: deliveryStats.delivered,
    coalesced: deliveryStats.coalesced,
    failures: deliveryStats.failures,
    lastErrorCategory: deliveryStats.lastErrorCategory,
    deliveryLagMs,
  });
  reportMetric('card_delivery_lag_ms', deliveryLagMs ?? -1, { terminal: state.terminal });
  reportMetric('card_delivery_failures', deliveryStats.failures, { terminal: state.terminal });
  reportMetric('card_delivery_coalesced', deliveryStats.coalesced, { terminal: state.terminal });
  const reservedFinalTruncated = (state.finalText?.trim().length ?? 0) > WINDOW_OPTS.maxTextChars;
  try {
    hooks?.onTerminal?.(
      state,
      Date.now() - runStart,
      fullText,
      Boolean(windowedFinal.truncated || reservedFinalTruncated),
    );
  } catch (err) {
    log.fail('stream', err, { step: 'onTerminal' });
  }
  if (handle.interrupted) {
    await handle.run.stop();
  }
  return state;
}

export async function awaitRenderAwareStream(input: {
  mode: 'card' | 'markdown';
  streamDone: Promise<unknown>;
  renderDone: Promise<RunState>;
  producerStarted: () => boolean;
  fallback: (state: RunState) => Promise<void>;
}): Promise<void> {
  const streamResult = input.streamDone.then(
    () => ({ kind: 'stream' as const, ok: true as const }),
    (err) => ({ kind: 'stream' as const, ok: false as const, err }),
  );
  const renderResult = input.renderDone.then(
    (state) => ({ kind: 'render' as const, ok: true as const, state }),
    (err) => ({ kind: 'render' as const, ok: false as const, err }),
  );
  const first = await Promise.race([streamResult, renderResult]);
  if (!first.ok) {
    if (first.kind === 'stream') {
      log.fail('stream', first.err, { mode: input.mode, step: 'stream' });
      const rendered = await renderResult;
      if (!rendered.ok) throw rendered.err;
      await runFallbackReply(input.mode, rendered.state, input.fallback);
      return;
    }
    throw first.err;
  }

  if (first.kind === 'stream') {
    const rendered = await renderResult;
    if (!rendered.ok) throw rendered.err;
    return;
  }

  if (!input.producerStarted()) {
    log.warn('stream', 'producer-not-started-before-agent-terminal', { mode: input.mode });
    await runFallbackReply(input.mode, first.state, input.fallback);
    return;
  }

  const terminal = await Promise.race([
    streamResult,
    delay(STREAM_TERMINAL_GRACE_MS).then(() => undefined),
  ]);
  if (!terminal) {
    log.warn('stream', 'terminal-grace-expired', {
      mode: input.mode,
      graceMs: STREAM_TERMINAL_GRACE_MS,
    });
    void streamResult.then((result) => {
      if (!result.ok) {
        log.fail('stream', result.err, { mode: input.mode, step: 'stream-terminal-late' });
      }
    });
    return;
  }
  if (!terminal.ok) {
    log.fail('stream', terminal.err, { mode: input.mode, step: 'stream-terminal' });
    await runFallbackReply(input.mode, first.state, input.fallback);
  }
}

async function runFallbackReply(
  mode: 'card' | 'markdown',
  state: RunState,
  fallback: (state: RunState) => Promise<void>,
): Promise<void> {
  try {
    await fallback(state);
  } catch (err) {
    log.fail('stream', err, { mode, step: 'fallback' });
  }
}

function scheduleWorkingReactionCleanup(
  channel: LarkChannel,
  messageId: string,
  reactionPromise: Promise<string | undefined> | undefined,
): void {
  if (!reactionPromise) return;

  void (async () => {
    const reactionResult = reactionPromise.then(
      (reactionId) => ({ ok: true as const, reactionId }),
      (err) => ({ ok: false as const, err }),
    );
    const settled = await Promise.race([
      reactionResult,
      delay(REACTION_CLEANUP_GRACE_MS).then(() => undefined),
    ]);

    if (!settled) {
      log.warn('reaction', 'cleanup-deferred', {
        messageId,
        graceMs: REACTION_CLEANUP_GRACE_MS,
      });
      void reactionResult.then((result) => {
        if (!result.ok || !result.reactionId) return;
        void removeReaction(channel, messageId, result.reactionId);
      });
      return;
    }

    if (!settled.ok || !settled.reactionId) return;
    await removeReaction(channel, messageId, settled.reactionId);
  })();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPrompt(
  batch: NormalizedMessage[],
  attachments: LocalAttachment[],
  quotes: QuotedContext[] = [],
  topicContext: QuotedContext[] = [],
  botIdentity?: { openId: string; name?: string },
): string {
  const first = batch[0];
  if (!first) return '';

  const fileKeys = batch.flatMap((m) => m.resources.map((r) => r.fileKey));
  // When the debounce window merged messages (possibly from several senders —
  // common in bot-at-bot group chats), annotate each segment with its sender
  // so the agent can tell who said what. Single-message batches stay verbatim.
  const annotate = batch.length > 1;
  const texts = batch
    .map((m) => {
      const text = stripAttachmentRefs(m.content, fileKeys).trim();
      if (!text) return '';
      return annotate ? `${senderAnnotation(m)} ${text}` : text;
    })
    .filter(Boolean);
  const userPart =
    texts.length > 0
      ? texts.join('\n\n')
      : attachments.length > 0
        ? '请看下面的附件。'
        : '（对方发来一条没有正文的消息——通常是只 @ 了你的唤醒（ping）。请简短回应。）';

  const senderType = senderTypeOf(first);
  const mentions = mergeMentions(batch);

  return buildAgentPrompt({
    context: {
      chatId: first.chatId,
      chatType: first.chatType,
      senderId: first.senderId,
      ...(first.senderName ? { senderName: first.senderName } : {}),
      ...(senderType ? { senderType } : {}),
      ...(botIdentity?.openId ? { botOpenId: botIdentity.openId } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(first.threadId ? { threadId: first.threadId } : {}),
      messageIds: batch.map((m) => m.messageId),
      source: 'im',
    },
    instructions: BRIDGE_AGENT_INSTRUCTIONS,
    userInput: userPart,
    ...(topicContext.length > 0
      ? { topicContext: topicContext.map(toPromptTopicMessage) }
      : {}),
    quotedMessages: quotes.map(toPromptQuote),
    interactiveCards: batch.map(toPromptInteractiveCard).filter(isDefined),
    attachments: attachments.map(toPromptAttachment),
  });
}

function toPromptTopicMessage(context: QuotedContext): BridgePromptTopicMessage {
  return {
    messageId: context.messageId,
    senderId: context.senderId,
    ...(context.senderName ? { senderName: context.senderName } : {}),
    ...(context.senderType ? { senderType: context.senderType } : {}),
    ...(context.createdAt ? { createdAt: context.createdAt } : {}),
    rawContentType: context.rawContentType,
    content: context.content,
  };
}

/**
 * Classify the sender as human or bot from the raw Feishu event
 * (`sender.sender_type`: 'user' = human, 'app' = bot). The normalizer drops
 * this field, so read it off `msg.raw` (`includeRawEvent: true` above).
 * Unknown / missing values return undefined — omit rather than guess.
 */
function senderTypeOf(msg: NormalizedMessage): 'user' | 'bot' | undefined {
  const raw = msg.raw as { sender?: { sender_type?: unknown } } | undefined;
  const senderType = raw?.sender?.sender_type;
  if (senderType === 'user') return 'user';
  if (senderType === 'app' || senderType === 'bot') return 'bot';
  return undefined;
}

function senderAnnotation(msg: NormalizedMessage): string {
  const name = msg.senderName ?? msg.senderId;
  const type = senderTypeOf(msg);
  return type ? `[${name} (${type})]:` : `[${name}]:`;
}

function mergeMentions(batch: NormalizedMessage[]): BridgePromptMention[] {
  const seen = new Set<string>();
  const out: BridgePromptMention[] = [];
  for (const msg of batch) {
    for (const mention of msg.mentions ?? []) {
      const dedupeKey = mention.openId ?? `${mention.name ?? ''}:${mention.key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({
        ...(mention.openId ? { openId: mention.openId } : {}),
        ...(mention.name ? { name: mention.name } : {}),
        ...(mention.isBot !== undefined ? { isBot: mention.isBot } : {}),
      });
    }
  }
  return out;
}

function replyQuoteTargetForMessage(
  msg: NormalizedMessage,
  mode: ChatMode,
): string | undefined {
  const replyTo = msg.replyToMessageId;
  if (!replyTo) return undefined;

  // Feishu topic messages use root_id/parent_id as the topic root anchor even
  // for ordinary in-topic messages. Treat that as structure, not a quote.
  if (mode === 'topic' && msg.threadId && msg.rootId && replyTo === msg.rootId) {
    return undefined;
  }
  return replyTo;
}

function stripAttachmentRefs(text: string, fileKeys: string[]): string {
  if (!text || fileKeys.length === 0) return text;
  let out = text;
  for (const key of fileKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`!?\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
    out = out.replace(
      new RegExp(
        `<\\s*(?:file|image|img|audio|video|media|folder)\\b[^>]*\\bkey\\s*=\\s*["']${escaped}["'][^>]*>`,
        'gi',
      ),
      '',
    );
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

function toPromptQuote(q: QuotedContext): BridgePromptQuotedMessage {
  return {
    messageId: q.messageId,
    senderId: q.senderId,
    ...(q.senderName ? { senderName: q.senderName } : {}),
    ...(q.createdAt ? { createdAt: q.createdAt } : {}),
    rawContentType: q.rawContentType,
    content: q.content,
  };
}

function toPromptInteractiveCard(m: NormalizedMessage): BridgePromptInteractiveCard | undefined {
  if (m.rawContentType !== 'interactive') return undefined;
  const rawContent = (m.raw as { message?: { content?: unknown } } | undefined)
    ?.message?.content;
  if (typeof rawContent !== 'string' || rawContent.length === 0) return undefined;
  return {
    messageId: m.messageId,
    content: parseJsonOrRaw(rawContent),
  };
}

function parseJsonOrRaw(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
