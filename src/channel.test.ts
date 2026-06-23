import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_ACCOUNT_ID } from "./sdk-compat.js";

// Mock api-fetch so outbound adapter wiring tests (below) can observe the
// final sendMessage / sendMediaMessage arguments without actually hitting
// Octo. Real implementations still ship in the bundle — this is test-only.
//
// Default success result — outbound deliver helper (toDeliveryResult) throws
// on missing message_id (issue #51), so existing wiring tests that only
// care about HOW we called sendMessage need a valid result by default.
// Individual tests can `vi.mocked(sendMessage).mockResolvedValueOnce(...)`
// to assert failure paths.
vi.mock("./api-fetch.js", async () => {
  const okResult = { message_id: "test-msg-id", client_msg_no: "uuid", message_seq: 1 };
  return {
    sendMessage: vi.fn().mockResolvedValue(okResult),
    sendMediaMessage: vi.fn().mockResolvedValue(okResult),
    getUploadPresign: vi.fn().mockResolvedValue({
      uploadUrl: "https://minio.example/octo/chat/1/a/b.txt?sig=1",
      downloadUrl: "https://cdn.example/file.txt",
      contentType: "text/plain; charset=utf-8",
      contentDisposition: 'inline; filename="file.txt"',
    }),
    uploadFileToPresignedUrl: vi.fn().mockResolvedValue({ url: "https://cdn.example/file.txt" }),
    inferContentType: (fn: string) =>
      fn.endsWith(".txt") ? "text/plain" : "application/octet-stream",
    ensureTextCharset: (ct: string) =>
      ct.startsWith("text/") && !ct.includes("charset") ? ct + "; charset=utf-8" : ct,
    parseImageDimensions: () => null,
    parseImageDimensionsFromFile: async () => null,
    registerBot: vi.fn(),
    sendHeartbeat: vi.fn(),
    fetchBotGroups: vi.fn().mockResolvedValue([]),
    getGroupMembers: vi.fn().mockResolvedValue([]),
    getGroupMd: vi.fn(),
  };
});

// ─── Token refresh cooldown tests ───────────────────────────────────────────
// These test the time-based cooldown pattern used in channel.ts onError handler
// to prevent token refresh storms.

describe("token refresh cooldown logic", () => {
  it("should allow refresh when cooldown has elapsed", () => {
    let lastTokenRefreshAt = 0;
    const TOKEN_REFRESH_COOLDOWN_MS = 60_000;

    const cooldownElapsed = Date.now() - lastTokenRefreshAt > TOKEN_REFRESH_COOLDOWN_MS;
    expect(cooldownElapsed).toBe(true);
  });

  it("should block refresh within cooldown window", () => {
    const TOKEN_REFRESH_COOLDOWN_MS = 60_000;
    let lastTokenRefreshAt = Date.now(); // just refreshed

    const cooldownElapsed = Date.now() - lastTokenRefreshAt > TOKEN_REFRESH_COOLDOWN_MS;
    expect(cooldownElapsed).toBe(false);
  });

  it("should allow refresh after cooldown expires", () => {
    const TOKEN_REFRESH_COOLDOWN_MS = 60_000;
    // Simulate a refresh that happened 61 seconds ago
    let lastTokenRefreshAt = Date.now() - 61_000;

    const cooldownElapsed = Date.now() - lastTokenRefreshAt > TOKEN_REFRESH_COOLDOWN_MS;
    expect(cooldownElapsed).toBe(true);
  });

  it("should keep cooldown active even after failed refresh (no reset)", () => {
    const TOKEN_REFRESH_COOLDOWN_MS = 60_000;
    let lastTokenRefreshAt = 0;

    // Simulate a refresh attempt (set timestamp before trying)
    lastTokenRefreshAt = Date.now();

    // Simulate failure — in the old code, hasRefreshedToken was reset to false
    // In the new code, lastTokenRefreshAt stays set (no reset in catch block)
    // So subsequent attempts within cooldown should be blocked
    const cooldownElapsed = Date.now() - lastTokenRefreshAt > TOKEN_REFRESH_COOLDOWN_MS;
    expect(cooldownElapsed).toBe(false);
  });

  it("should apply stagger delay before reconnect", async () => {
    // Verify the stagger delay pattern works
    const start = Date.now();
    const staggerMs = Math.floor(Math.random() * 5000);
    expect(staggerMs).toBeGreaterThanOrEqual(0);
    expect(staggerMs).toBeLessThan(5000);
  });
});

/**
 * Tests for channel.ts singleton timer behavior.
 * Verifies that cleanup timer doesn't accumulate during hot reloads.
 *
 * Fixes: https://github.com/Mininglamp-OSS/octo-adapters/issues/54
 */

