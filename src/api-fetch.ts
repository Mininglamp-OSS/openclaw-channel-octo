/**
 * Lightweight fetch-based API helpers for use inside OpenClaw plugin context.
 * These are used by inbound/outbound where the full OctoAPI class is not available.
 */

import { ChannelType, MessageType, CARD_INTERACTIVE_PROFILE, CARD_PROFILE, CARD_VERSION, type CardProfile, type MentionEntity, type RichTextBlock, type SendMessageResult, type TargetCandidate } from "./types.js";
import path from "path";
import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { BotEvent } from "./card-action.js";

const DEFAULT_TIMEOUT_MS = 30_000;
// Card-event short-poll requests run in a single sequential loop; without a bound a hung
// /v1/bot/events (or its ack) would block all callback processing for the account until the OS
// eventually drops the socket. Cap each request well under any reasonable poll cadence.
const EVENTS_POLL_TIMEOUT_MS = 10_000;
// Short timeout for the per-message mention_pref hot-path lookup. On a cache
// miss this fires on the first message of every group every TTL window; before
// the backend ships it 404s, and we must not stall the inbound pipeline for the
// full 30s. A failed/slow lookup just falls back to the account-level config.
const MENTION_PREF_TIMEOUT_MS = 3_000;

/**
 * 生成出站消息的客户端幂等编号 client_msg_no（UUID）。
 *
 * WuKongIM 以 client_msg_no 做服务端去重（见 pkg/wkdb/message.go：相同
 * client_msg_no 只落库一条）。图文混排 payload 体积大、链路长、更易触发重试，
 * 故出站统一附带 client_msg_no，保证重试不会产生重复消息。
 */
export function generateClientMsgNo(): string {
  return randomUUID();
}

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
};

/**
 * Parse JSON with int64 message_id protection.
 * Converts 16+ digit numeric message_id values to strings before JSON.parse
 * to prevent JavaScript precision loss for IDs exceeding Number.MAX_SAFE_INTEGER.
 */
function parseOctoJson<T>(text: string): T {
  const safeText = text.replace(
    /"message_id"\s*:\s*(\d{16,})/g,
    '"message_id":"$1"',
  );
  return JSON.parse(safeText) as T;
}

/**
 * Regex matching the `failed (<status>)` fragment in this module's thrown error
 * messages. Single source of truth for the throw format so external parsers do
 * not hardcode their own copy. See {@link httpStatusFromApiFetchError}.
 */
export const API_FETCH_STATUS_RE = /failed \((\d{3})\)/;

/**
 * Extract the HTTP status from an api-fetch error. The fetch helpers here throw
 * `Error("<who> failed (<status>): <text>")` on non-2xx, so the status is only
 * recoverable from the message. Centralizing the parse here means a caller (e.g.
 * fork-inherit-md) does not couple to the throw format, and a future format
 * change only needs updating in this module.
 *
 * @returns The 3-digit status, or undefined for errors without an embedded
 *   `(NNN)` (e.g. a network timeout, or a non-Error throw) — callers treat that
 *   as a generic failure.
 */
export function httpStatusFromApiFetchError(err: unknown): number | undefined {
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(API_FETCH_STATUS_RE);
  return match ? Number(match[1]) : undefined;
}

export async function postJson<T>(
  apiUrl: string,
  botToken: string,
  path: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const url = `${apiUrl.replace(/\/+$/, "")}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...DEFAULT_HEADERS,
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Octo API ${path} failed (${response.status}): ${text || response.statusText}`);
  }

  const text = await response.text();
  if (!text) return undefined;
  try {
    return parseOctoJson<T>(text);
  } catch {
    throw new Error(`Octo API ${path} returned invalid JSON: ${text.slice(0, 200)}`);
  }
}


/**
 * Send a media message (image or file) to a channel.
 */
export async function sendMediaMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  type: MessageType;
  url: string;
  name?: string;
  size?: number;
  width?: number;
  height?: number;
  mentionUids?: string[];
  mentionEntities?: MentionEntity[];
  onBehalfOf?: string;
  clientMsgNo?: string;
  signal?: AbortSignal;
}): Promise<SendMessageResult | undefined> {
  // Last-line guard: never POST an empty channel_id — the server answers an
  // opaque 500. Upstream resolvers should already reject this, but any future
  // caller that bypasses them is stopped here. (#138)
  if (!params.channelId || !params.channelId.trim()) {
    throw new Error("octo: channelId is required to send a message");
  }
  const payload: Record<string, unknown> = {
    type: params.type,
    url: params.url,
  };

  // Image (type=2) needs width/height/name/size; File (type=8) needs name/size
  if (params.type === MessageType.Image) {
    if (params.width) payload.width = params.width;
    if (params.height) payload.height = params.height;
    if (params.name) payload.name = params.name;
    if (params.size != null) payload.size = params.size;
  } else {
    if (params.name) payload.name = params.name;
    if (params.size != null) payload.size = params.size;
  }

  if (
    (params.mentionUids && params.mentionUids.length > 0) ||
    (params.mentionEntities && params.mentionEntities.length > 0)
  ) {
    const mention: Record<string, unknown> = {};
    if (params.mentionUids && params.mentionUids.length > 0) {
      mention.uids = params.mentionUids;
    }
    if (params.mentionEntities && params.mentionEntities.length > 0) {
      mention.entities = params.mentionEntities;
    }
    payload.mention = mention;
  }
  return await postJson<SendMessageResult>(params.apiUrl, params.botToken, "/v1/bot/sendMessage", {
    channel_id: params.channelId,
    channel_type: params.channelType,
    payload,
    client_msg_no: params.clientMsgNo ?? generateClientMsgNo(),
    ...(params.onBehalfOf ? { on_behalf_of: params.onBehalfOf } : {}),
  }, params.signal);
}

/**
 * Infer MIME type from filename extension. Returns a sensible default if unknown.
 */
export function inferContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".bmp": "image/bmp", ".ico": "image/x-icon",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
    ".pdf": "application/pdf", ".zip": "application/zip",
    ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown",
    ".csv": "text/csv", ".html": "text/html", ".htm": "text/html",
    ".css": "text/css", ".xml": "text/xml", ".yaml": "text/yaml", ".yml": "text/yaml",
    ".json": "application/json",
  };
  return map[ext] ?? "application/octet-stream";
}

/**
 * Ensure text/* content types include a charset parameter.
 * If the content type starts with "text/" and has no charset, appends "; charset=utf-8".
 */
export function ensureTextCharset(contentType: string): string {
  if (contentType.startsWith("text/") && !contentType.includes("charset")) {
    return contentType + "; charset=utf-8";
  }
  return contentType;
}

/**
 * Parse image dimensions from buffer (PNG/JPEG/GIF/WebP).
 * Lightweight — reads only the header bytes, no external dependencies.
 */
export function parseImageDimensions(buf: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === "image/png" && buf.length > 24) {
      // PNG: width at offset 16 (4 bytes BE), height at offset 20 (4 bytes BE)
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if ((mime === "image/jpeg" || mime === "image/jpg") && buf.length > 2) {
      // JPEG: scan for SOF0/SOF2 marker (0xFF 0xC0 or 0xFF 0xC2)
      let offset = 2;
      while (offset < buf.length - 8) {
        if (buf[offset] !== 0xFF) break;
        const marker = buf[offset + 1];
        if (marker === 0xC0 || marker === 0xC2) {
          return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
        }
        const len = buf.readUInt16BE(offset + 2);
        offset += 2 + len;
      }
    }
    if (mime === "image/gif" && buf.length > 10) {
      // GIF: width at offset 6 (2 bytes LE), height at offset 8 (2 bytes LE)
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === "image/webp" && buf.length > 30) {
      // WebP VP8: width at offset 26, height at offset 28 (both 2 bytes LE)
      if (buf.toString("ascii", 12, 16) === "VP8 " && buf.length > 29) {
        return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF };
      }
    }
  } catch { /* ignore parse errors */ }
  return null;
}

/**
 * Parse image dimensions from a file path by reading only the first 64KB.
 * Avoids loading the entire file into memory.
 */
export async function parseImageDimensionsFromFile(filePath: string, mime: string): Promise<{ width: number; height: number } | null> {
  const HEADER_SIZE = 65536; // 64KB — enough for PNG/JPEG/GIF/WebP headers
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(filePath, "r");
    const buf = Buffer.alloc(HEADER_SIZE);
    const { bytesRead } = await fh.read(buf, 0, HEADER_SIZE, 0);
    return parseImageDimensions(buf.subarray(0, bytesRead), mime);
  } catch { /* ignore read/parse errors */ }
  finally { await fh?.close(); }
  return null;
}

// SendMessageResult: use the canonical definition from types.ts
// (message_id is string due to int64 protection in postJson)

