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

/**
 * IM 出口:文本、媒体(走的也是 /v1/bot/sendMessage,所以旧版那条
 * `/sendMediaMessage` 过滤永远匹配不上)、上传预签名、typing、已读回执,
 * 以及卡片编辑 `/v1/bot/message/edit` —— 后者是 editCardMessage /
 * editTemplateCardMessage 的落点,此前完全不在断言范围内。
 */
function imOutbound(urls: string[]): string[] {
  return urls.filter(
    (u) =>
      u.includes("/sendMessage") ||
      u.includes("/message/edit") ||
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

/** 本回合上报的事实 —— handler 据此各自决定「写不写去重」和「补不补兜底」。 */
type Reported = { finalDelivered: boolean; delivered: boolean; lost: boolean; noticed: boolean };

function runDocTask(
  posted: string[],
  accountOverrides: Record<string, unknown> = {},
  sinks: {
    reports?: Reported[];
    log?: { error?: (m: string) => void };
    postComment?: (text: string) => Promise<void>;
  } = {},
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
      postComment: sinks.postComment ?? (async (text) => { posted.push(text); }),
      reportTurn: (report) => { sinks.reports?.push(report); },
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
    const reports: Reported[] = [];

    await runDocTask(posted, {}, { reports });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0] as any)[0].replyOptions.sourceReplyDeliveryMode).toBe("automatic");
    expect(imOutbound(urls)).toHaveLength(0);
    expect(posted).toEqual(["已按要求改好"]);
    expect(reports).toEqual([{ finalDelivered: true, delivered: true, lost: false, noticed: false }]);
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

