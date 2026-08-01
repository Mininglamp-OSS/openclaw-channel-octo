import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 文档任务在 **channel.ts 生产接线** 上的两条守卫。
 *
 * 为什么必须走生产接线:评审用变异验证指出,这两处改坏了全套测试照绿 ——
 *
 *   1. `const docTasksEnabled = account.config.docTasks === true` 改成 `= true`。
 *      `inbound.ts` 里 `grep docTasks` 是 0 命中 —— 它只看注入的 `docTask` 对象在不在,
 *      所以各测试 makeAccount 里那句 `docTasks: true` 是**装饰**,看着像门禁测试其实
 *      不是。真正的门禁只在 channel.ts,而没有任何测试碰过它。而「默认关闭」正是
 *      这个特性能先合进来的前提(评论正文是攻击者可控文本,IM 工具当前仍可从文档
 *      会话里调用)。
 *
 *   2. 会话冲突回执的 `if (extra?.docTask)` 改成 `if (false)`,回执就退回
 *      `notifyInboundConflictDropped` → sendMessage 到发起人私聊(第五处 IM 出口,
 *      修过一次)。原来那条「会话冲突」测试是 stub 自己手发的回执,测的是测试自己
 *      重实现的一遍接线 —— 正是 doc-mention-handler.ts 抽出来要消灭的反模式。
 *
 * 手法:mock 掉 socket / events-poll / api-fetch,真跑 `gateway.startAccount`,
 * 从 `startEventPoller` 收到的 options 里把生产的 `onDocMention` 取出来直接驱动。
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
    sendMessage: (...args: unknown[]) => sendMessage(...(args as [])),
    postDocComment: (...args: unknown[]) => postDocComment(...(args as [])),
  };
});

const API = "http://octo.test";

/**
 * `startAccount` 返回的 Promise 会一直挂着直到 abort(gateway 用 resolve 表示
 * 「账号已停止」),所以不能直接 await 它 —— 起完之后 abort 再收尾。
 */
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
  // 让 startAccount 跑到「挂起等 abort」那一步(registerBot 等都是 await 的)。
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 5));
  return async () => { controller.abort(); await running; };
}

function pollerOptions(): Array<Record<string, unknown>> {
  return (startEventPoller.mock.calls as unknown as Array<[Record<string, unknown>]>).map(([o]) => o);
}

const docEvent = {
  event_id: 4242,
  event_type: "doc_comment_mention",
  event_data: {
    idempotency_key: "docs:comment:wiring",
    doc_id: "d1",
    comment_id: "77",
    thread_id: "70",
    from_uid: "human_1",
    bot_uid: "bot_wiring_0000000000000000000000000",
    text: "改一下",
  },
};

beforeEach(() => {
  startEventPoller.mockClear();
  sendMessage.mockClear();
  postDocComment.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("channel.ts:docTasks 开关是真的门禁", () => {
  // 关键点:轮询器是**懒启动**的(发过卡片才起),文档任务则要求常驻 ——
  // `if (docTasksEnabled) startCardEventPoller()`。所以「开关关着」等价于
  // 「轮询器根本没起」,这条断言把那句 `=== true` 真正钉住了。
  it("未开启:常驻轮询器不启动,文档事件根本收不到", async () => {
    const stop = await startAccount({});
    try {
      expect(pollerOptions().filter((o) => o.onDocMention !== undefined)).toEqual([]);
    } finally {
      await stop();
    }
  });

  it("显式 docTasks: true:轮询器常驻,且注册了 onDocMention", async () => {
    const stop = await startAccount({ docTasks: true });
    try {
      const withDoc = pollerOptions().filter((o) => typeof o.onDocMention === "function");
      expect(withDoc.length).toBeGreaterThan(0);
    } finally {
      await stop();
    }
  });

  it('docTasks: "true" 这类真值不算开启 —— 门禁是严格 === true', async () => {
    const stop = await startAccount({ docTasks: "true" });
    try {
      expect(pollerOptions().filter((o) => o.onDocMention !== undefined)).toEqual([]);
    } finally {
      await stop();
    }
  });
});

describe("channel.ts:会话冲突回执走评论区,不走发起人私聊", () => {
  it("生产接线下,冲突回执发到评论区且 IM 零出站", async () => {
    const { setOctoRuntime } = await import("./runtime.js");
    // dispatch 抛 core 的会话初始化冲突 —— channel.ts 的冲突分支由它触发。
    setOctoRuntime({
      config: { loadConfig: () => ({}) },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => {
            throw new Error("reply session initialization conflicted for agent:x");
          }),
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
    } as never);

    const stop = await startAccount({ docTasks: true, dispatchTimeoutMs: 1000 });
    try {
      const options = pollerOptions().find((o) => typeof o.onDocMention === "function")!;
      const onDocMention = options.onDocMention as (mention: unknown) => Promise<void>;
      const { parseDocCommentMention } = await import("./doc-mention.js");

      await onDocMention(parseDocCommentMention(docEvent));

      // 回执进了评论区……
      const bodies = postDocComment.mock.calls.map(
        (call: unknown) => (call as [{ body: string }])[0].body,
      );
      // 必须是 toEqual 而不是 some:SESSION_INIT_RETRY 会重试 4 次,inbound 若在
      // 每次尝试里都道歉一遍,评论区就是 5 句道歉 + 1 条回执,而 `some` 照样通过。
      expect(bodies).toEqual(["⚠️ 上一轮任务尚未结束，本次请求已跳过。请稍后重试。"]);
      // ……而不是发起人的私聊。
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      await stop();
    }
  }, 60_000);
});
