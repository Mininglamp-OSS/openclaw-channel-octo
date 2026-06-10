import type {
  ChannelPlugin,
  OpenClawConfig,
  ChannelMessageActionAdapter,
} from "openclaw/plugin-sdk";
import type { ChannelOutboundContext } from "openclaw/plugin-sdk/channel-contract";
import { DEFAULT_ACCOUNT_ID } from "./sdk-compat.js";
import { OctoConfigJsonSchema } from "./config-schema.js";
import { CHANNEL_ID, stripChannelPrefix } from "./constants.js";
import {
  listOctoAccountIds,
  resolveDefaultOctoAccountId,
  resolveOctoAccount,
  type ResolvedOctoAccount,
} from "./accounts.js";
import { registerBot, sendMessage, sendHeartbeat, sendMediaMessage, inferContentType, ensureTextCharset, fetchBotGroups, getGroupMd, parseImageDimensions, parseImageDimensionsFromFile, getUploadCredentials, uploadFileToCOS } from "./api-fetch.js";
import { PLUGIN_VERSION } from "./version.js";
import { getOctoRuntime } from "./runtime.js";

/** Get OpenClaw host version from PluginRuntime.version (provided by SDK). */
function getAgentVersion(): string {
  try {
    return getOctoRuntime().version ?? "";
  } catch {
    return "";
  }
}
import { WKSocket } from "./socket.js";
import { handleInboundMessage, type OctoStatusSink, sanitizeFilename } from "./inbound.js";
import { ChannelType, MessageType, type BotMessage, type MessagePayload, type SendMessageResult } from "./types.js";
import { buildEntitiesFromFallback, parseStructuredMentions, convertStructuredMentions, sanitizeOutboundMentions, MENTION_FORMAT_HINT } from "./mention-utils.js";
import type { MentionEntity } from "./types.js";
import { handleOctoMessageAction, parseTarget, resolveOutboundOctoTarget, normalizeOutboundChannelPrefix, extractInlineMentionUids } from "./actions.js";
import { getOrCreateGroupMdCache, registerBotGroupIds, getKnownGroupIds, writeGroupMdToDisk, extractParentGroupNo } from "./group-md.js";
import { registerOwnerUid } from "./owner-registry.js";
import { registerKnownBot, isKnownBot } from "./bot-registry.js";
import { preloadGroupMemberCache, getGroupMembersFromCache } from "./member-cache.js";
import { preloadMentionPrefs } from "./mention-prefs.js";
import { initPersonaPromptCache, stopPersonaPromptCache } from "./persona-prompt.js";
import { registerOctoThreadBindingAdapter } from "./thread-binding-adapter.js";
import { normalizeAccountId } from "./account-id.js";
import path from "node:path";
import os from "node:os";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
// HistoryEntry type - compatible with any version
type HistoryEntry = { sender: string; body: string; timestamp: number };
const DEFAULT_GROUP_HISTORY_LIMIT = 20;

const MAX_UPLOAD_SIZE = 500 * 1024 * 1024; // 500 MB
const UPLOAD_TEMP_DIR = path.join("/tmp", "octo-upload");

/**
 * Build OutboundDeliveryResult from Octo's SendMessageResult.
 *
 * Fail-fast on missing/empty message_id: when the Octo API returned 2xx but
 * the body is missing `message_id`, that is an API anomaly — surfacing it as
 * an error is better than silently returning `messageId: ""`, which OpenClaw
 * 2026.5.7+ treats as `deliverySucceeded=false` and quietly drops downstream
 * (see issue #51).
 *
 * For early-return noop paths (empty content, no actual API call), do NOT
 * use this helper — return `{ channel, to, messageId: "" }` directly with an
 * inline comment.
 */
function toDeliveryResult(to: string, result: SendMessageResult | undefined) {
  const messageId = result?.message_id ? String(result.message_id).trim() : "";
  if (!messageId) {
    throw new Error("Octo send API returned no message_id");
  }
  return { channel: CHANNEL_ID, to, messageId };
}

/** Download a URL to a temp file with backpressure, return the temp path. */
async function downloadToTempFile(url: string, filename: string, signal?: AbortSignal): Promise<{ tempPath: string; contentType: string | undefined }> {
  await mkdir(UPLOAD_TEMP_DIR, { recursive: true });
  // sanitizeFilename: defense in depth — strips path separators / rejects
  // traversal segments. Shared with inbound.ts (single source of truth).
  const safeName = sanitizeFilename(filename);
  const tempPath = path.join(UPLOAD_TEMP_DIR, `${randomUUID()}-${safeName}`);

  // HEAD to check size first
  const head = await fetch(url, { method: "HEAD", signal: signal ?? AbortSignal.timeout(30_000) });
  const contentLength = Number(head.headers.get("content-length") || 0);
  if (contentLength > MAX_UPLOAD_SIZE) {
    throw new Error(`File too large (${contentLength} bytes, max ${MAX_UPLOAD_SIZE})`);
  }

  const resp = await fetch(url, { signal: signal ?? AbortSignal.timeout(300_000) });
  if (!resp.ok) throw new Error(`Failed to download media from ${url}: ${resp.status}`);
  const contentType = resp.headers.get("content-type") ?? undefined;

  const body = resp.body;
  if (!body) throw new Error(`No response body from ${url}`);
  const nodeStream = Readable.fromWeb(body as any);
  const ws = createWriteStream(tempPath);
  try {
    await pipeline(nodeStream, ws);
  } catch (err) {
    // Cleanup partial temp file on download failure
    await unlink(tempPath).catch(() => {});
    throw err;
  }
  return { tempPath, contentType };
}

/** Cleanup old temp upload files (>1h). Called opportunistically. */
async function cleanupOldUploadTempFiles(): Promise<void> {
  try {
    const { readdir, stat, unlink: rm } = await import("node:fs/promises");
    const files = await readdir(UPLOAD_TEMP_DIR);
    const now = Date.now();
    for (const f of files) {
      const fp = path.join(UPLOAD_TEMP_DIR, f);
      const st = await stat(fp).catch(() => null);
      if (st && now - st.mtimeMs > 3600_000) await rm(fp).catch(() => {});
    }
  } catch { /* dir may not exist */ }
}

// Module-level history storage — survives auto-restarts.
// All accountId-keyed in-memory state below normalizes accountId at the
// helper boundary (see ./account-id.ts), so mixed-case BotFather IDs
// (issue #33) cannot split a single bot's cache across two map slots.
const _historyMaps = new Map<string, Map<string, any[]>>();
function getOrCreateHistoryMap(accountId: string): Map<string, any[]> {
  const id = normalizeAccountId(accountId);
  let m = _historyMaps.get(id);
  if (!m) {
    m = new Map<string, any[]>();
    _historyMaps.set(id, m);
  }
  return m;
}

// Track last answered inbound message_seq per session for history segmentation.
// Stores the message_seq of the @mention message that triggered the bot's last reply,
// NOT the bot's own reply message_seq (sendMessage API returns 0 for that).
const _lastBotReplySeq = new Map<string, Map<string, number>>();
function getOrCreateLastBotReplySeqMap(accountId: string): Map<string, number> {
  const id = normalizeAccountId(accountId);
  let m = _lastBotReplySeq.get(id);
  if (!m) {
    m = new Map<string, number>();
    _lastBotReplySeq.set(id, m);
  }
  return m;
}

const _inboundQueues = new Map<string, Promise<void>>();

