import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startEventPoller, type EventCursorStore } from "./events-poll.js";
import { createFileDocMentionDedupeStore, createMemoryDocMentionDedupeStore } from "./doc-mention-dedupe.js";
import type { DocCommentMention } from "./doc-mention.js";

const API = "http://octo.test";

const docEvent = (eventId: number, overrides: Record<string, unknown> = {}) => ({
  event_id: eventId,
  event_type: "doc_comment_mention",
  event_data: {
    idempotency_key: `k${eventId}`,
    doc_id: "d1",
    comment_id: "77",
    thread_id: "70",
    from_uid: "u1",
    bot_uid: "bot1",
    text: "改一下",
    ...overrides,
  },
});

function memoryCursor(initial = 0): EventCursorStore & { saved: number[] } {
  const state = { value: initial, saved: [] as number[] };
  return {
    saved: state.saved,
    async load() { return state.value; },
    async save(eventId: number) { state.value = eventId; state.saved.push(eventId); },
  };
}

const originalFetch = globalThis.fetch;

/** 记录 ack 过的 event_id,用于验证「已识别才 ack」。 */
function installFetch(events: unknown[]): { acked: number[] } {
  const acked: number[] = [];
  let served = false;
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    const ackMatch = /\/v1\/bot\/events\/(\d+)\/ack/.exec(url);
    if (ackMatch) { acked.push(Number(ackMatch[1])); return json({ status: 1 }); }
    if (url.includes("/v1/bot/events")) {
      const batch = served ? [] : events;
      served = true;
      return json({ status: 1, results: batch });
    }
    return json({});
  }) as unknown as typeof fetch;
  return { acked };
}

async function drain(): Promise<void> {
  // 轮询器首个 tick 由 ready 之后的定时器触发,给它足够的时间跑完一轮。
  await new Promise((resolve) => setTimeout(resolve, 900));
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("轮询器识别文档任务事件", () => {
  it("解析并派发 doc_comment_mention,且完成后 ack", async () => {
    const { acked } = installFetch([docEvent(11)]);
    const seen: DocCommentMention[] = [];
    const poller = startEventPoller({
      apiUrl: API,
      botToken: "tok",
      intervalMs: 500,
      cursorStore: memoryCursor(),
      onDocMention: async (mention) => { seen.push(mention); },
    });
    await poller.ready;
    await drain();
    poller.stop();

    expect(seen.map((m) => m.idempotencyKey)).toEqual(["k11"]);
    expect(acked).toEqual([11]);
  });

  it("未注册 onDocMention 时不识别该类事件,也不 ack", async () => {
    const { acked } = installFetch([docEvent(12)]);
    const poller = startEventPoller({
      apiUrl: API,
      botToken: "tok",
      intervalMs: 500,
      cursorStore: memoryCursor(),
      onCardAction: async () => {},
    });
    await poller.ready;
    await drain();
    poller.stop();

    // 回归:不 ack 自己没处理的事件,但游标仍前进,避免本消费者反复拉取
    expect(acked).toEqual([]);
    expect(poller.cursor()).toBe(12);
  });

  it("未知 event_type 既不派发也不 ack", async () => {
    const { acked } = installFetch([{ event_id: 13, event_type: "brand_new_type", event_data: {} }]);
    const seen: DocCommentMention[] = [];
    const poller = startEventPoller({
      apiUrl: API,
      botToken: "tok",
      intervalMs: 500,
      cursorStore: memoryCursor(),
      onDocMention: async (mention) => { seen.push(mention); },
    });
    await poller.ready;
    await drain();
    poller.stop();

    expect(seen).toEqual([]);
    expect(acked).toEqual([]);
  });
});

describe("文档任务持久去重", () => {
  let dir: string;

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "octo-docmention-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("完成后同一 idempotency_key 不再放行", async () => {
    const store = createFileDocMentionDedupeStore({ accountId: "acct1", baseDir: dir });
    expect(await store.claim("k1")).toBe(false);
    await store.complete("k1");
    expect(await store.claim("k1")).toBe(true);
    expect(await store.claim("k2")).toBe(false);
  });

  it("进程重启后仍对已完成任务去重(内存态会被重启击穿,故必须落盘)", async () => {
    const first = createFileDocMentionDedupeStore({ accountId: "acct1", baseDir: dir });
    expect(await first.claim("k1")).toBe(false);
    await first.complete("k1");

    const afterRestart = createFileDocMentionDedupeStore({ accountId: "acct1", baseDir: dir });
    expect(await afterRestart.claim("k1")).toBe(true);
  });

  it("崩溃在 claim 之后、complete 之前:重启后必须允许重放,而不是永久丢弃", async () => {
    const beforeCrash = createFileDocMentionDedupeStore({ accountId: "acct1", baseDir: dir });
    expect(await beforeCrash.claim("k1")).toBe(false);
    // 任务执行中进程崩溃 —— 没有 complete。「进行中」只在内存,随进程消失。

    const afterCrash = createFileDocMentionDedupeStore({ accountId: "acct1", baseDir: dir });
    expect(await afterCrash.claim("k1")).toBe(false);
  });

  it("release 后允许再次执行(dispatch 未完成时的重投)", async () => {
    const store = createFileDocMentionDedupeStore({ accountId: "acct1", baseDir: dir });
    expect(await store.claim("k1")).toBe(false);
    store.release("k1");
    expect(await store.claim("k1")).toBe(false);
  });

  it("并发 claim 同一 key 只有一个通过", async () => {
    const store = createFileDocMentionDedupeStore({ accountId: "acct1", baseDir: dir });
    const results = await Promise.all([store.claim("k1"), store.claim("k1"), store.claim("k1")]);
    expect(results.filter((seen) => seen === false)).toHaveLength(1);
  });

  it("落盘失败不得把 key 记进内存:否则调用方重试会被误判为重复而永久丢任务", async () => {
    const store = createFileDocMentionDedupeStore({ accountId: "acct1", baseDir: join(dir, "nested") });
    // 用一个已存在的同名文件占位,让 mkdir/rename 失败
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "nested"), "not-a-dir", "utf8");

    expect(await store.claim("k1")).toBe(false);
    await expect(store.complete("k1")).rejects.toBeTruthy();

    // 修复占位后重试必须仍能放行(内存未被污染)
    const { rm: rmOne } = await import("node:fs/promises");
    await rmOne(join(dir, "nested"), { force: true });
    store.release("k1");
    expect(await store.claim("k1")).toBe(false);
  });

  it("超出容量时淘汰最旧的键", async () => {
    const store = createMemoryDocMentionDedupeStore(2);
    for (const key of ["a", "b", "c"]) { await store.claim(key); await store.complete(key); }
    expect(await store.claim("a")).toBe(false); // 已被淘汰,重新放行
    store.release("a");
    expect(await store.claim("c")).toBe(true);
  });
});
