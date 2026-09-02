import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType, MessageType } from "./types.js";
import { handleInboundMessage } from "./inbound.js";
import { setOctoRuntime } from "./runtime.js";
import { registerKnownBot, _clearKnownBots } from "./bot-registry.js";
import { _clearMentionPrefCache, _setMentionPrefEntry } from "./mention-prefs.js";
import type { ResolvedOctoAccount } from "./accounts.js";

/**
 * Regression guard for #68 — "inbound routing 用 stale cfg 引用, CLI 改 bindings
 * 后必须重启 gateway 才生效".
 *
 * Root cause back then: inbound fed `resolveAgentRoute` the cfg reference it had
 * captured at channel start. OpenClaw's routing layer memoizes per config object
 * (`WeakMap<OpenClawConfig, ...>`), so a stale reference kept returning the old
 * route forever — a new `openclaw agents bind` only took effect after a gateway
 * restart.
 *
 * The invariant that fixes it: inbound must ask the runtime for the config on
 * EVERY message and pass that through, never a captured one. Nothing tested that
 * invariant, which made it quietly vulnerable to any refactor of the config
 * reads — including the 2026.8 migration from the removed `config.loadConfig()`
 * to `config.current()`, which touched all four of them.
 *
 * These tests pin the observable behaviour rather than the call shape: after the
 * runtime's config changes (a hot reload swapping in a new object), the very next
 * message must be routed with the NEW config.
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
  } as unknown as ResolvedOctoAccount;
}

function makeTextMessage(seq: number, id: string) {
  return {
    message_id: id,
    message_seq: seq,
    from_uid: HUMAN_UID,
    channel_id: GROUP_ID,
    channel_type: ChannelType.Group,
    timestamp: Math.floor(Date.now() / 1000),
    payload: { type: MessageType.Text, content: "hello bot" },
  };
}

/**
 * Runtime stub whose config snapshot can be swapped between messages, standing
 * in for a gateway hot reload. Records every cfg object handed to
 * resolveAgentRoute so we can assert which one routing actually saw.
 */
function installRuntimeStub() {
  let snapshot: Record<string, unknown> = { marker: "initial" };
  const currentCalls = { count: 0 };
  const routedWith: unknown[] = [];

  const dispatch = vi.fn(async (args: any) => {
    await args.dispatcherOptions.deliver({ text: "hi" }, { kind: "final" });
  });

  setOctoRuntime({
    config: {
      current: () => {
        currentCalls.count += 1;
        return snapshot;
      },
    },
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: dispatch,
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: any) => body,
        finalizeInboundContext: (ctx: any) => ctx,
      },
      routing: {
        resolveAgentRoute: (args: any) => {
          routedWith.push(args?.cfg);
          return { agentId: "agent1", sessionKey: "sk1", accountId: "acct1" };
        },
      },
      session: {
        resolveStorePath: () => "/tmp/store",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: async () => {},
      },
    },
  } as any);

  return {
    dispatch,
    routedWith,
    currentCalls,
    /** Stand in for a hot reload: the runtime now hands out a different object. */
    swapConfig: (next: Record<string, unknown>) => {
      snapshot = next;
    },
    getSnapshot: () => snapshot,
  };
}

function installFetchStub() {
  const sends: any[] = [];
  globalThis.fetch = vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

    if (url.includes("/members")) {
      return json({ members: [{ uid: HUMAN_UID, name: "Alice", robot: false }] });
    }
    if (url.includes("/mention_pref")) return json({ no_mention: true });
    if (url.includes("/md")) return json({ content: "", version: 0, updated_at: null, updated_by: "" });
    if (url.includes("/messages/sync")) return json({ messages: [] });
    if (url.includes("/sendMessage")) {
      sends.push(init?.body ? JSON.parse(init.body) : {});
      return json({ message_id: "reply1", message_seq: 0 });
    }
    return json({});
  }) as unknown as typeof fetch;
  return { sends };
}

function inbound(message: unknown) {
  return handleInboundMessage({
    account: makeAccount(),
    message: message as never,
    botUid: BOT_UID,
    groupHistories: new Map(),
    lastBotReplySeqMap: new Map(),
    memberMap: new Map(),
    uidToNameMap: new Map(),
    groupCacheTimestamps: new Map(),
  });
}

describe("#68 — inbound must route with a freshly read config, never a captured one", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _clearKnownBots();
    _clearMentionPrefCache();
    registerKnownBot(BOT_UID);
    _setMentionPrefEntry("acct1", GROUP_ID, { no_mention: true });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    _clearKnownBots();
    _clearMentionPrefCache();
  });

  it("routes the next message with the config the runtime now reports, not the earlier one", async () => {
    const rt = installRuntimeStub();
    installFetchStub();

    await inbound(makeTextMessage(100, "m1"));
    const firstCfg = rt.routedWith.at(-1);
    expect(firstCfg).toBe(rt.getSnapshot());

    // A gateway hot reload swaps in a new config object (e.g. `openclaw agents
    // bind` just added a binding). Routing memoizes per object identity, so the
    // next message MUST carry this new one or the new binding stays invisible.
    const reloaded = { marker: "after-hot-reload" };
    rt.swapConfig(reloaded);

    await inbound(makeTextMessage(200, "m2"));
    const secondCfg = rt.routedWith.at(-1);

    expect(secondCfg).toBe(reloaded);
    expect(secondCfg).not.toBe(firstCfg);
  });

  it("asks the runtime for the config on every message rather than caching it", async () => {
    const rt = installRuntimeStub();
    installFetchStub();

    await inbound(makeTextMessage(100, "m1"));
    const afterFirst = rt.currentCalls.count;
    expect(afterFirst).toBeGreaterThan(0);

    await inbound(makeTextMessage(200, "m2"));
    expect(rt.currentCalls.count).toBeGreaterThan(afterFirst);
  });
});
