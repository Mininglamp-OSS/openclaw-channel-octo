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

  it("handler 抛异常:游标仍推进并 ack,任务只跑一次 —— 否则每个轮询周期重跑一次改文档的任务", async () => {
    // 回归(reviewer 复现):handler 的异常原先直接逃到 tick,而 cursorStore.save 和
    // ack 都排在 await handler 之后 —— 于是「不存游标、不 ack」,下一 tick 原样重取,
    // 实测 polls=6 taskRuns=6 acked=[] cursorSaved=[],3.2s 内把同一个会改文档的任务
    // 跑了 6 遍,永不收敛。handler 自己承诺不抛,这里是轮询器侧的兜底,不依赖它。
    const acked: number[] = [];
    let polls = 0;
    // 未被 ack 的事件会被 server 反复投递 —— 这正是死循环得以成立的前提。
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = typeof input === "string" ? input : input.toString();
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      const ackMatch = /\/v1\/bot\/events\/(\d+)\/ack/.exec(url);
      if (ackMatch) { acked.push(Number(ackMatch[1])); return json({ status: 1 }); }
      if (url.includes("/v1/bot/events")) {
        polls += 1;
        return json({ status: 1, results: acked.includes(14) ? [] : [docEvent(14)] });
      }
      return json({});
    }) as unknown as typeof fetch;

    const cursor = memoryCursor();
    let taskRuns = 0;
    const poller = startEventPoller({
      apiUrl: API,
      botToken: "tok",
      intervalMs: 500,
      cursorStore: cursor,
      onDocMention: async () => { taskRuns += 1; throw new Error("dedupe persist failed"); },
    });
    await poller.ready;
    await new Promise((resolve) => setTimeout(resolve, 1800));
    poller.stop();

    expect(polls).toBeGreaterThanOrEqual(2); // 确实轮询了多轮,不是没跑起来
    expect(taskRuns).toBe(1);
    expect(acked).toEqual([14]);
    expect(cursor.saved).toEqual([14]);
  });

  it("游标落盘失败:仍然 ack,任务只跑一次 —— 状态目录写不进去不该把任务重跑一遍", async () => {
    // 回归(reviewer 复现):上一轮只堵了 handler 里的去重落盘,但游标文件
    // (events.cursor.json)和去重表(doc-mentions.processed.json)在**同一个目录**,
    // EROFS/ENOSPC/EACCES/EDQUOT 会同时命中两处写。cursorStore.save() 原先裸在
    // 循环里,一抛就逃出整个 for:不 ack、游标不前进、批次剩余事件也一起不处理
    // —— 实测 polls=6 taskRuns=6 acked=[] cursorSaved=[],3.2s 跑 6 遍,永不收敛。
    const acked: number[] = [];
    let polls = 0;
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = typeof input === "string" ? input : input.toString();
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      const ackMatch = /\/v1\/bot\/events\/(\d+)\/ack/.exec(url);
      if (ackMatch) { acked.push(Number(ackMatch[1])); return json({ status: 1 }); }
      if (url.includes("/v1/bot/events")) {
        polls += 1;
        return json({ status: 1, results: acked.includes(15) ? [] : [docEvent(15)] });
      }
      return json({});
    }) as unknown as typeof fetch;

    let taskRuns = 0;
    const poller = startEventPoller({
      apiUrl: API,
      botToken: "tok",
      intervalMs: 500,
      cursorStore: {
        async load() { return 0; },
        async save() { throw new Error("EROFS: read-only file system"); },
      },
      onDocMention: async () => { taskRuns += 1; },
    });
    await poller.ready;
    await new Promise((resolve) => setTimeout(resolve, 1800));
    poller.stop();

    expect(polls).toBeGreaterThanOrEqual(2);
    expect(taskRuns).toBe(1);
    expect(acked).toEqual([15]); // ack 才是真正止住重投的东西
    expect(poller.cursor()).toBe(15); // 内存游标照常前进
  });

  it("同一批里前一个事件游标落盘失败,后续事件仍被处理", async () => {
    // 第二重影响:原先那个抛出会中断整个 for 循环,所以一旦触发,**卡片动作**也
    // 一起停 —— 是整个轮询器被楔死,不只是文档任务重放。
    const { acked } = installFetch([docEvent(16), docEvent(17)]);
    const seen: number[] = [];
    const poller = startEventPoller({
      apiUrl: API,
      botToken: "tok",
      intervalMs: 500,
      cursorStore: {
        async load() { return 0; },
        async save() { throw new Error("ENOSPC: no space left on device"); },
      },
      onDocMention: async (mention) => { seen.push(Number(mention.idempotencyKey.slice(1))); },
    });
    await poller.ready;
    await drain();
    poller.stop();

    expect(seen).toEqual([16, 17]);
    expect(acked).toEqual([16, 17]);
  });

  it("未注册 onCardAction 时卡片事件不被识别,也不 ack", async () => {
    // 回归:`parseCardAction` 原先无条件调用,回调可选这件事没有任何测试钉住 ——
    // 把门禁去掉全套照绿。cardInteraction:false 的部署会因此收到并 ack 卡片事件。
    // fixture 必须是 parseCardAction 真的能解析的形状:它要求 message_id /
    // channel_id / channel_type / action_id / operator_uid 五个字段齐全,缺一返回
    // null —— 上一版少了四个,于是这条测试无论门禁在不在都通过(空转)。
    const { acked } = installFetch([
      {
        event_id: 31,
        event_type: "card_action",
        event_data: {
          message_id: "m1",
          channel_id: "c1",
          channel_type: 1,
          action_id: "a1",
          operator_uid: "u1",
        },
      },
    ]);
    const seen: unknown[] = [];
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
    expect(poller.cursor()).toBe(31); // 游标仍前进,不重复拉取
  });

  it("ACK 排在存游标之前 —— 顺序本身要被钉住", async () => {
    // 上一轮整轮的主题就是这个顺序,却没有任何测试会在把它换回去时变红:
    // 「游标必失败仍要 ack」那条靠的是 try/catch,不是顺序。这里直接记录时序。
    const order: string[] = [];
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = typeof input === "string" ? input : input.toString();
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      if (/\/v1\/bot\/events\/(\d+)\/ack/.test(url)) { order.push("ack"); return json({ status: 1 }); }
      if (url.includes("/v1/bot/events")) {
        return json({ status: 1, results: order.includes("ack") ? [] : [docEvent(18)] });
      }
      return json({});
    }) as unknown as typeof fetch;

    const poller = startEventPoller({
      apiUrl: API,
      botToken: "tok",
      intervalMs: 500,
      cursorStore: {
        async load() { return 0; },
        async save() { order.push("cursor"); },
      },
      onDocMention: async () => { order.push("handler"); },
    });
    await poller.ready;
    await drain();
    poller.stop();

    expect(order).toEqual(["handler", "ack", "cursor"]);
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

  it("去重表读不出来时记一条 error —— 静默降级等于整表清空、每个事件重放一遍", async () => {
    // 回归:这条日志分支加了,但生产调用点(channel.ts)当时没传 log,分支不可达 ——
    // 注释描述的行为接线根本没实现。这条测试钉住「传了 log 就一定看得见」。
    const { mkdir, writeFile } = await import("node:fs/promises");
    const acct = join(dir, "acct-unreadable");
    await mkdir(acct, { recursive: true });
    await writeFile(join(acct, "doc-mentions.processed.json"), "{ this is not json", "utf8");

    const errors: string[] = [];
    const store = createFileDocMentionDedupeStore({
      accountId: "acct-unreadable",
      baseDir: dir,
      log: { error: (m) => errors.push(m) },
    });

    expect(await store.claim("k1")).toBe(false); // 降级成空表,放行
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("unreadable");
  });

  it("文件不存在是正常冷启动,不记 error", async () => {
    const errors: string[] = [];
    const store = createFileDocMentionDedupeStore({
      accountId: "acct-fresh",
      baseDir: dir,
      log: { error: (m) => errors.push(m) },
    });

    expect(await store.claim("k1")).toBe(false);
    expect(errors).toEqual([]);
  });

  it("超出容量时淘汰最旧的键", async () => {
    const store = createMemoryDocMentionDedupeStore(2);
    for (const key of ["a", "b", "c"]) { await store.claim(key); await store.complete(key); }
    expect(await store.claim("a")).toBe(false); // 已被淘汰,重新放行
    store.release("a");
    expect(await store.claim("c")).toBe(true);
  });
});