export async function sendMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  content: string;
  mentionUids?: string[];
  mentionEntities?: MentionEntity[];
  mentionAll?: boolean;
  replyMsgId?: string;
  onBehalfOf?: string;
  clientMsgNo?: string;
  signal?: AbortSignal;
}): Promise<SendMessageResult | undefined> {
  // Last-line guard: never POST an empty channel_id — the server answers an
  // opaque 500. Upstream resolvers should already reject this, but any future
  // caller that bypasses them is stopped here. (#138)
  if (!params.channelId || !params.channelId.trim()) {
    throw new Error("octo: channelId is required to send a message");
  }
  const payload: Record<string, unknown> = {
    type: MessageType.Text,
    content: params.content,
  };
  // Add mention field if any UIDs specified, entities present, or mentionAll
  if (
    (params.mentionUids && params.mentionUids.length > 0) ||
    (params.mentionEntities && params.mentionEntities.length > 0) ||
    params.mentionAll
  ) {
    const mention: Record<string, unknown> = {};
    if (params.mentionUids && params.mentionUids.length > 0) {
      mention.uids = params.mentionUids;
    }
    if (params.mentionEntities && params.mentionEntities.length > 0) {
      mention.entities = params.mentionEntities;
    }
    if (params.mentionAll) {
      mention.all = 1;
    }
    payload.mention = mention;
  }
  // Add reply field if replyMsgId is provided
  if (params.replyMsgId) {
    payload.reply = { message_id: params.replyMsgId };
  }
  return await postJson<SendMessageResult>(params.apiUrl, params.botToken, "/v1/bot/sendMessage", {
    channel_id: params.channelId,
    channel_type: params.channelType,
    payload,
    client_msg_no: params.clientMsgNo ?? generateClientMsgNo(),
    ...(params.onBehalfOf ? { on_behalf_of: params.onBehalfOf } : {}),
  }, params.signal);
}

/**
 * 发送一条 RichText(=14) 图文混排消息。
 *
 * 替代「sendMessage 文本 + 循环 uploadMedia」的多次 HTTP：调用方先批量上传图片
 * 拿到 url（含 width/height），再把文本与图片按顺序组成一条 `content` block 数组
 * 提交。一条 payload = 一次 HTTP，server 端图文不再拆条。
 *
 * 契约（见 octo-lib richtext.go）：
 *   - `content` 必填且非空；text block 的 text 非空、image block 的 url 为
 *     http/https 且 width/height >0 —— 校验由调用方/ server 负责，本函数只组装。
 *   - `plain` 出站可附带（供老客户端/降级），server 会用 content 权威重算覆盖。
 *   - `client_msg_no` 默认自动生成（幂等去重），调用方可显式传入复用。
 */
export async function sendRichTextMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  blocks: RichTextBlock[];
  plain?: string;
  mentionUids?: string[];
  mentionEntities?: MentionEntity[];
  mentionAll?: boolean;
  replyMsgId?: string;
  onBehalfOf?: string;
  clientMsgNo?: string;
  signal?: AbortSignal;
}): Promise<SendMessageResult | undefined> {
  // Last-line guard: never POST an empty channel_id — the server answers an
  // opaque 500. Upstream resolvers should already reject this, but any future
  // caller that bypasses them is stopped here. (#138)
  if (!params.channelId || !params.channelId.trim()) {
    throw new Error("octo: channelId is required to send a message");
  }
  const payload: Record<string, unknown> = {
    type: MessageType.RichText,
    content: params.blocks,
  };
  if (typeof params.plain === "string") {
    payload.plain = params.plain;
  }
  if (
    (params.mentionUids && params.mentionUids.length > 0) ||
    (params.mentionEntities && params.mentionEntities.length > 0) ||
    params.mentionAll
  ) {
    const mention: Record<string, unknown> = {};
    if (params.mentionUids && params.mentionUids.length > 0) {
      mention.uids = params.mentionUids;
    }
    if (params.mentionEntities && params.mentionEntities.length > 0) {
      mention.entities = params.mentionEntities;
    }
    if (params.mentionAll) {
      mention.all = 1;
    }
    payload.mention = mention;
  }
  if (params.replyMsgId) {
    payload.reply = { message_id: params.replyMsgId };
  }
  return await postJson<SendMessageResult>(params.apiUrl, params.botToken, "/v1/bot/sendMessage", {
    channel_id: params.channelId,
    channel_type: params.channelType,
    payload,
    client_msg_no: params.clientMsgNo ?? generateClientMsgNo(),
    ...(params.onBehalfOf ? { on_behalf_of: params.onBehalfOf } : {}),
  }, params.signal);
}

/**
 * 发送一条 InteractiveCard(=17) 卡片消息（octo-server PR #525 P1）。
 *
 * 复用现有 `/v1/bot/sendMessage`，`payload.type=17`，`card` 为标准 Adaptive Cards
 * 1.5 JSON（`octo/v1` profile）。契约要点：
 *   - `card` 由调用方组装为合法 AC1.5 JSON；schema 校验由服务端 `pkg/cardmsg` 权威，
 *     本函数只组包不校验。
 *   - `plain` 出站可附带（老客户端降级用），server 在 dispatch 出口权威重算覆盖。
 *   - `card_version` 固定 `1.5`；含任意 `Input.*`/`Action.Submit` 时 profile 自动为
 *     `octo/v2`，否则使用调用方 profile 或缺省 `octo/v1`。
 *   - `onBehalfOf` 透传保证 persona-clone 身份一致（C3）；注意 OBO + type17 会被
 *     server 在 P1 拒绝（Decision 2b），故仅用于普通 bot 发卡场景。
 *   - 发卡前应先 `getCardProfile` feature-detect（D12）。
 */
function cardContainsInteraction(value: unknown, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => cardContainsInteraction(item, seen));
  const record = value as Record<string, unknown>;
  if (typeof record.type === "string" && (
    record.type.startsWith("Input.") || record.type === "Action.Submit"
  )) return true;
  return Object.values(record).some((item) => cardContainsInteraction(item, seen));
}

function resolveCardProfile(card: Record<string, unknown>, requested?: CardProfile): CardProfile {
  return cardContainsInteraction(card) ? CARD_INTERACTIVE_PROFILE : (requested ?? CARD_PROFILE);
}

export async function sendCardMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  card: Record<string, unknown>;
  /** 展示卡默认 octo/v1；Input.* / Action.Submit 自动升级 octo/v2。 */
  profile?: CardProfile;
  plain?: string;
  mentionUids?: string[];
  mentionEntities?: MentionEntity[];
  mentionAll?: boolean;
  replyMsgId?: string;
  onBehalfOf?: string;
  clientMsgNo?: string;
  signal?: AbortSignal;
}): Promise<SendMessageResult | undefined> {
  if (!params.channelId || !params.channelId.trim()) {
    throw new Error("octo: channelId is required to send a message");
  }
  const payload: Record<string, unknown> = {
    type: MessageType.InteractiveCard,
    card: params.card,
    profile: resolveCardProfile(params.card, params.profile),
    card_version: CARD_VERSION,
  };
  if (typeof params.plain === "string") {
    payload.plain = params.plain;
  }
  if (
    (params.mentionUids && params.mentionUids.length > 0) ||
    (params.mentionEntities && params.mentionEntities.length > 0) ||
    params.mentionAll
  ) {
    const mention: Record<string, unknown> = {};
    if (params.mentionUids && params.mentionUids.length > 0) mention.uids = params.mentionUids;
    if (params.mentionEntities && params.mentionEntities.length > 0) mention.entities = params.mentionEntities;
    if (params.mentionAll) mention.all = 1;
    payload.mention = mention;
  }
  if (params.replyMsgId) {
    payload.reply = { message_id: params.replyMsgId };
  }
  return await postJson<SendMessageResult>(params.apiUrl, params.botToken, "/v1/bot/sendMessage", {
    channel_id: params.channelId,
    channel_type: params.channelType,
    payload,
    client_msg_no: params.clientMsgNo ?? generateClientMsgNo(),
    ...(params.onBehalfOf ? { on_behalf_of: params.onBehalfOf } : {}),
  }, params.signal);
}

export interface CardTemplateRef {
  id: string;
  version: string;
}

export interface CardTemplateViewCapability {
  name: string;
  states: string[];
  wire_profile: string;
  submit_actions: string[];
}

export interface CardTemplateCapability {
  id: string;
  version: string;
  views: CardTemplateViewCapability[];
}

export interface CardTemplatingCapability {
  supported: boolean;
  wire: string;
  templates: CardTemplateCapability[];
}

function validateTemplateFrame(params: {
  templateRef: CardTemplateRef;
  state: string;
  data: object;
}): void {
  const templateRef = params.templateRef as unknown;
  if (templateRef === null || typeof templateRef !== "object" || Array.isArray(templateRef)) {
    throw new Error("octo: templateRef must contain exactly id and version");
  }
  const templateRefKeys = Object.keys(templateRef);
  if (templateRefKeys.length !== 2 ||
      !templateRefKeys.includes("id") ||
      !templateRefKeys.includes("version")) {
    throw new Error("octo: templateRef must contain exactly id and version");
  }
  const { id, version } = templateRef as Record<string, unknown>;
  if (typeof id !== "string" || typeof version !== "string" || !id.trim() || !version.trim()) {
    throw new Error("octo: templateRef id/version are required");
  }
  if (typeof params.state !== "string" || !params.state.trim()) {
    throw new Error("octo: template state is required");
  }
  const data = params.data as unknown;
  if (data === null || typeof data !== "object" || Array.isArray(data) ||
      (Object.getPrototypeOf(data) !== Object.prototype && Object.getPrototypeOf(data) !== null) ||
      !Object.hasOwn(data, "state")) {
    throw new Error("octo: data must be a plain object with own state");
  }
  if ((data as { state: unknown }).state !== params.state) {
    throw new Error("octo: data.state must match state");
  }
}

