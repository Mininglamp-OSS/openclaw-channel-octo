/**
 * Last-resort supervisor for an account's WebSocket.
 *
 * Individual failure paths are fixed where they are found, but each fix only covers the
 * path it knows about. This asks one question on a slow timer — "should something be
 * reconnecting, and is nobody doing it?" — so a path that was missed, or one added later,
 * still recovers instead of stranding the account until someone restarts the process.
 *
 * The predicate belongs to the caller because only it can see every piece of reconnect
 * state. Getting that predicate wrong produces duplicate connections that kick each
 * other, so it must account for every attempt that is scheduled *or in progress*.
 */

/** Slow on purpose: this is a backstop, not the primary recovery path. */
export const WATCHDOG_INTERVAL_MS = 60_000;

export interface ConnectionWatchdog {
  start(): void;
  stop(): void;
}

export function createConnectionWatchdog(params: {
  intervalMs?: number;
  accountId: string;
  shouldReconnect: () => boolean;
  reconnect: () => void | Promise<void>;
  log?: { warn?(msg: string): void };
}): ConnectionWatchdog {
  const { accountId, shouldReconnect, reconnect, log } = params;
  const intervalMs = params.intervalMs ?? WATCHDOG_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reviving = false;
  let stopped = false;

  const tick = (): void => {
    if (stopped || reviving) return;
    if (!shouldReconnect()) return;
    reviving = true;
    log?.warn?.(
      `octo: [${accountId}] connection appears stranded with nobody reconnecting, reviving`,
    );
    void (async () => {
      try {
        await reconnect();
      } catch (err) {
        // Swallowed on purpose: a failed revive must not kill the watchdog, or the one
        // component whose job is to keep trying would stop after its first bad attempt.
        log?.warn?.(`octo: [${accountId}] watchdog revive failed: ${String(err)}`);
      } finally {
        reviving = false;
      }
    })();
  };

  return {
    start(): void {
      if (timer) return;
      stopped = false;
      // Jittered so several accounts in one process do not all wake together and hand the
      // server a burst of reconnects.
      const jittered = Math.round(intervalMs * (0.75 + Math.random() * 0.5));
      timer = setInterval(tick, jittered);
    },
    stop(): void {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
