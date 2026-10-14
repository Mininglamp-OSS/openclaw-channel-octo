import { normalizeOutboundChannelPrefix } from "./target.js";
import { ChannelType } from "./types.js";

function receiptDestination(data: Record<string, unknown> | undefined): string | undefined {
  if (typeof data?.resolvedTarget !== "string" || !data.resolvedTarget.trim()) return undefined;
  const prefix = data.channelType === ChannelType.DM ? "user"
    : data.channelType === ChannelType.Group || data.channelType === ChannelType.CommunityTopic ? "group" : undefined;
  return prefix ? `${prefix}:${data.resolvedTarget.trim()}` : undefined;
}

/** Only complete sends may become host delivery evidence. */
export function hasFailedMedia(data: Record<string, unknown> | undefined): boolean {
  const failed = data?.failedMedia;
  // Treat malformed failure receipts conservatively, too.
  return failed != null && (!Array.isArray(failed) || failed.length > 0);
}

/** Confirm source delivery from the actual receipt, rather than requested aliases. */
export function confirmsCurrentSourceReply(params: {
  result: { ok: boolean; data?: unknown };
  currentTarget?: string;
}): boolean {
  const data = params.result.data as Record<string, unknown> | undefined;
  if (!params.result.ok || data?.sent !== true || !params.currentTarget?.trim()
    || typeof data.resolvedTarget !== "string" || !data.resolvedTarget.trim()
    || hasFailedMedia(data)) return false;
  const delivered = receiptDestination(data);
  if (!delivered) return false;
  return targetsMatchForReplySuppression({ originTarget: params.currentTarget, targetKey: delivered });
}

function comparisonTarget(raw: string, threadId?: string) {
  const normalized = normalizeOutboundChannelPrefix(raw.trim());
  const explicitKind = normalized.startsWith("user:") ? "user"
    : normalized.startsWith("group:") ? "group" : undefined;
  let id = normalized.replace(/^(?:user:|group:)/, "");
  if (explicitKind === "group") id = id.split("@")[0];
  const kind = explicitKind ?? (id.includes("____") ? "group" : undefined);
  if (kind !== "user" && threadId && !id.includes("____")) {
    const thread = normalizeOutboundChannelPrefix(threadId.trim());
    if (thread.includes("____")) {
      if (!thread.startsWith(`${id}____`)) return undefined;
      id = thread;
    } else id = `${id}____${thread}`;
  }
  return id ? { id, kind } : undefined;
}

/** Compare conversation identity without changing explicit routing prefixes. */
export function targetsMatchForReplySuppression(params: {
  originTarget: string;
  targetKey: string;
  targetThreadId?: string;
}): boolean {
  const origin = comparisonTarget(params.originTarget);
  const target = comparisonTarget(params.targetKey, params.targetThreadId);
  return Boolean(origin && target && origin.id === target.id
    && (!origin.kind || !target.kind || origin.kind === target.kind));
}

/** Use the actual sent route, including automatic thread/account corrections. */
export function extractToolSendResult(params: {
  result: unknown;
  send: { to: string; accountId?: string | null };
}) {
  const details = (params.result as { details?: { ok?: boolean; data?: Record<string, unknown> } })?.details;
  const data = details?.data;
  const to = receiptDestination(data);
  if (details?.ok !== true || data?.sent !== true
    || hasFailedMedia(data) || !to) return null;
  return {
    to,
    accountId: typeof data.accountId === "string" ? data.accountId : params.send.accountId,
    // Octo encodes the effective thread in resolvedTarget; ignore stale host hints.
    threadSuppressed: true,
  };
}
