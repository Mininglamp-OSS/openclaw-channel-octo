import { describe, expect, it, vi } from "vitest";
import { createDocMentionHandler } from "./doc-mention-handler.js";
import { createMemoryDocMentionDedupeStore } from "./doc-mention-dedupe.js";
import { parseDocCommentMention, type DocCommentMention } from "./doc-mention.js";
import { DocCommentRejectedError } from "./api-fetch.js";

/**
 * 接线本身的回归测试。
 *
 * 这段逻辑原先长在 startAccount 的闭包里,测试只能重新实现一遍接线 —— 于是
 * 「去重什么时候写盘」「异常要不要外抛」这类接线层的错误根本抓不到。抽出来后
 * 直接测真实实现。
 */

const BOT_UID = "bot1";

function mention(overrides: Record<string, unknown> = {}): DocCommentMention {
  return parseDocCommentMention({
    event_id: 1001,
    event_type: "doc_comment_mention",
    event_data: {
      idempotency_key: "k1",
      doc_id: "d1",
      comment_id: "77",
      thread_id: "70",
      from_uid: "u1",
      bot_uid: BOT_UID,
      text: "改一下",
      ...overrides,
    },
  })!;
}

function makeHandler(dispatch: any, postCommentImpl?: any) {
  const dedupe = createMemoryDocMentionDedupeStore();
  const postComment = vi.fn(postCommentImpl ?? (async () => {}));
  const handler = createDocMentionHandler({
    botUid: BOT_UID,
    dedupe,
    dispatch,
    postComment,
    log: undefined,
  });
  return { handler, dedupe, postComment };
}

