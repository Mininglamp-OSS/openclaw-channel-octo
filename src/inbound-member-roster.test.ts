import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType, MessageType } from "./types.js";
import { handleInboundMessage } from "./inbound.js";
import { setOctoRuntime } from "./runtime.js";
import { _clearKnownBots } from "./bot-registry.js";
import { _clearMentionPrefCache, _setMentionPrefEntry } from "./mention-prefs.js";
import type { ResolvedOctoAccount } from "./accounts.js";
import type { GroupMember } from "./api-fetch.js";

/**
 * Integration test for #125 — group member-count / roster context must reflect
 * the CURRENT group only, never the cross-group union, and must not re-inject a
 * stale roster after a failed refresh.
 *
 * Drives the real handleInboundMessage with a stubbed OpenClaw runtime + stubbed
 * network. The current-group roster is observed via the per-account
 * currentGroupMembersMap the caller passes in (channel.ts owns one per account);
 * here each test owns the map so it can assert what got cached.
 *
 * Note on cleanupStaleCaches: the cleanup line that drops _currentGroupMembersMaps
 * entries lives in channel.ts module-private scope (same as the existing
 * _memberMaps/_groupCacheTimestamps cleanup, which has no unit test either) and
 * is not exercised here. It is structurally identical to and shares the raw-key
 * with the adjacent _groupCacheTimestamps.delete, so its correctness rests on
 * type-check + that structural equivalence rather than a private-symbol test.
 * The negative-cache behavior that the read path actually depends on IS asserted
 * below.
 */

const API = "http://octo.test";
const BOT_UID = "bot_self_0000000000000000000000000000";

function makeAccount(accountId = "acct1"): ResolvedOctoAccount {
  return {
    accountId,
    enabled: true,
    configured: true,
    config: {
      botToken: "tok",
      apiUrl: API,
      pollIntervalMs: 1000,
      heartbeatIntervalMs: 1000,
      requireMention: false, // reply without @ so the dispatch path always runs
    },
  };
}

function makeTextMessage(groupId: string, fromUid: string, content: string) {
  return {
    message_id: `m_${groupId}`,
    message_seq: 100,
    from_uid: fromUid,
    channel_id: groupId,
    channel_type: ChannelType.Group,
    timestamp: Math.floor(Date.now() / 1000),
    payload: { type: MessageType.Text, content },
  };
}

