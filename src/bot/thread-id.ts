import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';

export async function lookupMessageThreadId(
  channel: LarkChannel,
  messageId: string,
): Promise<string | undefined> {
  try {
    const [parent] = await channel.fetchRawMessage(messageId);
    return (parent as { thread_id?: string } | undefined)?.thread_id;
  } catch (err) {
    log.warn('thread', 'thread-id-lookup-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
