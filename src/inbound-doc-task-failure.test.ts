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
    config: { current: () => openClawConfig },
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

  it("进度不进评论区,但失败信息随兜底带出来", async () => {
    // 评论区只留结论:实测一次改单元格产生 9 条工具调用评论,真正的答复被埋在最下面
    // (用户报「为什么回复的都是工具调用」)。抑制不等于丢弃 —— 整回合没有产出时,
    // 最后那段进度往往就是失败原因,必须跟着兜底通知出去。
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ text: "⚠️ Exec failed: 412 base_version_stale" }, { kind: "tool" });
      await args.dispatcherOptions.onError(new Error("boom"), { kind: "final" });
    });
    const reports: Reported[] = [];
    const posted: string[] = [];

    await runDocTask(posted, {}, { reports });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("⚠️ 抱歉，处理您的消息时遇到了问题，请稍后重试。");
    expect(posted[0]).toContain("412 base_version_stale");
    // 进度不是答复:哪怕它的内容被引用进了提示,这一回合仍然只是 noticed。
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
    // 用「带附件的进度」当触发器:纯文本进度已被抑制(见上一条用例),而带附件的
    // 那一条仍会 POST —— 附件已计入 sentMediaUrls,跳过就等于永久丢弃。所以这条
    // 路径依然能产生「非 final 输出 POST 失败」,回归场景没有随抑制一起消失。
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver(
        { text: "正在读取文档…", mediaUrls: [`${API}/f/step.png`] },
        { kind: "tool" },
      );
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
          if (text.startsWith("正在读取文档…")) throw new Error("docs API 503");
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
    // P1 回归:附件先 POST 成功并把回合级 finalDelivered 置真;finally 随后刷新
    // block 文本时 POST 失败。若 deliverFinalText 返回回合级旧值,失败的这一次仍会
    // 报告 delivered:true,最终写去重且不留失败提示,正文永久静默丢失。
    //
    // 附件由独立的中间产出 payload 发出 —— 附件队列拆成 per-payload 之后,
    // 「同一个 payload 的文本 + 附件」会合成一条评论一次发出,构不成两次 POST。
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ mediaUrls: [`${API}/f/diff.png`] }, { kind: "tool" });
      await args.dispatcherOptions.deliver(
        { text: "已按要求改好，正文说明如下" },
        { kind: "block" },
      );
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

  it("本地文件路径不得写进公开评论,也不得算成已投递", async () => {
    // IM 路径会把本地文件先经 presign 上传再引用;文档分支是直接把字符串写进评论。
    // 原样带出去的话读者拿到一个用不了的路径,而且主机文件系统路径被发布进了评论区,
    // 回合还被记成投递成功。
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver(
        { text: "报告已生成", mediaUrls: ["/tmp/report.pdf"] },
        { kind: "final" },
      );
    });
    const reports: Reported[] = [];
    const posted: string[] = [];

    await runDocTask(posted, {}, { reports });

    expect(posted).toEqual(["报告已生成"]); // 正文照发,路径不带
    expect(posted[0]).not.toContain("/tmp/report.pdf");
    expect(reports).toEqual([report({ finalDelivered: true, delivered: true })]);
  });

  it("只有本地路径、没有文本:什么都发不出去,不能算成最终答复", async () => {
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ mediaUrls: ["/tmp/report.pdf"] }, { kind: "final" });
    });
    const reports: Reported[] = [];
    const posted: string[] = [];

    await runDocTask(posted, {}, { reports });

    expect(posted).toEqual([]);
    // 什么痕迹都没有 → handler 会补兜底并允许重投,而不是静默记成完成。
    expect(reports).toEqual([report()]);
  });

  // --- 收口不得把「不是本回合最终产出」的东西冒充成最终答复 ---
  // 提升方向比降级方向更狠:handler 会写去重(永不重投)**并且**不发失败提示,
  // 于是真答复没了、用户什么都不知道、事件也再不会回来。

  it("final 尝试过并失败后,满足条件的 media 收口不得把它洗回成功", async () => {
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ mediaUrls: [`${API}/f/a.png`] }, { kind: "tool" });
      await args.dispatcherOptions.deliver({ text: "已按要求改好" }, { kind: "final" });
      // dispatcher 用同 URL 收口。该 URL 确实已投递,但本回合的最终答复是上面那条
      // 失败的文本 —— 收口不是一次新的投递尝试,不能替它翻案。
      await args.dispatcherOptions.deliver({ mediaUrls: [`${API}/f/a.png`] }, { kind: "final" });
    });
    const reports: Reported[] = [];
    const posted: string[] = [];

    await runDocTask(posted, {}, {
      reports,
      postComment: async (text) => {
        if (text === "已按要求改好") throw new Error("docs API 503");
        posted.push(text);
      },
    });

    expect(posted).toEqual([`[附件] ${API}/f/a.png`]);
    expect(reports).toEqual([report({ delivered: true, lost: true })]);
  });

  it("更正 final 失败后,media 收口不得把上一版答复重新算作最终答复", async () => {
    // 直接击穿「更正 final 失败必须覆盖此前成功」那条不变量:覆盖发生了,
    // 然后收口又把它扶回来。
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver(
        { text: "初版答复", mediaUrls: [`${API}/f/b.png`] },
        { kind: "final" },
      );
      await args.dispatcherOptions.deliver({ text: "更正答复" }, { kind: "final" });
      await args.dispatcherOptions.deliver({ mediaUrls: [`${API}/f/b.png`] }, { kind: "final" });
    });
    const reports: Reported[] = [];
    const posted: string[] = [];

    await runDocTask(posted, {}, {
      reports,
      postComment: async (text) => {
        if (text === "更正答复") throw new Error("docs API 503");
        posted.push(text);
      },
    });

    expect(posted).toEqual([`初版答复\n\n[附件] ${API}/f/b.png`]);
    expect(reports).toEqual([report({ delivered: true, lost: true })]);
  });

  it("进度帖连同附件一起发失败:附件不顺延,后面的空 final 也不算最终答复", async () => {
    // 曾经的 door 2:失败的帖子把附件留在回合级队列里,于是后面那条空 final 发现
    // body 非空、压根走不到空 body 那道守卫,直接按 intent.final 打了标 —— 拿别人
    // 失败帖的遗留物给自己背书。
    //
    // 队列拆成 per-payload 之后,附件跟着那次失败的投递一起作废(有 error 日志),
    // 空 final 自己没有内容、引用的附件也从未落地,于是这一回合评论区什么都没有、
    // 如实 report lost —— handler 补兜底通知并 release,允许重投。这是本方案明确
    // 接受的代价:回合内不再有「失败附件顺延给后续帖子」的补救。
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

    await runDocTask(posted, {}, {
      reports,
      postComment: async (text) => {
        if (text.includes("正在生成预览")) throw new Error("docs API 503");
        posted.push(text);
      },
    });

    expect(posted).toEqual([]);
    expect(reports).toEqual([report({ lost: true })]);
  });

  // --- 附件按 payload 归属:一次 POST 的 body 只装它自己的内容 ---
  // 这一组钉的是「跨 payload 共享附件队列」被拆掉之后的两个方向。此前失败的 POST
  // 会把附件留在回合级队列里,于是后来的 payload 可以拿别人的遗留物给自己的 final
  // 背书(提升方向);而收紧认领资格时又极容易顺手打死「带着自己新附件的 final」
  // (降级方向)。两个方向必须同时钉住。

  it("带同一附件的 final 发失败后,同 URL 的收口 final 不得替它认领", async () => {
    // dispatcher 的正常收口协议:media 先作为中间产出发,再由引用同一 URL 的 final
    // 收口。当这一回合真正的答复(文本 + 同一附件)POST 失败时,那条收口自己什么都
    // 没带 —— 它引用的附件从来没落地过,不能把这个回合说成有答复。
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver(
        { text: "已按要求改好:第 3 段已改写", mediaUrls: [`${API}/f/a.png`] },
        { kind: "final" },
      );
      await args.dispatcherOptions.deliver({ mediaUrls: [`${API}/f/a.png`] }, { kind: "final" });
    });
    const reports: Reported[] = [];
    const posted: string[] = [];

    await runDocTask(posted, {}, {
      reports,
      postComment: async (text) => {
        if (text.includes("已按要求改好")) throw new Error("docs API 413");
        posted.push(text);
      },
    });

    // 答复没发出去,收口也没有自己的内容可发:评论区应当什么都没有,
    // 由 handler 补兜底通知并 release,而不是留一行光秃秃的附件加一条去重记录。
    expect(posted).toEqual([]);
    expect(reports).toEqual([report({ lost: true })]);
  });

  it("附件 final 发失败后,另一个新附件的 final 成功:仍算最终答复", async () => {
    // 上一条的镜像。第二条 final 带的是它**自己**的新附件、而且确实发出去了,
    // 那就是这一回合的最终产出。判成 false 会在正确答复下面补一句「没有给出
    // 答复」并 release,用户照做就把改文档的任务再跑一遍。
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ mediaUrls: [`${API}/f/x.png`] }, { kind: "final" });
      await args.dispatcherOptions.deliver({ mediaUrls: [`${API}/f/y.png`] }, { kind: "final" });
    });
    const reports: Reported[] = [];
    const posted: string[] = [];

    await runDocTask(posted, {}, {
      reports,
      postComment: async (text) => {
        if (text.includes("x.png")) throw new Error("docs API 503");
        posted.push(text);
      },
    });

    expect(posted).toEqual([`[附件] ${API}/f/y.png`]);
    expect(reports).toEqual([report({ finalDelivered: true, delivered: true, lost: true })]);
  });

  it("block 文本自带附件:缓冲期间不丢,收尾时与文本合成一条评论发出", async () => {
    // 拆掉共享队列之后新出现的路径:block 的文本被缓冲(还没 POST),它自己的附件
    // 必须跟着一起等,并由接管这段缓冲的那次投递带出去。漏掉这一步的话,这一回合
    // 附件一条都发不出去,而文本照常送达 —— report 说落地了,读者少了附件。
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver(
        { text: "已按要求改好", mediaUrls: [`${API}/f/b.png`] },
        { kind: "block" },
      );
    });
    const reports: Reported[] = [];
    const posted: string[] = [];
    const errors: string[] = [];

    await runDocTask(posted, {}, { reports, log: { error: (m: string) => { errors.push(m); } } });

    expect(posted).toEqual([`已按要求改好\n\n[附件] ${API}/f/b.png`]);
    expect(reports).toEqual([report({ finalDelivered: true, delivered: true })]);
    // 取走即消费:接管之后缓冲必须是空的,否则收尾会报「附件没人接管」。
    expect(errors.filter((m) => m.includes("never delivered"))).toEqual([]);
  });

  it("block 附件 + 随后的 final 文本:附件必须由这条 final 带出去,不能随缓冲一起丢", async () => {
    // final 会把缓冲文本清掉(它取代了那段草稿),所以缓冲里那些还没投递过的附件
    // 也必须由它接管。漏掉的话收尾流程已经被 textSent 关掉,附件这一回合再没有
    // 出口 —— 用户拿到最终答复,却少了它引用的图。
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver(
        { text: "草稿:先看看这个", mediaUrls: [`${API}/f/c.png`] },
        { kind: "block" },
      );
      await args.dispatcherOptions.deliver({ text: "最终答复:第 3 段已改写" }, { kind: "final" });
    });
    const reports: Reported[] = [];
    const posted: string[] = [];
    const errors: string[] = [];

    await runDocTask(posted, {}, { reports, log: { error: (m: string) => { errors.push(m); } } });

    expect(posted).toEqual([`最终答复:第 3 段已改写\n\n[附件] ${API}/f/c.png`]);
    expect(reports).toEqual([report({ finalDelivered: true, delivered: true })]);
    expect(errors.filter((m) => m.includes("never delivered"))).toEqual([]);
  });

  // --- 空转的收口不得降级 ---
  // 上一条(以及它下面两条)钉的是**提升**方向:空 final 不能把没答复洗成有答复。
  // 镜像的**降级**方向此前没人钉,于是那条早返回把「真的 POST 成功过」抹成了 false
  // —— 评论区有正确答复,report 却说没有,handler 于是在答复下面补一句「没有给出
  // 答复,请重新 @ 我」并 release,用户照做就把改文档的任务再跑一遍。

  it("最终答复已落地、随后一条空转的空 final:不得把已落地的事实抹掉", async () => {
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver(
        { text: "已按要求改好", mediaUrls: [`${API}/f/a.png`] },
        { kind: "final" },
      );
      // dispatcher 用一条空 payload 收口 —— 代码注释自己写明这是常规行为。
      // 它没重新带 URL,所以 closesDeliveredMedia 为假:什么都没发,也没失败。
      await args.dispatcherOptions.deliver({}, { kind: "final" });
    });
    const reports: Reported[] = [];
    const posted: string[] = [];

    await runDocTask(posted, {}, { reports });

    expect(posted).toEqual([`已按要求改好\n\n[附件] ${API}/f/a.png`]);
    expect(reports).toEqual([report({ finalDelivered: true, delivered: true })]);
  });

  it("进度附件 + 最终答复落地 + 空转空 final:同样不得降级", async () => {
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ mediaUrls: [`${API}/f/a.png`] }, { kind: "tool" });
      await args.dispatcherOptions.deliver({ text: "已按要求改好" }, { kind: "final" });
      await args.dispatcherOptions.deliver({}, { kind: "final" });
    });
    const reports: Reported[] = [];
    const posted: string[] = [];

    await runDocTask(posted, {}, { reports });

    expect(posted).toEqual([`[附件] ${API}/f/a.png`, "已按要求改好"]);
    expect(reports).toEqual([report({ finalDelivered: true, delivered: true })]);
  });

  it("最终答复 POST 失败、随后空转的空 final:仍然是失败 —— 空转不得反向洗白", async () => {
    // 反向对照:空转返回的是回合已有的结论,不是无脑 true。答复真丢了就得是丢了。
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ text: "已按要求改好" }, { kind: "final" });
      await args.dispatcherOptions.deliver({}, { kind: "final" });
    });
    const reports: Reported[] = [];
    const posted: string[] = [];

    await runDocTask(posted, {}, {
      reports,
      postComment: async () => { throw new Error("docs API 503"); },
    });

    expect(posted).toEqual([]);
    expect(reports).toEqual([report({ lost: true })]);
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

  it("只有进度文本、随后收到空 final:评论区一条不发,更不能把进度冒充最终答复", async () => {
    installFetchStub();
    installRuntime(async (args) => {
      await args.dispatcherOptions.deliver({ text: "正在读取文档…" }, { kind: "tool" });
      await args.dispatcherOptions.deliver({}, { kind: "final" });
    });
    const reports: Reported[] = [];
    const posted: string[] = [];

    await runDocTask(posted, {}, { reports });

    // 进度被抑制、final 是空的 —— 这一回合确实什么都没产出。如实上报 delivered:false,
    // 由 handler 去补兜底通知并允许重投,而不是拿一句进度冒充答复换取去重记录。
    expect(posted).toEqual([]);
    expect(reports).toEqual([report({})]);
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
    // 纯文本的非 final(即进度)在文档任务里被抑制,所以这一格 delivered 为假。
    { label: "有正文/空附件/非 final", text: "内容", media: false, kind: "tool", final: false, delivered: false },
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
