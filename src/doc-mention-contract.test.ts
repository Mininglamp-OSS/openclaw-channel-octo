import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startEventPoller, type EventCursorStore } from "./events-poll.js";
import {
  docCommentParentId,
  docTaskQueueScope,
  docTaskSessionScope,
  parseDocCommentMention,
  synthesizeDocMentionMessage,
  type DocCommentMention,
} from "./doc-mention.js";
import { createFileDocMentionDedupeStore, type DocMentionDedupeStore } from "./doc-mention-dedupe.js";
import { createDocMentionHandler } from "./doc-mention-handler.js";
import { getInboundQueueKey } from "./inbound-queue.js";
import { handleInboundMessage } from "./inbound.js";
import { postDocComment } from "./api-fetch.js";
import { setOctoRuntime } from "./runtime.js";
import { _clearKnownBots } from "./bot-registry.js";
import type { ResolvedOctoAccount } from "./accounts.js";

/**
 * 解析器契约测试:octo-server(modules/bot_mention)→ 本插件 → docs 评论 API。
 *
 * fixture 由 octo-server PR 分支的真实代码生成(normalizeMentionRequest +
 * mentionEventData,包在 /v1/bot/events 的 eventResp 形状里),不是手抄字段。
 *
 * **它保证什么、不保证什么**(上一版把这两件事说混了):
 *
 *   保证 —— 本插件的解析/合成/回帖链路对着这份**冻结快照**保持一致。谁改了
 *   `parseDocCommentMention` 的字段映射,下面的 toMatchObject 会红。
 *
 *   不保证 —— server 端真的改了字段名时这里**不会**自动变红:fixture 是签进仓库的
 *   静态文件,没有任何 CI 步骤去重新生成它并比对差异。要拿到那个保证,需要一个
 *   从 server 仓库重新生成 fixture 并对 diff 失败的 job。在那之前,这是一份
 *   「解析器不许自己漂移」的回归测试,不是跨服务的活契约。
 */

const FIXTURE = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "octo-server-doc-mention-event.json"),
    "utf8",
  ),
) as { status: number; results: Array<Record<string, unknown>> };

const SERVER_EVENT = FIXTURE.results[0];
const SERVER_DATA = SERVER_EVENT.event_data as Record<string, unknown>;

const API = "http://octo.test";
const BOT_UID = SERVER_DATA.bot_uid as string;
const HUMAN_UID = SERVER_DATA.from_uid as string;
const DOC_ID = SERVER_DATA.doc_id as string;

const originalFetch = globalThis.fetch;

interface Captured {
  urls: string[];
  docComments: Array<{ url: string; body: Record<string, unknown> }>;
  acked: number[];
}

function installFetch(events: unknown[]): Captured {
  const captured: Captured = { urls: [], docComments: [], acked: [] };
  let served = false;
  globalThis.fetch = vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.toString();
    captured.urls.push(url);
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });

    const ackMatch = /\/v1\/bot\/events\/(\d+)\/ack/.exec(url);
    if (ackMatch) { captured.acked.push(Number(ackMatch[1])); return json({ status: 1 }); }
    if (url.includes("/v1/bot/events")) {
      const batch = served ? [] : events;
      served = true;
      return json({ status: 1, results: batch });
    }
    if (/\/v1\/bot\/docs\/.+\/comments$/.test(url)) {
      captured.docComments.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return json({ id: 10099 });
    }
    if (url.includes("/messages/sync")) return json({ messages: [] });
    if (url.includes("/sendMessage")) return json({ message_id: "r1", message_seq: 0 });
    return json({});
  }) as unknown as typeof fetch;
  return captured;
}

function memoryCursor(): EventCursorStore {
  let value = 0;
  return { async load() { return value; }, async save(id: number) { value = id; } };
}

function makeAccount(): ResolvedOctoAccount {
  return {
    accountId: "acct1",
    enabled: true,
    configured: true,
    config: {
      botToken: "tok",
      apiUrl: API,
      pollIntervalMs: 500,
      heartbeatIntervalMs: 1000,
      requireMention: false,
      docTasks: true,
    },
  };
}