function getInboundQueueKey(accountId: string, msg: BotMessage): string {
  const id = normalizeAccountId(accountId);
  const isGroup =
    typeof msg.channel_id === "string" &&
    msg.channel_id.length > 0 &&
    (msg.channel_type === ChannelType.Group ||
     msg.channel_type === ChannelType.CommunityTopic);

  if (isGroup) {
    return `${id}:group:${msg.channel_id}`;
  }

  let spaceId = "";
  const effectiveChannelId = msg.from_uid;

  // DM channel_id format: "s{spaceId}_{peerId}" or "s{spaceId}_{peerId}@{suffix}"
  if (msg.channel_id?.startsWith("s")) {
    const atIdx = msg.channel_id.indexOf("@");
    const firstPart = atIdx > 0
      ? msg.channel_id.substring(0, atIdx)
      : msg.channel_id;
    const lastUnderscore = firstPart.lastIndexOf("_");
    if (lastUnderscore > 0) {
      spaceId = firstPart.substring(1, lastUnderscore);
    }
  }

  const sessionId = spaceId
    ? `${spaceId}:${effectiveChannelId}`
    : effectiveChannelId;
  return `${id}:dm:${sessionId}`;
}

function enqueueInbound(
  key: string,
  task: () => Promise<void>,
  log?: { error?: (msg: string) => void },
): void {
  const previous = _inboundQueues.get(key) ?? Promise.resolve();

  const next = previous
    .catch(() => undefined)
    .then(task)
    .catch((err) => {
      log?.error?.(
        `octo: inbound handler failed: ${
          err instanceof Error ? err.stack ?? String(err) : String(err)
        }`,
      );
    })
    .finally(() => {
      if (_inboundQueues.get(key) === next) {
        _inboundQueues.delete(key);
      }
    });

  _inboundQueues.set(key, next);
}

// Module-level member mapping: displayName -> uid
// Used to resolve @mentions in AI replies
const _memberMaps = new Map<string, Map<string, string>>();
export function getOrCreateMemberMap(accountId: string): Map<string, string> {
  const id = normalizeAccountId(accountId);
  let m = _memberMaps.get(id);
  if (!m) {
    m = new Map<string, string>();
    _memberMaps.set(id, m);
  }
  return m;
}

// Module-level reverse mapping: uid -> displayName
// Used to show display names instead of uids in replies
const _uidToNameMaps = new Map<string, Map<string, string>>();
export function getOrCreateUidToNameMap(accountId: string): Map<string, string> {
  const id = normalizeAccountId(accountId);
  let m = _uidToNameMaps.get(id);
  if (!m) {
    m = new Map<string, string>();
    _uidToNameMaps.set(id, m);
  }
  return m;
}

// Group member cache timestamps: groupId -> lastFetchedAt (ms)
const _groupCacheTimestamps = new Map<string, Map<string, number>>();
function getOrCreateGroupCacheTimestamps(accountId: string): Map<string, number> {
  const id = normalizeAccountId(accountId);
  let m = _groupCacheTimestamps.get(id);
  if (!m) {
    m = new Map<string, number>();
    _groupCacheTimestamps.set(id, m);
  }
  return m;
}

/**
 * Outbound @mention prefetch (P0-1).
 *
 * Proactive sends (cron, new sub-topic, agent-initiated @) never go through the
 * inbound member-cache refresh, so the per-account memberMap/uidToNameMap can be
 * empty or stale at send time. Before converting, if the text contains an `@`,
 * pull the target group's members from the shared 5-min-TTL cache and fill both
 * maps. Cache hit = zero cost; on a cold start (cache miss) this performs one
 * synchronous member-list API round-trip on the send path. Threads only know the
 * parent group_no for the member API, so strip the `____` sub-topic suffix.
 * Best-effort: any failure degrades silently (the outbound sanitizer is the real
 * safety net).
 */
