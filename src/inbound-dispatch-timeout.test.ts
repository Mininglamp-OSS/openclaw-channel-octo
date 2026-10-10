import { DocTaskTracker, type DocTaskProgress } from './doc-task-progress.js';
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType, MessageType } from "./types.js";
import {
  handleInboundMessage,
  resolveDispatchTimeoutMs,
  _setDispatchTimeoutForTests,
  _setDispatchApologyTimeoutForTests,
  _setDispatchAbortGraceForTests,
} from "./inbound.js";
import { setOctoRuntime } from "./runtime.js";
import { _clearKnownBots } from "./bot-registry.js";
import { resolveOctoAccount } from "./accounts.js";
import type { ResolvedOctoAccount } from "./accounts.js";
import { createBotTaskHandler } from "./bot-task-handler.js";
import type { BotTaskStateStore } from "./bot-task-store.js";
import { botTaskDedupeKey } from "./bot-task.js";

/**
 * Regression tests for issue #75 — upstream
 * `core.channel.reply.dispatchReplyWithBufferedBlockDispatcher` can hang
 * indefinitely (no resolve, no reject, no onError). Combined with the
 * per-group serial inbound queue (`enqueueInbound` in channel.ts), a single
 * hang locks the entire group: no further messages get processed until the
 * gateway restarts.
 *
 * Scope of this fix (intentionally minimal):
 *   1. Promise.race + setTimeout makes a hang reject as a timeout error
 *      → enqueueInbound's outer .catch() advances the queue.
 *   2. The "处理超时" apology sendMessage carries its own short AbortSignal
 *      → a sick Octo API does NOT re-hang the timeout path.
 *   3. The happy-path final flush of buffered text also carries a short
 *      AbortSignal → even on the success path, a slow API can't strand the
 *      queue.
 *   4. Timeout handle is cleared in finally on every path.
 *
 * Bot Task dispatches additionally receive an AbortSignal. Their queue slot is
 * held for a bounded cancellation grace period; a non-cooperative dispatcher
 * is then treated as already started so the task can be dead-lettered without
 * replay, including when it fulfils during the cancellation grace period.
 */

const API = "http://octo.test";
const BOT_UID = "bot_self_0000000000000000000000000000";
const HUMAN_UID = "human_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GROUP_ID = "g_room_1";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

// Two intentionally DIFFERENT delays so the timer-cleanup test can tell our
// dispatch timer apart from the apology / final-flush AbortSignal.timeout
// timers (both fixed at APOLOGY_TIMEOUT_MS) when filtering setTimeout calls
// by delay.
const TIMEOUT_MS_FOR_TESTS = 100;
const APOLOGY_TIMEOUT_MS_FOR_TESTS = 150;
const ABORT_GRACE_MS_FOR_TESTS = 30;

function makeAccount(): ResolvedOctoAccount {
  return {
    accountId: "acct1",
    enabled: true,
    configured: true,
    config: {
      botToken: "tok",
      apiUrl: API,
      pollIntervalMs: 1000,
      heartbeatIntervalMs: 1000,
      requireMention: false,
    },
  };
}

function makeAtBotMessage() {
  return {
    message_id: "m1",
    message_seq: 100,
    from_uid: HUMAN_UID,
    channel_id: GROUP_ID,
    channel_type: ChannelType.Group,
    timestamp: Math.floor(Date.now() / 1000),
    payload: {
      type: MessageType.Text,
      content: "hello bot",
      mention: { uids: [BOT_UID] },
    },
  };
}

function installFetchStub() {
  const sends: any[] = [];
  globalThis.fetch = vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

    if (url.includes("/members")) {
      return json({
        members: [
          { uid: HUMAN_UID, name: "Alice", robot: false },
          { uid: BOT_UID, name: "SelfBot", robot: true },
        ],
      });
    }
    if (url.includes("/mention_pref")) return json({ no_mention: false });
    if (url.includes("/md")) return json({ content: "", version: 0, updated_at: null, updated_by: "" });
    if (url.includes("/messages/sync")) return json({ messages: [] });
    if (url.includes("/readReceipt")) return json({});
    if (url.includes("/typing")) return json({});
    if (url.includes("/sendMessage")) {
      sends.push(init?.body ? JSON.parse(init.body) : {});
      return json({ message_id: "reply1", message_seq: 0 });
    }
    return json({});
  }) as unknown as typeof fetch;
  return { sends };
}

/**
 * Network stub variant where /sendMessage HANGS until the request's signal
 * aborts. Used to verify that AbortSignal.timeout on the apology + final
 * flush actually interrupts in-flight sends, instead of merely being passed
 * for show.
 */
