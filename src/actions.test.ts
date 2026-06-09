import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType } from "./types.js";
import { registerOwnerUid, _clearOwnerRegistry } from "./owner-registry.js";
import { _clearMemberCache, _setCacheEntry } from "./member-cache.js";
import { registerBotGroupIds, _testReset as _resetGroupMd } from "./group-md.js";

// Mock uploadAndSendMedia / uploadMedia — the streaming COS upload uses its own
// SDK internals that can't be tested via fetch mocks alone. Upload logic is
// tested in inbound.test.ts. resolveRichTextContent is a pure resolver, kept real.
vi.mock("./inbound.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./inbound.js")>();
  return {
    ...actual,
    uploadAndSendMedia: vi.fn().mockResolvedValue(undefined),
    uploadMedia: vi.fn().mockResolvedValue({
      url: "https://cdn.example.com/uploaded.png",
      filename: "uploaded.png",
      size: 1234,
      contentType: "image/png",
      isImage: true,
      width: 100,
      height: 80,
    }),
  };
});

/**
 * Tests for message action handlers.
 * All API calls are mocked via global.fetch.
 */

const originalFetch = globalThis.fetch;

// Helper to create a mock fetch that routes based on URL/method
function mockFetch(handlers: Record<string, (url: string, init?: RequestInit) => Promise<Response>>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) {
        return handler(url, init);
      }
    }
    return new Response("Not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("handleOctoMessageAction", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _clearOwnerRegistry();
    _clearMemberCache();
    _resetGroupMd();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _clearOwnerRegistry();
    _clearMemberCache();
    _resetGroupMd();
  });

  // -----------------------------------------------------------------------
  // send action
  // -----------------------------------------------------------------------
  describe("send — text to group", () => {
    it("should send text to a group target", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "group:chan123", message: "Hello group" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(sentPayload.channel_id).toBe("chan123");
      expect(sentPayload.channel_type).toBe(ChannelType.Group);
      expect(sentPayload.payload.content).toBe("Hello group");
    });
  });

  describe("send — text to user (DM)", () => {
    it("should send text to a user target", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "user:uid456", message: "Hello user" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(sentPayload.channel_id).toBe("uid456");
      expect(sentPayload.channel_type).toBe(ChannelType.DM);
    });
  });

  // -----------------------------------------------------------------------
  // #51 — messageId / mediaMessageIds propagation in toolResult.data
  //   When Octo API returns SendMessageResult, the handler must surface
  //   message_id back to the LLM via toolResult.data so the agent can
  //   reference the sent message for downstream edit/pin/delete.
  // -----------------------------------------------------------------------
  describe("send — messageId / mediaMessageIds propagation (#51)", () => {
    it("toolResult.data.messageId comes from Octo API send response", async () => {
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async () =>
          jsonResponse({ message_id: "2061639302604820480", client_msg_no: "uuid", message_seq: 7 }),
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "group:chan123", message: "hello" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect((result.data as any).messageId).toBe("2061639302604820480");
    });

    it("toolResult.data.mediaMessageIds comes from uploadAndSendMedia results", async () => {
      const { uploadAndSendMedia } = await import("./inbound.js");
      vi.mocked(uploadAndSendMedia).mockResolvedValueOnce({
        message_id: "media-1-id",
        client_msg_no: "uuid",
        message_seq: 10,
      });
      vi.mocked(uploadAndSendMedia).mockResolvedValueOnce({
        message_id: "media-2-id",
        client_msg_no: "uuid",
        message_seq: 11,
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: {
          target: "group:chan123",
          // No text — pure media send so we observe mediaMessageIds in isolation.
          attachments: [
            { url: "https://example.com/a.png" },
            { url: "https://example.com/b.png" },
          ],
        },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect((result.data as any).mediaMessageIds).toEqual(["media-1-id", "media-2-id"]);
      expect((result.data as any).mediaCount).toBe(2);
    });
  });

  describe("send — bare target defaults to DM", () => {
    it("should default to DM when no prefix", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "some_uid", message: "Hello" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(sentPayload.channel_type).toBe(ChannelType.DM);
      expect(sentPayload.channel_id).toBe("some_uid");
    });
  });

  describe("send — @mentions resolved from memberMap", () => {
    it("should resolve @mentions to UIDs via memberMap", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const memberMap = new Map([
        ["陈皮皮", "uid_chen"],
        ["bob", "uid_bob"],
      ]);

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "Hello @陈皮皮 and @bob!" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        memberMap,
      });

      expect(result.ok).toBe(true);
      expect(sentPayload.payload.mention.uids).toEqual(["uid_chen", "uid_bob"]);
    });
  });

  // -----------------------------------------------------------------------
  // send — v2 structured mentions (@[uid:name])
  // -----------------------------------------------------------------------
  describe("send — v2 structured mentions converted to @name + entities", () => {
    it("should convert @[uid:name] to @name with correct entities", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const uidToNameMap = new Map([
        ["uid_chen", "陈皮皮"],
        ["uid_bob", "bob"],
      ]);

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "Hello @[uid_chen:陈皮皮] and @[uid_bob:bob]!" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        uidToNameMap,
      });

      expect(result.ok).toBe(true);
      // Content should have @name format (not @[uid:name])
      expect(sentPayload.payload.content).toBe("Hello @陈皮皮 and @bob!");
      // Entities should have correct offset/length/uid
      const entities = sentPayload.payload.mention.entities;
      expect(entities).toHaveLength(2);
      expect(entities[0]).toMatchObject({ uid: "uid_chen", offset: 6, length: 4 });
      expect(entities[1]).toMatchObject({ uid: "uid_bob", offset: 15, length: 4 });
      // UIDs should be present
      expect(sentPayload.payload.mention.uids).toEqual(["uid_chen", "uid_bob"]);
    });
  });

  describe("send — @all detection", () => {
    it("should set mentionAll when @all is present", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "Attention @all please read" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(sentPayload.payload.mention.all).toBe(1);
    });
  });

  describe("send — @所有人 detection", () => {
    it("should set mentionAll when @所有人 is present", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "大家注意 @所有人 请查收" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(sentPayload.payload.mention.all).toBe(1);
    });
  });

  describe("send — mixed v1+v2 mentions", () => {
    it("should resolve both @[uid:name] and @name in same message", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const memberMap = new Map([["alice", "uid_alice"]]);
      const uidToNameMap = new Map([
        ["uid_chen", "陈皮皮"],
        ["uid_alice", "alice"],
      ]);

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "Hey @[uid_chen:陈皮皮] and @alice!" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        memberMap,
        uidToNameMap,
      });

      expect(result.ok).toBe(true);
      // Content should have both converted
      expect(sentPayload.payload.content).toBe("Hey @陈皮皮 and @alice!");
      const entities = sentPayload.payload.mention.entities;
      expect(entities).toHaveLength(2);
      // First entity from v2 conversion
      expect(entities[0]).toMatchObject({ uid: "uid_chen", offset: 4, length: 4 });
      // Second entity from v1 fallback
      expect(entities[1]).toMatchObject({ uid: "uid_alice", offset: 13, length: 6 });
    });
  });

  describe("send — v2 without uidToNameMap graceful fallback", () => {
    it("should leave @[uid:name] unchanged when uidToNameMap is not provided", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "Hello @[uid_chen:陈皮皮]!" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        // no uidToNameMap provided
      });

      expect(result.ok).toBe(true);
      // Content should be unchanged — no conversion without uidToNameMap
      expect(sentPayload.payload.content).toBe("Hello @[uid_chen:陈皮皮]!");
    });
  });

  describe("send — invalid uid in v2 (uid not in uidToNameMap)", () => {
    it("drops non-hex unknown uids via the outbound guard, keeps known ones", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const uidToNameMap = new Map([
        ["uid_bob", "bob"],
      ]);
      // uid_unknown is NOT in uidToNameMap and is not a 32-hex / space-prefixed
      // uid, so the P0-3 outbound guard strips it (server would reject it
      // anyway). uid_bob is in the map → kept.

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "Hello @[uid_unknown:Ghost] and @[uid_bob:bob]!" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        uidToNameMap,
      });

      expect(result.ok).toBe(true);
      // Format is still converted for both (text is human-readable @name)
      expect(sentPayload.payload.content).toBe("Hello @Ghost and @bob!");
      // Only the valid (in-map) uid survives the outbound guard.
      const entities = sentPayload.payload.mention.entities;
      expect(entities).toHaveLength(1);
      expect(entities[0]).toMatchObject({ uid: "uid_bob" });
    });
  });

  describe("send — unresolvable @mentions still sends", () => {
    it("should send without mentionUids when names are unresolvable", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const memberMap = new Map<string, string>(); // empty

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "Hello @unknown_user" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        memberMap,
      });

      expect(result.ok).toBe(true);
      // No mention field when UIDs can't be resolved
      expect(sentPayload.payload.mention).toBeUndefined();
    });
  });

  describe("send — P0-3 outbound sanitizer", () => {
    const HEX_A = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

    it("bracketless @uid:name (valid uid) → @displayName + entity, no raw uid:name leaked", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const uidToNameMap = new Map([[HEX_A, "Alice"]]);
      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "group:grp1", message: `Hi @${HEX_A}:Alice!` },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        uidToNameMap,
      });

      expect(result.ok).toBe(true);
      expect(sentPayload.payload.content).toBe("Hi @Alice!");
      expect(sentPayload.payload.content).not.toContain(`${HEX_A}:`);
      expect(sentPayload.payload.mention.entities).toEqual([
        { uid: HEX_A, offset: 3, length: 6 },
      ]);
    });

    it("bracketless @uid:name (token not uid-shaped) → left untouched, no mention", async () => {
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const uidToNameMap = new Map([[HEX_A, "Alice"]]);
      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "Hi @uid:Alice!" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        uidToNameMap,
      });

      expect(result.ok).toBe(true);
      // "uid" is not uid-shaped (not 32-hex, not in map, not a real
      // space-prefix), so the sanitizer leaves the ambiguous text intact —
      // the hard guarantee is only that no illegal mention is emitted.
      expect(sentPayload.payload.content).toBe("Hi @uid:Alice!");
      expect(sentPayload.payload.mention).toBeUndefined();
    });
  });

  describe("send — P0-1 sub-topic parent group prefetch", () => {
    const HEX_A = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

    it("fetches members from the PARENT group_no for a sub-topic target", async () => {
      let memberGroupNo: string | null = null;
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/members": async (url) => {
          // /v1/bot/groups/<groupNo>/members
          const m = url.match(/\/groups\/([^/]+)\/members/);
          memberGroupNo = m ? m[1] : null;
          return jsonResponse([{ uid: HEX_A, name: "Alice" }]);
        },
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const memberMap = new Map<string, string>();
      const uidToNameMap = new Map<string, string>();
      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "group:parentG____topic1", message: "ping @Alice" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        memberMap,
        uidToNameMap,
      });

      expect(result.ok).toBe(true);
      expect(memberGroupNo).toBe("parentG");
      // prefetched member resolved @Alice into an entity
      expect(sentPayload.payload.content).toBe("ping @Alice");
      expect(sentPayload.payload.mention.entities[0]).toMatchObject({ uid: HEX_A });
    });
  });

  describe("send — media only (no text)", () => {
    it("should upload and send media without text", async () => {
      const { uploadAndSendMedia } = await import("./inbound.js");
      const uploadSpy = vi.mocked(uploadAndSendMedia);
      uploadSpy.mockClear();

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "user:uid1", mediaUrl: "https://example.com/image.png" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(uploadSpy).toHaveBeenCalledOnce();
      expect(uploadSpy.mock.calls[0][0]).toMatchObject({
        mediaUrl: "https://example.com/image.png",
        channelId: "uid1",
      });
    });
  });

  describe("send — media + text", () => {
    it("should send both text and media", async () => {
      let textSent = false;

      const { uploadAndSendMedia } = await import("./inbound.js");
      const uploadSpy = vi.mocked(uploadAndSendMedia);
      uploadSpy.mockClear();

      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          const body = JSON.parse(init?.body as string);
          if (body.payload?.content) textSent = true;
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: {
          target: "group:grp1",
          message: "Check this file",
          media: "https://example.com/doc.pdf",
        },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(textSent).toBe(true);
      expect(uploadSpy).toHaveBeenCalledOnce();
    });
  });

  describe("send — missing target", () => {
    it("should return error when target is missing", async () => {
      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { message: "Hello" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("target");
    });
  });

  describe("send — missing message and media", () => {
    it("should return error when both message and media are missing", async () => {
      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "user:uid1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("message");
    });
  });

  // Foot-gun UX guard (#232 review): when the agent explicitly passes a bare
  // parent-group target while the session's currentChannelId is inside a
  // thread, log a warning. This doesn't reroute and doesn't reject (the
  // parent-group reply may be intentional), it just surfaces the ambiguity
  // so operators can notice model misuse.

  describe("send — thread-context foot-gun warning", () => {
    it("warns (via log.warn) when target is the thread's parent group", async () => {
      registerBotGroupIds(["grp1"]);
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async () => jsonResponse({ message_id: 1, message_seq: 1 }),
      });
      const logWarn = vi.fn();
      const logInfo = vi.fn();
      const { handleOctoMessageAction } = await import("./actions.js");
      await handleOctoMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "hi" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "grp1____topicA",
        log: { warn: logWarn, info: logInfo } as any,
      });
      expect(logWarn).toHaveBeenCalledTimes(1);
      expect(logInfo).not.toHaveBeenCalled();
      const msg = logWarn.mock.calls[0][0] as string;
      expect(msg).toContain("target=\"group:grp1\"");
      expect(msg).toContain("grp1____topicA");
    });

    it("falls back to log.info when log.warn is not provided", async () => {
      registerBotGroupIds(["grp1"]);
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async () => jsonResponse({ message_id: 1, message_seq: 1 }),
      });
      const logInfo = vi.fn();
      const { handleOctoMessageAction } = await import("./actions.js");
      await handleOctoMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "hi" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "grp1____topicA",
        log: { info: logInfo } as any, // no .warn
      });
      expect(logInfo).toHaveBeenCalledTimes(1);
    });

    it("does NOT warn when target is a DIFFERENT group (legitimate cross-channel send)", async () => {
      registerBotGroupIds(["grp1", "otherGroup"]);
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async () => jsonResponse({ message_id: 1, message_seq: 1 }),
      });
      const logWarn = vi.fn();
      const logInfo = vi.fn();
      const { handleOctoMessageAction } = await import("./actions.js");
      await handleOctoMessageAction({
        action: "send",
        args: { target: "group:otherGroup", message: "hi" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "grp1____topicA", // in thread of grp1, but sending to otherGroup
        log: { warn: logWarn, info: logInfo } as any,
      });
      expect(logWarn).not.toHaveBeenCalled();
      expect(logInfo).not.toHaveBeenCalled();
    });

    it("does NOT warn when target already carries the thread short id", async () => {
      registerBotGroupIds(["grp1"]);
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async () => jsonResponse({ message_id: 1, message_seq: 1 }),
      });
      const logWarn = vi.fn();
      const { handleOctoMessageAction } = await import("./actions.js");
      await handleOctoMessageAction({
        action: "send",
        args: { target: "group:grp1____topicA", message: "hi" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "grp1____topicA",
        log: { warn: logWarn } as any,
      });
      expect(logWarn).not.toHaveBeenCalled();
    });

    it("does NOT warn when session is NOT in a thread (plain group chat)", async () => {
      registerBotGroupIds(["grp1"]);
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async () => jsonResponse({ message_id: 1, message_seq: 1 }),
      });
      const logWarn = vi.fn();
      const { handleOctoMessageAction } = await import("./actions.js");
      await handleOctoMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "hi" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "grp1",
        log: { warn: logWarn } as any,
      });
      expect(logWarn).not.toHaveBeenCalled();
    });

    it("still sends the message when the warning fires (warn, not reject)", async () => {
      registerBotGroupIds(["grp1"]);
      let sent = false;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async () => {
          sent = true;
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });
      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "hi" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "grp1____topicA",
        log: { warn: vi.fn() } as any,
      });
      expect(sent).toBe(true);
      expect(result.ok).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // send — threadId routing via resolveOutboundOctoTarget
  // -----------------------------------------------------------------------
  describe("send — threadId routing", () => {
    it("routes to CommunityTopic when threadId is provided", async () => {
      registerBotGroupIds(["grp1"]);
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "thread msg" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        threadId: "topicA",
      });

      expect(result.ok).toBe(true);
      expect(sentPayload.channel_id).toBe("grp1____topicA");
      expect(sentPayload.channel_type).toBe(ChannelType.CommunityTopic);
    });

    it("routes to parent group when threadId is absent", async () => {
      registerBotGroupIds(["grp1"]);
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "parent msg" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(sentPayload.channel_id).toBe("grp1");
      expect(sentPayload.channel_type).toBe(ChannelType.Group);
    });

    it("does NOT trigger parent-group warning when threadId is provided", async () => {
      registerBotGroupIds(["grp1"]);
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async () => jsonResponse({ message_id: 1, message_seq: 1 }),
      });
      const logWarn = vi.fn();
      const logInfo = vi.fn();

      const { handleOctoMessageAction } = await import("./actions.js");
      await handleOctoMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "hi from thread" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "grp1____topicA",
        threadId: "topicA",
        log: { warn: logWarn, info: logInfo } as any,
      });

      expect(logWarn).not.toHaveBeenCalled();
      expect(logInfo).not.toHaveBeenCalled();
    });

    it("routes media-only message to CommunityTopic when threadId is provided", async () => {
      registerBotGroupIds(["grp1"]);
      const { uploadAndSendMedia } = await import("./inbound.js");
      const uploadSpy = vi.mocked(uploadAndSendMedia);
      uploadSpy.mockClear();

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "group:grp1", mediaUrl: "https://example.com/file.png" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        threadId: "topicA",
      });

      expect(result.ok).toBe(true);
      expect(uploadSpy).toHaveBeenCalledOnce();
      expect(uploadSpy.mock.calls[0][0]).toMatchObject({
        channelId: "grp1____topicA",
        channelType: ChannelType.CommunityTopic,
      });
    });

    it("does NOT inject ambient threadId when target is a different group", async () => {
      registerBotGroupIds(["grp1", "otherGroup"]);
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "group:otherGroup", message: "cross-group msg" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "grp1____topicA",
        threadId: "topicA",
      });

      expect(result.ok).toBe(true);
      expect(sentPayload.channel_id).toBe("otherGroup");
      expect(sentPayload.channel_type).toBe(ChannelType.Group);
    });

    it("merges threadId when target matches same parent group", async () => {
      registerBotGroupIds(["grp1"]);
      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "group:grp1", message: "same-group msg" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "grp1____topicA",
        threadId: "topicA",
      });

      expect(result.ok).toBe(true);
      expect(sentPayload.channel_id).toBe("grp1____topicA");
      expect(sentPayload.channel_type).toBe(ChannelType.CommunityTopic);
    });
  });

  // -----------------------------------------------------------------------
  // send — multi-attachment support
  // -----------------------------------------------------------------------
  describe("send — multiple attachments via mediaUrls array", () => {
    it("should call uploadAndSendMedia for each URL in mediaUrls", async () => {
      const { uploadAndSendMedia } = await import("./inbound.js");
      const uploadSpy = vi.mocked(uploadAndSendMedia);
      uploadSpy.mockClear();

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: {
          target: "user:uid1",
          mediaUrls: [
            "https://example.com/a.png",
            "https://example.com/b.pdf",
            "https://example.com/c.jpg",
          ],
        },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(uploadSpy).toHaveBeenCalledTimes(3);
      expect(uploadSpy.mock.calls[0][0]).toMatchObject({ mediaUrl: "https://example.com/a.png" });
      expect(uploadSpy.mock.calls[1][0]).toMatchObject({ mediaUrl: "https://example.com/b.pdf" });
      expect(uploadSpy.mock.calls[2][0]).toMatchObject({ mediaUrl: "https://example.com/c.jpg" });
      expect((result as any).data.mediaCount).toBe(3);
    });
  });

  describe("send — attachments as object array", () => {
    it("should extract URLs from attachment objects with various key names", async () => {
      const { uploadAndSendMedia } = await import("./inbound.js");
      const uploadSpy = vi.mocked(uploadAndSendMedia);
      uploadSpy.mockClear();

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: {
          target: "group:grp1",
          attachments: [
            { media: "https://example.com/via-media.png" },
            { mediaUrl: "https://example.com/via-mediaUrl.png" },
            { path: "https://example.com/via-path.png" },
            { filePath: "https://example.com/via-filePath.png" },
            { fileUrl: "https://example.com/via-fileUrl.png" },
            { url: "https://example.com/via-url.png" },
          ],
        },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(uploadSpy).toHaveBeenCalledTimes(6);
      expect(uploadSpy.mock.calls[0][0].mediaUrl).toBe("https://example.com/via-media.png");
      expect(uploadSpy.mock.calls[5][0].mediaUrl).toBe("https://example.com/via-url.png");
    });
  });

  describe("send — attachments as string array", () => {
    it("should handle string[] attachments", async () => {
      const { uploadAndSendMedia } = await import("./inbound.js");
      const uploadSpy = vi.mocked(uploadAndSendMedia);
      uploadSpy.mockClear();

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: {
          target: "user:uid1",
          attachments: [
            "https://example.com/str1.png",
            "https://example.com/str2.png",
          ],
        },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(uploadSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("send — deduplicates media URLs", () => {
    it("should not send the same URL twice", async () => {
      const { uploadAndSendMedia } = await import("./inbound.js");
      const uploadSpy = vi.mocked(uploadAndSendMedia);
      uploadSpy.mockClear();

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: {
          target: "user:uid1",
          mediaUrl: "https://example.com/dup.png",
          attachments: ["https://example.com/dup.png"],
        },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(uploadSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("send — single mediaUrl backward compatibility", () => {
    it("should still work with a single mediaUrl string", async () => {
      const { uploadAndSendMedia } = await import("./inbound.js");
      const uploadSpy = vi.mocked(uploadAndSendMedia);
      uploadSpy.mockClear();

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "user:uid1", mediaUrl: "https://example.com/single.png" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(uploadSpy).toHaveBeenCalledOnce();
      expect(uploadSpy.mock.calls[0][0].mediaUrl).toBe("https://example.com/single.png");
      expect((result as any).data.mediaCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // RichText(=14) 图文混排 outbound — single payload assembly (opt-in)
  // -----------------------------------------------------------------------
  describe("send — RichText 图文混排 (richText:true)", () => {
    it("assembles ONE RichText payload for text + image instead of split sends", async () => {
      const { uploadMedia, uploadAndSendMedia } = await import("./inbound.js");
      const uploadMediaSpy = vi.mocked(uploadMedia);
      const uploadSendSpy = vi.mocked(uploadAndSendMedia);
      uploadMediaSpy.mockClear();
      uploadSendSpy.mockClear();
      uploadMediaSpy.mockResolvedValue({
        url: "https://cdn.example.com/u.png",
        filename: "u.png",
        size: 1234,
        contentType: "image/png",
        isImage: true,
        width: 100,
        height: 80,
      });

      let sentPayload: any = null;
      let sendCount = 0;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sendCount += 1;
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: "rt-1", message_seq: 1 });
        },
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: {
          target: "group:grp1",
          message: "look here",
          mediaUrl: "https://example.com/pic.png",
          richText: true,
        },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      // ONE HTTP send (RichText), NOT text + media split.
      expect(sendCount).toBe(1);
      expect(uploadSendSpy).not.toHaveBeenCalled();
      expect(uploadMediaSpy).toHaveBeenCalledOnce();

      expect(sentPayload.payload.type).toBe(14);
      expect(sentPayload.payload.content[0]).toEqual({ type: "text", text: "look here" });
      expect(sentPayload.payload.content[1].type).toBe("image");
      expect(sentPayload.payload.content[1].url).toBe("https://cdn.example.com/u.png");
      expect(sentPayload.payload.content[1].width).toBe(100);
      expect(sentPayload.client_msg_no).toBeTruthy();

      expect((result.data as any).richText).toBe(true);
      expect((result.data as any).messageId).toBe("rt-1");
      expect((result.data as any).mediaCount).toBe(1);
    });

    it("batch-uploads multiple images into one ordered content array", async () => {
      const { uploadMedia } = await import("./inbound.js");
      const uploadMediaSpy = vi.mocked(uploadMedia);
      uploadMediaSpy.mockClear();
      uploadMediaSpy
        .mockResolvedValueOnce({ url: "https://cdn.example.com/1.png", filename: "1.png", size: 1, contentType: "image/png", isImage: true, width: 10, height: 10 })
        .mockResolvedValueOnce({ url: "https://cdn.example.com/2.png", filename: "2.png", size: 2, contentType: "image/png", isImage: true, width: 20, height: 20 });

      let sentPayload: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          sentPayload = JSON.parse(init?.body as string);
          return jsonResponse({ message_id: "rt-2", message_seq: 1 });
        },
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: {
          target: "group:grp1",
          message: "two pics",
          mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
          richText: true,
        },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(uploadMediaSpy).toHaveBeenCalledTimes(2);
      const content = sentPayload.payload.content;
      expect(content).toHaveLength(3);
      expect(content[0]).toEqual({ type: "text", text: "two pics" });
      expect(content[1].url).toBe("https://cdn.example.com/1.png");
      expect(content[2].url).toBe("https://cdn.example.com/2.png");
      expect((result.data as any).mediaCount).toBe(2);
    });

    it("file-only richText:true delivers text + sideload without re-upload or orphaned objects", async () => {
      const { uploadMedia, uploadAndSendMedia } = await import("./inbound.js");
      const uploadMediaSpy = vi.mocked(uploadMedia);
      const uploadSendSpy = vi.mocked(uploadAndSendMedia);
      uploadMediaSpy.mockClear();
      uploadSendSpy.mockClear();
      // Non-image (PDF) → no image block → text + sideload (no re-upload).
      uploadMediaSpy.mockResolvedValue({
        url: "https://cdn.example.com/doc.pdf",
        filename: "doc.pdf",
        size: 10,
        contentType: "application/pdf",
        isImage: false,
      });

      let textSent = false;
      let fileSent = false;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          const body = JSON.parse(init?.body as string);
          if (body.payload?.type === 1 && body.payload?.content) textSent = true;
          if (body.payload?.type === 8) fileSent = true;
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: {
          target: "group:grp1",
          message: "see attached",
          mediaUrl: "https://example.com/doc.pdf",
          richText: true,
        },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(textSent).toBe(true);
      expect(fileSent).toBe(true); // PDF via sendMediaMessage (reused upload)
      expect(uploadMediaSpy).toHaveBeenCalledOnce(); // uploaded exactly once
      expect(uploadSendSpy).not.toHaveBeenCalled(); // no re-upload via legacy path
      expect((result.data as any).richText).toBeUndefined(); // no type-14 sent
    });

    it("does NOT use RichText path without opt-in (backward compatible default)", async () => {
      const { uploadMedia, uploadAndSendMedia } = await import("./inbound.js");
      const uploadMediaSpy = vi.mocked(uploadMedia);
      const uploadSendSpy = vi.mocked(uploadAndSendMedia);
      uploadMediaSpy.mockClear();
      uploadSendSpy.mockClear();
      uploadSendSpy.mockResolvedValue(undefined);

      let textSent = false;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          const body = JSON.parse(init?.body as string);
          if (body.payload?.content) textSent = true;
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: {
          target: "group:grp1",
          message: "default split",
          mediaUrl: "https://example.com/pic.png",
        },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      // Legacy default: separate text send + uploadAndSendMedia, no RichText.
      expect(textSent).toBe(true);
      expect(uploadSendSpy).toHaveBeenCalledOnce();
      expect(uploadMediaSpy).not.toHaveBeenCalled();
      expect((result.data as any).richText).toBeUndefined();
    });

    it("delivers non-image files alongside images via sideload send (no re-upload)", async () => {
      const { uploadMedia, uploadAndSendMedia } = await import("./inbound.js");
      const uploadMediaSpy = vi.mocked(uploadMedia);
      const uploadSendSpy = vi.mocked(uploadAndSendMedia);
      uploadMediaSpy.mockClear();
      uploadSendSpy.mockClear();
      uploadMediaSpy
        .mockResolvedValueOnce({ url: "https://cdn.example.com/i.png", filename: "i.png", size: 1, contentType: "image/png", isImage: true, width: 5, height: 5 })
        .mockResolvedValueOnce({ url: "https://cdn.example.com/d.pdf", filename: "d.pdf", size: 2, contentType: "application/pdf", isImage: false });

      let richSends = 0;
      let fileSends = 0;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          const body = JSON.parse(init?.body as string);
          if (body.payload?.type === 14) richSends += 1;
          if (body.payload?.type === 8) fileSends += 1;
          return jsonResponse({ message_id: "rt-3", message_seq: 1 });
        },
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: {
          target: "group:grp1",
          message: "mixed",
          mediaUrls: ["https://example.com/i.png", "https://example.com/d.pdf"],
          richText: true,
        },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(richSends).toBe(1); // one RichText send for text+image
      expect(fileSends).toBe(1); // the PDF delivered via sendMediaMessage (already uploaded)
      expect(uploadMediaSpy).toHaveBeenCalledTimes(2); // uploaded once each, not re-uploaded
      expect(uploadSendSpy).not.toHaveBeenCalled();
      expect((result.data as any).mediaCount).toBe(2);
    });

    it("routes dimensionless images (e.g. SVG) to sideload, not RichText image block", async () => {
      const { uploadMedia } = await import("./inbound.js");
      const uploadMediaSpy = vi.mocked(uploadMedia);
      uploadMediaSpy.mockClear();
      uploadMediaSpy
        .mockResolvedValueOnce({ url: "https://cdn.example.com/ok.png", filename: "ok.png", size: 1, contentType: "image/png", isImage: true, width: 5, height: 5 })
        // image but dimensions failed to parse → must NOT become an image block
        .mockResolvedValueOnce({ url: "https://cdn.example.com/vec.svg", filename: "vec.svg", size: 2, contentType: "image/svg+xml", isImage: true });

      let richPayload: any = null;
      let imageSideloads = 0;
      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          const body = JSON.parse(init?.body as string);
          if (body.payload?.type === 14) richPayload = body.payload;
          if (body.payload?.type === 2) imageSideloads += 1;
          return jsonResponse({ message_id: "rt-4", message_seq: 1 });
        },
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: {
          target: "group:grp1",
          message: "svg+png",
          mediaUrls: ["https://example.com/ok.png", "https://example.com/vec.svg"],
          richText: true,
        },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      // RichText has exactly one image block (the dimensioned PNG); the SVG is sideloaded.
      expect(richPayload.content.filter((b: any) => b.type === "image")).toHaveLength(1);
      expect(richPayload.content.find((b: any) => b.type === "image").url).toBe("https://cdn.example.com/ok.png");
      expect(imageSideloads).toBe(1); // SVG via sendMediaMessage type=2
      expect((result.data as any).mediaCount).toBe(2);
    });
  });

  describe("send — multi-attachment with text", () => {
    it("should send text once and upload each attachment", async () => {
      let textSent = false;
      const { uploadAndSendMedia } = await import("./inbound.js");
      const uploadSpy = vi.mocked(uploadAndSendMedia);
      uploadSpy.mockClear();

      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async (_url, init) => {
          const body = JSON.parse(init?.body as string);
          if (body.payload?.content) textSent = true;
          return jsonResponse({ message_id: 1, message_seq: 1 });
        },
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: {
          target: "group:grp1",
          message: "Here are the files",
          mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
        },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(textSent).toBe(true);
      expect(uploadSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("send — partial upload failure isolation", () => {
    it("should continue sending remaining attachments when one fails", async () => {
      const { uploadAndSendMedia } = await import("./inbound.js");
      const uploadSpy = vi.mocked(uploadAndSendMedia);
      uploadSpy.mockClear();
      uploadSpy
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("upload timeout"))
        .mockResolvedValueOnce(undefined);

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: {
          target: "user:uid1",
          mediaUrls: [
            "https://example.com/a.png",
            "https://example.com/b.png",
            "https://example.com/c.png",
          ],
        },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(uploadSpy).toHaveBeenCalledTimes(3);
      const data = result.data as any;
      expect(data.mediaCount).toBe(2);
      expect(data.failedMedia).toHaveLength(1);
      expect(data.failedMedia[0].url).toBe("https://example.com/b.png");
    });

    it("should return ok:false when all uploads fail and no text message", async () => {
      const { uploadAndSendMedia } = await import("./inbound.js");
      const uploadSpy = vi.mocked(uploadAndSendMedia);
      uploadSpy.mockClear();
      uploadSpy.mockRejectedValue(new Error("network error"));

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: {
          target: "user:uid1",
          mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
        },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("All 2 media upload(s) failed");
    });

    it("should return ok:true when all uploads fail but text message was sent", async () => {
      const { uploadAndSendMedia } = await import("./inbound.js");
      const uploadSpy = vi.mocked(uploadAndSendMedia);
      uploadSpy.mockClear();
      uploadSpy.mockRejectedValue(new Error("network error"));

      globalThis.fetch = mockFetch({
        "/v1/bot/sendMessage": async () => jsonResponse({ message_id: 1, message_seq: 1 }),
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: {
          target: "user:uid1",
          message: "Here are files",
          mediaUrls: ["https://example.com/a.png"],
        },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.mediaCount).toBe(0);
      expect(data.failedMedia).toHaveLength(1);
    });
  });

  describe("send — edge cases for media URL resolution", () => {
    it("should return error when mediaUrls is empty array and no message", async () => {
      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "user:uid1", mediaUrls: [] },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("message");
    });

    it("should return error when attachments have no recognizable URL keys and no message", async () => {
      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: {
          target: "user:uid1",
          attachments: [{ unknownKey: "foo" }, { anotherKey: "bar" }],
        },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("message");
    });

    it("should skip falsy values in attachments", async () => {
      const { uploadAndSendMedia } = await import("./inbound.js");
      const uploadSpy = vi.mocked(uploadAndSendMedia);
      uploadSpy.mockClear();

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: {
          target: "user:uid1",
          attachments: [
            { url: "" },
            { url: null },
            { url: "https://example.com/valid.png" },
          ],
        },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(uploadSpy).toHaveBeenCalledOnce();
      expect(uploadSpy.mock.calls[0][0].mediaUrl).toBe("https://example.com/valid.png");
    });
  });

  describe("send — three-source merge (attachments + mediaUrls + mediaUrl)", () => {
    it("should send media from all three sources", async () => {
      const { uploadAndSendMedia } = await import("./inbound.js");
      const uploadSpy = vi.mocked(uploadAndSendMedia);
      uploadSpy.mockClear();

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: {
          target: "user:uid1",
          attachments: [{ url: "https://example.com/from-attachments.png" }],
          mediaUrls: ["https://example.com/from-mediaUrls.png"],
          mediaUrl: "https://example.com/from-mediaUrl.png",
        },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(uploadSpy).toHaveBeenCalledTimes(3);
      const sentUrls = uploadSpy.mock.calls.map(c => c[0].mediaUrl).sort();
      expect(sentUrls).toEqual([
        "https://example.com/from-attachments.png",
        "https://example.com/from-mediaUrl.png",
        "https://example.com/from-mediaUrls.png",
      ]);
    });
  });

  describe("send — args.url and args.fileUrl top-level collection", () => {
    it("should collect args.url", async () => {
      const { uploadAndSendMedia } = await import("./inbound.js");
      const uploadSpy = vi.mocked(uploadAndSendMedia);
      uploadSpy.mockClear();

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "user:uid1", url: "https://example.com/via-url.png" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(uploadSpy).toHaveBeenCalledOnce();
      expect(uploadSpy.mock.calls[0][0].mediaUrl).toBe("https://example.com/via-url.png");
    });

    it("should collect args.fileUrl", async () => {
      const { uploadAndSendMedia } = await import("./inbound.js");
      const uploadSpy = vi.mocked(uploadAndSendMedia);
      uploadSpy.mockClear();

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "user:uid1", fileUrl: "https://example.com/via-fileUrl.png" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      expect(uploadSpy).toHaveBeenCalledOnce();
      expect(uploadSpy.mock.calls[0][0].mediaUrl).toBe("https://example.com/via-fileUrl.png");
    });
  });

  // -----------------------------------------------------------------------
  // read action
  // -----------------------------------------------------------------------
  describe("read — same-channel group messages", () => {
    it("should read and return messages from current group (no permission check)", async () => {
      registerBotGroupIds(["grp1"]);
      const fakeMessages = {
        messages: [
          {
            from_uid: "user1",
            message_id: "m1",
            timestamp: 1709654400,
            payload: Buffer.from(JSON.stringify({ type: 1, content: "Hello" })).toString("base64"),
          },
          {
            from_uid: "user2",
            message_id: "m2",
            timestamp: 1709654401,
            payload: Buffer.from(JSON.stringify({ type: 1, content: "Hi there" })).toString("base64"),
          },
        ],
      };

      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async () => jsonResponse(fakeMessages),
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "read",
        args: { target: "group:grp1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "grp1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.count).toBe(2);
      expect(data.messages[0].content).toBe("Hello");
      expect(data.messages[1].content).toBe("Hi there");
      expect(data.hasMore).toBe(false);
      // Same-channel should NOT have prompt injection wrapper
      expect(data.header).toBeUndefined();
    });
  });

  describe("read — RichText(=14) history expansion", () => {
    it("expands type-14 history into plain text (not empty / [object Object])", async () => {
      registerBotGroupIds(["grp1"]);
      const fakeMessages = {
        messages: [
          {
            from_uid: "user1",
            message_id: "m1",
            timestamp: 1709654400,
            // type 14 payload: content is a block array, top-level content "" otherwise
            payload: Buffer.from(JSON.stringify({
              type: 14,
              content: [
                { type: "text", text: "看图: " },
                { type: "image", url: "https://cdn.example.com/p.png", width: 5, height: 5 },
              ],
              plain: "看图: [图片]",
            })).toString("base64"),
          },
        ],
      };

      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async () => jsonResponse(fakeMessages),
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "read",
        args: { target: "group:grp1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "grp1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.messages[0].content).toBe("看图: [图片]");
    });

    it("builds plain from blocks when top-level plain missing", async () => {
      registerBotGroupIds(["grp1"]);
      const fakeMessages = {
        messages: [
          {
            from_uid: "user1",
            message_id: "m1",
            timestamp: 1709654400,
            payload: Buffer.from(JSON.stringify({
              type: 14,
              content: [
                { type: "text", text: "no plain " },
                { type: "image", url: "https://cdn.example.com/p.png", width: 5, height: 5 },
              ],
            })).toString("base64"),
          },
        ],
      };

      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async () => jsonResponse(fakeMessages),
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "read",
        args: { target: "group:grp1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "grp1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.messages[0].content).toBe("no plain [图片]");
    });
  });

  describe("read — custom limit (same channel)", () => {
    it("should cap at 100+1 for same-channel reads", async () => {
      registerBotGroupIds(["grp1"]);
      let requestBody: any = null;

      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async (_url, init) => {
          requestBody = JSON.parse(init?.body as string);
          return jsonResponse({ messages: [] });
        },
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      await handleOctoMessageAction({
        action: "read",
        args: { target: "group:grp1", limit: 200 },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "grp1",
      });

      // Same channel: capped at 100, but API receives limit+1
      expect(requestBody.limit).toBe(101);
    });
  });

  describe("read — uid-to-name resolution", () => {
    it("should resolve from_uid to display names", async () => {
      registerBotGroupIds(["grp1"]);
      const fakeMessages = {
        messages: [
          {
            from_uid: "uid_chen",
            message_id: "m1",
            timestamp: 1709654400,
            payload: Buffer.from(JSON.stringify({ type: 1, content: "你好" })).toString("base64"),
          },
        ],
      };

      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async () => jsonResponse(fakeMessages),
      });

      const uidToNameMap = new Map([["uid_chen", "陈皮皮"]]);

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "read",
        args: { target: "group:grp1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        uidToNameMap,
        currentChannelId: "grp1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.messages[0].from).toBe("陈皮皮");
      expect(data.messages[0].from_uid).toBe("uid_chen");
    });
  });

  describe("read — missing target", () => {
    it("should return error when target is missing", async () => {
      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "read",
        args: {},
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("target");
    });
  });

  // -----------------------------------------------------------------------
  // member-info action
  // -----------------------------------------------------------------------
  describe("member-info — get group members", () => {
    it("should return group member list", async () => {
      const fakeMembers = [
        { uid: "uid1", name: "Alice", role: "admin" },
        { uid: "uid2", name: "Bob", role: "member" },
      ];

      globalThis.fetch = mockFetch({
        "/members": async () => jsonResponse(fakeMembers),
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "member-info",
        args: { target: "group:grp1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.count).toBe(2);
      expect(data.members[0].name).toBe("Alice");
      expect(data.members[1].name).toBe("Bob");
    });
  });

  describe("member-info — missing target", () => {
    it("should return error when target is missing", async () => {
      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "member-info",
        args: {},
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("target");
    });
  });

  // -----------------------------------------------------------------------
  // channel-list action
  // -----------------------------------------------------------------------
  describe("channel-list — list bot groups", () => {
    it("should return list of groups the bot belongs to", async () => {
      const fakeGroups = [
        { group_no: "grp1", name: "Dev Team" },
        { group_no: "grp2", name: "Support" },
      ];

      globalThis.fetch = mockFetch({
        "/v1/bot/groups": async () => jsonResponse(fakeGroups),
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "channel-list",
        args: {},
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.count).toBe(2);
      expect(data.groups[0].name).toBe("Dev Team");
      expect(data.groups[1].group_no).toBe("grp2");
    });
  });

  // -----------------------------------------------------------------------
  // channel-info action
  // -----------------------------------------------------------------------
  describe("channel-info — get group info", () => {
    it("should return group info", async () => {
      const fakeInfo = { group_no: "grp1", name: "Dev Team", member_count: 10 };

      globalThis.fetch = mockFetch({
        "/v1/bot/groups/grp1": async () => jsonResponse(fakeInfo),
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "channel-info",
        args: { target: "group:grp1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.group_no).toBe("grp1");
      expect(data.name).toBe("Dev Team");
      expect(data.member_count).toBe(10);
    });
  });

  describe("channel-info — missing target", () => {
    it("should return error when target is missing", async () => {
      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "channel-info",
        args: {},
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("target");
    });
  });

  // -----------------------------------------------------------------------
  // General
  // -----------------------------------------------------------------------
  describe("unknown action", () => {
    it("should return error for unknown action", async () => {
      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "nonexistent",
        args: {},
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Unknown action");
    });
  });

  describe("missing botToken", () => {
    it("should return error when botToken is empty", async () => {
      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "send",
        args: { target: "user:uid1", message: "hello" },
        apiUrl: "http://localhost:8090",
        botToken: "",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("botToken");
    });
  });

  // -----------------------------------------------------------------------
  // group-md-read action
  // -----------------------------------------------------------------------
  describe("group-md-read — read from cache", () => {
    it("should return cached GROUP.md content", async () => {
      const groupMdCache = new Map([
        ["grp1", { content: "# Group Rules\nBe nice.", version: 3 }],
      ]);

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "group-md-read",
        args: { target: "group:grp1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        groupMdCache,
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.content).toBe("# Group Rules\nBe nice.");
      expect(data.version).toBe(3);
      expect(data.source).toBe("cache");
    });
  });

  describe("group-md-read — cache miss (API fallback)", () => {
    it("should fetch from API when not in cache", async () => {
      globalThis.fetch = mockFetch({
        "/v1/bot/groups/grp1/md": async () =>
          jsonResponse({
            content: "# From API",
            version: 5,
            updated_at: "2024-03-01T00:00:00Z",
            updated_by: "user_abc",
          }),
      });

      const groupMdCache = new Map<string, { content: string; version: number }>();

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "group-md-read",
        args: { target: "group:grp1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        groupMdCache,
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.content).toBe("# From API");
      expect(data.version).toBe(5);
      expect(data.updated_by).toBe("user_abc");
      // Cache should be updated
      expect(groupMdCache.get("grp1")?.version).toBe(5);
    });
  });

  describe("group-md-read — missing target", () => {
    it("should return error when target is missing", async () => {
      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "group-md-read",
        args: {},
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("target");
    });
  });

  // -----------------------------------------------------------------------
  // group-md-update action
  // -----------------------------------------------------------------------
  describe("group-md-update — update successfully", () => {
    it("should update GROUP.md and return new version", async () => {
      globalThis.fetch = mockFetch({
        "/v1/bot/groups/grp1/md": async (_url, init) => {
          if (init?.method === "PUT") {
            return jsonResponse({ version: 6 });
          }
          return new Response("Not found", { status: 404 });
        },
      });

      const groupMdCache = new Map<string, { content: string; version: number }>();

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "group-md-update",
        args: { target: "group:grp1", content: "# Updated Rules" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        groupMdCache,
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.version).toBe(6);
      // Cache should be updated
      expect(groupMdCache.get("grp1")?.content).toBe("# Updated Rules");
      expect(groupMdCache.get("grp1")?.version).toBe(6);
    });
  });

  describe("group-md-update — missing target", () => {
    it("should return error when target is missing", async () => {
      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "group-md-update",
        args: { content: "some content" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("target");
    });
  });

  describe("group-md-update — missing content", () => {
    it("should return error when content is missing", async () => {
      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "group-md-update",
        args: { target: "group:grp1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("content");
    });
  });

  // -----------------------------------------------------------------------
  // read — cross-channel permission checks
  // -----------------------------------------------------------------------
  describe("read — cross-channel DM (self)", () => {
    it("should allow user to read their own DM cross-channel", async () => {
      const fakeMessages = {
        messages: [
          {
            from_uid: "user-abc",
            message_id: "m1",
            timestamp: 1709654400,
            payload: Buffer.from(JSON.stringify({ type: 1, content: "Hello from DM" })).toString("base64"),
          },
        ],
      };

      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async () => jsonResponse(fakeMessages),
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "read",
        args: { target: "user:user-abc" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "different-channel",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.messages[0].content).toBe("Hello from DM");
      // Cross-channel should have prompt injection wrapper
      expect(data.header).toBeDefined();
      expect(data.footer).toBeDefined();
      expect(data.metadata?.trustLevel).toBe("untrusted-data");
    });
  });

  describe("read — cross-channel DM (unauthorized)", () => {
    it("should deny non-owner reading another user's DM", async () => {
      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "read",
        args: { target: "user:someone-else" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "different-channel",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("无权查询他人");
    });
  });

  describe("read — cross-channel group (member)", () => {
    it("should allow group member to read cross-channel", async () => {
      _setCacheEntry("target-grp", [
        { uid: "user-abc", name: "Alice" },
        { uid: "user-xyz", name: "Bob" },
      ]);

      const fakeMessages = {
        messages: [
          {
            from_uid: "user-xyz",
            message_id: "m1",
            timestamp: 1709654400,
            payload: Buffer.from(JSON.stringify({ type: 1, content: "Group msg" })).toString("base64"),
          },
        ],
      };

      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async () => jsonResponse(fakeMessages),
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "read",
        args: { target: "group:target-grp" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "different-channel",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.messages[0].content).toBe("Group msg");
      expect(data.header).toBeDefined();
    });
  });

  describe("read — cross-channel group (non-member)", () => {
    it("should deny non-member reading another group", async () => {
      _setCacheEntry("target-grp", [
        { uid: "user-xyz", name: "Bob" },
      ]);

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "read",
        args: { target: "group:target-grp" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "different-channel",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("你不在该群中");
    });
  });

  describe("read — cross-channel missing requesterSenderId", () => {
    it("should deny when requester is unknown", async () => {
      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "read",
        args: { target: "user:someone" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "different-channel",
        // requesterSenderId not provided
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("无法识别");
    });
  });

  describe("read — owner cross-channel access", () => {
    it("should allow owner to read any DM", async () => {
      registerOwnerUid("acct1", "owner-uid");

      const fakeMessages = {
        messages: [
          {
            from_uid: "someone-else",
            message_id: "m1",
            timestamp: 1709654400,
            payload: Buffer.from(JSON.stringify({ type: 1, content: "Private msg" })).toString("base64"),
          },
        ],
      };

      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async () => jsonResponse(fakeMessages),
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "read",
        args: { target: "user:someone-else" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "different-channel",
        requesterSenderId: "owner-uid",
        accountId: "acct1",
      });

      expect(result.ok).toBe(true);
    });
  });

  describe("read — cross-channel limit cap at 50", () => {
    it("should cap cross-channel reads at 50+1", async () => {
      _setCacheEntry("target-grp", [{ uid: "user-abc", name: "Alice" }]);

      let requestBody: any = null;
      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async (_url, init) => {
          requestBody = JSON.parse(init?.body as string);
          return jsonResponse({ messages: [] });
        },
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      await handleOctoMessageAction({
        action: "read",
        args: { target: "group:target-grp", limit: 200 },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "different-channel",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      // Cross-channel: capped at 50, API receives limit+1
      expect(requestBody.limit).toBe(51);
    });
  });

  describe("read — hasMore detection", () => {
    it("should set hasMore=true when more messages exist", async () => {
      registerBotGroupIds(["grp1"]);
      // Request limit=2, return 3 messages (limit+1 triggers hasMore)
      const fakeMessages = {
        messages: [
          {
            from_uid: "u1", message_id: "m1", timestamp: 1709654400,
            payload: Buffer.from(JSON.stringify({ type: 1, content: "A" })).toString("base64"),
          },
          {
            from_uid: "u2", message_id: "m2", timestamp: 1709654401,
            payload: Buffer.from(JSON.stringify({ type: 1, content: "B" })).toString("base64"),
          },
          {
            from_uid: "u3", message_id: "m3", timestamp: 1709654402,
            payload: Buffer.from(JSON.stringify({ type: 1, content: "C" })).toString("base64"),
          },
        ],
      };

      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async () => jsonResponse(fakeMessages),
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "read",
        args: { target: "group:grp1", limit: 2 },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "grp1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.hasMore).toBe(true);
      expect(data.count).toBe(2); // Trimmed to requested limit
    });
  });

  describe("read — content truncation and type tags", () => {
    it("should truncate long text and show type tags for non-text messages", async () => {
      registerBotGroupIds(["grp1"]);
      const longContent = "A".repeat(600);
      const fakeMessages = {
        messages: [
          {
            from_uid: "u1", message_id: "m1", timestamp: 1709654400,
            payload: Buffer.from(JSON.stringify({ type: 1, content: longContent })).toString("base64"),
          },
          {
            from_uid: "u2", message_id: "m2", timestamp: 1709654401,
            payload: Buffer.from(JSON.stringify({ type: 2, content: "" })).toString("base64"),
          },
          {
            from_uid: "u3", message_id: "m3", timestamp: 1709654402,
            payload: Buffer.from(JSON.stringify({ type: 4, content: "" })).toString("base64"),
          },
          {
            from_uid: "u4", message_id: "m4", timestamp: 1709654403,
            payload: Buffer.from(JSON.stringify({ type: 8, name: "report.pdf" })).toString("base64"),
          },
        ],
      };

      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async () => jsonResponse(fakeMessages),
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "read",
        args: { target: "group:grp1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "grp1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      // Long text should be truncated to 500 + …
      expect(data.messages[0].content).toHaveLength(501);
      expect(data.messages[0].content.endsWith("…")).toBe(true);
      // Image type tag
      expect(data.messages[1].content).toBe("[图片]");
      // Voice type tag
      expect(data.messages[2].content).toBe("[语音]");
      // File type tag
      expect(data.messages[3].content).toBe("[文件: report.pdf]");
    });
  });

  // -----------------------------------------------------------------------
  // search action
  // -----------------------------------------------------------------------
  describe("search — shared-groups", () => {
    it("should return shared groups from cache", async () => {
      _setCacheEntry("grp1", [
        { uid: "user-abc", name: "Alice" },
        { uid: "user-xyz", name: "Bob" },
      ], "Dev Team");
      _setCacheEntry("grp2", [
        { uid: "user-abc", name: "Alice" },
      ], "Support");

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "search",
        args: { query: "shared-groups" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.total).toBe(2);
      expect(data.sharedGroups.map((g: any) => g.groupNo).sort()).toEqual(["grp1", "grp2"]);
    });
  });

  describe("search — shared-groups (no query defaults to shared-groups)", () => {
    it("should default to shared-groups when query is empty", async () => {
      _setCacheEntry("grp1", [
        { uid: "user-abc", name: "Alice" },
      ], "Dev Team");

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "search",
        args: {},
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.total).toBe(1);
    });
  });

  describe("search — missing requesterSenderId", () => {
    it("should return error when requester is unknown", async () => {
      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "search",
        args: { query: "shared-groups" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        // no requesterSenderId
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("无法识别");
    });
  });

  describe("search — unsupported query", () => {
    it("should return error for unsupported query type", async () => {
      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "search",
        args: { query: "keyword-search" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        requesterSenderId: "user-abc",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Unsupported search query");
    });
  });

  describe("search — shared-groups via API (cache miss)", () => {
    it("should fall back to API when cache is empty", async () => {
      globalThis.fetch = mockFetch({
        // /members must come before /v1/bot/groups to avoid false match
        "/members": async () =>
          jsonResponse([
            { uid: "user-abc", name: "Alice" },
          ]),
        "/v1/bot/groups": async () =>
          jsonResponse([
            { group_no: "grp1", name: "Dev Team" },
          ]),
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "search",
        args: { query: "shared-groups" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.total).toBe(1);
      expect(data.sharedGroups[0].groupNo).toBe("grp1");
      expect(data.sharedGroups[0].groupName).toBe("Dev Team");
    });
  });

  // -----------------------------------------------------------------------
  // read — isSameChannel channelType bypass prevention
  // -----------------------------------------------------------------------
  describe("read — channelType mismatch prevents same-channel bypass", () => {
    it("should NOT treat user:grp1 as same-channel when currentChannelId is grp1 (group)", async () => {
      registerBotGroupIds(["grp1"]);

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "read",
        args: { target: "user:grp1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "grp1",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      // channelId matches but channelType differs (DM vs Group) → cross-channel → permission denied
      expect(result.ok).toBe(false);
      expect(result.error).toContain("无权查询他人");
    });

    it("should NOT treat group:uid1 as same-channel when currentChannelId is uid1 (DM)", async () => {
      // uid1 is NOT a known group, so currentChannelType = DM
      // target is group:uid1 → channelType = Group → mismatch

      // Need member cache so the group permission check can proceed
      _setCacheEntry("uid1", [{ uid: "user-abc", name: "Alice" }]);

      globalThis.fetch = mockFetch({
        "/v1/bot/messages/sync": async () => jsonResponse({ messages: [] }),
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "read",
        args: { target: "group:uid1" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        currentChannelId: "uid1",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      // Cross-channel (channelType mismatch) → permission check runs → allowed (user is member)
      // But response should include cross-channel wrapper
      expect(result.ok).toBe(true);
      const data = result.data as any;
      expect(data.header).toBeDefined();
      expect(data.metadata?.trustLevel).toBe("untrusted-data");
    });
  });

  // -----------------------------------------------------------------------
  // search — API fallback error handling
  // -----------------------------------------------------------------------
  describe("search — shared-groups fetchBotGroups failure", () => {
    it("should return error when fetchBotGroups throws", async () => {
      globalThis.fetch = mockFetch({
        "/v1/bot/groups": async () => {
          throw new Error("network timeout");
        },
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "search",
        args: { query: "shared-groups" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("获取群列表失败");
    });
  });

  describe("search — shared-groups per-group member fetch failure", () => {
    it("should skip failed groups and return partial results", async () => {
      globalThis.fetch = mockFetch({
        // /members must come before /v1/bot/groups to avoid false match
        "/members": async (url) => {
          if (url.includes("grp2")) {
            throw new Error("API error");
          }
          return jsonResponse([{ uid: "user-abc", name: "Alice" }]);
        },
        "/v1/bot/groups": async () =>
          jsonResponse([
            { group_no: "grp1", name: "Dev Team" },
            { group_no: "grp2", name: "Broken Group" },
          ]),
      });

      const { handleOctoMessageAction } = await import("./actions.js");
      const result = await handleOctoMessageAction({
        action: "search",
        args: { query: "shared-groups" },
        apiUrl: "http://localhost:8090",
        botToken: "test-token",
        requesterSenderId: "user-abc",
        accountId: "acct1",
      });

      expect(result.ok).toBe(true);
      const data = result.data as any;
      // grp1 should succeed, grp2 should be skipped
      expect(data.total).toBe(1);
      expect(data.sharedGroups[0].groupNo).toBe("grp1");
    });
  });
});

describe("parseTarget", () => {
  it("should parse group: prefix", async () => {
    const { parseTarget } = await import("./actions.js");
    const result = parseTarget("group:chan123");
    expect(result.channelId).toBe("chan123");
    expect(result.channelType).toBe(ChannelType.Group);
  });

  it("should parse user: prefix", async () => {
    const { parseTarget } = await import("./actions.js");
    const result = parseTarget("user:uid456");
    expect(result.channelId).toBe("uid456");
    expect(result.channelType).toBe(ChannelType.DM);
  });

  it("should default bare string to DM", async () => {
    const { parseTarget } = await import("./actions.js");
    const result = parseTarget("some_id");
    expect(result.channelId).toBe("some_id");
    expect(result.channelType).toBe(ChannelType.DM);
  });

  it("should treat bare ID as Group when it matches a known group", async () => {
    const { parseTarget } = await import("./actions.js");
    const knownGroups = new Set(["grpX", "grpY"]);
    const result = parseTarget("grpX", undefined, knownGroups);
    expect(result.channelId).toBe("grpX");
    expect(result.channelType).toBe(ChannelType.Group);
  });

  it("should still default to DM when bare ID is not a known group", async () => {
    const { parseTarget } = await import("./actions.js");
    const knownGroups = new Set(["grpX", "grpY"]);
    const result = parseTarget("unknown_uid", undefined, knownGroups);
    expect(result.channelId).toBe("unknown_uid");
    expect(result.channelType).toBe(ChannelType.DM);
  });

  it("should let explicit prefix win over knownGroupIds", async () => {
    const { parseTarget } = await import("./actions.js");
    const knownGroups = new Set(["grpX"]);
    const result = parseTarget("user:grpX", undefined, knownGroups);
    expect(result.channelId).toBe("grpX");
    expect(result.channelType).toBe(ChannelType.DM);
  });

  it("should treat bare ID matching currentChannelId but NOT in knownGroupIds as DM", async () => {
    const { parseTarget } = await import("./actions.js");
    const knownGroups = new Set(["otherGroup"]);
    // currentChannelId matches target, but target is not a known group → DM
    const result = parseTarget("someChannel", "someChannel", knownGroups);
    expect(result.channelId).toBe("someChannel");
    expect(result.channelType).toBe(ChannelType.DM);
  });

  it("should strip octo: prefix from bare ID", async () => {
    const { parseTarget } = await import("./actions.js");
    const result = parseTarget("octo:someId");
    expect(result.channelId).toBe("someId");
    expect(result.channelType).toBe(ChannelType.DM);
  });

  it("should strip octo: prefix and detect group via knownGroupIds", async () => {
    const { parseTarget } = await import("./actions.js");
    const knownGroups = new Set(["grpZ"]);
    const result = parseTarget("octo:grpZ", undefined, knownGroups);
    expect(result.channelId).toBe("grpZ");
    expect(result.channelType).toBe(ChannelType.Group);
  });

  // OpenClaw's delivery pipeline can emit `channel:<id>` as a parallel alias
  // for group channels. parseTarget handles it directly now so every caller
  // (outbound adapters, message-tool, account resolver) sees consistent
  // routing without having to normalise upstream first.

  it("should parse channel:<id> as Group", async () => {
    const { parseTarget } = await import("./actions.js");
    const result = parseTarget("channel:grp1");
    expect(result.channelId).toBe("grp1");
    expect(result.channelType).toBe(ChannelType.Group);
  });

  it("should parse channel:<id>____<short> as CommunityTopic", async () => {
    const { parseTarget } = await import("./actions.js");
    const result = parseTarget("channel:grp1____topicA");
    expect(result.channelId).toBe("grp1____topicA");
    expect(result.channelType).toBe(ChannelType.CommunityTopic);
  });
});

describe("resolveOutboundOctoTarget", () => {
  // Regression guard for the thread cross-channel bug: OpenClaw passes thread
  // replies as `to: "group:<group_no>"` plus a separate `threadId: "<short_id>"`,
  // and callers used to run only parseTarget which collapsed the routing back
  // to the parent group (channel_type=2). The merged helper must synthesise
  // the CommunityTopic channel_id (channel_type=5).

  it("merges threadId into CommunityTopic channel_id", async () => {
    const { resolveOutboundOctoTarget } = await import("./actions.js");
    registerBotGroupIds(["grp1"]);
    const result = resolveOutboundOctoTarget("group:grp1", "topicA");
    expect(result.channelId).toBe("grp1____topicA");
    expect(result.channelType).toBe(ChannelType.CommunityTopic);
  });

  it("accepts numeric threadId", async () => {
    const { resolveOutboundOctoTarget } = await import("./actions.js");
    registerBotGroupIds(["grp1"]);
    const result = resolveOutboundOctoTarget("group:grp1", 2052674378482585600);
    expect(result.channelId).toBe("grp1____2052674378482585600");
    expect(result.channelType).toBe(ChannelType.CommunityTopic);
  });

  it("passes through an already-synthesised thread channel_id untouched", async () => {
    const { resolveOutboundOctoTarget } = await import("./actions.js");
    registerBotGroupIds(["grp1"]);
    const result = resolveOutboundOctoTarget("group:grp1____topicA");
    expect(result.channelId).toBe("grp1____topicA");
    expect(result.channelType).toBe(ChannelType.CommunityTopic);
  });

  it("does not re-merge threadId when ctx.to already carries ____", async () => {
    const { resolveOutboundOctoTarget } = await import("./actions.js");
    registerBotGroupIds(["grp1"]);
    // Caller gave both — ctx.to wins (already fully specified). Don't concat again.
    const result = resolveOutboundOctoTarget("group:grp1____topicA", "topicB");
    expect(result.channelId).toBe("grp1____topicA");
    expect(result.channelType).toBe(ChannelType.CommunityTopic);
  });

  it("leaves DM targets alone even when threadId is accidentally provided", async () => {
    const { resolveOutboundOctoTarget } = await import("./actions.js");
    const result = resolveOutboundOctoTarget("user:uid123", "stray");
    expect(result.channelId).toBe("uid123");
    expect(result.channelType).toBe(ChannelType.DM);
  });

  it("returns parent group unchanged when threadId is null/undefined/empty", async () => {
    const { resolveOutboundOctoTarget } = await import("./actions.js");
    registerBotGroupIds(["grp1"]);
    expect(resolveOutboundOctoTarget("group:grp1").channelType).toBe(ChannelType.Group);
    expect(resolveOutboundOctoTarget("group:grp1", null).channelType).toBe(ChannelType.Group);
    expect(resolveOutboundOctoTarget("group:grp1", undefined).channelType).toBe(ChannelType.Group);
    expect(resolveOutboundOctoTarget("group:grp1", "").channelType).toBe(ChannelType.Group);
  });

  it("strips inline mention-UID suffix before parsing", async () => {
    const { resolveOutboundOctoTarget } = await import("./actions.js");
    registerBotGroupIds(["grp1"]);
    const result = resolveOutboundOctoTarget("group:grp1@uid1,uid2", "topicA");
    expect(result.channelId).toBe("grp1____topicA");
    expect(result.channelType).toBe(ChannelType.CommunityTopic);
  });

  it("strips group:/channel: prefixes from threadId", async () => {
    const { resolveOutboundOctoTarget } = await import("./actions.js");
    registerBotGroupIds(["grp1"]);
    expect(resolveOutboundOctoTarget("group:grp1", "group:topicA").channelId)
      .toBe("grp1____topicA");
    expect(resolveOutboundOctoTarget("group:grp1", "channel:topicA").channelId)
      .toBe("grp1____topicA");
  });

  // The OpenClaw delivery pipeline can emit `channel:<id>` as an alternative
  // outbound target form for group channels. parseTarget on its own doesn't
  // recognise this prefix, so the helper has to normalise it to `group:` before
  // anything else — otherwise the target degrades to DM and threadId merge is
  // silently skipped.

  it("normalises channel:<id> prefix to group-type target", async () => {
    const { resolveOutboundOctoTarget } = await import("./actions.js");
    registerBotGroupIds(["grp1"]);
    const result = resolveOutboundOctoTarget("channel:grp1");
    expect(result.channelId).toBe("grp1");
    expect(result.channelType).toBe(ChannelType.Group);
  });

  it("merges threadId into a channel:<id> target", async () => {
    const { resolveOutboundOctoTarget } = await import("./actions.js");
    registerBotGroupIds(["grp1"]);
    const result = resolveOutboundOctoTarget("channel:grp1", "topicA");
    expect(result.channelId).toBe("grp1____topicA");
    expect(result.channelType).toBe(ChannelType.CommunityTopic);
  });

  it("passes through a channel:<group>____<short> target as CommunityTopic", async () => {
    const { resolveOutboundOctoTarget } = await import("./actions.js");
    registerBotGroupIds(["grp1"]);
    const result = resolveOutboundOctoTarget("channel:grp1____topicA");
    expect(result.channelId).toBe("grp1____topicA");
    expect(result.channelType).toBe(ChannelType.CommunityTopic);
  });

  it("strips inline mention-UID suffix on channel:<id>@uid1,uid2 form", async () => {
    const { resolveOutboundOctoTarget } = await import("./actions.js");
    registerBotGroupIds(["grp1"]);
    const result = resolveOutboundOctoTarget("channel:grp1@uid1,uid2", "topicA");
    expect(result.channelId).toBe("grp1____topicA");
    expect(result.channelType).toBe(ChannelType.CommunityTopic);
  });

  // Defensive: threadId from framework/user context should never silently redirect
  // delivery to a *different* parent group. If the threadId happens to carry its
  // own `____<parent>` prefix and that parent disagrees with ctx.to, the safe
  // choice is to stay on ctx.to's parent — otherwise a stale or corrupted
  // threadId could route a reply out of the originally targeted group entirely.

  it("accepts threadId that already includes ____ when its parent matches ctx.to", async () => {
    const { resolveOutboundOctoTarget } = await import("./actions.js");
    registerBotGroupIds(["grp1"]);
    // Redundant but consistent shape: threadId = "grp1____topicA", ctx.to = grp1.
    const result = resolveOutboundOctoTarget("group:grp1", "grp1____topicA");
    expect(result.channelId).toBe("grp1____topicA");
    expect(result.channelType).toBe(ChannelType.CommunityTopic);
  });

  it("ignores threadId when its ____ parent disagrees with ctx.to (cross-channel guard)", async () => {
    const { resolveOutboundOctoTarget } = await import("./actions.js");
    registerBotGroupIds(["grp1"]);
    // threadId points at otherGrp____topic, but ctx.to says grp1 — conflict.
    // Fall back to the ctx.to parent group; do NOT silently route to otherGrp.
    const result = resolveOutboundOctoTarget("group:grp1", "otherGrp____topic");
    expect(result.channelId).toBe("grp1");
    expect(result.channelType).toBe(ChannelType.Group);
  });

  it("ignores threadId starting with bare ____ (no parent)", async () => {
    const { resolveOutboundOctoTarget } = await import("./actions.js");
    registerBotGroupIds(["grp1"]);
    // "____topic" split on ____ yields empty parent — still a mismatch with grp1.
    const result = resolveOutboundOctoTarget("group:grp1", "____topic");
    expect(result.channelId).toBe("grp1");
    expect(result.channelType).toBe(ChannelType.Group);
  });
});

describe("normalizeOutboundChannelPrefix", () => {
  it("rewrites channel:<id> to group:<id>", async () => {
    const { normalizeOutboundChannelPrefix } = await import("./actions.js");
    expect(normalizeOutboundChannelPrefix("channel:grp1")).toBe("group:grp1");
  });

  it("preserves channel id separators and suffixes untouched", async () => {
    const { normalizeOutboundChannelPrefix } = await import("./actions.js");
    expect(normalizeOutboundChannelPrefix("channel:grp1____topicA")).toBe("group:grp1____topicA");
    expect(normalizeOutboundChannelPrefix("channel:grp1@uid1,uid2")).toBe("group:grp1@uid1,uid2");
  });

  it("passes non-channel: targets through untouched", async () => {
    const { normalizeOutboundChannelPrefix } = await import("./actions.js");
    expect(normalizeOutboundChannelPrefix("group:grp1")).toBe("group:grp1");
    expect(normalizeOutboundChannelPrefix("user:uid1")).toBe("user:uid1");
    expect(normalizeOutboundChannelPrefix("bare_id")).toBe("bare_id");
  });
});

describe("extractInlineMentionUids", () => {
  it("extracts UIDs from group:<id>@uid1,uid2 form", async () => {
    const { extractInlineMentionUids } = await import("./actions.js");
    expect(extractInlineMentionUids("group:grp1@uid1,uid2")).toEqual(["uid1", "uid2"]);
  });

  it("extracts UIDs from channel:<id>@uid1,uid2 form (same shape, parallel prefix)", async () => {
    const { extractInlineMentionUids } = await import("./actions.js");
    expect(extractInlineMentionUids("channel:grp1@uid1,uid2")).toEqual(["uid1", "uid2"]);
  });

  it("returns empty array for targets without the @-suffix", async () => {
    const { extractInlineMentionUids } = await import("./actions.js");
    expect(extractInlineMentionUids("group:grp1")).toEqual([]);
    expect(extractInlineMentionUids("channel:grp1")).toEqual([]);
    expect(extractInlineMentionUids("user:uid1")).toEqual([]);
    expect(extractInlineMentionUids("bare_id")).toEqual([]);
  });

  it("filters out empty segments produced by trailing/duplicate commas", async () => {
    const { extractInlineMentionUids } = await import("./actions.js");
    expect(extractInlineMentionUids("group:grp1@uid1,,uid2,")).toEqual(["uid1", "uid2"]);
  });
});