/**
 * Send one Registry-authored type-17 card without any Model B render-owned fields.
 *
 * `onBehalfOf` is intentionally absent (unlike {@link sendCardMessage}): Registry template cards
 * are bot-authored by design, and OBO + type-17 is rejected by P1 Decision 2b — persona-clone
 * turns skip progress cards entirely in `card-progress.ts`.
 */
export async function sendTemplateCardMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  templateRef: CardTemplateRef;
  state: string;
  data: object;
  clientMsgNo?: string;
  signal?: AbortSignal;
}): Promise<SendMessageResult | undefined> {
  if (!params.channelId.trim()) {
    throw new Error("octo: channelId is required to send a message");
  }
  validateTemplateFrame(params);
  return await postJson<SendMessageResult>(params.apiUrl, params.botToken, "/v1/bot/sendMessage", {
    channel_id: params.channelId,
    channel_type: params.channelType,
    payload: {
      type: MessageType.InteractiveCard,
      template_ref: params.templateRef,
      state: params.state,
      data: params.data,
    },
    client_msg_no: params.clientMsgNo ?? generateClientMsgNo(),
  }, params.signal);
}

/**
 * 就地编辑一条 InteractiveCard(=17) 消息（D6 帧 rewrite，octo-server PR#548）。
 *
 * `POST /v1/bot/message/edit`，`content_edit` 是**完整 type-17 信封的 JSON 字符串**
 * （与 send 对称）。服务端 `cardmsg` 校验 + 权威重算 `plain` + `message_extra` upsert +
 * `SendCMD(CMDSyncMessageExtra)` 扇出;仅能编辑 bot 自己发的、未撤回的卡。
 *
 *   - 不传 `message_seq`（canonical flow，服务端解析）。
 *   - 不带 `card_seq`:adapter dispatch per-group 串行 = 单写者，服务端 last-write-wins;
 *     并发多副本才需 CAS（届时 `card_seq` 需 string/BigInt 以免 JS number 精度丢失）。
 *   - `onBehalfOf` 透传（C3 身份一致）;注意 OBO + type-17 被 P1 Decision 2b 拒，
 *     故调用方应在 persona-clone 场景跳过卡片(见 `card-progress.ts`)。
 */
export async function editCardMessage(params: {
  apiUrl: string;
  botToken: string;
  messageId: string;
  channelId: string;
  channelType: ChannelType;
  card: Record<string, unknown>;
  /** 缺省 octo/v1；Input.* / Action.Submit 自动升级 octo/v2。 */
  profile?: CardProfile;
  /** 交互卡多帧编辑的单调序号；服务端拒绝旧帧/乱序帧。 */
  cardSeq?: number;
  plain?: string;
  /** 进度中间帧标 true → D10 不进修订历史(避免 cap 20 被进度噪音刷屏);终态帧不带 → 进历史。 */
  transient?: boolean;
  onBehalfOf?: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (!params.messageId) {
    throw new Error("octo: messageId is required to edit a card");
  }
  if (!params.channelId || !params.channelId.trim()) {
    throw new Error("octo: channelId is required to edit a card");
  }
  const envelope: Record<string, unknown> = {
    type: MessageType.InteractiveCard,
    card: params.card,
    profile: resolveCardProfile(params.card, params.profile),
    card_version: CARD_VERSION,
  };
  if (typeof params.plain === "string") {
    envelope.plain = params.plain;
  }
  if (params.cardSeq !== undefined) {
    if (!Number.isSafeInteger(params.cardSeq) || params.cardSeq <= 0) {
      throw new Error("octo: cardSeq must be a positive safe integer");
    }
    envelope.card_seq = params.cardSeq;
  }
  // D10:transient 帧不进修订历史侧表(进度中间帧用,避免 cap 20 被刷屏)。
  if (params.transient) {
    envelope.transient = true;
  }
  await postJson(params.apiUrl, params.botToken, "/v1/bot/message/edit", {
    message_id: params.messageId,
    channel_id: params.channelId,
    channel_type: params.channelType,
    content_edit: JSON.stringify(envelope),
    ...(params.onBehalfOf ? { on_behalf_of: params.onBehalfOf } : {}),
  }, params.signal);
}

/** Replace one Registry-authored card frame; raw content_edit is intentionally unavailable. */
export async function editTemplateCardMessage(params: {
  apiUrl: string;
  botToken: string;
  messageId: string;
  channelId: string;
  channelType: ChannelType;
  templateRef: CardTemplateRef;
  state: string;
  data: object;
  cardSeq: number;
  transient?: boolean;
  signal?: AbortSignal;
}): Promise<void> {
  if (!params.messageId) throw new Error("octo: messageId is required to edit a card");
  if (!params.channelId.trim()) throw new Error("octo: channelId is required to edit a card");
  if (!Number.isSafeInteger(params.cardSeq) || params.cardSeq <= 0) {
    throw new Error("octo: cardSeq must be a positive safe integer");
  }
  validateTemplateFrame(params);
  await postJson(params.apiUrl, params.botToken, "/v1/bot/message/edit", {
    message_id: params.messageId,
    channel_id: params.channelId,
    channel_type: params.channelType,
    template_ref: params.templateRef,
    state: params.state,
    data: params.data,
    card_seq: params.cardSeq,
    ...(params.transient ? { transient: true } : {}),
  }, params.signal);
}

/**
 * D12 生产者能力发现 manifest（octo-server PR #525 P2 D12，additive-only）。
 */
export interface CardProfileManifest {
  /**
   * D12 manifest 端点是否**已部署并响应**（非 404）。
   * `false` 表示端点尚未上线（PR-D 未落地）—— 调用方应回退到 adapter 侧 config
   * 显式开关决定是否发卡,**不可**把它等同于「服务端明确关闭」。
   */
  available: boolean;
  /** 卡片消息是否启用（OCTO_CARD_MESSAGE_ENABLED）。禁用时 server 仍返 200 + manifest。 */
  enabled: boolean;
  /** 支持的 profile 列表，如 `["octo/v1"]`（P2 增 `"octo/v2"`）。 */
  profiles?: string[];
  card_version?: string;
  /**
   * 服务端 advertise 的元素/输入白名单（源自 pkg/cardmsg 权威，additive）。producer 据此按
   * 元素/输入粒度协商 —— 即便 card_version 停在 1.5，也能探测该部署到底吃不吃某元素/输入。
   * 旧部署不返这两字段（undefined）→ 消费方回退保守基线。
   */
  elements?: string[];
  inputs?: string[];
  /**
   * 本地/导航动作白名单(pkg/cardmsg 权威):`Action.ToggleVisibility`/
   * `Action.CopyToClipboard`/`Action.OpenUrl`。回流 `Action.Submit` 不在此数组中；它由
   * `profiles` 包含 `octo/v2` 表示，也不得放进展示卡 selectAction。
   * 旧部署不返该字段(undefined) → 消费方保守视为不支持任何 action。
   */
  actions?: string[];
  /** 尺寸/结构上限（node/depth/body caps 等）。 */
  limits?: Record<string, unknown>;
  /** Optional Registry template-ref/v1 capability and explicit Bot catalog. */
  templating?: CardTemplatingCapability;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseTemplatingCapability(value: unknown): CardTemplatingCapability | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  const templates: CardTemplateCapability[] = [];
  for (const candidate of Array.isArray(root.templates) ? root.templates : []) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const template = candidate as Record<string, unknown>;
    if (typeof template.id !== "string" || typeof template.version !== "string") continue;
    const views: CardTemplateViewCapability[] = [];
    for (const candidateView of Array.isArray(template.views) ? template.views : []) {
      if (!candidateView || typeof candidateView !== "object" || Array.isArray(candidateView)) continue;
      const view = candidateView as Record<string, unknown>;
      if (typeof view.name !== "string" || typeof view.wire_profile !== "string") continue;
      views.push({
        name: view.name,
        wire_profile: view.wire_profile,
        states: stringArray(view.states),
        submit_actions: stringArray(view.submit_actions),
      });
    }
    templates.push({ id: template.id, version: template.version, views });
  }
  return {
    supported: root.supported === true,
    wire: typeof root.wire === "string" ? root.wire : "",
    templates,
  };
}

