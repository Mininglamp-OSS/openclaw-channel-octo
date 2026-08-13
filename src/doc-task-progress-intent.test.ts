import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P1-2 的**承重锁**：中间态产出必须以 `status: "partial"` 出站，只有真答复才配 `applied`。
 *
 * 为什么必须另开这个文件、走生产接线：
 *
 *   `doc-task-p1-closeout.test.ts` 里那条 `progress ⇒ partial` 是**假锁**。它直接调
 *   `postHtmlDocReply(..., "progress")`，测的只是 api-fetch 里那张映射表；判决点
 *   （`inbound.ts` 的 `replyIntent = intent.type === "notice" ? "notice" : claimsFinal
 *   ? "final" : "progress"`）根本不在它的路径上。红检实测：把那行判决写死成
 *   `"final"`，closeout 的 13 条**全绿** —— 一条都没红。锁不住修法的锁不是锁。
 *
 *   本文件把断言落回**真实出站报文的 status 字段**，且让报文由生产 dispatcher 一路
 *   产生，中间不插桩 —— 判决点一旦被合并回单一 intent，这里必红。
 *
 * 承重后果（为什么这是 P1）：
 *   上游 octo-doc 见 `status: "applied"` 会翻转父评论状态并发 `marked_applied`，
 *   dedupe 随即把任务**永久关闭**。中间态若打 applied，用户的诉求在真答复到达之前
 *   就被判定「已解决」，而真答复再也送不出来 —— 失败模式是假装成功，最难 triage。
 *
 * 手法沿用 `doc-task-tool-warning-intent.test.ts`：mock socket / events-poll /
 * api-fetch，真跑 `gateway.startAccount`，从 startEventPoller 收到的 options 里取
 * 生产的 `onDocMention` 驱动，再从 fetch body 上读 status。
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

/** 去重存储是文件持久的，固定 key 会让第二次运行被判重复而静默跳过。 */
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function htmlDocEvent(key: string) {
  return {
    event_id: 4343,
    event_type: "doc_comment_mention",
    event_data: {
      idempotency_key: `docs:comment:progress-intent:${RUN_ID}:${key}`,
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

function installDispatcher(payloads: Array<{ payload: Record<string, unknown>; kind: string }>) {
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

/**
 * 驱动一个回合并返回真实出站报文。
 *
 * 中间态用「带附件的工具产出」造：不带附件的 tool 文本会被生产刻意抑制
 * （评论区只留结论），那条路发不出报文，测不到 status。带 http(s) 附件的
 * 那一条不抑制 —— 抑制它等于永久丢弃产出。
 */
async function runTurn(
  payloads: Array<{ payload: Record<string, unknown>; kind: string }>,
  key: string,
): Promise<Array<Record<string, unknown>>> {
  const { setOctoRuntime } = await import("./runtime.js");
  setOctoRuntime(runtimeWith(vi.fn(installDispatcher(payloads))));
  const sent = captureHtmlPosts();
  const stop = await startAccount({ docTasks: true, dispatchTimeoutMs: 2000, docsApiUrl: API });
  try {
    const options = pollerOptions().find((o) => typeof o.onDocMention === "function")!;
    const onDocMention = options.onDocMention as (mention: unknown) => Promise<void>;
    const { parseDocCommentMention } = await import("./doc-mention.js");
    await onDocMention(parseDocCommentMention(htmlDocEvent(key)));
  } finally {
    await stop();
  }
  return sent;
}

describe("P1-2 中间态 intent（inbound.ts 判决点）", () => {
  it("★ 中间态产出 ⇒ status=partial，绝不能是 applied（applied 会让上游提前判定已解决）", async () => {
    const sent = await runTurn(
      [
        {
          payload: { text: "正在读取文档…", mediaUrl: "https://cdn.test/step1.png" },
          kind: "tool",
        },
      ],
      "progress-partial",
    );

    // 空数组会让下面的断言恒真 —— 先证明这条路真的发出了报文。
    expect(sent.length).toBeGreaterThan(0);
    const statuses = sent.map((b) => b.status);
    // ★ 只由「final 与 progress 分家」这个修法决定红绿：判决点合并回单一 intent
    //   （或写死 "final"）时，这里立刻变成 applied 而红。
    // 这一回合只有中间态、没有真答复，所以生产还会补一条兜底通知（question）。
    // 只断言 status 集合，不断言条数 —— 兜底文案不归本修法管。
    expect(statuses).not.toContain("applied");
    expect(statuses).toContain("partial");
    // 带着进度文本的那一条必须是 partial（而不是让兜底那条替它顶包）。
    const progressPost = sent.find((b) => String(b.text).includes("正在读取文档"))!;
    expect(progressPost).toBeDefined();
    expect(progressPost.status).toBe("partial");
  }, 60_000);

  it("同一回合先中间态后真答复 ⇒ partial 在前、applied 在后，顺序与归属都不许错位", async () => {
    const sent = await runTurn(
      [
        { payload: { text: "正在改写…", mediaUrl: "https://cdn.test/step2.png" }, kind: "tool" },
        { payload: { text: "已按要求改写完成" }, kind: "final" },
      ],
      "progress-then-final",
    );

    expect(sent.length).toBeGreaterThanOrEqual(2);
    const statuses = sent.map((b) => b.status);
    // 负向对照之一：修法不能把真答复一起降级成 partial —— 那样任务永远不收口。
    expect(statuses).toContain("applied");
    expect(statuses).toContain("partial");
    // 归属必须对上：中间态那条带的是进度文本，applied 那条带的是真答复。
    const partial = sent.find((b) => b.status === "partial")!;
    const applied = sent.find((b) => b.status === "applied")!;
    expect(String(partial.text)).toContain("正在改写");
    expect(String(applied.text)).toContain("已按要求改写完成");
    // 顺序：applied 必须是最后一条，中间态不许排在真答复之后。
    expect(statuses[statuses.length - 1]).toBe("applied");
  }, 60_000);

  it("负向对照：只有真答复的回合仍然是 applied（不许一律降级成 partial 来骗绿）", async () => {
    const sent = await runTurn(
      [{ payload: { text: "标题已经改好了" }, kind: "final" }],
      "final-only-applied",
    );

    expect(sent.length).toBeGreaterThan(0);
    expect(sent.map((b) => b.status)).toContain("applied");
    expect(sent.map((b) => b.status)).not.toContain("partial");
  }, 60_000);
});
