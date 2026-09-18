import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { AgentAdapter } from '../agent/types';
import type { ActiveRuns } from '../bot/active-runs';
import type { ChatMode, ChatModeCache } from '../bot/chat-mode-cache';
import type { AccessDecision } from '../policy/access';
import type { InboundJournal } from '../bot/inbound-journal';
import { recoveryMessageFrom } from '../bot/inbound-journal';
import type { PendingQueue } from '../bot/pending-queue';
import type { ProcessPool } from '../bot/process-pool';
import type { CallbackAuth } from './callback-auth';
import { runCommandHandler, type CommandContext, type Controls } from '../commands';
import { log } from '../core/logger';
import { canUseDm, canUseGroup, canRunAdminCommand } from '../policy/access';
import { commandSessionCatalogIdentity } from '../bot/session-catalog-identity';
import type { RunExecutor } from '../runtime/run-executor';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { ThinkingHistoryStore } from '../session/thinking-history';
import type { WorkspaceStore } from '../workspace/store';
import { lookupMessageThreadId } from '../bot/thread-id';

/** Marker key on a button's value object that flags the cardAction as
 * a callback that should be forwarded back to the agent instead
 * of dispatched to a built-in command handler. The double-underscore
 * sigils make it virtually impossible to collide with normal payload
 * fields the agent might set.
 */
const BRIDGE_CALLBACK_MARKER = '__bridge_cb';
/** Recovery-card actions must be used within this window after acceptance. */
const RECOVERY_ACTION_TTL_MS = 24 * 60 * 60 * 1000;
const LEGACY_CLAUDE_CALLBACK_MARKER = '__claude_cb';

export interface CardDispatchDeps {
  channel: LarkChannel;
  evt: CardActionEvent;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  thinkingHistory?: ThinkingHistoryStore;
  inboundJournal?: InboundJournal;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: AgentAdapter;
  processPool?: ProcessPool;
  runExecutor?: RunExecutor;
  controls: Controls;
  pending: PendingQueue;
  chatModeCache: ChatModeCache;
  callbackAuth?: CallbackAuth;
  callbackPolicyFingerprint?: string;
  callbackPolicyFingerprintForScope?: (scope: string) => string | undefined;
}

