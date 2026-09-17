import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

interface Harness {
  sessions: SessionStore;
  run(content: string): Promise<boolean>;
  lastReply(): string;
  replies(): string[];
}

async function createHarness(): Promise<Harness> {
  const tmp: TmpProfile = await createTmpProfile('last-cmd-');
  const channel = createFakeChannel();
  const workspaceRealpath = await realpath(tmp.workspace);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const profileConfig: ProfileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
  });
  profileConfig.workspaces.default = workspaceRealpath;
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
  workspaces.setCwd('chat-1', workspaceRealpath);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  const run = (content: string): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content),
      scope: 'chat-1',
      chatMode: 'p2p',
      sessions,
      workspaces,
      agent: createFakeAgent(),
      activeRuns: {} as CommandContext['activeRuns'],
      controls,
    });

  const replies = (): string[] =>
    channel.sent
      .map((s) =>
        s.content && typeof s.content === 'object' && 'markdown' in (s.content as object)
          ? String((s.content as { markdown?: string }).markdown ?? '')
          : '',
      )
      .filter(Boolean);

  return { sessions, run, replies, lastReply: () => replies()[replies().length - 1] ?? '' };
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
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

/** Page body of a `/last full` reply = between the header and the footer line. */
function pageBody(reply: string): string {
  const start = reply.indexOf('\n\n');
  const footer = reply.lastIndexOf('\n\n📄');
  const end = footer === -1 ? reply.length : footer;
  return reply.slice(start + 2, end);
}

function totalPages(reply: string): number {
  const m = reply.match(/第 1\/(\d+) 页/);
  if (!m) throw new Error(`no page marker in: ${reply.slice(0, 120)}`);
  return Number.parseInt(m[1]!, 10);
}

describe('/last command (OPT-03 full-content delivery)', () => {
  it('short output: default view unchanged (tail lines, no paging hint)', async () => {
    const h = await createHarness();
    h.sessions.setLastRunOutput('chat-1', 'line1\nline2\nline3');
    await h.run('/last');
    const reply = h.lastReply();
    expect(reply).toContain('line3');
    expect(reply).not.toContain('/last full');
  });

  it('long output: default view hints at /last full instead of pretending completeness', async () => {
    const h = await createHarness();
    const long = `${'长'.repeat(4000)}\nTAIL_LINE_MARKER`;
    h.sessions.setLastRunOutput('chat-1', long);
    await h.run('/last');
    const reply = h.lastReply();
    expect(reply).toContain('/last full');
  });

  it('/last full pages are stable and concatenate to the stored output exactly', async () => {
    const h = await createHarness();
    const long = `甲${'x'.repeat(6500)}\nPAGE_SPLIT_MARKER\n乙${'😀'.repeat(10)}尾`;
    h.sessions.setLastRunOutput('chat-1', long);

    await h.run('/last full');
    const first = h.lastReply();
    const total = totalPages(first);
    const pages = [pageBody(first)];
    for (let p = 2; p <= total; p++) {
      await h.run(`/last full ${p}`);
      pages.push(pageBody(h.lastReply()));
    }
    expect(pages.join('')).toBe(long);
  });

  it('/last full rejects out-of-range pages', async () => {
    const h = await createHarness();
    h.sessions.setLastRunOutput('chat-1', 'short output');
    await h.run('/last full 9');
    expect(h.lastReply()).toContain('页码');
  });

  it('numeric args keep the legacy tail-lines meaning', async () => {
    const h = await createHarness();
    h.sessions.setLastRunOutput('chat-1', 'a\nb\nc\nd\ne');
    await h.run('/last 2');
    expect(h.lastReply()).toContain('最后 2 行');
    expect(h.lastReply()).toContain('d\ne');
  });
});