function installRuntimeStub() {
  const dispatch = vi.fn(async (args: any) => {
    await args.dispatcherOptions.deliver({ text: "hi" }, { kind: "final" });
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
 * Network stub whose /members response is keyed by the groupNo in the request
 * URL, so different groups return different rosters. membersDown forces /members
 * to fail (500) to exercise the negative-cache path.
 */
function installFetchStub(rostersByGroup: Record<string, GroupMember[]>, opts: { membersDown?: boolean } = {}) {
  globalThis.fetch = vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

    if (url.includes("/members")) {
      if (opts.membersDown) return json({ error: "boom" }, 500);
      // Pick the roster whose groupNo appears in the request URL/body.
      const body = init?.body ? String(init.body) : "";
      const hay = url + body;
      for (const [groupNo, roster] of Object.entries(rostersByGroup)) {
        if (hay.includes(groupNo)) return json({ members: roster });
      }
      return json({ members: [] });
    }
    if (url.includes("/mention_pref")) return json({ no_mention: true, effective: true });
    if (url.includes("/md")) return json({ content: "", version: 0, updated_at: null, updated_by: "" });
    if (url.includes("/messages/sync")) return json({ messages: [] });
    if (url.includes("/readReceipt")) return json({});
    if (url.includes("/typing")) return json({});
    if (url.includes("/sendMessage")) return json({ message_id: "r", message_seq: 0 });
    return json({});
  }) as unknown as typeof fetch;
}

const originalFetch = globalThis.fetch;

const GROUP_A = "30000000000000000000000000000a";
const GROUP_B = "30000000000000000000000000000b";
const groupA: GroupMember[] = [
  { uid: "a1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "Alice" },
  { uid: "a2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "Bob" },
  { uid: "a3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "Carol" },
];
const groupB: GroupMember[] = [
  { uid: "b1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "Dave" },
  { uid: "b2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "Erin" },
  { uid: "b3bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "Frank" },
  { uid: "b4bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "Grace" },
];

describe("#125 current-group roster (cross-group isolation)", () => {
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

  it("caches ONLY the current group's roster, not the union across groups", async () => {
    installRuntimeStub();
    installFetchStub({ [GROUP_A]: groupA, [GROUP_B]: groupB });
    const currentGroupMembersMap = new Map<string, GroupMember[]>();
    const base = {
      account: makeAccount(),
      botUid: BOT_UID,
      groupHistories: new Map(),
      lastBotReplySeqMap: new Map(),
      memberMap: new Map(),
      uidToNameMap: new Map(),
      groupCacheTimestamps: new Map(),
      currentGroupMembersMap,
    };

    // Bot is messaged in group A, then in group B.
    await handleInboundMessage({ ...base, message: makeTextMessage(GROUP_A, groupA[0].uid, "hi") });
    await handleInboundMessage({ ...base, message: makeTextMessage(GROUP_B, groupB[0].uid, "hi") });

    // Each group's cache entry holds only that group's members.
    expect(currentGroupMembersMap.get(GROUP_A)?.map((m) => m.name)).toEqual(["Alice", "Bob", "Carol"]);
    expect(currentGroupMembersMap.get(GROUP_B)?.map((m) => m.name)).toEqual(["Dave", "Erin", "Frank", "Grace"]);
    // Group B's roster must NOT contain group A's members (no union/leak).
    expect(currentGroupMembersMap.get(GROUP_B)?.some((m) => m.name === "Alice")).toBe(false);
  });

  it("negative-caches on members fetch failure (no stale roster re-injected)", async () => {
    const currentGroupMembersMap = new Map<string, GroupMember[]>();
    const groupCacheTimestamps = new Map<string, number>();
    const base = {
      account: makeAccount(),
      botUid: BOT_UID,
      groupHistories: new Map(),
      lastBotReplySeqMap: new Map(),
      memberMap: new Map(),
      uidToNameMap: new Map(),
      groupCacheTimestamps,
      currentGroupMembersMap,
    };

    // 1) Successful refresh caches the roster.
    installRuntimeStub();
    installFetchStub({ [GROUP_A]: groupA });
    await handleInboundMessage({ ...base, message: makeTextMessage(GROUP_A, groupA[0].uid, "hi") });
    expect(currentGroupMembersMap.get(GROUP_A)?.length).toBe(3);

    // 2) Force expiry so the next message actually refreshes, then fail /members.
    groupCacheTimestamps.clear();
    installRuntimeStub();
    installFetchStub({}, { membersDown: true });
    await handleInboundMessage({ ...base, message: makeTextMessage(GROUP_A, groupA[0].uid, "hi again") });

    // Roster entry was deleted (negative cache) — not left stale.
    expect(currentGroupMembersMap.has(GROUP_A)).toBe(false);
  });

  it("isolates rosters per account (two real account flows, separate per-account state)", async () => {
    installRuntimeStub();
    // acct1 lives in GROUP_A (3 members); acct2 lives in GROUP_B (4 members).
    installFetchStub({ [GROUP_A]: groupA, [GROUP_B]: groupB });

    // Each account gets its OWN per-account state (as channel.ts does via the
    // getOrCreate*(accountId) helpers) — nothing is shared between them.
    const acct1 = {
      account: makeAccount("acct1"),
      currentGroupMembersMap: new Map<string, GroupMember[]>(),
      memberMap: new Map<string, string>(),
      uidToNameMap: new Map<string, string>(),
      groupCacheTimestamps: new Map<string, number>(),
    };
    const acct2 = {
      account: makeAccount("acct2"),
      currentGroupMembersMap: new Map<string, GroupMember[]>(),
      memberMap: new Map<string, string>(),
      uidToNameMap: new Map<string, string>(),
      groupCacheTimestamps: new Map<string, number>(),
    };
    const common = {
      botUid: BOT_UID,
      groupHistories: new Map(),
      lastBotReplySeqMap: new Map(),
    };

    // Drive a real inbound flow for BOTH accounts.
    await handleInboundMessage({ ...common, ...acct1, message: makeTextMessage(GROUP_A, groupA[0].uid, "hi") });
    await handleInboundMessage({ ...common, ...acct2, message: makeTextMessage(GROUP_B, groupB[0].uid, "hi") });

    // Each account's roster cache holds ONLY its own group — no cross-account bleed.
    expect(acct1.currentGroupMembersMap.get(GROUP_A)?.map((m) => m.name)).toEqual(["Alice", "Bob", "Carol"]);
    expect(acct1.currentGroupMembersMap.has(GROUP_B)).toBe(false);
    expect(acct2.currentGroupMembersMap.get(GROUP_B)?.map((m) => m.name)).toEqual(["Dave", "Erin", "Frank", "Grace"]);
    expect(acct2.currentGroupMembersMap.has(GROUP_A)).toBe(false);
  });
});
