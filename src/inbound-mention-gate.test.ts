import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType, MessageType } from "./types.js";
import { handleInboundMessage } from "./inbound.js";
import { setOctoRuntime } from "./runtime.js";
import { registerKnownBot, _clearKnownBots } from "./bot-registry.js";
import { _clearMentionPrefCache, _setMentionPrefEntry, _hasMentionPrefEntry } from "./mention-prefs.js";
import type { ResolvedOctoAccount } from "./accounts.js";

/**
 * Integration test for the inbound mention-gate 免@ relaxation (PR#57 review P1).
 *
 * The 免@ (no_mention=true) group preference relaxes requireMention so the bot
 * replies to non-@ messages. The fix scopes that relaxation to HUMAN senders,
 * and does so FAIL-CLOSED (round-4): the gate relaxes requireMention ONLY for a
 * sender the server-authoritative member list positively confirms is human
 * (memberRobotMap.get(uid) === false). Unknown senders, ANY robot, and the case
 * where the member refresh fails/returns empty (so the robot flag is undefined)
 * all keep requireMention — otherwise two 免@ bots in the same group, or any
 * mis-classified sender, reply to each other forever (bot-to-bot loop).
 *
 * These tests drive the real handleInboundMessage with a stubbed OpenClaw
 * runtime + stubbed network so we exercise the actual gate (not a re-impl).
 * "Replied" is observed via the dispatcher being invoked AND a text message
 * being POSTed to the send endpoint; "suppressed" is observed via the history-
 * only short-circuit (no dispatch, no send).
 */

const API = "http://octo.test";
const BOT_UID = "bot_self_0000000000000000000000000000";
const HUMAN_UID = "human_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_BOT_UID = "bot_other_111111111111111111111111111";
// A bot from another OpenClaw process / external integration: present in the
// server member list with robot:true but NEVER passed to registerKnownBot().
const EXTERNAL_BOT_UID = "bot_extern_22222222222222222222222222";
// A cross-process bot whose server robot flag is the NUMERIC shape (robot:1)
// rather than boolean true — the backend serializes it as a number. The gate
// must treat 1 the same as true, else this bot is misclassified as human.
const NUMERIC_BOT_UID = "bot_numeric_3333333333333333333333333";
const GROUP_ID = "g_room_1";

const originalFetch = globalThis.fetch;

function makeAccount(): ResolvedOctoAccount {
  return {
    accountId: "acct1",
    enabled: true,
    configured: true,
    config: {
      botToken: "tok",
      apiUrl: API,
      pollIntervalMs: 1000,
      heartbeatIntervalMs: 1000,
      requireMention: true, // account requires @ by default; 免@ pref relaxes it
    },
  };
}

function makeTextMessage(fromUid: string, content: string) {
  return {
    message_id: "m1",
    message_seq: 100,
    from_uid: fromUid,
    channel_id: GROUP_ID,
    channel_type: ChannelType.Group,
    timestamp: Math.floor(Date.now() / 1000),
    payload: { type: MessageType.Text, content },
  };
}

/**
 * Stub OpenClaw runtime. The dispatcher immediately emits one final text block
 * so the buffered-text path runs and POSTs a reply — letting us assert "replied"
 * by observing the send endpoint.
 */
function installRuntimeStub(): { dispatch: ReturnType<typeof vi.fn> } {
  const dispatch = vi.fn(async (args: any) => {
    await args.dispatcherOptions.deliver({ text: "hi there" }, { kind: "final" });
  });
  setOctoRuntime({
    config: { loadConfig: () => ({}) },
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: dispatch,
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: any) => body,
        finalizeInboundContext: (ctx: any) => ctx,
      },
      routing: {
        resolveAgentRoute: () => ({ agentId: "agent1", sessionKey: "sk1", accountId: "acct1" }),
      },
      session: {
        resolveStorePath: () => "/tmp/store",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: async () => {},
      },
    },
  } as any);
  return { dispatch };
}

/**
 * Network stub. Members endpoint returns the human + both bots (with robot
 * flags); the bot's own GROUP.md / mention_pref are answered benignly; the send
 * + typing + read-receipt endpoints record calls. Returns the list of POSTed
 * send-message bodies so we can assert a reply went out.
 */