function installHangingSendFetchStub(): {
  sends: Array<{ content: string | null; abortedBeforeResolve: boolean }>;
} {
  const sends: Array<{ content: string | null; abortedBeforeResolve: boolean }> = [];
  globalThis.fetch = vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

    if (url.includes("/members")) {
      return json({
        members: [
          { uid: HUMAN_UID, name: "Alice", robot: false },
          { uid: BOT_UID, name: "SelfBot", robot: true },
        ],
      });
    }
    if (url.includes("/mention_pref")) return json({ no_mention: false });
    if (url.includes("/md")) return json({ content: "", version: 0, updated_at: null, updated_by: "" });
    if (url.includes("/messages/sync")) return json({ messages: [] });
    if (url.includes("/readReceipt")) return json({});
    if (url.includes("/typing")) return json({});
    if (url.includes("/sendMessage")) {
      const body = init?.body ? JSON.parse(init.body) : null;
      const content: string | null = body?.payload?.content ?? null;
      const signal: AbortSignal | undefined = init?.signal;
      const record = { content, abortedBeforeResolve: false };
      sends.push(record);
      // If no signal was passed, the stub deliberately hangs forever and the
      // test will time out — that surfaces missing wiring loudly.
      if (!signal) {
        await new Promise<void>(() => {});
      }
      // Pre-aborted signal: don't wait for an event that already fired.
      if (signal.aborted) {
        record.abortedBeforeResolve = true;
        throw new Error("aborted");
      }
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => {
          record.abortedBeforeResolve = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
      return json({}); // unreachable
    }
    return json({});
  }) as unknown as typeof fetch;
  return { sends };
}

function installHangingRuntime(): { dispatch: ReturnType<typeof vi.fn> } {
  const dispatch = vi.fn(async () => {
    await new Promise<void>(() => {}); // never resolves, never rejects
  });
  setOctoRuntime({
    config: { current: () => ({}) },
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: dispatch,
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: any) => body,
        finalizeInboundContext: (ctx: any) => ctx,
      },
      routing: {
        resolveAgentRoute: () => ({ agentId: "agent1", sessionKey: "sk1", accountId: "acct1" }),
      },
      session: {
        resolveStorePath: () => "/tmp/store",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: async () => {},
      },
    },
  } as any);
  return { dispatch };
}

function installImmediateRuntime(
  deliverArgs?: { text?: string; kind?: string },
  opts?: { config?: Record<string, unknown> },
) {
  const dispatch = vi.fn(async (args: any) => {
    if (deliverArgs) {
      await args.dispatcherOptions.deliver({ text: deliverArgs.text ?? "hi" }, { kind: deliverArgs.kind ?? "final" });
    }
  });
  setOctoRuntime({
    config: { current: () => opts?.config ?? {} },
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: dispatch,
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: any) => body,
        finalizeInboundContext: (ctx: any) => ctx,
      },
      routing: {
        resolveAgentRoute: () => ({ agentId: "agent1", sessionKey: "sk1", accountId: "acct1" }),
      },
      session: {
        resolveStorePath: () => "/tmp/store",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: async () => {},
      },
    },
  } as any);
  return { dispatch };
}

function pickTimeoutSends(sends: any[]) {
  return sends.filter(
    (body) => typeof body?.payload?.content === "string" && body.payload.content.includes("处理超时"),
  );
}

function runInbound(opts: {
  log?: any;
  routeOverride?: { sessionKey: string; agentId?: string };
  docTask?: Parameters<typeof handleInboundMessage>[0]["docTask"];
} = {}) {
  return handleInboundMessage({
    account: makeAccount(),
    message: makeAtBotMessage() as any,
    botUid: BOT_UID,
    groupHistories: new Map(),
    lastBotReplySeqMap: new Map(),
    memberMap: new Map(),
    uidToNameMap: new Map(),
    groupCacheTimestamps: new Map(),
    log: opts.log,
    routeOverride: opts.routeOverride,
    docTask: opts.docTask,
  });
}

function createInboundBackedBotTaskDispatch(
  log: any,
): Parameters<typeof createBotTaskHandler>[0]["dispatch"] {
  return async (message, routeOverride, extra) => {
    await handleInboundMessage({
      account: makeAccount(),
      message,
      botUid: BOT_UID,
      groupHistories: new Map(),
      lastBotReplySeqMap: new Map(),
      memberMap: new Map(),
      uidToNameMap: new Map(),
      groupCacheTimestamps: new Map(),
      log,
      routeOverride,
      docTask: extra.docTask,
    });
    return "completed";
  };
}

beforeEach(() => {
  _clearKnownBots();
  _setDispatchTimeoutForTests(TIMEOUT_MS_FOR_TESTS);
  _setDispatchApologyTimeoutForTests(APOLOGY_TIMEOUT_MS_FOR_TESTS);
  _setDispatchAbortGraceForTests(ABORT_GRACE_MS_FOR_TESTS);
});

afterEach(() => {
  _setDispatchTimeoutForTests(null);
  _setDispatchApologyTimeoutForTests(null);
  _setDispatchAbortGraceForTests(null);
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  vi.restoreAllMocks();
});