async function prefetchOutboundMembers(opts: {
  content: string;
  channelId: string;
  apiUrl: string;
  botToken: string;
  memberMap: Map<string, string>;
  uidToNameMap: Map<string, string>;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<void> {
  if (!opts.content.includes("@")) return;
  try {
    const groupNo = extractParentGroupNo(opts.channelId);
    if (!groupNo) return;
    const members = await getGroupMembersFromCache({
      apiUrl: opts.apiUrl,
      botToken: opts.botToken,
      groupNo,
      log: opts.log,
    });
    for (const m of members) {
      if (m.name && m.uid) {
        opts.memberMap.set(m.name, m.uid);
        opts.uidToNameMap.set(m.uid, m.name);
      }
    }
  } catch (err) {
    opts.log?.error?.(`octo: prefetchOutboundMembers failed: ${err}`);
  }
}

// Module-level robot flags: uid -> robot (server-authoritative GroupMember.robot)
// Consulted by the 免@ mention gate to keep requireMention for ANY bot sender,
// including cross-process / external bots not registered via registerKnownBot().
// Flat uid→robot map (not keyed by groupId), like uidToNameMap.
const _memberRobotMaps = new Map<string, Map<string, boolean>>();
function getOrCreateMemberRobotMap(accountId: string): Map<string, boolean> {
  const id = normalizeAccountId(accountId);
  let m = _memberRobotMaps.get(id);
  if (!m) {
    m = new Map<string, boolean>();
    _memberRobotMaps.set(id, m);
  }
  return m;
}


// --- Group → Account mapping: tracks which accounts are active in each group ---
// Used by handleAction to resolve the correct account when framework passes wrong accountId
// A group may have multiple bots (1:N), so we store a Set of accountIds per group.
//
// Both the registration side AND the query side normalize accountId — Set
// membership checks are case-sensitive, so storing the raw mixed-case form
// would make later lowercase queries miss (and vice versa). See issue #33.
const _groupToAccounts = new Map<string, Set<string>>(); // groupNo → Set of <normalized accountIds>

export function registerGroupToAccount(groupNo: string, accountId: string): void {
  const id = normalizeAccountId(accountId);
  let s = _groupToAccounts.get(groupNo);
  if (!s) { s = new Set(); _groupToAccounts.set(groupNo, s); }
  s.add(id);
}

/**
 * Resolve the correct accountId for a group.
 * - If the group has exactly one registered account → return it (safe to correct).
 * - If the group has multiple accounts (shared group) → return undefined (don't override).
 * - If the group is unknown → return undefined.
 *
 * Returned id is always normalized (registration side normalizes).
 */
export function resolveAccountForGroup(groupNo: string): string | undefined {
  const s = _groupToAccounts.get(groupNo);
  if (!s || s.size !== 1) return undefined;
  return s.values().next().value;
}

/** Check if a specific accountId is registered for a group. */
export function isAccountRegisteredForGroup(groupNo: string, accountId: string): boolean {
  return _groupToAccounts.get(groupNo)?.has(normalizeAccountId(accountId)) ?? false;
}

// --- Cache cleanup: evict groups inactive for >4 hours ---
const CACHE_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const CACHE_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const _cacheActivity = new Map<string, Map<string, number>>();

function touchCache(accountId: string, groupId: string): void {
  const id = normalizeAccountId(accountId);
  let m = _cacheActivity.get(id);
  if (!m) { m = new Map(); _cacheActivity.set(id, m); }
  m.set(groupId, Date.now());
}

function cleanupStaleCaches(): void {
  const cutoff = Date.now() - CACHE_MAX_AGE_MS;
  for (const [accountId, activityMap] of _cacheActivity) {
    for (const [groupId, lastAccess] of activityMap) {
      if (lastAccess < cutoff) {
        _historyMaps.get(accountId)?.delete(groupId);
        _lastBotReplySeq.get(accountId)?.delete(groupId);
        _memberMaps.get(accountId)?.delete(groupId);
        // Note: uidToNameMap is a flat uid→name map (not keyed by groupId),
        // so we don't delete from it here — names remain valid across groups.
        _groupCacheTimestamps.get(accountId)?.delete(groupId);
        activityMap.delete(groupId);
      }
    }
    if (activityMap.size === 0) _cacheActivity.delete(accountId);
  }
}

// Known bot robot_ids across all accounts — for bot-to-bot loop prevention.
// Backed by the shared bot-registry so inbound.ts can consult the same set
// without importing channel.ts (channel.ts → inbound.ts is one-way; importing
// back would create a cycle). The thin wrapper keeps existing call sites
// (_knownBotUids.add / .has) unchanged.
const _knownBotUids = {
  add: (uid: string) => registerKnownBot(uid),
  has: (uid: string) => isKnownBot(uid),
};

// Singleton timer to prevent accumulation during hot reload (#54)
let _cleanupTimer: NodeJS.Timeout | null = null;

function ensureCleanupTimer(): void {
  if (_cleanupTimer) return; // Already running
  _cleanupTimer = setInterval(cleanupStaleCaches, CACHE_CLEANUP_INTERVAL_MS);
  if (typeof _cleanupTimer === "object" && _cleanupTimer && "unref" in _cleanupTimer) {
    _cleanupTimer.unref();
  }
}

/** Resolve correct accountId for outbound context using group→account mapping */
export function resolveOutboundAccountId(ctxTo: string, fallbackAccountId: string): string {
  // Same prefix / inline-mention-UID normalisation as the outbound send path —
  // otherwise `channel:<id>` never makes it past parseTarget (which doesn't
  // recognise that prefix) and the group→account lookup silently falls back,
  // routing the turn through the wrong bot's token.
  let targetForParse = normalizeOutboundChannelPrefix(ctxTo);
  if (targetForParse.startsWith("group:")) {
    const groupPart = targetForParse.slice(6);
    const atIdx = groupPart.indexOf("@");
    if (atIdx >= 0) targetForParse = "group:" + groupPart.slice(0, atIdx);
  }
  const { channelId, channelType } = parseTarget(targetForParse, undefined, getKnownGroupIds());
  if (channelType === ChannelType.Group || channelType === ChannelType.CommunityTopic) {
    const groupId = channelType === ChannelType.CommunityTopic ? channelId.split("____")[0] : channelId;
    const correctAccountId = resolveAccountForGroup(groupId);
    if (correctAccountId) return correctAccountId;
  }
  return fallbackAccountId;
}

/** Shared check: return available actions if at least one account is configured, else empty. */
function getAvailableActions(cfg: any): string[] {
  try {
    const ids = listOctoAccountIds(cfg);
    const hasConfigured = ids.some((id) => {
      const acct = resolveOctoAccount({ cfg, accountId: id });
      return acct.enabled && acct.configured && !!acct.config.botToken;
    });
    if (!hasConfigured) return [];
  } catch {
    return [];
  }
  return ["send", "read", "search"];
}

const meta = {
  id: "octo",
  label: "Octo",
  selectionLabel: "Octo",
  detailLabel: "Octo Bot",
  docsPath: "/channels/octo",
  docsLabel: "octo",
  blurb: "Connect OpenClaw to Octo",
  markdownCapable: false,
  order: 90,
};

// ---------------------------------------------------------------------------
// setupWizard + setup adapter — power `openclaw channels add --channel octo`.
//
// Without these, OpenClaw reports "octo does not have an interactive setup
// screen yet" for the wizard path, and "Channel does not support
// non-interactive add" for the --bot-token/--http-url CLI flag path.
//
// We follow feishu's "credentials: [] + collect everything in finalize"
// pattern — simpler than writing per-credential descriptors with inspect/
// applySet hooks, and lets us match the OpenClaw `channels add --channel octo` UX.
// ---------------------------------------------------------------------------

const ACCOUNT_ID_RE = /^[A-Za-z0-9_]+$/;

function setOctoAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
  botToken: string,
  apiUrl: string,
): OpenClawConfig {
  const channels = ((cfg as any).channels ?? {}) as Record<string, any>;
  const channel = (channels[CHANNEL_ID] ?? {}) as Record<string, any>;
  const accounts = (channel.accounts ?? {}) as Record<string, any>;
  return {
    ...cfg,
    channels: {
      ...channels,
      [CHANNEL_ID]: {
        ...channel,
        enabled: true,
        accounts: {
          ...accounts,
          [accountId]: {
            ...(accounts[accountId] ?? {}),
            enabled: true,
            botToken,
            apiUrl,
          },
        },
      },
    },
  } as OpenClawConfig;
}

const octoSetupWizard = {
  channel: CHANNEL_ID,
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs bot token",
    configuredHint: "configured",
    unconfiguredHint: "needs bot token",
    configuredScore: 2,
    unconfiguredScore: 0,
    resolveConfigured: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string }) => {
      const account = resolveOctoAccount({ cfg, accountId: accountId ?? DEFAULT_ACCOUNT_ID });
      return account.configured;
    },
    resolveStatusLines: async ({ cfg, accountId, configured }: { cfg: OpenClawConfig; accountId?: string; configured: boolean }) => {
      if (!configured) return ["Octo: needs bot token (bf_*)"];
      const account = resolveOctoAccount({ cfg, accountId: accountId ?? DEFAULT_ACCOUNT_ID });
      return [`Octo: configured (api: ${account.config.apiUrl})`];
    },
  },
  resolveAccountIdForConfigure: ({ accountOverride, defaultAccountId, cfg }: any) => {
    const resolved = (typeof accountOverride === "string" && accountOverride.trim() ? accountOverride.trim() : undefined)
      ?? resolveDefaultOctoAccountId(cfg)
      ?? defaultAccountId
      ?? DEFAULT_ACCOUNT_ID;
    // Same validation as the non-interactive setupAdapter: bail before
    // finalize writes an unreachable cfg.channels.octo.accounts[<bad-id>]
    // key that `openclaw channels remove` cannot later target.
    if (!ACCOUNT_ID_RE.test(resolved)) {
      throw new Error(`Invalid account ID "${resolved}". Only letters, digits, and underscores allowed.`);
    }
    return resolved;
  },
  resolveShouldPromptAccountIds: () => false,
  credentials: [] as any[],
  finalize: async ({ cfg, accountId, prompter }: any) => {
    const existing = resolveOctoAccount({ cfg, accountId });

    const botToken = await prompter.text({
      message: "Bot token (bf_*)",
      placeholder: "bf_...",
      initialValue: existing.config.botToken ?? "",
      sensitive: true,
      validate: (v: string) => {
        if (!v || !v.trim()) return "Bot token is required.";
        if (!v.startsWith("bf_") || v.length <= 13) {
          return "Bot token must start with 'bf_'. Create one via /newbot in Octo BotFather.";
        }
        return undefined;
      },
    });

    const apiUrl = await prompter.text({
      message: "API URL",
      placeholder: "http://localhost:8090/api",
      initialValue: existing.config.apiUrl,
      validate: (v: string) => {
        if (!v || !v.trim()) return "API URL is required.";
        try { new URL(v); } catch { return "Must be a valid URL (e.g. https://your-server/api)."; }
        return undefined;
      },
    });

    return { cfg: setOctoAccountConfig(cfg, accountId, botToken.trim(), apiUrl.trim()) };
  },
};

