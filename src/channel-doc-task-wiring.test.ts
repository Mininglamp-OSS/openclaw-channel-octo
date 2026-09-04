import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 文档任务在 **channel.ts 生产接线** 上的两条守卫。
 *
 * 为什么必须走生产接线:评审用变异验证指出,这两处改坏了全套测试照绿 ——
 *
 *   1. `const docTasksEnabled = account.config.docTasks === true` 改成 `= true`。
 *      `inbound.ts` 里 `grep docTasks` 是 0 命中 —— 它只看注入的 `docTask` 对象在不在,
 *      所以各测试 makeAccount 里那句 `docTasks: true` 是**装饰**,看着像门禁测试其实
 *      不是。真正的门禁只在 channel.ts,而没有任何测试碰过它。
 *
 *      门禁本身的承重理由(这条不随默认值变):评论正文是攻击者可控文本,IM 工具当前
 *      仍可从文档会话里调用,所以「谁能评论谁就能驱使 Bot」。特性最初是靠**默认关闭**
 *      来限制这个暴露面的;现在默认已翻成开启(PR #222,产品决定:开关是插件本地的、
 *      服务端没有对应字段,默认关意味着用户得先知道有这个开关,否则只会看到「@ 了没
 *      反应」)。残余风险改由三样东西承担,而不是靠默认值:显式 `docTasks: false` 是
 *      受支持的退出方式(README 里点名了不该开的场景),文档任务路径上 slash 命令被
 *      禁用、评论正文只作为引用值进入会话,以及下面这条门禁 —— 它保证只有布尔 `true`
 *      能开,写错类型不会静默半开。所以门禁越发不能被改成常量,这条测试是它的钉子。
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

vi.mock("./instance-id.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrCreateInstanceId: vi.fn(async () => "550e8400-e29b-41d4-a716-446655440000"),
}));

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
  // 注意:这里直接构造 account.config、**绕过了 accounts.ts 的解析**,所以「空配置」
  // 在这条测试里等于「门禁拿到 undefined」,不等于产品默认值。真实链路上未配置的账号
  // 会被 accounts.ts 兜底成 true(默认开启,见 accounts.test.ts)。这条钉的是门禁本身:
  // 拿不到 true 就不许起常驻轮询器。
  it("门禁拿不到 true(此处为 undefined):常驻轮询器不启动,文档事件根本收不到", async () => {
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

  it('docTasks: "true" 被拒时必须出声 —— 静默的话运维查不出「本想开却比不写还少」', async () => {
    // 上一条钉的是「拒掉」,这条钉的是「拒掉时说了」。默认已改成开启,所以写错类型的
    // 后果是**默认值的反面**:期待开,实得关。没有这行日志的话,现象和「配置没生效」
    // 完全一样,而配置文件里明明白白写着 docTasks。
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = await startAccount({ docTasks: "true" });
    try {
      const msg = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(msg).toContain("docTasks");
      expect(msg).toContain("string"); // 说出实收类型
      expect(msg).toContain("acct1"); // 说出是哪个账号
    } finally {
      await stop();
      warn.mockRestore();
    }
  });

  it("布尔值不告警 —— 正常配置不该往日志里添噪音", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = await startAccount({ docTasks: false });
    try {
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("[octo:doc-tasks]");
    } finally {
      await stop();
      warn.mockRestore();
    }
  });
});

