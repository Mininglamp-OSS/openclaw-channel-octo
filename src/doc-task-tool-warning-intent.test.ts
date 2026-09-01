import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * reviewer 第四轮 §2.1 的回归钉子：**工具失败警告不得以 `applied` 出站**。
 *
 * 为什么必须新开一个文件走生产接线，而不是在 handler 层加断言：
 *
 *   reviewer 指出 `deliver-buffer.test.ts` 里 `grep -c docTask` 是 **0** ——
 *   deliver buffer 那条路从来没有在 doc-task 形态下跑过。已有的
 *   `doc-task-p1-closeout.test.ts` 测的是 `createDocMentionHandler`（handler 层），
 *   它直接调 `ctx.docTask.postComment(text, signal, intent)`，intent 是测试自己
 *   传进去的 —— 那一层永远测不出「inbound.ts 的 dispatcher 忘了/无法传 intent」。
 *
 *   本轮缺陷正好活在两者中间的 `inbound.ts`：`resolveAndSendText` 把
 *   `type: "output"` 写死，于是 `deliverFinalText` 的调用点**根本没有通道**表达
 *   「这是提示、不是产出」。同一类缺陷被人工枚举找到两次、漏掉两次，因为两次
 *   人都在读调用点，而缺陷在被调用方。
 *
 * 承重后果（为什么这是 P1 而不是徽章不好看）：
 *   `status: "applied"` 在上游 octo-doc 不只是渲染绿标签 —— 它翻转父评论状态并发
 *   `marked_applied`。于是一条「⚠️ 执行失败」的回复把用户的诉求标成**已解决**，
 *   同时 dedupe.complete() 把任务**永久关闭**、不再重试。人去 triage 时看不到
 *   任何出错信号。最坏的失败模式不是报错，是假装成功。
 *
 * 手法沿用 channel-doc-task-wiring.test.ts：mock socket / events-poll / api-fetch，
 * 真跑 `gateway.startAccount`，从 startEventPoller 收到的 options 里取生产的
 * `onDocMention` 直接驱动，再从 fetch body 上读 status —— 断言落在**真实出站报文**
 * 上，不是落在中间函数的入参上。
 */

const startEventPoller = vi.fn(() => ({ ready: Promise.resolve(), stop: () => {}, cursor: () => 0 }));
const sendMessage = vi.fn(async () => ({ message_id: "m1", client_msg_no: "c1", message_seq: 1 }));
const postDocComment = vi.fn(async () => {});

vi.mock("./socket.js", () => ({
  WKSocket: class {
    connect() {}
    disconnect() {}
    async disconnectAndWait() {}
    stopReconnectTimer() {}
    send() {}
    get connected() { return false; }
  },
}));

vi.mock("./events-poll.js", () => ({
  startEventPoller: (options: unknown) => startEventPoller(options as never),
  setCardEventPollStarter: vi.fn(),
  requestCardEventPolling: vi.fn(),
  createFileEventCursorStore: () => ({ load: async () => 0, save: async () => {} }),
}));

vi.mock("./api-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    registerBot: vi.fn(async () => ({
      robot_id: "bot_wiring_0000000000000000000000000",
      im_token: "imtok",
      ws_url: "ws://octo.test/ws",
      owner_uid: "owner1",
    })),
    sendHeartbeat: vi.fn(async () => {}),
    fetchBotGroups: vi.fn(async () => []),
    getGroupMembers: vi.fn(async () => []),
    getGroupMd: vi.fn(async () => undefined),
    sendMessage: (...args: unknown[]) => (sendMessage as (...a: unknown[]) => unknown)(...args),
    postDocComment: (...args: unknown[]) => (postDocComment as (...a: unknown[]) => unknown)(...args),
  };
});

// 让 isFallbackOnlyToolWarningFinal 能把我们造的 payload 认成「非终止性工具错误
// 警告」。不 mock 的话 SDK 分类器对合成 payload 返回 false，这条支路根本进不去，
// 测试会变成一个恒绿的空壳。
vi.mock("openclaw/plugin-sdk/reply-payload", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isReplyPayloadNonTerminalToolErrorWarning: (payload: { __toolWarning?: boolean }) =>
      payload.__toolWarning === true,
  };
});

const API = "http://octo.test";

async function startAccount(config: Record<string, unknown>): Promise<() => Promise<void>> {
  const { octoPlugin } = await import("./channel.js");
  const controller = new AbortController();
  const ctx = {
    account: {
      accountId: "acct1",
      enabled: true,
      configured: true,
      config: { botToken: "tok", apiUrl: API, pollIntervalMs: 1000, heartbeatIntervalMs: 60_000, ...config },
    },
    cfg: {},
    log: undefined,
    setStatus: () => {},
    abortSignal: controller.signal,
  } as never;
  const running = octoPlugin.gateway!.startAccount!(ctx);
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 5));
  return async () => { controller.abort(); await running; };
}

function pollerOptions(): Array<Record<string, unknown>> {
  return (startEventPoller.mock.calls as unknown as Array<[Record<string, unknown>]>).map(([o]) => o);
}

/** 捕获 postHtmlDocReply 的真实出站报文（HTML 文档走 fetch，不走 postDocComment）。 */
function captureHtmlPosts(): Array<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    // 只收「评论回帖」报文。startAccount 期间还有别的 fetch（注册/心跳等，
    // body 为空对象），混进来会让 every() 断言对着一个非评论报文失败。
    if (typeof body.text === "string" && "status" in body) sent.push(body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ status: 1 }),
      json: async () => ({ status: 1 }),
    };
  }) as unknown as typeof fetch;
  return sent;
}

