import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType, MessageType } from "./types.js";
import {
  handleInboundMessage,
  _setDispatchTimeoutForTests,
  _setDispatchApologyTimeoutForTests,
} from "./inbound.js";
import { setOctoRuntime } from "./runtime.js";
import { _clearKnownBots } from "./bot-registry.js";
import type { ResolvedOctoAccount } from "./accounts.js";
import { resolveOctoAccount } from "./accounts.js";

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
 * Out of scope (tracked separately): cancellation of an already-in-flight
 * upstream dispatch / suppression of late deliver/onError callbacks from a
 * dispatch that "wakes up" after our timeout. If the upstream resumes, the
 * worst outcome is a delayed real reply on top of the apology — annoying,
 * not broken.
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

function makeAccount(configOverrides?: Partial<ResolvedOctoAccount["config"]>): ResolvedOctoAccount {
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
      ...configOverrides,
    },
  };
}

// Real-timer sleep that bypasses any setTimeout spy installed in a test, so
// streaming-delivery pacing never pollutes the spy's call records.
const sleep = (ms: number) => new Promise<void>((resolve) => originalSetTimeout(resolve, ms));

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
    config: { loadConfig: () => ({}) },
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

function installImmediateRuntime(deliverArgs?: { text?: string; kind?: string }) {
  const dispatch = vi.fn(async (args: any) => {
    if (deliverArgs) {
      await args.dispatcherOptions.deliver({ text: deliverArgs.text ?? "hi" }, { kind: deliverArgs.kind ?? "final" });
    }
  });
  setOctoRuntime({
    config: { loadConfig: () => ({}) },
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

/**
 * Runtime that streams a series of deliver() calls spaced `intervalMs` apart,
 * optionally finishing with a non-reasoning "final" block. Used to exercise the
 * idle-reset path: each delivery resets the idle timer, so a total stream
 * longer than the idle window must NOT time out as long as every gap is shorter
 * than the window.
 */
function installStreamingRuntime(opts: {
  deliveries: Array<{ text?: string; isReasoning?: boolean; kind?: string }>;
  intervalMs: number;
  finalText?: string;
}) {
  const dispatch = vi.fn(async (args: any) => {
    for (const d of opts.deliveries) {
      await sleep(opts.intervalMs);
      await args.dispatcherOptions.deliver(
        { text: d.text, isReasoning: d.isReasoning },
        { kind: d.kind ?? "block" },
      );
    }
    if (opts.finalText !== undefined) {
      await sleep(opts.intervalMs);
      await args.dispatcherOptions.deliver({ text: opts.finalText }, { kind: "block" });
    }
  });
  setOctoRuntime({
    config: { loadConfig: () => ({}) },
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

function runInbound(opts: { log?: any; account?: ResolvedOctoAccount } = {}) {
  return handleInboundMessage({
    account: opts.account ?? makeAccount(),
    message: makeAtBotMessage() as any,
    botUid: BOT_UID,
    groupHistories: new Map(),
    lastBotReplySeqMap: new Map(),
    memberMap: new Map(),
    uidToNameMap: new Map(),
    groupCacheTimestamps: new Map(),
    log: opts.log,
  });
}

beforeEach(() => {
  _clearKnownBots();
  _setDispatchTimeoutForTests(TIMEOUT_MS_FOR_TESTS);
  _setDispatchApologyTimeoutForTests(APOLOGY_TIMEOUT_MS_FOR_TESTS);
});

afterEach(() => {
  _setDispatchTimeoutForTests(null);
  _setDispatchApologyTimeoutForTests(null);
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  vi.restoreAllMocks();
});

describe("dispatch timeout guard (issue #75)", () => {
  it("hang: rejects after timeout, sends 处理超时 apology, would unblock per-group queue", async () => {
    const { dispatch } = installHangingRuntime();
    const { sends } = installFetchStub();
    const warnSpy = vi.fn();

    await expect(runInbound({ log: { debug: () => {}, info: () => {}, warn: warnSpy, error: () => {} } }))
      .rejects.toThrow();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(pickTimeoutSends(sends)).toHaveLength(1);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("dispatch idle"))).toBe(true);
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
      config: { loadConfig: () => ({}) },
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

/**
 * Regression tests for issue #113 — the dispatch timeout used to be a single
 * non-resetting setTimeout measuring TOTAL turn wall-clock, which killed long
 * but actively-streaming turns. It is now an IDLE timer: every deliver event
 * resets it, so only a genuinely silent dispatch (zero events for a full
 * window) is treated as hung.
 */
describe("dispatch idle timeout (issue #113)", () => {
  // Window comfortably larger than each delivery gap, but smaller than the
  // total stream duration — so a correct idle reset survives while a stale
  // "total wall-clock" timer would fire mid-stream.
  const IDLE_WINDOW_MS = 200;
  const DELIVER_INTERVAL_MS = 20;
  const DELIVER_COUNT = 12; // 12 * 20ms = 240ms total > 200ms window

  it("idle reset: repeated deliver within the window outlasts it without timing out", async () => {
    _setDispatchTimeoutForTests(IDLE_WINDOW_MS);
    installStreamingRuntime({
      deliveries: Array.from({ length: DELIVER_COUNT }, (_, i) => ({ text: `chunk ${i}` })),
      intervalMs: DELIVER_INTERVAL_MS,
      finalText: "the real answer",
    });
    const { sends } = installFetchStub();

    await runInbound({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } });

    // No timeout apology, and the real buffered reply was flushed.
    expect(pickTimeoutSends(sends)).toHaveLength(0);
    const realReply = sends.find((s) => s?.payload?.content === "the real answer");
    expect(realReply, "real reply must be sent after a long but active stream").toBeDefined();
  });

  it("reasoning-only stream resets the idle timer (reset runs before isReasoning return)", async () => {
    // This locks the ordering constraint: resetIdleTimer() MUST be called
    // before `if (payload.isReasoning) return;`. A turn that streams only
    // reasoning blocks for longer than the window must NOT be killed. Moving
    // the reset after the early return makes this test fail (idle timer fires
    // mid-reasoning → 处理超时).
    _setDispatchTimeoutForTests(IDLE_WINDOW_MS);
    installStreamingRuntime({
      deliveries: Array.from({ length: DELIVER_COUNT }, () => ({ isReasoning: true })),
      intervalMs: DELIVER_INTERVAL_MS,
      finalText: "answer after thinking",
    });
    const { sends } = installFetchStub();

    await runInbound({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } });

    expect(pickTimeoutSends(sends)).toHaveLength(0);
    const realReply = sends.find((s) => s?.payload?.content === "answer after thinking");
    expect(realReply, "reply must follow a long reasoning-only phase without timing out").toBeDefined();
  });

  it("true idle: a dispatch that never delivers rejects, posts 处理超时, advances the queue", async () => {
    // Same semantics as the issue #75 hang test — zero deliver events ever, so
    // the idle timer (armed once before the race) fires.
    const { dispatch } = installHangingRuntime();
    const { sends } = installFetchStub();
    const warnSpy = vi.fn();

    await expect(runInbound({ log: { debug: () => {}, info: () => {}, warn: warnSpy, error: () => {} } }))
      .rejects.toThrow();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(pickTimeoutSends(sends)).toHaveLength(1);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("dispatch idle"))).toBe(true);
  });

  it("config: account.config.dispatchIdleTimeoutMs overrides the default window", async () => {
    // Default window is set deliberately large; the per-account override is
    // small. The hanging runtime never delivers, so it must time out at the
    // SMALL account value — proving the account override is honored, not the
    // large default.
    _setDispatchTimeoutForTests(10_000);
    installHangingRuntime();
    const { sends } = installFetchStub();

    const account = makeAccount({ dispatchIdleTimeoutMs: 80 });
    const start = Date.now();
    await expect(
      runInbound({ account, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }),
    ).rejects.toThrow();
    const elapsed = Date.now() - start;

    expect(pickTimeoutSends(sends)).toHaveLength(1);
    expect(elapsed, "must time out at the small account window, not the 10s default").toBeLessThan(2000);
  });

  // Suggestion #1 — runtime finite-positive guard for dispatchIdleTimeoutMs.
  // The schema's minimum:1000 is host metadata and is not enforced at runtime;
  // a dirty config can smuggle NaN/0/negative/Infinity past it. setTimeout
  // clamps any of those to a 1ms delay, and since the idle timer arms ONCE
  // before the first deliver, a 1ms window would fire before any delivery and
  // mark every message timed out — bricking the whole account/channel. The
  // guard must fall back to the DEFAULT (not the 1000 floor, which would break
  // the legitimate 80ms override above).
  //
  // Each case sets the default to a controllable small window (IDLE_WINDOW_MS)
  // and runs the streaming runtime: 12 chunks 20ms apart (240ms total) survive
  // the 200ms window only via idle resets. If the invalid value were honored,
  // setTimeout's 1ms clamp would fire before the first chunk → 处理超时. So a
  // clean stream + a warn log proves the fallback, distinguishing it from an
  // instant timeout.
  for (const { label, value } of [
    { label: "NaN", value: NaN },
    { label: "0", value: 0 },
    { label: "negative", value: -5 },
    { label: "Infinity", value: Infinity },
  ]) {
    it(`config: invalid dispatchIdleTimeoutMs=${label} falls back to default (no instant timeout)`, async () => {
      _setDispatchTimeoutForTests(IDLE_WINDOW_MS);
      installStreamingRuntime({
        deliveries: Array.from({ length: DELIVER_COUNT }, (_, i) => ({ text: `chunk ${i}` })),
        intervalMs: DELIVER_INTERVAL_MS,
        finalText: "fallback answer",
      });
      const { sends } = installFetchStub();
      const warnSpy = vi.fn();

      const account = makeAccount({ dispatchIdleTimeoutMs: value as number });
      await runInbound({ account, log: { debug: () => {}, info: () => {}, warn: warnSpy, error: () => {} } });

      // Fell back to the default window: the long-but-active stream was NOT
      // killed (no 处理超时), and the real buffered reply was flushed.
      expect(pickTimeoutSends(sends)).toHaveLength(0);
      expect(sends.find((s) => s?.payload?.content === "fallback answer")).toBeDefined();
      // And the invalid value was reported.
      expect(
        warnSpy.mock.calls.some((c) => String(c[0]).includes("ignoring invalid dispatchIdleTimeoutMs")),
        "an invalid dispatchIdleTimeoutMs must be logged",
      ).toBe(true);
    });
  }

  it("config: resolveOctoAccount picks account > channel-top-level > undefined", () => {
    // account value wins over channel top-level
    const both = resolveOctoAccount({
      cfg: {
        channels: {
          octo: {
            dispatchIdleTimeoutMs: 5000,
            accounts: { acctA: { dispatchIdleTimeoutMs: 1234 } },
          },
        },
      } as any,
      accountId: "acctA",
    });
    expect(both.config.dispatchIdleTimeoutMs).toBe(1234);

    // only channel top-level set → channel value used
    const channelOnly = resolveOctoAccount({
      cfg: {
        channels: {
          octo: {
            dispatchIdleTimeoutMs: 5000,
            accounts: { acctA: {} },
          },
        },
      } as any,
      accountId: "acctA",
    });
    expect(channelOnly.config.dispatchIdleTimeoutMs).toBe(5000);

    // neither set → undefined (inbound.ts then falls back to the default)
    const neither = resolveOctoAccount({
      cfg: { channels: { octo: { accounts: { acctA: {} } } } } as any,
      accountId: "acctA",
    });
    expect(neither.config.dispatchIdleTimeoutMs).toBeUndefined();
  });

  it("timer cleanup: every idle-timer setTimeout handle is eventually cleared (reset + finally)", async () => {
    // resetIdleTimer arms a fresh setTimeout on each delivery and clears the
    // prior one; the finally block clears the last. Net: zero leaked timers.
    // Filter by delay === IDLE_WINDOW_MS, which is unique vs the apology timers
    // (APOLOGY_TIMEOUT_MS_FOR_TESTS) and the streaming sleeps (which bypass the
    // spy via originalSetTimeout).
    _setDispatchTimeoutForTests(IDLE_WINDOW_MS);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout") as any;
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout") as any;

    installStreamingRuntime({
      deliveries: Array.from({ length: 4 }, (_, i) => ({ text: `chunk ${i}` })),
      intervalMs: DELIVER_INTERVAL_MS,
      finalText: "done",
    });
    installFetchStub();

    await runInbound({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } });

    const idleTimerCalls = setTimeoutSpy.mock.calls
      .map((call: any[], idx: number) => ({ delay: call[1], idx }))
      .filter((x: any) => x.delay === IDLE_WINDOW_MS);
    // arm-once + one reset per delivery (4 chunks + 1 final) = several timers
    expect(idleTimerCalls.length).toBeGreaterThan(1);

    for (const c of idleTimerCalls) {
      const handle = setTimeoutSpy.mock.results[c.idx]?.value;
      expect(handle).toBeDefined();
      const cleared = clearTimeoutSpy.mock.calls.some((call: any[]) => call[0] === handle);
      expect(cleared, `idle-timer handle from setTimeout call ${c.idx} was not cleared`).toBe(true);
    }
  });

  it("late deliver after idle timeout does not arm a new (uncleared) idle timer", async () => {
    // The Promise.race settles on idle timeout, but the upstream dispatch may
    // keep running and call deliver() afterwards. resetIdleTimer() must NOT arm
    // a fresh setTimeout once the race has settled — the finally block already
    // ran its clearTimeout and would never clear a newly-armed handle, leaking
    // one timer ref for up to a full idle window. The `settled` guard gates
    // ONLY the timer re-arm; the late reply content is still delivered.
    _setDispatchTimeoutForTests(IDLE_WINDOW_MS);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout") as any;
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout") as any;

    // Dispatch captures the deliver callback then never resolves, forcing the
    // idle timeout to fire while the dispatch is still "running".
    let capturedDeliver: ((payload: any, info?: any) => Promise<void>) | undefined;
    const dispatch = vi.fn(async (args: any) => {
      capturedDeliver = args.dispatcherOptions.deliver;
      await new Promise<void>(() => {}); // never resolves, never rejects
    });
    setOctoRuntime({
      config: { loadConfig: () => ({}) },
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
    installFetchStub();

    await expect(runInbound({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))
      .rejects.toThrow();

    const idleCallsBefore = setTimeoutSpy.mock.calls.filter((c: any[]) => c[1] === IDLE_WINDOW_MS).length;

    // Simulate the still-running upstream dispatch delivering a late reply.
    expect(capturedDeliver).toBeDefined();
    await capturedDeliver!({ text: "late reply" }, { kind: "final" });

    // No new idle timer was armed by the late deliver...
    const idleCallsAfter = setTimeoutSpy.mock.calls.filter((c: any[]) => c[1] === IDLE_WINDOW_MS).length;
    expect(idleCallsAfter, "late deliver must not arm a new idle timer").toBe(idleCallsBefore);

    // ...and every idle-timer handle ever armed has a matching clearTimeout.
    const idleTimerCalls = setTimeoutSpy.mock.calls
      .map((call: any[], idx: number) => ({ delay: call[1], idx }))
      .filter((x: any) => x.delay === IDLE_WINDOW_MS);
    for (const c of idleTimerCalls) {
      const handle = setTimeoutSpy.mock.results[c.idx]?.value;
      expect(handle).toBeDefined();
      const cleared = clearTimeoutSpy.mock.calls.some((call: any[]) => call[0] === handle);
      expect(cleared, `idle-timer handle from setTimeout call ${c.idx} leaked (not cleared)`).toBe(true);
    }
  });
});
