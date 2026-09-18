import type { CardActionEvent } from '@larksuite/channel';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { InboundJournal } from '../../../src/bot/inbound-journal.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { CallbackAuth } from '../../../src/card/callback-auth.js';
import { CallbackNonceStore } from '../../../src/card/callback-store.js';
import { handleCardAction } from '../../../src/card/dispatcher.js';
import type { Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeAgentRun } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('signed card callback dispatch', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('runs built-in command callbacks only when the bridge token verifies', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: h.token('stop'),
    });

    expect(activeRun.stopped).toBe(true);

    const deniedRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', deniedRun);
    await h.dispatch({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: h.token('stop', { operatorOpenId: 'ou_other' }),
    });

    expect(deniedRun.stopped).toBe(false);
  });

  it('forwards signed bridge callbacks without leaking auth fields into the agent payload', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' });
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch(
      {
        __bridge_cb: true,
        bridge_token: h.token('agent_callback', { nonce: 'nonce-agent' }),
        choice: 'a',
      },
      { note: 'from form' },
    );

    const queued = h.pending.cancel('oc_group');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('[card-click] {"choice":"a","form_value":{"note":"from form"}}');
    expect(queued[0]?.chatType).toBe('group');
  });

  it('drops legacy Claude callback markers before command dispatch', async () => {
    const h = await createHarness();
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      __claude_cb: true,
      cmd: 'stop',
    });

    expect(activeRun.stopped).toBe(false);
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
  });

  it('scopes topic-group callbacks by the carrier message thread_id', async () => {
    const h = await createHarness({ chatMode: 'topic' });
    // The dispatcher must read items[0].thread_id from the raw message get to
    // compose the `${chatId}:${threadId}` scope. A regression here (e.g. using
    // channel.fetchMessage, whose normalized shape drops thread_id) would fall
    // back to the bare chatId and route the click into the wrong session.
    h.channel.rawThreadIds.set('om_card', 'th_topic');
    h.activeRuns.register('oc_group:th_topic', h.agent.run({ runId: 'run-active', prompt: 'running' }));

    await h.dispatch({
      __bridge_cb: true,
      bridge_token: h.token('agent_callback', { nonce: 'nonce-topic', scope: 'oc_group:th_topic' }),
      choice: 'a',
    });

    expect(h.pending.cancel('oc_group')).toHaveLength(0);
    const queued = h.pending.cancel('oc_group:th_topic');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('[card-click] {"choice":"a"}');
  });

  it('rejects bridge callbacks when callback auth is unavailable', async () => {
    const h = await createHarness({ callbackAuth: false });
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('oc_group', activeRun);

    await h.dispatch({
      __bridge_cb: true,
      choice: 'unsafe',
    });

    expect(activeRun.stopped).toBe(false);
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
  });
});


// ─── OPT-04 分片 4: recovery card actions ───────────────────────────────────

async function seedUncertain(h: Harness): Promise<void> {
  await h.journal.recordAccepted({
    messageId: 'om_side_effect',
    scope: 'oc_group',
    chatId: 'oc_group',
    senderId: 'ou_alice',
    content: 'possibly deployed task',
    acceptedAt: Date.now(),
    chatType: 'group',
  });
  await h.journal.markClaimed('oc_group', ['om_side_effect'], 'run-lost');
  await h.journal.recoverOnStartup(); // claimed → uncertain
}