/**
 * GET /v1/bot/card/profile — D12 能力发现。发卡前 feature-detect，避免用发送试探
 * （一个 400 无法区分「disabled」与「invalid」）。
 *
 * 返回 `available` 区分两种「不发」语义（避免 gate 死锁）:
 *   - 端点未部署（404）→ `{ available:false }`：调用方回退 adapter config 显式开关，
 *     **不可**当作服务端明确关闭（octo-server PR-D 上线前 R2 未落地即此情形）。
 *   - 端点已部署但 `enabled:false` → `{ available:true, enabled:false }`：服务端明确关，不发。
 * 传输 / 5xx 抛错，交由调用方重试节奏处理。
 */
export async function getCardProfile(params: {
  apiUrl: string;
  botToken: string;
  signal?: AbortSignal;
}): Promise<CardProfileManifest> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/card/profile`;
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  // 端点尚未部署（PR-D 未落地）→ available:false，调用方回退 config 显式开关，
  // 不可当作「服务端明确关闭」硬降级不发。
  if (resp.status === 404) return { available: false, enabled: false };
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Bot API GET /v1/bot/card/profile failed (${resp.status}): ${text || resp.statusText}`);
  }
  // 端点已部署（available:true）；manifest 内容异常时保守视作 enabled:false。
  const raw = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") return { available: true, enabled: false };
  const templating = parseTemplatingCapability(raw.templating);
  return {
    available: true,
    // 兼容布尔与 1/0 序列化(与本仓 GroupMember.robot / getMentionPref 的 flag 惯例一致)。
    enabled: raw.enabled === true || raw.enabled === 1,
    ...(Array.isArray(raw.profiles) ? { profiles: (raw.profiles as unknown[]).filter((e): e is string => typeof e === "string") } : {}),
    ...(typeof raw.card_version === "string" ? { card_version: raw.card_version } : {}),
    ...(Array.isArray(raw.elements) ? { elements: (raw.elements as unknown[]).filter((e): e is string => typeof e === "string") } : {}),
    ...(Array.isArray(raw.inputs) ? { inputs: (raw.inputs as unknown[]).filter((e): e is string => typeof e === "string") } : {}),
    ...(Array.isArray(raw.actions) ? { actions: (raw.actions as unknown[]).filter((e): e is string => typeof e === "string") } : {}),
    ...(raw.limits && typeof raw.limits === "object" ? { limits: raw.limits as Record<string, unknown> } : {}),
    ...(templating ? { templating } : {}),
  };
}

/** Pull typed bot events strictly after the supplied cursor. This endpoint is short-polling. */
export async function fetchBotEvents(params: {
  apiUrl: string;
  botToken: string;
  sinceEventId?: number;
  limit?: number;
  signal?: AbortSignal;
}): Promise<BotEvent[]> {
  const response = await postJson<{ results?: BotEvent[] }>(
    params.apiUrl,
    params.botToken,
    "/v1/bot/events",
    {
      event_id: params.sinceEventId ?? 0,
      limit: Math.max(1, Math.min(100, Math.floor(params.limit ?? 20))),
    },
    params.signal ?? AbortSignal.timeout(EVENTS_POLL_TIMEOUT_MS),
  );
  return Array.isArray(response?.results) ? response.results : [];
}

/** Best-effort queue pruning after a recognized bot event has been accepted locally. */
export async function ackBotEvent(params: {
  apiUrl: string;
  botToken: string;
  eventId: number;
  signal?: AbortSignal;
}): Promise<void> {
  await postJson(
    params.apiUrl,
    params.botToken,
    `/v1/bot/events/${params.eventId}/ack`,
    {},
    params.signal ?? AbortSignal.timeout(EVENTS_POLL_TIMEOUT_MS),
  );
}

export async function sendTyping(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  onBehalfOf?: string;
  signal?: AbortSignal;
}): Promise<void> {
  await postJson(params.apiUrl, params.botToken, "/v1/bot/typing", {
    channel_id: params.channelId,
    channel_type: params.channelType,
    ...(params.onBehalfOf ? { on_behalf_of: params.onBehalfOf } : {}),
  }, params.signal);
}

export async function sendReadReceipt(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  messageIds?: string[];
  signal?: AbortSignal;
}): Promise<void> {
  await postJson(params.apiUrl, params.botToken, "/v1/bot/readReceipt", {
    channel_id: params.channelId,
    channel_type: params.channelType,
    ...(params.messageIds && params.messageIds.length > 0 ? { message_ids: params.messageIds } : {}),
  }, params.signal);
}

export async function sendHeartbeat(params: {
  apiUrl: string;
  botToken: string;
  signal?: AbortSignal;
}): Promise<void> {
  await postJson(params.apiUrl, params.botToken, "/v1/bot/heartbeat", {}, params.signal);
}

/**
 * docs 后端明确拒绝了这条评论(2xx 但信封是失败)。与传输故障区分开:重试它没有
 * 意义 —— 「文档不存在」重试三次仍然不存在,只会在轮询器的串行循环里白烧 3 次
 * POST 和 600ms,而后续的兜底通知还会再烧一遍同样的三次。
 */
export class DocCommentRejectedError extends Error {
  readonly name = "DocCommentRejectedError";
}

/**
 * 这个错误重试也不会变好吗?
 *
 * 信封拒绝 = 确定性失败。4xx 同理,但排除 408 / 423 / 425 / 429 —— 那几个是
 * 「稍后再来」的语义。其余(网络、5xx、超时)都值得重试。
 */
export function isPermanentDocCommentFailure(err: unknown): boolean {
  if (err instanceof DocCommentRejectedError) return true;
  const status = httpStatusFromApiFetchError(err);
  if (status === undefined) return false;
  // 408 请求超时 / 423 资源被锁(文档正被并发编辑)/ 425 太早 / 429 限流 —— 这四个
  // 都是「稍后再来」的语义,重试有意义。其余 4xx 重试不会变好。
  if (status === 408 || status === 423 || status === 425 || status === 429) return false;
  return status >= 400 && status < 500;
}

/**
 * 在文档评论串下发布一条 Bot 评论(docs domain,与 IM 消息无关)。
 *
 * 文档任务的最终答复走这条出口而不是 sendMessage:合成消息是 DM 形状的,
 * 走 IM 出口会把答复发进发起人的私聊 —— 正是本特性要消除的污染。
 * parentId 省略时发布为根评论。
 */
