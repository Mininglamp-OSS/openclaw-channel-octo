/**
 * Reconnect coordination for one bot account.
 *
 * A connection has several parties that may decide to rebuild it: the socket's own backoff,
 * a token refresh, a deferred retry after a failed re-register, and the watchdog. They each
 * need to know whether one of the others is already on it, and the answer is not derivable
 * from the socket alone — a sequence that has torn the old socket down but not yet built the
 * new one leaves no trace anywhere else.
 *
 * Kept in its own module so the production path and its tests exercise the same code rather
 * than two hand-written versions of the same rule.
 */

export interface ReconnectSequencer {
  /**
   * Run a reconnect sequence unless one is already running. Never rejects: a failed
   * sequence is reported and the slot released, because the alternative is one bad attempt
   * wedging every future reconnect, including the watchdog's.
   */
  run(label: string, fn: () => Promise<void>): Promise<void>;
  isInFlight(): boolean;
}

export function createReconnectSequencer(params?: {
  log?: { error?(msg: string): void };
}): ReconnectSequencer {
  let inFlight = false;
  return {
    async run(label, fn): Promise<void> {
      if (inFlight) return;
      // Set synchronously, before any await, so the flag is already visible to a watchdog
      // tick that lands in the same turn.
      inFlight = true;
      try {
        await fn();
      } catch (err) {
        params?.log?.error?.(`octo: reconnect sequence ${label} failed: ${String(err)}`);
      } finally {
        inFlight = false;
      }
    },
    isInFlight(): boolean {
      return inFlight;
    },
  };
}

/**
 * Build the watchdog's "should I step in?" predicate.
 *
 * Every input is a getter, not a value: the predicate is consulted on a timer long after it
 * is built, so capturing state here would freeze the answer at construction time.
 */
export function buildWatchdogPredicate(deps: {
  isStopped: () => boolean;
  isReconnectInFlight: () => boolean;
  isConnectingOrConnected: () => boolean;
  hasPendingReconnect: () => boolean;
  isRefreshingToken: () => boolean;
  hasDeferredReconnect: () => boolean;
}): () => boolean {
  return () =>
    !deps.isStopped() &&
    !deps.isReconnectInFlight() &&
    !deps.isConnectingOrConnected() &&
    !deps.hasPendingReconnect() &&
    !deps.isRefreshingToken() &&
    !deps.hasDeferredReconnect();
}
