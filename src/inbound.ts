import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { ChannelLogSink } from "openclaw/plugin-sdk/channel-contract";
import type { ReplyPayload, ReplyDispatchKind } from "openclaw/plugin-sdk/reply-runtime";
import type { ReplyDispatcherWithTypingOptions } from "openclaw/plugin-sdk/reply-runtime";
import { DEFAULT_GROUP_HISTORY_LIMIT } from "openclaw/plugin-sdk/reply-history";
// Namespace import + runtime feature detection so the deliver-buffer fix
// degrades gracefully across SDK versions:
//   - isReplyPayloadNonTerminalToolErrorWarning lands in newer SDK (>=5.27);
//     on older SDK (e.g. 5.22) it is undefined, so we cannot classify a final
//     as a tool-warning fallback and treat it as a normal final (sent
//     immediately), which still preserves the real user-facing reply.
//   - resolveSendableOutboundReplyParts is present across these versions.
import * as replyPayloadSdk from "openclaw/plugin-sdk/reply-payload";

const replyPayloadCompat = replyPayloadSdk as typeof replyPayloadSdk & {
  isReplyPayloadNonTerminalToolErrorWarning?: (payload: ReplyPayload) => boolean;
};
const isReplyPayloadNonTerminalToolErrorWarning =
  typeof replyPayloadCompat.isReplyPayloadNonTerminalToolErrorWarning === "function"
    ? replyPayloadCompat.isReplyPayloadNonTerminalToolErrorWarning
    : undefined;
const resolveSendableOutboundReplyParts = replyPayloadSdk.resolveSendableOutboundReplyParts;
import { sendMessage, sendReadReceipt, sendTyping, getChannelMessages, getGroupMembers, getGroupMd, postJson, sendMediaMessage, inferContentType, ensureTextCharset, parseImageDimensions, parseImageDimensionsFromFile, getUploadPresign, uploadFileToPresignedUrl, fetchUserInfo } from "./api-fetch.js";
import type { GroupMember } from "./api-fetch.js";
import { getMentionPrefFromCache, invalidateMentionPref } from "./mention-prefs.js";
import { normalizeAccountId } from "./account-id.js";
import type { ResolvedOctoAccount } from "./accounts.js";
import type { BotMessage } from "./types.js";
import { ChannelType, MessageType, RICH_TEXT_BLOCK_IMAGE, RICH_TEXT_BLOCK_TEXT, RICH_TEXT_IMAGE_PLACEHOLDER } from "./types.js";
import type { RichTextBlock } from "./types.js";
import { getOctoRuntime } from "./runtime.js";
import { CHANNEL_ID, MAX_UPLOAD_SIZE } from "./constants.js";
import { streamToFileWithCap } from "./stream-helpers.js";
import {
  extractMentionMatches,
  extractMentionUids,
  convertContentForLLM,
  buildSenderPrefix,
  resolveSenderName,
  parseStructuredMentions,
  convertStructuredMentions,
  buildEntitiesFromFallback,
  MENTION_FORMAT_HINT,
} from "./mention-utils.js";
import type { MentionPayload, MentionEntity, SendMessageResult } from "./types.js";
import { registerGroupAccount, ensureGroupMd, handleGroupMdEvent, broadcastGroupMdUpdate, extractParentGroupNo, extractThreadShortId, ensureThreadMd, handleThreadMdEvent } from "./group-md.js";
import { isOwner } from "./owner-registry.js";
import { isKnownBot } from "./bot-registry.js";
import { getPersonaPromptForSession } from "./persona-prompt.js";
import { createWriteStream } from "node:fs";
import { mkdir, unlink, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";

// Per-inbound dispatch timeout (issue #75; config derivation: issue #113).
// The upstream OpenClaw runtime call
// `core.channel.reply.dispatchReplyWithBufferedBlockDispatcher` is observed to
// occasionally hang indefinitely (no resolve, no reject, no onError) — likely
// in agent/runtime layers, not in this plugin. Combined with the per-group
// serial inbound queue (`enqueueInbound` in channel.ts), a single hang locks
// the entire group: no further messages get processed until the gateway
// restarts. This wrapper turns "silent permanent block" into "single-message
// timeout with a warn log + user-facing apology + queue advances".
//
// This timeout is a pure infrastructure backstop — it must NOT double as an
// agent-run timeout (OpenClaw core already bounds agent runs via
// `agents.defaults.timeoutSeconds`). Issue #113: the old hardcoded 5-minute
// value killed healthy long-running dispatches whenever operators raised
// `timeoutSeconds` above 300s. The effective value is therefore resolved
// per-inbound by `resolveDispatchTimeoutMs` (see below): an explicit
// `dispatchTimeoutMs` channel/account config wins, otherwise the value is
// DERIVED as `agents.defaults.timeoutSeconds (default 600) * 1000 + 60s`.
// The 60s buffer guarantees by construction that this guard fires strictly
// AFTER the agent-run timeout — core terminates the run gracefully first,
// and the dispatch guard only catches genuinely hung infrastructure.
// Tests override via `_setDispatchTimeoutForTests` to keep the suite fast.
const DISPATCH_TIMEOUT_BUFFER_MS = 60_000;
const DEFAULT_AGENT_TIMEOUT_SECONDS = 600;
// issue #121: 上限 clamp。dispatch 超时最终值会喂给 setTimeout,后者 delay 上限是
// 32-bit signed int (2^31-1 ≈ 24.8 天);超限会被 Node 重置为 1ms 并抛
// TimeoutOverflowWarning,导致每条消息秒发「处理超时」。夹到这个硬上限既堵死溢出,
// 又因 24.8 天远超任何现实 agent 运行 → 对一切现实配置,兜底仍严格晚于 agent-run
// 超时触发(保上面 #113 注释里的不变量),不会提前误杀健康长任务。
const DISPATCH_TIMEOUT_MAX_MS = 2 ** 31 - 1;
let dispatchTimeoutTestOverrideMs: number | null = null;
// How long we wait for the user-facing "处理超时" apology to post, AND for the
// happy-path buffered-text final flush, before giving up. The whole point of
// issue #75 is that an Octo API call can hang; these recovery/flush calls hit
// the same Octo API, so they MUST themselves be bounded or
// `handleInboundMessage` is still vulnerable to the same hang. 10s is long
// enough for a healthy API round-trip and short enough that a sick API
// releases the per-group queue promptly.
const DISPATCH_TIMEOUT_APOLOGY_DEFAULT_MS = 10_000;
let DISPATCH_TIMEOUT_APOLOGY_MS = DISPATCH_TIMEOUT_APOLOGY_DEFAULT_MS;

export function _setDispatchTimeoutForTests(ms: number | null): void {
  dispatchTimeoutTestOverrideMs = ms;
}

/**
 * Resolve the effective per-inbound dispatch timeout (issue #113).
 *
 * Precedence:
 *   1. `_setDispatchTimeoutForTests` override (tests only).
 *   2. Explicit `dispatchTimeoutMs` from channel/account config
 *      (`channels.octo.dispatchTimeoutMs`, overridable per account) —
 *      ignored unless a finite positive number.
 *   3. Derived from the agent-run timeout: `(agents.defaults.timeoutSeconds
 *      ?? 600) * 1000 + 60_000`. Single source of truth — raising
 *      `timeoutSeconds` automatically moves this guard with it, and the 60s
 *      buffer keeps it strictly behind the agent timeout so a healthy run is
 *      never killed by its own infrastructure backstop.
 */
export function resolveDispatchTimeoutMs(
  cfg: OpenClawConfig,
  account: ResolvedOctoAccount,
): number {
  if (dispatchTimeoutTestOverrideMs !== null) return dispatchTimeoutTestOverrideMs;
  const explicit = account.config.dispatchTimeoutMs;
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return Math.min(explicit, DISPATCH_TIMEOUT_MAX_MS);
  }
  const configured = cfg.agents?.defaults?.timeoutSeconds;
  const agentTimeoutSeconds =
    typeof configured === "number" && Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_AGENT_TIMEOUT_SECONDS;
  return Math.min(
    agentTimeoutSeconds * 1000 + DISPATCH_TIMEOUT_BUFFER_MS,
    DISPATCH_TIMEOUT_MAX_MS,
  );
}

export function _setDispatchApologyTimeoutForTests(ms: number | null): void {
  DISPATCH_TIMEOUT_APOLOGY_MS = ms === null ? DISPATCH_TIMEOUT_APOLOGY_DEFAULT_MS : ms;
}

// Pending inbound context for before_prompt_build hook injection.
// handleInboundMessage writes here; the hook reads and clears per sessionKey.
export const pendingInboundContext = new Map<string, { historyPrefix: string; memberListPrefix: string }>();

// Per-(account, session) registry. The before_prompt_build hook receives
// ctx.sessionKey but not ctx.accountId, so we record on every inbound message
// (right next to pendingInboundContext.set) the fact that some accountId has
// been seen on a given sessionKey. Persona-prompt injection (GH
// octo-adapters#68) depends on this — without it, getPersonaPromptForSession
// can never be called with the correct accountId from the hook.
//
// 🔴 Multi-account isolation (PR#69 R3, Jerry-Xin):
// The map is keyed by the COMPOSITE `${accountId}:${sessionKey}`, NOT by
// `sessionKey` alone. Two distinct bot accounts (e.g. a persona clone and a
// regular bot, or two persona clones) running on the same OpenClaw node can
// legitimately share the same `sessionKey` — OpenClaw routes per-account but
// the resulting session keys can collide. Keying only by `sessionKey` means
// the second account's inbound `.set` overwrites the first, and the hook
// then attaches the wrong account's persona prompt — a cross-account
// identity leak.
//
// With the composite key, both accounts get separate entries and the hook
// resolves persona identity by iterating the registered persona accounts
// and checking `sessionAccountMap.has(buildSessionAccountKey(candidate, ctx.sessionKey))`.
// If exactly one persona account matches we use it; on 0 or >1 matches we
// fail safe to "no persona injection" rather than risk attaching the wrong
// identity.
//
// Lifetime: entries are kept (not deleted) so the hook works on every prompt
// build for the session, not just the first one after an inbound message.
// Sessions are bounded by accounts, so the map size is bounded by
// (active accounts × active session keys per account) — no unbounded growth
// in practice.
//
// All entries are stored with NORMALIZED (lowercase) accountId in both the
// composite key AND the stored value, so mixed-case BotFather IDs (see
// issue #33) cannot split a single bot's presence across two map entries.
// Use the helpers below instead of touching the map directly.
export const sessionAccountMap = new Map<string, string>();

/**
 * Build the composite key used to record `(accountId, sessionKey)` pairs.
 * Normalizes accountId so callers passing any case form hit the same entry.
 */
export function buildSessionAccountKey(accountId: string, sessionKey: string): string {
  return `${normalizeAccountId(accountId)}:${sessionKey}`;
}

/**
 * Register an account's presence on a session.
 *
 * Encapsulates the write to `sessionAccountMap` so both the composite key
 * AND the stored value are normalized — and so unit tests can exercise this
 * single helper instead of mocking the full `handleInboundMessage` flow.
 * Called from the inbound dispatch right after the route is resolved.
 */
export function recordSessionAccount(accountId: string, sessionKey: string): void {
  const id = normalizeAccountId(accountId);
  sessionAccountMap.set(buildSessionAccountKey(id, sessionKey), id);
}

export type OctoStatusSink = (patch: {
  lastInboundAt?: number;
  lastOutboundAt?: number;
  lastError?: string | null;
}) => void;

/** Extract media URLs from deliver payload */
function resolveOutboundMediaUrls(payload: { mediaUrl?: string; mediaUrls?: string[] }): string[] {
  return [
    ...(payload.mediaUrls ?? []),
    ...(payload.mediaUrl ? [payload.mediaUrl] : []),
  ].filter(Boolean);
}

// Tool warning final: a kind=final payload that carries a non-terminal tool
// error warning and no media.  These should be deferred (not sent immediately)
// so they don't overwrite the real user-facing answer in the single-slot
// deliver buffer.  Mirrors Discord's isFallbackOnlyToolWarningFinal.
function isFallbackOnlyToolWarningFinal(payload: ReplyPayload): boolean {
  // Older SDK lacks the tool-warning classifier: never defer, so the final is
  // sent immediately and the real reply is never lost.
  if (!isReplyPayloadNonTerminalToolErrorWarning) {
    return false;
  }
  if (payload.isError !== true || !isReplyPayloadNonTerminalToolErrorWarning(payload)) {
    return false;
  }
  return !resolveSendableOutboundReplyParts(payload).hasMedia;
}

/**
 * Sanitize a filename for safe use inside a temp directory.
 *
 * Strips path separators (basename), rejects path-traversal segments and
 * null bytes, caps length. Returns "file" for empty/dangerous input.
 *
 * Exported so unit tests (`content-disposition.test.ts`) can lock in the
 * defense against URL-encoded path traversal (e.g. `..%2F..%2Fetc%2Fpasswd`).
 */
export function sanitizeFilename(name: string): string {
  // basename() strips any leading directory components
  const base = join("/", name).split(/[/\\]/).pop() || "";
  // Reject traversal segments and null bytes after basename
  if (!base || base === "." || base === ".." || base.includes("\0")) return "file";
  // Cap length to avoid filesystem limits / DoS via huge names
  return base.length > 200 ? base.slice(0, 200) : base;
}

/** Extract filename from a URL path (sanitized for use in temp paths) */
export function extractFilename(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split("/");
    const raw = parts[parts.length - 1] || "file";
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }
    return sanitizeFilename(decoded);
  } catch {
    return "file";
  }
}

/**
 * Result of uploading a single media asset via the server presigned URL
 * (without sending).
 */
export interface UploadedMedia {
  /** Public CDN/object URL of the uploaded asset. */
  url: string;
  /** Sanitized filename used for the upload. */
  filename: string;
  /** Byte size of the uploaded asset. */
  size: number;
  /** Resolved content type (charset normalized for text/*). */
  contentType: string;
  /** True when the asset is an image (contentType starts with image/). */
  isImage: boolean;
  /** Image width in px (images only, when parseable). */
  width?: number;
  /** Image height in px (images only, when parseable). */
  height?: number;
}

/**
 * Upload a single media asset (remote URL or local path) via the server's
 * backend-agnostic presigned PUT URL and return its public URL plus metadata
 * — WITHOUT sending a message.
 *
 * Extracted from {@link uploadAndSendMedia} so the outbound RichText(=14) path
 * can batch-upload images first, collect their URLs/dimensions, then assemble a
 * single RichText payload (one HTTP send) instead of one send per asset.
 */
