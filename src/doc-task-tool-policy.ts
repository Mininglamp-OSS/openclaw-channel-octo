import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isDocTaskSessionKey } from "./constants.js";

export function isBlockedDocTaskTool(sessionKey: string | undefined, toolName: unknown): boolean {
  return isDocTaskSessionKey(sessionKey) && (toolName === "sessions_spawn" || toolName === "sessions_yield");
}

/**
 * The document reply transport belongs to inbound's dispatch. A host-initiated
 * continuation uses the generic channel outbound route, which intentionally
 * rejects the document's no-IM sentinel. Until the host can carry the document
 * transport across runs, keep this task in one run: blocking only yield would
 * still leave a spawned child editing after the receipt has ended.
 *
 * Independent of the optional progress observer/registry. Applies to Docs,
 * Sheets, HTML and PPT; interactive IM keeps its existing tool policy.
 */
export function registerDocTaskToolPolicy(api: OpenClawPluginApi): void {
  api.on("before_tool_call", (event, ctx) => {
    if (!isBlockedDocTaskTool(ctx.sessionKey, event.toolName)) return;
    return {
      block: true,
      blockReason: "Document comment tasks must finish in the current run: host continuations cannot deliver to the original comment. Use the current run's tools to complete the request; do not spawn a child agent or yield.",
    };
  }, { priority: 100 }); // Veto before observers record an unexecuted tool as work.
}