function installRuntime(finalText: string) {
  const finalizeInboundContext = vi.fn((ctx: any) => ctx);
  const dispatch = vi.fn(async (args: any) => {
    await args.dispatcherOptions.deliver({ text: finalText }, { kind: "final" });
  });
  setOctoRuntime({
    config: { current: () => ({}) },
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: dispatch,
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: any) => body,
        finalizeInboundContext,
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
  return { dispatch, finalizeInboundContext };
}

/**
 * 用**真实**的 createDocMentionHandler(channel.ts 生产路径同一函数)驱动,
 * 只把 dispatch / postComment 换成测试替身 —— 复刻一份接线的话,接线本身的
 * 回归就抓不到了。
 */
function makeDocMentionHandler(params: {
  dedupe: DocMentionDedupeStore;
  promptSink?: (text: string) => void;
  finalText: string;
}) {
  return createDocMentionHandler({
    botUid: BOT_UID,
    dedupe: params.dedupe,
    postComment: async (mention, text, signal) => {
      await postDocComment({
        apiUrl: API,
        botToken: "tok",
        docId: mention.docId,
        body: text,
        parentId: docCommentParentId(mention),
        signal,
      });
    },
    dispatch: async (message, _routeOverride, extra) => {
      params.promptSink?.(message.payload.content ?? "");
      await handleInboundMessage({
        account: makeAccount(),
        message: message as any,
        botUid: BOT_UID,
        groupHistories: new Map(),
        lastBotReplySeqMap: new Map(),
        memberMap: new Map(),
        uidToNameMap: new Map(),
        groupCacheTimestamps: new Map(),
        log: undefined,
        docTask: extra.docTask,
      });
      return "completed";
    },
  });
}

async function drain(ms = 900): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

let dir: string;

beforeEach(async () => {
  _clearKnownBots();
  dir = await mkdtemp(join(tmpdir(), "octo-contract-"));
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("server 事件契约", () => {
  it("fixture 是 /v1/bot/events 的形状,且字段集没被人手改过", () => {
    // 注意这条断言的性质:它约束的是**这份签进仓库的快照**,不是线上的 server。
    // 快照被人手工编辑会红,server 真的改了字段名不会红(见文件头说明)。
    expect(FIXTURE.status).toBe(1);
    expect(SERVER_EVENT.event_type).toBe("doc_comment_mention");
    expect(Object.keys(SERVER_DATA).sort()).toEqual([
      "bot_uid", "comment_id", "doc_id", "enqueued_at", "from_uid",
      "idempotency_key", "parent_id", "space_id", "text", "thread_id", "url",
    ]);
  });

  it("插件解析 server 载荷无字段丢失", () => {
    const mention = parseDocCommentMention(SERVER_EVENT as any)!;
    expect(mention).toMatchObject({
      idempotencyKey: SERVER_DATA.idempotency_key,
      docId: SERVER_DATA.doc_id,
      commentId: SERVER_DATA.comment_id,
      threadId: SERVER_DATA.thread_id,
      parentId: SERVER_DATA.parent_id,
      fromUid: SERVER_DATA.from_uid,
      botUid: SERVER_DATA.bot_uid,
      text: SERVER_DATA.text,
      url: SERVER_DATA.url,
      spaceId: SERVER_DATA.space_id,
      enqueuedAt: SERVER_DATA.enqueued_at,
    });
  });

  it("server 派生的 thread_id(=parent_id)决定评论串,而不是 comment_id", () => {
    const mention = parseDocCommentMention(SERVER_EVENT as any)!;
    expect(mention.threadId).toBe(SERVER_DATA.parent_id);
    expect(docTaskSessionScope(mention)).toBe(`doctask:${DOC_ID}:${SERVER_DATA.thread_id}`);
  });
});

describe("端到端:server 事件 → bot 执行 → 评论区回帖", () => {
  it("轮询拿到 server 事件后完成一整轮,回帖挂在原评论串下并 ack", async () => {
    const captured = installFetch([SERVER_EVENT]);
    installRuntime("已把绝对化承诺改成有数据边界、保留人工复核的表述。");
    const dedupe = createFileDocMentionDedupeStore({ accountId: "acct1", baseDir: dir });

    const poller = startEventPoller({
      apiUrl: API,
      botToken: "tok",
      intervalMs: 500,
      cursorStore: memoryCursor(),
      onDocMention: makeDocMentionHandler({ dedupe, finalText: "已把绝对化承诺改成有数据边界、保留人工复核的表述。" }),
    });
    await poller.ready;
    await drain();
    poller.stop();

    // 1) 回帖落在 docs 评论 API,doc 与父评论都对
    expect(captured.docComments).toHaveLength(1);
    expect(captured.docComments[0].url).toBe(`${API}/v1/bot/docs/${DOC_ID}/comments`);
    expect(captured.docComments[0].body).toEqual({
      body: "已把绝对化承诺改成有数据边界、保留人工复核的表述。",
      parentId: Number(SERVER_DATA.thread_id),
    });
    // 2) IM 侧零发送 —— 本特性的核心诉求
    expect(captured.urls.filter((u) => u.includes("/sendMessage"))).toHaveLength(0);
    expect(captured.urls.filter((u) => u.includes("/typing"))).toHaveLength(0);
    expect(captured.urls.filter((u) => u.includes("/readReceipt"))).toHaveLength(0);
    // 3) 处理完才 ack
    expect(captured.acked).toEqual([SERVER_EVENT.event_id]);
  });

  it("server 崩溃重投同一 idempotency_key(新 event_id)不会重复执行", async () => {
    // server 侧 enqueue 后 confirm 前崩溃会产生新的 event_id、同一 idempotency_key
    const replay = { ...SERVER_EVENT, event_id: 1000002 };
    const captured = installFetch([SERVER_EVENT, replay]);
    installRuntime("完成");
    const dedupe = createFileDocMentionDedupeStore({ accountId: "acct1", baseDir: dir });

    const poller = startEventPoller({
      apiUrl: API,
      botToken: "tok",
      intervalMs: 500,
      cursorStore: memoryCursor(),
      onDocMention: makeDocMentionHandler({ dedupe, finalText: "完成" }),
    });
    await poller.ready;
    await drain();
    poller.stop();

    expect(captured.docComments).toHaveLength(1);
    // 两条都被识别并 ack(第二条是「已处理」而非「未识别」)
    expect(captured.acked).toEqual([1000001, 1000002]);
  });

  it("agent 拿到的 prompt 含 doc/comment 定位与原始评论,且禁止自行发评论", async () => {
    installFetch([SERVER_EVENT]);
    installRuntime("完成");
    const dedupe = createFileDocMentionDedupeStore({ accountId: "acct1", baseDir: dir });
    const prompts: string[] = [];

    const poller = startEventPoller({
      apiUrl: API,
      botToken: "tok",
      intervalMs: 500,
      cursorStore: memoryCursor(),
      onDocMention: makeDocMentionHandler({ dedupe, finalText: "完成", promptSink: (t) => prompts.push(t) }),
    });
    await poller.ready;
    await drain();
    poller.stop();

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`doc_id=${JSON.stringify(DOC_ID)}`);
    expect(prompts[0]).toContain(`thread_id=${JSON.stringify(SERVER_DATA.thread_id)}`);
    expect(prompts[0]).toContain(JSON.stringify(SERVER_DATA.text));
    expect(prompts[0]).toContain("不要自己再发一条评论");
  });

  it("队列键脱离发起人 DM:长任务不会阻塞该用户的私聊", () => {
    const mention = parseDocCommentMention(SERVER_EVENT as any)!;
    const message = synthesizeDocMentionMessage(mention, BOT_UID);
    const docKey = getInboundQueueKey("acct1", message, docTaskQueueScope(mention));
    const dmKey = getInboundQueueKey("acct1", message);

    expect(docKey).toBe(`acct1:doctask:${DOC_ID}:${SERVER_DATA.thread_id}`);
    // 不覆写就会落进 DM 队列(具体 space 切分沿用既有 lastIndexOf 约定,这里只关心
    // 「是 DM 队列且属于该发起人」),两者必须不同,否则长任务队头阻塞其私聊。
    expect(dmKey.startsWith("acct1:dm:")).toBe(true);
    expect(dmKey).toContain(HUMAN_UID);
    expect(docKey).not.toBe(dmKey);
  });

  it("事件指向其它 bot 时丢弃,不越权执行", async () => {
    const foreign = {
      ...SERVER_EVENT,
      event_data: { ...SERVER_DATA, bot_uid: "bot_someone_else000000000000000" },
    };
    const captured = installFetch([foreign]);
    installRuntime("完成");
    const dedupe = createFileDocMentionDedupeStore({ accountId: "acct1", baseDir: dir });

    const poller = startEventPoller({
      apiUrl: API,
      botToken: "tok",
      intervalMs: 500,
      cursorStore: memoryCursor(),
      onDocMention: makeDocMentionHandler({ dedupe, finalText: "完成" }),
    });
    await poller.ready;
    await drain();
    poller.stop();

    expect(captured.docComments).toHaveLength(0);
    expect(captured.urls.filter((u) => u.includes("/sendMessage"))).toHaveLength(0);
  });
});