export async function uploadMedia(params: {
  mediaUrl: string;
  apiUrl: string;
  botToken: string;
  log?: ChannelLogSink;
}): Promise<UploadedMedia> {
  const { mediaUrl, apiUrl, botToken, log } = params;

  const { createReadStream: fsCreateReadStream, statSync: fsStatSync } = await import("node:fs");
  const { basename, join: pathJoin } = await import("node:path");
  const { mkdir: fsMkdir, unlink: fsUnlink } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");

  const TEMP_DIR = pathJoin("/tmp", "octo-upload");

  let fileSize: number;
  let contentType: string;
  let filename: string;
  let tempPath: string | undefined;
  // Path the upload body is streamed from (temp file for remote, original for
  // local). The read stream is opened lazily right before the PUT so that an
  // earlier failure (e.g. presign) can unlink the temp file without leaving a
  // dangling open() that throws ENOENT.
  let bodyPath: string;

  if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
    filename = extractFilename(mediaUrl);
    // Stream download to a temp file. We deliberately do NOT trust the HEAD
    // Content-Length for the size check or for the presigned fileSize: a
    // remote server may omit or lie about it, and the presigned PUT signs the
    // exact byte count (SigV4 403 on any mismatch). Enforce the cap while
    // streaming via streamToFileWithCap (shared helper), then use the real
    // statSync().size for the signed fileSize.
    await fsMkdir(TEMP_DIR, { recursive: true });
    tempPath = pathJoin(TEMP_DIR, `${randomUUID()}-${filename}`);

    const resp = await fetch(mediaUrl, {
      signal: AbortSignal.timeout(300_000),
    });
    if (!resp.ok) throw new Error(`Failed to fetch media: ${resp.status}`);
    contentType = resp.headers.get("content-type") || "application/octet-stream";
    if (!resp.body) throw new Error(`No response body from ${mediaUrl}`);

    try {
      await streamToFileWithCap({
        body: resp.body as ReadableStream<Uint8Array>,
        destPath: tempPath,
        maxBytes: MAX_UPLOAD_SIZE,
      });
    } catch (err) {
      // streamToFileWithCap unlinks the partial temp file on its own error
      // path; clear our handle so the outer `finally` doesn't double-unlink.
      tempPath = undefined;
      throw err;
    }

    const st = fsStatSync(tempPath);
    bodyPath = tempPath;
    fileSize = st.size;
  } else {
    // Local file path — stream, don't buffer
    const st = fsStatSync(mediaUrl);
    if (st.size > MAX_UPLOAD_SIZE) throw new Error(`File too large (${st.size} bytes, max ${MAX_UPLOAD_SIZE})`);
    bodyPath = mediaUrl;
    fileSize = st.size;
    filename = basename(mediaUrl);
    contentType = inferContentType(filename);
  }

  try {
    // Upload via the server's presigned PUT URL (backend-agnostic: MinIO/COS/S3/OSS).
    const presign = await getUploadPresign({
      apiUrl,
      botToken,
      filename,
      fileSize,
      contentType: ensureTextCharset(contentType),
    });
    const { url: uploadedUrl } = await uploadFileToPresignedUrl({
      uploadUrl: presign.uploadUrl,
      downloadUrl: presign.downloadUrl,
      fileBody: fsCreateReadStream(bodyPath),
      fileSize,
      // Replay the server-signed contentType / contentDisposition verbatim:
      // both are folded into the SigV4 canonical headers (403 otherwise).
      contentType: presign.contentType,
      contentDisposition: presign.contentDisposition,
    });

    // Determine media kind from MIME
    const isImage = contentType.startsWith("image/");

    // For images, parse dimensions from file (not full buffer)
    let width: number | undefined;
    let height: number | undefined;
    if (isImage) {
      const fileToParse = tempPath ?? mediaUrl;
      const dims = await parseImageDimensionsFromFile(fileToParse, contentType);
      width = dims?.width;
      height = dims?.height;
    }

    log?.info?.(`octo: uploaded media as ${isImage ? "image" : "file"}: ${filename}${width ? ` (${width}x${height})` : ""}`);

    return { url: uploadedUrl, filename, size: fileSize, contentType, isImage, width, height };
  } finally {
    if (tempPath) await fsUnlink(tempPath).catch(() => {});
  }
}

/** Upload media via the server presigned URL and send as image/file message */
export async function uploadAndSendMedia(params: {
  mediaUrl: string;
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  onBehalfOf?: string;
  log?: ChannelLogSink;
}): Promise<SendMessageResult | undefined> {
  const { mediaUrl, apiUrl, botToken, channelId, channelType, onBehalfOf, log } = params;

  const uploaded = await uploadMedia({ mediaUrl, apiUrl, botToken, log });

  const msgType = uploaded.isImage ? MessageType.Image : MessageType.File;

  // Send via sendMessage
  const result = await sendMediaMessage({
    apiUrl,
    botToken,
    channelId,
    channelType,
    type: msgType,
    url: uploaded.url,
    name: uploaded.filename,
    size: uploaded.size,
    width: uploaded.width,
    height: uploaded.height,
    ...(onBehalfOf ? { onBehalfOf } : {}),
  });
  return result;
}

/** Guess MIME type from file extension */
function guessMime(pathOrName?: string, fallback = "application/octet-stream"): string {
  if (!pathOrName) return fallback;
  const ext = pathOrName.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", opus: "audio/opus",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", avi: "video/x-msvideo", mkv: "video/x-matroska",
    pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
    txt: "text/plain", json: "application/json", csv: "text/csv", md: "text/markdown",
    py: "text/x-python", js: "text/javascript", ts: "text/typescript", go: "text/x-go", java: "text/x-java",
    html: "text/html", css: "text/css", xml: "text/xml", yaml: "text/yaml", yml: "text/yaml",
  };
  return map[ext] ?? fallback;
}

export interface ResolvedContent {
  text: string;
  mediaUrl?: string;
  mediaType?: string;
  /**
   * RichText(=14) 图文混排展开后的全部图片 URL（有序，按 block 顺序）。
   * 单图/纯媒体类型仍走 `mediaUrl`；此字段仅在一条消息可携带多张图时填充。
   */
  mediaUrls?: string[];
}

export interface ForwardUser {
  uid: string;
  name: string;
}

export interface ForwardMessage {
  message_id?: string;
  from_uid: string;
  timestamp?: number;
  payload: {
    type: number;
    content?: string;
    url?: string;
    name?: string;
    users?: ForwardUser[];
    msgs?: ForwardMessage[];
  };
}

/** Build a full media URL from a relative storage path */
export function buildMediaUrl(relUrl?: string, apiUrl?: string, cdnUrl?: string): string | undefined {
  if (!relUrl) return undefined;
  if (relUrl.startsWith("http")) return relUrl;
  let storagePath = relUrl;
  if (storagePath.startsWith("file/preview/")) {
    storagePath = storagePath.substring("file/preview/".length);
  } else if (storagePath.startsWith("file/")) {
    storagePath = storagePath.substring("file/".length);
  }
  if (cdnUrl) {
    const base = cdnUrl.replace(/\/+$/, "");
    return `${base}/${storagePath}`;
  }
  const baseUrl = apiUrl?.replace(/\/+$/, "") ?? "";
  return `${baseUrl}/file/${storagePath}`;
}

/** Resolve inner message type to display text for MultipleForward */
export function resolveInnerMessageText(
  payload: ForwardMessage["payload"],
  buildUrl?: (url?: string) => string | undefined,
): string {
  if (!payload) return "";
  const fullUrl = buildUrl?.(payload.url);
  switch (payload.type) {
    case MessageType.Text:
      return payload.content ?? "";
    case MessageType.Image:
      return fullUrl ? `[图片]\n${fullUrl}` : "[图片]";
    case MessageType.GIF:
      return fullUrl ? `[GIF]\n${fullUrl}` : "[GIF]";
    case MessageType.Voice:
      return fullUrl ? `[语音]\n${fullUrl}` : "[语音]";
    case MessageType.Video:
      return fullUrl ? `[视频]\n${fullUrl}` : "[视频]";
    case MessageType.Location:
      return "[位置信息]";
    case MessageType.Card:
      return "[名片]";
    case MessageType.File: {
      const label = payload.name ? `[文件: ${payload.name}]` : "[文件]";
      return fullUrl ? `${label}\n${fullUrl}` : label;
    }
    case MessageType.MultipleForward:
      return "[合并转发]";
    case MessageType.RichText: {
      // 嵌套 RichText（引用/转发预览）：优先顶层 plain，缺则遍历 content blocks。
      const rt = resolveRichTextContent(payload as any, buildUrl);
      return rt.text || "[图文消息]";
    }
    default:
      return payload.content ?? "[消息]";
  }
}

/**
 * 将 RichText(=14) payload 展开成单条语义消息 `{ text, mediaUrls[] }`。
 *
 * 复刻 MultipleForward(=11) 的展开范式：
 *   - 文本：优先读顶层 `plain`（server 权威生成的冗余纯文本）；
 *     缺失时遍历 `content` block 数组现场拼接（text 取 text、image 注入占位符）。
 *   - 图片：遍历 image block 收集 `url`（经 buildUrl 归一化为完整地址）。
 *
 * 向后兼容老 payload：`content` 为字符串时按单个 text block 处理。
 */
export function resolveRichTextContent(
  payload: { content?: unknown; plain?: unknown; url?: string },
  buildUrl?: (url?: string) => string | undefined,
): { text: string; mediaUrls: string[] } {
  const blocks = normalizeRichTextBlocks(payload?.content);
  const mediaUrls: string[] = [];
  for (const blk of blocks) {
    // Defensive: server-originated data — only collect string urls so a
    // malformed `{type:'image', url:{}}` never reaches buildUrl and throws.
    if (blk.type === RICH_TEXT_BLOCK_IMAGE && typeof blk.url === "string" && blk.url) {
      const full = buildUrl ? buildUrl(blk.url) : blk.url;
      if (full) mediaUrls.push(full);
    }
  }
  // 顶层 plain 优先（server 权威）。注意 plain 仅供展示，图片仍从 blocks 收集。
  const topPlain = typeof payload?.plain === "string" ? payload.plain : "";
  const text = topPlain.trim() !== ""
    ? topPlain
    : buildRichTextPlain(blocks);
  return { text, mediaUrls };
}

/**
 * 归一化 RichText `content`：
 *   - 数组 → 原样（过滤非对象元素）；
 *   - 字符串 → 视为单个 text block（向后兼容老的字符串 content）；
 *   - 其它 → 空数组。
 */
function normalizeRichTextBlocks(content: unknown): RichTextBlock[] {
  if (Array.isArray(content)) {
    return content.filter((b): b is RichTextBlock => !!b && typeof b === "object");
  }
  if (typeof content === "string" && content) {
    return [{ type: RICH_TEXT_BLOCK_TEXT, text: content }];
  }
  return [];
}

/**
 * 遍历 content blocks 生成纯文本（对齐 octo-lib BuildRichTextPlain）：
 *   - text block 取 text；
 *   - image block 注入 RICH_TEXT_IMAGE_PLACEHOLDER；
 *   - 未知 type 降级：有 text 写 text，否则跳过（Postel，展示端宽容）。
 */
function buildRichTextPlain(blocks: RichTextBlock[]): string {
  let out = "";
  for (const blk of blocks) {
    if (blk.type === RICH_TEXT_BLOCK_IMAGE) {
      out += RICH_TEXT_IMAGE_PLACEHOLDER;
    } else if (blk.type === RICH_TEXT_BLOCK_TEXT) {
      // Only string text — guards against a malformed non-string `text`
      // rendering as "[object Object]".
      out += typeof blk.text === "string" ? blk.text : "";
    } else if (typeof blk.text === "string" && blk.text) {
      out += blk.text;
    }
  }
  return out;
}

/** Resolve MultipleForward payload into readable text */
export function resolveMultipleForwardText(payload: any, apiUrl?: string, cdnUrl?: string): string {
  const users: ForwardUser[] = payload?.users ?? [];
  const msgs: ForwardMessage[] = payload?.msgs ?? [];
  const userMap = new Map<string, string>();
  for (const u of users) {
    if (u.uid && u.name) userMap.set(u.uid, u.name);
  }
  const buildUrl = (apiUrl || cdnUrl)
    ? (url?: string) => buildMediaUrl(url, apiUrl, cdnUrl)
    : undefined;
  const lines: string[] = ["[合并转发: 聊天记录]"];
  for (const m of msgs) {
    const senderName = userMap.get(m.from_uid) ?? m.from_uid;
    if (m.payload?.type === MessageType.MultipleForward) {
      const nested = resolveMultipleForwardText(m.payload, apiUrl, cdnUrl);
      lines.push(`${senderName}: [合并转发]`);
      lines.push(nested);
    } else {
      const content = resolveInnerMessageText(m.payload, buildUrl);
      lines.push(`${senderName}: ${content}`);
    }
  }
  return lines.join("\n");
}

function resolveContent(payload: BotMessage["payload"], apiUrl?: string, log?: ChannelLogSink, cdnUrl?: string): ResolvedContent {
  if (!payload) return { text: "" };

  const makeFullUrl = (relUrl?: string) => buildMediaUrl(relUrl, apiUrl, cdnUrl);

  switch (payload.type) {
    case MessageType.Text:
      return { text: payload.content ?? "" };
    case MessageType.Image: {
      log?.debug?.(`octo: [resolveContent] Image payload.url=${payload.url}`);
      const imgUrl = makeFullUrl(payload.url);
      const imgMime = guessMime(payload.url, "image/jpeg");
      return { text: `[图片]\n${imgUrl ?? ""}`.trim(), mediaUrl: imgUrl, mediaType: imgMime };
    }
    case MessageType.GIF: {
      const gifUrl = makeFullUrl(payload.url);
      return { text: `[GIF]\n${gifUrl ?? ""}`.trim(), mediaUrl: gifUrl, mediaType: "image/gif" };
    }
    case MessageType.Voice: {
      const voiceUrl = makeFullUrl(payload.url);
      const voiceMime = guessMime(payload.url, "audio/mpeg");
      return { text: `[语音消息]\n${voiceUrl ?? ""}`.trim(), mediaUrl: voiceUrl, mediaType: voiceMime };
    }
    case MessageType.Video: {
      const videoUrl = makeFullUrl(payload.url);
      const videoMime = guessMime(payload.url, "video/mp4");
      return { text: `[视频]\n${videoUrl ?? ""}`.trim(), mediaUrl: videoUrl, mediaType: videoMime };
    }
    case MessageType.File: {
      log?.debug?.(`octo: [resolveContent] File payload.url=${payload.url}`);
      const fileUrl = makeFullUrl(payload.url);
      const fileMime = guessMime(payload.url, payload.name ? guessMime(payload.name, "application/octet-stream") : "application/octet-stream");
      return { text: `[文件: ${payload.name ?? "未知文件"}]\n${fileUrl ?? ""}`.trim(), mediaUrl: fileUrl, mediaType: fileMime };
    }
    case MessageType.Location: {
      const lat = payload.latitude ?? payload.lat;
      const lng = payload.longitude ?? payload.lng ?? payload.lon;
      const locText = lat != null && lng != null ? `[位置信息: ${lat},${lng}]` : "[位置信息]";
      return { text: locText };
    }
    case MessageType.Card: {
      const cardName = payload.name ?? "未知";
      const cardUid = payload.uid ?? "";
      const cardText = cardUid ? `[名片: ${cardName} (${cardUid})]` : `[名片: ${cardName}]`;
      return { text: cardText };
    }
    case MessageType.MultipleForward: {
      return { text: resolveMultipleForwardText(payload, apiUrl, cdnUrl) };
    }
    case MessageType.RichText: {
      // 图文混排：展开成单条语义 { text, mediaUrls[] }。优先顶层 plain，
      // 缺则遍历 content blocks（复刻 MultipleForward 的展开范式）。
      const buildUrl = (url?: string) => buildMediaUrl(url, apiUrl, cdnUrl);
      const rt = resolveRichTextContent(payload as any, buildUrl);
      const mediaUrls = rt.mediaUrls;
      return {
        text: rt.text,
        ...(mediaUrls.length > 0 ? { mediaUrl: mediaUrls[0], mediaUrls } : {}),
        ...(mediaUrls.length > 0 ? { mediaType: guessMime(mediaUrls[0], "image/jpeg") } : {}),
      };
    }
    default:
      return { text: payload.content ?? payload.url ?? "" };
  }
}

/** Extract text-only content for history/quotes (no mediaUrl) */
function resolveContentText(payload: BotMessage["payload"], apiUrl?: string): string {
  return resolveContent(payload, apiUrl).text;
}

const TEXT_FILE_EXTENSIONS = new Set([
  "txt", "html", "htm", "md", "csv", "json", "xml", "yaml", "yml",
  "log", "py", "js", "ts", "go", "java",
]);

