/**
 * P1-2 regression: a turn that failed must stay failed on the progress card, even
 * when the agent already delivered something through the `message` tool.
 *
 * `replySucceeded === false` conflates two states — "no deliverable final text"
 * (which tool delivery legitimately compensates for) and "this turn errored".
 * inbound.ts must hand the failure reason to finalizeCard so the delivery
 * evidence cannot launder it into a green card while the user is being sent an
 * apology message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleInboundMessage } from "./inbound.js";
import {
  registerCardProgress,
  _resetCardProgressForTests,
} from "./card-progress.js";
import { setOctoRuntime } from "./runtime.js";
import { _clearKnownBots } from "./bot-registry.js";
import { _clearOwnerRegistry, registerOwnerUid } from "./owner-registry.js";
import { ChannelType, MessageType } from "./types.js";
import type { ResolvedOctoAccount } from "./accounts.js";

const sessionStoreMocks = vi.hoisted(() => ({
  getSessionEntry: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => sessionStoreMocks);

const API = "http://octo-failure.test";
const BOT_UID = "bot_self_0000000000000000000000000000";
const HUMAN_UID = "human_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GROUP_ID = "g_failure_1";
const SESSION_KEY = "sk-failure";
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

function makeMessage() {
  return {
    message_id: "m1",
    message_seq: 100,
    from_uid: HUMAN_UID,
    channel_id: GROUP_ID,
    channel_type: ChannelType.Group,
    timestamp: Math.floor(Date.now() / 1000),
    payload: {
      type: MessageType.Text,
      content: "跑一下",
      mention: { uids: [BOT_UID] },
    },
  };
}

function collectCardHooks(): Record<string, (event: unknown, ctx: unknown) => unknown> {
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  registerCardProgress({
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers[name] = handler;
    },
  } as never);
  return handlers;
}

function installFetchStub(opts: { failPlainSend?: boolean } = {}) {
  const edits: Array<Record<string, unknown>> = [];
  const texts: string[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

    if (url.includes("/card/profile")) {
      return json({
        enabled: true,
        profiles: ["octo/v1"],
        card_version: "1.5",
        elements: ["TextBlock", "RichTextBlock", "Container", "ColumnSet"],
      });
    }
    if (url.includes("/members")) {
      return json({ members: [
        { uid: HUMAN_UID, name: "Alice", robot: false },
        { uid: BOT_UID, name: "SelfBot", robot: true },
      ] });
    }
    if (url.includes("/mention_pref")) return json({ no_mention: false });
    if (url.includes("/md")) return json({ content: "", version: 0, updated_at: null, updated_by: "" });
    if (url.includes("/messages/sync")) return json({ messages: [] });
    if (url.includes("/readReceipt") || url.includes("/typing")) return json({});
    if (url.includes("/message/edit")) {
      edits.push(body);
      return json({});
    }
    if (url.includes("/sendMessage")) {
      const payload = body.payload as { type?: number; content?: string } | undefined;
      if (payload?.type === 17) return json({ message_id: "progress-message", message_seq: 0 });
      if (opts.failPlainSend) return json({ error: { code: "err.server.bot_api.denied" } }, 400);
      texts.push(String(payload?.content ?? ""));
      return json({ message_id: "text-message", message_seq: 0 });
    }
    return json({});
  }) as typeof fetch;
  return { edits, texts };
}

/**
 * The agent delivers an interim note with the `message` tool (so the card gains
 * delivery evidence), and the turn then fails through the dispatcher's onError.
 */
function installRuntime(
  hooks: Record<string, (event: unknown, ctx: unknown) => unknown>,
  mode: "onError" | "swallowed-final-send" = "onError",
) {
  setOctoRuntime({
    config: { loadConfig: () => ({}) },
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async (args: any) => {
          const hookCtx = { sessionKey: SESSION_KEY, runId: "run-failure" };
          hooks.before_agent_run({}, hookCtx);
          hooks.before_tool_call(
            {
              toolName: "message",
              toolCallId: "msg-1",
              params: { action: "send", target: `group:${GROUP_ID}` },
            },
            hookCtx,
          );
          hooks.after_tool_call({ toolName: "message", toolCallId: "msg-1", result: {} }, hookCtx);
          await new Promise((resolve) => setTimeout(resolve, 850));
          if (mode === "onError") {
            await args.dispatcherOptions.onError(new Error("upstream exploded"), { kind: "final" });
            return;
          }
          // 只产出 block 文本 → 由 finally 的 buffered flush 投递,而那次 send 会被打成失败。
          await args.dispatcherOptions.deliver({ text: "缓冲正文" }, { kind: "block" });
        },
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: any) => body,
        finalizeInboundContext: (ctx: any) => ctx,
      },
      routing: {
        resolveAgentRoute: () => ({ agentId: "agent1", sessionKey: SESSION_KEY, accountId: "acct1" }),
      },
      session: {
        resolveStorePath: () => "/tmp/store",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: async () => {},
      },
    },
  } as any);
}

describe("inbound progress-card failure precedence", () => {
  beforeEach(() => {
    sessionStoreMocks.getSessionEntry.mockReset();
    sessionStoreMocks.getSessionEntry.mockReturnValue(undefined);
    _clearKnownBots();
    _clearOwnerRegistry();
    registerOwnerUid("acct1", HUMAN_UID);
    _resetCardProgressForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _clearOwnerRegistry();
    _resetCardProgressForTests();
    vi.restoreAllMocks();
  });

  it("keeps the card in the error state when the turn failed after a tool delivery", async () => {
    const { edits, texts } = installFetchStub();
    const hooks = collectCardHooks();
    installRuntime(hooks);

    await handleInboundMessage({
      account: makeAccount(),
      message: makeMessage() as any,
      botUid: BOT_UID,
      groupHistories: new Map(),
      lastBotReplySeqMap: new Map(),
      memberMap: new Map(),
      uidToNameMap: new Map(),
      groupCacheTimestamps: new Map(),
    });

    // The user was told the turn failed…
    expect(texts.some((t) => t.includes("遇到了问题"))).toBe(true);

    // …so the card must not claim success on the strength of the tool delivery.
    const terminal = edits.at(-1);
    expect(terminal).toBeTruthy();
    const card = JSON.parse(terminal!.content_edit as string).card as {
      body: Array<Record<string, unknown>>;
    };
    const header = String((card.body[0] as { text?: string }).text
      ?? JSON.stringify(card.body[0]));
    expect(header).toContain("Interrupted");
    expect(header).not.toContain("Done");
  });
  it("keeps the card in the error state when the buffered final send failed silently", async () => {
    const { edits, texts } = installFetchStub({ failPlainSend: true });
    const hooks = collectCardHooks();
    installRuntime(hooks, "swallowed-final-send");

    await handleInboundMessage({
      account: makeAccount(),
      message: makeMessage() as any,
      botUid: BOT_UID,
      groupHistories: new Map(),
      lastBotReplySeqMap: new Map(),
      memberMap: new Map(),
      uidToNameMap: new Map(),
      groupCacheTimestamps: new Map(),
    });

    // 回复根本没送出去(Octo API 拒了),只有 catch 里的一条日志。
    expect(texts).toHaveLength(0);
    const terminal = edits.at(-1);
    expect(terminal).toBeTruthy();
    const card = JSON.parse(terminal!.content_edit as string).card as {
      body: Array<Record<string, unknown>>;
    };
    const header = String((card.body[0] as { text?: string }).text
      ?? JSON.stringify(card.body[0]));
    expect(header).toContain("Interrupted");
    expect(header).not.toContain("Done");
  });
});