export async function postDocComment(params: {
  apiUrl: string;
  botToken: string;
  docId: string;
  body: string;
  parentId?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const path = `/v1/bot/docs/${encodeURIComponent(params.docId)}/comments`;
  const result = await postJson<{ status?: unknown; msg?: unknown; message?: unknown }>(
    params.apiUrl,
    params.botToken,
    path,
    {
      body: params.body,
      ...(params.parentId !== undefined ? { parentId: params.parentId } : {}),
    },
    // 必须有界。多处调用点不传 signal(handler 的兜底通知、会话冲突回执、
    // deliver() 的正常答复),而这条 POST 是在轮询器的单条循环里 await 的:
    // docs 后端接了连接却不回包,handleDocMention 就永不返回,该账号的文档任务
    // 和卡片事件一起停到重启为止。hang 不是 try/catch 能接住的。
    params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  );

  // 平台返回的是 {status, ...} 信封,业务失败(文档不存在、无评论权限、正文超长)
  // 一样可能是 HTTP 200。而这条 POST 的成败是整个特性**唯一**的投递凭证 —— 只看
  // response.ok 会把业务失败记成「已投递」,进而写入去重、永不重投。
  //
  // 断言的是**成功形状**而不是「不等于某个已知失败值」:接口尚未对着真实 docs 后端
  // 验证过,`{"status":"0"}` 这种字符串型状态完全可能出现,只否定数字 0 会放它过去。
  if (result && typeof result === "object" && !Array.isArray(result) && "status" in result) {
    const { status } = result;
    const ok = status === 1 || status === "1";
    if (!ok) {
      const detail = result.msg ?? result.message;
      throw new DocCommentRejectedError(
        `Octo API ${path} rejected the comment (status=${String(status)})${detail ? `: ${String(detail)}` : ""}`,
      );
    }
  }
}



export async function registerBot(params: {
  apiUrl: string;
  botToken: string;
  forceRefresh?: boolean;
  agentPlatform?: string;
  agentVersion?: string;
  pluginVersion?: string;
  signal?: AbortSignal;
}): Promise<{
  robot_id: string;
  im_token: string;
  ws_url: string;
  api_url: string;
  owner_uid: string;
  owner_channel_id: string;
}> {
  const path = params.forceRefresh
    ? "/v1/bot/register?force_refresh=true"
    : "/v1/bot/register";
  const body: Record<string, string> = {};
  if (params.agentPlatform) body.agent_platform = params.agentPlatform;
  if (params.agentVersion) body.agent_version = params.agentVersion;
  if (params.pluginVersion) body.plugin_version = params.pluginVersion;
  const result = await postJson<{
    robot_id: string;
    im_token: string;
    ws_url: string;
    api_url: string;
    owner_uid: string;
    owner_channel_id: string;
  }>(params.apiUrl, params.botToken, path, body, params.signal);
  if (!result) throw new Error("Octo bot registration returned empty response");
  return result;
}

// Fetch the groups the bot belongs to
export async function fetchBotGroups(params: {
  apiUrl: string;
  botToken: string;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<Array<{ group_no: string; name: string }>> {
  const url = `${params.apiUrl}/v1/bot/groups`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${params.botToken}`,
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    params.log?.error?.(`octo: fetchBotGroups failed: ${resp.status}`);
    return [];
  }
  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}

/**
 * 获取群成员列表
 */
export interface GroupMember {
  uid: string;
  name: string;
  role?: string;    // admin/member
  // 是否是机器人。后端把该 flag 序列化成数字（1/0），但历史上也出现过 boolean，
  // 故类型放宽为 boolean | number；消费端须同时认 `=== true` 和 `=== 1`。
  robot?: boolean | number;
}

export async function getGroupMembers(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;  // 群 ID (channel_id)
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<GroupMember[]> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${params.groupNo}/members`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${params.botToken}`,
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const msg = `getGroupMembers failed: ${resp.status}`;
    params.log?.error?.(`octo: ${msg}`);
    throw new Error(msg);
  }
  const data = await resp.json();
  // Normalize to strict array to prevent silent failures
  const members = Array.isArray(data?.members)
    ? data.members
    : Array.isArray(data)
      ? data
      : [];
  return members as GroupMember[];
}

/**
 * 获取群信息
 */
export async function getGroupInfo(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<{ group_no: string; name: string; [key: string]: unknown }> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${params.groupNo}`;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.botToken}`,
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!resp.ok) {
      params.log?.error?.(`octo: getGroupInfo failed: ${resp.status}`);
      throw new Error(`getGroupInfo failed: ${resp.status}`);
    }
    return await resp.json();
  } catch (err) {
    params.log?.error?.(`octo: getGroupInfo error: ${err}`);
    throw err;
  }
}

/**
 * 群级免@偏好（per-group mention preference）。
 *
 * 后端 octo-server#237 暴露 GET /v1/bot/groups/:group_no/mention_pref。
 * 两个权限轴 AND 合成（octo-server YUJ-2996）：
 *  - `no_mention`：bot 主人意愿（bot_mention_pref，无记录=false）
 *  - `group_allow_no_mention`：群主/管理员的群级总开关（group.allow_no_mention，
 *    无群记录回退默认 true=允许）
 *  - `effective = no_mention && group_allow_no_mention`：最终是否免@即可触发。
 *
 * gate 只看 `effective`。`no_mention` / `group_allow_no_mention` 保留供观测/日志，
 * 并为旧 server（仅返回 no_mention）提供回退。
 */
export interface MentionPref {
  /** bot 主人意愿轴。旧 server 只有这个字段。 */
  no_mention: boolean;
  /** 群级总开关轴；无群记录回退 true（允许）。 */
  group_allow_no_mention: boolean;
  /** 两轴 AND：免@即可触发回复。gate 据此决策。 */
  effective: boolean;
}

/**
 * 获取某群对当前 bot 的免@偏好。
 *
 * 失败（网络错误 / 非 2xx / 解析失败）一律回退到账号级行为
 * （effective=false，即保持需@），绝不抛错，避免 gate 崩溃。
 *
 * 兼容旧 server：YUJ-2996 之前的 server 只返回 `{ no_mention }`，没有
 * `effective` / `group_allow_no_mention`。此时 group 轴缺省视为 true（允许），
 * effective 回退为 no_mention，行为与升级前完全一致（零回归）。
 */
export async function getMentionPref(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;  // 父群 group_no（thread 复合 channel_id 须先取父群）
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<MentionPref> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/mention_pref`;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.botToken}`,
      },
      signal: AbortSignal.timeout(MENTION_PREF_TIMEOUT_MS),
    });
    if (!resp.ok) {
      // 404 = the mention_pref endpoint isn't deployed yet (expected during
      // rollout before octo-server#237 ships); 401 = empty/short-lived Bearer.
      // Both are benign — we fall back to effective=false below — and recur on
      // every inbound message, so logging them at error level (compounded by
      // the 30s negative-cache TTL) makes a healthy rollout look broken. Log
      // expected statuses at info and reserve error for genuinely unexpected
      // responses (5xx, etc.).
      const expected = resp.status === 404 || resp.status === 401;
      const msg = `octo: getMentionPref(${params.groupNo}) failed: ${resp.status}`;
      if (expected) params.log?.info?.(msg);
      else params.log?.error?.(msg);
      return { no_mention: false, group_allow_no_mention: true, effective: false };
    }
    const data = await resp.json();
    // Accept boolean `true` or numeric `1` (DB/JSON may serialize either),
    // mirroring the mention.{all,ais,humans} coercion in inbound.ts.
    const noMention = data?.no_mention === true || data?.no_mention === 1;
    // Old server omits group_allow_no_mention → default true (allow), so the
    // group axis is a no-op and effective degrades to noMention (zero regression).
    const groupAllow = data?.group_allow_no_mention === undefined
      ? true
      : data.group_allow_no_mention === true || data.group_allow_no_mention === 1;
    // Old server omits effective → fall back to the AND of the two axes (which,
    // with groupAllow defaulting true, equals noMention).
    const effective = data?.effective === undefined
      ? noMention && groupAllow
      : data.effective === true || data.effective === 1;
    return { no_mention: noMention, group_allow_no_mention: groupAllow, effective };
  } catch (err) {
    params.log?.error?.(`octo: getMentionPref(${params.groupNo}) error: ${err}`);
    return { no_mention: false, group_allow_no_mention: true, effective: false };
  }
}

// Fetch GROUP.md content for a group
export async function getGroupMd(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<{ content: string; version: number; updated_at: string | null; updated_by: string }> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${params.groupNo}/md`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${params.botToken}`,
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`getGroupMd failed (${resp.status}): ${text || resp.statusText}`);
  }
  return await resp.json();
}

/**
 * Get thread THREAD.md content (throws on non-2xx — used by agent-tools).
 * GET /v1/bot/groups/{groupNo}/threads/{shortId}/md
 *
 * See also: group-md.ts `fetchThreadMdFromApi()` which returns null on error
 * and is used for background cache refresh where failures are non-fatal.
 */
export async function getThreadMd(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<{ content: string; version: number; updated_at: string | null; updated_by: string }> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}/md`;
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`getThreadMd failed (${resp.status}): ${text || resp.statusText}`);
  }
  return await resp.json();
}

/**
 * Update thread THREAD.md content (requires bot_admin permission).
 * PUT /v1/bot/groups/{groupNo}/threads/{shortId}/md
 *
 * Content size limit: 10,240 bytes (server-side GetGroupMdMaxSize()).
 */
export async function updateThreadMd(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
  content: string;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<{ version: number }> {
  const contentSize = new TextEncoder().encode(params.content).byteLength;
  if (contentSize > 10240) {
    throw new Error(`updateThreadMd: content size (${contentSize} bytes) exceeds maximum 10,240 bytes`);
  }

  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}/md`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      ...DEFAULT_HEADERS,
      Authorization: `Bearer ${params.botToken}`,
    },
    body: JSON.stringify({ content: params.content }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`updateThreadMd failed (${resp.status}): ${text || resp.statusText}`);
  }
  return await resp.json();
}

// Update GROUP.md content for a group (requires bot_admin permission)
export async function updateGroupMd(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  content: string;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<{ version: number }> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${params.groupNo}/md`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      ...DEFAULT_HEADERS,
      Authorization: `Bearer ${params.botToken}`,
    },
    body: JSON.stringify({ content: params.content }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`updateGroupMd failed (${resp.status}): ${text || resp.statusText}`);
  }
  return await resp.json();
}

// ---- Bot JSON Request Helper ----

/**
 * Generic helper for bot JSON API requests (GET / PUT / DELETE).
 * Centralizes URL construction, auth headers, timeout, and error handling.
 *
 * @throws Error on non-2xx responses with status code and response body.
 */
async function botFetchJson<T = void>(params: {
  apiUrl: string;
  botToken: string;
  path: string;
  method: "GET" | "PUT" | "DELETE";
  body?: Record<string, unknown>;
}): Promise<T> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}${params.path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.botToken}`,
  };
  if (params.body) {
    Object.assign(headers, DEFAULT_HEADERS);
  }
  const resp = await fetch(url, {
    method: params.method,
    headers,
    body: params.body ? JSON.stringify(params.body) : undefined,
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Bot API ${params.method} ${params.path} failed (${resp.status}): ${text || resp.statusText}`,
    );
  }
  if (params.method === "GET") {
    return (await resp.json()) as T;
  }
  return undefined as T;
}

// ---- Voice Context API ----

/**
 * Query the owner's personal voice correction context.
 * GET /v1/bot/voice/context
 *
 * Returns normalized response with defensive defaults:
 * - has_context defaults to false if missing from backend response
 * - context defaults to empty string if missing
 * - updated_at defaults to empty string if missing
 */