const octoSetupAdapter = {
  resolveAccountId: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string }) =>
    (accountId && accountId.trim()) || resolveDefaultOctoAccountId(cfg) || DEFAULT_ACCOUNT_ID,
  validateInput: ({ accountId, input }: { accountId: string; input: any }) => {
    if (!ACCOUNT_ID_RE.test(accountId)) {
      return `Invalid account ID "${accountId}". Only letters, digits, and underscores allowed.`;
    }
    const botToken = input.botToken ?? input.token;
    if (botToken !== undefined) {
      if (typeof botToken !== "string" || !botToken.trim() || !botToken.startsWith("bf_") || botToken.length <= 13) {
        return "Bot token must start with 'bf_' and be longer than 13 chars.";
      }
    }
    const apiUrl = input.baseUrl ?? input.url ?? input.httpUrl;
    if (apiUrl !== undefined) {
      if (typeof apiUrl !== "string" || !apiUrl.trim()) {
        return "API URL must be a non-empty string.";
      }
      try { new URL(apiUrl); } catch { return "API URL must be a valid URL."; }
    }
    return undefined;
  },
  applyAccountConfig: ({ cfg, accountId, input }: { cfg: OpenClawConfig; accountId: string; input: any }) => {
    const existing = resolveOctoAccount({ cfg, accountId });
    const botToken = (input.botToken ?? input.token ?? existing.config.botToken ?? "").trim();
    // existing.config.apiUrl always populated by resolveOctoAccount (falls back
    // to DEFAULT_API_URL = "http://localhost:8090/api"), so the trailing ??
    // never fires in practice but is kept as a belt-and-suspenders default.
    const apiUrl = (input.baseUrl ?? input.url ?? input.httpUrl ?? existing.config.apiUrl).trim();
    if (!botToken) throw new Error("Bot token is required. Pass --bot-token bf_xxx or --token bf_xxx.");
    return setOctoAccountConfig(cfg, accountId, botToken, apiUrl);
  },
};