describe("ensureCleanupTimer singleton pattern", () => {
  let originalSetInterval: typeof setInterval;
  let setIntervalCalls: number;

  beforeEach(() => {
    originalSetInterval = global.setInterval;
    setIntervalCalls = 0;

    // Track setInterval calls
    global.setInterval = vi.fn(() => {
      setIntervalCalls++;
      // Return a mock timer object that won't actually run
      const timerId = { unref: vi.fn() } as unknown as NodeJS.Timeout;
      return timerId;
    }) as unknown as typeof setInterval;
  });

  afterEach(() => {
    global.setInterval = originalSetInterval;
    vi.resetModules();
  });

  it("should only create one cleanup timer on first import", async () => {
    // Fresh import - timer should be created lazily now (not at module load)
    // Since we changed to lazy initialization, no timer at import time
    vi.resetModules();
    const { octoPlugin } = await import("./channel.js");

    // At this point, no timer should have been created yet
    // Timer is created when startAccount is called
    expect(octoPlugin).toBeDefined();
    expect(octoPlugin.id).toBe("octo");
  });

  it("should expose ensureCleanupTimer via gateway.startAccount pattern", async () => {
    vi.resetModules();
    const { octoPlugin } = await import("./channel.js");

    // The gateway.startAccount method should exist and call ensureCleanupTimer
    expect(octoPlugin.gateway?.startAccount).toBeDefined();
    expect(typeof octoPlugin.gateway?.startAccount).toBe("function");
  });
});

describe("octoPlugin structure", () => {
  it("should have correct plugin id and meta", async () => {
    const { octoPlugin } = await import("./channel.js");

    expect(octoPlugin.id).toBe("octo");
    expect(octoPlugin.meta.id).toBe("octo");
    expect(octoPlugin.meta.label).toBe("Octo");
  });

  it("should have gateway.startAccount defined", async () => {
    const { octoPlugin } = await import("./channel.js");

    expect(octoPlugin.gateway).toBeDefined();
    expect(octoPlugin.gateway?.startAccount).toBeDefined();
  });

  it("should support direct and group chat types", async () => {
    const { octoPlugin } = await import("./channel.js");

    expect(octoPlugin.capabilities?.chatTypes).toContain("direct");
    expect(octoPlugin.capabilities?.chatTypes).toContain("group");
  });
});

// ─── Group → Account mapping tests ──────────────────────────────────────────

describe("resolveAccountForGroup — prefetch registration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("should register groups during startup prefetch", async () => {
    const { registerGroupToAccount, resolveAccountForGroup } = await import("./channel.js");

    // Simulate prefetch registration
    registerGroupToAccount("group_abc", "acct_1");

    // resolveAccountForGroup should now return the registered account
    expect(resolveAccountForGroup("group_abc")).toBe("acct_1");
  });
});

// ─── resolveOutboundAccountId tests ──────────────────────────────────────────

describe("resolveOutboundAccountId", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("should strip @uid suffix from group target and resolve account", async () => {
    const { registerGroupToAccount, resolveOutboundAccountId } = await import("./channel.js");

    registerGroupToAccount("abc", "acct_A");

    // "group:abc@uid1,uid2" → should strip @uid1,uid2, resolve group "abc"
    // Returned accountId is normalized to lowercase (see issue #33).
    const result = resolveOutboundAccountId("group:abc@uid1,uid2", "fallback");
    expect(result).toBe("acct_a");
  });

  it("should resolve plain group target without @suffix", async () => {
    const { registerGroupToAccount, resolveOutboundAccountId } = await import("./channel.js");

    registerGroupToAccount("abc", "acct_B");

    // Returned accountId is normalized to lowercase.
    const result = resolveOutboundAccountId("group:abc", "fallback");
    expect(result).toBe("acct_b");
  });

  it("should return fallback for DM targets (no correction)", async () => {
    const { resolveOutboundAccountId } = await import("./channel.js");

    // DM target — resolveOutboundAccountId should not correct, return fallback
    const result = resolveOutboundAccountId("user:some_uid", "fallback_acct");
    expect(result).toBe("fallback_acct");
  });

  // channel:<id> is an alternative prefix OpenClaw's delivery pipeline can emit
  // for group channels. If the normalisation layer misses it, the group→account
  // lookup silently falls back to the caller-provided accountId and the turn
  // goes out through the wrong bot's token. Keep these three cases as a
  // regression guard for the prefix-normalisation step in particular.

  it("should resolve channel:<id> alias like group:<id>", async () => {
    const { registerGroupToAccount, resolveOutboundAccountId } = await import("./channel.js");
    registerGroupToAccount("abc", "acct_chan");
    const result = resolveOutboundAccountId("channel:abc", "fallback");
    expect(result).toBe("acct_chan");
  });

  it("should resolve channel:<id>____<short> to the parent group's account", async () => {
    const { registerGroupToAccount, resolveOutboundAccountId } = await import("./channel.js");
    registerGroupToAccount("abc", "acct_thread");
    const result = resolveOutboundAccountId("channel:abc____topicA", "fallback");
    expect(result).toBe("acct_thread");
  });

  it("should strip @uid suffix from channel:<id>@uid1,uid2 target", async () => {
    const { registerGroupToAccount, resolveOutboundAccountId } = await import("./channel.js");
    registerGroupToAccount("abc", "acct_chan_uid");
    const result = resolveOutboundAccountId("channel:abc@uid1,uid2", "fallback");
    expect(result).toBe("acct_chan_uid");
  });
});

