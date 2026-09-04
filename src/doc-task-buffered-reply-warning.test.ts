import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 第五轮 review 的 🔴 回归钉子：**缓冲 block 答复落地之后，延后的工具错误播报
 * 不许再被 finally 补发出去。**
 *
 * 缺陷形状（reviewer 描述的序列）：
 *   1. agent 的答复只以 `block` 到达 —— 被 deliverBuffer 缓冲，
 *      `userFacingFinalDelivered` 保持 false（block 不置位，它要等 finally flush）。
 *   2. 随后一条带 `isError` 的 `final` 到达 —— 被判成「非终止性工具错误警告」，
 *      defer 进 `pendingToolWarningFinal`。
 *   3. 宿主/SDK **不调用** `onFreshSettledDelivery`（这正是 finally-flush 存在的理由：
 *      老宿主没实现，或新消息抢占跳过）。
 *   4. finally 把缓冲的真答复发出去 —— 但上一轮它只写 `replySucceeded`，
 *      没写 `userFacingFinalDelivered`，也没清 pending。
 *   5. 紧接着的 pending flush 于是照发一条「⚠️ 🛠️ … failed」。
 *
 * 结果：评论区先出现一条正确答复，后面跟一条自相矛盾的失败提示 —— 正是本 PR
 * 要消灭的失败形态。`onFreshSettledDelivery` 里那条「缓冲里有真答复 ⇒ 丢掉警告
 * 兜底」的纪律（src/inbound.ts:3581）只在被调用时生效，finally 这条镜像路径缺了。
 *
 * 为什么要走生产接线而不是单测某个函数：这个缺陷活在**两条投递路径之间的状态
 * 交接**上，任何一边单独看都是对的。只有真跑 dispatcher、从出站报文上数条数才
 * 抓得住。手法沿用 doc-task-tool-warning-intent.test.ts。
 */

const startEventPoller = vi.fn((_options?: unknown) => ({ ready: Promise.resolve(), stop: () => {}, cursor: () => 0 }));
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
    sendMessage: (...args: unknown[]) => (sendMessage as (...a: unknown[]) => unknown)(...args),
    postDocComment: (...args: unknown[]) => (postDocComment as (...a: unknown[]) => unknown)(...args),
  };
});