describe("文档任务接线", () => {
  it("成功投递后写入持久去重,同 key 不再执行", async () => {
    // 「成功」以确实发出过评论为准 —— 只是 dispatch 没抛异常不算(见不变量 1)
    const dispatch = vi.fn(async (_m: any, _r: any, extra: any) => {
      await extra.docTask.postComment("已改好");
      extra.docTask.reportTurn({ finalDelivered: true, delivered: true, lost: false, noticed: false });
      return "completed" as const;
    });
    const { handler, dedupe } = makeHandler(dispatch);

    await handler(mention());
    await handler(mention());

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await dedupe.claim("k1")).toBe(true);
  });

  it("dispatch 抛错:不外抛,且释放 claim 让重投得以重放", async () => {
    // 回归:外抛会让轮询器游标停在原地 → 重投 → 再次失败 → 每个轮询周期一次死循环。
    // 而若此时把 key 写进持久去重,任务则被永久静默丢弃(reviewer 指出这条比崩溃常见得多)。
    const dispatch = vi.fn(async () => { throw new Error("non_deliverable_terminal_turn"); });
    const { handler, dedupe } = makeHandler(dispatch);

    await expect(handler(mention())).resolves.toBeUndefined();

    expect(await dedupe.claim("k1")).toBe(false); // 未被标记为已完成
  });

  it("dispatch 返回 dropped 且未投递:释放,不写持久去重", async () => {
    const dispatch = vi.fn(async () => "dropped" as const);
    const { handler, dedupe } = makeHandler(dispatch);

    await handler(mention());

    expect(await dedupe.claim("k1")).toBe(false);
  });

  it("事件指向别的 bot:不 dispatch,也不污染去重存储", async () => {
    const dispatch = vi.fn(async () => "completed" as const);
    const { handler, dedupe } = makeHandler(dispatch);

    await handler(mention({ bot_uid: "other_bot" }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(await dedupe.claim("k1")).toBe(false);
  });

  it("传给 dispatch 的 docTask 作用域与队列作用域按评论串派生", async () => {
    const dispatch = vi.fn(async () => "completed" as const);
    const { handler } = makeHandler(dispatch);

    await handler(mention());

    const [, , extra] = dispatch.mock.calls[0] as any;
    expect(extra.queueScope).toBe("doctask:d1:70");
    expect(extra.docTask).toMatchObject({ docId: "d1", threadId: "70", sessionScope: "doctask:d1:70" });
  });

  it("docTask.postComment 透传到注入的实现", async () => {
    const dispatch = vi.fn(async (_m: any, _r: any, extra: any) => {
      await extra.docTask.postComment("已改好");
      extra.docTask.reportTurn({ finalDelivered: true, delivered: true, lost: false, noticed: false });
      return "completed" as const;
    });
    const { handler, postComment } = makeHandler(dispatch);

    await handler(mention());

    expect(postComment).toHaveBeenCalledWith(expect.objectContaining({ docId: "d1" }), "已改好", undefined);
  });

  // --- 投递结果必须可观测 ---
  // 根因:完成状态原先是靠「handler 没抛异常」推断的,从不校验评论到底发出去没有。
  // 于是「回帖失败」「media-only 无文本」「dispatch 前早返回」三条路径都会被当成
  // 成功 —— 事件 ack、去重落盘、评论区静默、永不重试。

  it("回帖始终失败:不得写入持久去重(否则一次瞬时 5xx 就永久丢回复)", async () => {
    const dispatch = vi.fn(async (_m: any, _r: any, extra: any) => {
      await extra.docTask.postComment("已改好").catch(() => {});
      // POST 没成 → finalDelivered 为假(它由出站收口在成功之后才置位)
      extra.docTask.reportTurn({ finalDelivered: false, delivered: false, lost: true, noticed: false });
      return "completed" as const;
    });
    const { handler, dedupe } = makeHandler(dispatch, async () => { throw new Error("docs API 503"); });

    await handler(mention());

    // 未标记完成 → server 重投时仍可重放
    expect(await dedupe.claim("k1")).toBe(false);
  });

  it("回帖瞬时失败后重试成功:视为已投递并写入去重", async () => {
    let attempts = 0;
    const dispatch = vi.fn(async (_m: any, _r: any, extra: any) => {
      await extra.docTask.postComment("已改好");
      extra.docTask.reportTurn({ finalDelivered: true, delivered: true, lost: false, noticed: false });
      return "completed" as const;
    });
    const { handler, dedupe } = makeHandler(dispatch, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("docs API 503");
    });

    await handler(mention());

    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(await dedupe.claim("k1")).toBe(true);
  });

  it("dispatch 返回 completed 却一条评论都没发:补兜底评论,且不写去重", async () => {
    // 覆盖 dispatch 之前的早返回(resolveAgentRoute 抛错、能力门禁等):
    // 那些是正常返回而非异常,连 catch 都进不去。
    const dispatch = vi.fn(async () => "completed" as const);
    const { handler, dedupe, postComment } = makeHandler(dispatch);

    await handler(mention());

    expect(postComment).toHaveBeenCalledTimes(1); // 兜底,保证评论区有痕迹
    expect(await dedupe.claim("k1")).toBe(false); // 兜底不算成功交付
  });

  it("兜底评论使用显式短超时,不能按 postDocComment 默认值阻塞串行 poller", async () => {
    const dispatch = vi.fn(async () => "completed" as const);
    const signals: Array<AbortSignal | undefined> = [];
    const { handler } = makeHandler(dispatch, async (_mention: unknown, _text: string, signal?: AbortSignal) => {
      signals.push(signal);
    });

    await handler(mention());

    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("正常投递过就不再补兜底", async () => {
    const dispatch = vi.fn(async (_m: any, _r: any, extra: any) => {
      await extra.docTask.postComment("已改好");
      extra.docTask.reportTurn({ finalDelivered: true, delivered: true, lost: false, noticed: false });
      return "completed" as const;
    });
    const { handler, postComment } = makeHandler(dispatch);

    await handler(mention());

    expect(postComment).toHaveBeenCalledTimes(1);
    expect(postComment.mock.calls[0][1]).toBe("已改好");
  });

  // --- 「投递过」不等于「答复送达」 ---

  it("中间消息发成功、最终答复发失败:必须补兜底且不写去重(答复不能悄悄丢)", async () => {
    // 反例:delivered 只要 >0 就判成功 → 用户只看到「正在读取文档…」,
    // 永远等不到答复,也等不到失败提示,事件却已 ack + 落盘。
    const dispatch = vi.fn(async (_m: any, _r: any, extra: any) => {
      await extra.docTask.postComment("正在读取文档…");
      await extra.docTask.postComment("这是最终答复").catch(() => {});
      // inbound 侧:最终答复没发成功 → finalDelivered 为假,且没发过提示 → 补兜底
      extra.docTask.reportTurn({ finalDelivered: false, delivered: true, lost: true, noticed: false });
      return "completed" as const;
    });
    let call = 0;
    const { handler, dedupe, postComment } = makeHandler(dispatch, async (_m: any, text: string) => {
      call += 1;
      if (text === "这是最终答复") throw new Error("docs API 503");
    });

    await handler(mention());

    const bodies = postComment.mock.calls.map((c: any) => c[1]);
    expect(bodies.some((b: string) => b.includes("没有给出答复"))).toBe(true); // 有兜底提示
    expect(await dedupe.claim("k1")).toBe(false); // 有丢失 → 不写去重
  });

  it("确定性拒绝只尝试一次 —— 不在轮询器串行循环里白烧三次 POST", async () => {
    // 「文档不存在」重试三次仍然不存在。而且后面的兜底通知还会再烧一遍同样的三次,
    // 单个事件 ~6 次无望的 POST + 1.2s 退避,全都发生在轮询器的串行循环里。
    const dispatch = vi.fn(async (_m: any, _r: any, extra: any) => {
      await extra.docTask.postComment("已改好").catch(() => {});
      extra.docTask.reportTurn({ finalDelivered: false, delivered: false, lost: true, noticed: false });
      return "completed" as const;
    });
    const { handler, postComment } = makeHandler(dispatch, async () => {
      throw new DocCommentRejectedError("Octo API /v1/bot/docs/d1/comments rejected the comment (status=404)");
    });

    await handler(mention());

    // 一次真答复 + 一次兜底,各只尝试一次
    expect(postComment).toHaveBeenCalledTimes(2);
  });

  it("POST 期间 signal 被 abort:不再空睡一次退避", async () => {
    // 注意断言的是**退避有没有发生**,不是尝试次数:循环顶部那道检查会在下一轮
    // 把它拦下,所以两种写法的尝试次数都是 1,唯一的差别是白睡的那 200ms ——
    // 而这 200ms 是在串行的轮询循环里、在一个只有 10s 预算的兜底路径上花掉的。
    const controller = new AbortController();
    const dispatch = vi.fn(async (_m: any, _r: any, extra: any) => {
      await extra.docTask.postComment("已改好", controller.signal).catch(() => {});
      extra.docTask.reportTurn({ finalDelivered: false, delivered: false, lost: true, noticed: false });
      return "completed" as const;
    });
    const { handler } = makeHandler(
      dispatch,
      async (_m: unknown, _text: string, signal?: AbortSignal) => {
        if (signal === controller.signal) {
          controller.abort(); // POST 进行中被取消
          throw new Error("aborted");
        }
      },
    );
    const sleeps: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === 200 || ms === 400) sleeps.push(ms);
      return (realSetTimeout as any)(fn, ms, ...rest);
    }) as typeof globalThis.setTimeout;

    try {
      await handler(mention());
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    expect(sleeps).toEqual([]); // 一次退避都不该发生
  });

  // --- 结论由回合上报,不由本文件推断 ---

  it("上报 notice-only:不写去重,也不再补一条兜底(评论区已有痕迹)", async () => {
    const dispatch = vi.fn(async (_m: any, _r: any, extra: any) => {
      await extra.docTask.postComment("⚠️ 抱歉，处理您的消息时遇到了问题，请稍后重试。");
      extra.docTask.reportTurn({ finalDelivered: false, delivered: true, lost: false, noticed: true });
      return "completed" as const;
    });
    const { handler, dedupe, postComment } = makeHandler(dispatch);

    await handler(mention());

    expect(await dedupe.claim("k1")).toBe(false); // 未记为完成 → 可重投
    expect(postComment).toHaveBeenCalledTimes(1); // 不叠第二条废话
  });

  it("完全没上报(dispatch 之前就早返回):按 nothing 处理 —— 补兜底、不写去重", async () => {
    // 能力门禁、resolveAgentRoute 抛错这类路径根本走不到上报点。
    const dispatch = vi.fn(async () => "completed" as const);
    const { handler, dedupe, postComment } = makeHandler(dispatch);

    await handler(mention());

    expect(postComment).toHaveBeenCalledTimes(1);
    expect(await dedupe.claim("k1")).toBe(false);
  });

  it("答复送达之后 dispatch 才抛错:写去重,且**不**在正确答复下面再贴一条失败提示", async () => {
    // 两位 reviewer 独立复现的同一格。上一版把「dispatch 抛错」当成「任务没跑」,
    // 于是一个已经把答复发出去的回合被判成 nothing:评论区多一条「没有完成、也没有
    // 产生任何修改，请重新 @ 我」,而且不写去重 —— 用户照做,改文档的任务再跑一遍。
    const dispatch = vi.fn(async (_m: any, _r: any, extra: any) => {
      await extra.docTask.postComment("已改好，diff 见版本记录");
      extra.docTask.reportTurn({ finalDelivered: true, delivered: true, lost: false, noticed: false });
      throw new Error("non_deliverable_terminal_turn");
    });
    const { handler, dedupe, postComment } = makeHandler(dispatch);

    await expect(handler(mention())).resolves.toBeUndefined();

    expect(postComment).toHaveBeenCalledTimes(1); // 只有那条真答复
    expect(await dedupe.claim("k1")).toBe(true); // 已完成 → 不会重放
  });

  it("进度评论发丢、最终答复送达:写去重,且不叠兜底 —— lost 不得否决 finalDelivered", async () => {
    // 回归:`workLanded = finalDelivered && !lost` 里的 lost 是回合全局且粘性的,
    // 任何非提示帖失败都会置位(进度、工具、附件)。于是一次进度评论的瞬时 5xx
    // 就会否决掉一个确实落地的最终答复 —— 在正确答复下面贴出「没有给出答复」
    // 并允许重放,而 agent 已经改过文档了。
    const dispatch = vi.fn(async (_m: any, _r: any, extra: any) => {
      await extra.docTask.postComment("已改好");
      extra.docTask.reportTurn({ finalDelivered: true, delivered: true, lost: true, noticed: false });
      return "completed" as const;
    });
    const { handler, dedupe, postComment } = makeHandler(dispatch);

    await handler(mention());

    expect(postComment).toHaveBeenCalledTimes(1); // 没有多出一条「没有给出答复」
    expect(await dedupe.claim("k1")).toBe(true); // 已完成 → 不会重放
  });

  it("答复送达之后又道歉(超时/onError):仍算落地,不再叠兜底", async () => {
    const dispatch = vi.fn(async (_m: any, _r: any, extra: any) => {
      await extra.docTask.postComment("已改好");
      await extra.docTask.postComment("⚠️ 处理超时，请稍后重试。");
      extra.docTask.reportTurn({ finalDelivered: true, delivered: true, lost: false, noticed: true });
      return "completed" as const;
    });
    const { handler, dedupe, postComment } = makeHandler(dispatch);

    await handler(mention());

    expect(postComment).toHaveBeenCalledTimes(2);
    expect(await dedupe.claim("k1")).toBe(true);
  });

  it("会话重试的多次 reportTurn 要累计事实,后续 notice 不得覆盖此前 final", async () => {
    const dispatch = vi.fn(async (_m: any, _r: any, extra: any) => {
      extra.docTask.reportTurn({ finalDelivered: true, delivered: true, lost: false, noticed: false });
      extra.docTask.reportTurn({ finalDelivered: false, delivered: true, lost: false, noticed: true });
      return "dropped" as const;
    });
    const { handler, dedupe, postComment } = makeHandler(dispatch);

    await handler(mention());

    expect(postComment).not.toHaveBeenCalled();
    expect(await dedupe.claim("k1")).toBe(true);
  });

  it("答复发丢但道歉发出去了:不写去重,也不叠兜底 —— 用户已经知道失败了", async () => {
    const dispatch = vi.fn(async (_m: any, _r: any, extra: any) => {
      extra.docTask.reportTurn({ finalDelivered: false, delivered: true, lost: true, noticed: true });
      return "completed" as const;
    });
    const { handler, dedupe, postComment } = makeHandler(dispatch);

    await handler(mention());

    expect(postComment).not.toHaveBeenCalled();
    expect(await dedupe.claim("k1")).toBe(false);
  });

  // --- 去重落盘失败不得逃逸(不变量 3) ---

  it("dedupe.complete 落盘失败:handler 仍正常返回 —— 外抛会让轮询器每周期重跑一次改文档的任务", async () => {
    // reviewer 的复现:complete() 必抛时 polls=6 taskRuns=6 acked=[] cursorSaved=[],
    // 3.2s 内把同一个任务对着线上文档跑了 6 遍,永不收敛。
    const dispatch = vi.fn(async (_m: any, _r: any, extra: any) => {
      await extra.docTask.postComment("已改好");
      extra.docTask.reportTurn({ finalDelivered: true, delivered: true, lost: false, noticed: false });
      return "completed" as const;
    });
    const postComment = vi.fn(async () => {});
    const failing = createMemoryDocMentionDedupeStore();
    const completeErr = new Error("EACCES: dedupe file not writable");
    const dedupe = {
      claim: failing.claim,
      release: failing.release,
      complete: vi.fn(async () => { throw completeErr; }),
    };
    const handler = createDocMentionHandler({ botUid: BOT_UID, dedupe, dispatch, postComment });

    await expect(handler(mention())).resolves.toBeUndefined();

    expect(dedupe.complete).toHaveBeenCalledTimes(1);
    expect(postComment).toHaveBeenCalledTimes(1); // 答复照常发出,不因落盘失败重发
  });

  it("会话冲突:channel.ts 上报 notice-only,回执本身就是痕迹,不补兜底也不写去重", async () => {
    const dispatch = vi.fn(async (_m: any, _r: any, extra: any) => {
      await extra.docTask.postComment("⚠️ 上一轮任务尚未结束，本次请求已跳过。");
      extra.docTask.reportTurn({ finalDelivered: false, delivered: true, lost: false, noticed: true });
      return "dropped" as const;
    });
    const { handler, dedupe, postComment } = makeHandler(dispatch);

    await handler(mention());

    expect(await dedupe.claim("k1")).toBe(false);
    expect(postComment).toHaveBeenCalledTimes(1);
  });
});