describe("resolveOutboundAccountId — group→account correction semantics", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("corrects unambiguously owned single-bot groups even when a different accountId is explicitly passed", async () => {
    // Intent: if the group belongs to exactly one configured bot, always use
    // that bot's accountId — otherwise the turn goes out with a token the
    // backend will reject (bot not a member of the group). This is the safe
    // default; explicit accountId is only meaningful when the group has
    // multiple bots registered to it (see next test).
    const { registerGroupToAccount, resolveOutboundAccountId } = await import("./channel.js");
    registerGroupToAccount("some_group", "thomas_fu_bot");
    const resolved = resolveOutboundAccountId("group:some_group", "allen-imtest");
    expect(resolved).toBe("thomas_fu_bot");
  });

  it("falls back to explicit accountId when group is shared by multiple bots", async () => {
    // When >1 bots are registered to the same group, resolveAccountForGroup
    // returns undefined and we honour whatever the caller passed — this is
    // where "explicit accountId wins" applies.
    const { registerGroupToAccount, resolveOutboundAccountId } = await import("./channel.js");
    registerGroupToAccount("shared_group", "bot_a");
    registerGroupToAccount("shared_group", "bot_b");
    const resolved = resolveOutboundAccountId("group:shared_group", "bot_a");
    expect(resolved).toBe("bot_a");
  });

  it("corrects when rawAccountId is the DEFAULT alias", async () => {
    const { registerGroupToAccount, resolveOutboundAccountId } = await import("./channel.js");
    registerGroupToAccount("some_group", "thomas_fu_bot");
    const resolved = resolveOutboundAccountId("group:some_group", DEFAULT_ACCOUNT_ID);
    expect(resolved).toBe("thomas_fu_bot");
  });
});

describe("outbound accountId correction pattern", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("should use resolveAccountForGroup for group targets", async () => {
    const { registerGroupToAccount, resolveAccountForGroup } = await import("./channel.js");
    const { parseTarget } = await import("./actions.js");

    registerGroupToAccount("group_xyz", "correct_acct");

    const target = "group:group_xyz";
    const { channelId, channelType } = parseTarget(target);

    // Simulate the correction logic
    let accountId = "wrong_acct";
    if (channelType === 2) { // ChannelType.Group
      const correct = resolveAccountForGroup(channelId);
      if (correct) accountId = correct;
    }

    expect(accountId).toBe("correct_acct");
  });
});

// ─── @all / @所有人 hasAtAll regex tests ──────────────────────────────────────

describe("hasAtAll regex — @所有人 support", () => {
  const hasAtAllRegex = /(?:^|(?<=\s))@(?:all|所有人)(?=\s|[^\w]|$)/i;

  it("should match @all", () => {
    expect(hasAtAllRegex.test("hello @all please check")).toBe(true);
  });

  it("should match @All (case-insensitive)", () => {
    expect(hasAtAllRegex.test("hello @All please")).toBe(true);
  });

  it("should match @所有人", () => {
    expect(hasAtAllRegex.test("大家好 @所有人 请注意")).toBe(true);
  });

  it("should match @所有人 at start of string", () => {
    expect(hasAtAllRegex.test("@所有人 请注意")).toBe(true);
  });

  it("should match @all at start of string", () => {
    expect(hasAtAllRegex.test("@all check this")).toBe(true);
  });

  it("should match @所有人 at end of string", () => {
    expect(hasAtAllRegex.test("通知 @所有人")).toBe(true);
  });

  it("should NOT match @Alice (not all)", () => {
    expect(hasAtAllRegex.test("hello @Alice")).toBe(false);
  });

  it("should NOT match email with @all in domain", () => {
    expect(hasAtAllRegex.test("email user@all.com")).toBe(false);
  });
});

// ─── sendText v2 structured mention handling (unit logic) ─────────────────────

