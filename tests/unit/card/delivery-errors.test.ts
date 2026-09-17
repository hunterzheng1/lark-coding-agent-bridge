import { describe, it, expect } from 'vitest';
import {
  classifyDeliveryError,
  isPermanentDeliveryError,
} from '../../../src/card/delivery-errors';

describe('classifyDeliveryError', () => {
  it('recognizes streaming-mode closures as stream_closed', () => {
    expect(classifyDeliveryError({ code: 200850 })).toBe('stream_closed');
    expect(classifyDeliveryError({ code: '300309' })).toBe('stream_closed');
    expect(classifyDeliveryError(new Error('streaming timeout'))).toBe('stream_closed');
  });

  it('recognizes rate limiting', () => {
    expect(classifyDeliveryError({ code: 9499, msg: 'freq limit' })).toBe('rate_limited');
    expect(classifyDeliveryError(new Error('Too Many Requests'))).toBe('rate_limited');
  });

  it('recognizes content-audit and invalid payload as invalid_payload', () => {
    expect(classifyDeliveryError({ code: 230028 })).toBe('invalid_payload');
    expect(classifyDeliveryError(new Error('Invalid param [card.content]'))).toBe('invalid_payload');
  });

  it('recognizes permission errors as forbidden', () => {
    expect(classifyDeliveryError(new Error('permission denied'))).toBe('forbidden');
    expect(classifyDeliveryError({ code: 99991672, msg: 'forbidden' })).toBe('forbidden');
  });

  it('recognizes transient network failures', () => {
    expect(classifyDeliveryError(new Error('socket hang up'))).toBe('transient_network');
    expect(classifyDeliveryError({ code: 'ECONNRESET', message: 'ECONNRESET' })).toBe(
      'transient_network',
    );
  });

  it('falls back to unknown and treats only payload/permission classes as permanent', () => {
    expect(classifyDeliveryError(new Error('mystery'))).toBe('unknown');
    expect(isPermanentDeliveryError('invalid_payload')).toBe(true);
    expect(isPermanentDeliveryError('forbidden')).toBe(true);
    expect(isPermanentDeliveryError('rate_limited')).toBe(false);
    expect(isPermanentDeliveryError('transient_network')).toBe(false);
    expect(isPermanentDeliveryError('stream_closed')).toBe(false);
    expect(isPermanentDeliveryError('unknown')).toBe(false);
  });

  it('unwraps nested response.data.code like the SDK delivers them', () => {
    expect(
      classifyDeliveryError({ response: { data: { code: 200850 } } }),
    ).toBe('stream_closed');
  });
});