describe("dispatch timeout guard (issue #75)", () => {
  it.each(["deadline", "account stop"])("PPT %s cancels the runtime before a late write or reply", async (reason) => {
    vi.useFakeTimers();
    let enterRuntime!: () => void;
    const entered = new Promise<void>(resolve => { enterRuntime = resolve; });
    try {
    const { dispatch } = installImmediateRuntime();
    installFetchStub();
    const controller = new AbortController();
    let lateWrite = false;
    let aborted = false;
    const postComment = vi.fn().mockResolvedValue(undefined);
    dispatch.mockImplementation(async (args: any) => {
      const signal = args.replyOptions.abortSignal as AbortSignal;
      enterRuntime();
      if (reason === "account stop") setTimeout(() => controller.abort(), 20);
      await new Promise<void>((resolve, reject) => {
        const pending = setTimeout(() => { lateWrite = true; resolve(); }, 80);
        signal.addEventListener("abort", () => {
          aborted = true;
          clearTimeout(pending);
          reject(signal.reason);
        }, { once: true });
      });
      await args.dispatcherOptions.deliver({ text: "late final" }, { kind: "final" });
    });
    const rejected = expect(runInbound({
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      docTask: {
        docId: "deck", threadId: "1", sessionScope: "ppt:deck:1",
        deadlineAt: Date.now() + (reason === "deadline" ? 40 : 1000), abortOnTimeout: true, signal: controller.signal,
        postComment, reportTurn: () => {},
      },
    })).rejects.toThrow(reason === "deadline" ? "dispatch timed out" : "account stopped");
    await entered;
    await vi.advanceTimersByTimeAsync(1100);
    await rejected;
    expect(aborted).toBe(true);
    expect(lateWrite).toBe(false);
    expect(postComment.mock.calls.some(call => call[0].includes("late final"))).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("rolls back a persisted reservation if account stops before runtime handoff", async () => {
    const { dispatch } = installImmediateRuntime();
    installFetchStub();
    const controller = new AbortController();
    const rollback = vi.fn();
    await expect(runInbound({docTask:{
      docId:"deck",threadId:"1",sessionScope:"ppt:deck:1",signal:controller.signal,abortOnTimeout:true,
      postComment:vi.fn(),reportTurn:()=>{},
      onAgentTurnStarted:async()=>{controller.abort();},onAgentTurnNotStarted:rollback,
    }})).rejects.toThrow("account stopped");
    expect(dispatch).not.toHaveBeenCalled();expect(rollback).toHaveBeenCalledOnce();
  });

  it.each([true, false])("rolls back only a synchronous runtime handoff failure (%s)", async synchronous => {
    const { dispatch } = installImmediateRuntime();
    installFetchStub();
    const rollback = vi.fn();
    dispatch.mockImplementation(() => {
      if (synchronous) throw new Error("dispatch rejected");
      return Promise.reject(new Error("dispatch rejected"));
    });
    await expect(runInbound({docTask:{
      docId:"deck",threadId:"1",sessionScope:"ppt:deck:1",abortOnTimeout:true,
      postComment:vi.fn(),reportTurn:()=>{},
      onAgentTurnStarted:async()=>{},onAgentTurnNotStarted:rollback,
    }})).rejects.toThrow("dispatch rejected");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledTimes(synchronous ? 1 : 0);
  });

  it.each(['aborted', 'expired', 'aborted during reservation', 'expired during reservation'])(
    'reports pre-handoff %s as interrupted without running the agent', async mode => {
      const { dispatch } = installImmediateRuntime();
      installFetchStub();
      const sent: DocTaskProgress[] = [];
      const tracker = new DocTaskTracker(async p => { sent.push(p); });
      const controller = new AbortController();
      if (mode === 'aborted') controller.abort();
      const deadlineAt = mode === 'expired' ? Date.now() - 1 : Date.now() + 10_000;
      try {
        await expect(runInbound({
          log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
          docTask: {
            docId: 'deck', threadId: '1', sessionScope: 'ppt:deck:1',
            signal: controller.signal, deadlineAt, abortOnTimeout: true, progress: tracker,
            onAgentTurnStarted: async () => {
              if (mode === 'aborted during reservation') controller.abort();
              if (mode === 'expired during reservation') vi.setSystemTime(deadlineAt + 1);
            },
            postComment: async () => {}, reportTurn: () => {},
          },
        })).rejects.toThrow(/dispatch timed out|account stopped/);
      } finally { await tracker.finish({ finalDelivered: false }); }
      expect(dispatch).not.toHaveBeenCalled();
      expect(sent.at(-1)).toMatchObject({ state: 'unknown', phase: 'ended', errorCode: 'interrupted' });
    },
  );

  it("does not hand an expired PPT task to the Agent runtime", async () => {
    const { dispatch } = installImmediateRuntime();
    installFetchStub();
    await expect(runInbound({
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      docTask: {
        docId: "deck", threadId: "1", sessionScope: "ppt:deck:1",
        deadlineAt: Date.now() - 1, abortOnTimeout: true,
        postComment: async () => {}, reportTurn: () => {},
      },
    })).rejects.toThrow("dispatch timed out");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("started-state failure does not block Bot Task handoff to the real inbound dispatcher", async () => {
    const { dispatch: runtimeDispatch } = installImmediateRuntime();
    installFetchStub();
    const errors: string[] = [];
    const store: BotTaskStateStore = {
      begin: vi.fn().mockResolvedValue({ skip: false, attemptCount: 1 }),
      started: vi.fn().mockRejectedValue(new Error("state file temporarily unreadable")),
      finish: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
    };
    const log = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message: string) => errors.push(message),
    };
    const handle = createBotTaskHandler({
      botUid: BOT_UID,
      store,
      log,
      dispatch: createInboundBackedBotTaskDispatch(log),
    });

    const task = {
      eventId: 41,
      source: "loop",
      taskType: "loop_issue_comment_mention",
      idempotencyKey: "comment-1:bot-1",
      botUid: BOT_UID,
      actorUid: HUMAN_UID,
      sessionKey: "issue:1:thread:2",
      prompt: "Review the issue and reply if needed.",
      context: { issue_id: "1" },
    };
    await expect(handle(task)).resolves.toBeUndefined();

    expect(runtimeDispatch).toHaveBeenCalledOnce();
    expect(store.retry).not.toHaveBeenCalled();
    expect(store.finish).toHaveBeenCalledWith(41, botTaskDedupeKey(task), "completed");
    expect(errors.some((message) => message.includes("started-boundary state write failed"))).toBe(true);
  });

  it.each(["runtime missing", "route resolution failure"] as const)(
    "retries Bot Tasks when inbound exits before handoff: %s",
    async (failure) => {
      const runtimeDispatch = vi.fn().mockResolvedValue(undefined);
      setOctoRuntime({
        config: { current: () => ({}) },
        channel: {
          reply: {
            ...(failure === "runtime missing"
              ? {}
              : { dispatchReplyWithBufferedBlockDispatcher: runtimeDispatch }),
            resolveEnvelopeFormatOptions: () => ({}),
            formatAgentEnvelope: ({ body }: any) => body,
            finalizeInboundContext: (ctx: any) => ctx,
          },
          routing: {
            resolveAgentRoute: () => {
              if (failure === "route resolution failure") throw new Error("route unavailable");
              return { agentId: "agent1", sessionKey: "sk1", accountId: "acct1" };
            },
          },
          session: {
            resolveStorePath: () => "/tmp/store",
            readSessionUpdatedAt: () => undefined,
            recordInboundSession: async () => {},
          },
        },
      } as any);
      installFetchStub();
      const store: BotTaskStateStore = {
        begin: vi.fn().mockResolvedValue({ skip: false, attemptCount: 1 }),
        started: vi.fn().mockResolvedValue(undefined),
        finish: vi.fn().mockResolvedValue(undefined),
        retry: vi.fn().mockResolvedValue(undefined),
      };
      const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
      const handle = createBotTaskHandler({
        botUid: BOT_UID,
        store,
        log,
        dispatch: createInboundBackedBotTaskDispatch(log),
      });

      await expect(handle({
        eventId: 42,
        source: "loop",
        taskType: "loop_issue_comment_mention",
        idempotencyKey: `pre-handoff:${failure}`,
        botUid: BOT_UID,
        actorUid: HUMAN_UID,
        sessionKey: "issue:2:thread:3",
        prompt: "Review the issue.",
        context: { issue_id: "2" },
      })).rejects.toThrow("completed before Agent turn started");

      expect(runtimeDispatch).not.toHaveBeenCalled();
      expect(store.started).not.toHaveBeenCalled();
      expect(store.finish).not.toHaveBeenCalled();
      expect(store.retry).toHaveBeenCalledOnce();
    },
  );

  it("可信 route override 保持原始 sessionKey", async () => {
    const { dispatch } = installImmediateRuntime();
    installFetchStub();

    await runInbound({
      routeOverride: { sessionKey: "origin-session", agentId: "origin-agent" },
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });

    expect(dispatch.mock.calls[0][0].ctx.SessionKey).toBe("origin-session");
  });

  it("hang: rejects after timeout, sends 处理超时 apology, would unblock per-group queue", async () => {
    const { dispatch } = installHangingRuntime();
    const { sends } = installFetchStub();
    const warnSpy = vi.fn();

    await expect(runInbound({ log: { debug: () => {}, info: () => {}, warn: warnSpy, error: () => {} } }))
      .rejects.toThrow();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(pickTimeoutSends(sends)).toHaveLength(1);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("dispatch hung"))).toBe(true);
  });

  it("bot task timeout propagates a dispatcher rejection after waiting for it to settle", async () => {
    let abortObserved = false;
    let dispatchSettled = false;
    const dispatch = vi.fn(async (args: any) => {
      const signal = args.replyOptions.abortSignal as AbortSignal | undefined;
      expect(signal).toBeInstanceOf(AbortSignal);
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener("abort", () => {
          abortObserved = true;
          setTimeout(() => {
            dispatchSettled = true;
            reject(signal!.reason);
          }, 20);
        }, { once: true });
      });
    });
    setOctoRuntime({
      config: { current: () => ({}) },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: dispatch,
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: ({ body }: any) => body,
          finalizeInboundContext: (ctx: any) => ctx,
        },
        routing: { resolveAgentRoute: () => ({ agentId: "agent1", sessionKey: "sk1", accountId: "acct1" }) },
        session: {
          resolveStorePath: () => "/tmp/store",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: async () => {},
        },
      },
    } as any);
    installFetchStub();

    const reports: any[] = [];
    await expect(runInbound({
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      docTask: {
        docId: "loop",
        threadId: "issue-1",
        sessionScope: "octo:bot-task:bot-1:loop:issue-1",
        abortOnTimeout: true,
        postComment: async () => {},
        reportTurn: (report) => reports.push(report),
      },
    })).rejects.toThrow("dispatch timed out");

    expect(abortObserved).toBe(true);
    expect(dispatchSettled).toBe(true);
    expect(reports).toHaveLength(1);
  });

  it("bot task timeout stays terminal when the turn fulfils during cancellation grace", async () => {
    let abortObserved = false;
    const dispatch = vi.fn(async (args: any) => {
      const signal = args.replyOptions.abortSignal as AbortSignal;
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          abortObserved = true;
          setTimeout(resolve, 20);
        }, { once: true });
      });
    });
    setOctoRuntime({
      config: { current: () => ({}) },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: dispatch,
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: ({ body }: any) => body,
          finalizeInboundContext: (ctx: any) => ctx,
        },
        routing: { resolveAgentRoute: () => ({ agentId: "agent1", sessionKey: "sk1", accountId: "acct1" }) },
        session: {
          resolveStorePath: () => "/tmp/store",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: async () => {},
        },
      },
    } as any);
    installFetchStub();
    const reports: any[] = [];

    await expect(runInbound({
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      docTask: {
        docId: "loop",
        threadId: "issue-1",
        sessionScope: "octo:bot-task:bot-1:loop:issue-1",
        abortOnTimeout: true,
        postComment: async () => {},
        reportTurn: (report) => reports.push(report),
      },
    })).rejects.toThrow("dispatch timed out");

    expect(abortObserved).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ noticed: false });
  });

  it("bot task timeout releases the queue after bounded grace when dispatch ignores abort", async () => {
    const dispatch = vi.fn(async (args: any) => {
      expect(args.replyOptions.abortSignal).toBeInstanceOf(AbortSignal);
      await new Promise<void>(() => {});
    });
    setOctoRuntime({
      config: { current: () => ({}) },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: dispatch,
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: ({ body }: any) => body,
          finalizeInboundContext: (ctx: any) => ctx,
        },
        routing: { resolveAgentRoute: () => ({ agentId: "agent1", sessionKey: "sk1", accountId: "acct1" }) },
        session: {
          resolveStorePath: () => "/tmp/store",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: async () => {},
        },
      },
    } as any);
    installFetchStub();
    const warnSpy = vi.fn();
    const errorSpy = vi.fn(() => {
      // The timeout diagnostic must be visible before the grace period expires.
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("dispatch hung"))).toBe(true);
    });
    const reports: any[] = [];

    const inbound = runInbound({
      log: { debug: () => {}, info: () => {}, warn: warnSpy, error: errorSpy },
      docTask: {
        docId: "loop",
        threadId: "issue-1",
        sessionScope: "octo:bot-task:bot-1:loop:issue-1",
        abortOnTimeout: true,
        postComment: async () => {},
        reportTurn: (report) => reports.push(report),
      },
    });

    await expect(Promise.race([
      inbound,
      new Promise((_, reject) => setTimeout(() => reject(new Error("queue remained blocked")), 1_000)),
    ])).rejects.toThrow("dispatch timed out");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("ignored abort"))).toBe(true);
    expect(reports).toHaveLength(1);
  });

  // --- 超时提示的抑制条件 ---
  // 抑制「答复已经发出去了就别再追一句超时」是对的,但守卫必须用「**最终答复**
  // 落地了」而不是 replySucceeded —— 后者对进度/工具文本也置位。用错的话,
  // 「只发过进度然后 hang」的回合彻底收不到终态信号,而这条路径在 docTasks
  // 关着时也走,是普通 DM/群聊上的静默回归。

  it("只发过工具/进度文本然后 hang:超时提示必须照发", async () => {
    const dispatch = vi.fn(async (args: any) => {
      await args.dispatcherOptions.deliver({ text: "正在读取文档…" }, { kind: "tool" });
      await new Promise<void>(() => {}); // 随后挂死
    });
    setOctoRuntime({
      config: { current: () => ({}) },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: dispatch,
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: ({ body }: any) => body,
          finalizeInboundContext: (ctx: any) => ctx,
        },
        routing: { resolveAgentRoute: () => ({ agentId: "agent1", sessionKey: "sk1", accountId: "acct1" }) },
        session: {
          resolveStorePath: () => "/tmp/store",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: async () => {},
        },
      },
    } as any);
    const { sends } = installFetchStub();

    await expect(runInbound({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))
      .rejects.toThrow();

    expect(pickTimeoutSends(sends)).toHaveLength(1);
  });

  it("最终答复已经发出去之后才 hang:抑制超时提示,不自相矛盾", async () => {
    const dispatch = vi.fn(async (args: any) => {
      await args.dispatcherOptions.deliver({ text: "已按要求改好" }, { kind: "final" });
      await new Promise<void>(() => {});
    });
    setOctoRuntime({
      config: { current: () => ({}) },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: dispatch,
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: ({ body }: any) => body,
          finalizeInboundContext: (ctx: any) => ctx,
        },
        routing: { resolveAgentRoute: () => ({ agentId: "agent1", sessionKey: "sk1", accountId: "acct1" }) },
        session: {
          resolveStorePath: () => "/tmp/store",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: async () => {},
        },
      },
    } as any);
    const { sends } = installFetchStub();

    await expect(runInbound({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))
      .rejects.toThrow();

    expect(pickTimeoutSends(sends)).toHaveLength(0);
  });

  it("happy path: dispatchTimeoutHandle is cleared (no leaked timer)", async () => {
    // Spy on setTimeout/clearTimeout to find the specific dispatch-timeout
    // handle and verify it gets cleared. Filter by delay === TIMEOUT_MS_FOR_TESTS
    // which is unique (APOLOGY_TIMEOUT_MS_FOR_TESTS is intentionally different).
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout") as any;
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout") as any;

    installImmediateRuntime({ text: "hi", kind: "final" });
    installFetchStub();

    await runInbound({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } });

    const dispatchTimerCalls = setTimeoutSpy.mock.calls
      .map((call: any[], idx: number) => ({ delay: call[1], idx }))
      .filter((x: any) => x.delay === TIMEOUT_MS_FOR_TESTS);
    expect(dispatchTimerCalls.length).toBeGreaterThan(0);

    for (const c of dispatchTimerCalls) {
      const handle = setTimeoutSpy.mock.results[c.idx]?.value;
      expect(handle).toBeDefined();
      const cleared = clearTimeoutSpy.mock.calls.some((call: any[]) => call[0] === handle);
      expect(cleared, `dispatch-timeout handle from setTimeout call ${c.idx} was not cleared`).toBe(true);
    }
  });

  it("apology AbortSignal actually fires: sick API doesn't re-hang the queue", async () => {
    // Simulates the worst meta-case: the same Octo API that caused the
    // upstream dispatch to hang ALSO hangs when we try to POST the apology.
    // The apology's AbortSignal.timeout(APOLOGY_TIMEOUT_MS) must fire and
    // runInbound must still reject within bounded time — otherwise the fix
    // is self-defeating.
    installHangingRuntime();
    const { sends } = installHangingSendFetchStub();

    const start = Date.now();
    await expect(runInbound({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))
      .rejects.toThrow();
    const elapsed = Date.now() - start;
    expect(elapsed, "must settle within bound, not hang forever").toBeLessThan(2000);

    const apology = sends.find((s) => s.content?.includes("处理超时"));
    expect(apology, "apology sendMessage must reach fetch").toBeDefined();
    expect(apology!.abortedBeforeResolve, "apology must be aborted by its own AbortSignal.timeout").toBe(true);
  });

  it("happy-path final flush hang: bounded so per-group queue is not stranded", async () => {
    // Dispatch returns normally with a "block" kind (populates lastText, does
    // NOT set textSent), so the finally branch hits the final flush. The
    // Octo API hangs on that POST. Without bounding the final flush, the
    // function would hang forever even though dispatch succeeded.
    const dispatch = vi.fn(async (args: any) => {
      await args.dispatcherOptions.deliver({ text: "buffered-final" }, { kind: "block" });
    });
    setOctoRuntime({
      config: { current: () => ({}) },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: dispatch,
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: ({ body }: any) => body,
          finalizeInboundContext: (ctx: any) => ctx,
        },
        routing: {
          resolveAgentRoute: () => ({ agentId: "agent1", sessionKey: "sk1", accountId: "acct1" }),
        },
        session: {
          resolveStorePath: () => "/tmp/store",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: async () => {},
        },
      },
    } as any);
    const { sends } = installHangingSendFetchStub();

    const start = Date.now();
    // Dispatch succeeded → handleInboundMessage does NOT reject; the final
    // flush error is caught + logged. Just verify it RESOLVES within bound.
    await runInbound({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);

    const finalFlush = sends.find((s) => s.content === "buffered-final");
    expect(finalFlush, "final flush sendMessage must reach fetch").toBeDefined();
    expect(finalFlush!.abortedBeforeResolve, "final flush must be aborted by its own AbortSignal.timeout").toBe(true);
  });
});