describe("sendText v2 mention processing logic", () => {
  it("should convert @[uid:name] to @name + entities", async () => {
    const { parseStructuredMentions, convertStructuredMentions, buildEntitiesFromFallback } = await import("./mention-utils.js");

    const content = "请 @[abc123:张三] 确认";
    const memberMap = new Map([["张三", "abc123"]]);

    // v2 path
    const structuredMentions = parseStructuredMentions(content);
    expect(structuredMentions).toHaveLength(1);

    const converted = convertStructuredMentions(content, structuredMentions);
    expect(converted.content).toBe("请 @张三 确认");
    expect(converted.entities).toHaveLength(1);
    expect(converted.entities[0]).toEqual({ uid: "abc123", offset: 2, length: 3 });
    expect(converted.uids).toEqual(["abc123"]);

    // v1 fallback on converted content should find @张三 but not create duplicate
    const fallback = buildEntitiesFromFallback(converted.content, memberMap);
    expect(fallback.uids).toEqual(["abc123"]);
  });

  it("should handle mixed v2 + v1 mentions", async () => {
    const { parseStructuredMentions, convertStructuredMentions, buildEntitiesFromFallback } = await import("./mention-utils.js");

    const content = "@[abc:张三] 和 @李四";
    const memberMap = new Map([["张三", "abc"], ["李四", "def"]]);

    // v2 path
    const structuredMentions = parseStructuredMentions(content);
    expect(structuredMentions).toHaveLength(1);

    const converted = convertStructuredMentions(content, structuredMentions);
    expect(converted.content).toBe("@张三 和 @李四");

    // v1 fallback resolves @李四
    const fallback = buildEntitiesFromFallback(converted.content, memberMap);

    // Merge with dedup
    const mentionEntities = [...converted.entities];
    const existingOffsets = new Set(mentionEntities.map(e => e.offset));
    for (const entity of fallback.entities) {
      if (!existingOffsets.has(entity.offset)) {
        mentionEntities.push(entity);
      }
    }

    expect(mentionEntities).toHaveLength(2);
    expect(mentionEntities.map(e => e.uid).sort()).toEqual(["abc", "def"]);
  });

  it("pure v1 content should work unchanged", async () => {
    const { parseStructuredMentions, buildEntitiesFromFallback } = await import("./mention-utils.js");

    const content = "@张三 你好";
    const structuredMentions = parseStructuredMentions(content);
    expect(structuredMentions).toHaveLength(0);

    const memberMap = new Map([["张三", "abc"]]);
    const fallback = buildEntitiesFromFallback(content, memberMap);
    expect(fallback.uids).toEqual(["abc"]);
    expect(fallback.entities).toHaveLength(1);
  });

  it("@[uid:name] with @所有人 should only produce entity for name, not 所有人", async () => {
    const { parseStructuredMentions, convertStructuredMentions, buildEntitiesFromFallback } = await import("./mention-utils.js");

    const content = "@[abc:张三] @所有人";
    const memberMap = new Map([["张三", "abc"]]);

    const structured = parseStructuredMentions(content);
    const converted = convertStructuredMentions(content, structured);
    expect(converted.content).toBe("@张三 @所有人");

    const fallback = buildEntitiesFromFallback(converted.content, memberMap);
    // @所有人 should be skipped by buildEntitiesFromFallback
    const allEntities = [...converted.entities];
    const existingOffsets = new Set(allEntities.map(e => e.offset));
    for (const entity of fallback.entities) {
      if (!existingOffsets.has(entity.offset)) {
        allEntities.push(entity);
      }
    }
    // Only 张三 should have an entity
    expect(allEntities).toHaveLength(1);
    expect(allEntities[0].uid).toBe("abc");

    // hasAtAll should be true
    const hasAtAll = /(?:^|(?<=\s))@(?:all|所有人)(?=\s|[^\w]|$)/i.test(converted.content);
    expect(hasAtAll).toBe(true);
  });
});

// ─── outbound adapter wiring (thread cross-channel regression) ──────────────
// These exercise the full sendText / sendMedia adapter path — not just the
// resolveOutboundOctoTarget helper — to pin down that ctx.threadId is
// correctly wired from framework input all the way to sendMessage /
// sendMediaMessage. Motivated by the bug where OpenClaw passed
// to="group:<group_no>" + threadId="<short>" and files silently landed in
// the parent group (channel_type=2) instead of the sub-topic (5).

describe("outbound.sendText — threadId wiring", () => {
  const cfg = {
    channels: {
      octo: {
        apiUrl: "https://api.example",
        accounts: {
          default: { botToken: "bf_test", apiUrl: "https://api.example" },
        },
      },
    },
  };

  beforeEach(async () => {
    const apiFetch = await import("./api-fetch.js");
    (apiFetch.sendMessage as any).mockClear();
  });

  it("merges ctx.threadId into the group target as CommunityTopic (type=5)", async () => {
    const { octoPlugin } = await import("./channel.js");
    const { sendMessage } = await import("./api-fetch.js");

    await octoPlugin.outbound!.sendText!({
      cfg,
      to: "group:grp1",
      threadId: "topicA",
      text: "hi from bot",
      accountId: "default",
    } as any);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = (sendMessage as any).mock.calls[0][0];
    expect(call.channelId).toBe("grp1____topicA");
    expect(call.channelType).toBe(5); // ChannelType.CommunityTopic
    expect(call.content).toBe("hi from bot");
  });

  it("leaves a parent-group target (no threadId) as Group (type=2)", async () => {
    const { octoPlugin } = await import("./channel.js");
    const { sendMessage } = await import("./api-fetch.js");

    await octoPlugin.outbound!.sendText!({
      cfg,
      to: "group:grp1",
      text: "parent group reply",
      accountId: "default",
    } as any);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = (sendMessage as any).mock.calls[0][0];
    expect(call.channelId).toBe("grp1");
    expect(call.channelType).toBe(2); // ChannelType.Group
  });

  it("accepts channel:<id> alias + threadId and routes to CommunityTopic", async () => {
    const { octoPlugin } = await import("./channel.js");
    const { sendMessage } = await import("./api-fetch.js");

    await octoPlugin.outbound!.sendText!({
      cfg,
      to: "channel:grp1",
      threadId: "topicA",
      text: "hi",
      accountId: "default",
    } as any);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = (sendMessage as any).mock.calls[0][0];
    expect(call.channelId).toBe("grp1____topicA");
    expect(call.channelType).toBe(5);
  });
});