export async function handleCardAction(deps: CardDispatchDeps): Promise<void> {
  const value = deps.evt.action.value;
  if (!value || typeof value !== 'object') return;
  const payload = value as Record<string, unknown>;

  const operatorId = deps.evt.operator.openId;
  const chatId = deps.evt.chatId;

  // CardKit 2.0 form submits drop user-input values from action.value; they
  // arrive on raw.action.form_value. The SDK forwards the raw event when
  // includeRawEvent: true is set on the channel options.
  const raw = (deps.evt as CardActionEvent & { raw?: unknown }).raw as
    | { action?: { form_value?: Record<string, unknown> } }
    | undefined;
  const formValue = raw?.action?.form_value;

  // Resolve the click's session scope. For topic groups we need to know
  // the message's thread_id so the action targets the right topic's
  // session — look up the carrier message (the card lives on it) once.
  // Done before the access check so we know the chat mode (p2p vs group)
  // and can skip the chat allowlist for DMs.
  const { scope, threadId, mode } = await resolveScope(deps);

  const accessDecision =
    mode === 'p2p'
      ? canUseDm(deps.controls.profileConfig, deps.controls, operatorId)
      : canUseGroup(deps.controls.profileConfig, deps.controls, chatId, operatorId);
  if (!accessDecision.ok) {
    log.info('cardAction', 'skip-not-allowed-user', {
      operator: operatorId.slice(-6),
      reason: accessDecision.reason,
    });
    return;
  }

  if (LEGACY_CLAUDE_CALLBACK_MARKER in payload) {
    log.info('cardAction', 'skip-legacy-callback-marker', { scope });
    return;
  }

  const cmd = typeof payload.cmd === 'string' ? payload.cmd : '';
  if (cmd) {
    // Recovery-card actions (OPT-04) need the pending queue, which command
    // handlers don't hold — handle them right here. Unsigned like other
    // built-in command buttons; chat/user access was already enforced above.
    if (
      cmd === 'inbound.redo' ||
      cmd === 'inbound.continue' ||
      cmd === 'inbound.dismiss'
    ) {
      const messageId = typeof payload.arg === 'string' ? payload.arg : '';
      await handleInboundRecoveryAction(deps, {
        scope,
        chatId,
        threadId,
        mode,
        msg: makeFakeMsg(deps.evt, threadId),
        access: accessDecision,
        cmd,
        messageId,
      });
      return;
    }
    if (isSignedBridgeCallback(payload) && !verifyBridgeToken(deps, payload, scope, cmd)) {
      return;
    }
    log.info('cardAction', 'cmd', { cmd, scope });
    const msg = makeFakeMsg(deps.evt, threadId);

    const ctx: CommandContext = {
      channel: deps.channel,
      msg,
      scope,
      chatMode: mode,
      sessions: deps.sessions,
      sessionCatalog: deps.sessionCatalog,
      thinkingHistory: deps.thinkingHistory,
      inboundJournal: deps.inboundJournal,
      sessionCatalogIdentity: await commandSessionCatalogIdentity({
        msg,
        scope,
        mode,
        workspaces: deps.workspaces,
        controls: deps.controls,
        access: accessDecision,
      }),
      workspaces: deps.workspaces,
      activeRuns: deps.activeRuns,
      agent: deps.agent,
      processPool: deps.processPool,
      runExecutor: deps.runExecutor,
      controls: deps.controls,
      formValue,
      fromCardAction: true,
    };

    const [name, ...rest] = cmd.split('.');
    const sub = rest.join(' ');
    const args = composeArgs(sub, payload);

    try {
      const ok = await runCommandHandler(name ?? '', args, ctx);
      if (!ok) log.warn('cardAction', 'unknown', { cmd });
    } catch (err) {
      log.fail('cardAction', err, { cmd });
    }
    return;
  }

  // Agent-driven callback: the button was rendered by an agent via lark-cli,
  // with `__bridge_cb` set on the value. Forward the click back into the
  // scope's pending queue so the agent resumes its session and sees the click
  // as a follow-up message, with full context of what it sent.
  if (BRIDGE_CALLBACK_MARKER in payload) {
    if (!verifyBridgeToken(deps, payload, scope, 'agent_callback')) return;
    forwardToAgent(deps, payload, formValue, scope, threadId, mode);
    return;
  }

  return;
}

/** Continuation prompt sent by 继续对话 — bridge-generated wrapper, clearly marked. */
function continuationPrompt(content: string): string {
  return [
    '【恢复】上次运行被中断，执行结果未知。',
    '请先检查工作区中的已有进度（已修改的文件、未完成的步骤），从中断处继续完成任务，不要重复已完成的工作。',
    '',
    `原任务：${content}`,
  ].join('\n');
}

/**
 * Recovery-card button actions (OPT-04 分片 4):
 * - `inbound.continue`（继续对话）: keep the session, dispatch a continuation
 *   prompt so the agent inspects progress and picks up where things stand.
 * - `inbound.redo`: uncertain → reset the scope session (archive the catalog
 *   entry + clear the session store, same as /new) and re-dispatch the
 *   original task from scratch; expired (never dispatched) → just dispatch
 *   the original content into the current session, no reset.
 * - `inbound.dismiss`: settle without running.
 *
 * Authorization: only the record's original sender or a profile admin may
 * act — another group member must not be able to re-run (or reset the
 * session for) someone else's task. The re-dispatched message carries the
 * real clicker's identity so dispatch-time policy checks evaluate the
 * actual actor. Actions expire 24h after acceptance; all are idempotent.
 */
