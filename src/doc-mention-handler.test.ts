import { describe, expect, it, vi } from "vitest";
import { createDocMentionHandler } from "./doc-mention-handler.js";
import { createMemoryDocMentionDedupeStore } from "./doc-mention-dedupe.js";
import { parseDocCommentMention, type DocCommentMention } from "./doc-mention.js";

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

function makeHandler(dispatch: any) {
  const dedupe = createMemoryDocMentionDedupeStore();
  const postComment = vi.fn(async () => {});
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
  it("成功后写入持久去重,同 key 不再执行", async () => {
    const dispatch = vi.fn(async () => "completed" as const);
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

  it("dispatch 返回 dropped:同样释放,不写持久去重", async () => {
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
      return "completed" as const;
    });
    const { handler, postComment } = makeHandler(dispatch);

    await handler(mention());

    expect(postComment).toHaveBeenCalledWith(expect.objectContaining({ docId: "d1" }), "已改好", undefined);
  });
});