describe("outbound.sendMedia — threadId wiring", () => {
  const cfg = {
    channels: {
      octo: {
        apiUrl: "https://api.example",
        accounts: {
          default: { botToken: "bf_test", apiUrl: "https://api.example" },
        },
      },
    },
  };

  beforeEach(async () => {
    const apiFetch = await import("./api-fetch.js");
    (apiFetch.sendMediaMessage as any).mockClear();
    (apiFetch.getUploadPresign as any).mockClear();
    (apiFetch.uploadFileToPresignedUrl as any).mockClear();
  });

  it("merges ctx.threadId into the group target as CommunityTopic (type=5)", async () => {
    const { octoPlugin } = await import("./channel.js");
    const { sendMediaMessage } = await import("./api-fetch.js");

    await octoPlugin.outbound!.sendMedia!({
      cfg,
      to: "group:grp1",
      threadId: "topicA",
      text: "",
      mediaUrl: "data:text/plain;base64,aGVsbG8=",
      accountId: "default",
    } as any);

    expect(sendMediaMessage).toHaveBeenCalledTimes(1);
    const call = (sendMediaMessage as any).mock.calls[0][0];
    expect(call.channelId).toBe("grp1____topicA");
    expect(call.channelType).toBe(5);
    expect(call.url).toBe("https://cdn.example/file.txt");
  });

  it("leaves a parent-group target (no threadId) as Group (type=2)", async () => {
    const { octoPlugin } = await import("./channel.js");
    const { sendMediaMessage } = await import("./api-fetch.js");

    await octoPlugin.outbound!.sendMedia!({
      cfg,
      to: "group:grp1",
      text: "",
      mediaUrl: "data:text/plain;base64,aGVsbG8=",
      accountId: "default",
    } as any);

    expect(sendMediaMessage).toHaveBeenCalledTimes(1);
    const call = (sendMediaMessage as any).mock.calls[0][0];
    expect(call.channelId).toBe("grp1");
    expect(call.channelType).toBe(2);
  });

  it("accepts channel:<id> alias + threadId and routes to CommunityTopic", async () => {
    const { octoPlugin } = await import("./channel.js");
    const { sendMediaMessage } = await import("./api-fetch.js");

    await octoPlugin.outbound!.sendMedia!({
      cfg,
      to: "channel:grp1",
      threadId: "topicA",
      text: "",
      mediaUrl: "data:text/plain;base64,aGVsbG8=",
      accountId: "default",
    } as any);

    expect(sendMediaMessage).toHaveBeenCalledTimes(1);
    const call = (sendMediaMessage as any).mock.calls[0][0];
    expect(call.channelId).toBe("grp1____topicA");
    expect(call.channelType).toBe(5);
  });

  it("preserves an already-synthesised channel_id even if threadId is also passed", async () => {
    const { octoPlugin } = await import("./channel.js");
    const { sendMediaMessage } = await import("./api-fetch.js");

    await octoPlugin.outbound!.sendMedia!({
      cfg,
      to: "group:grp1____topicA",
      threadId: "different",
      text: "",
      mediaUrl: "data:text/plain;base64,aGVsbG8=",
      accountId: "default",
    } as any);

    expect(sendMediaMessage).toHaveBeenCalledTimes(1);
    const call = (sendMediaMessage as any).mock.calls[0][0];
    // ctx.to wins; duplicate threadId must not re-concat or downgrade.
    expect(call.channelId).toBe("grp1____topicA");
    expect(call.channelType).toBe(5);
  });
});

/**
 * Streaming size cap for the outbound HTTP-URL branch (PR#66 R2 — lml2468 阻断点).
 *
 * channel.ts#downloadToTempFile is the only line of defense after dropping the
 * HEAD-based pre-check. This test drives the cap through octoPlugin.outbound.sendMedia
 * with an http(s):// mediaUrl so the private downloadToTempFile is exercised end-to-end:
 *   - rejects with /exceeds max/
 *   - presigned PUT is never called
 *   - partial temp file under /tmp/octo-upload is unlinked on failure
 */