describe("accounts.ts 默认值 → channel.ts 门禁:未配置的账号真的把轮询器开起来", () => {
  // 这条补的是评审点名的接缝。此前两侧各测各的:accounts.test.ts 断言解析器吐出
  // `docTasks === true`,本文件断言门禁认不认 `true` —— 但没有任何测试走完
  // 「配置里根本没写 docTasks」→ 常驻轮询器真的起来了 这条完整链路。
  // 也就是说把 accounts.ts 那句 `?? true` 删掉,两侧测试依然全绿(各自的前提都还成立),
  // 而产品行为已经退回默认关。这条测试就是那个缺口的钉子。
  //
  // 手法:不像上面的 startAccount 那样直接构造 config,而是喂一份**真实形态的 openclaw
  // 配置**给 resolveOctoAccount,把它解析出来的 config 原样交给 channel.ts。
  it("openclaw.json 里没有 docTasks 这个键 ⇒ onDocMention 已注册、轮询器常驻", async () => {
    const { resolveOctoAccount } = await import("./accounts.js");
    const resolved = resolveOctoAccount({
      cfg: {
        channels: {
          octo: {
            accounts: { acct1: { botToken: "tok", apiUrl: API } },
          },
        },
      } as never,
      accountId: "acct1",
    });
    // 前提自检:解析结果里确实没有人显式写过 true,是兜底给的。
    expect(resolved.config.docTasks).toBe(true);

    const stop = await startAccount(resolved.config as unknown as Record<string, unknown>);
    try {
      const withDoc = pollerOptions().filter((o) => typeof o.onDocMention === "function");
      expect(withDoc.length).toBeGreaterThan(0);
    } finally {
      await stop();
    }
  });

  it("openclaw.json 里写了 docTasks: false ⇒ 常驻轮询器不启动(退出方式仍然有效)", async () => {
    const { resolveOctoAccount } = await import("./accounts.js");
    const resolved = resolveOctoAccount({
      cfg: {
        channels: {
          octo: {
            accounts: { acct1: { botToken: "tok", apiUrl: API, docTasks: false } },
          },
        },
      } as never,
      accountId: "acct1",
    });
    expect(resolved.config.docTasks).toBe(false);

    const stop = await startAccount(resolved.config as unknown as Record<string, unknown>);
    try {
      expect(pollerOptions().filter((o) => o.onDocMention !== undefined)).toEqual([]);
    } finally {
      await stop();
    }
  });
});