describe("dispatch-reject fallback guard (PR #152 regression)", () => {
  it("blocks-only turn: dispatch rejects → delivers buffered block text, NOT error message", async () => {
    // Regression: the fallback branch unconditionally cleared deliverBuffer
    // before sending the error message, discarding a valid blocks-only reply
    // and sending a contradictory error instead. The fix: if deliverBuffer
    // has buffered text, deliver it and skip the error message.
    const dispatch = vi.fn(async (args: any) => {
      await args.dispatcherOptions.deliver({ text: "block-content-reply" }, { kind: "block" });
      throw new Error("non_deliverable_terminal_turn");
    });
    setOctoRuntime({
      config: { current: () => ({}) },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: dispatch,
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: ({ body }: any) => body,
          finalizeInboundContext: (ctx: any) => ctx,
        },
        routing: {
          resolveAgentRoute: () => ({ agentId: "agent1", sessionKey: "sk1", accountId: "acct1" }),
        },
        session: {
          resolveStorePath: () => "/tmp/store",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: async () => {},
        },
      },
    } as any);
    const { sends } = installFetchStub();

    await expect(
      runInbound({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }),
    ).rejects.toThrow();

    const actualReplies = sends.filter((s) => typeof s?.payload?.content === "string");
    const blockReply = actualReplies.find((s) => s.payload.content === "block-content-reply");
    const errorApology = actualReplies.find((s) => typeof s?.payload?.content === "string" && s.payload.content.includes("⚠️"));

    expect(blockReply, "buffered block text must be delivered").toBeDefined();
    expect(errorApology, "error apology must NOT be sent when buffered text exists").toBeUndefined();
  });

  it("no-content turn: dispatch rejects with no buffered text → sends error fallback", async () => {
    // When dispatch rejects and no block text was buffered (and no reply
    // succeeded), the error fallback should still fire as before.
    const dispatch = vi.fn(async () => {
      throw new Error("non_deliverable_terminal_turn");
    });
    setOctoRuntime({
      config: { current: () => ({}) },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: dispatch,
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: ({ body }: any) => body,
          finalizeInboundContext: (ctx: any) => ctx,
        },
        routing: {
          resolveAgentRoute: () => ({ agentId: "agent1", sessionKey: "sk1", accountId: "acct1" }),
        },
        session: {
          resolveStorePath: () => "/tmp/store",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: async () => {},
        },
      },
    } as any);
    const { sends } = installFetchStub();

    await expect(
      runInbound({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }),
    ).rejects.toThrow();

    const errorApology = sends.find(
      (s) => typeof s?.payload?.content === "string" && s.payload.content.includes("\u26a0\ufe0f"),
    );
    expect(errorApology, "error apology must be sent when no content was buffered").toBeDefined();
  });
});