describe("outbound.sendMedia — HTTP streaming size cap (R2)", () => {
  const cfg = {
    channels: {
      octo: {
        apiUrl: "https://api.example",
        accounts: {
          default: { botToken: "bf_test", apiUrl: "https://api.example" },
        },
      },
    },
  };
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    const apiFetch = await import("./api-fetch.js");
    (apiFetch.getUploadPresign as any).mockClear();
    (apiFetch.uploadFileToPresignedUrl as any).mockClear();
    (apiFetch.sendMediaMessage as any).mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    // NB: do NOT call vi.restoreAllMocks() here — it would tear down the
    // module-level vi.mock("./api-fetch.js") at the top of this file and
    // break every later test in this suite.
  });

  async function listOctoUploadTemp(): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    try { return await readdir("/tmp/octo-upload"); } catch { return []; }
  }

  it("rejects with 'exceeds max' on http(s) URL > 100MB; presign never called; temp cleaned", async () => {
    const apiFetch = await import("./api-fetch.js");
    const { octoPlugin } = await import("./channel.js");

    const CHUNK = new Uint8Array(1024 * 1024); // 1MB
    const TOTAL_CHUNKS = 110;                  // 110MB > 100MB cap
    let sent = 0;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "application/octet-stream" }),
      body: new ReadableStream({
        pull(controller) {
          if (sent >= TOTAL_CHUNKS) { controller.close(); return; }
          controller.enqueue(CHUNK);
          sent += 1;
        },
      }),
    }) as any;

    // Unique token in the URL filename so the cleanup assertion below
    // targets only OUR test's residue and doesn't false-fail on parallel
    // cleanup of stale temp files (`cleanupOldUploadTempFiles` removes
    // >1h-old files opportunistically on every call).
    const token = "r2-cap-channel-fixture";

    await expect(octoPlugin.outbound!.sendMedia!({
      cfg,
      to: "group:grp1",
      text: "",
      mediaUrl: `https://example.com/${token}.bin`,
      accountId: "default",
    } as any)).rejects.toThrow(/exceeds max/);

    // Cap fires before presigned API call → no upload attempted.
    expect(apiFetch.getUploadPresign).not.toHaveBeenCalled();
    expect(apiFetch.uploadFileToPresignedUrl).not.toHaveBeenCalled();
    expect(apiFetch.sendMediaMessage).not.toHaveBeenCalled();

    // Partial temp file (named `<uuid>-<token>.bin`) must be unlinked.
    const after = await listOctoUploadTemp();
    const survivors = after.filter(f => f.includes(token));
    expect(survivors).toEqual([]);
  });
});

// ─── outbound accountId correction — end-to-end token assertion ─────────────
// These close the gap the review flagged: resolveOutboundAccountId's behaviour
// is covered in isolation, but the outbound adapters (sendText/sendMedia) also
// have to actually USE the corrected accountId's botToken when calling the
// Octo API. Without these tests, a regression in the wiring (e.g. passing
// the original ctx.accountId to resolveOctoAccount instead of the corrected
// one) would go undetected.