export async function getVoiceContext(params: {
  apiUrl: string;
  botToken: string;
}): Promise<{ has_context: boolean; context: string; updated_at: string }> {
  const raw = await botFetchJson<Record<string, unknown>>({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    path: "/v1/bot/voice/context",
    method: "GET",
  });

  // Defensive normalization — do not blindly pass-through.
  // If backend omits has_context, treat as false.
  return {
    has_context: raw.has_context === true,
    context: typeof raw.context === "string" ? raw.context : "",
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : "",
  };
}

/**
 * Set the owner's personal voice correction context (PUT upsert).
 * PUT /v1/bot/voice/context
 *
 * Content must not be empty — empty strings are rejected at the adapter
 * validation layer (agent-tools.ts) before this function is called.
 * Backend also rejects empty context with 400.
 */
export async function updateVoiceContext(params: {
  apiUrl: string;
  botToken: string;
  content: string;
}): Promise<void> {
  await botFetchJson({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    path: "/v1/bot/voice/context",
    method: "PUT",
    body: { context: params.content },
  });
}

/**
 * Delete the owner's personal voice correction context.
 * DELETE /v1/bot/voice/context
 *
 * Idempotent — deleting a non-existent record returns 200.
 */
export async function deleteVoiceContext(params: {
  apiUrl: string;
  botToken: string;
}): Promise<void> {
  await botFetchJson({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    path: "/v1/bot/voice/context",
    method: "DELETE",
  });
}

// ---- OBO Grant API (persona clone introspection) ----

/**
 * Bot-side view of its own OBO grant — used by persona clones to fetch
 * the active `persona_prompt` so it can be injected into the LLM system
 * prompt via the before_prompt_build hook (GH octo-adapters#68).
 *
 * Returned by GET /v1/bot/obo-grant (octo-server YUJ-1762). The bot is
 * identified by its botToken; the server resolves the grant where this
 * bot is the grantee.
 */
export interface BotOboGrant {
  /** False / absent when the bot has no active grant (regular non-persona bot). */
  has_grant: boolean;
  grantor_uid?: string;
  grantor_name?: string;
  persona_prompt?: string;
  /** Whether the grant is currently active (mode != "paused" & not revoked). */
  active?: boolean;
}

/**
 * GET /v1/bot/obo-grant — fetch this bot's own OBO grant info.
 *
 * Returns null when:
 *  - the bot has no grant (404)
 *  - the server reports has_grant=false
 *  - the response is malformed
 *
 * Throws on transport / 5xx errors so the caller's retry-on-next-tick
 * cadence (see persona-prompt.ts) can decide whether to log and skip.
 */
export async function getBotOboGrant(params: {
  apiUrl: string;
  botToken: string;
}): Promise<BotOboGrant | null> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/obo-grant`;
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  // 404 = no grant for this bot (regular bot, not a persona clone).
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Bot API GET /v1/bot/obo-grant failed (${resp.status}): ${text || resp.statusText}`,
    );
  }
  const raw = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") return null;
  // Accept grant when `has_grant: true` is explicit, OR when the field is
  // absent (undefined) and the response contains a `grantor_uid` — some
  // server versions omit `has_grant` entirely.  An explicit `has_grant: false`
  // is authoritative denial and must fail closed.
  const hasGrant = raw.has_grant === true ||
    (raw.has_grant === undefined &&
      typeof raw.grantor_uid === "string" &&
      raw.grantor_uid.length > 0);
  if (!hasGrant) return null;
  return {
    has_grant: true,
    grantor_uid: typeof raw.grantor_uid === "string" ? raw.grantor_uid : undefined,
    grantor_name: typeof raw.grantor_name === "string" ? raw.grantor_name : undefined,
    persona_prompt: typeof raw.persona_prompt === "string" ? raw.persona_prompt : undefined,
    active: raw.active === true,
  };
}

// ---- Secret Resolve API (user-managed external keys) ----

/**
 * One candidate when an alias matches more than one stored secret.
 *
 * 🔴 SECURITY: candidates carry ONLY non-sensitive identifiers
 * (display_name + secret_id). The plaintext secret value is NEVER part of a
 * candidate — disambiguation happens on labels alone so nothing sensitive is
 * surfaced while the caller is still deciding which secret to use.
 */
export interface SecretCandidate {
  /** Stable opaque id of the secret (safe to echo back for re-resolution). */
  secret_id?: string;
  /** Human-facing label the owner gave the secret. Safe to show. */
  display_name: string;
}

/**
 * Result of resolving a secret alias for the bot's owner.
 *
 * Discriminated on `status`:
 *  - `resolved`     → exactly one EXACT match; `value` holds the plaintext secret.
 *  - `not_found`    → no secret matches the alias; the owner must add it first.
 *  - `ambiguous`    → server needs confirmation; `candidates` lists labels for the
 *                     caller to re-resolve against (no plaintext). Per octo-server
 *                     PR#301 this covers BOTH "exact name hit >1" AND "any
 *                     pinyin/fuzzy hit, even exactly one candidate" — a single
 *                     fuzzy candidate must still be confirmed, never auto-used.
 *  - `rate_limited` → the per-IP resolve limiter rejected this call (HTTP 429);
 *                     the caller should back off and retry.
 *
 * 🔴 RED LINE: the `value` field on the `resolved` variant is the ONLY place
 * plaintext appears. Callers must consume it internally (e.g. write it to a
 * local file) and MUST NOT propagate it into any LLM-visible return value,
 * transcript, message, or log. See agent-tools.ts `write-secret`.
 */
export type ResolveSecretResult =
  | { status: "resolved"; value: string; secret_id?: string; display_name?: string }
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: SecretCandidate[] }
  | { status: "rate_limited" };

/**
 * Resolve a user-managed external-key alias to its current plaintext value.
 *
 * POST /v1/bot/secrets/resolve  (octo-server YUJ-3538)
 *
 * Auth & ownership: the request carries only the plugin's bot token
 * (`bf_...`). The server authenticates the bot and resolves the alias against
 * the secrets owned by THAT bot's owner — the plugin never sends, sees, or
 * needs the owner's identity beyond the token it already holds.
 *
 * Use-time resolution: this is called on every write so the latest plaintext
 * is always fetched. If the owner rotates the key, the next call picks it up
 * with zero restart and zero cache invalidation.
 *
 * Contract (octo-server PR#301, docs/user-secret-alias-api.md):
 *  - 200 `{ secret_id?, value }` → exact unique hit; `value` is the plaintext.
 *  - 422 → ambiguous: the i18n error envelope carries the (masked) candidates at
 *    `error.details.candidates`. Triggered by an exact name hit on >1 row OR ANY
 *    pinyin/fuzzy hit (even a single candidate). Normalized to
 *    `{ status: "ambiguous", candidates }`.
 *  - 404 → not_found (also covers "endpoint not deployed yet during rollout").
 *  - 429 → the per-IP resolve limiter rejected this call. Normalized to
 *    `{ status: "rate_limited" }` so the caller can surface a back-off hint.
 *  - any other non-2xx → throws (caller surfaces a non-plaintext "resolve
 *    failed, please re-set" message).
 *
 * For backward compatibility a 200 body still carrying `status:"ambiguous"` /
 * `status:"not_found"` is honored, but the HTTP status is authoritative.
 *
 * 🔴 SECURITY: on a thrown non-2xx the Error message contains ONLY the HTTP
 * status — never the response body and never a resolved value. The body is
 * deliberately dropped because this error reaches an LLM-visible tool result
 * and a resolve-endpoint error body could carry secret-bearing diagnostics.
 */
