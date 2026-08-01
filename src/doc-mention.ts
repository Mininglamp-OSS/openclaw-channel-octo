import { ChannelType, MessageType, type BotMessage } from "./types.js";
import type { BotEvent } from "./card-action.js";

/**
 * 文档评论 @Bot 任务（octo-server `doc_comment_mention` 事件）。
 *
 * 与 card_action 的区别在于「产出去向」:card_action 的回复回到原 IM 会话,
 * 文档任务的回复必须回到文档评论串。合成消息仍走正常 inbound 管线以复用
 * mention 门控 / 会话隔离 / 分发骨架,但出站被重定向到 docs 评论 API
 * (见 inbound.ts 的 docTask 分支),IM 侧零发送。
 */
export interface DocCommentMention {
  eventId: number;
  idempotencyKey: string;
  docId: string;
  commentId: string;
  /** 评论串根 id。server 已按 parent_id→comment_id 派生,插件不再自行推断。 */
  threadId: string;
  parentId?: string;
  fromUid: string;
  botUid: string;
  text: string;
  url?: string;
  spaceId?: string;
  enqueuedAt?: number;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 解析 server 权威的 doc_comment_mention 信封。字段名与
 * octo-server `modules/bot_mention` 的 event_data 契约一一对应;
 * 任一必填字段缺失即整条丢弃,不做兜底猜测。
 */
export function parseDocCommentMention(event: BotEvent): DocCommentMention | null {
  if (
    !Number.isSafeInteger(event.event_id) ||
    event.event_id < 0 ||
    event.event_type !== "doc_comment_mention" ||
    !event.event_data ||
    typeof event.event_data !== "object"
  ) {
    return null;
  }

  const data = event.event_data;
  const idempotencyKey = stringValue(data.idempotency_key);
  const docId = stringValue(data.doc_id);
  const commentId = stringValue(data.comment_id);
  // thread_id 由 server 派生并保证非空;这里仍回落到 comment_id,避免旧版本
  // server 漏发该字段时整条任务被丢弃。
  const threadId = stringValue(data.thread_id) || commentId;
  const fromUid = stringValue(data.from_uid);
  const botUid = stringValue(data.bot_uid);
  const text = typeof data.text === "string" ? data.text : "";
  if (!idempotencyKey || !docId || !commentId || !threadId || !fromUid || !botUid || !text.trim()) {
    return null;
  }

  const mention: DocCommentMention = {
    eventId: event.event_id,
    idempotencyKey,
    docId,
    commentId,
    threadId,
    fromUid,
    botUid,
    text,
  };
  const parentId = stringValue(data.parent_id);
  if (parentId) mention.parentId = parentId;
  const url = stringValue(data.url);
  if (url) mention.url = url;
  const spaceId = stringValue(data.space_id);
  if (spaceId) mention.spaceId = spaceId;
  if (typeof data.enqueued_at === "number" && Number.isFinite(data.enqueued_at)) {
    mention.enqueuedAt = data.enqueued_at;
  }
  return mention;
}

/**
 * 会话隔离键的作用域片段。与 DM/群会话彻底分开,粒度是「评论串」而非「单次任务」:
 * 同一评论串内的追问共享上下文,跨评论串互不可见。
 *
 * 注意不要落进 `octo:group:` 命名空间 —— group-md.ts 靠该前缀正则决定是否注入
 * GROUP.md,文档任务不应继承群聊规则。
 */
export function docTaskSessionScope(mention: DocCommentMention): string {
  return `doctask:${escapeScopeSegment(mention.docId)}:${escapeScopeSegment(mention.threadId)}`;
}

/**
 * `:` 是作用域键的分隔符,所以字段里的 `:` 必须转义,否则键的结构有歧义 ——
 * docId="d:1"/threadId="2" 与 docId="d"/threadId="1:2" 会拼成同一个键,两条不相干
 * 的评论串就共享了会话和串行队列。
 */
function escapeScopeSegment(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

/** 串行队列键:同评论串串行,把文档任务挪出发起人的 DM 队列(轮询器串行 await 每个 handler,这里并不带来跨评论串并行),且不占用发起人的 DM 队列。 */
export function docTaskQueueScope(mention: DocCommentMention): string {
  return docTaskSessionScope(mention);
}

/**
 * 把用户评论原文放进 JSON 值,而不是直接拼进控制文本 —— 与 card_action 的
 * formatCardActionText 同样的注入防御姿态。
 */
export function formatDocMentionText(mention: DocCommentMention): string {
  const lines = [
    "[Octo doc comment task]",
    `doc_id=${JSON.stringify(mention.docId)}`,
    `comment_id=${JSON.stringify(mention.commentId)}`,
    `thread_id=${JSON.stringify(mention.threadId)}`,
  ];
  if (mention.url) lines.push(`url=${JSON.stringify(mention.url)}`);
  lines.push(`comment=${JSON.stringify(mention.text)}`);
  lines.push(
    "",
    "请按上面这条文档评论的要求，使用 octo-cli 的 docs 命令读取并修改该文档正文。",
    "你的最终答复会由系统自动发布到该评论串，请不要自己再发一条评论。",
  );
  return lines.join("\n");
}

/**
 * 合成 DM 形状消息复用正常 inbound 管线。channel_id 采用 Space 感知形式与
 * card_action 保持一致;真正决定隔离的是 docTask 作用域(会话键 + 队列键),
 * 而不是这里的 channel_id。
 */
export function synthesizeDocMentionMessage(mention: DocCommentMention, botUid: string): BotMessage {
  const channelId = mention.spaceId ? `s${mention.spaceId}_${mention.fromUid}` : mention.fromUid;
  return {
    message_id: `doc_mention:${mention.idempotencyKey}`,
    message_seq: 0,
    from_uid: mention.fromUid,
    channel_id: channelId,
    channel_type: ChannelType.DM,
    timestamp: mention.enqueuedAt ?? Math.floor(Date.now() / 1000),
    payload: {
      type: MessageType.Text,
      content: formatDocMentionText(mention),
      mention: { uids: [botUid] },
    },
  };
}

/**
 * docs 评论 API 的 parentId 是整数,而 octo-server 事件里的 id 是字符串。
 * 无法解析成正整数时返回 undefined —— 宁可发一条根评论,也不要把非法值发上去。
 *
 * 用 threadId 而不是 mention.parentId:server 那边 `thread_id = parent_id ‖ comment_id`,
 * threadId 才是评论串的根,回在它下面才和「同串共享会话」的语义一致。mention.parentId
 * 仍然解析并被契约测试钉住(它是 server 契约的一部分),只是不作为回复目标。
 *
 * 已知边界:超过 2^53 的雪花 id 会解析失败并退化成根评论。这是安全的失败方向,
 * 但接口契约本身尚未对着真实 docs 后端验证过 —— 若 parentId 其实接受字符串,
 * 应当原样透传 server 给的值,这个精度悬崖就一并消失了。
 */
export function docCommentParentId(mention: DocCommentMention): number | undefined {
  if (!/^\d+$/.test(mention.threadId)) return undefined;
  const parsed = Number(mention.threadId);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