async function handleInboundRecoveryAction(
  deps: CardDispatchDeps,
  input: {
    scope: string;
    chatId: string;
    threadId: string | undefined;
    mode: ChatMode;
    msg: NormalizedMessage;
    access: AccessDecision;
    cmd: string;
    messageId: string;
  },
): Promise<void> {
  const journal = deps.inboundJournal;
  const send = (markdown: string): void => {
    void deps.channel.send(input.chatId, { markdown }).catch((err) => log.fail('inbound', err));
  };
  if (!journal || !input.messageId) {
    send('恢复记录不可用（journal 未启用或缺少消息 id）。');
    return;
  }
  const record = journal.getRecord(input.scope, input.messageId);
  if (!record || (record.status !== 'uncertain' && record.status !== 'expired')) {
    send('该恢复记录已处理过。');
    return;
  }

  const clicker = input.msg.senderId;
  const isOwnerOrAdmin =
    record.senderId === clicker ||
    canRunAdminCommand(deps.controls.profileConfig, deps.controls, clicker).ok;
  if (!isOwnerOrAdmin) {
    log.warn('inbound', 'recovery-denied-not-owner', {
      scope: input.scope,
      messageId: input.messageId,
      owner: record.senderId.slice(-6),
      clicker: clicker.slice(-6),
    });
    send('仅原任务所有者或管理员可操作该恢复卡。');
    return;
  }
  if (Date.now() - record.acceptedAt > RECOVERY_ACTION_TTL_MS) {
    send('该恢复卡已超过 24 小时操作时限，请直接重新发送任务。');
    return;
  }

  if (input.cmd === 'inbound.dismiss') {
    await journal.markDismissed(input.scope, input.messageId);
    log.info('inbound', 'recovery-dismiss', { scope: input.scope, messageId: input.messageId });
    send('✓ 已忽略该恢复记录。');
    return;
  }

  const dispatch = async (content: string): Promise<void> => {
    const newId = await journal.redo(input.scope, input.messageId, {
      contentOverride: content,
      senderId: clicker,
    });
    if (!newId) {
      send('该恢复记录已处理过。');
      return;
    }
    const m = recoveryMessageFrom(record, newId);
    const synthetic: NormalizedMessage = {
      messageId: m.messageId,
      chatId: m.chatId,
      chatType: m.chatType === 'p2p' ? 'p2p' : 'group',
      ...(m.threadId ? { threadId: m.threadId } : {}),
      // Real clicker identity — dispatch-time policy checks must evaluate
      // the actual actor, never the original record's sender.
      senderId: clicker,
      senderName: undefined,
      content,
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: Date.now(),
    } as unknown as NormalizedMessage;
    deps.pending.push(input.scope, synthetic);
    log.info('inbound', 'recovery-redo', {
      scope: input.scope,
      messageId: input.messageId,
      newMessageId: newId,
      action: input.cmd,
    });
  };

  if (input.cmd === 'inbound.continue') {
    // 继续对话: keep the session. For an expired record (never dispatched)
    // there is nothing to continue — degrade to a plain dispatch.
    const content =
      record.status === 'uncertain' ? continuationPrompt(record.content) : record.content;
    await dispatch(content);
    send(
      record.status === 'uncertain'
        ? '💬 已在原会话提交继续请求，agent 会先检查进度再接着做。'
        : '▶️ 该记录未曾执行，已直接提交执行。',
    );
    return;
  }

  // inbound.redo
  if (record.status === 'uncertain') {
    // Full redo: reset the scope session (catalog entry + session store,
    // same as /new) so the re-run cannot resume the interrupted context.
    const identity = await commandSessionCatalogIdentity({
      msg: input.msg,
      scope: input.scope,
      mode: input.mode,
      workspaces: deps.workspaces,
      controls: deps.controls,
      access: input.access,
    });
    if (identity) {
      deps.sessionCatalog?.archiveActive({ ...identity, now: Date.now() });
    }
    deps.sessions.clear(input.scope);
    await dispatch(record.content);
    send('♻️ 已重置会话并重新提交完整任务，后续消息将在新会话中处理。');
    return;
  }

  // expired: nothing ever ran — plain dispatch into the current session.
  await dispatch(record.content);
  send('▶️ 已按原内容提交执行。');
}

