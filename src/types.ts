/** Octo Bot API types. */

export interface BotRegisterReq {
  name?: string;
}

export interface BotRegisterResp {
  robot_id: string;
  im_token: string;
  ws_url: string;
  api_url: string;
  owner_uid: string;
  owner_channel_id: string;
}

export interface BotSendMessageReq {
  channel_id: string;
  channel_type: ChannelType;
  stream_no?: string;
  payload: MessagePayload;
}

export interface BotTypingReq {
  channel_id: string;
  channel_type: ChannelType;
}

export interface BotReadReceiptReq {
  channel_id: string;
  channel_type: ChannelType;
}

export interface BotEventsReq {
  event_id: number;
  limit?: number;
}



export interface BotMessage {
  message_id: string;
  message_seq: number;
  from_uid: string;
  channel_id?: string;
  channel_type?: ChannelType;
  timestamp: number;
  payload: MessagePayload;
}

/**
 * 单个 mention 的精确位置描述。
 * offset/length 的单位为 UTF-16 code units（与 JS string.length 一致）。
 */
export interface MentionEntity {
  /** 被 @ 用户的唯一标识符 */
  uid: string;
  /** @name 在 content 中的起始位置（包括 @ 符号） */
  offset: number;
  /** @name 的完整长度（包括 @ 符号） */
  length: number;
}

export interface MentionPayload {
  uids?: string[];
  entities?: MentionEntity[];
  /**
   * Legacy "@all" flag. Server outbound double-writes this for legacy clients
   * even after the three-state split landed (server-side semantic: all=humans).
   * Adapter treats `all=1` as a humans-only signal (NOT ais) to match the
   * server's authoritative decision.
   */
  all?: boolean | number; // true or 1 = @all (API returns either depending on version)
  /**
   * Three-state mention (server-authoritative, PR-A landed on octo-server #94).
   * `humans=1` → "@所有人", `ais=1` → "@所有AI". Both can co-exist.
   * Adapter only reads these; it never decides semantics — server is the
   * source of truth and rewrites legacy `all=1` into the canonical form
   * before adapter sees it.
   */
  humans?: boolean | number;
  ais?: boolean | number;
}

export interface ReplyPayload {
  payload?: MessagePayload;
  from_uid?: string;
  from_name?: string;
}

export interface MessagePayload {
  type: MessageType;
  content?: string;
  url?: string;
  name?: string;
  mention?: MentionPayload;
  reply?: ReplyPayload;
  event?: {
    type: string;       // "group_md_updated" | "group_md_deleted" | "thread_md_updated" | "thread_md_deleted"
    version?: number;
    updated_by?: string;
    group_no?: string;   // thread_md_* events only
    short_id?: string;   // thread_md_* events only
  };
  [key: string]: unknown;
}

export interface BotStreamStartReq {
  channel_id: string;
  channel_type: ChannelType;
  payload: string; // base64 encoded
}

export interface BotStreamStartResp {
  stream_no: string;
}

export interface BotStreamEndReq {
  stream_no: string;
  channel_id: string;
  channel_type: ChannelType;
}

export interface SendMessageResult {
  message_id: string;  // string due to int64 protection in postJson
  client_msg_no: string;
  message_seq: number;
}

/** Channel types */
export enum ChannelType {
  DM = 1,
  Group = 2,
  CommunityTopic = 5, // Thread/子区
}

/** Message content types */
export enum MessageType {
  Text = 1,
  Image = 2,
  GIF = 3,
  Voice = 4,
  Video = 5,
  Location = 6,
  Card = 7,
  File = 8,
  MultipleForward = 11,
  /**
   * 图文混排（rich text）。复用 octo-lib Phase 0 已定的 ContentType=14（见
   * octo-lib common/richtext.go）。正文以有序 `content` block 数组承载，数组
   * 顺序即图文穿插顺序；顶层 `plain` 为冗余纯文本，契约上由 server 权威生成。
   */
  RichText = 14,
}

/** RichText(=14) 单个 block 类型常量（与 octo-lib RichTextBlockText/Image 对齐）。 */
export const RICH_TEXT_BLOCK_TEXT = "text";
export const RICH_TEXT_BLOCK_IMAGE = "image";

/** 生成 plain 时 image block 注入的占位符（与 octo-lib RichTextImagePlaceholder 对齐）。 */
export const RICH_TEXT_IMAGE_PLACEHOLDER = "[图片]";

/**
 * RichText(=14) `content` 数组中的单个 block。
 *   - type=text  使用 `text`（纯文本，MVP 不渲染 markdown）；
 *   - type=image 使用 `url`/`width`/`height`（`size`、`name` 可选）。
 *
 * ⚠️ 命名锁定（见 octo-lib richtext.go）：禁止使用 entities + offset/length。
 */
export interface RichTextBlock {
  type: typeof RICH_TEXT_BLOCK_TEXT | typeof RICH_TEXT_BLOCK_IMAGE | string;
  /** text block 文本内容（type=text 必填且非空）。 */
  text?: string;
  /** image block 图片地址（type=image 必填，scheme 仅 http/https）。 */
  url?: string;
  /** image block 宽度（像素，契约必填且 >0，供端上占位排版避免抖动）。 */
  width?: number;
  /** image block 高度（像素，契约必填且 >0）。 */
  height?: number;
  /** image block 字节大小（可选）。 */
  size?: number;
  /** image block 原始文件名（可选）。 */
  name?: string;
}

/** RichText(=14) 消息的 payload。 */
export interface RichTextPayload {
  /** 有序 block 数组，顺序即图文穿插顺序（契约必填且非空）。 */
  content: RichTextBlock[];
  /** 冗余纯文本，契约上由 server 生成；adapter 出站可附带，server 会覆盖。 */
  plain?: string;
}

/**
 * A single candidate returned by the name → target resolver
 * (GET /v1/bot/resolve/targets, octo-server PR #337).
 *
 * Group candidates carry only the group identity; thread candidates additionally
 * carry `shortId` + `parentName`. There is no `parentGroupNo` — `groupNo` already
 * holds the parent group for a thread.
 */
export interface TargetCandidate {
  kind: "group" | "thread";
  /** group: group_no ; thread: group_no____short_id (four underscores). */
  channelId: string;
  /** 2 = group, 5 = thread (CommunityTopic). */
  channelType: ChannelType;
  name: string;
  groupNo: string;
  /** Thread only. */
  shortId?: string;
  /** Thread only. */
  parentName?: string;
}

/** Minimal logger interface used across modules. */
export type LogSink = {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
};
