import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType, MessageType } from "./types.js";
import {
  handleInboundMessage,
  resolveDispatchTimeoutMs,
  _setDispatchTimeoutForTests,
  _setDispatchApologyTimeoutForTests,
} from "./inbound.js";
import { setOctoRuntime } from "./runtime.js";
import { _clearKnownBots } from "./bot-registry.js";
import { resolveOctoAccount } from "./accounts.js";
import type { ResolvedOctoAccount } from "./accounts.js";

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
    config: { loadConfig: () => opts?.config ?? {} },
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

function runInbound(opts: { log?: any } = {}) {
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
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("dispatch hung"))).toBe(true);
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