// 同 doc-task-tool-warning-intent.test.ts：不 mock 分类器的话，合成 payload 进不了
// 「非终止性工具错误警告」支路，defer 根本不发生，测试变成恒绿空壳。
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

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function htmlDocEvent(key: string) {
  return {
    event_id: 4343,
    event_type: "doc_comment_mention",
    event_data: {
      idempotency_key: `docs:comment:buffered-warning:${RUN_ID}:${key}`,
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
 * 关键差异：`skipSettledCallback` 为 true 时**不调用** `onFreshSettledDelivery`，
 * 模拟老宿主 / 被抢占的那一回合 —— 这正是 finally-flush 存在的场景，也正是
 * 缺陷现场。
 */
function installDispatcher(
  payloads: Array<{ payload: Record<string, unknown>; kind: string }>,
  opts: { skipSettledCallback?: boolean; throwAfter?: boolean } = {},
) {
  return async (o: {
    dispatcherOptions?: {
      deliver?: (p: unknown, i: { kind: string }) => Promise<void>;
      onFreshSettledDelivery?: () => Promise<{ visibleReplySent?: boolean } | undefined>;
    };
  }) => {
    const d = o.dispatcherOptions;
    for (const { payload, kind } of payloads) {
      await d?.deliver?.(payload, { kind });
    }
    if (!opts.skipSettledCallback) await d?.onFreshSettledDelivery?.();
    // dispatch 自身 reject（如 non_deliverable_terminal_turn）：走 catch 里的
    // 「有缓冲正文就发正文」分支，onError 从未被调用，onFreshSettledDelivery 也没跑。
    if (opts.throwAfter) throw new Error("non_deliverable_terminal_turn");
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
  globalThis.fetch = realFetch;
});

const REAL_ANSWER = "标题已经改成《季度复盘》了";
const TOOL_WARNING = "⚠️ 🛠️ Exec failed: /bin/sh -c curl -H 'Authorization: Bearer sk-live-xyz' https://x";

describe("缓冲 block 答复 + 未消费的工具警告（finally-flush 的镜像守卫）", () => {
  it("★ block 答复 → isError final → 宿主跳过回调 ⇒ finally 只发答复，不许追发失败提示", async () => {
    const { setOctoRuntime } = await import("./runtime.js");
    setOctoRuntime(
      runtimeWith(
        vi.fn(
          installDispatcher(
            [
              // 真答复只以 block 到达：被缓冲，userFacingFinalDelivered 仍是 false。
              { payload: { text: REAL_ANSWER }, kind: "block" },
              // 随后一条工具错误播报：被 defer 成 pendingToolWarningFinal。
              { payload: { text: TOOL_WARNING, isError: true, __toolWarning: true }, kind: "final" },
            ],
            // ★ 宿主不调 onFreshSettledDelivery —— finally-flush 的场景。
            { skipSettledCallback: true },
          ),
        ),
      ),
    );

    const sent = captureHtmlPosts();
    const stop = await startAccount({ docTasks: true, dispatchTimeoutMs: 2000, docsApiUrl: API });
    try {
      const options = pollerOptions().find((o) => typeof o.onDocMention === "function")!;
      const onDocMention = options.onDocMention as (mention: unknown) => Promise<void>;
      const { parseDocCommentMention } = await import("./doc-mention.js");

      await onDocMention(parseDocCommentMention(htmlDocEvent("buffered-then-warning")));

      const texts = sent.map((b) => String(b.text));
      // 先证明这条路真的跑了：缓冲的真答复必须落地。空数组会让下面的
      // 「不含」断言恒真，那就是个看着绿其实什么都没测的壳。
      expect(texts.some((t) => t.includes(REAL_ANSWER))).toBe(true);
      // ★ 承重断言：真答复之后不许再出现工具失败播报。
      expect(texts.some((t) => t.includes("Exec failed"))).toBe(false);
      expect(texts.some((t) => t.startsWith("⚠️ 🛠️ "))).toBe(false);
      // 顺带钉死凭证不会随净化后的提示外泄（提示压根不该发）。
      expect(texts.some((t) => t.includes("Bearer"))).toBe(false);
    } finally {
      await stop();
    }
  }, 60_000);

  it("★ dispatch reject 分支：缓冲答复被发出后，同样不许追发工具失败提示", async () => {
    const { setOctoRuntime } = await import("./runtime.js");
    setOctoRuntime(
      runtimeWith(
        vi.fn(
          installDispatcher(
            [
              { payload: { text: REAL_ANSWER }, kind: "block" },
              { payload: { text: TOOL_WARNING, isError: true, __toolWarning: true }, kind: "final" },
            ],
            // dispatch 本身 reject 且 onError 没被调用 —— 走 catch 里的
            // 「有缓冲正文就发正文」分支。它和 finally-flush 是两条独立路径，
            // 上一轮两条都只写了 replySucceeded，所以要分别钉。
            { skipSettledCallback: true, throwAfter: true },
          ),
        ),
      ),
    );

    const sent = captureHtmlPosts();
    const stop = await startAccount({ docTasks: true, dispatchTimeoutMs: 2000, docsApiUrl: API });
    try {
      const options = pollerOptions().find((o) => typeof o.onDocMention === "function")!;
      const onDocMention = options.onDocMention as (mention: unknown) => Promise<void>;
      const { parseDocCommentMention } = await import("./doc-mention.js");

      // handler 会把 dispatch 的 reject 吞掉/上报，这里不关心它抛不抛，
      // 只看评论区实际收到了什么。
      await onDocMention(parseDocCommentMention(htmlDocEvent("dispatch-reject-buffered"))).catch(() => {});

      const texts = sent.map((b) => String(b.text));
      expect(texts.some((t) => t.includes(REAL_ANSWER))).toBe(true);
      expect(texts.some((t) => t.includes("Exec failed"))).toBe(false);
      expect(texts.some((t) => t.startsWith("⚠️ 🛠️ "))).toBe(false);
    } finally {
      await stop();
    }
  }, 60_000);

  it("对照组：没有真答复时，跳过回调的那一回合仍然必须补出警告（守卫不能把兜底一起吃掉）", async () => {
    const { setOctoRuntime } = await import("./runtime.js");
    setOctoRuntime(
      runtimeWith(
        vi.fn(
          installDispatcher(
            [{ payload: { text: TOOL_WARNING, isError: true, __toolWarning: true }, kind: "final" }],
            { skipSettledCallback: true },
          ),
        ),
      ),
    );

    const sent = captureHtmlPosts();
    const stop = await startAccount({ docTasks: true, dispatchTimeoutMs: 2000, docsApiUrl: API });
    try {
      const options = pollerOptions().find((o) => typeof o.onDocMention === "function")!;
      const onDocMention = options.onDocMention as (mention: unknown) => Promise<void>;
      const { parseDocCommentMention } = await import("./doc-mention.js");

      await onDocMention(parseDocCommentMention(htmlDocEvent("warning-only-no-callback")));

      const texts = sent.map((b) => String(b.text));
      // 这条对照组防「把 finally flush 直接删掉/无条件跳过」那种假修复：
      // 整回合只有警告时，静默吞掉才是更坏的失败。
      expect(texts.some((t) => t.includes("Exec failed"))).toBe(true);
      // 发出去的必须是净化过的，命令行与凭证不进公开评论区。
      expect(texts.some((t) => t.includes("Bearer"))).toBe(false);
      expect(sent.map((b) => b.status)).not.toContain("applied");
    } finally {
      await stop();
    }
  }, 60_000);
});