/** Fetch an authenticated URL and return a base64 data URL */
async function fetchAsDataUrl(
  url: string,
  botToken: string,
  log?: { warn?: (msg: string) => void },
): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      log?.warn?.(`octo: fetchAsDataUrl failed: status=${resp.status} url=${url}`);
      return null;
    }
    const contentType = resp.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await resp.arrayBuffer());
    return `data:${contentType};base64,${buffer.toString("base64")}`;
  } catch (err) {
    log?.warn?.(`octo: fetchAsDataUrl error: ${String(err)} url=${url}`);
    return null;
  }
}

/** Format bytes as human-readable size string */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/** Calculate dynamic timeout based on file size (512KB/s baseline, min 5min, max 30min) */
export function calcDownloadTimeout(fileSize?: number): number {
  const MIN_TIMEOUT = 300_000;    // 5 minutes
  const MAX_TIMEOUT = 1_800_000;  // 30 minutes
  const ASSUMED_SIZE = 256 * 1024 * 1024; // 256MB if unknown
  const size = fileSize ?? ASSUMED_SIZE;
  const computed = Math.ceil(size / (512 * 1024)) * 1000; // 512KB/s baseline
  return Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, computed));
}

// Download inbound media under Core's allowed media root (/tmp/openclaw) so
// that isInboundPathAllowed accepts the local path passed via MediaPaths.
// A bare /tmp/octo-media dir is outside buildMediaLocalRoots and would be
// rejected as `blocked`.
const MEDIA_TEMP_DIR = join("/tmp", "openclaw", "octo-media");
const MAX_MEDIA_DOWNLOAD_SIZE = 20 * 1024 * 1024; // 20MB cap for inbound media
const MEDIA_DOWNLOAD_TIMEOUT = 120_000; // 120 seconds

/** True when a media entry is a remote http(s) URL rather than a local fs path. */
export function isRemoteMediaUrl(entry: string | undefined): boolean {
  return !!entry && /^https?:\/\//i.test(entry);
}

/**
 * One inbound media image: its locally-downloaded fs path (if the download
 * succeeded) paired with the original remote http(s) URL fallback (always
 * fetchable). The remote URL lets Core re-fetch the image whenever the local
 * path is unavailable, without ever fs-reading a remote URL string.
 */
export interface InboundMediaItem {
  /** Local fs path under Core's allowed root; undefined when the download failed. */
  localPath?: string;
  /** Original remote http(s) URL — the always-reachable fallback for this image. */
  remoteUrl: string;
}

/**
 * Derive the inbound MediaPaths list (Core's preferred, fs-read branch).
 *
 * ALL-OR-NOTHING: emit MediaPaths only when EVERY image downloaded to a local
 * path. The returned array is then compact (string[], no holes) and same-order
 * with MediaUrls. If ANY image failed, return undefined so the whole message
 * falls back to the MediaUrls (remote http) branch instead.
 *
 * This sidesteps the sparse-array trap: Core consumes MediaPaths through two
 * paths with different contracts — normalizeAttachments pairs MediaPaths[i] with
 * MediaUrls[i] positionally, while sandbox staging (resolveRawPaths → trim each
 * raw) treats MediaPaths as a plain string[] and CRASHES on an undefined slot.
 * Never emitting a non-string MediaPaths element keeps both consumers safe.
 */
export function resolveInboundMediaPaths(
  items: InboundMediaItem[] | undefined,
): string[] | undefined {
  if (!items?.length) return undefined;
  if (!items.every((it) => it.localPath)) return undefined;
  return items.map((it) => it.localPath!);
}

/**
 * Derive the inbound media list passed to Core as MediaUrls.
 *
 * Mirrors the MediaPaths all-or-nothing decision so the two arrays never drift:
 * - All images downloaded → local fs paths (same values as MediaPaths; Core
 *   fs-reads them via the MediaPaths branch).
 * - Any download failed → every image's ORIGINAL remote http(s) URL. MediaPaths
 *   is undefined in this case, so Core takes the URL branch and http-fetches all
 *   of them — including the ones that did download locally (the local-path
 *   optimisation is sacrificed for this message to guarantee correctness and to
 *   avoid handing a bare local path to the http fetch, which was the #58 bug).
 */
export function resolveInboundMediaList(
  items: InboundMediaItem[] | undefined,
): string[] | undefined {
  if (!items?.length) return undefined;
  const allLocal = items.every((it) => it.localPath);
  return allLocal
    ? items.map((it) => it.localPath!)
    : items.map((it) => it.remoteUrl);
}

/** Best-effort cleanup of inbound media temp files older than 1 hour */
async function cleanupMediaTempFiles(): Promise<void> {
  try {
    const entries = await readdir(MEDIA_TEMP_DIR);
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const entry of entries) {
      try {
        const filePath = join(MEDIA_TEMP_DIR, entry);
        const info = await stat(filePath);
        if (info.mtimeMs < cutoff) {
          await unlink(filePath);
        }
      } catch {}
    }
  } catch {}
}

/**
 * Download inbound media (Image/GIF/Voice/Video) to a local temp file.
 *
 * Returns the local file path on success, undefined on failure.
 * Failures are logged but never thrown — the agent still sees the URL
 * in the text body, it just won't get native media understanding.
 */
export async function downloadMediaToLocal(
  url: string,
  mime: string | undefined,
  log?: ChannelLogSink,
): Promise<string | undefined> {
  try {
    await mkdir(MEDIA_TEMP_DIR, { recursive: true });
    cleanupMediaTempFiles().catch(() => {});

    // Derive a file extension from mime or URL
    let ext = "";
    if (mime) {
      const parts = mime.split("/");
      if (parts.length === 2) ext = "." + parts[1].split(";")[0];
    }
    if (!ext) {
      const urlPath = url.split("?")[0];
      const dot = urlPath.lastIndexOf(".");
      if (dot !== -1) ext = urlPath.substring(dot);
    }
    // Sanitize extension
    ext = ext.replace(/[^a-zA-Z0-9.]/g, "").substring(0, 10);

    const localPath = join(MEDIA_TEMP_DIR, `${randomUUID()}${ext}`);

    const resp = await fetch(url, {
      signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT),
    });
    if (!resp.ok) {
      log?.warn?.(`octo: media download failed HTTP ${resp.status} for ${url}`);
      return undefined;
    }
    if (!resp.body) {
      log?.warn?.(`octo: media download returned no body for ${url}`);
      return undefined;
    }

    const ws = createWriteStream(localPath);
    let totalBytes = 0;
    try {
      const reader = (resp.body as any).getReader() as ReadableStreamDefaultReader<Uint8Array>;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_MEDIA_DOWNLOAD_SIZE) {
          reader.cancel();
          ws.destroy();
          try { await unlink(localPath); } catch {}
          log?.warn?.(`octo: media too large (>${formatSize(MAX_MEDIA_DOWNLOAD_SIZE)}), skipping: ${url}`);
          return undefined;
        }
        if (!ws.write(value)) {
          await new Promise<void>(r => ws.once("drain", r));
        }
      }
      ws.end();
      await new Promise<void>((resolve, reject) => {
        ws.on("finish", resolve);
        ws.on("error", reject);
      });
    } catch (err) {
      ws.destroy();
      try { await unlink(localPath); } catch {}
      throw err;
    }
    log?.info?.(`octo: media downloaded to local: ${localPath} (${formatSize(totalBytes)})`);
    return localPath;
  } catch (err) {
    log?.warn?.(`octo: media download failed for ${url}: ${err}`);
    return undefined;
  }
}

const TEMP_DIR = join("/tmp", "octo-files");
const MAX_DOWNLOAD_SIZE = 500 * 1024 * 1024; // 500MB hard cap

/** Best-effort cleanup of temp files older than 1 hour */
async function cleanupTempFiles(): Promise<void> {
  try {
    const entries = await readdir(TEMP_DIR);
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const entry of entries) {
      try {
        const filePath = join(TEMP_DIR, entry);
        const info = await stat(filePath);
        if (info.mtimeMs < cutoff) {
          await unlink(filePath);
        }
      } catch {}
    }
  } catch {}
}

/** Download a file to a temp path, streaming to disk with size limit.
 *  Returns the local path on success. */
export async function downloadToTemp(
  url: string,
  botToken: string,
  filename: string,
  opts?: { knownSize?: number; log?: ChannelLogSink },
): Promise<string> {
  await mkdir(TEMP_DIR, { recursive: true });
  // Non-blocking cleanup of old temp files
  cleanupTempFiles().catch(() => {});

  const safeName = basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
  const localPath = join(TEMP_DIR, `${randomUUID()}-${safeName}`);
  const timeout = calcDownloadTimeout(opts?.knownSize);
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  if (!resp.body) throw new Error("no response body");

  const ws = createWriteStream(localPath);
  let totalBytes = 0;
  try {
    const reader = (resp.body as any).getReader() as ReadableStreamDefaultReader<Uint8Array>;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_DOWNLOAD_SIZE) {
        reader.cancel();
        throw new Error(`file exceeds max download size (${formatSize(MAX_DOWNLOAD_SIZE)})`);
      }
      if (!ws.write(value)) {
        await new Promise<void>(r => ws.once('drain', r));
      }
    }
    ws.end();
    await new Promise<void>((resolve, reject) => {
      ws.on("finish", resolve);
      ws.on("error", reject);
    });
  } catch (err) {
    ws.destroy();
    // Best-effort cleanup
    try { await unlink(localPath); } catch {}
    throw err;
  }
  opts?.log?.info?.(`octo: file downloaded to temp: ${localPath}`);
  return localPath;
}

/**
 * Attempt to resolve file content for inline display.
 *
 * - Only attempts inline for text-like file extensions
 * - Threshold reduced to 20KB to avoid blowing up LLM context
 * - Sends HEAD request first to check size before downloading
 * - Streams the body with a size guard instead of buffering entirely
 * - For files above inline threshold, streams to a temp file on disk
 * - Returns error description string on failure (never silent null)
 *
 * Return value:
 *   { inline: string }             – file content was inlined
 *   { tempPath: string }           – file was saved to temp
 *   { description: string }        – download skipped or failed; embed this in message
 *   null                           – non-text extension, no action needed
 */
export type ResolveFileResult =
  | { inline: string }
  | { tempPath: string }
  | { description: string }
  | null;