export async function resolveSecret(params: {
  apiUrl: string;
  botToken: string;
  /** Alias the owner referenced: a display_name or a secret_id. */
  alias: string;
  signal?: AbortSignal;
}): Promise<ResolveSecretResult> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/secrets/resolve`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      ...DEFAULT_HEADERS,
      Authorization: `Bearer ${params.botToken}`,
    },
    // 🔴 The server binds the request field `query` (BindJSON → req.Query) and
    // 400s when it is empty. The function input is still named `alias` for
    // callers, but the wire field MUST be `query` — `query` accepts either a
    // secret_id or a display_name, matching the `alias` semantics.
    body: JSON.stringify({ query: params.alias }),
    signal: params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  // 404 = alias not found for this owner (or endpoint not deployed yet during
  // rollout). Both degrade to a benign "not_found" so the caller can guide the
  // user to add the secret rather than surfacing a hard error.
  if (resp.status === 404) {
    return { status: "not_found" };
  }

  // 422 = ambiguous. The server returns the i18n error envelope; the masked
  // candidate list lives at `error.details.candidates`. This is NOT an HTTP
  // failure to surface — it is a normal "needs confirmation" outcome, so we
  // parse it here instead of letting it fall into the throw branch below.
  // 🔴 SECURITY: candidates carry ONLY masked identifiers (display_name,
  // secret_id, kind, masked) — never the plaintext value — so reading this
  // specific body is safe. We still read NOTHING from any other error body.
  if (resp.status === 422) {
    const raw = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
    const error = (raw?.error ?? {}) as Record<string, unknown>;
    const details = (error.details ?? {}) as Record<string, unknown>;
    const rawCandidates = Array.isArray(details.candidates) ? details.candidates : [];
    return { status: "ambiguous", candidates: parseCandidates(rawCandidates) };
  }

  // 429 = the per-IP resolve limiter (StrictIPRateLimitMiddleware,
  // tag=usersecret_resolve) rejected this call. Surface a recognizable
  // back-off outcome rather than a generic error.
  // 🔴 SECURITY: do NOT read the body — a rate-limit response is not expected to
  // carry a value, and the no-body-in-error invariant for this endpoint stands.
  if (resp.status === 429) {
    return { status: "rate_limited" };
  }

  if (!resp.ok) {
    // 🔴 SECURITY: never fold the response body into the error. A resolve
    // endpoint handles plaintext secrets; a 5xx/diagnostic body could echo a
    // resolved value or other sensitive material. This error bubbles up to an
    // LLM-visible tool result, so it must carry the HTTP status ONLY — no body.
    throw new Error(`resolveSecret failed (${resp.status})`);
  }

  const raw = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") {
    throw new Error("resolveSecret returned an unparseable response");
  }

  const status = raw.status;

  // Backward-compat: honor a legacy 200 body that still carries an explicit
  // status discriminator. The current server (PR#301) instead signals these via
  // HTTP status (404/422), handled above; a 200 body simply carries the value.
  if (status === "not_found") {
    return { status: "not_found" };
  }

  if (status === "ambiguous") {
    const rawCandidates = Array.isArray(raw.candidates) ? raw.candidates : [];
    return { status: "ambiguous", candidates: parseCandidates(rawCandidates) };
  }

  // Resolved: the current server returns 200 `{ secret_id?, value }` WITHOUT a
  // status field, so a 200 carrying a non-empty `value` is the resolved case.
  // A legacy `status:"resolved"` body is also accepted. Anything else is treated
  // as a malformed resolved response (missing value) and rejected.
  if (status === "resolved" || (status === undefined && "value" in raw)) {
    if (typeof raw.value !== "string" || raw.value.length === 0) {
      throw new Error("resolveSecret resolved a secret with no value");
    }
    return {
      status: "resolved",
      value: raw.value,
      secret_id: typeof raw.secret_id === "string" ? raw.secret_id : undefined,
      display_name: typeof raw.display_name === "string" ? raw.display_name : undefined,
    };
  }

  // 🔴 SECURITY: never fold the server-supplied status string into the error.
  // This error bubbles up to an LLM-visible tool result; echoing a
  // server-controlled value back into the transcript is an injection vector.
  // Use a fixed message — the unexpected status is unusable to the caller anyway.
  throw new Error("resolveSecret returned an unknown status");
}

/**
 * Map a raw candidate array (from a 422 `error.details.candidates` envelope or a
 * legacy 200 ambiguous body) into label-only SecretCandidate entries.
 *
 * 🔴 SECURITY: deliberately copies ONLY `display_name` + `secret_id` — never any
 * `value`/`masked`/other server field — so nothing sensitive leaks into the
 * disambiguation surface the LLM eventually sees. Entries with no label are
 * dropped: a candidate the caller can't show the user is useless.
 */
function parseCandidates(rawCandidates: unknown[]): SecretCandidate[] {
  return rawCandidates
    .map((c) => {
      const obj = (c ?? {}) as Record<string, unknown>;
      const displayName = typeof obj.display_name === "string" ? obj.display_name : "";
      const secretId = typeof obj.secret_id === "string" ? obj.secret_id : undefined;
      return { display_name: displayName, secret_id: secretId };
    })
    .filter((c) => c.display_name.length > 0);
}

/** Decoded payload from base64 message content */
interface SyncMessagePayload {
  type?: number;
  content?: string;
  url?: string;
  name?: string;
  mention?: {
    all?: boolean;
    uids?: string[];
  };
}

/**
 * 获取频道历史消息（用于注入上下文）
 * @param params.log - Optional logger for consistent logging with OpenClaw log system
 */
export async function getChannelMessages(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  limit?: number;
  startMessageSeq?: number;
  endMessageSeq?: number;
  signal?: AbortSignal;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<Array<{ from_uid: string; content: string; timestamp: number; message_id?: string; message_seq?: number; type?: number; url?: string; name?: string; payload?: SyncMessagePayload }>> {
  try {
    const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/messages/sync`;
    const limit = params.limit ?? 20;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.botToken}`,
      },
      body: JSON.stringify({
        channel_id: params.channelId,
        channel_type: params.channelType,
        limit,
        start_message_seq: params.startMessageSeq ?? 0,
        end_message_seq: params.endMessageSeq ?? 0,
        pull_mode: 1,  // 1 = pull up (newer messages)
      }),
      signal: params.signal,
    });

    if (!response.ok) {
      params.log?.info?.(`octo: getChannelMessages failed: ${response.status}`);
      return [];
    }

    const text = await response.text();
    const data = text
      ? parseOctoJson<{ messages?: any[] }>(text)
      : {};
    const messages = data.messages ?? [];
    return messages.map((m: any) => {
      // payload is base64-encoded JSON string
      let payload: SyncMessagePayload = {};
      if (m.payload) {
        try {
          const decoded = Buffer.from(m.payload, "base64").toString("utf-8");
          payload = JSON.parse(decoded);
        } catch (decodeErr) {
          params.log?.info?.(`octo: payload decode failed for msg ${m.message_id ?? "unknown"}: ${decodeErr}`);
          // If decoding fails, try treating payload as already-parsed object
          payload = typeof m.payload === "object" ? m.payload : {};
        }
      }
      return {
        from_uid: m.from_uid ?? "unknown",
        message_id: m.message_id ?? undefined,
        message_seq: m.message_seq ?? undefined,
        type: payload.type ?? undefined,
        url: payload.url ?? undefined,
        name: payload.name ?? undefined,
        content: payload.content ?? "",
        payload,  // preserve full payload for types that need nested data (e.g. MultipleForward)
        // Convert seconds to milliseconds (API returns seconds, internal standard is ms)
        timestamp: (m.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
      };
    });
  } catch (err) {
    params.log?.error?.(`octo: getChannelMessages error: ${err}`);
    return [];
  }
}

/**
 * Get a presigned PUT URL for direct, backend-agnostic file upload.
 *
 * Calls the server's `GET /v1/bot/upload/presigned` route, which signs a PUT
 * URL against whatever object storage the deployment is configured with
 * (MinIO / COS / S3 / OSS). This replaces the old COS-only STS-credentials
 * path so self-hosted Docker+MinIO deployments (no Tencent COS config) can
 * upload too — same presigned link the web/iOS/Android clients use.
 *
 * `fileSize` is REQUIRED and must be the exact byte count of the body the
 * caller is about to PUT: on SigV4 backends (MinIO/COS) it is signed into the
 * canonical headers as Content-Length, so any mismatch at PUT time returns
 * 403 SignatureDoesNotMatch. Callers MUST pass `statSync().size` of the real
 * payload, never a HEAD Content-Length guess.
 */
export async function getUploadPresign(params: {
  apiUrl: string;
  botToken: string;
  filename: string;
  fileSize: number;
  contentType?: string;
  signal?: AbortSignal;
}): Promise<{
  uploadUrl: string;
  downloadUrl: string;
  contentType: string;
  contentDisposition?: string;
}> {
  if (!Number.isInteger(params.fileSize) || params.fileSize <= 0) {
    throw new Error(
      `getUploadPresign requires a positive integer fileSize (got ${params.fileSize})`,
    );
  }
  const query = new URLSearchParams({
    filename: params.filename,
    fileSize: String(params.fileSize),
  });
  if (params.contentType) query.set("contentType", params.contentType);
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/upload/presigned?${query}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${params.botToken}`,
    },
    signal: params.signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Octo API /v1/bot/upload/presigned failed (${response.status}): ${text || response.statusText}`);
  }
  const data = await response.json() as any;
  if (typeof data.uploadUrl !== "string" || typeof data.downloadUrl !== "string") {
    throw new Error(`Octo API /v1/bot/upload/presigned returned incomplete response: missing ${
      ['uploadUrl', 'downloadUrl'].filter(k => typeof data[k] !== "string").join(', ')
    }`);
  }
  return {
    uploadUrl: data.uploadUrl,
    downloadUrl: data.downloadUrl,
    contentType: typeof data.contentType === "string" ? data.contentType : "application/octet-stream",
    contentDisposition: typeof data.contentDisposition === "string" ? data.contentDisposition : undefined,
  };
}

/**
 * Upload a file body with a single PUT to a server-issued presigned URL.
 *
 * The body must be exactly `fileSize` bytes — the same value passed to
 * {@link getUploadPresign} so the signed Content-Length matches (SigV4
 * backends 403 otherwise). `contentType` and `contentDisposition` are
 * replayed verbatim from the presign response: both are folded into the
 * canonical headers on MinIO/COS, so omitting or altering them returns
 * 403 SignatureDoesNotMatch.
 *
 * Returns `{ url }` = the presign response's `downloadUrl`, ready to drop
 * into a message payload.
 */
export async function uploadFileToPresignedUrl(params: {
  uploadUrl: string;
  downloadUrl: string;
  fileBody: Buffer | NodeJS.ReadableStream;
  fileSize: number;
  contentType: string;
  contentDisposition?: string;
  signal?: AbortSignal;
}): Promise<{ url: string }> {
  const headers: Record<string, string> = {
    "Content-Type": params.contentType,
    "Content-Length": String(params.fileSize),
  };
  if (params.contentDisposition) {
    headers["Content-Disposition"] = params.contentDisposition;
  }

  const response = await fetch(params.uploadUrl, {
    method: "PUT",
    headers,
    body: params.fileBody as any,
    // Required by undici when streaming a request body.
    duplex: "half",
    signal: params.signal,
  } as RequestInit);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Presigned PUT upload failed (${response.status}): ${text || response.statusText}`);
  }
  return { url: params.downloadUrl };
}



