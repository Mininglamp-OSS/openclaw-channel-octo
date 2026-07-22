import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType, MessageType } from "./types.js";
import { handleInboundMessage } from "./inbound.js";
import { setOctoRuntime } from "./runtime.js";
import { _clearKnownBots } from "./bot-registry.js";
import type { ResolvedOctoAccount } from "./accounts.js";

/**
 * Regression tests for #172 — DM no-reply.
 *
 * A DM whose delivery mode resolves to message_tool_only produces no visible
 * reply when the agent doesn't call the message tool. On the Codex harness the
 * DM default (`defaultVisibleReplies`) is "message_tool", so an unconfigured DM
 * silently strands. The plugin corrects only that implicit default: it requests
 * sourceReplyDeliveryMode="automatic" ONLY for a DM whose operator has NOT set
 * messages.visibleReplies. Group chats and any explicit visibleReplies config
 * are left to the host (requested mode outranks config, so injecting it
 * unconditionally would override operator intent and change group behaviour).
 */

const API = "http://octo.test";
const BOT_UID = "bot_self_0000000000000000000000000000";
const HUMAN_UID = "human_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
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
      requireMention: false,
    },
  };
}

function makeDmMessage() {
  return {
    message_id: "m_dm",
    message_seq: 100,
    from_uid: HUMAN_UID,
    channel_id: HUMAN_UID, // DM: channel is the peer uid
    channel_type: ChannelType.DM,
    timestamp: Math.floor(Date.now() / 1000),
    payload: { type: MessageType.Text, content: "hi bot" },
  };
}

function makeGroupMessage() {
  return {
    message_id: "m_grp",
    message_seq: 100,
    from_uid: HUMAN_UID,
    channel_id: GROUP_ID,
    channel_type: ChannelType.Group,
    timestamp: Math.floor(Date.now() / 1000),
    payload: {
      type: MessageType.Text,
      content: "hello bot",
      mention: { uids: [BOT_UID] },
    },
  };
}

function installFetchStub() {
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (url.includes("/members")) {
      return json({
        members: [
          { uid: HUMAN_UID, name: "Alice", robot: false },
          { uid: BOT_UID, name: "SelfBot", robot: true },
        ],
      });
    }
    if (url.includes("/mention_pref")) return json({ no_mention: false });
    if (url.includes("/md")) return json({ content: "", version: 0, updated_at: null, updated_by: "" });
    if (url.includes("/messages/sync")) return json({ messages: [] });
    if (url.includes("/readReceipt")) return json({});
    if (url.includes("/typing")) return json({});
    if (url.includes("/sendMessage")) return json({ message_id: "reply1", message_seq: 0 });
    return json({});
  }) as unknown as typeof fetch;
}

function installRuntime(config: Record<string, unknown> = {}, deliver = false) {
  const dispatch = vi.fn(async (args: any) => {
    if (deliver) await args.dispatcherOptions.deliver({ text: "hi" }, { kind: "final" });
  });
  setOctoRuntime({
    config: { loadConfig: () => config },
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

function runDm() {
  return handleInboundMessage({
    account: makeAccount(),
    message: makeDmMessage() as any,
    botUid: BOT_UID,
    groupHistories: new Map(),
    lastBotReplySeqMap: new Map(),
    memberMap: new Map(),
    uidToNameMap: new Map(),
    groupCacheTimestamps: new Map(),
    log: undefined,
  });
}

function runGroup() {
  return handleInboundMessage({
    account: makeAccount(),
    message: makeGroupMessage() as any,
    botUid: BOT_UID,
    groupHistories: new Map(),
    lastBotReplySeqMap: new Map(),
    memberMap: new Map(),
    uidToNameMap: new Map(),
    groupCacheTimestamps: new Map(),
    log: undefined,
  });
}

const replyOptionsOf = (dispatch: ReturnType<typeof vi.fn>) => dispatch.mock.calls[0][0].replyOptions;

beforeEach(() => {
  _clearKnownBots();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("#172 DM reply delivery mode", () => {
  it("DM without configured visibleReplies → injects sourceReplyDeliveryMode=automatic", async () => {
    installFetchStub();
    const { dispatch } = installRuntime({});
    await runDm();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(replyOptionsOf(dispatch)).toEqual({ sourceReplyDeliveryMode: "automatic" });
  });

  it("DM with explicit messages.visibleReplies=message_tool → NOT overridden ({})", async () => {
    installFetchStub();
    const { dispatch } = installRuntime({ messages: { visibleReplies: "message_tool" } });
    await runDm();
    expect(replyOptionsOf(dispatch)).toEqual({});
  });

  it("DM with explicit messages.visibleReplies=automatic → not injected, left to host ({})", async () => {
    installFetchStub();
    const { dispatch } = installRuntime({ messages: { visibleReplies: "automatic" } });
    await runDm();
    expect(replyOptionsOf(dispatch)).toEqual({});
  });

  it("DM ignores groupChat.visibleReplies → still injects automatic (DM only reads messages.visibleReplies)", async () => {
    // The host DM branch resolves off messages.visibleReplies ?? defaultVisibleReplies
    // and never consults groupChat, so a DM with only groupChat configured is
    // still "unconfigured" for DM purposes. Also exercises the optional-chain
    // path where `messages` exists but `visibleReplies` is absent.
    installFetchStub();
    const { dispatch } = installRuntime({ messages: { groupChat: { visibleReplies: "message_tool" } } });
    await runDm();
    expect(replyOptionsOf(dispatch)).toEqual({ sourceReplyDeliveryMode: "automatic" });
  });

  it("group → never injects automatic ({})", async () => {
    installFetchStub();
    const { dispatch } = installRuntime({});
    await runGroup();
    expect(replyOptionsOf(dispatch)).toEqual({});
  });

  it("group with groupChat.visibleReplies=message_tool → preserved, not overridden ({})", async () => {
    installFetchStub();
    const { dispatch } = installRuntime({ messages: { groupChat: { visibleReplies: "message_tool" } } });
    await runGroup();
    expect(replyOptionsOf(dispatch)).toEqual({});
  });

  // Plugin delivery-callback regression (NOT evidence that automatic makes the
  // host settle — that is a host-side behaviour verified only on a real Codex
  // runtime). Confirms the deliver callback still routes a final text send.
  it("plugin delivery callback: final text is sent to the Octo API", async () => {
    installFetchStub();
    const sends: any[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/sendMessage")) {
        sends.push(init?.body ? JSON.parse(init.body) : {});
        return new Response(JSON.stringify({ message_id: "r1", message_seq: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return (origFetch as any)(input, init);
    }) as unknown as typeof fetch;
    const { dispatch } = installRuntime({}, /* deliver */ true);
    await runDm();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(sends.some((b) => typeof b?.payload?.content === "string" && b.payload.content.includes("hi"))).toBe(true);
  });
});
