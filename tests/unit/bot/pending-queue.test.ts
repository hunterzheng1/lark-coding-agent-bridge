import { describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { PendingQueue } from '../../../src/bot/pending-queue';

function msg(id: string): NormalizedMessage {
  return { messageId: id, chatId: 'c', senderId: 'u', content: id, resources: [] } as unknown as NormalizedMessage;
}

describe('PendingQueue.has', () => {
  it('reports whether a scope currently holds queued messages', () => {
    const queue = new PendingQueue(10_000, vi.fn());
    expect(queue.has('chat-1')).toBe(false);
    queue.push('chat-1', msg('a'));
    expect(queue.has('chat-1')).toBe(true);
    expect(queue.has('chat-2')).toBe(false);
    queue.cancel('chat-1');
    expect(queue.has('chat-1')).toBe(false);
  });

  it('still reports queued messages while the scope is blocked', () => {
    const queue = new PendingQueue(10_000, vi.fn());
    queue.block('chat-1');
    queue.push('chat-1', msg('a'));
    expect(queue.has('chat-1')).toBe(true);
  });
});
