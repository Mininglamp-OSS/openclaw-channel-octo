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

export interface DeferredReconnect {
  /** Arm a reconnect for later, replacing any already-armed one. */
  schedule(label: string): void;
  cancel(): void;
  /** True while one is armed but has not fired — a watchdog input. */
  isPending(): boolean;
}

/**
 * One tracked handle for every reconnect an account defers.
 *
 * Two properties matter and neither survives a bare `setTimeout`. It must be cancellable,
 * so shutting the account down does not leave a reconnect to fire into a stopped account;
 * and it must be observable, so the watchdog can tell somebody is already on it. A failed
 * re-register used to schedule nothing at all, which is how an account ended up dark until
 * the process was restarted.
 *
 * Replacing an armed handle is deliberate: both pending actions rebuild the same
 * connection, and two of them racing produce sockets that kick each other.
 */
export function createDeferredReconnect(deps: {
  isStopped: () => boolean;
  sequencer: ReconnectSequencer;
  run: () => Promise<void>;
  /** Override for tests; production jitters to avoid a synchronised herd. */
  delayMs?: () => number;
}): DeferredReconnect {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const delayMs = deps.delayMs ?? (() => 5_000 + Math.floor(Math.random() * 5_000));

  return {
    schedule(label): void {
      if (deps.isStopped()) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        // Re-checked here as well as at schedule time: the account can stop during the wait.
        if (deps.isStopped()) return;
        void deps.sequencer.run(label, deps.run);
      }, delayMs());
    },
    cancel(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    isPending(): boolean {
      return timer !== null;
    },
  };
}

export interface SingleFlightFlag {
  isRaised(): boolean;
  /**
   * Raise the flag, run `fn`, and lower it again — whatever `fn` does, including nothing
   * at all and including throwing.
   */
  run(fn: () => Promise<void>): Promise<void>;
}

/**
 * A guard flag whose lowering cannot be skipped.
 *
 * Written as a unit because the obvious hand-rolled version has a trap that cost this
 * codebase a real defect: raise the flag, then hand the work to something that may decline
 * to run it, and put the lowering inside the work. When the work is declined the flag stays
 * raised for the lifetime of the process — and this particular flag gates both the watchdog
 * predicate and the fallback reconnect branch, so leaving it raised is indistinguishable from
 * the outage it was meant to prevent.
 */
export function createSingleFlightFlag(): SingleFlightFlag {
  let raised = false;
  return {
    isRaised: () => raised,
    async run(fn): Promise<void> {
      raised = true;
      try {
        await fn();
      } finally {
        raised = false;
      }
    },
  };
}
