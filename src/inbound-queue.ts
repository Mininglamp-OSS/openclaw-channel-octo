import { normalizeAccountId } from "./account-id.js";
import { ChannelType, MessageType, type BotMessage } from "./types.js";

const inboundQueues = new Map<string, Promise<void>>();
const APPROVAL_DECISIONS = new Set([
  "allow",
  "once",
  "allow-once",
  "allowonce",
  "always",
  "allow-always",
  "allowalways",
  "deny",
  "reject",
  "block",
]);

/**
 * Match the approval forms accepted by the minimum supported OpenClaw host.
 * This deliberately remains a local predicate: importing a hashed private
 * host bundle would make the plugin depend on an unstable implementation file.
 * The host still parses, authorizes, and resolves the command authoritatively.
 */
function isAcceptedApprovalCommand(content: string): boolean {
  // OpenClaw 2026.6.9's approval parser accepts both `/approve ...` and
  // slashless `approve ...`; mirror that public host behavior here.
  const commandMatch = content.trim().match(/^\/?approve(?:\s|$)/i);
  if (!commandMatch) return false;

  const tokens = content
    .trim()
    .slice(commandMatch[0].length)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length < 2) return false;

  const first = tokens[0].toLowerCase();
  const second = tokens[1].toLowerCase();
  if (APPROVAL_DECISIONS.has(first)) {
    return tokens.slice(1).join(" ").trim().length > 0;
  }
  return APPROVAL_DECISIONS.has(second);
}

export function getInboundQueueKey(accountId: string, message: BotMessage): string {
  const id = normalizeAccountId(accountId);
  const isGroup =
    typeof message.channel_id === "string" &&
    message.channel_id.length > 0 &&
    (message.channel_type === ChannelType.Group ||
      message.channel_type === ChannelType.CommunityTopic);
  if (isGroup) return `${id}:group:${message.channel_id}`;

  const spaceId = extractDmSpaceId(message);
  const sessionId = spaceId ? `${spaceId}:${message.from_uid}` : message.from_uid;
  return `${id}:dm:${sessionId}`;
}

/** Extract Space from s{spaceId}_{uid}@s{spaceId}_{uid} without splitting UID underscores. */
export function extractDmSpaceId(
  message: Pick<BotMessage, "channel_id" | "from_uid">,
): string {
  if (!message.channel_id?.startsWith("s")) return "";
  const senderSuffix = `_${message.from_uid}`;
  let spaceId = "";
  for (const participant of message.channel_id.split("@")) {
    if (participant.startsWith("s") && participant.endsWith(senderSuffix)) {
      const candidate = participant.slice(1, -senderSuffix.length);
      // Another participant UID may itself end in `_${from_uid}`. Its derived
      // candidate includes that UID prefix, so prefer the shortest match.
      if (candidate !== "" && (spaceId === "" || candidate.length < spaceId.length)) {
        spaceId = candidate;
      }
    }
  }
  return spaceId;
}

/**
 * Approval replies must not wait behind the Agent run that is itself blocked
 * on that approval. Only a server-verified owner sending an OpenClaw-supported
 * plain-text approval command in an explicit DM may bypass serialization.
 * OpenClaw still performs authoritative authorization and approval-id checks.
 */
export function shouldBypassInboundQueue(
  message: BotMessage,
  ownerUid: string | undefined,
): boolean {
  if (
    ownerUid === undefined ||
    message.from_uid !== ownerUid ||
    message.channel_type !== ChannelType.DM ||
    message.payload?.type !== MessageType.Text ||
    typeof message.payload.content !== "string"
  ) {
    return false;
  }
  return isAcceptedApprovalCommand(message.payload.content);
}

export type InboundDispatchMode = "standard" | "approval-bypass";

/** Keep the queue/bypass decision and the dispatch mode passed to inbound handling in one place. */
export function dispatchInboundWithQueue<T>(params: {
  accountId: string;
  message: BotMessage;
  ownerUid: string | undefined;
  run: (mode: InboundDispatchMode) => Promise<T>;
}): Promise<T> {
  if (shouldBypassInboundQueue(params.message, params.ownerUid)) {
    return params.run("approval-bypass");
  }
  return enqueueInbound(
    getInboundQueueKey(params.accountId, params.message),
    () => params.run("standard"),
  );
}

/** Serialize work per account/conversation while still returning this task's real outcome. */
export function enqueueInbound<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = inboundQueues.get(key) ?? Promise.resolve();
  const execution = previous.catch(() => undefined).then(task);
  const tail: Promise<void> = execution
    .then(() => undefined, () => undefined)
    .finally(() => {
      if (inboundQueues.get(key) === tail) inboundQueues.delete(key);
    });
  inboundQueues.set(key, tail);
  return execution;
}