function installFetchStub() {
  const sends: any[] = [];
  globalThis.fetch = vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

    if (url.includes("/members")) {
      return json({
        members: [
          { uid: HUMAN_UID, name: "Alice", robot: false },
          { uid: BOT_UID, name: "SelfBot", robot: true },
          { uid: OTHER_BOT_UID, name: "OtherBot", robot: true },
          // Cross-process / external bot: server marks it robot:true, but this
          // plugin never registered it via registerKnownBot().
          { uid: EXTERNAL_BOT_UID, name: "ExternalBot", robot: true },
          // Cross-process bot whose robot flag arrives as the numeric shape (1).
          { uid: NUMERIC_BOT_UID, name: "NumericBot", robot: 1 },
        ],
      });
    }
    if (url.includes("/mention_pref")) return json({ no_mention: true });
    if (url.includes("/md")) return json({ content: "", version: 0, updated_at: null, updated_by: "" });
    if (url.includes("/messages/sync")) return json({ messages: [] });
    if (url.includes("/readReceipt")) return json({});
    if (url.includes("/typing")) return json({});
    // sendMessage POST → record the outbound reply
    if (url.includes("/sendMessage")) {
      sends.push(init?.body ? JSON.parse(init.body) : {});
      return json({ message_id: "reply1", message_seq: 0 });
    }
    // Default benign 200
    return json({});
  }) as unknown as typeof fetch;
  return { sends };
}

/**
 * Network stub variant where the group-members endpoint FAILS (or returns
 * empty), so refreshGroupMemberCache can't populate memberRobotMap. Every other
 * endpoint behaves like installFetchStub. Used to prove the fail-closed gate:
 * with no server robot flag, even a real human sender stays gated because the
 * member list never confirmed them as human.
 */
function installFetchStubMembersDown(mode: "error" | "empty" = "error") {
  const sends: any[] = [];
  globalThis.fetch = vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

    if (url.includes("/members")) {
      if (mode === "error") return json({ error: "boom" }, 500);
      return json({ members: [] });
    }
    if (url.includes("/mention_pref")) return json({ no_mention: true });
    if (url.includes("/md")) return json({ content: "", version: 0, updated_at: null, updated_by: "" });
    if (url.includes("/messages/sync")) return json({ messages: [] });
    if (url.includes("/readReceipt")) return json({});
    if (url.includes("/typing")) return json({});
    if (url.includes("/sendMessage")) {
      sends.push(init?.body ? JSON.parse(init.body) : {});
      return json({ message_id: "reply1", message_seq: 0 });
    }
    return json({});
  }) as unknown as typeof fetch;
  return { sends };
}

