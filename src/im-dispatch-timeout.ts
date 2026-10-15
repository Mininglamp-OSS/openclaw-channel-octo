import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

const TIMER_MAX_MS = 2 ** 31 - 1;
const DISPATCH_GRACE_MS = 60_000;

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
  try {
    const resolved = host.agent?.resolveAgentTimeoutMs?.({ cfg });
    if (typeof resolved === "number" && Number.isFinite(resolved) && resolved >= 0) {
      return resolved === 0 ? TIMER_MAX_MS : Math.min(resolved + DISPATCH_GRACE_MS, TIMER_MAX_MS);
    }
  } catch {
    // Older/custom hosts may not expose a usable resolver. Never guess their default.
  }
  const seconds = cfg.agents?.defaults?.timeoutSeconds;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000 + DISPATCH_GRACE_MS, TIMER_MAX_MS);
  }
  if (seconds !== 0) {
    warn?.("octo: host agent timeout resolver unavailable; IM guard uses the timer-safe ceiling. Set dispatchTimeoutMs to bound queue waiting; the guard does not cancel the agent.");
  }
  return TIMER_MAX_MS;
}
