import { normalizeAccountId } from "./account-id.js";
import { ChannelType, type BotMessage } from "./types.js";

const inboundQueues = new Map<string, Promise<void>>();

/**
 * `scopeOverride` 让合成消息脱离「按消息字段派生」的默认分区。
 *
 * 文档任务必须用它:合成消息是 DM 形状的,不覆写会落进发起人的 DM 队列,
 * 一个跑几分钟的文档任务会队头阻塞该用户与这个 Bot 的所有私聊(队列严格串行)。
 */
export function getInboundQueueKey(
  accountId: string,
  message: BotMessage,
  scopeOverride?: string,
): string {
  const id = normalizeAccountId(accountId);
  if (scopeOverride) return `${id}:${scopeOverride}`;
  const isGroup =
    typeof message.channel_id === "string" &&
    message.channel_id.length > 0 &&
    (message.channel_type === ChannelType.Group ||
      message.channel_type === ChannelType.CommunityTopic);
  if (isGroup) return `${id}:group:${message.channel_id}`;

  let spaceId = "";
  if (message.channel_id?.startsWith("s")) {
    const firstPart = message.channel_id.split("@", 1)[0];
    const lastUnderscore = firstPart.lastIndexOf("_");
    if (lastUnderscore > 0) spaceId = firstPart.slice(1, lastUnderscore);
  }
  const sessionId = spaceId ? `${spaceId}:${message.from_uid}` : message.from_uid;
  return `${id}:dm:${sessionId}`;
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