describe("channel.ts:回帖打到文档域,不是 IM 域", () => {
  /**
   * 实测过的缺陷:回帖用的是 `account.config.apiUrl`(IM server)。文档域
   * `/v1/bot/docs/**` 由 docs-backend 提供 —— 拆开部署的栈里 IM 网关没有这条路由,
   * 于是每条回帖都拿到 404;404 是确定性失败,不重试,回复丢掉,兜底提示走的是同一
   * 个 endpoint 所以也发不出去。文档已经改完了 ⇒ 用户看到「正文被悄悄改了、评论区
   * 一个字都没有」。这两条把「回帖用哪个 base」钉在生产接线上。
   *
   * 用会话冲突回执做触发器:它是最短的一条「生产接线一定会 POST 一次」的路径。
   *
   * 走**真实的账号解析**(`resolveOctoAccount`)而不是手搭 config:「没配就退回
   * apiUrl」这条默认值本身就住在解析里,手搭 config 只会测到测试自己写的默认值。
   * 生产路径同样是解析出来的 —— channel.ts 的 `resolveAccount` adapter 就是它。
   */
  async function conflictPostArgs(octoAccount: Record<string, unknown>, key: string): Promise<{ apiUrl: string }> {
    const { resolveOctoAccount } = await import("./accounts.js");
    const resolved = resolveOctoAccount({
      cfg: {
        channels: {
          octo: {
            accounts: {
              acct1: {
                botToken: "tok",
                apiUrl: API,
                docTasks: true,
                dispatchTimeoutMs: 1000,
                ...octoAccount,
              },
            },
          },
        },
      } as never,
      accountId: "acct1",
    });
    const { setOctoRuntime } = await import("./runtime.js");
    setOctoRuntime({
      config: { current: () => ({}) },
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

    const stop = await startAccount(resolved.config as unknown as Record<string, unknown>);
    try {
      const options = pollerOptions().find((o) => typeof o.onDocMention === "function")!;
      const onDocMention = options.onDocMention as (mention: unknown) => Promise<void>;
      const { parseDocCommentMention } = await import("./doc-mention.js");
      // 每条用例用自己的 idempotency_key:去重存储是**持久**的,共用一个 key 会让
      // 后一条用例走「已处理,跳过」而一次 POST 都不发,断言就落在 undefined 上。
      await onDocMention(parseDocCommentMention({
        ...docEvent,
        event_data: { ...docEvent.event_data, idempotency_key: key },
      }));
      const first = postDocComment.mock.calls[0]?.[0] as { apiUrl: string } | undefined;
      expect(first).toBeDefined();
      return first!;
    } finally {
      await stop();
    }
  }

  it("没配 docsApiUrl:退回 apiUrl(托管环境一个网关前置两者)", async () => {
    expect((await conflictPostArgs({}, "docs:comment:wiring:base-default")).apiUrl).toBe(API);
  }, 60_000);

  it("配了 docsApiUrl:回帖打到它,而不是 IM 的 apiUrl", async () => {
    const DOCS = "http://docs-backend.test:3000";
    expect((await conflictPostArgs({ docsApiUrl: DOCS }, "docs:comment:wiring:base-split")).apiUrl)
      .toBe(DOCS);
  }, 60_000);
});

describe("channel.ts:会话冲突回执走评论区,不走发起人私聊", () => {
  it("生产接线下,冲突回执发到评论区且 IM 零出站", async () => {
    const { setOctoRuntime } = await import("./runtime.js");
    // dispatch 抛 core 的会话初始化冲突 —— channel.ts 的冲突分支由它触发。
    setOctoRuntime({
      config: { current: () => ({}) },
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
      const conflictPost = postDocComment.mock.calls[0]?.[0] as { signal?: AbortSignal };
      expect(conflictPost.signal).toBeInstanceOf(AbortSignal);
      // ……而不是发起人的私聊。
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      await stop();
    }
  }, 60_000);
});

/**
 * reviewer 第四轮 §Blocking:两条 notice-only 路径漏传 intent。
 *
 * 这两条**必须**断言 HTML 载荷里的 `status`,不能只断言「postComment 收到了 intent」——
 * 上一轮就是那么写的,结果把最后一跳写死回 applied 时测试照样全绿(见
 * doc-task-p1-closeout.test.ts §2.1 的注释)。这里让 postHtmlDocReply 走真实现,
 * 从 fetch 载荷里读 status,变异任一处的 "notice" 都会变红。
 */
describe("channel.ts:notice-only 路径在 HTML 文档上不得渲染成 applied", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** 装一个 fetch,记下每次 POST 的 body,供断言最终 status。 */
  function captureHtmlPosts(): Array<Record<string, unknown>> {
    const sent: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      sent.push(body);
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

  const htmlDocEvent = {
    ...docEvent,
    event_data: { ...docEvent.event_data, doc_kind: "html", idempotency_key: "docs:comment:html-notice" },
  };

  it("会话冲突回执 ⇒ status=question", async () => {
    const { setOctoRuntime } = await import("./runtime.js");
    setOctoRuntime({
      config: { current: () => ({}) },
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

    const sent = captureHtmlPosts();
    const stop = await startAccount({ docTasks: true, dispatchTimeoutMs: 1000, docsApiUrl: API });
    try {
      const options = pollerOptions().find((o) => typeof o.onDocMention === "function")!;
      const onDocMention = options.onDocMention as (mention: unknown) => Promise<void>;
      const { parseDocCommentMention } = await import("./doc-mention.js");

      await onDocMention(parseDocCommentMention(htmlDocEvent));

      // HTML 分流生效:走的是 postHtmlDocReply(fetch),不是 postDocComment。
      expect(postDocComment).not.toHaveBeenCalled();
      const statuses = sent.map((b) => b.status);
      // 冲突回执是 notice-only —— 一条都不许是 applied。
      expect(statuses).toEqual(["question"]);
    } finally {
      await stop();
    }
  }, 60_000);

  it("「本次没有给出答复」兜底通知 ⇒ status=question", async () => {
    const { setOctoRuntime } = await import("./runtime.js");
    // dispatch 正常返回但什么都没发 ⇒ handler 走 userLeftHanging 兜底。
    setOctoRuntime({
      config: { current: () => ({}) },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => {}),
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

    const sent = captureHtmlPosts();
    const stop = await startAccount({ docTasks: true, dispatchTimeoutMs: 1000, docsApiUrl: API });
    try {
      const options = pollerOptions().find((o) => typeof o.onDocMention === "function")!;
      const onDocMention = options.onDocMention as (mention: unknown) => Promise<void>;
      const { parseDocCommentMention } = await import("./doc-mention.js");

      await onDocMention(
        parseDocCommentMention({
          ...htmlDocEvent,
          event_data: { ...htmlDocEvent.event_data, idempotency_key: "docs:comment:html-hanging" },
        }),
      );

      const statuses = sent.map((b) => b.status);
      expect(statuses).toEqual(["question"]);
    } finally {
      await stop();
    }
  }, 60_000);
});