async function resolveScope(
  deps: CardDispatchDeps,
): Promise<{ scope: string; threadId: string | undefined; mode: 'p2p' | 'group' | 'topic' }> {  const chatId = deps.evt.chatId;
  const mode = await deps.chatModeCache.resolve(deps.channel, chatId);
  if (mode !== 'topic') {
    return { scope: chatId, threadId: undefined, mode };
  }
  // Topic group — need the carrier message's thread_id to compose scope.
  // One API call per click; could cache by messageId if it ever becomes hot.
  const threadId = await lookupMessageThreadId(deps.channel, deps.evt.messageId);
  if (!threadId) {
    // Fall back to plain chatId. Better to land in the chat's "default"
    // scope than fail the click silently.
    return { scope: chatId, threadId: undefined, mode };
  }
  return { scope: `${chatId}:${threadId}`, threadId, mode };
}

function forwardToAgent(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  formValue: Record<string, unknown> | undefined,
  scope: string,
  threadId: string | undefined,
  mode: 'p2p' | 'group' | 'topic',
): void {
  // Strip the marker so the agent only sees the meaningful fields it set.
  const {
    [BRIDGE_CALLBACK_MARKER]: _marker,
    bridge_token: _token,
    ...agentPayload
  } = payload;
  const merged = formValue ? { ...agentPayload, form_value: formValue } : agentPayload;
  log.info('cardAction', 'forward-agent', {
    scope,
    payload: JSON.stringify(merged).slice(0, 200),
  });
  const synthetic: NormalizedMessage = {
    messageId: deps.evt.messageId,
    chatId: deps.evt.chatId,
    chatType: mode === 'p2p' ? 'p2p' : 'group',
    threadId,
    senderId: deps.evt.operator.openId,
    senderName: deps.evt.operator.name,
    content: `[card-click] ${JSON.stringify(merged)}`,
    rawContentType: 'card_action',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
  deps.pending.push(scope, synthetic);
}

function verifyBridgeToken(
  deps: CardDispatchDeps,
  payload: Record<string, unknown>,
  scope: string,
  action: string,
): boolean {
  const token = typeof payload.bridge_token === 'string' ? payload.bridge_token : '';
  const active = deps.activeRuns.get(scope);
  if (!deps.callbackAuth || !token || !active) {
    log.info('cardAction', 'skip-callback-auth-missing', { scope, action });
    log.warn('callback', 'denied', { scope, action, reason: 'missing-token-or-run' });
    return false;
  }
  const result = deps.callbackAuth.verify(token, {
    runId: active.run.runId,
    scope,
    chatId: deps.evt.chatId,
    operatorOpenId: deps.evt.operator.openId,
    action,
    policyFingerprint:
      deps.callbackPolicyFingerprintForScope?.(scope) ??
      deps.callbackPolicyFingerprint ??
      '',
  });
  if (!result.ok) {
    log.info('cardAction', 'skip-callback-auth-failed', {
      scope,
      action,
      reason: result.reason,
    });
    log.warn('callback', 'denied', { scope, action, reason: result.reason });
    return false;
  }
  return true;
}

function isSignedBridgeCallback(payload: Record<string, unknown>): boolean {
  return BRIDGE_CALLBACK_MARKER in payload || typeof payload.bridge_token === 'string';
}

/** Turn a button payload like {cmd:'ws.use', name:'proj-a'} into the arg
 * string the text-command handler expects: 'use proj-a'. Accepts `arg`
 * (preferred, generic) or `name` (legacy ws cards). */
function composeArgs(sub: string, payload: Record<string, unknown>): string {
  if (!sub) return '';
  const arg =
    (typeof payload.arg === 'string' && payload.arg) ||
    (typeof payload.name === 'string' && payload.name) ||
    '';
  return arg ? `${sub} ${arg}` : sub;
}

function makeFakeMsg(
  evt: CardActionEvent,
  threadId: string | undefined,
): NormalizedMessage {
  return {
    messageId: evt.messageId,
    chatId: evt.chatId,
    chatType: 'p2p',
    threadId,
    senderId: evt.operator.openId,
    senderName: evt.operator.name,
    content: '',
    rawContentType: 'interactive',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}
