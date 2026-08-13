import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 第五轮 review P1-2 的回归钉子：**带附件的工具失败警告不得以 `applied` 出站**。
 *
 * 缺陷形态（上一轮修复留下的洞）：
 *   `isFallbackOnlyToolWarningFinal` 一个谓词同时回答了两个问题 ——
 *   「它算不算真答复」（内容性质）和「要不要延后缓冲」（投递策略）。后者额外受
 *   附件约束：带附件不能延后，因为延后只保留文本、附件会随缓冲一起丢掉。
 *   于是**带附件**的工具警告在策略问题上答 false，顺带把性质问题也答成了
 *   「是真答复」，掉进正常 final 分支，以 `intent: "output" + final: true` 出站，
 *   落库 `status: "applied"`。
 *
 *   上一轮那条锁（doc-task-tool-warning-intent.test.ts）只造了**不带附件**的
 *   payload，正好走 defer 分支，所以它绿着，洞照样在。
 *
 * 承重后果与上一轮同源：`applied` 在上游 octo-doc 会翻转父评论状态并发
 * `marked_applied`，把「⚠️ 工具执行失败」标成已解决，dedupe 随后永久关闭任务 ——
 * 而这次连重试的机会都没有。
 *
 * 修法：拆出 `isNonTerminalToolErrorWarning`（只答性质），final 分支据它给
 * `deliverFinalText` 传 `claimsCompletion: false`。附件照发（不丢），徽章降成
 * `partial`，回合仍算「没有 final」，由既有兜底补 notice。
 *
 * 下面每条断言都只由这个修法决定红绿：把 `claimsCompletion: !isToolWarningWithMedia`
 * 改回无条件 true，★ 那条立刻变红。
 */

const startEventPoller = vi.fn((_options?: unknown) => ({ ready: Promise.resolve(), stop: () => {}, cursor: () => 0 }));
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

// 同 doc-task-tool-warning-intent.test.ts：不 mock 分类器的话，SDK 对合成 payload
// 一律返回 false，这条支路进不去，测试变成恒绿空壳。
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

function captureHtmlPosts(): Array<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
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

/** 见 doc-task-tool-warning-intent.test.ts：dedupe 是文件持久的，key 必须每轮唯一。 */
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function htmlDocEvent(key: string) {
  return {
    event_id: 4343,
    event_type: "doc_comment_mention",
    event_data: {
      idempotency_key: `docs:comment:toolwarn-media:${RUN_ID}:${key}`,
      doc_id: "d1",
      comment_id: "88",
      thread_id: "80",
      from_uid: "human_1",
      bot_uid: "bot_wiring_0000000000000000000000000",
      text: "改一下",
      doc_kind: "html",
    },
  };
}

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
    await d?.onFreshSettledDelivery?.();
  };
}

function runtimeWith(dispatch: unknown) {
  return {
    config: { loadConfig: () => ({}) },
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
  globalThis.fetch = realFetch;
});

describe("P1-2 带附件的工具失败警告不得宣称完成", () => {
  it("★ 工具警告带附件 ⇒ 出站不含 applied（附件照发，徽章说实话）", async () => {
    const { setOctoRuntime } = await import("./runtime.js");
    setOctoRuntime(
      runtimeWith(
        vi.fn(
          installDispatcher([
            {
              // 关键差异：带 media。这正是 isFallbackOnlyToolWarningFinal 返回
              // false、payload 掉进正常 final 分支的那条路 —— 上一轮那条锁没造它。
              payload: {
                text: "⚠️ 工具执行失败：只生成了部分结果",
                isError: true,
                __toolWarning: true,
                mediaUrls: ["http://cdn.test/partial.png"],
              },
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

      await onDocMention(parseDocCommentMention(htmlDocEvent("toolwarn-media")));

      // 空数组会让 not.toContain 恒真 —— 先证明这条路真的走了。
      expect(sent.length).toBeGreaterThan(0);
      const statuses = sent.map((b) => b.status);
      // ★ 承重断言：一条 applied 都不许有。applied ⇒ 上游翻转父评论状态、
      // 发 marked_applied、dedupe 永久关闭任务。
      expect(statuses).not.toContain("applied");
    } finally {
      await stop();
    }
  }, 60_000);

  it("附件本身没有被丢掉（修法不许拿「不发附件」换徽章正确）", async () => {
    // 没有这一条，把带附件的警告改成走 defer（附件丢光）也能让上面那条绿。
    const { setOctoRuntime } = await import("./runtime.js");
    setOctoRuntime(
      runtimeWith(
        vi.fn(
          installDispatcher([
            {
              payload: {
                text: "⚠️ 工具执行失败：只生成了部分结果",
                isError: true,
                __toolWarning: true,
                mediaUrls: ["http://cdn.test/partial.png"],
              },
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

      await onDocMention(parseDocCommentMention(htmlDocEvent("toolwarn-media-kept")));

      expect(sent.length).toBeGreaterThan(0);
      const allText = sent.map((b) => String(b.text)).join("\n");
      expect(allText).toContain("http://cdn.test/partial.png");
    } finally {
      await stop();
    }
  }, 60_000);

  it("负向对照：带附件的**真答复**仍然是 applied（没有误伤正常产出）", async () => {
    // 防「凡是带附件就降级」这种过度修复 —— 那样正常的图文产出再也认领不了终态。
    const { setOctoRuntime } = await import("./runtime.js");
    setOctoRuntime(
      runtimeWith(
        vi.fn(
          installDispatcher([
            {
              payload: { text: "图已经画好并插入文档了", mediaUrls: ["http://cdn.test/final.png"] },
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

      await onDocMention(parseDocCommentMention(htmlDocEvent("normal-media-applied")));

      expect(sent.length).toBeGreaterThan(0);
      expect(sent.map((b) => b.status)).toContain("applied");
    } finally {
      await stop();
    }
  }, 60_000);
});
