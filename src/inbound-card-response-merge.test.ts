import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleInboundMessage } from "./inbound.js";
import {
  registerCardProgress,
  setCardContext,
  _resetCardProgressForTests,
} from "./card-progress.js";
import { setOctoRuntime } from "./runtime.js";
import { _clearKnownBots } from "./bot-registry.js";
import { _clearOwnerRegistry, registerOwnerUid } from "./owner-registry.js";
import { ChannelType, MessageType } from "./types.js";
import type { ResolvedOctoAccount } from "./accounts.js";

const API = "http://octo.test";
const BOT_UID = "bot_self_0000000000000000000000000000";
const HUMAN_UID = "human_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GROUP_ID = "g_room_1";
const originalFetch = globalThis.fetch;
const originalMergeFlag = process.env.OCTO_CARD_MERGE_FINAL;

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
      content: "分析渠道 B",
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

function installFetchStub() {
  const sends: Array<Record<string, unknown>> = [];
  const edits: Array<Record<string, unknown>> = [];
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
        elements: ["TextBlock", "RichTextBlock", "Container", "ColumnSet", "ActionSet"],
        actions: ["Action.ToggleVisibility"],
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
      sends.push(body);
      const payload = body.payload as { type?: number } | undefined;
      return json({ message_id: payload?.type === 17 ? "progress-message" : "text-message", message_seq: 0 });
    }
    return json({});
  }) as typeof fetch;
  return { sends, edits };
}

function installRuntime(
  hooks: Record<string, (event: unknown, ctx: unknown) => unknown>,
  finalText: string,
  opts: {
    reasoningText?: string;
    reasoningDelivery?: "stream" | "dispatcher";
    reasoningVisibility?: "off" | "on" | "stream";
    captureReasoningCallback?: (callback: (payload: {
      text?: string;
      isReasoningSnapshot?: boolean;
    }) => void) => void;
  } = {},
) {
  setOctoRuntime({
    config: {
      loadConfig: () => opts.reasoningVisibility && opts.reasoningVisibility !== "off"
        ? { agents: { defaults: { reasoningDefault: opts.reasoningVisibility } } }
        : {},
    },
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async (args: any) => {
          if (opts.captureReasoningCallback) {
            opts.captureReasoningCallback(args.replyOptions.onReasoningStream);
            return;
          }
          const hookCtx = opts.reasoningText
            ? { sessionKey: "sk-merge", runId: "run-merge" }
            : { sessionKey: "sk-merge" };
          if (opts.reasoningText) {
            hooks.before_agent_run({}, hookCtx);
            hooks.model_call_started({ callId: "call-merge" }, hookCtx);
            if (opts.reasoningDelivery === "dispatcher") {
              await args.dispatcherOptions.deliver({
                text: opts.reasoningText,
                isReasoning: true,
                isReasoningSnapshot: true,
              }, { kind: "block" });
            } else {
              await args.replyOptions.onReasoningStream({
                text: opts.reasoningText,
                isReasoningSnapshot: true,
              });
            }
          }
          hooks.before_tool_call({ toolName: "read", toolCallId: "read-1" }, hookCtx);
          await new Promise((resolve) => setTimeout(resolve, 850));
          hooks.after_tool_call(
            {
              toolName: "read",
              toolCallId: "read-1",
              durationMs: 20,
              result: { details: { status: "completed" } },
            },
            hookCtx,
          );
          await args.dispatcherOptions.deliver({ text: finalText }, { kind: "final" });
        },
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: any) => body,
        finalizeInboundContext: (ctx: any) => ctx,
      },
      routing: {
        resolveAgentRoute: () => ({ agentId: "agent1", sessionKey: "sk-merge", accountId: "acct1" }),
      },
      session: {
        resolveStorePath: () => "/tmp/store",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: async () => {},
      },
    },
  } as any);
}

async function runInbound() {
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
}

