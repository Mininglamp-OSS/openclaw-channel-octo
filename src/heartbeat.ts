/**
 * Periodic liveness beat for a bot account.
 *
 * Deliberately has no access to the WebSocket. The beat is a REST call; its failure says
 * nothing about whether the socket is healthy, and treating it as a connection fault used
 * to tear down a working connection and strand the account. The socket has its own
 * ping/pong and reconnect machinery for its own health.
 *
 * The loop's lifetime follows the account rather than the connection, so no failed
 * reconnect can leave the beat permanently stopped.
 */

import { OctoApiError } from "./api-error.js";

/**
 * Per-beat deadline. `fetch` has no default timeout, so without this a hung connection
 * would hold the single-flight slot for the lifetime of the process.
 *
 * Implemented with a plain timer rather than `AbortSignal.timeout` so that tests driving
 * a fake clock control it like every other timer here.
 */
export const HEARTBEAT_TIMEOUT_MS = 10_000;

/** Consecutive non-rate-limit failures before the log escalates from warn to error. */
export const MAX_HEARTBEAT_FAILURES = 3;

export interface HeartbeatLoop {
  start(): void;
  stop(): void;
}

export function createHeartbeatLoop(params: {
  intervalMs: number;
  accountId: string;
  send: (signal: AbortSignal) => Promise<void>;
  isConnected: () => boolean;
  log?: { warn?(msg: string): void; error?(msg: string): void };
}): HeartbeatLoop {
  const { intervalMs, accountId, send, isConnected, log } = params;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: AbortController | undefined;
  let consecutiveFailures = 0;
  let stopped = false;

  const beat = (): void => {
    if (stopped || inFlight) return; // single-flight: never stack beats
    // Claiming to be alive while the socket is down would be a lie, and no reader needs
    // the beat badly enough to justify sending it anyway.
    if (!isConnected()) return;

    const controller = new AbortController();
    inFlight = controller;
    const deadline = setTimeout(() => {
      controller.abort(new Error(`heartbeat exceeded ${HEARTBEAT_TIMEOUT_MS}ms`));
    }, HEARTBEAT_TIMEOUT_MS);

    void send(controller.signal)
      .then(() => {
        consecutiveFailures = 0;
      })
      .catch((err: unknown) => {
        // stop() aborts the in-flight beat on purpose. Counting or logging that would make
        // every clean shutdown look like a failure.
        if (stopped) return;
        if (err instanceof OctoApiError && err.isRateLimited) {
          // Transient by definition and self-correcting: the next beat is one interval
          // away. Counting it would conflate "the server is busy" with "we are offline".
          log?.warn?.(
            `octo: [${accountId}] heartbeat rate limited ` +
              `(scope=${err.rateLimitScope ?? "?"} remaining=${err.rateLimitRemaining ?? "?"}), ` +
              `skipping this beat`,
          );
          return;
        }
        consecutiveFailures++;
        const msg =
          `octo: [${accountId}] heartbeat failed ` +
          `(${consecutiveFailures}/${MAX_HEARTBEAT_FAILURES}): ${String(err)}`;
        // Escalation is a log level, not an action. The beat has no reader whose absence
        // breaks anything, so there is nothing to repair from here — and the one thing
        // this used to do, reconnecting, attacked a connection that was never the problem.
        if (consecutiveFailures >= MAX_HEARTBEAT_FAILURES) log?.error?.(msg);
        else log?.warn?.(msg);
      })
      .finally(() => {
        clearTimeout(deadline);
        if (inFlight === controller) inFlight = undefined;
      });
  };

  return {
    start(): void {
      if (timer) return;
      stopped = false;
      timer = setInterval(beat, intervalMs);
    },
    stop(): void {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      inFlight?.abort(new Error("heartbeat stopped"));
      inFlight = undefined;
    },
  };
}