export const octoPlugin: ChannelPlugin<ResolvedOctoAccount> = {
  id: "octo",
  meta,
  setupWizard: octoSetupWizard as any,
  setup: octoSetupAdapter as any,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: true,
  },
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  // Declare ACP thread-binding support so OpenClaw's session-binding service
  // recognizes Octo as a thread-binding-capable channel. Without this block,
  // `getCapabilities({channel:"octo",...})` returns
  // `{ adapterAvailable: false, bindSupported: false }` and ACP spawns abort
  // with `errorCode: "thread_binding_invalid"` (#23).
  //
  // - `supportsCurrentConversationBinding: true` is the minimum for OpenClaw's
  //   generic current-placement bind path to accept Octo.
  // - `createManager` is the runtime entry point: OpenClaw calls it on demand
  //   per (cfg, accountId) and we install a SessionBindingAdapter that adds
  //   "child" placement support (creates a new Octo sub-thread on bind).
  // - `resolveConversationRef` normalizes octo's `groupNo____shortId` thread
  //   format so callers passing a parent + threadId get the correct merged ref.
  // - `buildBoundReplyPayload` returns null because Octo doesn't have a
  //   per-thread pin/notify equivalent of Telegram's topic pin payload.
  conversationBindings: {
    supportsCurrentConversationBinding: true,
    defaultTopLevelPlacement: "current",
    resolveConversationRef: ({ conversationId, parentConversationId, threadId }: {
      accountId?: string | null;
      conversationId: string;
      parentConversationId?: string;
      threadId?: string | number | null;
    }) => {
      // Already a thread ref like "groupNo____shortId": split into parent+child.
      if (conversationId.includes("____")) {
        const parent = conversationId.split("____")[0]!;
        return { conversationId, parentConversationId: parent };
      }
      // Caller passed a parent group + an explicit threadId: synthesize the
      // composite conversationId in Octo's canonical format.
      const tid = threadId == null ? "" : String(threadId).trim();
      if (tid) {
        return {
          conversationId: `${conversationId}____${tid}`,
          parentConversationId: conversationId,
        };
      }
      return {
        conversationId,
        ...(parentConversationId ? { parentConversationId } : {}),
      };
    },
    buildBoundReplyPayload: () => null,
    createManager: ({ cfg, accountId }: { cfg: any; accountId?: string | null }) => {
      const resolvedId =
        (accountId && accountId.trim()) ||
        resolveDefaultOctoAccountId(cfg) ||
        DEFAULT_ACCOUNT_ID;
      const account = resolveOctoAccount({ cfg, accountId: resolvedId });
      if (!account.config.botToken) {
        // Account not yet configured (botToken missing). Return a no-op
        // manager so OpenClaw's lifecycle doesn't crash. NOTE: the runtime
        // tracks one manager per (plugin, account) and will NOT call
        // createManager again on subsequent binds for the same account, so
        // configuring the bot AFTER first bind requires a gateway restart
        // (or an in-process config reload hook) to install a working manager.
        return { stop: () => {} };
      }
      // The SDK's `createManager` signature does NOT include a log sink, so
      // we wire a minimal console-backed fallback. This surfaces
      // `createThread` failures in the `child`-placement path that would
      // otherwise be swallowed into a generic null binding result.
      const fallbackLog = {
        info: (msg: string) => console.log(`[octo:thread-binding] ${msg}`),
        warn: (msg: string) => console.warn(`[octo:thread-binding] ${msg}`),
        debug: (msg: string) => console.debug(`[octo:thread-binding] ${msg}`),
      };
      const unregister = registerOctoThreadBindingAdapter({
        accountId: resolvedId,
        apiUrl: account.config.apiUrl,
        botToken: account.config.botToken,
        log: fallbackLog,
      });
      return { stop: () => unregister() };
    },
  },
  actions: {
    listActions: ({ cfg }: { cfg: any }) => {
      const actions = getAvailableActions(cfg);
      return actions as any; // TODO: remove when SDK types support this
    },
    describeMessageTool: ({ cfg }: { cfg: any }) => {
      const actions = getAvailableActions(cfg);
      if (actions.length === 0) return null;
      return { actions, capabilities: [] };
    },
    extractToolSend: ({ args }: { args: Record<string, unknown> }) => {
      const target = args.target as string | undefined;
      return target ? { target } : {};
    },
    handleAction: async (ctx: any) => {
      // Resolve correct accountId: framework may pass wrong one when agent has multiple accounts.
      // Use currentChannelId to look up which account actually owns the group.
      // When multiple bots share the same group, do NOT correct — the caller's accountId is authoritative.
      let accountId = ctx.accountId ?? DEFAULT_ACCOUNT_ID;
      const currentChannelId = ctx.toolContext?.currentChannelId;
      if (currentChannelId) {
        const rawId = stripChannelPrefix(currentChannelId);
        // 子区 channelID (groupNo____shortId) → 提取父群 groupNo
        const rawGroupNo = rawId.includes("____") ? rawId.split("____")[0] : rawId;
        // Only correct if current accountId is NOT registered for this group
        // (i.e., framework passed a clearly wrong accountId).
        // For shared groups (multiple bots), don't override — respect framework's choice.
        if (!isAccountRegisteredForGroup(rawGroupNo, accountId)) {
          const correctAccountId = resolveAccountForGroup(rawGroupNo);
          if (correctAccountId) {
            ctx.log?.info?.(`octo: handleAction accountId corrected: ${accountId} → ${correctAccountId} (group=${rawGroupNo})`);
            accountId = correctAccountId;
          }
        }
      }
      const account = resolveOctoAccount({
        cfg: ctx.cfg,
        accountId,
      });
      if (!account.config.botToken) {
        return { ok: false, error: "Octo botToken is not configured" };
      }
      const memberMap = getOrCreateMemberMap(accountId);
      const uidToNameMap = getOrCreateUidToNameMap(accountId);
      const groupMdCache = getOrCreateGroupMdCache(accountId);
      return handleOctoMessageAction({
        action: ctx.action,
        args: ctx.params ?? {},
        apiUrl: account.config.apiUrl,
        botToken: account.config.botToken,
        memberMap,
        uidToNameMap,
        groupMdCache,
        currentChannelId: ctx.toolContext?.currentChannelId ?? undefined,
        threadId: ctx.toolContext?.threadId ?? ctx.params?.threadId ?? undefined,
        requesterSenderId: ctx.requesterSenderId ?? undefined,
        accountId,
        log: ctx.log,
      });
    },
  } as any, // TODO: remove when SDK types support this
  agentPrompt: {
    messageToolHints: ({ cfg, accountId }: { cfg: any; accountId?: string | null }) => {
      if (!accountId) return [];
      return [
        `IMPORTANT: Your Octo accountId is "${accountId}". You MUST always pass accountId: "${accountId}" when using the octo_management tool. Do NOT use any other accountId.`,
        `For sending messages: if the target is a group, use target="group:<groupId>". If the target is a specific user (1v1 direct message), use target="user:<userId>". If sending to the current conversation, no prefix is needed.`,
        `For threads/sub-topics: always prefer the explicit "group:<group_no>____<short_id>" (four underscores) form so the destination is unambiguous. If you accidentally pass the bare parent "group:<group_no>" from within a thread session and that parent matches your current thread's group, the plugin auto-reroutes the send to the current thread (with an info-level log; see issue #98). Outside a thread session, "group:<group_no>" continues to address the parent group. The same rules apply to file uploads.`,
        `For reading message history: use action="read" with target="user:<uid>" to read DM history, or target="group:<groupId>" to read group message history. Cross-channel queries require the requester to be a participant of the target channel.`,
        `For searching: use action="search" with query="shared-groups" to find groups that the bot and the current user both belong to.`,
        `For @mentions in a group: FIRST look up the target member's real uid + display name with octo_management action="group-members" (target="group:<groupId>"). ${MENTION_FORMAT_HINT}`,
      ];
    },
  },
  configSchema: OctoConfigJsonSchema,
  config: {
    listAccountIds: (cfg) => listOctoAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveOctoAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultOctoAccountId(cfg) ?? listOctoAccountIds(cfg)[0] ?? DEFAULT_ACCOUNT_ID,
    isEnabled: (account) => account.enabled,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      apiUrl: account.config.apiUrl,
      botToken: account.config.botToken ? "[set]" : "[missing]",
      wsUrl: account.config.wsUrl ?? "[auto-detect]",
    }),
  },
  messaging: {
    normalizeTarget: (target) => target.trim(),
    targetResolver: {
      looksLikeId: (input) => Boolean(input.trim()),
      hint: "<userId or channelId>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async (ctx) => {
      // Resolve correct accountId — framework may pass wrong one for multi-bot setups
      const accountId = resolveOutboundAccountId(
        ctx.to,
        ctx.accountId ?? DEFAULT_ACCOUNT_ID,
      );
      const account = resolveOctoAccount({
        cfg: ctx.cfg as OpenClawConfig,
        accountId,
      });
      if (!account.config.botToken) {
        throw new Error("Octo botToken is not configured");
      }
      const content = ctx.text?.trim();
      if (!content) {
        // noop early-return: no API call was made, so no real message_id
        // exists. Runtime will see messageId="" and judge
        // deliverySucceeded=false — that is the CORRECT semantics for
        // "we delivered nothing". Do NOT fabricate an ID here. See
        // toDeliveryResult() helper at the top of this file.
        return { channel: CHANNEL_ID, to: ctx.to, messageId: "" };
      }

      // Parse target — merge framework-provided threadId into CommunityTopic
      // channel_id when ctx.to is a bare group. Inline mention UIDs
      // (`(group|channel):<id>@uid1,uid2`) are pulled out here via the
      // shared extractor so both prefix forms propagate UIDs consistently.
      const mentionUids: string[] = extractInlineMentionUids(ctx.to);

      const { channelId, channelType } = resolveOutboundOctoTarget(ctx.to, ctx.threadId);

      let mentionEntities: MentionEntity[] = [];
      let finalContent = content;

      if (channelType === ChannelType.Group || channelType === ChannelType.CommunityTopic) {
        const accountMemberMap = getOrCreateMemberMap(accountId);
        const uidToNameMap = getOrCreateUidToNameMap(accountId);

        // P0-1: ensure member maps are populated for proactive sends (cron / new
        // sub-topic / agent-initiated @) where the inbound refresh never ran.
        await prefetchOutboundMembers({
          content: finalContent,
          channelId,
          apiUrl: account.config.apiUrl,
          botToken: account.config.botToken,
          memberMap: accountMemberMap,
          uidToNameMap,
        });

        // v2 path: convert @[uid:name] → @name + entities
        const structuredMentions = parseStructuredMentions(finalContent);
        if (structuredMentions.length > 0) {
          const converted = convertStructuredMentions(finalContent, structuredMentions);
          finalContent = converted.content;
          mentionEntities = [...converted.entities];
          for (const uid of converted.uids) {
            if (!mentionUids.includes(uid)) {
              mentionUids.push(uid);
            }
          }
        }

        // v1 fallback: resolve remaining @name via memberMap
        const { entities, uids } = buildEntitiesFromFallback(finalContent, accountMemberMap);
        const existingOffsets = new Set(mentionEntities.map(e => e.offset));
        for (const entity of entities) {
          if (!existingOffsets.has(entity.offset)) {
            mentionEntities.push(entity);
          }
        }
        for (const uid of uids) {
          if (!mentionUids.includes(uid)) {
            mentionUids.push(uid);
          }
        }

        // P0-3: last-line guard — rewrite/downgrade/strip any malformed @ the
        // conversion+fallback couldn't resolve, and drop illegal uids so a bad
        // mention is never leaked to the server.
        const sanitized = sanitizeOutboundMentions({
          content: finalContent,
          entities: mentionEntities,
          uids: mentionUids,
          uidToNameMap,
        });
        finalContent = sanitized.content;
        mentionEntities = sanitized.entities;
        mentionUids.length = 0;
        mentionUids.push(...sanitized.uids);
      }

      // Detect @all/@所有人 in content
      const hasAtAll = /(?:^|(?<=\s))@(?:all|所有人)(?=\s|[^\w]|$)/i.test(finalContent);

      const sendResult = await sendMessage({
        apiUrl: account.config.apiUrl,
        botToken: account.config.botToken,
        channelId,
        channelType,
        content: finalContent,
        ...(mentionUids.length > 0 ? { mentionUids } : {}),
        ...(mentionEntities.length > 0 ? { mentionEntities } : {}),
        mentionAll: hasAtAll || undefined,
      });

      return toDeliveryResult(ctx.to, sendResult);
    },
    sendMedia: async (ctx) => {
      // Resolve correct accountId — framework may pass wrong one for multi-bot setups
      const accountId = resolveOutboundAccountId(
        ctx.to,
        ctx.accountId ?? DEFAULT_ACCOUNT_ID,
      );
      const account = resolveOctoAccount({
        cfg: ctx.cfg as OpenClawConfig,
        accountId,
      });
      if (!account.config.botToken) {
        throw new Error("Octo botToken is not configured");
      }

      const mediaUrl = ctx.mediaUrl;
      if (!mediaUrl) {
        throw new Error("sendMedia called without mediaUrl");
      }

      // 1. Resolve file — stream-based for HTTP/file paths, Buffer for data URIs
      let fileBody: Buffer | NodeJS.ReadableStream;
      let fileSize: number;
      let contentType: string | undefined;
      let filename: string;
      let tempPath: string | undefined; // temp file we created (will be cleaned up)
      let localFilePath: string | undefined; // path for parseImageDimensionsFromFile

      // Opportunistic cleanup of stale temp files
      cleanupOldUploadTempFiles().catch(() => {});

      if (mediaUrl.startsWith("data:")) {
        // Parse data URI: data:[<mediatype>][;base64],<data>
        const match = mediaUrl.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/);
        if (!match) {
          throw new Error("Invalid data URI format");
        }
        contentType = match[1] || "application/octet-stream";
        const buf = Buffer.from(match[2], "base64");
        fileBody = buf;
        fileSize = buf.length;
        // Generate a reasonable filename from MIME type
        const extMap: Record<string, string> = {
          "text/markdown": ".md", "text/plain": ".txt", "application/pdf": ".pdf",
          "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
          "application/json": ".json", "application/zip": ".zip",
          "audio/mpeg": ".mp3", "video/mp4": ".mp4",
        };
        const ext = extMap[contentType] || ".bin";
        filename = `file${ext}`;
        // If OpenClaw provides a filename hint via ctx, prefer it
        if ((ctx as Record<string, unknown>).filename) {
          filename = String((ctx as Record<string, unknown>).filename);
        }
      } else if (mediaUrl.startsWith("file://")) {
        const filePath = decodeURIComponent(mediaUrl.slice(7));
        const st = statSync(filePath);
        if (st.size > MAX_UPLOAD_SIZE) {
          throw new Error(`File too large (${st.size} bytes, max ${MAX_UPLOAD_SIZE})`);
        }
        localFilePath = filePath;
        fileBody = createReadStream(filePath);
        fileSize = st.size;
        filename = path.basename(filePath);
        contentType = inferContentType(filename);
      } else {
        // HTTP(S) URL — stream download to temp file to avoid buffering in memory
        const urlPath = new URL(mediaUrl).pathname;
        const rawFilename = path.basename(urlPath) || "file";
        try {
          filename = decodeURIComponent(rawFilename);
        } catch {
          filename = rawFilename;
        }
        const dl = await downloadToTempFile(mediaUrl, filename);
        tempPath = dl.tempPath;
        localFilePath = dl.tempPath;
        contentType = dl.contentType;
        if (!contentType || contentType === "application/octet-stream") contentType = inferContentType(filename);
        const st = statSync(tempPath);
        fileBody = createReadStream(tempPath);
        fileSize = st.size;
      }

      contentType = contentType || "application/octet-stream";

      let sendResult: SendMessageResult | undefined;
      try {
        // 2. Upload to COS via STS credentials (stream mode)
        const creds = await getUploadCredentials({
          apiUrl: account.config.apiUrl,
          botToken: account.config.botToken,
          filename,
        });
        const { url: cdnUrl } = await uploadFileToCOS({
          credentials: creds.credentials,
          startTime: creds.startTime,
          expiredTime: creds.expiredTime,
          bucket: creds.bucket,
          region: creds.region,
          key: creds.key,
          fileBody,
          fileSize,
          contentType: ensureTextCharset(contentType),
          cdnBaseUrl: creds.cdnBaseUrl,
          filename,
        });

        // 3. Resolve target — merge framework-provided threadId into
        // CommunityTopic (channel_type=5) when ctx.to is a bare group.
        const { channelId, channelType } = resolveOutboundOctoTarget(ctx.to, ctx.threadId);

        // 4. Determine message type and send
        const msgType = contentType.startsWith("image/")
          ? MessageType.Image
          : MessageType.File;

        if (msgType === MessageType.Image) {
          // For images, parse dimensions from file or buffer
          const dims = localFilePath
            ? await parseImageDimensionsFromFile(localFilePath, contentType)
            : Buffer.isBuffer(fileBody)
              ? parseImageDimensions(fileBody, contentType)
              : null;
          sendResult = await sendMediaMessage({
            apiUrl: account.config.apiUrl,
            botToken: account.config.botToken,
            channelId,
            channelType,
            type: msgType,
            url: cdnUrl,
            width: dims?.width,
            height: dims?.height,
            name: filename,
            size: fileSize,
          });
        } else {
          sendResult = await sendMediaMessage({
            apiUrl: account.config.apiUrl,
            botToken: account.config.botToken,
            channelId,
            channelType,
            type: msgType,
            url: cdnUrl,
            name: filename,
            size: fileSize,
          });
        }
      } finally {
        // Cleanup temp file
        if (tempPath) await unlink(tempPath).catch(() => {});
      }

      return toDeliveryResult(ctx.to, sendResult);
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      apiUrl: account.config.apiUrl,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      // Ensure cleanup timer is running (singleton pattern for hot reload safety)
      ensureCleanupTimer();

      const account = ctx.account;
      if (!account.configured || !account.config.botToken) {
        throw new Error(
          `Octo not configured for account "${account.accountId}" (missing botToken)`,
        );
      }

      const log = ctx.log;
      const statusSink: OctoStatusSink = (patch) =>
        ctx.setStatus({ accountId: account.accountId, ...patch });

      // Operator-facing one-shot audit: if any configured accountId contains
      // uppercase characters, log the count (NOT the IDs themselves — avoids
      // leaking bot identifiers). All internal storage is normalized so this
      // is informational only; it helps operators decide whether to clean up
      // legacy disk dirs or notify users to rotate to lowercase bots. See
      // issue #33 / octo-server#302.
      try {
        const allIds = listOctoAccountIds(ctx.cfg);
        const mixedCount = allIds.filter((id) => id !== id.toLowerCase()).length;
        if (mixedCount > 0) {
          log?.info?.(
            `octo: detected ${mixedCount} mixed-case Octo accountId(s); internal storage normalized (see openclaw-channel-octo#33)`,
          );
        }
      } catch { /* config snapshot inaccessible — non-fatal */ }

      log?.info?.(`[${account.accountId}] registering Octo bot...`);

      // 1. Register bot (first attempt uses cached token)
      let credentials: {
        robot_id: string;
        im_token: string;
        ws_url: string;
        owner_uid: string;
      };
      try {
        credentials = await registerBot({
          apiUrl: account.config.apiUrl,
          botToken: account.config.botToken,
          agentPlatform: "OpenClaw",
          agentVersion: getAgentVersion(),
          pluginVersion: PLUGIN_VERSION,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log?.error?.(`octo: bot registration failed: ${message}`);
        statusSink({ lastError: message });
        throw err;
      }

      // Track this bot's uid for bot-to-bot loop prevention
      _knownBotUids.add(credentials.robot_id);

      // Register owner_uid for permission checks
      if (credentials.owner_uid) {
        registerOwnerUid(account.accountId, credentials.owner_uid);
      }

      log?.info?.(
        `[${account.accountId}] bot registered as ${credentials.robot_id}`,
      );

      // Preload member cache for cross-session permission checks (fire-and-forget)
      preloadGroupMemberCache({
        apiUrl: account.config.apiUrl,
        botToken: account.config.botToken!,
        log,
      }).catch(() => {});

      // Preload group-level 免@偏好 for this bot (fire-and-forget). Optional
      // warm-up; the inbound mention gate works lazily without it.
      preloadMentionPrefs({
        accountId: account.accountId,
        apiUrl: account.config.apiUrl,
        botToken: account.config.botToken!,
        log,
      }).catch(() => {});

      // Start persona_prompt cache refresh loop for persona-clone bots
      // (GH octo-adapters#68). No-op for regular bots. Polls
      // GET /v1/bot/obo-grant so persona_prompt edits propagate without
      // requiring a fan-out copy or process restart.
      initPersonaPromptCache(
        {
          accountId: account.accountId,
          apiUrl: account.config.apiUrl,
          botToken: account.config.botToken!,
          onBehalfOf: account.config.onBehalfOf,
        },
        log,
      );

      // NOTE: ACP thread-binding adapter is NOT registered here. The canonical
      // wiring is via `octoPlugin.conversationBindings.createManager`, which
      // OpenClaw runtime calls on demand and whose returned `{stop}` it owns.
      // See the plugin declaration above and `src/thread-binding-adapter.ts`.

      // Prefetch GROUP.md and group members for all groups (fire-and-forget)
      const groupMdCache = getOrCreateGroupMdCache(account.accountId);
      (async () => {
        try {
          const groups = await fetchBotGroups({ apiUrl: account.config.apiUrl, botToken: account.config.botToken!, log });
          registerBotGroupIds(groups.map(g => g.group_no));
          let mdCount = 0;
          let memberCount = 0;
          for (const g of groups) {
            // Register group → account mapping for outbound accountId resolution
            registerGroupToAccount(g.group_no, account.accountId);

            // Prefetch GROUP.md
            try {
              const md = await getGroupMd({ apiUrl: account.config.apiUrl, botToken: account.config.botToken!, groupNo: g.group_no, log });
              if (md.content) {
                groupMdCache.set(g.group_no, { content: md.content, version: md.version });
                writeGroupMdToDisk({
                  accountId: account.accountId,
                  groupNo: g.group_no,
                  content: md.content,
                  meta: {
                    version: md.version,
                    updated_at: null,
                    updated_by: "prefetch",
                    fetched_at: new Date().toISOString(),
                    account_id: account.accountId,
                  },
                });
                mdCount++;
              }
            } catch {
              // Ignore per-group failures (group may not have GROUP.md)
            }
            // Prefetch group members → fill uidToNameMap for SenderName resolution
            // Uses cache so preloadGroupMemberCache() results are reused
            try {
              const members = await getGroupMembersFromCache({ apiUrl: account.config.apiUrl, botToken: account.config.botToken!, groupNo: g.group_no, log });
              const prefetchMemberMap = getOrCreateMemberMap(account.accountId);
              const prefetchUidMap = getOrCreateUidToNameMap(account.accountId);
              for (const m of members) {
                if (m.uid && m.name) {
                  prefetchMemberMap.set(m.name, m.uid);
                  prefetchUidMap.set(m.uid, m.name);
                  memberCount++;
                }
              }
            } catch {
              // Ignore per-group failures
            }
          }
          if (mdCount > 0) {
            log?.info?.(`octo: prefetched GROUP.md for ${mdCount} groups`);
          }
          if (memberCount > 0) {
            log?.info?.(`octo: prefetched ${memberCount} member names from ${groups.length} groups`);
          }
        } catch (err) {
          log?.error?.(`octo: group prefetch failed: ${String(err)}`);
        }
      })();

      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
        lastError: null,
      });

      // 2. Resolve WebSocket URL
      const wsUrl = account.config.wsUrl || credentials.ws_url;

      // 3. Start heartbeat timer
      let heartbeatTimer: NodeJS.Timeout | null = null;
      let stopped = false;

      const startHeartbeat = () => {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        heartbeatTimer = setInterval(() => {
          if (stopped) return;
          sendHeartbeat({
            apiUrl: account.config.apiUrl,
            botToken: account.config.botToken!,
          }).then(() => {
            consecutiveHeartbeatFailures = 0; // Reset on success
          }).catch(async (err) => {
            consecutiveHeartbeatFailures++;
            log?.error?.(`octo: [${account.accountId}] heartbeat failed (${consecutiveHeartbeatFailures}/${MAX_HEARTBEAT_FAILURES}): ${String(err)}`);
            if (consecutiveHeartbeatFailures >= MAX_HEARTBEAT_FAILURES && !stopped) {
              log?.warn?.(`octo: [${account.accountId}] too many heartbeat failures, triggering reconnect...`);
              consecutiveHeartbeatFailures = 0;
              if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
              const backoffMs = 3000 + Math.floor(Math.random() * 2000);
              await new Promise(r => setTimeout(r, backoffMs));
              if (stopped) return;
              await socket.disconnectAndWait();
              socket.stopReconnectTimer();
              socket.connect();
            }
          });
        }, account.config.heartbeatIntervalMs);
      };

      // 4. Group history map — persists across auto-restarts (module-level)
      const groupHistories = getOrCreateHistoryMap(account.accountId);

      // 4a. Last bot reply seq map — for history segmentation
      const lastBotReplySeqMap = getOrCreateLastBotReplySeqMap(account.accountId);

      // 4b. Member name->uid map — for resolving @mentions in replies
      const memberMap = getOrCreateMemberMap(account.accountId);

      // 4c. Reverse map uid->name — for showing display names in replies
      const uidToNameMap = getOrCreateUidToNameMap(account.accountId);

      // 4d. Group cache timestamps — track when each group's members were last fetched
      const groupCacheTimestamps = getOrCreateGroupCacheTimestamps(account.accountId);

      // 4e. Robot flags map — server-authoritative sender classification for the 免@ gate
      const memberRobotMap = getOrCreateMemberRobotMap(account.accountId);

      // 5. Token refresh state — time-based cooldown to prevent refresh storms
      let lastTokenRefreshAt = 0;
      const TOKEN_REFRESH_COOLDOWN_MS = 60_000; // 60 seconds
      let isRefreshingToken = false; // Guard against concurrent refreshes (#43)

      // 5b. Cooldown reconnect timer — deduplicate to prevent self-kick storms (#139)
      let cooldownReconnectTimer: ReturnType<typeof setTimeout> | null = null;

      // 5c. Heartbeat failure tracking — reconnect after consecutive failures (#42)
      let consecutiveHeartbeatFailures = 0;
      const MAX_HEARTBEAT_FAILURES = 3;

      // 6. Connect WebSocket — pure real-time
      const socket = new WKSocket({
        wsUrl,
        uid: credentials.robot_id,
        token: credentials.im_token,

        onMessage: (msg: BotMessage) => {
          // Allow structured event messages (e.g. group_md_updated) even from self/bots
          const isEvent = !!(msg.payload as any)?.event?.type; // TODO: remove when SDK types support this
          if (msg.payload?.type === 1 && (msg.payload as any)?.event) { // TODO: remove when SDK types support this
          }
          // Skip self messages (but not events — bot needs to know about its own GROUP.md updates)
          if (msg.from_uid === credentials.robot_id && !isEvent) return;
          // Skip messages from any other bot in this plugin instance (prevent bot-to-bot loops)
          // But allow group messages through — bot-to-bot @mention in groups is legitimate;
          // mention gating in inbound.ts ensures only @-targeted messages trigger AI.
          // Also allow event messages (e.g. group_md_updated) from any source.
          if (_knownBotUids.has(msg.from_uid) && msg.channel_type === ChannelType.DM && !isEvent) return;
          // Skip unsupported message types (Location, Card), but allow event messages through
          const supportedTypes = [MessageType.Text, MessageType.Image, MessageType.GIF, MessageType.Voice, MessageType.Video, MessageType.File, MessageType.MultipleForward, MessageType.RichText];
          if (!msg.payload || (!supportedTypes.includes(msg.payload.type) && !isEvent)) return;

          // Defense-in-depth DM filter (kept for safety, though v0.2.28+ uses independent
          // WebSocket connections per bot so server-side routing is already correct).
          // DM channel_id is typically "uid1@uid2", but may also be a plain uid
          // when channel_type === 1 without '@'. The plain-uid case needs no extra filter
          // since each bot has its own WS connection.
          if (msg.channel_type === ChannelType.DM && msg.channel_id && msg.channel_id.includes("@")) {
            const parts = msg.channel_id.split("@");
            if (!parts.includes(credentials.robot_id)) {
              log?.info?.(
                `octo: [${account.accountId}] skipping DM not for this bot: channel=${msg.channel_id} bot=${credentials.robot_id}`,
              );
              return;
            }
          }

          log?.info?.(
            `octo: [${account.accountId}] recv message from=${msg.from_uid} channel=${msg.channel_id ?? "DM"} type=${msg.channel_type ?? 1}`,
          );

          // Track cache activity for cleanup
          if (msg.channel_id) {
            touchCache(account.accountId, msg.channel_id);
            if (msg.channel_type === ChannelType.Group || msg.channel_type === ChannelType.CommunityTopic) {
              const groupId = msg.channel_type === ChannelType.CommunityTopic
                ? msg.channel_id.split("____")[0]
                : msg.channel_id;
              registerGroupToAccount(groupId, account.accountId);
            }
          }

          const inboundQueueKey = getInboundQueueKey(account.accountId, msg);

          enqueueInbound(
            inboundQueueKey,
            () =>
              handleInboundMessage({
                account,
                message: msg,
                botUid: credentials.robot_id,
                groupHistories,
                lastBotReplySeqMap,
                memberMap,
                uidToNameMap,
                groupCacheTimestamps,
                memberRobotMap,
                groupMdCache,
                log,
                statusSink,
              }),
            log,
          );
        },

        onConnected: () => {
          log?.info?.(`octo: [${account.accountId}] WebSocket connected to ${wsUrl}`);
          statusSink({ lastError: null });
          consecutiveHeartbeatFailures = 0;
          startHeartbeat();
        },

        onDisconnected: () => {
          log?.warn?.(`octo: [${account.accountId}] WebSocket disconnected, will reconnect...`);
          if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
          statusSink({ lastError: "disconnected" });
        },

        onError: async (err: Error) => {
          log?.error?.(`octo: [${account.accountId}] WebSocket error: ${err.message}`);
          statusSink({ lastError: err.message });

          // If kicked or connect failed, try refreshing the IM token with a cooldown
          // to prevent refresh storms (e.g. 9000+ refreshes across 11 bots).
          // Use isRefreshingToken to prevent concurrent refresh attempts (#43)
          const cooldownElapsed = Date.now() - lastTokenRefreshAt > TOKEN_REFRESH_COOLDOWN_MS;
          if (cooldownElapsed && !isRefreshingToken && !stopped &&
              (err.message.includes("Kicked") || err.message.includes("Connect failed"))) {
            isRefreshingToken = true;
            lastTokenRefreshAt = Date.now();
            log?.warn?.(`octo: [${account.accountId}] connection rejected — refreshing IM token...`);
            try {
              await socket.disconnectAndWait();
              const fresh = await registerBot({
                apiUrl: account.config.apiUrl,
                botToken: account.config.botToken!,
                forceRefresh: true,
                agentPlatform: "OpenClaw",
                agentVersion: getAgentVersion(),
                pluginVersion: PLUGIN_VERSION,
              });
              credentials = fresh;
              log?.info?.(`octo: [${account.accountId}] got fresh IM token, reconnecting WS...`);
              socket.updateCredentials(fresh.robot_id, fresh.im_token);
              // Stagger reconnect to avoid thundering herd when multiple bots
              // refresh tokens simultaneously after server-wide token expiry
              const staggerMs = Math.floor(Math.random() * 5000);
              log?.info?.(`octo: [${account.accountId}] staggering reconnect by ${staggerMs}ms`);
              await new Promise(r => setTimeout(r, staggerMs));
              if (stopped) return; // account was stopped during stagger delay
              socket.connect();
            } catch (refreshErr) {
              log?.error?.(`octo: [${account.accountId}] token refresh failed: ${String(refreshErr)}`);
              // Keep cooldown active even on failure to prevent rapid retry hammering
            } finally {
              isRefreshingToken = false;
            }
          } else if (!isRefreshingToken && !stopped &&
              (err.message.includes("Kicked") || err.message.includes("Connect failed"))) {
            // Cooldown active — skip token refresh but still reconnect with current credentials.
            // Deduplicate: clear any pending cooldown reconnect timer to prevent self-kick storms
            // where multiple setTimeout callbacks fire simultaneously, each calling connect(),
            // causing the same bot to have multiple WS connections that kick each other (#139).
            if (cooldownReconnectTimer) {
              clearTimeout(cooldownReconnectTimer);
            }
            log?.warn?.(`octo: [${account.accountId}] cooldown active, scheduling reconnect with current credentials...`);
            const backoffMs = 5000 + Math.floor(Math.random() * 5000);
            cooldownReconnectTimer = setTimeout(async () => {
              cooldownReconnectTimer = null;
              if (!stopped) {
                await socket.disconnectAndWait();
                socket.stopReconnectTimer();
                socket.connect();
              }
            }, backoffMs);
          }
        },
      });

      socket.connect();

      // Keep Promise pending until stopped — gateway treats resolve as "account stopped"
      return new Promise((resolve) => {
        const cleanup = () => {
          if (stopped) return;
          stopped = true;
          socket.disconnect();
          if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
          if (cooldownReconnectTimer) { clearTimeout(cooldownReconnectTimer); cooldownReconnectTimer = null; }
          stopPersonaPromptCache(account.accountId);
          ctx.setStatus({
            accountId: account.accountId,
            running: false,
            lastStopAt: Date.now(),
          });
          resolve({
            stop: () => { /* already cleaned up */ },
          });
        };

        if (ctx.abortSignal.aborted) {
          cleanup();
        } else {
          ctx.abortSignal.addEventListener("abort", cleanup, { once: true });
        }
      });
    },
  },
};
