import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFileEventCursorStore,
  requestCardEventPolling,
  setCardEventPollStarter,
  startEventPoller,
  type EventCursorStore,
} from "./events-poll.js";
import type { CardAction } from "./card-action.js";

const actionEvent = (eventId: number) => ({
  event_id: eventId,
  event_type: "card_action",
  event_data: {
    message_id: `m${eventId}`,
    channel_id: "g1",
    channel_type: 2,
    action_id: "approve",
    operator_uid: "u1",
    inputs: {},
  },
});

function memoryCursor(initial = 0): EventCursorStore & { saved: number[] } {
  const state = { value: initial, saved: [] as number[] };
  return {
    saved: state.saved,
    load: async () => state.value,
    save: async (value) => {
      state.value = value;
      state.saved.push(value);
    },
  };
}

describe("event poller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("从持久化 cursor 拉取，升序处理、保存后 ack", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      requests.push({ url: String(url), body });
      if (String(url).endsWith("/ack")) return new Response("");
      return Response.json({ results: [actionEvent(12), actionEvent(11)] });
    }) as typeof fetch;
    const cursor = memoryCursor(10);
    const seen: number[] = [];
    const info: string[] = [];
    const poller = startEventPoller({
      apiUrl: "https://api.test",
      botToken: "bf_x",
      intervalMs: 1000,
      cursorStore: cursor,
      log: { info: (message) => info.push(message) },
      onCardAction: async (action: CardAction) => { seen.push(action.eventId); },
    });

    await poller.ready;
    await vi.advanceTimersByTimeAsync(1000);

    expect(requests[0].body).toEqual({ event_id: 10, limit: 50 });
    expect(seen).toEqual([11, 12]);
    expect(cursor.saved).toEqual([11, 12]);
    expect(requests.filter((request) => request.url.endsWith("/ack")).map((request) => request.url))
      .toEqual([
        "https://api.test/v1/bot/events/11/ack",
        "https://api.test/v1/bot/events/12/ack",
      ]);
    expect(poller.cursor()).toBe(12);
    expect(info).toContain("octo: event poll batch events=2 card_actions=2 cursor=12");
    poller.stop();
  });

  it("handler 失败时不保存、不 ack，下一轮可重试同一事件", async () => {
    const acked: string[] = [];
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).endsWith("/ack")) {
        acked.push(String(url));
        return new Response("");
      }
      return Response.json({ results: [actionEvent(21)] });
    }) as typeof fetch;
    const cursor = memoryCursor(20);
    const poller = startEventPoller({
      apiUrl: "https://api.test",
      botToken: "bf_x",
      intervalMs: 1000,
      cursorStore: cursor,
      onCardAction: async () => { throw new Error("dispatch failed"); },
    });

    await poller.ready;
    await vi.advanceTimersByTimeAsync(1000);

    expect(cursor.saved).toEqual([]);
    expect(acked).toEqual([]);
    expect(poller.cursor()).toBe(20);
    poller.stop();
  });

  it("非 card_action 不派发，但仍前移 cursor", async () => {
    global.fetch = vi.fn().mockResolvedValue(Response.json({
      results: [{ event_id: 31, event_type: "bot_joined_group", event_data: {} }],
    })) as typeof fetch;
    const cursor = memoryCursor(30);
    const onCardAction = vi.fn();
    const poller = startEventPoller({
      apiUrl: "https://api.test",
      botToken: "bf_x",
      intervalMs: 1000,
      cursorStore: cursor,
      onCardAction,
    });

    await poller.ready;
    await vi.advanceTimersByTimeAsync(1000);

    expect(onCardAction).not.toHaveBeenCalled();
    expect(cursor.saved).toEqual([31]);
    poller.stop();
  });

  it("stop 后不再发起后续轮询", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ results: [] }));
    global.fetch = fetchMock as typeof fetch;
    const poller = startEventPoller({
      apiUrl: "https://api.test",
      botToken: "bf_x",
      intervalMs: 1000,
      cursorStore: memoryCursor(),
      onCardAction: async () => {},
    });
    await poller.ready;
    poller.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ack:false 只保存 cursor；ack 失败只告警不回退 cursor", async () => {
    const errors: string[] = [];
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).endsWith("/ack")) return new Response("down", { status: 503 });
      return Response.json({ results: [actionEvent(41)] });
    }) as typeof fetch;
    const withoutAck = memoryCursor(40);
    const poller1 = startEventPoller({
      apiUrl: "https://api.test", botToken: "bf", intervalMs: 500,
      cursorStore: withoutAck, ack: false, onCardAction: async () => {},
    });
    await poller1.ready;
    await vi.advanceTimersByTimeAsync(500);
    expect(withoutAck.saved).toEqual([41]);
    poller1.stop();

    const withAck = memoryCursor(40);
    const poller2 = startEventPoller({
      apiUrl: "https://api.test", botToken: "bf", intervalMs: 500,
      cursorStore: withAck, onCardAction: async () => {}, log: { error: (message) => errors.push(message) },
    });
    await poller2.ready;
    await vi.advanceTimersByTimeAsync(500);
    expect(withAck.saved).toEqual([41]);
    expect(errors.some((message) => message.includes("ack event 41 failed"))).toBe(true);
    poller2.stop();
  });

  it("fetch 失败后保留 cursor 并在下一 tick 恢复", async () => {
    let calls = 0;
    const errors: string[] = [];
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).endsWith("/ack")) return new Response("");
      calls += 1;
      if (calls === 1) return new Response("down", { status: 503 });
      return Response.json({ results: [actionEvent(51)] });
    }) as typeof fetch;
    const cursor = memoryCursor(50);
    const poller = startEventPoller({
      apiUrl: "https://api.test", botToken: "bf", intervalMs: 500,
      cursorStore: cursor, onCardAction: async () => {}, log: { error: (message) => errors.push(message) },
    });
    await poller.ready;
    await vi.advanceTimersByTimeAsync(500);
    expect(cursor.saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(cursor.saved).toEqual([51]);
    expect(errors.some((message) => message.includes("event poll failed"))).toBe(true);
    poller.stop();
  });

  it("忽略非法或旧 event_id，并对空批次保持 cursor", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(Response.json({
      results: [actionEvent(Number.NaN), actionEvent(59), actionEvent(60)],
    })).mockResolvedValue(Response.json({ results: [] })) as typeof fetch;
    const cursor = memoryCursor(60);
    const onCardAction = vi.fn();
    const poller = startEventPoller({
      apiUrl: "https://api.test", botToken: "bf", intervalMs: 1, limit: 999,
      cursorStore: cursor, onCardAction,
    });
    await poller.ready;
    await vi.advanceTimersByTimeAsync(1000);
    expect(cursor.saved).toEqual([]);
    expect(onCardAction).not.toHaveBeenCalled();
    poller.stop();
  });

  it("批次含非整数 event_id 时丢弃畸形项，合法事件仍按升序处理不被挤掉", async () => {
    const errors: string[] = [];
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).endsWith("/ack")) return new Response("");
      // 畸形项夹在两个合法事件之间；若在校验前排序，NaN 比较会打乱顺序并可能丢掉 11。
      return Response.json({ results: [
        actionEvent(12),
        { ...actionEvent(11), event_id: "oops" },
        actionEvent(11),
      ] });
    }) as typeof fetch;
    const cursor = memoryCursor(10);
    const seen: number[] = [];
    const poller = startEventPoller({
      apiUrl: "https://api.test", botToken: "bf", intervalMs: 1000,
      cursorStore: cursor,
      log: { error: (message) => errors.push(message) },
      onCardAction: async (action: CardAction) => { seen.push(action.eventId); },
    });
    await poller.ready;
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual([11, 12]);
    expect(cursor.saved).toEqual([11, 12]);
    expect(poller.cursor()).toBe(12);
    expect(errors.some((message) => message.includes("non-integer event_id"))).toBe(true);
    poller.stop();
  });

  it("拉取与 ack 请求都带默认超时 signal，服务端挂起时不会无限阻塞轮询", async () => {
    const signals: Array<unknown> = [];
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      signals.push(init?.signal);
      if (String(url).endsWith("/ack")) return new Response("");
      return Response.json({ results: [actionEvent(5)] });
    }) as typeof fetch;
    const cursor = memoryCursor(4);
    const poller = startEventPoller({
      apiUrl: "https://api.test", botToken: "bf", intervalMs: 1000,
      cursorStore: cursor, onCardAction: async () => {},
    });
    await poller.ready;
    await vi.advanceTimersByTimeAsync(1000);
    // 即便 poller 未显式传 signal，fetchBotEvents 与 ackBotEvent 也须带 AbortSignal（默认超时）。
    expect(signals.length).toBeGreaterThanOrEqual(2);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    poller.stop();
  });

  it("cursor load 失败或返回非法值时从零启动", async () => {
    const errors: string[] = [];
    const rejected = startEventPoller({
      apiUrl: "https://api.test", botToken: "bf",
      cursorStore: { load: async () => Promise.reject("load down"), save: async () => {} },
      onCardAction: async () => {}, log: { error: (message) => errors.push(message) },
    });
    await rejected.ready;
    expect(rejected.cursor()).toBe(0);
    expect(errors.some((message) => message.includes("load down"))).toBe(true);
    rejected.stop();

    const invalid = startEventPoller({
      apiUrl: "https://api.test", botToken: "bf", cursorStore: memoryCursor(-1),
      onCardAction: async () => {},
    });
    await invalid.ready;
    expect(invalid.cursor()).toBe(0);
    invalid.stop();
  });

  it("按规范化账号注册、触发和注销懒启动器", () => {
    const starter = vi.fn();
    setCardEventPollStarter("Bot-A", starter);
    requestCardEventPolling("bot-a");
    expect(starter).toHaveBeenCalledOnce();

    setCardEventPollStarter("BOT-A", undefined);
    requestCardEventPolling("bot-a");
    expect(starter).toHaveBeenCalledOnce();
  });
});

