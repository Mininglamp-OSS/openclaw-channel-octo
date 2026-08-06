/**
 * Structured error for the Octo REST helpers.
 *
 * The status code and the server's rate-limit hints used to survive only as text inside
 * the message, so every caller that needed them re-parsed the string. This carries them
 * as fields while keeping the historical message wording, which an existing regex parser
 * and its callers still depend on.
 */

/** Fallback wait when the server rate-limits without a usable hint. */
export const DEFAULT_RETRY_AFTER_MS = 1_000;

/**
 * Cap on the response body kept for the message and the logs. A gateway answering with a
 * full HTML error page would otherwise put tens of KB into a single log line. Truncation
 * is cosmetic: the status comes from the response and the retry hint is parsed from the
 * untruncated body.
 */
export const MAX_ERROR_BODY_CHARS = 500;

/** The subset of `Response` this module reads, so tests and non-standard bodies both fit. */
export interface ResponseLike {
  status: number;
  statusText?: string;
  headers?: { get?(name: string): string | null };
}

function header(resp: ResponseLike, name: string): string | undefined {
  // Optional all the way down: a hand-rolled response object may carry no headers at
  // all, and reading them must never turn a plain HTTP failure into a TypeError.
  const raw = resp.headers?.get?.(name);
  return raw == null || raw === "" ? undefined : raw;
}

/** Seconds → ms, rejecting anything that is not a finite non-negative number. */
function secondsToMs(raw: string | number | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  // Number("") is 0 and Number(" ") is 0, so guard the empty cases above rather than
  // letting a blank header masquerade as "retry immediately".
  const seconds = typeof raw === "number" ? raw : Number(raw);
  // Zero is rejected along with the negatives: "come back immediately" is not something a
  // rate limiter means, and taking it literally produces back-to-back retries at the exact
  // moment the server just turned us away.
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  // Re-checked after rounding: a hint like 0.0004 is positive but rounds to 0ms, which would
  // put us straight back on the server with no wait at all.
  const ms = Math.round(seconds * 1000);
  return ms > 0 ? ms : undefined;
}

function retryAfterFromBody(body: string): number | undefined {
  if (!body) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined; // an HTML error page, a proxy blurb, anything non-JSON
  }
  const hint = (parsed as { error?: { details?: { retry_after?: unknown } } })?.error?.details
    ?.retry_after;
  return typeof hint === "number" ? secondsToMs(hint) : undefined;
}

export class OctoApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: string;
  /**
   * The server's requested wait, verbatim. Deliberately not clamped here: shortening it
   * would mean going back before the server said we could, which is the behaviour this
   * error exists to help remove. Callers decide whether the wait is worth honouring.
   */
  readonly retryAfterMs: number;
  readonly rateLimitScope?: string;
  readonly rateLimitRemaining?: string;

  constructor(params: {
    status: number;
    path: string;
    body: string;
    retryAfterMs: number;
    rateLimitScope?: string;
    rateLimitRemaining?: string;
  }) {
    super(`Octo API ${params.path} failed (${params.status}): ${params.body}`);
    this.name = "OctoApiError";
    this.status = params.status;
    this.path = params.path;
    this.body = params.body;
    this.retryAfterMs = params.retryAfterMs;
    this.rateLimitScope = params.rateLimitScope;
    this.rateLimitRemaining = params.rateLimitRemaining;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  static from(resp: ResponseLike, path: string, body: string): OctoApiError {
    const text = body || resp.statusText || "";
    const scope = header(resp, "X-RateLimit-Scope");
    const remaining = header(resp, "X-RateLimit-Remaining");
    return new OctoApiError({
      status: resp.status,
      path,
      body: text.length > MAX_ERROR_BODY_CHARS ? `${text.slice(0, MAX_ERROR_BODY_CHARS)}…` : text,
      // Parsed from the untruncated body: a hint sitting past the cap must not be lost
      // to a display concern.
      retryAfterMs:
        secondsToMs(header(resp, "Retry-After")) ??
        retryAfterFromBody(body) ??
        DEFAULT_RETRY_AFTER_MS,
      ...(scope !== undefined ? { rateLimitScope: scope } : {}),
      ...(remaining !== undefined ? { rateLimitRemaining: remaining } : {}),
    });
  }
}
