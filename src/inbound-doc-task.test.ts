import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, MessageType } from "./types.js";
const handleForkCommandIfMatched = vi.fn(async () => false);
vi.mock("./commands/fork-inbound.js", () => ({
  handleForkCommandIfMatched: (...args: unknown[]) => handleForkCommandIfMatched(...(args as [])),
}));

import { handleInboundMessage } from "./inbound.js";
import { OCTO_GROUP_RE } from "./group-md.js";
import { setOctoRuntime } from "./runtime.js";
import { _clearKnownBots } from "./bot-registry.js";
import { docTaskSessionScope, parseDocCommentMention, synthesizeDocMentionMessage } from "./doc-mention.js";
import type { ResolvedOctoAccount } from "./accounts.js";

/**
 * 文档评论任务的出站回归测试。
 *
 * 合成消息是 DM 形状的,若不改道,agent 的最终答复、正在输入、已读回执、进度卡
 * 都会发进发起人的私聊 —— 正是本特性要消除的污染。这里锁死两条:
 *   1. IM 出站零调用(sendMessage / typing / readReceipt 一个都不许发);
 *   2. 最终答复改投 docTask.postComment(评论区),且失败不回退 IM。
 */

const API = "http://octo.test";
const BOT_UID = "bot_self_0000000000000000000000000000";
const HUMAN_UID = "human_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const originalFetch = globalThis.fetch;

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
      requireMention: false,
      docTasks: true,
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

/** 记录所有出站 HTTP,便于断言 IM 出口零调用。 */
function installFetchStub(): string[] {
  const urls: string[] = [];
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.includes("/messages/sync")) return json({ messages: [] });
    if (url.includes("/sendMessage")) return json({ message_id: "reply1", message_seq: 0 });
    return json({});
  }) as unknown as typeof fetch;
  return urls;
}

function installRuntime(finalText = "已按要求改写完成") {
  const dispatch = vi.fn(async (args: any) => {
    await args.dispatcherOptions.deliver({ text: finalText }, { kind: "final" });
  });
  const resolveAgentRoute = vi.fn(() => ({ agentId: "agent1", sessionKey: "sk-default", accountId: "acct1" }));
  const finalizeInboundContext = vi.fn((ctx: any) => ctx);
  setOctoRuntime({
    config: { current: () => ({}) },
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: dispatch,
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: any) => body,
        finalizeInboundContext,
      },
      routing: { resolveAgentRoute },
      session: {
        resolveStorePath: () => "/tmp/store",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: async () => {},
      },
    },
  } as any);
  return { dispatch, finalizeInboundContext };
}

function runDocTask(postComment: (text: string) => Promise<void>, opts: { accountId?: string } = {}) {
  const mention = makeMention();
  return handleInboundMessage({
    account: makeAccount(opts.accountId),
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
      postComment: async (text) => { await postComment(text); },
      reportTurn: () => {},
    },
  });
}

beforeEach(() => {
  _clearKnownBots();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("文档任务的出站改道", () => {
  it("最终答复发到评论区,而不是发起人的私聊", async () => {
    const urls = installFetchStub();
    installRuntime("已按要求改写完成");
    const posted: string[] = [];

    await runDocTask(async (text) => { posted.push(text); });

    expect(posted).toEqual(["已按要求改写完成"]);
    expect(urls.filter((u) => u.includes("/sendMessage"))).toHaveLength(0);
  });

  it("IM 出口全部静默:typing / readReceipt 一个都不发", async () => {
    const urls = installFetchStub();
    installRuntime();
    const posted: string[] = [];

    await runDocTask(async (text) => { posted.push(text); });

    expect(urls.filter((u) => u.includes("/typing"))).toHaveLength(0);
    expect(urls.filter((u) => u.includes("/readReceipt"))).toHaveLength(0);
    // 只断言「IM 没动静」的话,文档路径一条评论都没发也能通过 —— 那是静默丢弃,
    // 不是成功。必须同时钉住评论区确实收到了东西。
    expect(posted).toEqual(["已按要求改写完成"]);
  });

  it("评论区回帖失败不回退 IM(回退等于把污染放回来)", async () => {
    const urls = installFetchStub();
    installRuntime();

    await runDocTask(async () => { throw new Error("docs 5xx"); });

    expect(urls.filter((u) => u.includes("/sendMessage"))).toHaveLength(0);
  });

  it("会话键含 accountId 且脱离 GROUP.md 命名空间 —— 按生产键逐段断言", async () => {
    installFetchStub();
    const { finalizeInboundContext } = installRuntime();

    await runDocTask(async () => {});

    expect(finalizeInboundContext).toHaveBeenCalled();
    const sessionKey: string = finalizeInboundContext.mock.calls[0][0].SessionKey ?? "";

    // 整键精确断言。此前只 toContain("doctask:d1:70"),于是把 accountId 段整段删掉
    // 测试照绿 —— 而那段正是「共用同一 agent 的两个 bot 账号不会塌成一个会话」的
    // 唯一保证,是个数据泄漏形状的缺陷。
    expect(sessionKey).toBe("agent:agent1:octo:acct1:doctask:d1:70");
    // 用 group-md.ts 导出的**同一个**正则,而不是在测试里抄一份 —— 抄的那份会
    // 随源码漂移,且当时构造的键少一段,两边都对不上。
    expect(OCTO_GROUP_RE.test(sessionKey)).toBe(false);
  });

  it("文档任务不授权斜杠命令,也不进 /fork 短路", async () => {
    // 两处都只靠「formatDocMentionText 给正文加了前缀所以锚定正则匹配不上」这种
    // 意外保护挡着,提示词格式一改就重新打开。fork-inbound 还用它自己的 sendMessage
    // 直发 IM(在另一个文件里,出站闸门看不到它),目标正是发起人的私聊。
    installFetchStub();
    const { finalizeInboundContext } = installRuntime();

    await runDocTask(async () => {});

    const ctx = finalizeInboundContext.mock.calls[0][0];
    expect(ctx.CommandAuthorized).toBe(false);
    // 连问都不该问 fork —— 它一旦匹配就用自己的出口发到私聊。
    expect(handleForkCommandIfMatched).not.toHaveBeenCalled();
  });

  it("不同 account 的同一条评论串拿到不同会话键", async () => {
    installFetchStub();
    const { finalizeInboundContext } = installRuntime();

    await runDocTask(async () => {});
    await runDocTask(async () => {}, { accountId: "acct2" });

    const keys = finalizeInboundContext.mock.calls.map((c: any) => c[0].SessionKey);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("非文档任务不受影响", () => {
  it("普通 DM 仍走 IM 出站", async () => {
    const urls = installFetchStub();
    installRuntime("普通回复");

    await handleInboundMessage({
      account: makeAccount(),
      message: {
        message_id: "m_dm",
        message_seq: 100,
        from_uid: HUMAN_UID,
        channel_id: HUMAN_UID,
        channel_type: ChannelType.DM,
        timestamp: Math.floor(Date.now() / 1000),
        payload: { type: MessageType.Text, content: "hi bot" },
      } as any,
      botUid: BOT_UID,
      groupHistories: new Map(),
      lastBotReplySeqMap: new Map(),
      memberMap: new Map(),
      uidToNameMap: new Map(),
      groupCacheTimestamps: new Map(),
      log: undefined,
    });

    expect(urls.filter((u) => u.includes("/sendMessage")).length).toBeGreaterThan(0);
  });
});