/**
 * 去重存储是**文件持久**的（`createFileDocMentionDedupeStore`，落在
 * ~/.openclaw/workspace/octo/<acct>/doc-mentions.processed.json），跨 vitest
 * 运行都会残留。固定 idempotency_key 会让这个文件第一次跑就记住它，第二次跑
 * 事件被判重复直接跳过 —— 表现为「dispatch 没被调用、零出站」，而不是断言失败，
 * 很容易被误读成产品 bug。所以每次运行都要唯一。
 */
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function htmlDocEvent(key: string) {
  return {
    event_id: 4242,
    event_type: "doc_comment_mention",
    event_data: {
      idempotency_key: `docs:comment:toolwarn-intent:${RUN_ID}:${key}`,
      doc_id: "d1",
      comment_id: "77",
      thread_id: "70",
      from_uid: "human_1",
      bot_uid: "bot_wiring_0000000000000000000000000",
      text: "改一下",
      doc_kind: "html",
    },
  };
}

/**
 * 装一个只吐指定 payload 序列的 dispatcher。
 * `deliver` / `onFreshSettledDelivery` 都从生产的 dispatcherOptions 上取，
 * 所以调用顺序与线上一致。
 */
function installDispatcher(
  payloads: Array<{ payload: Record<string, unknown>; kind: string }>,
) {
  return async (opts: {
    dispatcherOptions?: {
      deliver?: (p: unknown, i: { kind: string }) => Promise<void>;
      onFreshSettledDelivery?: () => Promise<{ visibleReplySent?: boolean } | undefined>;
    };
  }) => {
    const d = opts.dispatcherOptions;
    for (const { payload, kind } of payloads) {
      await d?.deliver?.(payload, { kind });
    }
    // 生产在 dispatch 收尾时调它，把 deferred 的 tool-warning 兜底发出去。
    await d?.onFreshSettledDelivery?.();
  };
}

function runtimeWith(dispatch: unknown) {
  return {
    config: { current: () => ({}) },
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: dispatch,
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: { body: string }) => body,
        finalizeInboundContext: (c: unknown) => c,
      },
      routing: { resolveAgentRoute: () => ({ agentId: "agent1", sessionKey: "sk", accountId: "acct1" }) },
      session: {
        resolveStorePath: () => "/tmp/store",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: async () => {},
      },
    },
  } as never;
}

beforeEach(() => {
  startEventPoller.mockClear();
  sendMessage.mockClear();
  postDocComment.mockClear();
});

const realFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  // captureHtmlPosts 直接改写了 globalThis.fetch（不是 vi.spyOn），
  // restoreAllMocks 收不回来 —— 不手动还原的话第二个用例会继续往
  // 第一个用例的数组里写，表现为「sent.length 是 0」。
  globalThis.fetch = realFetch;
});

describe("§2.1 doc-task 形态下的 intent 闭集（inbound.ts dispatcher 层）", () => {
  it("★ 只有工具失败警告的回合 ⇒ 出站 status=question，一条 applied 都不许有", async () => {
    const { setOctoRuntime } = await import("./runtime.js");
    setOctoRuntime(
      runtimeWith(
        vi.fn(
          installDispatcher([
            {
              // 非终止性工具错误警告，且没有真答复 ——
              // 生产会把它 defer 成 pendingToolWarningFinal，
              // 再由 onFreshSettledDelivery 兜底发出去。
              payload: { text: "⚠️ 工具执行失败：write_file 权限不足", isError: true, __toolWarning: true },
              kind: "final",
            },
          ]),
        ),
      ),
    );

    const sent = captureHtmlPosts();
    const stop = await startAccount({ docTasks: true, dispatchTimeoutMs: 2000, docsApiUrl: API });
    try {
      const options = pollerOptions().find((o) => typeof o.onDocMention === "function")!;
      const onDocMention = options.onDocMention as (mention: unknown) => Promise<void>;
      const { parseDocCommentMention } = await import("./doc-mention.js");

      await onDocMention(parseDocCommentMention(htmlDocEvent("toolwarn-notice")));

      // 先证明这条路真的走了 —— 空数组会让下面的 every() 恒真，
      // 那就是一个看着绿其实什么都没测的壳。
      expect(sent.length).toBeGreaterThan(0);
      const statuses = sent.map((b) => b.status);
      // ★ 承重断言。applied 会让上游 octo-doc 翻转父评论状态、发 marked_applied，
      // 把「执行失败」标成已解决，dedupe 再永久关闭任务。
      expect(statuses).not.toContain("applied");
      expect(statuses.every((s) => s === "question")).toBe(true);
    } finally {
      await stop();
    }
  }, 60_000);

  it("对照组：正常最终答复仍然是 applied（修复不能把产出一起降级成 question）", async () => {
    const { setOctoRuntime } = await import("./runtime.js");
    setOctoRuntime(
      runtimeWith(
        vi.fn(
          installDispatcher([
            { payload: { text: "标题已经改好了" }, kind: "final" },
          ]),
        ),
      ),
    );

    const sent = captureHtmlPosts();
    const stop = await startAccount({ docTasks: true, dispatchTimeoutMs: 2000, docsApiUrl: API });
    try {
      const options = pollerOptions().find((o) => typeof o.onDocMention === "function")!;
      const onDocMention = options.onDocMention as (mention: unknown) => Promise<void>;
      const { parseDocCommentMention } = await import("./doc-mention.js");

      await onDocMention(parseDocCommentMention(htmlDocEvent("normal-applied")));

      expect(sent.length).toBeGreaterThan(0);
      // 这条对照组是防「把 intent 一律改成 notice 就全绿」的那种假修复：
      // 真答复必须仍然认领终态。
      expect(sent.map((b) => b.status)).toContain("applied");
    } finally {
      await stop();
    }
  }, 60_000);
});