export async function resolveFileContentWithRetry(
  url: string,
  botToken: string,
  filename: string,
  opts?: { knownSize?: number; maxRetries?: number; log?: ChannelLogSink },
): Promise<ResolveFileResult> {
  let ext = "";
  try {
    ext = new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
  } catch {
    ext = url.split(".").pop()?.toLowerCase() ?? "";
  }
  if (!TEXT_FILE_EXTENSIONS.has(ext)) return null;

  const maxBytes = 20 * 1024; // 20KB inline threshold
  const knownSize = opts?.knownSize;
  const maxRetries = opts?.maxRetries ?? 3;
  const log = opts?.log;

  // If we already know the file is too large for inline, stream to temp
  if (knownSize != null && knownSize > maxBytes) {
    log?.info?.(`octo: file too large for inline (${formatSize(knownSize)}), streaming to temp`);
    return await downloadLargeFileWithRetry(url, botToken, filename, { knownSize, maxRetries, log });
  }

  // HEAD pre-check to get Content-Length without downloading
  let headSize: number | undefined;
  try {
    const headResp = await fetch(url, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (headResp.ok) {
      const cl = headResp.headers.get("content-length");
      if (cl) headSize = parseInt(cl, 10);
    }
  } catch {
    // HEAD failed — proceed with streaming download
  }

  // Reject files exceeding hard cap before any download attempt
  if (headSize != null && headSize > MAX_DOWNLOAD_SIZE) {
    log?.info?.(`octo: HEAD reports ${formatSize(headSize)}, exceeds max download size (${formatSize(MAX_DOWNLOAD_SIZE)}), skipping`);
    return { description: `[文件: ${filename} (${formatSize(headSize)}) - 文件超过最大下载限制(${formatSize(MAX_DOWNLOAD_SIZE)})]` };
  }

  if (headSize != null && headSize > maxBytes) {
    log?.info?.(`octo: HEAD reports ${formatSize(headSize)}, exceeds inline threshold, streaming to temp`);
    return await downloadLargeFileWithRetry(url, botToken, filename, { knownSize: headSize, maxRetries, log });
  }

  // Attempt inline download with streaming size guard
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const timeout = calcDownloadTimeout(headSize ?? knownSize);
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${botToken}` },
        signal: AbortSignal.timeout(timeout),
      });
      if (!resp.ok) {
        lastError = `HTTP ${resp.status}`;
        log?.warn?.(`octo: resolveFileContent attempt ${attempt}/${maxRetries} failed: ${lastError}`);
        if (resp.status >= 400 && resp.status < 500) break;
        if (attempt < maxRetries) await sleep(1000 * attempt);
        continue;
      }
      if (!resp.body) {
        lastError = "no response body";
        break;
      }

      // Check Content-Length from GET response
      const cl = resp.headers.get("content-length");
      if (cl && parseInt(cl, 10) > maxBytes) {
        log?.info?.(`octo: GET Content-Length ${cl} exceeds inline threshold, streaming to temp`);
        // Cancel this response; download to temp instead
        try { resp.body.cancel(); } catch {}
        return await downloadLargeFileWithRetry(url, botToken, filename, { knownSize: parseInt(cl, 10), maxRetries: maxRetries - attempt + 1, log });
      }

      // Stream body with size guard
      const reader = (resp.body as any).getReader() as ReadableStreamDefaultReader<Uint8Array>;
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      let exceededInline = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          exceededInline = true;
          reader.cancel();
          break;
        }
        chunks.push(value);
      }

      if (exceededInline) {
        log?.info?.(`octo: file exceeded inline threshold during stream (${formatSize(totalBytes)}+), streaming to temp`);
        return await downloadLargeFileWithRetry(url, botToken, filename, { knownSize: totalBytes, maxRetries: maxRetries - attempt + 1, log });
      }

      // Inline the content
      const combined = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const text = new TextDecoder().decode(combined);
      log?.info?.(`octo: file inlined (${formatSize(totalBytes)})`);
      return { inline: text };
    } catch (err) {
      const errMsg = String(err);
      lastError = errMsg.includes("TimeoutError") || errMsg.includes("abort") ? "下载超时" : `网络错误`;
      log?.warn?.(`octo: resolveFileContent attempt ${attempt}/${maxRetries} error: ${errMsg}`);
      if (attempt < maxRetries) await sleep(1000 * attempt);
    }
  }

  const sizeInfo = knownSize != null ? ` (${formatSize(knownSize)})` : headSize != null ? ` (${formatSize(headSize)})` : "";
  return { description: `[文件: ${filename}${sizeInfo} - 下载失败: ${lastError ?? "未知错误"}]` };
}

/** Download large file to temp with retry + exponential backoff */
async function downloadLargeFileWithRetry(
  url: string,
  botToken: string,
  filename: string,
  opts: { knownSize?: number; maxRetries: number; log?: ChannelLogSink },
): Promise<ResolveFileResult> {
  const { knownSize, maxRetries, log } = opts;

  // Reject files exceeding hard cap before any download attempt
  if (knownSize != null && knownSize > MAX_DOWNLOAD_SIZE) {
    log?.info?.(`octo: file size ${formatSize(knownSize)} exceeds max download size (${formatSize(MAX_DOWNLOAD_SIZE)}), skipping`);
    return { description: `[文件: ${filename} (${formatSize(knownSize)}) - 文件超过最大下载限制(${formatSize(MAX_DOWNLOAD_SIZE)})]` };
  }

  let lastError: string | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const start = Date.now();
      const tempPath = await downloadToTemp(url, botToken, filename, { knownSize, log });
      const duration = ((Date.now() - start) / 1000).toFixed(1);
      log?.info?.(`octo: large file downloaded in ${duration}s: ${filename}`);
      return { tempPath };
    } catch (err) {
      const errMsg = String(err);
      lastError = errMsg.includes("TimeoutError") || errMsg.includes("abort")
        ? `下载超时，已重试${attempt}次失败`
        : errMsg.includes("HTTP ")
        ? errMsg
        : "网络错误";
      log?.warn?.(`octo: downloadToTemp attempt ${attempt}/${maxRetries} failed: ${errMsg}`);
      // 4xx errors are permanent — do not retry
      const httpMatch = errMsg.match(/HTTP (\d+)/);
      if (httpMatch) {
        const status = parseInt(httpMatch[1], 10);
        if (status >= 400 && status < 500) break;
      }
      if (attempt < maxRetries) await sleep(1000 * attempt * 2);
    }
  }
  const sizeInfo = knownSize != null ? ` (${formatSize(knownSize)})` : "";
  return { description: `[文件: ${filename}${sizeInfo} - ${lastError ?? "下载失败"}]` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Placeholder text for non-text API history messages */
export function resolveApiMessagePlaceholder(type?: number, name?: string): string {
  switch (type) {
    case MessageType.Image: return "[图片]";
    case MessageType.GIF: return "[GIF]";
    case MessageType.Voice: return "[语音消息]";
    case MessageType.Video: return "[视频]";
    case MessageType.File: return `[文件: ${name ?? "未知文件"}]`;
    case MessageType.Location: return "[位置信息]";
    case MessageType.Card: return "[名片]";
    case MessageType.MultipleForward: return "[合并转发]";
    case MessageType.RichText: return "[图文消息]";
    default: return "[消息]";
  }
}

/**
 * Strip emoji from string for fuzzy matching.
 * Removes most emoji using Unicode ranges.
 */
function stripEmoji(str: string): string {
  return str
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, '') // Most emoji (faces, symbols, etc.)
    .replace(/[\u{2600}-\u{26FF}]/gu, '')   // Misc symbols
    .replace(/[\u{2700}-\u{27BF}]/gu, '')   // Dingbats
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')   // Variation selectors
    .replace(/[\u{1F000}-\u{1F02F}]/gu, '') // Mahjong, dominos
    .replace(/[\u{1F0A0}-\u{1F0FF}]/gu, '') // Playing cards
    .trim();
}

/**
 * Find uid by displayName with emoji-tolerant matching.
 * First tries exact match, then falls back to matching with emoji stripped.
 */
function findUidByName(name: string, memberMap: Map<string, string>): string | undefined {
  // First try exact match
  const exact = memberMap.get(name);
  if (exact) return exact;

  // Then try matching by stripping emoji from both sides
  const strippedName = stripEmoji(name);
  if (!strippedName) return undefined;

  for (const [displayName, uid] of memberMap.entries()) {
    if (stripEmoji(displayName) === strippedName) {
      return uid;
    }
  }
  return undefined;
}

// Cache expiry time: 1 hour
const GROUP_CACHE_EXPIRY_MS = 60 * 60 * 1000;


/**
 * Refresh group member cache at module level to avoid closure recreation per message.
 * Extracted from handleInboundMessage (fixes #25).
 */
async function refreshGroupMemberCache(opts: {
  sessionId: string;
  memberMap: Map<string, string>;
  uidToNameMap: Map<string, string>;
  groupCacheTimestamps: Map<string, number>;
  // uid -> robot flag (server-authoritative GroupMember.robot). Used by the 免@
  // gate to suppress relaxation for ANY bot sender — including cross-process /
  // external bots this plugin never registered via registerKnownBot().
  memberRobotMap?: Map<string, boolean>;
  // parent groupNo -> current group's roster (#125). When provided,
  // refreshGroupMemberCache writes the freshly-fetched current-group roster
  // here on success and deletes the entry on empty/failure (negative cache),
  // so a stale roster is never re-injected into prompt context.
  currentGroupMembersMap?: Map<string, GroupMember[]>;
  apiUrl: string;
  botToken: string;
  forceRefresh?: boolean;
  log?: ChannelLogSink;
}): Promise<boolean> {
  const { sessionId, memberMap, uidToNameMap, groupCacheTimestamps, memberRobotMap, currentGroupMembersMap, apiUrl, botToken, log } = opts;
  const forceRefresh = opts.forceRefresh ?? false;

  const lastFetched = groupCacheTimestamps.get(sessionId) ?? 0;
  const now = Date.now();
  const isExpired = (now - lastFetched) > GROUP_CACHE_EXPIRY_MS;

  if (!forceRefresh && !isExpired && lastFetched > 0) {
    return false;
  }

  log?.info?.(`octo: [CACHE] ${forceRefresh ? 'Force refreshing' : 'Refreshing expired'} group member cache for ${sessionId}`);

  try {
    const members = await getGroupMembers({
      apiUrl,
      botToken,
      groupNo: sessionId,
      log: log ? { info: (...args) => log.info?.(String(args[0])), error: (...args) => log.error?.(String(args[0])) } : undefined,
    });

    if (members.length > 0) {
      for (const m of members) {
        if (m.name && m.uid) {
          memberMap.set(m.name, m.uid);
          uidToNameMap.set(m.uid, m.name);

          const nameWithoutEmoji = stripEmoji(m.name);
          if (nameWithoutEmoji && nameWithoutEmoji !== m.name && !memberMap.has(nameWithoutEmoji)) {
            memberMap.set(nameWithoutEmoji, m.uid);
            log?.debug?.(`octo: [CACHE] Added emoji alias: "${nameWithoutEmoji}" -> "${m.uid}"`);
          }
        }
        // Preserve the server-authoritative robot flag for the 免@ gate. Keyed
        // by uid (not name) so sender classification survives display-name
        // collisions. Accept BOTH boolean `true` and numeric `1`: the backend
        // serializes GroupMember.robot as a number, so a strict `=== true`
        // would misclassify a bot (robot:1) as human → relax requireMention →
        // reply to non-@ bot messages → bot-to-bot loop. This matches the
        // no_mention true/1 coercion used elsewhere in the gate.
        if (m.uid && memberRobotMap) {
          memberRobotMap.set(m.uid, m.robot === true || m.robot === 1);
        }
      }
      groupCacheTimestamps.set(sessionId, now);
      // Cache the current group's roster (only this group's members) for the
      // member-context prompt, keyed by parent groupNo (#125).
      currentGroupMembersMap?.set(sessionId, members);
      log?.info?.(`octo: [CACHE] Loaded ${members.length} members, memberMap size: ${memberMap.size}`);
      return true;
    } else {
      groupCacheTimestamps.set(sessionId, now - GROUP_CACHE_EXPIRY_MS + 30000);
      // Negative cache: drop any stale roster so we never re-inject it.
      currentGroupMembersMap?.delete(sessionId);
      log?.warn?.(`octo: [CACHE] No members returned for group ${sessionId}, backoff 30s`);
      return false;
    }
  } catch (err) {
    groupCacheTimestamps.set(sessionId, now - GROUP_CACHE_EXPIRY_MS + 30000);
    // Negative cache on failure: drop any stale roster.
    currentGroupMembersMap?.delete(sessionId);
    log?.error?.(`octo: [CACHE] Failed to fetch group members: ${err}, backoff 30s`);
    return false;
  }
}

/**
 * Build the group-path persona-clone GroupSystemPrompt (GH octo-adapters#64).
 *
 * When the persona-clone bot AND its grantor are both members of the same
 * group, the inbound message arrives as a normal group event (not OBO v2).
 * If someone @-mentions the grantor (or @所有人 / legacy @everyone), the
 * adapter routes the reply as the grantor — but the LLM agent sees the raw
 * `@grantor` text and concludes the message is not addressed to it,
 * returning NO_REPLY. This hint tells the agent it is the grantor's
 * persona clone and should respond as the grantor.
 *
 * Locally synthesized — no payload trust required because all inputs come
 * from server-trusted state (`account.config.onBehalfOf` and the resolved
 * `uidToNameMap`).
 */
export function buildPersonaGroupSystemPrompt(
  grantorUid: string,
  uidToNameMap: Map<string, string>,
): string {
  const grantorName = uidToNameMap.get(grantorUid) || grantorUid;
  return (
    `你是${grantorName}的AI分身（persona clone）。当群里有人@${grantorName}` +
    `或@所有人时，就是在叫你，你应当以${grantorName}的身份回复，不要返回 NO_REPLY。`
  );
}

export function buildMemberListPrefix(members: GroupMember[]): string {
  if (members.length === 0) return "";

  if (members.length <= 10) {
    const memberLines = members
      .map((m) => `  ${m.name} (${m.uid})`)
      .join("\n");
    // 真实形态示例锚点用真名 + 真 uid（来自内联名单）；格式说明/anti-pattern
    // 取自共享常量，三处同源不 drift。占位槽用尖括号，避免示例本身被
    // STRUCTURED_MENTION_PATTERN 解析成非法 {uid:"uid"}。
    return `[Group Members]\n${memberLines}\n\n${MENTION_FORMAT_HINT}\n(e.g. @[${members[0].uid}:${members[0].name}]).\n\n`;
  }

  return (
    `[Group Info] This group has ${members.length} members — too many to list here.\n` +
    `To @mention someone, FIRST look up their real uid and display name with the ` +
    `group management tool (octo_management action="group-members", ` +
    `target="group:<groupId>"); it returns each member's { uid, name }.\n` +
    `THEN write the mention. ${MENTION_FORMAT_HINT}\n` +
    `Real example: @[a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6:Alice].\n\n`
  );
}

/**
 * Strip @mention prefix from raw message text for command detection.
 * Only strips when bot is explicitly mentioned (not @all).
 */
export function resolveCommandBody(rawBody: string, isGroup: boolean, isExplicitBotMention: boolean): string {
  if (isGroup && isExplicitBotMention) {
    return rawBody.replace(/^@\S+\s*/, "").trim();
  }
  return rawBody;
}

/**
 * Determine if the sender is authorized to execute slash commands.
 * DM: anyone can execute. Group: owner + explicit @bot mention required.
 */
export function resolveCommandAuthorized(isGroup: boolean, isOwnerUser: boolean, isExplicitBotMention: boolean): boolean {
  return !isGroup || (isOwnerUser && isExplicitBotMention);
}

export function segmentHistoryEntries(params: {
  entries: Array<{ message_id?: string; message_seq?: number; [key: string]: any }>;
  cutoffSeq: number;
  currentMsgId?: string;
}): { answered: typeof params.entries; new: typeof params.entries } {
  const filtered = params.currentMsgId
    ? params.entries.filter(e => e.message_id !== params.currentMsgId)
    : params.entries;

  if (params.cutoffSeq <= 0) {
    return { answered: [], new: filtered };
  }

  return {
    answered: filtered.filter(e => (e.message_seq ?? 0) <= params.cutoffSeq),
    new: filtered.filter(e => (e.message_seq ?? 0) > params.cutoffSeq),
  };
}

