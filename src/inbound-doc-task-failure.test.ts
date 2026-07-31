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

function installRuntime(drive: DispatchDriver, openClawConfig: Record<string, unknown> = {}) {
  const dispatch = vi.fn(drive);
  setOctoRuntime({
    config: { loadConfig: () => openClawConfig },
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

/** 记录每条评论的性质 —— `notice` 不代表任务做成,handler 靠它决定要不要写去重。 */
type PostedComment = { text: string; kind: string };

function runDocTask(
  posted: string[],
  accountOverrides: Record<string, unknown> = {},
  sinks: { comments?: PostedComment[]; log?: { error?: (m: string) => void } } = {},
) {
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
    log: sinks.log as any,
    docTask: {
      docId: mention.docId,
      threadId: mention.threadId,
      sessionScope: docTaskSessionScope(mention),
      postComment: async (text, _signal, opts) => {
        posted.push(text);
        sinks.comments?.push({ text, kind: opts?.kind ?? "work" });
      },
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

  it("agent 只产出 media、没有文本:附件必须发进评论区,不能一条都不发", async () => {
    // 回归:附件原先只在「有文本可发」时才随评论带出去,纯 media 回合会一条评论
    // 都不产生,任务却被记为成功 —— 评论区静默且永不重试。
    const urls = installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ mediaUrls: [`${API}/f/a.png`] }, { kind: "final" });
    });
    const posted: string[] = [];

    await runDocTask(posted);

    expect(imOutbound(urls)).toHaveLength(0);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(`[附件] ${API}/f/a.png`);
  });
});

describe("文档任务:最终答复的投递模式不受 messages.visibleReplies 影响", () => {
  // 回归:文档任务是一条合成 DM,原先跟着「DM 且运维未配置 visibleReplies 才请求
  // automatic」那条规则走。于是运维一旦显式配了 messages.visibleReplies:"message_tool",
  // 最终文本就不再经 deliver() 出来 —— 评论区只剩兜底提示,事件却照样 ack;而 agent
  // 真去调 message tool 的话,输出又落回 IM,正是本特性要消除的污染。
  it("显式配置 message_tool 时仍请求 automatic,最终答复照样进评论区", async () => {
    const urls = installFetchStub();
    const dispatch = installRuntime(
      async (args) => {
        expect(args.replyOptions?.sourceReplyDeliveryMode).toBe("automatic");
        await args.dispatcherOptions.deliver({ text: "已按要求改好" }, { kind: "final" });
      },
      { messages: { visibleReplies: "message_tool" } },
    );
    const posted: string[] = [];
    const comments: PostedComment[] = [];

    await runDocTask(posted, {}, { comments });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0] as any)[0].replyOptions.sourceReplyDeliveryMode).toBe("automatic");
    expect(imOutbound(urls)).toHaveLength(0);
    expect(comments).toEqual([{ text: "已按要求改好", kind: "work" }]);
  });

  it("非文档任务的 DM 不受影响:显式配置仍然被尊重", async () => {
    // 反向守卫:上面的例外只能对文档任务生效,不能顺手覆盖运维对普通 DM 的设置。
    installFetchStub();
    const dispatch = installRuntime(async () => {}, { messages: { visibleReplies: "message_tool" } });
    const mention = makeMention();

    await handleInboundMessage({
      account: makeAccount(),
      message: synthesizeDocMentionMessage(mention, BOT_UID) as any,
      botUid: BOT_UID,
      groupHistories: new Map(),
      lastBotReplySeqMap: new Map(),
      memberMap: new Map(),
      uidToNameMap: new Map(),
      groupCacheTimestamps: new Map(),
      log: undefined,
    });

    expect((dispatch.mock.calls[0] as any)[0].replyOptions.sourceReplyDeliveryMode).toBeUndefined();
  });
});

describe("文档任务:提示不得被当成产出", () => {
  // 回归:三处兜底(onError / 超时 / dispatch 拒绝)都经同一投递通道,原先不带任何
  // 标记 —— handler 于是把「只发出一句道歉」的回合记成投递成功。onError 路径
  // dispatcher 还会正常 resolve(outcome=completed),三个条件全满足 → 写入持久去重
  // → 文档一个字没改,事件却被永久吸收,再也不会重投。
  it("onError 的道歉标记为 notice,不是产出", async () => {
    installFetchStub();
    installRuntime(async (args) => { await args.dispatcherOptions.onError(new Error("boom"), { kind: "final" }); });
    const posted: string[] = [];
    const comments: PostedComment[] = [];

    await runDocTask(posted, {}, { comments });

    expect(comments).toHaveLength(1);
    expect(comments[0].kind).toBe("notice");
  });

  it("超时提示标记为 notice,不是产出", async () => {
    installFetchStub();
    installRuntime(async () => { await new Promise((resolve) => setTimeout(resolve, 5_000)); });
    const posted: string[] = [];
    const comments: PostedComment[] = [];

    await runDocTask(posted, { dispatchTimeoutMs: 1000 }, { comments }).catch(() => {});

    expect(comments).toHaveLength(1);
    expect(comments[0].kind).toBe("notice");
  }, 20_000);

  it("dispatch 拒绝的兜底标记为 notice,不是产出", async () => {
    installFetchStub();
    installRuntime(async () => { throw new Error("dispatch rejected"); });
    const posted: string[] = [];
    const comments: PostedComment[] = [];

    await expect(runDocTask(posted, {}, { comments })).rejects.toThrow("dispatch rejected");

    expect(comments).toHaveLength(1);
    expect(comments[0].kind).toBe("notice");
  });

  it("正常答复不带标记 → 按产出记账", async () => {
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ text: "已按要求改好" }, { kind: "final" });
    });
    const posted: string[] = [];
    const comments: PostedComment[] = [];

    await runDocTask(posted, {}, { comments });

    expect(comments).toEqual([{ text: "已按要求改好", kind: "work" }]);
  });
});

describe("文档任务:IM 出站闸门不应在正常路径上被触发", () => {
  // 闸门是兜底。它被触发说明某个出站点绕过了显式守卫 —— 那是清单漏项的信号,
  // 不是常态。这条测试保证显式守卫本身没有退化成「反正闸门会拦」。
  it("成功路径上没有任何出站被闸门拦下", async () => {
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ text: "已按要求改好" }, { kind: "final" });
    });
    const errors: string[] = [];
    const posted: string[] = [];

    await runDocTask(posted, {}, { log: { error: (m) => errors.push(m) } });

    expect(errors.filter((e) => e.includes("IM egress"))).toEqual([]);
  });
});