describe("inbound mention-gate 免@ relaxation (P1: human-only)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _clearKnownBots();
    _clearMentionPrefCache();
    // Register both this bot and the other bot as known bots.
    registerKnownBot(BOT_UID);
    registerKnownBot(OTHER_BOT_UID);
    // Pre-seed the 免@ pref so no network round-trip is needed for the lookup.
    _setMentionPrefEntry("acct1", GROUP_ID, { no_mention: true });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    _clearKnownBots();
    _clearMentionPrefCache();
  });

  it("replies to a HUMAN non-@ message in a 免@ group", async () => {
    const { dispatch } = installRuntimeStub();
    const { sends } = installFetchStub();

    await handleInboundMessage({
      account: makeAccount(),
      message: makeTextMessage(HUMAN_UID, "hello bot"),
      botUid: BOT_UID,
      groupHistories: new Map(),
      lastBotReplySeqMap: new Map(),
      memberMap: new Map(),
      uidToNameMap: new Map(),
      groupCacheTimestamps: new Map(),
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(sends.length).toBeGreaterThan(0);
  });

  it("does NOT reply to a KNOWN-BOT non-@ message in a 免@ group (loop guard)", async () => {
    const { dispatch } = installRuntimeStub();
    const { sends } = installFetchStub();

    await handleInboundMessage({
      account: makeAccount(),
      message: makeTextMessage(OTHER_BOT_UID, "hello from other bot"),
      botUid: BOT_UID,
      groupHistories: new Map(),
      lastBotReplySeqMap: new Map(),
      memberMap: new Map(),
      uidToNameMap: new Map(),
      groupCacheTimestamps: new Map(),
    });

    // History-only short-circuit: gate kept requireMention for the bot sender,
    // the non-@ message was cached as context and the bot never dispatched.
    expect(dispatch).not.toHaveBeenCalled();
    expect(sends.length).toBe(0);
  });

  it("DOES reply to a KNOWN-BOT message that explicitly @mentions this bot", async () => {
    const { dispatch } = installRuntimeStub();
    const { sends } = installFetchStub();

    const msg = makeTextMessage(OTHER_BOT_UID, "@SelfBot ping");
    (msg.payload as any).mention = { uids: [BOT_UID] };

    await handleInboundMessage({
      account: makeAccount(),
      message: msg,
      botUid: BOT_UID,
      groupHistories: new Map(),
      lastBotReplySeqMap: new Map(),
      memberMap: new Map(),
      uidToNameMap: new Map(),
      groupCacheTimestamps: new Map(),
    });

    // Explicit @mention always triggers, even from a known bot.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(sends.length).toBeGreaterThan(0);
  });

  it("suppresses the group-pref lookup for known-bot senders (no mention_pref fetch)", async () => {
    installRuntimeStub();
    const { sends } = installFetchStub();
    // Force a cache miss so a lookup WOULD hit the network if attempted.
    _clearMentionPrefCache();

    await handleInboundMessage({
      account: makeAccount(),
      message: makeTextMessage(OTHER_BOT_UID, "noise"),
      botUid: BOT_UID,
      groupHistories: new Map(),
      lastBotReplySeqMap: new Map(),
      memberMap: new Map(),
      uidToNameMap: new Map(),
      groupCacheTimestamps: new Map(),
    });

    const calledUrls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(calledUrls.some((u: string) => u.includes("/mention_pref"))).toBe(false);
    expect(sends.length).toBe(0);
  });

  it("suppresses the group-pref lookup for an explicit @bot message (no needless latency)", async () => {
    // round-3 non-blocking #1: an explicit @bot message already passes the gate,
    // so the 免@ pref can't change the outcome. The lookup must be short-
    // circuited (computed AFTER mention flags, only when !isMentioned) so a
    // cold/slow pref backend never adds latency to normal @bot replies.
    const { dispatch } = installRuntimeStub();
    const { sends } = installFetchStub();
    // Force a cache miss so a lookup WOULD hit the network if attempted.
    _clearMentionPrefCache();

    const msg = makeTextMessage(HUMAN_UID, "@SelfBot please answer");
    (msg.payload as any).mention = { uids: [BOT_UID] };

    await handleInboundMessage({
      account: makeAccount(),
      message: msg,
      botUid: BOT_UID,
      groupHistories: new Map(),
      lastBotReplySeqMap: new Map(),
      memberMap: new Map(),
      uidToNameMap: new Map(),
      groupCacheTimestamps: new Map(),
    });

    const calledUrls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(calledUrls.some((u: string) => u.includes("/mention_pref"))).toBe(false);
    // The @bot message still triggers a normal reply.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(sends.length).toBeGreaterThan(0);
  });

  it("does NOT reply to a CROSS-PROCESS bot (robot:true in member list, NOT registerKnownBot'd)", async () => {
    // Regression for PR#57 round-2 P1: the loop guard must use the
    // server-authoritative GroupMember.robot signal, not just the local
    // registerKnownBot() set. EXTERNAL_BOT_UID is robot:true in the group
    // member list but was never registered, so isKnownBot() returns false for
    // it. Before the fix it was treated as human → 免@ relaxed → reply → loop.
    const { dispatch } = installRuntimeStub();
    const { sends } = installFetchStub();
    // Force a member-cache fetch so the robot flag is loaded from the server.
    const memberRobotMap = new Map<string, boolean>();

    await handleInboundMessage({
      account: makeAccount(),
      message: makeTextMessage(EXTERNAL_BOT_UID, "hello from a bot in another process"),
      botUid: BOT_UID,
      groupHistories: new Map(),
      lastBotReplySeqMap: new Map(),
      memberMap: new Map(),
      uidToNameMap: new Map(),
      groupCacheTimestamps: new Map(),
      memberRobotMap,
    });

    // Gate kept requireMention for the server-flagged robot sender: no dispatch,
    // no send. The robot flag was sourced from the member list.
    expect(memberRobotMap.get(EXTERNAL_BOT_UID)).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    expect(sends.length).toBe(0);
  });

  it("does NOT reply to a CROSS-PROCESS bot whose robot flag is NUMERIC (robot:1)", async () => {
    // Regression for PR#57 round-3 P1: the backend serializes GroupMember.robot
    // as a number, so a strict `=== true` would treat robot:1 as human → relax
    // requireMention → reply to the non-@ bot message → bot-to-bot loop. The
    // gate must coerce robot:1 to a bot exactly like robot:true.
    const { dispatch } = installRuntimeStub();
    const { sends } = installFetchStub();
    const memberRobotMap = new Map<string, boolean>();

    await handleInboundMessage({
      account: makeAccount(),
      message: makeTextMessage(NUMERIC_BOT_UID, "hello from a numeric-flagged bot"),
      botUid: BOT_UID,
      groupHistories: new Map(),
      lastBotReplySeqMap: new Map(),
      memberMap: new Map(),
      uidToNameMap: new Map(),
      groupCacheTimestamps: new Map(),
      memberRobotMap,
    });

    // robot:1 coerced to true → gate kept requireMention → no dispatch, no send.
    expect(memberRobotMap.get(NUMERIC_BOT_UID)).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    expect(sends.length).toBe(0);
  });

  it("DOES reply to a CROSS-PROCESS bot that explicitly @mentions this bot", async () => {
    // Explicit @mention always triggers, even from a server-flagged robot that
    // is not locally registered — symmetric with the known-bot @mention case.
    const { dispatch } = installRuntimeStub();
    const { sends } = installFetchStub();

    const msg = makeTextMessage(EXTERNAL_BOT_UID, "@SelfBot ping");
    (msg.payload as any).mention = { uids: [BOT_UID] };

    await handleInboundMessage({
      account: makeAccount(),
      message: msg,
      botUid: BOT_UID,
      groupHistories: new Map(),
      lastBotReplySeqMap: new Map(),
      memberMap: new Map(),
      uidToNameMap: new Map(),
      groupCacheTimestamps: new Map(),
      memberRobotMap: new Map(),
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(sends.length).toBeGreaterThan(0);
  });

  it("does NOT reply to a HUMAN non-@ message when member refresh FAILS (fail-closed)", async () => {
    // round-4 P1: the loop guard inverts to a whitelist. A sender is relaxed
    // ONLY when the member list positively confirms them human. When the
    // members endpoint errors out, refreshGroupMemberCache leaves memberRobotMap
    // unpopulated → robot flag is undefined → classification unknown → keep
    // requireMention. The blacklist version failed OPEN here (undefined !== true
    // → treated as human → relax → reply → loop for ANY sender on refresh fail).
    const { dispatch } = installRuntimeStub();
    const { sends } = installFetchStubMembersDown("error");
    const memberRobotMap = new Map<string, boolean>();

    await handleInboundMessage({
      account: makeAccount(),
      message: makeTextMessage(HUMAN_UID, "hello bot"),
      botUid: BOT_UID,
      groupHistories: new Map(),
      lastBotReplySeqMap: new Map(),
      memberMap: new Map(),
      uidToNameMap: new Map(),
      groupCacheTimestamps: new Map(),
      memberRobotMap,
    });

    // Refresh failed → no robot flag recorded → fail-closed: gate kept
    // requireMention, the non-@ message was cached only, no dispatch/send.
    expect(memberRobotMap.has(HUMAN_UID)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(sends.length).toBe(0);
  });

  it("does NOT reply to a HUMAN non-@ message when member list is EMPTY (fail-closed)", async () => {
    // Sibling of the refresh-error case: an empty member list is the other way
    // refreshGroupMemberCache returns without populating memberRobotMap. Same
    // fail-closed outcome — unknown classification keeps requireMention.
    const { dispatch } = installRuntimeStub();
    const { sends } = installFetchStubMembersDown("empty");
    const memberRobotMap = new Map<string, boolean>();

    await handleInboundMessage({
      account: makeAccount(),
      message: makeTextMessage(HUMAN_UID, "hello bot"),
      botUid: BOT_UID,
      groupHistories: new Map(),
      lastBotReplySeqMap: new Map(),
      memberMap: new Map(),
      uidToNameMap: new Map(),
      groupCacheTimestamps: new Map(),
      memberRobotMap,
    });

    expect(memberRobotMap.has(HUMAN_UID)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(sends.length).toBe(0);
  });

  it("does NOT reply to an UNKNOWN non-@ sender absent from the member list (fail-closed)", async () => {
    // The member list loads fine but does NOT contain this sender (e.g. a uid
    // that joined after the cache warmed, or a cross-process sender the server
    // omits). memberRobotMap.get(uid) === undefined → not confirmed human →
    // keep requireMention. The blacklist version relaxed here (undefined !==
    // true), reopening the loop for any sender the member list happened to miss.
    const UNKNOWN_UID = "user_ghost_99999999999999999999999999";
    const { dispatch } = installRuntimeStub();
    const { sends } = installFetchStub(); // members endpoint OK, just no UNKNOWN_UID row
    const memberRobotMap = new Map<string, boolean>();

    await handleInboundMessage({
      account: makeAccount(),
      message: makeTextMessage(UNKNOWN_UID, "hello bot"),
      botUid: BOT_UID,
      groupHistories: new Map(),
      lastBotReplySeqMap: new Map(),
      memberMap: new Map(),
      uidToNameMap: new Map(),
      groupCacheTimestamps: new Map(),
      memberRobotMap,
    });

    // Member list loaded but had no row for UNKNOWN_UID → flag undefined →
    // fail-closed: gate kept requireMention.
    expect(memberRobotMap.has(UNKNOWN_UID)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(sends.length).toBe(0);
  });
});

describe("inbound mention_pref_updated event → cache invalidation (GH#60)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _clearKnownBots();
    _clearMentionPrefCache();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    _clearKnownBots();
    _clearMentionPrefCache();
  });

  function makeMentionPrefEvent() {
    return {
      message_id: "evt1",
      message_seq: 200,
      from_uid: "system",
      channel_id: GROUP_ID,
      channel_type: ChannelType.Group,
      timestamp: Math.floor(Date.now() / 1000),
      payload: { event: { type: "mention_pref_updated", group_no: GROUP_ID } },
    };
  }

  it("invalidates the cached (bot, group) entry and does NOT dispatch to the LLM", async () => {
    const { dispatch } = installRuntimeStub();
    const { sends } = installFetchStub();

    // Pre-seed a stale 免@ pref for this (bot, group).
    _setMentionPrefEntry("acct1", GROUP_ID, { no_mention: true });
    expect(_hasMentionPrefEntry("acct1", GROUP_ID)).toBe(true);

    await handleInboundMessage({
      account: makeAccount(),
      message: makeMentionPrefEvent() as any,
      botUid: BOT_UID,
      groupHistories: new Map(),
      lastBotReplySeqMap: new Map(),
      memberMap: new Map(),
      uidToNameMap: new Map(),
      groupCacheTimestamps: new Map(),
    });

    // Cache entry was dropped; event was swallowed (no LLM dispatch, no reply).
    expect(_hasMentionPrefEntry("acct1", GROUP_ID)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(sends.length).toBe(0);
  });

  it("only invalidates the targeted group, leaving other entries intact", async () => {
    installRuntimeStub();
    installFetchStub();

    _setMentionPrefEntry("acct1", GROUP_ID, { no_mention: true });
    _setMentionPrefEntry("acct1", "other_group", { no_mention: true });

    await handleInboundMessage({
      account: makeAccount(),
      message: makeMentionPrefEvent() as any,
      botUid: BOT_UID,
      groupHistories: new Map(),
      lastBotReplySeqMap: new Map(),
      memberMap: new Map(),
      uidToNameMap: new Map(),
      groupCacheTimestamps: new Map(),
    });

    expect(_hasMentionPrefEntry("acct1", GROUP_ID)).toBe(false);
    expect(_hasMentionPrefEntry("acct1", "other_group")).toBe(true);
  });
});
