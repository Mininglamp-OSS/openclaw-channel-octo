import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleInboundMessage } from "./inbound.js";
import { setOctoRuntime } from "./runtime.js";
import { _clearKnownBots } from "./bot-registry.js";
import { docTaskSessionScope, parseDocCommentMention, synthesizeDocMentionMessage } from "./doc-mention.js";
import type { ResolvedOctoAccount } from "./accounts.js";

/**
 * 失败路径的出站不变量。
 *
 * 本特性的核心承诺是「文档任务的任何输出都不进 IM」,但 PR #195 首版只在成功路径
 * 做到了:dispatcher 的 onError / 超时 / 拒绝三条兜底,以及 media 投递,都直接
 * sendMessage 到合成消息的 DM channel(= 发起人私聊)。评论区反而什么都没有 ——
 * 失败恰恰是最需要反馈的时候,却同时踩中「污染」和「无痕迹」。
 *
 * 每条用例断言两半:IM 出站为 0 **且** 评论区收到一条。只断言前者会漏掉静默丢弃。
 */

const API = "http://octo.test";
const BOT_UID = "bot_self_0000000000000000000000000000";
const HUMAN_UID = "human_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const originalFetch = globalThis.fetch;

function makeAccount(overrides: Record<string, unknown> = {}): ResolvedOctoAccount {
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
      docTasks: true,
      ...overrides,
    },
  };
}

function makeMention() {
  return parseDocCommentMention({
    event_id: 1001,
    event_type: "doc_comment_mention",
    event_data: {
      idempotency_key: "docs:comment:c1",
      doc_id: "d1",
      comment_id: "77",
      thread_id: "70",
      from_uid: HUMAN_UID,
      bot_uid: BOT_UID,
      text: "把这段绝对化表述改掉",
    },
  })!;
}

/** 捕获所有出站 URL,用于断言 IM 出口零调用。 */
function installFetchStub(): string[] {
  const urls: string[] = [];
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.includes("/messages/sync")) return json({ messages: [] });
    if (url.includes("/sendMessage")) return json({ message_id: "r1", message_seq: 0 });
    if (url.includes("presigned")) return json({ url: `${API}/upload`, download_url: `${API}/f/a.png` });
    return json({});
  }) as unknown as typeof fetch;
  return urls;
}

/** IM 出口:文本、媒体上传、媒体消息。文档任务下这些都必须是 0。 */
function imOutbound(urls: string[]): string[] {
  return urls.filter(
    (u) =>
      u.includes("/sendMessage") ||
      u.includes("/sendMediaMessage") ||
      u.includes("presigned") ||
      u.includes("/typing") ||
      u.includes("/readReceipt"),
  );
}

type DispatchDriver = (args: any) => Promise<void>;

function installRuntime(drive: DispatchDriver) {
  const dispatch = vi.fn(drive);
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
        resolveAgentRoute: () => ({ agentId: "agent1", sessionKey: "sk-default", accountId: "acct1" }),
      },
      session: {
        resolveStorePath: () => "/tmp/store",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: async () => {},
      },
    },
  } as any);
  return dispatch;
}

function runDocTask(posted: string[], accountOverrides: Record<string, unknown> = {}) {
  const mention = makeMention();
  return handleInboundMessage({
    account: makeAccount(accountOverrides),
    message: synthesizeDocMentionMessage(mention, BOT_UID) as any,
    botUid: BOT_UID,
    groupHistories: new Map(),
    lastBotReplySeqMap: new Map(),
    memberMap: new Map(),
    uidToNameMap: new Map(),
    groupCacheTimestamps: new Map(),
    log: undefined,
    docTask: {
      docId: mention.docId,
      threadId: mention.threadId,
      sessionScope: docTaskSessionScope(mention),
      postComment: async (text) => { posted.push(text); },
    },
  });
}

beforeEach(() => { _clearKnownBots(); });

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("文档任务:失败路径同样不得触达 IM", () => {
  it("dispatcher onError:道歉进评论区,不进私聊", async () => {
    const urls = installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.onError(new Error("boom"), { kind: "final" });
    });
    const posted: string[] = [];

    await runDocTask(posted);

    expect(imOutbound(urls)).toHaveLength(0);
    expect(posted).toHaveLength(1);
  });

  it("dispatch 直接抛错且无缓冲文本:兜底进评论区,不进私聊", async () => {
    const urls = installFetchStub();
    installRuntime(async () => { throw new Error("dispatch rejected"); });
    const posted: string[] = [];

    // 兜底发出后 handleInboundMessage 会重新抛出(既有行为,由 channel.ts 捕获)
    await expect(runDocTask(posted)).rejects.toThrow("dispatch rejected");

    expect(imOutbound(urls)).toHaveLength(0);
    expect(posted).toHaveLength(1);
  });

  it("dispatch 超时:超时提示进评论区,不进私聊", async () => {
    const urls = installFetchStub();
    installRuntime(async () => { await new Promise((resolve) => setTimeout(resolve, 5_000)); });
    const posted: string[] = [];

    // dispatchTimeoutMs 下限由 resolveDispatchTimeoutMs 决定,给一个足够小的值触发超时
    await runDocTask(posted, { dispatchTimeoutMs: 1000 }).catch(() => {});

    expect(imOutbound(urls)).toHaveLength(0);
    expect(posted).toHaveLength(1);
  }, 20_000);

  it("agent 产出 media:不得上传/发送到私聊", async () => {
    const urls = installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver(
        { text: "改好了", mediaUrls: [`${API}/f/a.png`] },
        { kind: "final" },
      );
    });
    const posted: string[] = [];

    await runDocTask(posted);

    expect(imOutbound(urls)).toHaveLength(0);
    expect(posted.length).toBeGreaterThanOrEqual(1);
  });
});