describe('recovery card actions (inbound.redo / inbound.dismiss)', () => {
  it('redo settles the record and re-dispatches the content through the pending queue', async () => {
    const h = await createHarness();
    await seedUncertain(h);

    await h.dispatch({ cmd: 'inbound.redo', arg: 'om_side_effect' }, undefined, 'ou_alice');

    // Old record settled, fresh queued record created.
    const old = h.journal.getRecord('oc_group', 'om_side_effect');
    expect(old?.status).toBe('terminal');
    expect(old?.terminalState).toBe('redone');
    const queued = h.pending.cancel('oc_group');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('possibly deployed task');
    // The re-dispatch belongs to the real clicker, not the original sender.
    expect(queued[0]?.senderId).toBe('ou_alice');
    const newRecord = h.journal.list('oc_group').find((r) => r.messageId === queued[0]?.messageId);
    expect(newRecord?.status).toBe('queued');
    expect(newRecord?.senderId).toBe('ou_alice');
  });

  it('a second redo click is a no-op (record already settled)', async () => {
    const h = await createHarness();
    await seedUncertain(h);
    await h.dispatch({ cmd: 'inbound.redo', arg: 'om_side_effect' }, undefined, 'ou_alice');
    expect(h.pending.cancel('oc_group')).toHaveLength(1);

    await h.dispatch({ cmd: 'inbound.redo', arg: 'om_side_effect' });
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
    // A replied hint is sent instead.
    expect(JSON.stringify(h.channel.sent)).toContain('已处理过');
  });

  it('dismiss settles the record without dispatching a run', async () => {
    const h = await createHarness();
    await seedUncertain(h);

    await h.dispatch({ cmd: 'inbound.dismiss', arg: 'om_side_effect' }, undefined, 'ou_alice');

    expect(h.journal.getRecord('oc_group', 'om_side_effect')?.terminalState).toBe('dismissed');
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
    expect(JSON.stringify(h.channel.sent)).toContain('已忽略');
  });

  it('unknown or missing journal targets answer without throwing', async () => {
    const h = await createHarness();
    await h.dispatch({ cmd: 'inbound.redo', arg: 'om_unknown' });
    expect(JSON.stringify(h.channel.sent)).toContain('已处理过');
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
  });
});


describe('recovery card 继续对话 vs 重头重做 split', () => {
  async function seedWithSession(h: Harness): Promise<void> {
    await h.journal.recordAccepted({
      messageId: 'om_unc',
      scope: 'oc_group',
      chatId: 'oc_group',
      senderId: 'ou_operator',
      content: 'original task text',
      acceptedAt: Date.now(),
      chatType: 'group',
    });
    await h.journal.markClaimed('oc_group', ['om_unc'], 'run-lost');
    await h.journal.recoverOnStartup();
    // A resumable session exists before the recovery action.
    h.sessions.set('oc_group', 'sess-live', 'C:/cwd');
  }

  it('继续对话 keeps the session and dispatches a continuation prompt', async () => {
    const h = await createHarness();
    await seedWithSession(h);

    await h.dispatch({ cmd: 'inbound.continue', arg: 'om_unc' });

    const queued = h.pending.cancel('oc_group');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toContain('【恢复】');
    expect(queued[0]?.content).toContain('original task text');
    // Session is preserved.
    expect(h.sessions.getRaw('oc_group')?.sessionId).toBe('sess-live');
    const old = h.journal.getRecord('oc_group', 'om_unc');
    expect(old?.terminalState).toBe('redone');
    // P2 regression: the success wording must follow the ORIGINAL status
    // (journal.redo mutates record.status in place before it is read).
    expect(JSON.stringify(h.channel.sent)).toContain('已在原会话');
    expect(JSON.stringify(h.channel.sent)).not.toContain('未曾执行');
  });

  it('重头重做 journals a resetSession intent instead of resetting in the click handler', async () => {
    const h = await createHarness();
    await seedWithSession(h);

    await h.dispatch({ cmd: 'inbound.redo', arg: 'om_unc' });

    const queued = h.pending.cancel('oc_group');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('original task text');
    // The reset rides on the journaled re-run record and executes in
    // runAgentBatch BEFORE resume resolution and claim — the dispatcher
    // side must not touch the session (that raced the debounce window).
    const rec = h.journal.getRecord('oc_group', queued[0]!.messageId);
    expect(rec?.resetSession).toBe(true);
    expect(h.sessions.getRaw('oc_group')?.sessionId).toBe('sess-live');
  });

  it('expired record: redo dispatches plainly without touching the session', async () => {
    const h = await createHarness();
    await h.journal.recordAccepted({
      messageId: 'om_old',
      scope: 'oc_group',
      chatId: 'oc_group',
      senderId: 'ou_operator',
      content: 'never dispatched task',
      acceptedAt: Date.now() - 60 * 60_000,
      chatType: 'group',
    });
    await h.journal.recoverOnStartup(); // → expired
    h.sessions.set('oc_group', 'sess-keep', 'C:/cwd');

    await h.dispatch({ cmd: 'inbound.redo', arg: 'om_old' });

    const queued = h.pending.cancel('oc_group');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('never dispatched task');
    expect(h.journal.getRecord('oc_group', queued[0]!.messageId)?.resetSession).toBeUndefined();
    expect(h.sessions.getRaw('oc_group')?.sessionId).toBe('sess-keep');
  });

  it('continue on an expired record degrades to a plain dispatch', async () => {
    const h = await createHarness();
    await h.journal.recordAccepted({
      messageId: 'om_old2',
      scope: 'oc_group',
      chatId: 'oc_group',
      senderId: 'ou_operator',
      content: 'never started task',
      acceptedAt: Date.now() - 60 * 60_000,
      chatType: 'group',
    });
    await h.journal.recoverOnStartup();

    await h.dispatch({ cmd: 'inbound.continue', arg: 'om_old2' });

    const queued = h.pending.cancel('oc_group');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe('never started task');
    expect(JSON.stringify(h.channel.sent)).toContain('未曾执行');
  });
});