/**
 * Fetch user info by UID. Requires backend `/v1/bot/user/info` endpoint.
 * Returns null if the endpoint is unavailable (404) or returns an error,
 * so callers can gracefully degrade.
 */
export async function fetchUserInfo(params: {
  apiUrl: string;
  botToken: string;
  uid: string;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<{ uid: string; name: string; avatar?: string } | null> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/user/info?uid=${encodeURIComponent(params.uid)}`;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${params.botToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (resp.status === 404) {
      // Endpoint not implemented yet — silent degrade
      return null;
    }
    if (!resp.ok) {
      params.log?.error?.(`octo: fetchUserInfo(${params.uid}) failed: ${resp.status}`);
      return null;
    }
    const data = await resp.json() as { uid?: string; name?: string; avatar?: string };
    if (data?.name) {
      return { uid: data.uid ?? params.uid, name: data.name, avatar: data.avatar };
    }
    return null;
  } catch (err) {
    params.log?.error?.(`octo: fetchUserInfo(${params.uid}) error: ${String(err)}`);
    return null;
  }
}

// ========== Space Members API ==========

export async function searchSpaceMembers(params: {
  apiUrl: string;
  botToken: string;
  keyword?: string;
  spaceId?: string;
  limit?: number;
}): Promise<Array<{ uid: string; name: string; robot: number }>> {
  const query = new URLSearchParams();
  if (params.keyword) query.set("keyword", params.keyword);
  if (params.spaceId) query.set("space_id", params.spaceId);
  if (params.limit) query.set("limit", String(params.limit));
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/space/members?${query}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`searchSpaceMembers failed (${resp.status}): ${text || resp.statusText}`);
  }
  return (await resp.json()) as Array<{ uid: string; name: string; robot: number }>;
}

// ========== Bot Group Management APIs ==========

export async function createGroup(params: {
  apiUrl: string;
  botToken: string;
  name?: string;
  members: string[];
  creator: string;
  spaceId?: string;
}): Promise<{ group_no: string; name: string }> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/createGroup`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, Authorization: `Bearer ${params.botToken}` },
    body: JSON.stringify({
      name: params.name,
      members: params.members,
      creator: params.creator,
      ...(params.spaceId ? { space_id: params.spaceId } : {}),
    }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`createGroup failed (${resp.status}): ${text || resp.statusText}`);
  }
  return (await resp.json()) as { group_no: string; name: string };
}

export async function updateGroup(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  name?: string;
  notice?: string;
}): Promise<void> {
  const body: Record<string, string> = {};
  if (params.name != null) body.name = params.name;
  if (params.notice != null) body.notice = params.notice;
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/info`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: { ...DEFAULT_HEADERS, Authorization: `Bearer ${params.botToken}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`updateGroup failed (${resp.status}): ${text || resp.statusText}`);
  }
}

export async function addGroupMembers(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  members: string[];
}): Promise<{ ok: boolean; added: number }> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/members/add`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, Authorization: `Bearer ${params.botToken}` },
    body: JSON.stringify({ members: params.members }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`addGroupMembers failed (${resp.status}): ${text || resp.statusText}`);
  }
  return (await resp.json()) as { ok: boolean; added: number };
}

export async function removeGroupMembers(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  members: string[];
}): Promise<{ ok: boolean; removed: number }> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/members/remove`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, Authorization: `Bearer ${params.botToken}` },
    body: JSON.stringify({ members: params.members }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`removeGroupMembers failed (${resp.status}): ${text || resp.statusText}`);
  }
  return (await resp.json()) as { ok: boolean; removed: number };
}

// ========== Bot Thread APIs ==========

export async function createThread(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  name: string;
  sourceMessageId?: number;
}): Promise<{ short_id: string; name: string; creator_uid: string }> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads`;
  const body: Record<string, unknown> = { name: params.name };
  if (params.sourceMessageId != null) body.source_message_id = params.sourceMessageId;
  const resp = await fetch(url, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, Authorization: `Bearer ${params.botToken}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`createThread failed (${resp.status}): ${text || resp.statusText}`);
  }
  return (await resp.json()) as { short_id: string; name: string; creator_uid: string };
}

export async function listThreads(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
}): Promise<Array<{ short_id: string; name: string; creator_uid: string; status: number }>> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`listThreads failed (${resp.status}): ${text || resp.statusText}`);
  }
  return (await resp.json()) as Array<{ short_id: string; name: string; creator_uid: string; status: number }>;
}

export async function getThread(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
}): Promise<{ short_id: string; name: string; creator_uid: string; status: number; member_count: number }> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`getThread failed (${resp.status}): ${text || resp.statusText}`);
  }
  return (await resp.json()) as { short_id: string; name: string; creator_uid: string; status: number; member_count: number };
}

export async function deleteThread(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
}): Promise<void> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}`;
  const resp = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`deleteThread failed (${resp.status}): ${text || resp.statusText}`);
  }
}

export async function listThreadMembers(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
}): Promise<Array<{ uid: string; role: number }>> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}/members`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`listThreadMembers failed (${resp.status}): ${text || resp.statusText}`);
  }
  return (await resp.json()) as Array<{ uid: string; role: number }>;
}

export async function joinThread(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
}): Promise<void> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}/join`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`joinThread failed (${resp.status}): ${text || resp.statusText}`);
  }
}

export async function leaveThread(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
}): Promise<void> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}/leave`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`leaveThread failed (${resp.status}): ${text || resp.statusText}`);
  }
}

// ========== Target Resolve API ==========

/**
 * Resolve a NAMED target ("forward to 'XXX'") into concrete channel candidates.
 *
 * GET /v1/bot/resolve/targets?name=...&kind=...&limit=... (octo-server PR #337).
 *
 * Returns candidates the agent can disambiguate against — it must NEVER
 * hand-build a `group:` address from a name. An empty result (App Bot, or no
 * match) comes back as candidates:[] / total:0 with HTTP 200, not an error.
 *
 * The server response is snake_case; this does EXPLICIT field mapping into the
 * camelCase TargetCandidate shape rather than casting the raw JSON, so a backend
 * field rename surfaces as a typed gap here instead of silently propagating.
 */
export async function resolveTargetsByName(params: {
  apiUrl: string;
  botToken: string;
  name: string;
  kind?: "group" | "thread" | "all";
  limit?: number;
}): Promise<{ candidates: TargetCandidate[]; total: number; truncated: boolean }> {
  const query = new URLSearchParams();
  query.set("name", params.name);
  if (params.kind) query.set("kind", params.kind);
  if (params.limit != null) query.set("limit", String(params.limit));
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/resolve/targets?${query}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`resolveTargetsByName failed (${resp.status}): ${text || resp.statusText}`);
  }
  const data = (await resp.json()) as {
    candidates?: Array<Record<string, unknown>>;
    total?: number;
    truncated?: boolean;
  };
  const rawCandidates = Array.isArray(data?.candidates) ? data.candidates : [];
  const candidates: TargetCandidate[] = rawCandidates.map((c) => {
    const mapped: TargetCandidate = {
      kind: c.kind as "group" | "thread",
      channelId: c.channel_id as string,
      channelType: c.channel_type as ChannelType,
      name: c.name as string,
      groupNo: c.group_no as string,
    };
    if (c.short_id != null) mapped.shortId = c.short_id as string;
    if (c.parent_name != null) mapped.parentName = c.parent_name as string;
    return mapped;
  });
  // When the server omits `total`, fall back to candidates.length — but that
  // fallback is unsafe if we asked for a bounded page (limit) and got a full
  // page back: total would collapse to the page size and a truncated result
  // could masquerade as genuinely unique. Fail closed: if total is missing AND
  // we hit the limit, force truncated=true so the caller never auto-resolves.
  const hasTotal = typeof data?.total === "number";
  const total = hasTotal ? (data.total as number) : candidates.length;
  const limitReached =
    typeof params.limit === "number" && params.limit > 0 && candidates.length >= params.limit;
  const truncated = data?.truncated === true || (!hasTotal && limitReached);
  return {
    candidates,
    total,
    truncated,
  };
}
