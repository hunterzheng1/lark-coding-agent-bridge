import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger.js';

/** Feishu auto-closes streaming_mode ~10 minutes after last open; renew before that. */
export const STREAMING_RENEW_MS = 8 * 60_000;

export interface StreamingCardSession {
  readonly messageId: string;
  readonly cardId: string;
  update(card: object): Promise<void>;
  close(summary?: string): Promise<void>;
  dispose(): void;
}

export interface StartStreamingCardSessionOptions {
  replyTo?: string;
  replyInThread?: boolean;
  renewEveryMs?: number;
  now?: () => number;
  /** Override CardKit settings API (tests). */
  settingsApi?: (args: {
    cardId: string;
    streamingMode: boolean;
    sequence: number;
    summary?: string;
  }) => Promise<void>;
}

type SessionChannel = Pick<LarkChannel, 'createCard' | 'send' | 'updateCardById' | 'rawClient'>;

export function isStreamingModeError(err: unknown): boolean {
  if (typeof err === 'string') {
    return /streaming timeout|streaming closed/i.test(err);
  }
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    code?: unknown;
    message?: unknown;
    response?: { data?: { code?: unknown } };
  };
  const code = e.code ?? e.response?.data?.code;
  if (code === 200850 || code === 300309 || code === '200850' || code === '300309') {
    return true;
  }
  const msg = typeof e.message === 'string' ? e.message : '';
  return /streaming timeout|streaming closed/i.test(msg);
}

export async function startStreamingCardSession(
  channel: SessionChannel,
  to: string,
  initialCard: object,
  opts: StartStreamingCardSessionOptions = {},
): Promise<StreamingCardSession> {
  const { cardId } = await channel.createCard(initialCard);
  const sendOpts: { replyTo?: string; replyInThread?: boolean } = {};
  if (opts.replyTo) sendOpts.replyTo = opts.replyTo;
  if (opts.replyInThread === true) sendOpts.replyInThread = true;
  const { messageId } = await channel.send(
    to,
    { cardId },
    Object.keys(sendOpts).length > 0 ? sendOpts : undefined,
  );

  const renewEveryMs = Math.max(1, opts.renewEveryMs ?? STREAMING_RENEW_MS);
  const now = opts.now ?? Date.now;
  const settingsApi =
    opts.settingsApi ??
    (async ({ cardId: id, streamingMode, sequence, summary }) => {
      const config: Record<string, unknown> = { streaming_mode: streamingMode };
      if (summary !== undefined) config.summary = { content: summary };
      await channel.rawClient.cardkit.v1.card.settings({
        path: { card_id: id },
        data: {
          settings: JSON.stringify({ config }),
          sequence,
          uuid: `s_${id}_${sequence}`,
        },
      });
    });

  let sequence = 0;
  let lastRenewAt = now();
  let closed = false;
  let disposed = false;
  let renewTimer: ReturnType<typeof setTimeout> | undefined;
  let tail: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    // Swallow prior rejection so the next task still runs with no args (not the
    // rejection reason). Mirror ResilientCardUpdater's serial queue shape.
    const task = tail.catch(() => undefined).then(fn);
    tail = task.catch(() => undefined);
    return task;
  };

  const clearRenewTimer = (): void => {
    if (renewTimer !== undefined) {
      clearTimeout(renewTimer);
      renewTimer = undefined;
    }
  };

  const scheduleRenewTimer = (): void => {
    clearRenewTimer();
    if (closed || disposed) return;
    renewTimer = setTimeout(() => {
      void enqueue(async () => {
        if (closed || disposed) return;
        await renewStreamingMode('timer');
      });
    }, renewEveryMs);
  };

  const renewStreamingMode = async (reason: 'timer' | 'elapsed' | 'error'): Promise<void> => {
    if (closed || disposed) return;
    sequence += 1;
    const seq = sequence;
    try {
      await settingsApi({
        cardId,
        streamingMode: true,
        sequence: seq,
      });
      lastRenewAt = now();
      log.info('stream', 'streaming-renew', { cardId, sequence: seq, reason });
    } catch (err) {
      log.fail('stream', err, { step: 'streaming-renew', cardId, sequence: seq, reason });
      throw err;
    } finally {
      scheduleRenewTimer();
    }
  };

  const maybeRenewForElapsed = async (): Promise<void> => {
    if (now() - lastRenewAt < renewEveryMs) return;
    await renewStreamingMode('elapsed');
  };

  const pushUpdate = async (card: object): Promise<void> => {
    sequence += 1;
    await channel.updateCardById(cardId, card, sequence);
  };

  scheduleRenewTimer();

  const session: StreamingCardSession = {
    messageId,
    cardId,

    update(card: object): Promise<void> {
      return enqueue(async () => {
        if (closed || disposed) {
          throw new Error('streaming card session closed');
        }
        await maybeRenewForElapsed();
        try {
          await pushUpdate(card);
        } catch (err) {
          if (!isStreamingModeError(err)) throw err;
          await renewStreamingMode('error');
          await pushUpdate(card);
        }
      });
    },

    close(summary?: string): Promise<void> {
      return enqueue(async () => {
        if (closed || disposed) return;
        closed = true;
        clearRenewTimer();
        sequence += 1;
        const seq = sequence;
        try {
          await settingsApi({
            cardId,
            streamingMode: false,
            sequence: seq,
            ...(summary !== undefined ? { summary } : {}),
          });
          log.info('stream', 'streaming-close', { cardId, sequence: seq });
        } catch (err) {
          log.fail('stream', err, { step: 'streaming-close', cardId, sequence: seq });
          throw err;
        }
      });
    },

    dispose(): void {
      disposed = true;
      closed = true;
      clearRenewTimer();
    },
  };

  return session;
}