describe('recovery card operator binding (评审修复)', () => {
  it('denies a click from a user who is neither the owner nor an admin', async () => {
    const h = await createHarness();
    await seedUncertain(h);

    await h.dispatch({ cmd: 'inbound.redo', arg: 'om_side_effect' }, undefined, 'ou_operator');

    expect(h.pending.cancel('oc_group')).toHaveLength(0);
    expect(JSON.stringify(h.channel.sent)).toContain('仅原任务所有者或管理员');
    expect(h.journal.getRecord('oc_group', 'om_side_effect')?.status).toBe('uncertain');
  });

  it('allows an admin who is not the owner, using the admin as the actor', async () => {
    const h = await createHarness();
    await seedUncertain(h);

    await h.dispatch({ cmd: 'inbound.redo', arg: 'om_side_effect' }, undefined, 'ou_admin');

    const queued = h.pending.cancel('oc_group');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.senderId).toBe('ou_admin');
  });

  it('ignores actions on records past the 24h action window', async () => {
    const h = await createHarness();
    await seedUncertain(h);
    // Backdate the record beyond the action TTL.
    const rec = h.journal.getRecord('oc_group', 'om_side_effect');
    if (rec) rec.acceptedAt = Date.now() - 25 * 60 * 60 * 1000;

    await h.dispatch({ cmd: 'inbound.redo', arg: 'om_side_effect' }, undefined, 'ou_alice');

    expect(h.pending.cancel('oc_group')).toHaveLength(0);
    expect(JSON.stringify(h.channel.sent)).toContain('24 小时');
  });
});

type Harness = {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: FakeAgentAdapter;
  controls: Controls;
  pending: PendingQueue;
  auth: CallbackAuth;
  journal: InboundJournal;
  dispatch(
    value: Record<string, unknown>,
    formValue?: Record<string, unknown>,
    operatorOpenId?: string,
  ): Promise<void>;
  token(
    action: string,
    overrides?: { operatorOpenId?: string; nonce?: string; scope?: string },
  ): string;
};

