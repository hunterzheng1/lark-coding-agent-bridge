import type { LarkChannel } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startKeepalive } from '../../../src/bot/keepalive.js';

function createChannel(getConnectionStatus: () => { state: string; reconnectAttempts: number }) {
  return {
    getConnectionStatus,
  } as unknown as LarkChannel;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('startKeepalive', () => {
  it('resets stale counter when the channel reconnects', async () => {
    vi.useFakeTimers();
    const status = { state: 'reconnecting', reconnectAttempts: 1 };
    const forceReconnect = vi.fn(async () => {});
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
    const handle = startKeepalive({
      channel: createChannel(() => status),
      domain: 'https://open.feishu.cn',
      forceReconnect,
    });

    await vi.advanceTimersByTimeAsync(15_000);
    status.state = 'connected';
    await vi.advanceTimersByTimeAsync(15_000);
    status.state = 'reconnecting';
    await vi.advanceTimersByTimeAsync(30_000);

    expect(forceReconnect).not.toHaveBeenCalled();
    handle.stop();
  });

  it('does not force reconnect while HTTP is down', async () => {
    vi.useFakeTimers();
    const forceReconnect = vi.fn(async () => {});
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    const handle = startKeepalive({
      channel: createChannel(() => ({ state: 'reconnecting', reconnectAttempts: 1 })),
      domain: 'https://open.feishu.cn',
      forceReconnect,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(forceReconnect).not.toHaveBeenCalled();
    handle.stop();
  });

  it('force reconnects after three WS-stuck ticks', async () => {
    vi.useFakeTimers();
    const forceReconnect = vi.fn(async () => {});
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200 })));
    const handle = startKeepalive({
      channel: createChannel(() => ({ state: 'reconnecting', reconnectAttempts: 1 })),
      domain: 'https://open.feishu.cn',
      forceReconnect,
    });

    await vi.advanceTimersByTimeAsync(45_000);

    expect(forceReconnect).toHaveBeenCalledTimes(1);
    handle.stop();
  });
});
