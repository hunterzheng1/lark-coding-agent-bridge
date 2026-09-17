/**
 * Delivery error classification for the card update chain (OPT-02).
 *
 * Categories decide handling: rate limits and transient network errors are
 * retryable (bounded backoff, then rollover); stream closures go through the
 * renewal/rollover machinery; invalid payloads and permission errors are
 * permanent — retrying or re-sending the same content in a new card is
 * pointless, so those surface immediately.
 *
 * Code mappings marked below are the ones the codebase itself has verified at
 * runtime (streaming closure codes, audit reject). Others are conservative
 * message heuristics — verify against the Feishu API docs before treating any
 * specific code as authoritative for an endpoint.
 */

export type DeliveryErrorCategory =
  | 'stream_closed'
  | 'rate_limited'
  | 'transient_network'
  | 'invalid_payload'
  | 'forbidden'
  | 'unknown';

interface ErrorShape {
  code?: unknown;
  msg?: unknown;
  message?: unknown;
  response?: { data?: { code?: unknown; msg?: unknown } };
}

function errCode(err: object): string {
  const e = err as ErrorShape;
  const code = e.code ?? e.response?.data?.code;
  return code === undefined || code === null ? '' : String(code);
}

function errText(err: object): string {
  const e = err as ErrorShape;
  const parts = [e.msg, e.message, e.response?.data?.msg];
  return parts.filter((p): p is string => typeof p === 'string').join(' ');
}

export function classifyDeliveryError(err: unknown): DeliveryErrorCategory {
  if (!err || typeof err !== 'object') {
    return typeof err === 'string' && /streaming timeout|streaming closed/i.test(err)
      ? 'stream_closed'
      : 'unknown';
  }
  const code = errCode(err);
  const text = errText(err);

  // Verified in this codebase: CardKit streaming closures (200850/300309),
  // the streaming timeout/closed SDK message, and the local
  // "streaming card session closed" error thrown after close().
  if (code === '200850' || code === '300309') return 'stream_closed';
  if (/streaming timeout|streaming.{0,40}closed/i.test(text)) return 'stream_closed';

  // Verified in this codebase: message audit rejection on send (230028).
  if (code === '230028') return 'invalid_payload';

  // Conservative heuristics — verify specific codes against Feishu docs.
  if (code === '9499' || /rate limit|too many requests|freq( uency)? limit/i.test(text)) {
    return 'rate_limited';
  }
  if (/invalid param|param(eter)? invalid|card\.content|bad request/i.test(text)) {
    return 'invalid_payload';
  }
  if (/permission denied|forbidden|not allowed|access denied/i.test(text)) {
    return 'forbidden';
  }
  if (
    /timeout|timed out|econnreset|econnrefused|enotfound|eai_again|socket|network|aborted|fetch failed/i.test(
      text,
    )
  ) {
    return 'transient_network';
  }
  return 'unknown';
}

export function isPermanentDeliveryError(category: DeliveryErrorCategory): boolean {
  return category === 'invalid_payload' || category === 'forbidden';
}