async function createHarness(
  opts: { callbackAuth?: boolean; chatMode?: 'p2p' | 'group' | 'topic' } = {},
): Promise<Harness> {
  const tmp = await createTmpProfile('callback-dispatch-test-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const activeRuns = new ActiveRuns();
  const agent = new FakeAgentAdapter();
  const pending = new PendingQueue(60_000, () => {});
  const journal = new InboundJournal(`${tmp.profile}/inbound`);
  const store = new CallbackNonceStore(`${tmp.profile}/callback-nonces.json`);
  const controls = {
    profile: 'claude',
    profileConfig: createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
      access: { allowedChats: ['oc_group'], admins: ['ou_admin'] },
    }),
    botOwnerId: 'ou_owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: `${tmp.profile}/config.json`,
    cfg: createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
      access: { allowedChats: ['oc_group'], admins: ['ou_admin'] },
    }),
    processId: 'proc-1',
  } satisfies Controls;
  let nonce = 'nonce-stop';
  const auth = new CallbackAuth({
    keys: [{ version: 1, secret: 'secret-1' }],
    nonceStore: store,
    now: () => 1000,
    createNonce: () => nonce,
  });
  const chatModeCache = {
    resolve: async () => opts.chatMode ?? 'group',
  } as unknown as ChatModeCache;
  cleanups.push(async () => {
    pending.cancelAll();
    await Promise.all([sessions.flush(), workspaces.flush(), store.flush(), journal.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    channel,
    sessions,
    workspaces,
    activeRuns,
    agent,
    controls,
    pending,
    auth,
    journal,
    token: (action, overrides = {}) => {
      nonce = overrides.nonce ?? `nonce-${action}`;
      return auth.sign({
        runId: 'run-active',
        scope: overrides.scope ?? 'oc_group',
        chatId: 'oc_group',
        operatorOpenId: overrides.operatorOpenId ?? 'ou_operator',
        action,
        policyFingerprint: 'fp-1',
        ttlMs: 60_000,
      });
    },
    dispatch: (value, formValue, operatorOpenId) =>
      handleCardAction({
        channel: channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
        evt: cardEvent(value, formValue, operatorOpenId),
        sessions,
        workspaces,
        activeRuns,
        agent,
        controls,
        pending,
        chatModeCache,
        inboundJournal: journal,
        ...(opts.callbackAuth === false ? {} : { callbackAuth: auth }),
        callbackPolicyFingerprint: 'fp-1',
      }),
  };
}

function cardEvent(
  value: Record<string, unknown>,
  formValue?: Record<string, unknown>,
  operatorOpenId?: string,
): CardActionEvent {
  return {
    action: { value },
    chatId: 'oc_group',
    messageId: 'om_card',
    operator: {
      openId: operatorOpenId ?? 'ou_operator',
      name: 'Operator',
    },
    raw: formValue ? { action: { form_value: formValue } } : undefined,
  } as unknown as CardActionEvent;
}

describe('恢复卡持久化失败路径（评审三轮）', () => {
  async function seedAndBreak(h: Harness): Promise<void> {
    await seedUncertain(h);
    // Break the journal dir AFTER seeding: in-memory record survives, disk fails.
    const inDir = join(h.tmp.profile, 'inbound');
    const { rm, writeFile } = await import('node:fs/promises');
    await rm(inDir, { recursive: true, force: true });
    await writeFile(inDir, 'occupied', 'utf8');
  }

  it('redo with a failing journal does NOT reset the session and asks to retry', async () => {
    const h = await createHarness();
    await h.journal.recordAccepted({
      messageId: 'om_unc',
      scope: 'oc_group',
      chatId: 'oc_group',
      senderId: 'ou_alice',
      content: 'original task text',
      acceptedAt: Date.now(),
      chatType: 'group',
    });
    await h.journal.markClaimed('oc_group', ['om_unc'], 'run-lost');
    await h.journal.recoverOnStartup();
    h.sessions.set('oc_group', 'sess-live', 'C:/cwd');
    await seedAndBreak(h);

    await h.dispatch({ cmd: 'inbound.redo', arg: 'om_unc' }, undefined, 'ou_alice');

    // Old session untouched — a failed write must not destroy it.
    expect(h.sessions.getRaw('oc_group')?.sessionId).toBe('sess-live');
    expect(h.pending.cancel('oc_group')).toHaveLength(0);
    expect(JSON.stringify(h.channel.sent)).toContain('暂时无法写入');
  });

  it('dismiss with a failing journal asks to retry instead of claiming success', async () => {
    const h = await createHarness();
    await seedUncertain(h);
    await seedAndBreak(h);

    await h.dispatch({ cmd: 'inbound.dismiss', arg: 'om_side_effect' }, undefined, 'ou_alice');

    expect(JSON.stringify(h.channel.sent)).toContain('暂时无法写入');
    expect(JSON.stringify(h.channel.sent)).not.toContain('已忽略');
    // Record still actionable.
    expect(h.journal.getRecord('oc_group', 'om_side_effect')?.status).toBe('uncertain');
  });
});