describe("file event cursor store", () => {
  it("按账号持久化 event_id 并可在新实例恢复", async () => {
    const root = await mkdtemp(join(tmpdir(), "octo-events-"));
    try {
      const store = createFileEventCursorStore({ accountId: "Bot-A", baseDir: root });
      expect(await store.load()).toBe(0);
      await store.save(123);
      expect(await createFileEventCursorStore({ accountId: "bot-a", baseDir: root }).load()).toBe(123);
      expect(JSON.parse(await readFile(join(root, "bot-a", "events.cursor.json"), "utf8")))
        .toEqual({ event_id: 123 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("非法文件回退到零，非法 cursor 拒绝持久化", async () => {
    const root = await mkdtemp(join(tmpdir(), "octo-events-invalid-"));
    try {
      const dir = join(root, "bot-a");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "events.cursor.json"), JSON.stringify({ event_id: -1 }), "utf8");
      const store = createFileEventCursorStore({ accountId: "Bot-A", baseDir: root });
      expect(await store.load()).toBe(0);
      await expect(store.save(-1)).rejects.toThrow("invalid event cursor");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("event poller long-poll", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("不设 waitSeconds 时请求体不带 wait —— 对旧服务端逐字节不变", async () => {
    const bodies: Record<string, unknown>[] = [];
    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : {});
      return Response.json({ results: [] });
    }) as typeof fetch;

    const poller = startEventPoller({
      apiUrl: "https://api.test",
      botToken: "bf_x",
      intervalMs: 1000,
      cursorStore: memoryCursor(0),
      onCardAction: async () => {},
    });
    await poller.ready;
    await vi.advanceTimersByTimeAsync(1000);

    // `wait` must be absent, not `wait: 0` — a server that predates the field would
    // otherwise see an unknown key on every poll.
    expect(bodies[0]).toEqual({ event_id: 0, limit: 50 });
    expect("wait" in bodies[0]).toBe(false);
    poller.stop();
  });

  it("设了 waitSeconds 时请求体带 wait", async () => {
    const bodies: Record<string, unknown>[] = [];
    global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : {});
      return Response.json({ results: [] });
    }) as typeof fetch;

    const poller = startEventPoller({
      apiUrl: "https://api.test",
      botToken: "bf_x",
      intervalMs: 1000,
      waitSeconds: 25,
      cursorStore: memoryCursor(0),
      onCardAction: async () => {},
    });
    await poller.ready;
    await vi.advanceTimersByTimeAsync(0);

    expect(bodies[0]).toEqual({ event_id: 0, limit: 50, wait: 25 });
    poller.stop();
  });

  it("long-poll 模式下不再额外空等 intervalMs", async () => {
    // The whole point: the server already paces the loop by holding the request. Sleeping
    // intervalMs on top would give back most of the latency the hold just bought.
    let calls = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      calls += 1;
      return Response.json({ results: [] });
    }) as typeof fetch;

    const drain = async () => {
      // The reschedule happens in a `finally` after an await chain, so one timer advance is
      // not enough to observe the next tick; drain a few rounds instead of guessing.
      // Advance by 1ms per round: a 0ms advance does not move the clock, so a freshly
      // scheduled setTimeout(...,0) would never come due.
      for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(1);
    };

    const longPoll = startEventPoller({
      apiUrl: "https://api.test",
      botToken: "bf_x",
      intervalMs: 60_000,
      waitSeconds: 25,
      cursorStore: memoryCursor(0),
      onCardAction: async () => {},
    });
    await longPoll.ready;
    await drain();
    const longPollCalls = calls;
    longPoll.stop();

    calls = 0;
    const shortPoll = startEventPoller({
      apiUrl: "https://api.test",
      botToken: "bf_x",
      intervalMs: 60_000,
      cursorStore: memoryCursor(0),
      onCardAction: async () => {},
    });
    await shortPoll.ready;
    await drain();
    const shortPollCalls = calls;
    shortPoll.stop();

    // Same wall-clock (5ms advanced), same intervalMs: short polling is gated by the 60s
    // timer and cannot fire at all, while long polling keeps going back for more as soon as
    // each request settles.
    expect(shortPollCalls).toBe(0);
    expect(longPollCalls).toBeGreaterThan(1);
  });

  it("stop() 中断在途 hold，且不把中断记成轮询失败", async () => {
    const errors: string[] = [];
    let sawAbort = false;
    global.fetch = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            sawAbort = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    ) as typeof fetch;

    const poller = startEventPoller({
      apiUrl: "https://api.test",
      botToken: "bf_x",
      waitSeconds: 25,
      cursorStore: memoryCursor(0),
      log: { error: (message) => errors.push(message) },
      onCardAction: async () => {},
    });
    await poller.ready;
    await vi.advanceTimersByTimeAsync(0);

    poller.stop();
    await vi.advanceTimersByTimeAsync(0);

    // A hold must be cut short on shutdown rather than waited out...
    expect(sawAbort).toBe(true);
    // ...and a deliberate shutdown abort must not surface as a poll failure, or every clean
    // stop would leave a spurious error in the log.
    expect(errors).toEqual([]);
  });
});