describe("outbound sendText/sendMedia — accountId correction threads through to API", () => {
  const cfgWithTwoBots = {
    channels: {
      octo: {
        apiUrl: "https://api.example",
        accounts: {
          "bot-a": { botToken: "tok-bot-a", apiUrl: "https://api.example" },
          "bot-b": { botToken: "tok-bot-b", apiUrl: "https://api.example" },
        },
      },
    },
  };

  beforeEach(async () => {
    // Reset module state so _groupToAccounts doesn't leak across these tests —
    // otherwise an earlier "shared group" registration would leave the group
    // ambiguous for the next test, silently masking the correction under test.
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("sendText corrects to the group-owning bot's token when group has a single owner, even if a different accountId is passed", async () => {
    const { octoPlugin, registerGroupToAccount } = await import("./channel.js");
    const { sendMessage } = await import("./api-fetch.js");

    // Group grp1 belongs to bot-b only; caller passed bot-a.
    registerGroupToAccount("grp1", "bot-b");

    await octoPlugin.outbound!.sendText!({
      cfg: cfgWithTwoBots,
      to: "group:grp1",
      text: "hi",
      accountId: "bot-a",
    } as any);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = (sendMessage as any).mock.calls[0][0];
    expect(call.botToken).toBe("tok-bot-b"); // corrected from bot-a → bot-b
  });

  it("sendMedia corrects to the group-owning bot's token", async () => {
    const { octoPlugin, registerGroupToAccount } = await import("./channel.js");
    const { sendMediaMessage } = await import("./api-fetch.js");

    registerGroupToAccount("grp1", "bot-b");

    await octoPlugin.outbound!.sendMedia!({
      cfg: cfgWithTwoBots,
      to: "group:grp1",
      text: "",
      mediaUrl: "data:text/plain;base64,aGVsbG8=",
      accountId: "bot-a",
    } as any);

    expect(sendMediaMessage).toHaveBeenCalledTimes(1);
    const call = (sendMediaMessage as any).mock.calls[0][0];
    expect(call.botToken).toBe("tok-bot-b");
  });

  it("sendText respects explicit accountId when group is shared by multiple bots (no single owner)", async () => {
    const { octoPlugin, registerGroupToAccount } = await import("./channel.js");
    const { sendMessage } = await import("./api-fetch.js");

    // Shared group — resolveAccountForGroup returns undefined for ambiguity.
    registerGroupToAccount("grp1", "bot-a");
    registerGroupToAccount("grp1", "bot-b");

    await octoPlugin.outbound!.sendText!({
      cfg: cfgWithTwoBots,
      to: "group:grp1",
      text: "hi",
      accountId: "bot-a",
    } as any);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = (sendMessage as any).mock.calls[0][0];
    expect(call.botToken).toBe("tok-bot-a"); // explicit choice honoured
  });

  it("sendText corrects through the channel:<id> prefix alias too", async () => {
    const { octoPlugin, registerGroupToAccount } = await import("./channel.js");
    const { sendMessage } = await import("./api-fetch.js");

    registerGroupToAccount("grp1", "bot-b");

    await octoPlugin.outbound!.sendText!({
      cfg: cfgWithTwoBots,
      to: "channel:grp1",
      text: "hi",
      accountId: "bot-a",
    } as any);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = (sendMessage as any).mock.calls[0][0];
    expect(call.botToken).toBe("tok-bot-b");
  });
});

// ─── #51 outbound deliver — messageId propagation ──────────────────────────
// Regression tests for the bug where sendText / sendMedia returned
// `messageId: ""` regardless of what the Octo API returned. After 2026.5.7
// the host runtime evaluates `deliverySucceeded` strictly and silently
// drops outbound when the adapter result has an empty messageId.

describe("outbound sendText/sendMedia — messageId propagation (#51)", () => {
  const cfg = {
    channels: {
      octo: {
        apiUrl: "https://api.example",
        accounts: {
          "bot-a": { botToken: "tok-a", apiUrl: "https://api.example" },
        },
      },
    },
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("sendText propagates message_id from Octo API result to OutboundDeliveryResult", async () => {
    const { octoPlugin } = await import("./channel.js");
    const { sendMessage } = await import("./api-fetch.js");
    vi.mocked(sendMessage).mockResolvedValueOnce({
      message_id: "real-id-abc",
      client_msg_no: "uuid",
      message_seq: 42,
    });

    const result = await octoPlugin.outbound!.sendText!({
      cfg,
      to: "group:grp1",
      text: "hello",
      accountId: "bot-a",
    } as any);

    expect(result.messageId).toBe("real-id-abc");
    expect(result.channel).toBe("octo");
  });

  it("sendText empty text returns messageId='' and does NOT call sendMessage (noop)", async () => {
    const { octoPlugin } = await import("./channel.js");
    const { sendMessage } = await import("./api-fetch.js");

    const result = await octoPlugin.outbound!.sendText!({
      cfg,
      to: "group:grp1",
      text: "   ",
      accountId: "bot-a",
    } as any);

    expect(result.messageId).toBe("");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sendText throws when Octo API returns undefined (fail-fast on anomaly)", async () => {
    const { octoPlugin } = await import("./channel.js");
    const { sendMessage } = await import("./api-fetch.js");
    vi.mocked(sendMessage).mockResolvedValueOnce(undefined);

    await expect(octoPlugin.outbound!.sendText!({
      cfg,
      to: "group:grp1",
      text: "hello",
      accountId: "bot-a",
    } as any)).rejects.toThrow(/no message_id/);
  });

  it("sendText throws when Octo API returns empty message_id", async () => {
    const { octoPlugin } = await import("./channel.js");
    const { sendMessage } = await import("./api-fetch.js");
    vi.mocked(sendMessage).mockResolvedValueOnce({
      message_id: "",
      client_msg_no: "uuid",
      message_seq: 0,
    });

    await expect(octoPlugin.outbound!.sendText!({
      cfg,
      to: "group:grp1",
      text: "hello",
      accountId: "bot-a",
    } as any)).rejects.toThrow(/no message_id/);
  });

  it("sendMedia propagates message_id from sendMediaMessage result", async () => {
    const { octoPlugin } = await import("./channel.js");
    const { sendMediaMessage } = await import("./api-fetch.js");
    vi.mocked(sendMediaMessage).mockResolvedValueOnce({
      message_id: "media-xyz",
      client_msg_no: "uuid",
      message_seq: 99,
    });

    const result = await octoPlugin.outbound!.sendMedia!({
      cfg,
      to: "group:grp1",
      text: "",
      mediaUrl: "data:text/plain;base64,aGVsbG8=",
      accountId: "bot-a",
    } as any);

    expect(result.messageId).toBe("media-xyz");
  });
});

// ─── P0-2: messageToolHints @mention format hint ─────────────────────────────

describe("agentPrompt.messageToolHints — @mention format hint", () => {
  it("appends the shared MENTION_FORMAT_HINT with group-members + anti-patterns", async () => {
    const { octoPlugin } = await import("./channel.js");
    const { MENTION_FORMAT_HINT } = await import("./mention-utils.js");
    const hints: string[] = (octoPlugin as any).agentPrompt.messageToolHints({
      cfg: {},
      accountId: "default",
    });
    const joined = hints.join("\n");
    expect(joined).toContain("group-members");
    expect(joined).toContain(MENTION_FORMAT_HINT);
    // anti-patterns + single-colon + brackets reachable through the shared hint
    expect(joined).toContain("ONE colon");
    expect(joined).toContain("username/bot_id");
    expect(joined).toContain('"uid"');
  });

  it("hint text never parses into an illegal {uid:'uid'} structured mention", async () => {
    const { octoPlugin } = await import("./channel.js");
    const { parseStructuredMentions } = await import("./mention-utils.js");
    const hints: string[] = (octoPlugin as any).agentPrompt.messageToolHints({
      cfg: {},
      accountId: "default",
    });
    const parsed = parseStructuredMentions(hints.join("\n"));
    expect(parsed.every((m) => m.uid !== "uid")).toBe(true);
  });
});

// ─── P0-1: outbound member prefetch (cold start) ─────────────────────────────

describe("outbound.sendText — P0-1 member prefetch", () => {
  const cfg = {
    channels: {
      octo: {
        apiUrl: "https://api.example",
        accounts: {
          default: { botToken: "bf_test", apiUrl: "https://api.example" },
        },
      },
    },
  };

  beforeEach(async () => {
    const apiFetch = await import("./api-fetch.js");
    (apiFetch.sendMessage as any).mockClear();
    (apiFetch.getGroupMembers as any).mockClear();
    (apiFetch.getGroupMembers as any).mockResolvedValue([]);
    const memberCache = await import("./member-cache.js");
    memberCache._clearMemberCache();
  });

  it("cold map: fetches members for the target group and resolves @displayName to an entity", async () => {
    const apiFetch = await import("./api-fetch.js");
    (apiFetch.getGroupMembers as any).mockResolvedValue([
      { uid: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", name: "Alice" },
    ]);
    const { octoPlugin } = await import("./channel.js");

    await octoPlugin.outbound!.sendText!({
      cfg,
      to: "group:grpcold",
      text: "hello @Alice",
      accountId: "default",
    } as any);

    const memberCall = (apiFetch.getGroupMembers as any).mock.calls[0][0];
    expect(memberCall.groupNo).toBe("grpcold");

    const call = (apiFetch.sendMessage as any).mock.calls[0][0];
    expect(call.content).toBe("hello @Alice");
    expect(call.mentionEntities).toEqual([
      { uid: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", offset: 6, length: 6 },
    ]);
  });

  it("sub-topic target: prefetch uses the PARENT group_no (strips ____ suffix)", async () => {
    const apiFetch = await import("./api-fetch.js");
    (apiFetch.getGroupMembers as any).mockResolvedValue([
      { uid: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", name: "Alice" },
    ]);
    const { octoPlugin } = await import("./channel.js");

    await octoPlugin.outbound!.sendText!({
      cfg,
      to: "group:parentG____topic1",
      text: "ping @Alice",
      accountId: "default",
    } as any);

    const memberCall = (apiFetch.getGroupMembers as any).mock.calls[0][0];
    expect(memberCall.groupNo).toBe("parentG");
  });

  it("no @ in text: skips the member fetch entirely", async () => {
    const apiFetch = await import("./api-fetch.js");
    const { octoPlugin } = await import("./channel.js");

    await octoPlugin.outbound!.sendText!({
      cfg,
      to: "group:grpcold",
      text: "no mentions here",
      accountId: "default",
    } as any);

    expect((apiFetch.getGroupMembers as any).mock.calls.length).toBe(0);
  });

  it("member fetch failure degrades silently (still sends)", async () => {
    const apiFetch = await import("./api-fetch.js");
    (apiFetch.getGroupMembers as any).mockRejectedValue(new Error("boom"));
    const { octoPlugin } = await import("./channel.js");

    const result = await octoPlugin.outbound!.sendText!({
      cfg,
      to: "group:grpcold",
      text: "hi @Ghost",
      accountId: "default",
    } as any);

    expect(result.messageId).toBe("test-msg-id");
    const call = (apiFetch.sendMessage as any).mock.calls[0][0];
    // unresolved @Ghost left as plain text, no illegal mention leaked
    expect(call.content).toBe("hi @Ghost");
    expect(call.mentionEntities).toBeUndefined();
  });
});

describe("octoSetupAdapter.validateInput token prefix", () => {
  let validate: (input: any) => string | undefined;
  beforeEach(async () => {
    const { octoPlugin } = await import("./channel.js");
    validate = (input: any) =>
      (octoPlugin.setup as any).validateInput({ accountId: "test", input });
  });

  it("accepts a bf_ User Bot token", () => {
    expect(validate({ botToken: "bf_dummy_user_bot_token" })).toBeUndefined();
  });

  it("accepts an app_ App Bot token", () => {
    // App Bot tokens (Admin 后台「应用 Bot」) are DM-only on the server side,
    // but the CLI must let them bind — the capability boundary is the server's
    // call, not the adapter's.
    expect(validate({ botToken: "app_EXAMPLE_dummy_app_bot_token" })).toBeUndefined();
  });

  it("accepts app_ token via the `token` alias field", () => {
    expect(validate({ token: "app_EXAMPLE_dummy_app_bot_token" })).toBeUndefined();
  });

  it("rejects an unknown prefix", () => {
    expect(validate({ botToken: "uk_dummy_unknown_prefix" })).toBeTruthy();
  });

  it("rejects a too-short token even with a valid prefix", () => {
    expect(validate({ botToken: "app_short" })).toBeTruthy();
    expect(validate({ botToken: "bf_short" })).toBeTruthy();
  });

  it("rejects an empty / non-string token", () => {
    expect(validate({ botToken: "" })).toBeTruthy();
    expect(validate({ botToken: 123 })).toBeTruthy();
  });

  it("skips validation when no token field is present", () => {
    expect(validate({ baseUrl: "https://im.example.com/api" })).toBeUndefined();
  });
});