describe("inbound final response progress-card merge", () => {
  beforeEach(() => {
    _clearKnownBots();
    _clearOwnerRegistry();
    registerOwnerUid("acct1", HUMAN_UID);
    _resetCardProgressForTests();
    process.env.OCTO_CARD_MERGE_FINAL = "1";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _clearOwnerRegistry();
    _resetCardProgressForTests();
    vi.restoreAllMocks();
    if (originalMergeFlag === undefined) delete process.env.OCTO_CARD_MERGE_FINAL;
    else process.env.OCTO_CARD_MERGE_FINAL = originalMergeFlag;
  });

  it("edits the visible progress card with the final text instead of sending a second text message", async () => {
    const { sends, edits } = installFetchStub();
    const hooks = collectCardHooks();
    const finalText = "结论\n\n渠道 B 的下降主要来自权益认知不足。";
    installRuntime(hooks, finalText);
    await runInbound();

    const cardSends = sends.filter((body) => (body.payload as { type?: number } | undefined)?.type === 17);
    const textSends = sends.filter((body) => (body.payload as { type?: number } | undefined)?.type === 1);
    expect(cardSends).toHaveLength(1);
    expect(textSends).toHaveLength(0);
    expect(edits).toHaveLength(1);
    expect(edits[0].message_id).toBe("progress-message");
    const contentEdit = JSON.parse(edits[0].content_edit as string);
    expect(contentEdit.transient).toBeUndefined();
    expect(JSON.stringify(contentEdit.card)).toContain("渠道 B 的下降主要来自权益认知不足");
  });

  it("captures reasoning snapshots in the progress card without sending a reasoning text message", async () => {
    const { sends } = installFetchStub();
    const hooks = collectCardHooks();
    installRuntime(hooks, "最终结论", {
      reasoningText: "先核对渠道数据，再给出结论。",
      reasoningVisibility: "stream",
    });

    await runInbound();

    const cardSends = sends.filter((body) => (body.payload as { type?: number } | undefined)?.type === 17);
    const textSends = sends.filter((body) => (body.payload as { type?: number } | undefined)?.type === 1);
    expect(cardSends).toHaveLength(1);
    expect(textSends).toHaveLength(0);
    const card = (cardSends[0]?.payload as { card: Record<string, unknown> }).card;
    expect(JSON.stringify(card)).toContain("先核对渠道数据，再给出结论。");
    expect(JSON.stringify(card)).toContain("read");
  });

  it.each(["stream", "dispatcher"] as const)(
    "keeps %s reasoning payloads out of progress cards when visibility is off",
    async (reasoningDelivery) => {
      const { sends } = installFetchStub();
      const hooks = collectCardHooks();
      installRuntime(hooks, "最终结论", {
        reasoningText: `MUST STAY HIDDEN FROM ${reasoningDelivery}`,
        reasoningDelivery,
        reasoningVisibility: "off",
      });

      await runInbound();

      const cardSend = sends.find((body) =>
        (body.payload as { type?: number } | undefined)?.type === 17);
      expect(cardSend).toBeTruthy();
      expect(JSON.stringify(cardSend?.payload)).not.toContain("MUST STAY HIDDEN");
      const textSends = sends.filter((body) =>
        (body.payload as { type?: number } | undefined)?.type === 1);
      expect(textSends).toHaveLength(0);
    },
  );

  it("drops a late reasoning callback after the session entry generation is replaced", async () => {
    const { sends } = installFetchStub();
    const hooks = collectCardHooks();
    let staleCapture: ((payload: { text?: string; isReasoningSnapshot?: boolean }) => void) | undefined;
    installRuntime(hooks, "", {
      reasoningVisibility: "stream",
      captureReasoningCallback: (callback) => { staleCapture = callback; },
    });
    await runInbound();
    expect(staleCapture).toBeTypeOf("function");

    setCardContext("sk-merge", {
      apiUrl: API,
      botToken: "tok",
      channelId: GROUP_ID,
      channelType: ChannelType.Group,
      reasoningVisibility: "off",
    });
    const currentRun = { sessionKey: "sk-merge", runId: "run-current" };
    hooks.before_agent_run({}, currentRun);
    staleCapture!({ text: "STALE TURN MUST NOT LEAK", isReasoningSnapshot: true });
    hooks.before_tool_call({ toolName: "read", toolCallId: "read-current" }, currentRun);
    await new Promise((resolve) => setTimeout(resolve, 850));

    const cardSend = sends.find((body) =>
      (body.payload as { type?: number } | undefined)?.type === 17);
    expect(cardSend).toBeTruthy();
    expect(JSON.stringify(cardSend?.payload)).not.toContain("STALE TURN MUST NOT LEAK");
  });

  it("keeps mention-bearing final text on the normal message path", async () => {
    const { sends } = installFetchStub();
    installRuntime(collectCardHooks(), "请看，@Alice 的渠道结论。");

    await runInbound();

    const textSends = sends.filter((body) => (body.payload as { type?: number } | undefined)?.type === 1);
    expect(textSends).toHaveLength(1);
    expect((textSends[0].payload as { content?: string }).content).toContain("@Alice");
  });
});