describe("文档任务:回合只上报事实,不预先归纳成结论", () => {
  // 回归:上一版把结论压成三值枚举(work-delivered / notice-only / nothing),
  // 值域里没有「活儿落地了 **并且** 另外出了岔子」这一格。于是「答复已送达、之后
  // dispatch 又抛错」被判成 nothing —— 在正确答复下面再贴一条「没有完成、也没有
  // 产生任何修改，请重新 @ 我」,用户照做就把改文档的任务再跑一遍。
  const report = (over: Partial<Reported> = {}): Reported => ({
    finalDelivered: false, delivered: false, lost: false, noticed: false, ...over,
  });

  it("正常答复:final + delivered", async () => {
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ text: "已按要求改好" }, { kind: "final" });
    });
    const reports: Reported[] = [];
    const posted: string[] = [];

    await runDocTask(posted, {}, { reports });

    expect(reports).toEqual([report({ finalDelivered: true, delivered: true })]);
    expect(posted).toEqual(["已按要求改好"]);
  });

  it("答复送达之后 dispatch 才抛错:仍然是 finalDelivered —— 活儿落地了", async () => {
    // Jerry-Xin 和 yujiawei 独立复现的同一格。inbound 的 !replySucceeded 守卫
    // 已经正确地不发道歉了,坏在下游把它判成了「什么都没发生」。
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ text: "已改好，diff 见版本记录" }, { kind: "final" });
      throw new Error("non_deliverable_terminal_turn");
    });
    const reports: Reported[] = [];
    const posted: string[] = [];

    await expect(runDocTask(posted, {}, { reports })).rejects.toThrow("non_deliverable_terminal_turn");

    expect(posted).toEqual(["已改好，diff 见版本记录"]); // 没有多出一条自相矛盾的道歉
    expect(reports).toEqual([report({ finalDelivered: true, delivered: true })]);
  });

  it("答复送达之后 onError 才触发:不得追加自相矛盾的失败提示", async () => {
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ text: "已按要求改好" }, { kind: "final" });
      await args.dispatcherOptions.onError(new Error("late error"), { kind: "final" });
    });
    const reports: Reported[] = [];
    const posted: string[] = [];

    await runDocTask(posted, {}, { reports });

    expect(posted).toEqual(["已按要求改好"]);
    expect(reports).toEqual([report({ finalDelivered: true, delivered: true })]);
  });

  it("答复送达之后才超时:不再追发超时提示,回合仍算落地", async () => {
    // 超时分支原先无条件道歉,而它的兄弟分支(dispatch rejected)有 !replySucceeded
    // 守卫且注释写明了理由。少这一层,一个已经答复完的回合会被一句道歉拖成未完成。
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ text: "已按要求改好" }, { kind: "final" });
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    });
    const reports: Reported[] = [];
    const posted: string[] = [];

    await runDocTask(posted, { dispatchTimeoutMs: 1000 }, { reports }).catch(() => {});

    expect(posted).toEqual(["已按要求改好"]);
    expect(reports[reports.length - 1]).toEqual(report({ finalDelivered: true, delivered: true }));
  }, 20_000);

  it("先发出进度、再道歉:finalDelivered 为假 —— 进度不是答复", async () => {
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ text: "正在读取文档…" }, { kind: "tool" });
      await args.dispatcherOptions.onError(new Error("boom"), { kind: "final" });
    });
    const reports: Reported[] = [];
    const posted: string[] = [];

    await runDocTask(posted, {}, { reports });

    expect(posted).toHaveLength(2);
    expect(reports).toEqual([report({ delivered: true, noticed: true })]);
  });

  it("onError / dispatch 拒绝:noticed", async () => {
    installFetchStub();
    installRuntime(async (args) => { await args.dispatcherOptions.onError(new Error("boom"), { kind: "final" }); });
    const reports: Reported[] = [];

    await runDocTask([], {}, { reports });

    expect(reports).toEqual([report({ delivered: true, noticed: true })]);
  });

  it("答复发丢:finalDelivered 为假 —— 它由出站收口在 POST 成功之后才置位", async () => {
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ text: "已按要求改好" }, { kind: "final" });
    });
    const reports: Reported[] = [];
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
      docTask: {
        docId: mention.docId,
        threadId: mention.threadId,
        sessionScope: docTaskSessionScope(mention),
        postComment: async () => { throw new Error("docs API 503"); },
        reportTurn: (r) => { reports.push(r); },
      },
    });

    // 关键:不是「置真再用 !lost 补偿」。补偿是回合全局的,一次进度评论的瞬时 5xx
    // 就会否决掉一个确实落地的答复(见下一条用例)。
    expect(reports).toEqual([report({ lost: true })]);
  });

  it("只发 block 的回合:缓冲文本刷出去后必须算 finalDelivered", async () => {
    // 回归(三位 reviewer 独立发现):block 文本经最外层 finally 刷出去时只置
    // replySucceeded,不置最终答复标志。于是 agent 用 block 形式作答的回合上报
    // finalDelivered:false → handler 判「用户在干等」→ 在正确答复下面贴一条
    // 「本次文档任务没有给出答复」并且不写去重 —— 重投会把文档改第二遍。
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ text: "已按要求改好（块式答复）" }, { kind: "block" });
    });
    const reports: Reported[] = [];
    const posted: string[] = [];

    await runDocTask(posted, {}, { reports });

    expect(posted).toEqual(["已按要求改好（块式答复）"]);
    expect(reports).toEqual([report({ finalDelivered: true, delivered: true })]);
  });

  it("block 缓冲后 dispatch 拒绝:刷出去的仍是最终答复", async () => {
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ text: "已按要求改好（块式答复）" }, { kind: "block" });
      throw new Error("non_deliverable_terminal_turn");
    });
    const reports: Reported[] = [];
    const posted: string[] = [];

    await expect(runDocTask(posted, {}, { reports })).rejects.toThrow("non_deliverable_terminal_turn");

    expect(posted).toEqual(["已按要求改好（块式答复）"]); // 没有多出一条道歉
    expect(reports).toEqual([report({ finalDelivered: true, delivered: true })]);
  });

  it("进度评论发丢、最终答复发成功:仍算落地 —— lost 不得否决 finalDelivered", async () => {
    // 回归:`workLanded = finalDelivered && !lost` 里的 lost 是回合全局且粘性的,
    // 一次进度评论的瞬时 5xx 就会否决掉一个确实落地的答复,于是在正确答复下面贴出
    // 「没有给出答复」并允许重放。触发条件只是一次 docs 5xx,凡有工具输出的回合都暴露。
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ text: "正在读取文档…" }, { kind: "tool" });
      await args.dispatcherOptions.deliver({ text: "已按要求改好" }, { kind: "final" });
    });
    const reports: Reported[] = [];
    const posted: string[] = [];
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
      docTask: {
        docId: mention.docId,
        threadId: mention.threadId,
        sessionScope: docTaskSessionScope(mention),
        postComment: async (text) => {
          if (text === "正在读取文档…") throw new Error("docs API 503");
          posted.push(text);
        },
        reportTurn: (r) => { reports.push(r); },
      },
    });

    expect(posted).toEqual(["已按要求改好"]); // 只有最终答复落地了,这是对的
    expect(reports).toEqual([report({ finalDelivered: true, delivered: true, lost: true })]);
  });

  it("纯附件也是最终产出:finalDelivered", async () => {
    // 不置位的话这个回合永远拿不到去重记录,重投会把文档改第二遍。
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ mediaUrls: [`${API}/f/a.png`] }, { kind: "final" });
    });
    const reports: Reported[] = [];

    await runDocTask([], {}, { reports });

    expect(reports).toEqual([report({ finalDelivered: true, delivered: true })]);
  });

  it("同一附件先作为中间产出落地、再由空 final 收口:仍算最终答复", async () => {
    // 回归:第一次 deliver 已经把附件 POST 到评论区并抽干队列;第二次 final 重复
    // 同一个 URL 时会被 sentMediaUrls 去重,于是 postDocTaskReply 收到空正文+空队列。
    // 旧逻辑在 if (!body) return 提前退出,吞掉 final 事实,下游便叠加「没有给出答复」
    // 并释放去重键,让改文档任务可以重放。
    installFetchStub();
    installRuntime(async (args) => {
      const mediaUrls = [`${API}/f/a.png`];
      await args.dispatcherOptions.deliver({ mediaUrls }, { kind: "tool" });
      await args.dispatcherOptions.deliver({ mediaUrls }, { kind: "final" });
    });
    const reports: Reported[] = [];
    const posted: string[] = [];

    await runDocTask(posted, {}, { reports });

    expect(posted).toEqual([`[附件] ${API}/f/a.png`]);
    expect(reports).toEqual([report({ finalDelivered: true, delivered: true })]);
  });

  it("附件先落地、随后 buffered 最终文本 POST 失败:不得借前一次成功冒充答复送达", async () => {
    // P1 回归:空 final 先把附件 POST 成功并把回合级 finalDelivered 置真;finally
    // 随后刷新 block 文本时 POST 失败。若 deliverFinalText 返回回合级旧值,失败的
    // 这一次仍会报告 delivered:true,最终写去重且不留失败提示,正文永久静默丢失。
    installFetchStub();
    installRuntime(async (args) => {
      const mediaUrls = [`${API}/f/diff.png`];
      await args.dispatcherOptions.deliver(
        { text: "已按要求改好，正文说明如下", mediaUrls },
        { kind: "block" },
      );
      await args.dispatcherOptions.deliver({ mediaUrls }, { kind: "final" });
    });
    const reports: Reported[] = [];
    const posted: string[] = [];
    let attempt = 0;

    await runDocTask(posted, {}, {
      reports,
      postComment: async (text) => {
        attempt += 1;
        if (attempt === 2) throw new Error("docs API 503");
        posted.push(text);
      },
    });

    expect(posted).toEqual([`[附件] ${API}/f/diff.png`]);
    expect(reports).toEqual([report({ delivered: true, lost: true })]);
  });

  it("连续两个 final:第二个更正答复 POST 失败时最终状态必须失败", async () => {
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ text: "第一版答复" }, { kind: "final" });
      await args.dispatcherOptions.deliver({ text: "更正后的最终答复" }, { kind: "final" });
    });
    const reports: Reported[] = [];
    const posted: string[] = [];
    let attempt = 0;

    await runDocTask(posted, {}, {
      reports,
      postComment: async (text) => {
        attempt += 1;
        if (attempt === 2) throw new Error("docs API 503");
        posted.push(text);
      },
    });

    expect(posted).toEqual(["第一版答复"]);
    expect(reports).toEqual([report({ delivered: true, lost: true })]);
  });

  it("进度文本携带附件、随后无媒体引用的空 final:不能把进度附件洗成最终答复", async () => {
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver(
        { text: "正在生成预览…", mediaUrls: [`${API}/f/preview.png`] },
        { kind: "tool" },
      );
      await args.dispatcherOptions.deliver({}, { kind: "final" });
    });
    const reports: Reported[] = [];
    const posted: string[] = [];

    await runDocTask(posted, {}, { reports });

    expect(posted).toEqual([`正在生成预览…\n\n[附件] ${API}/f/preview.png`]);
    expect(reports).toEqual([report({ delivered: true })]);
  });

  it("只有进度文本落地、随后收到空 final:不能把进度冒充最终答复", async () => {
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ text: "正在读取文档…" }, { kind: "tool" });
      await args.dispatcherOptions.deliver({}, { kind: "final" });
    });
    const reports: Reported[] = [];
    const posted: string[] = [];

    await runDocTask(posted, {}, { reports });

    expect(posted).toEqual(["正在读取文档…"]);
    expect(reports).toEqual([report({ delivered: true })]);
  });

  it("失败提示不得夹带并消费尚未成功投递的附件", async () => {
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ mediaUrls: [`${API}/f/a.png`] }, { kind: "tool" });
      await args.dispatcherOptions.onError(new Error("boom"), { kind: "final" });
    });
    const reports: Reported[] = [];
    const posted: string[] = [];
    let attempt = 0;

    await runDocTask(posted, {}, {
      reports,
      postComment: async (text) => {
        attempt += 1;
        if (attempt === 1) throw new Error("docs API 503");
        posted.push(text);
      },
    });

    expect(posted).toEqual(["⚠️ 抱歉，处理您的消息时遇到了问题，请稍后重试。"]);
    expect(reports).toEqual([report({ delivered: true, lost: true, noticed: true })]);
  });

  it.each([
    { label: "空正文/空附件/非 final", text: undefined, media: false, kind: "tool", final: false, delivered: false },
    { label: "空正文/空附件/final", text: undefined, media: false, kind: "final", final: false, delivered: false },
    { label: "空正文/有附件/非 final", text: undefined, media: true, kind: "tool", final: false, delivered: true },
    { label: "空正文/有附件/final", text: undefined, media: true, kind: "final", final: true, delivered: true },
    { label: "有正文/空附件/非 final", text: "内容", media: false, kind: "tool", final: false, delivered: true },
    { label: "有正文/空附件/final", text: "内容", media: false, kind: "final", final: true, delivered: true },
    { label: "有正文/有附件/非 final", text: "内容", media: true, kind: "tool", final: false, delivered: true },
    { label: "有正文/有附件/final", text: "内容", media: true, kind: "final", final: true, delivered: true },
  ] as const)("投递矩阵:$label", async ({ text, media, kind, final, delivered }) => {
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver(
        {
          ...(text ? { text } : {}),
          ...(media ? { mediaUrls: [`${API}/f/matrix.png`] } : {}),
        },
        { kind },
      );
    });
    const reports: Reported[] = [];

    await runDocTask([], {}, { reports });

    expect(reports).toEqual([report({ finalDelivered: final, delivered })]);
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