export async function handleInboundMessage(params: {
  account: ResolvedOctoAccount;
  message: BotMessage;
  botUid: string;
  groupHistories: Map<string, any[]>;
  lastBotReplySeqMap: Map<string, number>;
  memberMap: Map<string, string>;  // displayName -> uid mapping
  uidToNameMap: Map<string, string>;  // uid -> displayName mapping (reverse)
  groupCacheTimestamps: Map<string, number>;  // groupId -> lastFetchedAt
  memberRobotMap?: Map<string, boolean>;  // uid -> robot flag (server-authoritative)
  // parent groupNo -> current group's roster. Optional: when omitted (e.g.
  // existing tests) it falls back to a throwaway Map below — member context
  // still works WITHIN a single call (the refresh writes the roster, the
  // prompt-build read reads it back), and only degrades to empty across calls
  // (a cache-hit that skips refresh has nothing in the throwaway map). The
  // persistent per-account map (real channel call site) enables cross-call
  // reuse. (#125)
  currentGroupMembersMap?: Map<string, GroupMember[]>;
  groupMdCache?: Map<string, { content: string; version: number }>;
  log?: ChannelLogSink;
  statusSink?: OctoStatusSink;
}) {
  const { account, message, botUid, groupHistories, lastBotReplySeqMap, memberMap, uidToNameMap, groupCacheTimestamps, groupMdCache, log, statusSink } = params;
  // Server-authoritative robot map. Default to a throwaway Map when the caller
  // omits it so the gate logic below can read it unconditionally; the real
  // channel call site passes a persistent per-account map.
  const memberRobotMap = params.memberRobotMap ?? new Map<string, boolean>();
  // Current-group roster cache (per-account, keyed by parent groupNo). Same
  // fallback pattern as memberRobotMap so omitting it is harmless.
  const currentGroupMembersMap = params.currentGroupMembersMap ?? new Map<string, GroupMember[]>();

  // Detect GROUP.md update/delete notification — refresh both memory + disk cache, do NOT pass to LLM
  const earlyEventType = (message.payload as any)?.event?.type;
  if ((earlyEventType === "group_md_updated" || earlyEventType === "group_md_deleted") && message.channel_id) {
    const groupNo = extractParentGroupNo(message.channel_id);
    log?.info?.(`octo: GROUP.md ${earlyEventType} notification for group ${groupNo}`);

    // Update memory cache
    if (earlyEventType === "group_md_updated" && groupMdCache) {
      try {
        const md = await getGroupMd({
          apiUrl: account.config.apiUrl,
          botToken: account.config.botToken ?? "",
          groupNo,
          log,
        });
        if (md.content) {
          groupMdCache.set(groupNo, { content: md.content, version: md.version });
          log?.info?.(`octo: GROUP.md memory cache updated for ${groupNo} (v${md.version})`);
        }
      } catch (err) {
        log?.error?.(`octo: failed to refresh GROUP.md memory cache: ${String(err)}`);
      }
    } else if (earlyEventType === "group_md_deleted" && groupMdCache) {
      groupMdCache.delete(groupNo);
    }

    // Update disk cache (for before_prompt_build hook)
    if (earlyEventType === "group_md_updated" && groupMdCache) {
      const cached = groupMdCache.get(groupNo);
      if (cached) {
        broadcastGroupMdUpdate({
          accountId: account.accountId,
          groupNo,
          content: cached.content,
          version: cached.version,
        });
      }
    } else if (earlyEventType === "group_md_deleted") {
      // Delete disk cache
      broadcastGroupMdUpdate({
        accountId: account.accountId,
        groupNo,
        content: "",
        version: 0,
      });
    }

    return;
  }

  // Detect thread THREAD.md update/delete notification — refresh disk cache, do NOT pass to LLM
  if ((earlyEventType === "thread_md_updated" || earlyEventType === "thread_md_deleted") && message.channel_id) {
    const event = (message.payload as any)?.event;
    const groupNo = event?.group_no ?? extractParentGroupNo(message.channel_id);
    const shortId = event?.short_id ?? extractThreadShortId(message.channel_id);

    if (!groupNo || !shortId) {
      log?.warn?.(`octo: thread_md event missing group_no/short_id`);
      return;
    }

    log?.info?.(`octo: THREAD.md ${earlyEventType} notification for ${groupNo}/${shortId}`);

    // Resolve agentId from route/account (same pattern as group events below)
    let threadAgentId = "";
    try {
      const _core = getOctoRuntime();
      const _cfg = _core.config.loadConfig() as OpenClawConfig;
      const _route = _core.channel.routing.resolveAgentRoute({
        cfg: _cfg, channel: CHANNEL_ID, accountId: account.accountId,
        peer: { kind: "group", id: message.channel_id },
      });
      threadAgentId = _route?.agentId ?? "";
    } catch {
      // fallback to empty — handleThreadMdEvent only uses agentId for logging
    }

    handleThreadMdEvent({
      agentId: threadAgentId,
      accountId: account.accountId,
      groupNo,
      shortId,
      eventType: earlyEventType,
      apiUrl: account.config.apiUrl,
      botToken: account.config.botToken ?? "",
      log,
    }).catch((err) => log?.error?.(`octo: handleThreadMdEvent failed: ${String(err)}`));

    return;
  }

  // Detect mention-pref (免@偏好) update notification — invalidate the cached
  // (bot, group) entry so the next inbound message re-pulls the fresh value, do
  // NOT pass to LLM. Mirrors the GROUP.md early-event pattern above. The mention
  // gate caches no_mention per (accountId, parentGroupNo); without this an owner
  // toggling 免@ would wait up to one TTL window for the change to take effect.
  // TTL still backstops self-healing if this event is ever dropped.
  if (earlyEventType === "mention_pref_updated" && message.channel_id) {
    const groupNo = extractParentGroupNo(message.channel_id);
    invalidateMentionPref(account.accountId, groupNo);
    log?.info?.(`octo: mention_pref_updated for ${groupNo}, cache invalidated`);
    return;
  }

  const isGroup =
    typeof message.channel_id === "string" &&
    message.channel_id.length > 0 &&
    (message.channel_type === ChannelType.Group || message.channel_type === ChannelType.CommunityTopic);

  // --- GROUP.md: register group→account mapping and handle structured events ---
  if (isGroup && message.channel_id) {
    const parentGroupNo = extractParentGroupNo(message.channel_id);
    // Resolve agentId for the group→account mapping
    try {
      const _core = getOctoRuntime();
      const _cfg = _core.config.loadConfig() as OpenClawConfig;
      const _route = _core.channel.routing.resolveAgentRoute({
        cfg: _cfg, channel: CHANNEL_ID, accountId: account.accountId,
        peer: { kind: "group", id: message.channel_id },
      });
      registerGroupAccount(parentGroupNo, account.accountId, _route?.agentId);
    } catch {
      registerGroupAccount(parentGroupNo, account.accountId);
    }

    // Note: group_md_updated/deleted events are handled by the early handler above (line ~530)
    // and never reach here because early handler returns.
  }

  // Parse space_id from channel_id (format: s{spaceId}_{peerId})
  // For DM, channel_id is a fake channel: s{spaceId}_{uid1}@s{spaceId}_{uid2}
  // Use LastIndex approach: spaceId is everything between 's' and the last '_' before peerId
  let spaceId = "";
  const effectiveChannelId = isGroup ? message.channel_id! : message.from_uid;
  if (effectiveChannelId.startsWith("s")) {
    const lastUnderscore = effectiveChannelId.lastIndexOf("_");
    if (lastUnderscore > 0) {
      spaceId = effectiveChannelId.substring(1, lastUnderscore);
    }
  }
  // Also try to extract spaceId from the WS channel_id (compound DM format)
  if (!spaceId && message.channel_id && message.channel_id.startsWith("s")) {
    // DM compound: s{spaceId}_{uid1}@s{spaceId}_{uid2}
    const atIdx = message.channel_id.indexOf("@");
    const firstPart = atIdx > 0 ? message.channel_id.substring(0, atIdx) : message.channel_id;
    if (firstPart.startsWith("s")) {
      const lastUnderscore = firstPart.lastIndexOf("_");
      if (lastUnderscore > 0) {
        spaceId = firstPart.substring(1, lastUnderscore);
      }
    }
  }

  // Session ID: include spaceId for Space isolation (same user in different Spaces = different sessions)
  const sessionId = isGroup
    ? message.channel_id!
    : spaceId ? `${spaceId}:${message.from_uid}` : message.from_uid;

  const resolved = resolveContent(message.payload, account.config.apiUrl, log, account.config.cdnUrl);
  let rawBody = resolved.text;
  let inboundMediaUrl = resolved.mediaUrl;
  // Inbound inline media images, each carrying its local download path (if the
  // download succeeded) and its original remote http(s) URL fallback. Drives the
  // MediaPaths/MediaUrls payload below. RichText(=14) 图文混排 may carry several.
  let inboundMediaItems: InboundMediaItem[] | undefined;

  // Opportunistic uid→name cache fill from MultipleForward payloads
  if (message.payload?.type === MessageType.MultipleForward && Array.isArray(message.payload.users)) {
    for (const u of message.payload.users as Array<{ uid?: string; name?: string }>) {
      if (u.uid && u.name) uidToNameMap.set(u.uid, u.name);
    }
  }

  // For Image/GIF/Voice/Video: download media to local temp file so Core reads
  // local files instead of remote URLs (avoids hang on large/slow downloads in Core)
  const mediaDownloadTypes = [MessageType.Image, MessageType.GIF, MessageType.Voice, MessageType.Video];
  if (inboundMediaUrl && message.payload?.type != null && mediaDownloadTypes.includes(message.payload.type)) {
    const remoteUrl = inboundMediaUrl; // original http(s) URL (always fetchable)
    const localPath = await downloadMediaToLocal(remoteUrl, resolved.mediaType, log);
    inboundMediaUrl = localPath; // undefined on failure — graceful degradation
    inboundMediaItems = [{ localPath, remoteUrl }];
  }
  // RichText(=14): download every embedded image to a local temp file (same
  // rationale as single-media types above). Each image keeps its original remote
  // http(s) URL so Core can re-fetch it whenever the local download failed —
  // unlike single-media types where the url survives inside rawBody, the RichText
  // body is only plain text with [图片] placeholders, so the url must travel as
  // structured media or it is lost.
  if (message.payload?.type === MessageType.RichText && resolved.mediaUrls?.length) {
    const items: InboundMediaItem[] = [];
    for (const remoteUrl of resolved.mediaUrls) {
      const localPath = await downloadMediaToLocal(remoteUrl, guessMime(remoteUrl, "image/jpeg"), log);
      items.push({ localPath, remoteUrl });
    }
    inboundMediaItems = items.length > 0 ? items : undefined;
    // History reference: prefer the first image's local path, else its remote URL.
    inboundMediaUrl = items[0]?.localPath ?? items[0]?.remoteUrl;
  }
  // Inline text file content if possible, or stream large files to temp
  const isFileMessage = message.payload?.type === MessageType.File;
  if (isFileMessage && resolved.mediaUrl) {
    const payloadSize = typeof message.payload.size === "number" ? message.payload.size : undefined;
    const fileName = (message.payload.name as string) ?? "未知文件";
    if (payloadSize != null) {
      log?.info?.(`octo: file message: ${fileName}, payload.size=${formatSize(payloadSize)}`);
    }
    const fileResult = await resolveFileContentWithRetry(
      resolved.mediaUrl,
      account.config.botToken ?? "",
      fileName,
      { knownSize: payloadSize, log },
    );
    if (fileResult && "inline" in fileResult) {
      rawBody = `[文件: ${fileName}]\n\n--- 文件内容 ---\n${fileResult.inline}\n--- 文件结束 ---`;
      inboundMediaUrl = undefined;
    } else if (fileResult && "tempPath" in fileResult) {
      // tempPath is intentionally included in the message body so the agent can read the file
      const sizeStr = payloadSize != null ? ` (${formatSize(payloadSize)})` : "";
      rawBody = `[文件: ${fileName}${sizeStr} - 已下载到本地: ${fileResult.tempPath}]`;
      inboundMediaUrl = undefined;
    } else if (fileResult && "description" in fileResult) {
      rawBody = fileResult.description;
      inboundMediaUrl = undefined;
    }
    // fileResult === null means non-text extension, keep original resolveContent result
  }

  // Media URLs are passed directly to the Agent (storage is public-read, no auth needed)

  if (!rawBody) {
    log?.info?.(
      `octo: inbound dropped session=${sessionId} reason=empty-content`,
    );
    return;
  }

  // Extract quoted/replied message content if present
  let quotePrefix = "";
  const replyData = message.payload?.reply;
  if (replyData) {
    const replyPayload = replyData.payload;
    // RichText(=14) carries `content` as a block array, not a string — using the
    // raw `content` would interpolate `[object Object]`. Only trust a string
    // `content`; otherwise (RichText, or missing) resolve via the type-aware path.
    const rawReplyContent = typeof replyPayload?.content === "string" ? replyPayload.content : undefined;
    const replyContent = rawReplyContent ?? (replyPayload ? resolveContentText(replyPayload, account.config.apiUrl) : "");
    const replyFrom = replyData.from_uid ?? replyData.from_name ?? "unknown";
    if (replyContent) {
      quotePrefix = `[Quoted message from ${replyFrom}]: ${replyContent}\n---\n`;
      log?.info?.(`octo: message quotes a reply (${quotePrefix.length} chars)`);
    }
    // Cache reply sender name for uid→name resolution (opportunistic fill)
    if (replyData.from_uid && replyData.from_name) {
      uidToNameMap.set(replyData.from_uid, replyData.from_name);
    }
  }

  // Refresh group member cache BEFORE the mention gate.
  // The gate's bot-sender classification relies on the server-authoritative
  // GroupMember.robot flag (populated into memberRobotMap by this refresh), so
  // the cache must be warm before we decide whether to relax requireMention.
  // Use parent groupNo for member cache API calls (thread channelIds are compound)
  const memberCacheGroupNo = isGroup
    ? extractParentGroupNo(message.channel_id!)
    : sessionId;
  if (isGroup) {
    await refreshGroupMemberCache({ sessionId: memberCacheGroupNo, memberMap, uidToNameMap, groupCacheTimestamps, memberRobotMap, currentGroupMembersMap, apiUrl: account.config.apiUrl, botToken: account.config.botToken ?? "", log });
  }

  // --- Mention gating for group messages ---
  // Group-aware requireMention: the bot may reply without an explicit @mention
  // only when the server's two-axis decision says so (octo-server YUJ-2996).
  // `effective = no_mention && group_allow_no_mention`:
  //   - no_mention: the bot OWNER marked this (bot, group) as 免@.
  //   - group_allow_no_mention: the GROUP owner/admin allows 免@ in this group.
  // Either axis off → effective=false → the bot still requires an @mention.
  // The preference is per-(bot, group); thread (compound channel_id) messages
  // inherit their PARENT group's preference, so we resolve the parent group_no
  // first. On miss/expiry the cache pulls GET
  // /v1/bot/groups/:group_no/mention_pref (TTL 30s); any failure falls back to
  // the account-level config, so the gate never crashes.
  //
  // The 免@ relaxation is HUMAN-ONLY and FAIL-CLOSED (PR#57 round-4 P1).
  // channel.ts forwards other bots' group messages into here on purpose,
  // relying on this mention gate to drop the non-@ ones. If we relaxed
  // requireMention for a non-human sender, two 免@ bots in the same group would
  // reply to each other with no @ to break the chain — an unbounded bot-to-bot
  // loop (group spam + token burn).
  //
  // Earlier rounds used a BLACKLIST ("relax UNLESS the sender is a proven
  // bot"), which fails OPEN: any sender we could not positively prove was a bot
  // defaulted to "human" and had requireMention relaxed. That left loop paths
  // open whenever classification was uncertain — an unknown/cross-process
  // sender absent from isKnownBot, or ANY sender when refreshGroupMemberCache
  // failed/returned empty so memberRobotMap was never populated (robot flag →
  // undefined → treated as human → reply → loop).
  //
  // We invert to a WHITELIST: relax requireMention ONLY for a sender the
  // server-authoritative member list positively confirms as human. This closes
  // every loop path at once, independent of where the sender came from, how its
  // robot flag was serialized, or whether the member refresh succeeded:
  //   memberRobotMap.get(uid) === false → confirmed human          → may relax
  //   memberRobotMap.get(uid) === true  → confirmed bot             → keep @
  //   memberRobotMap.get(uid) === undefined (unknown sender, OR the
  //       member refresh failed/empty so the map is unpopulated)
  //                                      → classification unknown   → keep @
  //   isKnownBot(uid)                   → bot from this process     → keep @
  //
  // memberRobotMap is populated by the refreshGroupMemberCache() call above;
  // a failed/empty refresh simply leaves the sender's uid absent → undefined →
  // fail-closed. We key on this per-sender map entry rather than the refresh()
  // boolean on purpose: that boolean is ambiguous (it also returns false on a
  // warm-cache hit, and the maps are shared across groups), so gating on it
  // would wrongly suppress replies to humans on every cached message.
  const isFromKnownBot = isKnownBot(message.from_uid);
  const isConfirmedHuman = !isFromKnownBot && memberRobotMap.get(message.from_uid) === false;
  // account-level requireMention: false means the account is already 免@.
  const accountRequiresMention = account.config.requireMention !== false;
  let historyPrefix = "";

  // Save original mention uids for reply (exclude bot itself)
  const originalMentionUids: string[] = (message.payload?.mention?.uids ?? []).filter((uid: string) => uid !== botUid);

  // Compute mention flags — separate "reply gating" from "command gating"
  let isMentioned = false;
  let isExplicitBotMention = false;
  let triggeredByMentionHumans = false;
  if (isGroup) {
    const mentionUids = extractMentionUids(message.payload?.mention);
    const mentionAllRaw = message.payload?.mention?.all;
    const mentionAll: boolean = mentionAllRaw === true || mentionAllRaw === 1;
    // mention.ais=1 means @AI / @所有AI — bots should respond
    const mentionAisRaw = message.payload?.mention?.ais;
    const mentionAis: boolean = mentionAisRaw === true || mentionAisRaw === 1;
    // mention.humans=1 means @所有人 (Plan X) — only persona-clone bots respond,
    // because they act on behalf of a human who IS part of @所有人.
    // Regular bots without onBehalfOf stay silent.
    const mentionHumansRaw = message.payload?.mention?.humans;
    const mentionHumans: boolean = mentionHumansRaw === true || mentionHumansRaw === 1;
    const isPersonaClone = Boolean(account.config.onBehalfOf);
    const grantorUid = account.config.onBehalfOf;
    // Persona clone: when the GRANTOR is @mentioned, treat it as a mention
    // for the bot too (the bot acts on the grantor's behalf).
    const grantorMentioned: boolean = !!(isPersonaClone && grantorUid && mentionUids.includes(grantorUid));
    // Broadcast suppression:
    // `@所有人` (mention.all=1) must NOT trigger bot replies. The server rewrites
    // `@所有人` to also include `ais=1` so AIs are covered, so a `{all:1, ais:1}`
    // payload is a broadcast — treating it as a pure AI mention would let
    // `mentionAis` re-trigger the bot, which is wrong. So when broadcast flags
    // (`all` or `humans`) are present, the AI mention is suppressed. Pure
    // `{ais:1}` (no `all`, no `humans`) is a deliberate AI-only mention and
    // continues to trigger the bot. Explicit bot UID, grantor mention, and the
    // persona-clone `humans` path always work regardless of broadcast flags.
    const isBroadcast = mentionAll || mentionHumans;
    isMentioned = (!isBroadcast && mentionAis)
      || mentionUids.includes(botUid)
      || (mentionHumans && isPersonaClone)
      || grantorMentioned;
    isExplicitBotMention = mentionUids.includes(botUid);
    // Track whether the bot was triggered as the grantor's proxy.
    // When true, persona clone replies as the grantor (admin), not as itself.
    // Covers: @admin (grantor uid mentioned), @所有人 (mention.humans=1),
    // legacy @所有人 (mention.all=1). @所有AI (ais=1 only) and direct @james
    // mentions should still respond as the bot itself.
    const isHumanBroadcast = mentionHumans || mentionAll;
    triggeredByMentionHumans = !!(isHumanBroadcast || grantorMentioned) && isPersonaClone && !isExplicitBotMention;

    // Debug: log mention flags for troubleshooting persona clone routing
    if (isPersonaClone) {
      log?.debug?.(`octo: [MENTION-DEBUG] mentionAll=${mentionAll} mentionAis=${mentionAis} mentionHumans=${mentionHumans} isExplicitBot=${isExplicitBotMention} isHumanBroadcast=${isHumanBroadcast} triggeredAsGrantor=${triggeredByMentionHumans} isMentioned=${isMentioned}`);
    }

    // Defensive fallback: if payload.mention is missing/empty but the message
    // text contains @botName, treat it as a mention.  This covers old senders
    // that don't populate the mention payload (e.g. bot-to-bot messages).
    if (!isMentioned && rawBody && message.payload?.type === MessageType.Text) {
      const botName = uidToNameMap.get(botUid);
      if (botName?.trim()) {
        const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Lookbehind: more conservative than MENTION_PATTERN — also excludes CJK and extended
        // Latin ranges so that adjacent Chinese text (e.g. '你好@BotName') is not a false
        // positive.  Trade-off: '你好@BotName' without payload.mention is treated as non-mention;
        // this is intentional — a false positive (spurious bot activation) is worse than a false
        // negative (user simply re-sends with a space before @).
        const re = new RegExp(`(?<=^|[^\\w\\u4e00-\\u9fff\\u3040-\\u30FF\\uAC00-\\uD7AF\\u00C0-\\u024F])@${escaped}(?![\\w\\u4e00-\\u9fff\\u3040-\\u30FF\\uAC00-\\uD7AF\\u00C0-\\u024F.\\-])`);
        if (re.test(rawBody)) {
          isMentioned = true;
          isExplicitBotMention = true;
          log?.debug?.(`octo: [RECV] isMentioned set by text fallback (@${botName})`);
        }
      }
    }
  }

  // Group 免@ preference lookup — deferred until AFTER mention flags are known.
  // Only consult the group pref when it can actually change the outcome:
  //   1. isGroup && accountRequiresMention — else the pref can only return
  //      effective=false, with no effect.
  //   2. isConfirmedHuman — the 免@ relaxation is whitelist/fail-closed: it
  //      applies ONLY to a sender the member list positively confirms is human.
  //      Unknown senders, refresh failures, and any bot keep requireMention, so
  //      there is no point paying for the pref lookup for them either.
  //   3. !isMentioned — an explicit @bot message already passes the gate, so
  //      the pref can't change anything. Short-circuiting here keeps explicit
  //      @bot replies off the (cold/slow) pref network path entirely, avoiding
  //      up to MENTION_PREF_TIMEOUT_MS of needless latency on the hot path.
  const shouldCheckGroupPref =
    isGroup && accountRequiresMention && isConfirmedHuman && !isMentioned;
  const mentionPref = shouldCheckGroupPref
    ? await getMentionPrefFromCache({
        accountId: account.accountId,
        parentGroupNo: extractParentGroupNo(message.channel_id!),
        apiUrl: account.config.apiUrl,
        // botToken ?? "" can yield an empty `Bearer` header; getMentionPref
        // treats any non-2xx (incl. the resulting 401) as effective=false, so
        // the gate safely falls back to the account-level config.
        botToken: account.config.botToken ?? "",
        log,
      })
    : undefined;
  const requireMention = mentionPref?.effective === true
    ? false
    : accountRequiresMention;

  if (isGroup && requireMention) {
    // Debug: log received mention info
    log?.debug?.(`octo: [RECV] mention payload: isMentioned=${isMentioned}, originalCount=${originalMentionUids.length}`);

    if (!isMentioned) {
      // Record as pending history context (manual — avoids SDK format incompatibility)
      if (!groupHistories.has(sessionId)) {
        groupHistories.set(sessionId, []);
      }
      const entries = groupHistories.get(sessionId)!;
      entries.push({
        sender: message.from_uid,
        body: rawBody,
        mention: message.payload?.mention,
        mediaUrl: inboundMediaUrl,
        msgType: message.payload?.type,
        timestamp: message.timestamp ? message.timestamp * 1000 : Date.now(),
        message_id: message.message_id,
        message_seq: message.message_seq,
      });
      const historyLimit = account.config.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT;
      while (entries.length > historyLimit) {
        entries.shift();
      }
      log?.info?.(
        `octo: [HISTORY] 非@消息已缓存 | from=${message.from_uid} | session=${sessionId} | 当前缓存=${entries.length}条`,
      );
      return;
    }

    // Bot IS mentioned — prepend history context (manual — avoids SDK format incompatibility)
    // Sliding window: always include the most recent historyLimit messages
    const historyLimit = account.config.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT;
    let entries = groupHistories.get(sessionId) ?? [];
    // Take last N entries (sliding window)
    if (entries.length > historyLimit) {
      entries = entries.slice(-historyLimit);
      groupHistories.set(sessionId, entries); // Persist trimmed array to prevent unbounded growth
    }
    const historyCountBefore = entries.length;
    log?.info?.(`octo: [MENTION] 收到@消息 | 缓存=${historyCountBefore}条 | historyLimit=${historyLimit}`);

    // If memory cache is empty or insufficient, try fetching from API
    const cacheInsufficient = entries.length < Math.ceil(historyLimit / 2);
    if (cacheInsufficient && account.config.botToken) {
      log?.info?.(`octo: [MENTION] 缓存不足(${entries.length}/${historyLimit})，从API补充历史...`);
      try {
        const fetchLimit = Math.min(historyLimit, 100);  // Cap at 100
        const apiMessages = await getChannelMessages({
          apiUrl: account.config.apiUrl,
          botToken: account.config.botToken,
          channelId: message.channel_id!,
          channelType: message.channel_type ?? ChannelType.Group,
          limit: fetchLimit,
          log,
        });

        // Cold-start: derive initial cutoff from bot replies in API backfill
        if ((lastBotReplySeqMap.get(sessionId) ?? 0) === 0 && apiMessages.length > 0) {
          let inferredCutoff = 0;
          for (const m of apiMessages) {
            if (
              m.from_uid === botUid &&
              typeof m.message_seq === "number" &&
              m.message_seq > inferredCutoff
            ) {
              inferredCutoff = m.message_seq;
            }
          }
          if (inferredCutoff > 0) {
            lastBotReplySeqMap.set(sessionId, inferredCutoff);
            log?.info?.(
              `octo: [MENTION] derived initial lastBotReplySeq=${inferredCutoff} from API backfill | session=${sessionId}`,
            );
          }
        }

        const filteredApiMsgs = apiMessages
          .filter((m: any) => m.from_uid !== botUid && (m.content || m.type !== 1))
          .sort((a: any, b: any) => (a.message_seq ?? 0) - (b.message_seq ?? 0))
          .slice(-historyLimit);
        entries = filteredApiMsgs.map((m: any) => {
          let body = m.content || resolveApiMessagePlaceholder(m.type, m.name);
          // For MultipleForward, expand the nested messages from full payload
          if (m.type === MessageType.MultipleForward && m.payload) {
            body = resolveMultipleForwardText(m.payload, account.config.apiUrl, account.config.cdnUrl);
          }
          // For RichText(=14), expand the 图文混排 payload into a single-line
          // semantic body (plain text with [图片] placeholders), same as inbound.
          if (m.type === MessageType.RichText && m.payload) {
            const apiResolved = resolveContent(m.payload, account.config.apiUrl, log, account.config.cdnUrl);
            if (apiResolved.text) body = apiResolved.text;
          }
          const entry: any = {
            sender: m.from_uid,
            body,
            mention: m.payload?.mention,
            msgType: m.type,
            timestamp: m.timestamp,
            message_id: m.message_id,
            message_seq: m.message_seq,
          };
          // For media message types, resolve the URL directly (storage is public-read)
          const mediaTypes = [MessageType.Image, MessageType.File, MessageType.Voice, MessageType.Video];
          if (mediaTypes.includes(m.type) && !m.content) {
            const apiResolved = resolveContent({ type: m.type, url: m.url, name: m.name } as any, account.config.apiUrl, log, account.config.cdnUrl);
            if (apiResolved.mediaUrl) {
              entry.mediaUrl = apiResolved.mediaUrl;
              entry.body = apiResolved.text;
            }
          }
          return entry;
        });
        log?.info?.(`octo: [MENTION] 从API获取到 ${entries.length} 条历史消息`);
      } catch (err) {
        log?.error?.(`octo: [MENTION] 从API获取历史失败: ${err}`);
      }
    }

    // Build history context manually (JSON format)
    // History media URLs are kept in the text body only — not passed as MediaUrls
    // to Core (they are remote URLs; only local paths should go through MediaUrls)
    if (entries.length > 0) {
      const cutoffSeq = lastBotReplySeqMap.get(sessionId) ?? 0;
      const currentMsgId = message.message_id;

      const { answered: answeredEntries, new: newEntries } = segmentHistoryEntries({
        entries,
        cutoffSeq,
        currentMsgId,
      });

      const formatEntries = (items: any[]) => JSON.stringify(items.map((e: any) => {
        const bodyForLLM = e.mention
          ? convertContentForLLM(e.body, e.mention, memberMap)
          : e.body;
        const senderLabel = buildSenderPrefix(e.sender, uidToNameMap);
        return {
          sender: senderLabel,
          body: bodyForLLM,
          ...(e.mediaUrl ? { mediaUrl: e.mediaUrl } : {}),
        };
      }), null, 2);

      const ANSWERED_HEADER = "[Previous context - already answered, do NOT re-answer]";
      const NEW_HEADER = "[Chat messages since your last reply - for context only, do NOT re-answer questions from this history]";
      const CURRENT_HEADER = "[Current message - respond to this ONLY]";

      let historyBlock = "";

      if (answeredEntries.length > 0) {
        historyBlock += `${ANSWERED_HEADER}\n\`\`\`json\n${formatEntries(answeredEntries)}\n\`\`\`\n\n`;
      }
      if (newEntries.length > 0) {
        historyBlock += `${NEW_HEADER}\n\`\`\`json\n${formatEntries(newEntries)}\n\`\`\`\n\n`;
      }

      if (historyBlock) {
        const template = account.config.historyPromptTemplate;
        if (template) {
          const hasSegmentedPlaceholders =
            template.includes("{answered_messages}") ||
            template.includes("{new_messages}");

          if (hasSegmentedPlaceholders) {
            historyPrefix = template
              .replace("{answered_messages}", formatEntries(answeredEntries))
              .replace("{new_messages}", formatEntries(newEntries))
              .replace("{answered_count}", String(answeredEntries.length))
              .replace("{new_count}", String(newEntries.length))
              .replace("{messages}", formatEntries([...answeredEntries, ...newEntries]))
              .replace("{count}", String(answeredEntries.length + newEntries.length));
          } else {
            const filteredEntries = entries.filter((e: any) => e.message_id !== currentMsgId);
            const allFormatted = formatEntries(filteredEntries);
            const legacyPreamble = answeredEntries.length > 0
              ? `[Note: The first ${answeredEntries.length} message(s) below have already been answered. Do NOT re-answer them.]\n`
              : "";
            historyPrefix = legacyPreamble + template
              .replace("{messages}", allFormatted)
              .replace("{count}", String(filteredEntries.length));
          }
        } else {
          historyPrefix = historyBlock + `${CURRENT_HEADER}\n\n`;
        }
        log?.info?.(`octo: [MENTION] 已注入历史上下文 | ${historyPrefix.length} chars | answered=${answeredEntries.length} new=${newEntries.length}`);
      } else {
        log?.info?.(`octo: [MENTION] 历史条目全部被过滤 | answered=${answeredEntries.length} new=${newEntries.length}`);
      }
    } else {
      log?.info?.(`octo: [MENTION] 无历史上下文可注入`);
    }

    // History retained for context continuity; segmented by lastBotReplySeq at prompt build time
    log?.info?.(`octo: [MENTION] 历史保留（按 message_seq 分段标注） | session=${sessionId}`);
  }

  const core = getOctoRuntime();
  if (!core?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
    log?.error?.(`octo: OpenClaw runtime missing required functions. Available: config=${!!core?.config}, channel=${!!core?.channel}, reply=${!!core?.channel?.reply}, routing=${!!core?.channel?.routing}, session=${!!core?.channel?.session}`);
    log?.error?.(`octo: reply methods: ${core?.channel?.reply ? Object.keys(core.channel.reply).join(",") : "N/A"}`);
    log?.error?.(`octo: session methods: ${core?.channel?.session ? Object.keys(core.channel.session).join(",") : "N/A"}`);
    log?.error?.(`octo: routing methods: ${core?.channel?.routing ? Object.keys(core.channel.routing).join(",") : "N/A"}`);
    return;
  }

  const config = core.config.loadConfig() as OpenClawConfig;

  let route;
  try {
    route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: sessionId,
    },
  });

  } catch (routeErr) {
    log?.error?.(`octo: resolveAgentRoute failed: ${String(routeErr)}`);
    return;
  }

  // Fire-and-forget: ensure GROUP.md is cached for this group
  if (isGroup && message.channel_id) {
    const _parentGroupNo = extractParentGroupNo(message.channel_id);
    const _threadShortId = extractThreadShortId(message.channel_id);

    // Always ensure group-level GROUP.md is cached
    ensureGroupMd({
      agentId: route.agentId,
      accountId: account.accountId,
      groupNo: _parentGroupNo,
      apiUrl: account.config.apiUrl,
      botToken: account.config.botToken ?? "",
      log,
    }).catch((err) => log?.warn?.(`octo: [GROUP.md] ensureGroupMd failed: ${String(err)}`));

    // For thread messages, also ensure thread-level THREAD.md is cached
    if (_threadShortId) {
      ensureThreadMd({
        agentId: route.agentId,
        accountId: account.accountId,
        groupNo: _parentGroupNo,
        shortId: _threadShortId,
        apiUrl: account.config.apiUrl,
        botToken: account.config.botToken ?? "",
        log,
      }).catch((err) => log?.warn?.(`octo: [THREAD.md] ensureThreadMd failed: ${String(err)}`));
    }
  }

  const fromLabel = isGroup
    ? `group:${message.channel_id}`
    : spaceId ? `space:${spaceId}:user:${message.from_uid}` : `user:${message.from_uid}`;

  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });

  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  // memberListPrefix and historyPrefix are injected via before_prompt_build hook
  // (not persisted to session history). Only quotePrefix stays in Body.
  // Use the CURRENT group's roster (per-group, keyed by parent groupNo), not the
  // flat per-account uidToNameMap (which is the cross-group union) so the count
  // and member list reflect this group only (#125). On fetch failure the entry
  // is negative-cached (absent) → empty prefix, never a stale/foreign roster.
  const currentGroupMembers = isGroup
    ? (currentGroupMembersMap.get(memberCacheGroupNo) ?? [])
    : [];
  const memberListPrefix = isGroup ? buildMemberListPrefix(currentGroupMembers) : "";
  if (historyPrefix || memberListPrefix) {
    pendingInboundContext.set(route.sessionKey, { historyPrefix, memberListPrefix });
  }

  // Record (accountId, sessionKey) so the before_prompt_build hook can
  // resolve persona identity from ctx.sessionKey (hook ctx does not expose
  // accountId). The composite key is required for multi-account isolation —
  // see the doc comment on sessionAccountMap above.
  // Required by persona-prompt injection (GH octo-adapters#68).
  // recordSessionAccount normalizes both key AND value so mixed-case bot
  // ids (issue #33) cannot split a single bot's presence across two entries.
  recordSessionAccount(account.accountId, route.sessionKey);

  const finalBody = quotePrefix ? (quotePrefix + rawBody) : rawBody;

  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Octo",
    from: fromLabel,
    timestamp: message.timestamp ? message.timestamp * 1000 : undefined,
    previousTimestamp,
    envelope: envelopeOptions,
    body: finalBody,
  });

  // GROUP.md injection is handled exclusively by the before_prompt_build hook
  // (see index.ts → getGroupMdForPrompt) — no longer set here to avoid duplication.

  // Resolve sender display name — async fallback for DM users not in cache
  let senderName = resolveSenderName(message.from_uid, uidToNameMap);
  if (!senderName && !isGroup) {
    // DM user not in any group cache — try backend user info API
    // Skip if we already tried and failed (negative cache sentinel "")
    const cached = uidToNameMap.get(message.from_uid);
    if (cached === undefined) {
      const userInfo = await fetchUserInfo({
        apiUrl: account.config.apiUrl,
        botToken: account.config.botToken ?? "",
        uid: message.from_uid,
        log,
      });
      if (userInfo?.name) {
        senderName = userInfo.name;
        uidToNameMap.set(message.from_uid, userInfo.name);
      } else {
        // Negative cache — prevent repeated API calls for unknown UIDs
        uidToNameMap.set(message.from_uid, "");
      }
    }
  }

  const commandBody = resolveCommandBody(rawBody, isGroup, isExplicitBotMention);
  const commandAuthorized = resolveCommandAuthorized(isGroup, isOwner(account.accountId, message.from_uid), isExplicitBotMention);

  // OBO v2 detection + relevance filter (R10): Must run BEFORE
  // finalizeInboundContext / recordInboundSession so that irrelevant
  // OBO v2 messages (e.g. AI-only fan-out) do not leak any state —
  // including `obo_system_hint` as GroupSystemPrompt — into the bot's
  // DM session with the grantor. Mirrors the group-path early-return at
  // ~L1300 (non-mention group messages return before session is recorded).
  const oboV2OriginChannel = message.payload?.obo_origin_channel_id;
  const oboV2OriginChannelType = message.payload?.obo_origin_channel_type;
  const oboV2RespondAs = message.payload?.obo_respond_as ?? message.payload?.obo_grantor_uid;
  const grantorUid = account.config.onBehalfOf;
  const isOBOv2 = Boolean(
    typeof oboV2OriginChannel === "string" &&
    oboV2OriginChannel.length > 0 &&
    typeof oboV2RespondAs === "string" &&
    oboV2RespondAs.length > 0 &&
    // Security: only trust OBO v2 fields when the message is sent by the
    // configured grantor. Without this, any user able to put obo_* fields in
    // their payload could trick the bot into replying in another channel as
    // somebody else's persona.
    grantorUid && message.from_uid === grantorUid
  );

  if (!isOBOv2 && typeof oboV2OriginChannel === "string" && oboV2OriginChannel.length > 0) {
    log?.warn?.(`octo: OBO v2 payload rejected — from_uid=${message.from_uid} is not configured grantor ${grantorUid ?? "(none)"}`);
  }

  // OBO v2 relevance filter: when the fan-out message is @AI-only (mention.ais=1
  // but no grantor mention, no @所有人), the persona clone should NOT respond.
  // @AI targets AI bots directly, not humans or their persona clones.
  //
  // Mirrors the group-path semantics (see ~L1223/L1230): broadcast-style
  // mentions (`mention.humans=1`, `mention.all=1`) are relevant for the persona
  // clone because the grantor (a human) is part of the broadcast. Explicit
  // grantor UID mentions also remain relevant, because they target the grantor
  // identity directly.
  //
  // CRITICAL (R10): this filter MUST run before finalizeInboundContext /
  // recordInboundSession — otherwise an irrelevant OBO v2 message would
  // already have been persisted to the bot's DM session with the grantor,
  // including any `obo_system_hint` as GroupSystemPrompt.
  if (isOBOv2) {
    const origMention = message.payload?.mention;
    const origAis = origMention?.ais === true || origMention?.ais === 1;
    const origHumans = origMention?.humans === true || origMention?.humans === 1;
    const origAll = origMention?.all === true || origMention?.all === 1;
    const origUids: string[] = Array.isArray(origMention?.uids) ? origMention.uids : [];
    // Use the trusted configured grantor (account.config.onBehalfOf) for the
    // explicit-mention relevance check, mirroring the group path. This is
    // also what `effectiveOnBehalfOf` resolves to below; `oboV2RespondAs`
    // from the payload is for diagnostic logging only.
    const grantorInUids = typeof grantorUid === "string" && grantorUid.length > 0
      && origUids.includes(grantorUid);
    const broadcastRelevant = origHumans || origAll;
    // No-mention fallback: when the payload carries no mention information at
    // all (no ais, no humans, no all, no uids), treat the message as relevant
    // (plain group/DM chatter the persona should see).
    const noMentionFallback = !origAis && !origHumans && !origAll && origUids.length === 0;
    const isRelevantToPersona = broadcastRelevant || grantorInUids || noMentionFallback;
    if (!isRelevantToPersona) {
      log?.info?.(`octo: OBO v2 skipped — message not relevant to persona (ais=${origAis} humans=${origHumans} all=${origAll} grantorInUids=${grantorInUids})`);
      // Mirror group-path early-return: do NOT call finalizeInboundContext /
      // recordInboundSession, so no DM session record (and no GroupSystemPrompt)
      // is persisted for irrelevant OBO v2 fan-out messages.
      return;
    }
  }

  // Compute GroupSystemPrompt for two distinct persona-clone scenarios:
  //
  //   1. OBO v2 DM-relay path: bot is friends with the grantor only; the
  //      grantor sends a relay message carrying `obo_system_hint` so the
  //      LLM knows it is acting as the grantor's persona in the origin
  //      group. The hint must come from the configured grantor (security).
  //
  //   2. Group path (GH octo-adapters#64): grantor and persona clone bot
  //      are both members of the group, so the message arrives as a normal
  //      group event (not OBO v2). When `triggeredByMentionHumans` is true
  //      (i.e. @grantor / @所有人 / legacy @everyone), the bot replies as
  //      the grantor — but without a system hint the LLM sees `@grantor`
  //      and concludes "not addressed to me" → NO_REPLY. Inject a locally
  //      synthesized hint so the LLM understands it is the grantor's
  //      persona clone and should respond.
  //
  // OBO v2 takes precedence: if the message carries a valid OBO v2
  // envelope from the grantor, we use the payload-supplied hint as-is.
  let groupSystemPrompt: string | undefined;
  const oboHintTrusted =
    typeof message.payload?.obo_system_hint === "string" && message.payload.obo_system_hint.length > 0 &&
    typeof message.payload?.obo_origin_channel_id === "string" && message.payload.obo_origin_channel_id.length > 0 &&
    typeof (message.payload?.obo_respond_as ?? message.payload?.obo_grantor_uid) === "string" &&
    // Security: only trust system hint from the configured grantor. Without
    // this sender gate, a forged message from any uid could inject arbitrary
    // system-level instructions into the LLM — the downstream OBO routing
    // would be rejected, but the system prompt would already be in session.
    Boolean(account.config.onBehalfOf) && message.from_uid === account.config.onBehalfOf;
  if (oboHintTrusted) {
    groupSystemPrompt = message.payload!.obo_system_hint as string;
  } else if (isGroup && triggeredByMentionHumans && account.config.onBehalfOf) {
    // Group path persona hint (GH octo-adapters#64). The bot was triggered
    // because someone @-mentioned the grantor (or @所有人 / legacy @everyone)
    // and the bot is the grantor's persona clone. Without this hint the LLM
    // sees `@grantor` in the body, concludes the message is not for it, and
    // returns NO_REPLY. Synthesized locally — no payload trust needed because
    // the values come from server-trusted config (`onBehalfOf`) and the
    // already-resolved group member map.
    groupSystemPrompt = buildPersonaGroupSystemPrompt(account.config.onBehalfOf, uidToNameMap);
    // Append cached persona_prompt so the GroupSystemPrompt carries the full
    // custom instruction (e.g. "always reply in English"). Without this,
    // only the generic "you are X's clone" hint lands in GroupSystemPrompt
    // and the persona_prompt only reaches via prependSystemContext which
    // has lower effective priority.
    const cachedHint = getPersonaPromptForSession(account.accountId);
    if (cachedHint) {
      groupSystemPrompt += '\n\n' + cachedHint;
    }
  }

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: body,
    RawBody: rawBody,
    CommandBody: commandBody,
    BodyForCommands: commandBody,
    CommandAuthorized: commandAuthorized,
    // Scalar MediaUrl/MediaPath mirror the array all-or-nothing decision so a
    // single-media consumer never sees a local path while the arrays fell back
    // to remote URLs (and vice versa). All-local → first local path; mixed-fail
    // → first remote URL (matching MediaUrls[0], never an unstaged local path).
    MediaUrl: isFileMessage ? undefined : (resolveInboundMediaList(inboundMediaItems)?.[0] ?? inboundMediaUrl),
    // MediaPath(s) / MediaUrls — ALL-OR-NOTHING (see resolveInboundMediaPaths):
    // inbound media is downloaded to a Core-allowed local root, so when EVERY
    // image succeeds we pass the compact local fs paths via MediaPath(s). Core's
    // normalizeAttachments prefers MediaPaths and fs-reads them, avoiding the
    // readRemoteMediaBuffer http path that throws MediaFetchError on bare local
    // paths (the #58 bug). If ANY image download failed we emit NO MediaPaths
    // (undefined) and put every image's original remote http(s) URL in MediaUrls;
    // Core then takes the URL branch and http-fetches them. This never produces a
    // sparse MediaPaths array, so the sandbox staging path (resolveRawPaths →
    // raw.trim()) cannot crash on an undefined slot.
    MediaPath: (() => {
      if (isFileMessage) return undefined;
      const paths = resolveInboundMediaPaths(inboundMediaItems);
      return paths?.[0];
    })(),
    MediaPaths: isFileMessage ? undefined : resolveInboundMediaPaths(inboundMediaItems),
    MediaUrls: isFileMessage ? undefined : resolveInboundMediaList(inboundMediaItems),
    MediaTypes: (() => {
      if (isFileMessage) return undefined;
      // Align MediaTypes index-for-index with the MediaUrls/MediaPaths arrays.
      // Both helpers return same-length, same-order lists, so deriving mime from
      // the MediaUrls list keeps each attachment's mime correct.
      const list = resolveInboundMediaList(inboundMediaItems);
      if (list?.length) {
        if (inboundMediaItems && inboundMediaItems.length > 1) {
          return list.map((u) => guessMime(u, "image/jpeg"));
        }
        return resolved.mediaType ? [resolved.mediaType] : list.map((u) => guessMime(u, "image/jpeg"));
      }
      return resolved.mediaType ? [resolved.mediaType] : undefined;
    })(),
    From: `${CHANNEL_ID}:${message.from_uid}`,
    To: `${CHANNEL_ID}:${sessionId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderId: message.from_uid,
    SenderName: senderName,
    SenderUsername: message.from_uid,
    WasMentioned: isGroup ? isMentioned : undefined,
    MessageSid: String(message.message_id),
    Timestamp: message.timestamp ? message.timestamp * 1000 : undefined,
    GroupSubject: isGroup ? message.channel_id : undefined,
    GroupSystemPrompt: groupSystemPrompt,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `${CHANNEL_ID}:${sessionId}`,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      log?.error?.(`octo: failed updating session meta: ${String(err)}`);
    },
  });

  statusSink?.({ lastInboundAt: Date.now(), lastError: null });

  // OBO v2: when the payload carries `obo_origin_channel_id`, the reply should
  // go to the origin GROUP channel (not the DM), with `on_behalf_of` set to
  // `obo_respond_as` (the grantor). This way the bot replies in the group as
  // the grantor, not in DM.
  //
  // Detection (`isOBOv2`) and the relevance filter that gates an early-return
  // have already run BEFORE finalizeInboundContext / recordInboundSession
  // (see R10 fix above) so that irrelevant OBO v2 fan-out messages do not
  // leak `obo_system_hint` (as GroupSystemPrompt) into the bot's DM session.
  // The reply-routing variables below (`replyChannelId`, `replyChannelType`,
  // `effectiveOnBehalfOf`) are derived here using the previously-computed
  // `isOBOv2`, `oboV2OriginChannel`, `oboV2OriginChannelType`, and
  // `oboV2RespondAs`.

  let replyChannelId: string;
  let replyChannelType: ChannelType;
  let effectiveOnBehalfOf: string | undefined;

  if (isOBOv2) {
    const oboV2OriginFromUid = message.payload?.obo_origin_from_uid;
    const resolvedChannelType = (typeof oboV2OriginChannelType === "number" ? oboV2OriginChannelType : ChannelType.Group) as ChannelType;
    if (resolvedChannelType === ChannelType.DM) {
      // DM: bot is only friends with the grantor, not the original sender.
      // Reply to the original sender (bob) using on_behalf_of=grantor (admin).
      // The channel is the original sender's uid — the server routes
      // admin→bob DM via on_behalf_of, which bypasses the bot-friend gate.
      replyChannelId = (typeof oboV2OriginFromUid === "string" && oboV2OriginFromUid.length > 0)
        ? oboV2OriginFromUid
        : oboV2OriginChannel as string;
    } else {
      // Group/Thread: reply to the origin group
      replyChannelId = oboV2OriginChannel as string;
    }
    replyChannelType = resolvedChannelType;
    // Security: always use the trusted account.config.onBehalfOf as the
    // authoritative grantor identity. `oboV2RespondAs` comes from the payload
    // and must not be trusted as the reply identity — it is kept only for
    // logging/debug visibility. (`isOBOv2` above already guarantees
    // account.config.onBehalfOf is non-empty.)
    effectiveOnBehalfOf = account.config.onBehalfOf!;
    if (oboV2RespondAs !== effectiveOnBehalfOf) {
      log?.warn?.(`octo: OBO v2 payload respondAs=${oboV2RespondAs} differs from configured grantor=${effectiveOnBehalfOf} — using configured grantor`);
    }
    log?.info?.(`octo: OBO v2 detected — reply target=${replyChannelId} type=${replyChannelType} respondAs=${effectiveOnBehalfOf} payloadRespondAs=${oboV2RespondAs} originFrom=${oboV2OriginFromUid}`);
  } else {
    replyChannelId = isGroup ? message.channel_id! : message.from_uid;
    replyChannelType = isGroup ? (message.channel_type ?? ChannelType.Group) : ChannelType.DM;
    // Persona clone: only reply as grantor when triggered by @所有人 (mention.humans=1).
    // When the bot is directly mentioned (@James, @AI), respond as itself.
    effectiveOnBehalfOf = (isGroup && triggeredByMentionHumans && account.config.onBehalfOf) ? account.config.onBehalfOf : undefined;
  }

  const apiUrl = account.config.apiUrl;
  const botToken = account.config.botToken ?? "";

  // 已读回执 + 正在输入 — fire-and-forget
  if (isOBOv2) {
    // v2: send typing to origin group with grantor identity (skip readReceipt)
    log?.info?.(`octo: OBO v2 — sending typing to origin group=${replyChannelId} as=${effectiveOnBehalfOf}`);
    sendTyping({ apiUrl, botToken, channelId: replyChannelId, channelType: replyChannelType, onBehalfOf: effectiveOnBehalfOf })
      .then(() => log?.info?.("octo: OBO v2 typing sent OK"))
      .catch((err) => log?.error?.(`octo: OBO v2 typing failed: ${String(err)}`));
  } else {
    log?.info?.(`octo: sending readReceipt+typing to channel=${replyChannelId} type=${replyChannelType} apiUrl=${apiUrl}`);
    const messageIds = message.message_id ? [message.message_id] : [];
    sendReadReceipt({ apiUrl, botToken, channelId: replyChannelId, channelType: replyChannelType, messageIds })
      .then(() => log?.info?.("octo: readReceipt sent OK"))
      .catch((err) => log?.error?.(`octo: readReceipt failed: ${String(err)}`));
    sendTyping({ apiUrl, botToken, channelId: replyChannelId, channelType: replyChannelType, ...(effectiveOnBehalfOf ? { onBehalfOf: effectiveOnBehalfOf } : {}) })
      .then(() => log?.info?.(`octo: typing sent OK${effectiveOnBehalfOf ? ` (as ${effectiveOnBehalfOf})` : ""}`))
      .catch((err) => log?.error?.(`octo: typing failed: ${String(err)}`));
  }

  // Keep sending typing indicator while AI is processing
  const typingInterval = setInterval(() => {
    sendTyping({ apiUrl, botToken, channelId: replyChannelId, channelType: replyChannelType, ...(effectiveOnBehalfOf ? { onBehalfOf: effectiveOnBehalfOf } : {}) }).catch(() => {});
  }, 5000);

  // Buffer text across streaming deliver calls; only send once after dispatcher finishes.
  // Media is sent immediately (no edit problem); text is buffered (each call overwrites).
  const deliverBuffer = {
    lastText: null as string | null,
    textSent: false,
  };
  const sentMediaUrls = new Set<string>();
  let userFacingFinalDelivered = false;
  let pendingToolWarningFinal: { text: string } | undefined;
  let deliveryErrorOccurred = false;

  // --- Shared helper: resolve mentions and send text ---
  const resolveAndSendText = async (content: string, signal?: AbortSignal): Promise<SendMessageResult | undefined> => {
    let replyMentionUids: string[] = [];
    let replyMentionEntities: MentionEntity[] = [];
    let finalContent = content;

    if (isGroup) {
      const structuredMentions = parseStructuredMentions(content);

      if (structuredMentions.length > 0) {
        // v2 path: LLM used @[uid:name] format
        const converted = convertStructuredMentions(
          content,
          structuredMentions,
        );
        finalContent = converted.content;
        replyMentionEntities = [...converted.entities];

        // Mixed scenario: check for remaining @name in converted content
        const remaining = buildEntitiesFromFallback(finalContent, memberMap);
        const existingOffsets = new Set(replyMentionEntities.map((e) => e.offset));
        for (const rm of remaining.entities) {
          if (!existingOffsets.has(rm.offset)) {
            replyMentionEntities.push(rm);
          }
        }

        log?.debug?.(
          `octo: [REPLY] structured mentions: ${structuredMentions.length}, fallback: ${remaining.entities.length}`,
        );
      } else {
        // v1 fallback path: LLM used @name format
        const contentMentions = extractMentionMatches(content);

        const unresolvedNames: { name: string; index: number }[] = [];

        const resolveMention = (name: string): { uid: string | null; newContent: string } => {
          const uid = findUidByName(name, memberMap);
          let newContent = finalContent;

          if (uid) {
            return { uid, newContent };
          } else if (/^[a-f0-9]{32}$/i.test(name)) {
            const displayName = uidToNameMap.get(name);
            if (displayName) {
              newContent = newContent.replace(`@${name}`, `@${displayName}`);
              return { uid: name, newContent };
            }
            return { uid: name, newContent };
          } else if (/^[a-zA-Z0-9_]+$/.test(name)) {
            const displayName = uidToNameMap.get(name);
            if (displayName) {
              newContent = newContent.replace(`@${name}`, `@${displayName}`);
              return { uid: name, newContent };
            }
            return { uid: name, newContent };
          }
          return { uid: null, newContent };
        };

        const resolvedUids: (string | null)[] = [];
        for (const mention of contentMentions) {
          const name = mention.slice(1);
          const result = resolveMention(name);
          finalContent = result.newContent;
          resolvedUids.push(result.uid);
          if (!result.uid) {
            unresolvedNames.push({ name, index: resolvedUids.length - 1 });
          }
        }

        if (unresolvedNames.length > 0) {
          log?.info?.(`octo: [REPLY] ${unresolvedNames.length} unresolved names, force refreshing cache...`);
          const refreshed = await refreshGroupMemberCache({ sessionId: memberCacheGroupNo, memberMap, uidToNameMap, groupCacheTimestamps, memberRobotMap, currentGroupMembersMap, apiUrl: account.config.apiUrl, botToken: account.config.botToken ?? "", forceRefresh: true, log });
          if (refreshed) {
            for (const { name, index } of unresolvedNames) {
              const uid = findUidByName(name, memberMap);
              if (uid) {
                resolvedUids[index] = uid;
              }
            }
          }
        }

        replyMentionUids = resolvedUids.filter((uid): uid is string => uid !== null);
        const fallbackResult = buildEntitiesFromFallback(finalContent, memberMap);
        replyMentionEntities = fallbackResult.entities;
      }

      // Sort entities by offset and rebuild uids from sorted entities
      if (replyMentionEntities.length > 0) {
        replyMentionEntities.sort((a, b) => a.offset - b.offset);
        replyMentionUids = replyMentionEntities.map((e) => e.uid);
      }
    }

    // Detect @all/@所有人 in final content
    const hasAtAll = /(?:^|(?<=\s))@(?:all|所有人)(?=\s|[^\w]|$)/i.test(finalContent);

    const result = await sendMessage({
      apiUrl: account.config.apiUrl,
      botToken: account.config.botToken ?? "",
      channelId: replyChannelId,
      channelType: replyChannelType,
      content: finalContent,
      ...(replyMentionUids.length > 0 ? { mentionUids: replyMentionUids } : {}),
      ...(replyMentionEntities.length > 0 ? { mentionEntities: replyMentionEntities } : {}),
      mentionAll: hasAtAll || undefined,
      ...(effectiveOnBehalfOf ? { onBehalfOf: effectiveOnBehalfOf } : {}),
      ...(signal ? { signal } : {}),
    });
    statusSink?.({ lastOutboundAt: Date.now(), lastError: null });
    return result;
  };

  let replySucceeded = false;

  // Timeout guard: see resolveDispatchTimeoutMs at top of file. Without this,
  // an upstream dispatch hang would leave the per-group queue's Promise chain
  // unresolved forever — see issue #75.
  //
  // Scope note: we intentionally do NOT try to cancel an already-in-flight
  // dispatch or gate late deliver/onError callbacks from a "woken up" old
  // dispatch. Those are second-order consistency concerns, not the reported
  // symptom (silent permanent stuck). If a hung dispatch resumes after our
  // timeout, the worst outcome is a delayed real reply arriving after the
  // "处理超时" apology — annoying, not broken. Adding cancel/gate semantics
  // is tracked separately and intentionally kept out of this issue.
  //
  // timeoutError: a per-invocation Error so the outer catch identifies "this
  // is OUR timeout" by reference equality, never by string comparison —
  // protects against a same-text upstream error being misclassified.
  let dispatchTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const dispatchTimeoutMs = resolveDispatchTimeoutMs(config, account);
  const timeoutError = new Error(
    `octo: dispatch timed out after ${dispatchTimeoutMs}ms`,
  );
  const dispatchTimeoutPromise = new Promise<never>((_, reject) => {
    dispatchTimeoutHandle = setTimeout(() => {
      reject(timeoutError);
    }, dispatchTimeoutMs);
  });

  try {
    await Promise.race([
      core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: config,
      replyOptions: {},
      // onFreshSettledDelivery is only present on newer SDK dispatcher options.
      // On older SDK the property is ignored (and never invoked, since
      // pendingToolWarningFinal is only set when the tool-warning classifier
      // exists), so the cast keeps both versions type-correct.
      dispatcherOptions: ({
        deliver: async (payload: ReplyPayload, info: { kind: ReplyDispatchKind }) => {
          // Skip reasoning blocks
          if (payload.isReasoning) return;

          const kind = info.kind;

          // --- Media: send immediately (no edit/forward issue) with dedup ---
          const outboundMediaUrls = resolveOutboundMediaUrls(payload);
          for (const mediaUrl of outboundMediaUrls) {
            if (sentMediaUrls.has(mediaUrl)) continue;
            try {
              const mediaResult = await uploadAndSendMedia({
                mediaUrl,
                apiUrl: account.config.apiUrl,
                botToken: account.config.botToken ?? "",
                channelId: replyChannelId,
                channelType: replyChannelType,
                ...(effectiveOnBehalfOf ? { onBehalfOf: effectiveOnBehalfOf } : {}),
                log,
              });
              sentMediaUrls.add(mediaUrl);
            } catch (err) {
              log?.error?.(`octo: media send failed for ${mediaUrl}: ${String(err)}`);
            }
          }

          // --- Text handling based on kind ---
          const content = payload.text?.trim() ?? "";
          if (!content && sentMediaUrls.size > 0) {
            statusSink?.({ lastOutboundAt: Date.now(), lastError: null });
            replySucceeded = true;
            return;
          }
          if (!content) return;

          if (kind === "tool") {
            // Verbose tool call output: send immediately
            await resolveAndSendText(content, AbortSignal.timeout(DISPATCH_TIMEOUT_APOLOGY_MS));
            replySucceeded = true;
            log?.info?.(`octo: [deliver] tool text sent (${content.length} chars)`);
            return;
          }

          if (kind === "final") {
            if (isFallbackOnlyToolWarningFinal(payload)) {
              if (!userFacingFinalDelivered) {
                pendingToolWarningFinal = { text: content };
              }
              log?.debug?.(
                `octo: [deliver-buffer] tool warning final deferred (${content.length} chars)`,
              );
              return;
            }

            await resolveAndSendText(content, AbortSignal.timeout(DISPATCH_TIMEOUT_APOLOGY_MS));
            replySucceeded = true;
            userFacingFinalDelivered = true;
            pendingToolWarningFinal = undefined;
            deliverBuffer.lastText = null;
            deliverBuffer.textSent = true;
            log?.info?.(`octo: [deliver] final text sent immediately (${content.length} chars)`);
            return;
          }

          // kind === "block" / anything else: buffer, send only once after dispatcher finishes
          deliverBuffer.lastText = content;
          log?.debug?.(`octo: [deliver-buffer] ${kind} text buffered (${content.length} chars)`);
        },
        onError: async (err: unknown, info: { kind: string }) => {
          clearInterval(typingInterval);
          log?.error?.(`octo ${info.kind} reply failed: ${String(err)}`);
          // Prevent finally block from sending stale buffered text after error
          deliverBuffer.lastText = null;
          deliverBuffer.textSent = true;
          deliveryErrorOccurred = true;
          try {
            await sendMessage({
              apiUrl,
              botToken,
              channelId: replyChannelId,
              channelType: replyChannelType,
              content: "⚠️ 抱歉，处理您的消息时遇到了问题，请稍后重试。",
              ...(effectiveOnBehalfOf ? { onBehalfOf: effectiveOnBehalfOf } : {}),
              // Same bounded signal as the timeout-path apology: if upstream
              // signals an error AND the Octo API is also sick, this recovery
              // sendMessage would otherwise hold the per-group queue until
              // the outer dispatch timeout kicks in. PR #83 review.
              signal: AbortSignal.timeout(DISPATCH_TIMEOUT_APOLOGY_MS),
            });
          } catch (sendErr) {
            log?.error?.(`octo: failed to send error message: ${String(sendErr)}`);
          }
        },
        onFreshSettledDelivery: async () => {
          if (!pendingToolWarningFinal || userFacingFinalDelivered || deliveryErrorOccurred) {
            return undefined;
          }
          // Buffered block text is the real user-facing reply; let the finally
          // flush deliver it and drop the warning fallback (single message).
          if (deliverBuffer.lastText && !deliverBuffer.textSent) {
            pendingToolWarningFinal = undefined;
            return undefined;
          }
          const pending = pendingToolWarningFinal;
          pendingToolWarningFinal = undefined;
          try {
            await resolveAndSendText(pending.text, AbortSignal.timeout(DISPATCH_TIMEOUT_APOLOGY_MS));
            replySucceeded = true;
            log?.info?.(
              `octo: [deliver] pending tool warning sent as fallback (${pending.text.length} chars)`,
            );
            return { visibleReplySent: true };
          } catch (err) {
            log?.error?.(
              `octo: [deliver] tool warning fallback send failed: ${String(err)}`,
            );
            return { visibleReplySent: false };
          }
        },
      } as ReplyDispatcherWithTypingOptions & {
        onFreshSettledDelivery?: () => Promise<{ visibleReplySent: boolean } | undefined>;
      }),
      }),
      dispatchTimeoutPromise,
    ]);
  } catch (err) {
    // Timeout: dispatch never returned within dispatchTimeoutMs. Tell the
    // user, suppress any stale buffered text (so the finally-flush branch
    // does not double-send), then rethrow so the per-group queue's outer
    // .catch() (channel.ts#enqueueInbound) can advance to the next message
    // — otherwise this group stays stuck forever, see issue #75.
    //
    // We do NOT gate late deliver/onError callbacks from the still-running
    // upstream dispatch — that "ghost reply" suppression is intentionally
    // out of scope for #75 (see scope-note comment above timeoutError).
    if (err === timeoutError) {
      clearInterval(typingInterval);
      log?.warn?.(
        `octo: dispatch hung past ${dispatchTimeoutMs}ms, aborting to unblock per-group queue (session=${route?.sessionKey ?? "?"})`,
      );
      deliverBuffer.lastText = null;
      deliverBuffer.textSent = true;
      try {
        // The apology call itself MUST be bounded — otherwise a sick Octo API
        // hangs this sendMessage too, defeating the whole timeout fix. See
        // DISPATCH_TIMEOUT_APOLOGY_MS above.
        await sendMessage({
          apiUrl,
          botToken,
          channelId: replyChannelId,
          channelType: replyChannelType,
          content: "⚠️ 处理超时，请稍后重试。",
          ...(effectiveOnBehalfOf ? { onBehalfOf: effectiveOnBehalfOf } : {}),
          signal: AbortSignal.timeout(DISPATCH_TIMEOUT_APOLOGY_MS),
        });
      } catch (sendErr) {
        log?.error?.(`octo: failed to send timeout message: ${String(sendErr)}`);
      }
    }
    throw err;
  } finally {
    if (dispatchTimeoutHandle) clearTimeout(dispatchTimeoutHandle);
    // --- Debug: log dispatch outcome ---
    log?.debug?.(`octo: [dispatch-result] replySucceeded=${replySucceeded} bufferedText=${deliverBuffer.lastText?.length ?? 0} textSent=${deliverBuffer.textSent} userFacingFinalDelivered=${userFacingFinalDelivered} effectiveOBO=${effectiveOnBehalfOf ?? 'none'}`);

    // --- Final send: deliver buffered text if only blocks arrived (no final/tool) ---
    if (deliverBuffer.lastText && !deliverBuffer.textSent) {
      deliverBuffer.textSent = true;
      try {
        // Bounded signal so a sick Octo API can't strand the per-group queue
        // on the happy path either — dispatch may have completed normally
        // but if the final POST hangs, handleInboundMessage would never
        // settle. See DISPATCH_TIMEOUT_APOLOGY_MS comment at top of file.
        await resolveAndSendText(
          deliverBuffer.lastText,
          AbortSignal.timeout(DISPATCH_TIMEOUT_APOLOGY_MS),
        );
        replySucceeded = true;
        log?.info?.(`octo: [deliver-buffer] fallback text sent (${deliverBuffer.lastText.length} chars)`);
      } catch (finalSendErr) {
        log?.error?.(`octo: [deliver-buffer] final text send failed: ${String(finalSendErr)}`);
      }
    }
    clearInterval(typingInterval);
    // Safety net: clean up pending inbound context in case the hook didn't fire
    pendingInboundContext.delete(route.sessionKey);

    // Record last answered inbound message_seq for history segmentation (don't clear history).
    // We use the inbound @mention message's message_seq (from WebSocket frame) rather than
    // sendMessage's returned message_seq, because the API always returns message_seq=0.
    if (isGroup && replySucceeded) {
      const seq = message.message_seq;
      if (typeof seq === "number" && seq > 0) {
        const existing = lastBotReplySeqMap.get(sessionId) ?? 0;
        if (seq > existing) {
          lastBotReplySeqMap.set(sessionId, seq);
          log?.info?.(`octo: [HISTORY] Bot reply done, recorded lastAnsweredSeq=${seq} | session=${sessionId}`);
        }
      }
    }
  }
}