describe("dispatch timeout derivation from config (issue #113)", () => {
  // These tests exercise the real resolution chain, so clear the test
  // override that the outer beforeEach installs.
  beforeEach(() => {
    _setDispatchTimeoutForTests(null);
  });

  it("derives from agents.defaults.timeoutSeconds + 60s buffer (1000s → 1060s)", () => {
    const cfg = { agents: { defaults: { timeoutSeconds: 1000 } } } as any;
    expect(resolveDispatchTimeoutMs(cfg, makeAccount())).toBe(1_060_000);
  });

  it("falls back to 600s agent timeout when cfg omits timeoutSeconds → 660s", () => {
    expect(resolveDispatchTimeoutMs({} as any, makeAccount())).toBe(660_000);
    expect(resolveDispatchTimeoutMs({ agents: {} } as any, makeAccount())).toBe(660_000);
    expect(resolveDispatchTimeoutMs({ agents: { defaults: {} } } as any, makeAccount())).toBe(660_000);
  });

  describe("clamp to setTimeout ceiling (issue #121)", () => {
    const CEIL = 2 ** 31 - 1; // 2_147_483_647, Node setTimeout 32-bit delay 上限

    it("clamps absurd timeoutSeconds (MAX_SAFE_INTEGER) to 2^31-1 instead of overflowing setTimeout", () => {
      const cfg = { agents: { defaults: { timeoutSeconds: Number.MAX_SAFE_INTEGER } } } as any;
      const ms = resolveDispatchTimeoutMs(cfg, makeAccount());
      expect(ms).toBe(CEIL);
      expect(ms).toBeLessThanOrEqual(CEIL);
    });

    it("clamps a large-but-finite timeoutSeconds (30d → > 2^31 ms) to 2^31-1", () => {
      const cfg = { agents: { defaults: { timeoutSeconds: 2_592_000 } } } as any; // 30 天
      expect(resolveDispatchTimeoutMs(cfg, makeAccount())).toBe(CEIL);
    });

    it("clamps absurd explicit dispatchTimeoutMs (MAX_SAFE_INTEGER) to 2^31-1", () => {
      const account = makeAccount();
      (account.config as any).dispatchTimeoutMs = Number.MAX_SAFE_INTEGER;
      const ms = resolveDispatchTimeoutMs({} as any, account);
      expect(ms).toBe(CEIL);
      expect(ms).toBeLessThanOrEqual(CEIL);
    });

    it("derived-path boundary: 2_147_423s (≤ ceil) not clamped, 2_147_424s (> ceil) clamped", () => {
      // 2_147_423*1000 + 60_000 = 2_147_483_000 ≤ CEIL → 原样
      expect(
        resolveDispatchTimeoutMs({ agents: { defaults: { timeoutSeconds: 2_147_423 } } } as any, makeAccount()),
      ).toBe(2_147_483_000);
      // 2_147_424*1000 + 60_000 = 2_147_484_000 > CEIL → 夹到 CEIL
      expect(
        resolveDispatchTimeoutMs({ agents: { defaults: { timeoutSeconds: 2_147_424 } } } as any, makeAccount()),
      ).toBe(CEIL);
    });

    it("explicit-path boundary: exactly ceil not clamped, ceil+1 clamped", () => {
      const atCeil = makeAccount();
      (atCeil.config as any).dispatchTimeoutMs = CEIL;
      expect(resolveDispatchTimeoutMs({} as any, atCeil)).toBe(CEIL);
      const overCeil = makeAccount();
      (overCeil.config as any).dispatchTimeoutMs = 2 ** 31; // ceil + 1
      expect(resolveDispatchTimeoutMs({} as any, overCeil)).toBe(CEIL);
    });
  });

  it("explicit dispatchTimeoutMs config wins over the derived value", () => {
    const account = makeAccount();
    account.config.dispatchTimeoutMs = 1_234_000;
    const cfg = { agents: { defaults: { timeoutSeconds: 1000 } } } as any;
    expect(resolveDispatchTimeoutMs(cfg, account)).toBe(1_234_000);
  });

  it("invalid explicit values (0, negative, NaN, Infinity) fall through to derivation", () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      const account = makeAccount();
      (account.config as any).dispatchTimeoutMs = bad;
      expect(resolveDispatchTimeoutMs({} as any, account), `bad value: ${bad}`).toBe(660_000);
    }
  });

  it("invalid agents.defaults.timeoutSeconds falls back to the 600s default", () => {
    for (const bad of [0, -1, NaN, "1000"]) {
      const cfg = { agents: { defaults: { timeoutSeconds: bad } } } as any;
      expect(resolveDispatchTimeoutMs(cfg, makeAccount()), `bad value: ${bad}`).toBe(660_000);
    }
  });

  it("_setDispatchTimeoutForTests override beats both explicit config and derivation", () => {
    _setDispatchTimeoutForTests(123);
    const account = makeAccount();
    account.config.dispatchTimeoutMs = 999_999;
    const cfg = { agents: { defaults: { timeoutSeconds: 1000 } } } as any;
    expect(resolveDispatchTimeoutMs(cfg, account)).toBe(123);
  });

  it("resolveOctoAccount plumbs dispatchTimeoutMs: account-level overrides channel-level", () => {
    const cfg = {
      channels: {
        octo: {
          botToken: "tok",
          apiUrl: API,
          dispatchTimeoutMs: 700_000,
          accounts: {
            a1: { botToken: "tok1", dispatchTimeoutMs: 900_000 },
            a2: { botToken: "tok2" },
          },
        },
      },
    } as any;
    expect(resolveOctoAccount({ cfg, accountId: "a1" }).config.dispatchTimeoutMs).toBe(900_000);
    // a2 sets nothing → inherits the channel-level value
    expect(resolveOctoAccount({ cfg, accountId: "a2" }).config.dispatchTimeoutMs).toBe(700_000);
    // neither set → undefined (handleInboundMessage derives from agent timeout)
    const bare = { channels: { octo: { botToken: "tok", apiUrl: API } } } as any;
    expect(resolveOctoAccount({ cfg: bare, accountId: null }).config.dispatchTimeoutMs).toBeUndefined();
  });

  it("wiring: handleInboundMessage arms the dispatch timer with the derived value", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout") as any;

    installImmediateRuntime(
      { text: "hi", kind: "final" },
      { config: { agents: { defaults: { timeoutSeconds: 1000 } } } },
    );
    installFetchStub();

    await runInbound({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } });

    const armed = setTimeoutSpy.mock.calls.some((call: any[]) => call[1] === 1_060_000);
    expect(armed, "dispatch timer must be armed with timeoutSeconds*1000 + 60s").toBe(true);
  });
});
