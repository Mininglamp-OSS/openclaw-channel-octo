import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

const TIMER_MAX_MS = 2 ** 31 - 1;
const DISPATCH_GRACE_MS = 60_000;
// Queue recovery only, never an assumed host execution deadline.
export const UNKNOWN_HOST_QUEUE_WAIT_MS = 30 * 60_000;
const warnedHosts = new WeakSet<object>();

type TimeoutHost = {
  agent?: { resolveAgentTimeoutMs?: (opts: { cfg: OpenClawConfig }) => number };
};

/** Ordinary IM follows host policy; business-task budgets are resolved separately. */
export function resolveImDispatchTimeoutMs(
  cfg: OpenClawConfig,
  explicitMs: unknown,
  host: TimeoutHost,
  warn?: (message: string) => void,
): number {
  if (typeof explicitMs === "number" && Number.isFinite(explicitMs) && explicitMs > 0) {
    return Math.min(explicitMs, TIMER_MAX_MS);
  }
  // Official hosts encode timeoutSeconds=0 as a large finite sentinel.
  if (cfg.agents?.defaults?.timeoutSeconds === 0) return UNKNOWN_HOST_QUEUE_WAIT_MS;
  try {
    const resolved = host.agent?.resolveAgentTimeoutMs?.({ cfg });
    if (typeof resolved === "number" && Number.isFinite(resolved) && resolved >= 0) {
      return resolved === 0 ? UNKNOWN_HOST_QUEUE_WAIT_MS : Math.min(resolved + DISPATCH_GRACE_MS, TIMER_MAX_MS);
    }
  } catch {
    // Older/custom hosts may not expose a usable resolver. Never guess their default.
  }
  const seconds = cfg.agents?.defaults?.timeoutSeconds;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000 + DISPATCH_GRACE_MS, TIMER_MAX_MS);
  }
  if (seconds !== 0 && warn && !warnedHosts.has(host)) {
    warnedHosts.add(host);
    warn("octo: host agent timeout resolver unavailable; using a 30-minute queue recovery interval, not an execution deadline. The agent continues and late replies remain allowed.");
  }
  return UNKNOWN_HOST_QUEUE_WAIT_MS;
}
