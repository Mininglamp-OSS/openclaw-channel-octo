/**
 * 三条 P1 收口的回归钉子（reviewer 第三轮 §2.1 / §2.2 / §2.3）。
 *
 * 每一条都必须能靠 mutation 变红 —— 见 PR 里的 door-test 记录。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDocMentionHandler } from "./doc-mention-handler.js";
import { createMemoryDocMentionDedupeStore } from "./doc-mention-dedupe.js";
import {
  createFileDocTaskDeadLetterStore,
  createMemoryDocTaskDeadLetterStore,
  truncateDetail,
} from "./doc-task-deadletter.js";
import { parseDocCommentMention, type DocCommentMention } from "./doc-mention.js";

const BOT_UID = "bot_1";

// 用真解析器造 mention:手搓对象会绕过字段归一,测出来的东西跟线上不是一回事。
const mention: DocCommentMention = parseDocCommentMention({
  event_id: 2001,
  event_type: "doc_comment_mention",
  event_data: {
    idempotency_key: "evt_1",
    doc_id: "doc_1",
    comment_id: "77",
    thread_id: "42",
    from_uid: "u_author",
    bot_uid: BOT_UID,
    text: "改一下标题",
  },
})!;

describe("§2.1 intent 透传 —— 失败通知不得打 applied 徽章", () => {
  it("把 notice intent 一路带到 postComment（而不是被丢掉变成默认 applied）", async () => {
    const seen: Array<{ text: string; intent?: string }> = [];
    const handler = createDocMentionHandler({
      botUid: "bot_1",
      dedupe: createMemoryDocMentionDedupeStore(),
      // dispatch 里模拟「agent 只发了一条失败通知」
      dispatch: async (_msg, _x, ctx) => {
        await ctx!.docTask!.postComment("超时了，抱歉", undefined, "notice");
        ctx!.docTask!.reportTurn!({
          finalDelivered: false,
          delivered: true,
          lost: false,
          noticed: true,
        });
        return "completed";
      },
      postComment: async (_m, text, _signal, intent) => {
        seen.push({ text, intent });
      },
    });

    await handler(mention);

    expect(seen).toHaveLength(1);
    // ★ 承重断言：intent 必须原样到达出站层。丢了它 → 出站按默认发 applied，
    // 于是一条「超时了，抱歉」在评论上顶着「已完成」徽章。
    expect(seen[0]!.intent).toBe("notice");
  });

  it("正常答复带 final intent", async () => {
    const seen: Array<string | undefined> = [];
    const handler = createDocMentionHandler({
      botUid: "bot_1",
      dedupe: createMemoryDocMentionDedupeStore(),
      dispatch: async (_msg, _x, ctx) => {
        await ctx!.docTask!.postComment("改好了", undefined, "final");
        ctx!.docTask!.reportTurn!({
          finalDelivered: true,
          delivered: true,
          lost: false,
          noticed: false,
        });
        return "completed";
      },
      postComment: async (_m, _text, _signal, intent) => {
        seen.push(intent);
      },
    });
    await handler(mention);
    expect(seen).toEqual(["final"]);
  });
});

describe("§2.1 最后一跳 —— postHtmlDocReply 必须把 intent 映射成 status", () => {
  // ★ 这组是真正钉住 reviewer §2.1 的那一跳。上面那组只证明 intent 到了出站层的入口,
  // 证明不了出站层没把它扔掉 —— 实测:把 status 写死回 "applied" 时,上面那组仍然全绿。
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function capturePostedStatus(intent?: "final" | "progress" | "notice"): Promise<string | undefined> {
    let sent: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      sent = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ status: 1 }),
        json: async () => ({ status: 1 }),
      };
    }) as unknown as typeof fetch;

    const { postHtmlDocReply } = await import("./api-fetch.js");
    await postHtmlDocReply({
      apiUrl: "https://example.test",
      botToken: "t",
      slug: "s",
      parentId: "p",
      body: "b",
      intent,
    });
    return sent?.status as string | undefined;
  }

  it("notice ⇒ question（失败/超时通知不得渲染成已完成）", async () => {
    expect(await capturePostedStatus("notice")).toBe("question");
  });

  it("final ⇒ applied", async () => {
    expect(await capturePostedStatus("final")).toBe("applied");
  });

  // ★ P1-2 承重锁：这一条只由「final 与 progress 分开」这个修法决定红绿。
  // 合并回同一个 intent（progress 也走 applied）时它必红。
  // 为什么承重：上游 octo-doc 见 status=applied 就把父评论翻成「已解决」并发
  // marked_applied —— 中间态（工具进展 / 分段产出 / 先发的附件）以 applied 落库，
  // 等于在真答复到达之前就把用户的诉求标成已完成，dedupe 随后永久关闭该任务。
  it("progress ⇒ partial（中间态绝不能打 applied，否则上游提前判定已解决）", async () => {
    const status = await capturePostedStatus("progress");
    expect(status).not.toBe("applied");
    expect(status).toBe("partial");
  });

  it("intent 缺失时保守回落 applied（与改动前行为一致，不改既有契约）", async () => {
    expect(await capturePostedStatus(undefined)).toBe("applied");
  });
});

describe("§2.3 死信 —— 答复与兜底通知都没送达时必须留下可查记录", () => {
  it("两条都失败 ⇒ 落一条 undelivered_after_ack", async () => {
    const deadLetter = createMemoryDocTaskDeadLetterStore();
    const handler = createDocMentionHandler({
      botUid: "bot_1",
      dedupe: createMemoryDocMentionDedupeStore(),
      deadLetter,
      dispatch: async (_msg, _x, ctx) => {
        // agent 想发答复，但出站一直失败 → 什么都没上报
        await ctx!.docTask!.postComment("改好了", undefined, "final").catch(() => {});
        return "completed";
      },
      // 所有 POST 都失败，兜底通知也一样
      postComment: async () => {
        throw new Error("comment service 503");
      },
    });

    await handler(mention);

    const entries = await deadLetter.list();
    // ★ 事件随后会被 ack，server 不再投递。这条记录是这次 @Bot 在系统里唯一的痕迹。
    expect(entries).toHaveLength(1);
    expect(entries[0]!.idempotencyKey).toBe("evt_1");
    expect(entries[0]!.docId).toBe("doc_1");
    expect(entries[0]!.threadId).toBe("42");
    expect(entries[0]!.reason).toBe("undelivered_after_ack");
    expect(entries[0]!.detail).toContain("503");
  });

  it("兜底通知送达了 ⇒ 不落死信（用户已被告知，不是黑洞）", async () => {
    const deadLetter = createMemoryDocTaskDeadLetterStore();
    let calls = 0;
    const handler = createDocMentionHandler({
      botUid: "bot_1",
      dedupe: createMemoryDocMentionDedupeStore(),
      deadLetter,
      dispatch: async () => "completed",
      postComment: async () => {
        calls += 1;
      },
    });
    await handler(mention);
    expect(calls).toBeGreaterThan(0);
    expect(await deadLetter.list()).toHaveLength(0);
  });

  it("答复送达了 ⇒ 不落死信，也不发兜底通知", async () => {
    const deadLetter = createMemoryDocTaskDeadLetterStore();
    const texts: string[] = [];
    const handler = createDocMentionHandler({
      botUid: "bot_1",
      dedupe: createMemoryDocMentionDedupeStore(),
      deadLetter,
      dispatch: async (_msg, _x, ctx) => {
        await ctx!.docTask!.postComment("改好了", undefined, "final");
        ctx!.docTask!.reportTurn!({
          finalDelivered: true,
          delivered: true,
          lost: false,
          noticed: false,
        });
        return "completed";
      },
      postComment: async (_m, text) => {
        texts.push(text);
      },
    });
    await handler(mention);
    expect(texts).toEqual(["改好了"]);
    expect(await deadLetter.list()).toHaveLength(0);
  });

  it("死信 store 自己写失败也不能把异常抛进收尾路径（否则游标卡住 ⇒ 非幂等重放）", async () => {
    const errors: string[] = [];
    // baseDir 指到一个「文件」上，mkdir 必然 ENOTDIR
    const store = createFileDocTaskDeadLetterStore({
      accountId: "acc",
      baseDir: "/dev/null/nope",
      log: { error: (m) => errors.push(m) },
    });
    await expect(
      store.record({
        idempotencyKey: "k",
        docId: "d",
        threadId: "t",
        at: new Date().toISOString(),
        reason: "undelivered_after_ack",
      }),
    ).resolves.toBeUndefined();
    expect(errors.join("\n")).toContain("dead-letter write failed");
  });
});

describe("死信落盘形状", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "octo-dl-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("写进 doc-tasks.deadletter.json，与去重表分开，且按 capacity 有界", async () => {
    const store = createFileDocTaskDeadLetterStore({ accountId: "Acc_1", baseDir: dir, capacity: 2 });
    for (const k of ["k1", "k2", "k3"]) {
      await store.record({
        idempotencyKey: k,
        docId: "d",
        threadId: "t",
        at: new Date().toISOString(),
        reason: "undelivered_after_ack",
      });
    }
    const raw = JSON.parse(
      await readFile(join(dir, "acc_1", "doc-tasks.deadletter.json"), "utf8"),
    ) as { entries: Array<{ idempotencyKey: string }> };
    expect(raw.entries.map((e) => e.idempotencyKey)).toEqual(["k2", "k3"]);
    expect(await store.list()).toHaveLength(2);
  });

  it("detail 截断，避免一条 stack 撑爆死信文件", () => {
    expect(truncateDetail("x".repeat(600))!.length).toBe(501);
    expect(truncateDetail("  ")).toBeUndefined();
    expect(truncateDetail(undefined)).toBeUndefined();
  });
});

describe("§2.2 docsApiUrl —— 双服务单 knob 必须写成明示的不支持，而不是留白", () => {
  it("描述明说它同时是 docs-backend 与 octo-doc 的 base，且两源分离不支持", async () => {
    const { DOCS_API_URL_DESCRIPTION } = await import("./config-schema.js");
    expect(DOCS_API_URL_DESCRIPTION).toContain("/docs-html/v1/**");
    expect(DOCS_API_URL_DESCRIPTION).toContain("/v1/bot/docs/**");
    expect(DOCS_API_URL_DESCRIPTION).toMatch(/not supported/i);
  });
});
