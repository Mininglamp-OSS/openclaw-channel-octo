import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the runtime + octo Bot API so we can drive dispatchForkSeedReply's deliver
// state machine and assert the fork-trigger invariant (SessionKey comes from the
// CHILD route, not the seed ctx) without a live runtime.
const { mockResolveAgentRoute, mockFinalize, mockDispatch, mockSendMessage, mockTimeout } = vi.hoisted(() => ({
  mockTimeout: vi.fn(() => 600_000),
  mockResolveAgentRoute: vi.fn(),
  mockFinalize: vi.fn((ctx: unknown) => ctx),
  mockDispatch: vi.fn(),
  mockSendMessage: vi.fn(async () => ({})),
}));

vi.mock("../runtime.js", () => ({
  getOctoRuntime: () => ({
    agent: { resolveAgentTimeoutMs: mockTimeout },
    channel: {
      routing: { resolveAgentRoute: mockResolveAgentRoute },
      reply: {
        finalizeInboundContext: mockFinalize,
        dispatchReplyWithBufferedBlockDispatcher: mockDispatch,
      },
    },
  }),
}));
vi.mock("../api-fetch.js", () => ({
  sendMessage: mockSendMessage,
  createThread: vi.fn(),
}));

import { dispatchForkSeedReply } from "./fork-inbound.js";
import { _setDispatchTimeoutForTests } from "../inbound.js";
import type { ForkSeedContext } from "./fork-runtime.js";

function makeSeedCtx(overrides: Partial<ForkSeedContext> = {}): ForkSeedContext {
  return {
    Body: "explain the bug",
    BodyForAgent: "explain the bug",
    RawBody: "explain the bug",
    CommandBody: "explain the bug",
    BodyForCommands: "explain the bug",
    CommandAuthorized: true,
    From: "octo:user_hash",
    To: "octo:group123____abc",
    ParentSessionKey: "octo:acct1:group123",
    ModelParentSessionKey: "octo:acct1:group123",
    AccountId: "acct1",
    ChatType: "group",
    ConversationLabel: "group:group123____abc",
    SenderId: "user_hash",
    SenderName: "刘建辉",
    SenderUsername: "user_hash",
    WasMentioned: false,
    MessageSid: "fork-seed:group123____abc",
    Timestamp: 0,
    GroupSubject: "group123____abc",
    Provider: "octo",
    Surface: "octo",
    OriginatingChannel: "octo",
    OriginatingTo: "octo:group123____abc",
    ...overrides,
  };
}

type DeliverCall = { text?: string; isReasoning?: boolean; kind: string };

/** Configure the dispatcher mock to replay a script of deliver() calls. */
function driveDeliver(calls: DeliverCall[], opts: { throwAfter?: boolean } = {}) {
  mockDispatch.mockImplementation(async (o: any) => {
    for (const c of calls) {
      await o.dispatcherOptions.deliver({ text: c.text, isReasoning: c.isReasoning }, { kind: c.kind });
    }
    if (opts.throwAfter) throw new Error("dispatch boom");
  });
}

const run = (seedOverrides: Partial<ForkSeedContext> = {}) =>
  dispatchForkSeedReply({
    seedCtx: makeSeedCtx(seedOverrides),
    childChannelId: "group123____abc",
    accountId: "acct1",
    account: { config: {} } as never,
    apiUrl: "https://api.test",
    botToken: "bf_tok",
    config: {} as never,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  });

describe("dispatchForkSeedReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTimeout.mockReturnValue(600_000);
    mockResolveAgentRoute.mockReturnValue({ sessionKey: "octo:acct1:group123____abc", accountId: "acct1" });
    mockFinalize.mockImplementation((ctx: unknown) => ctx);
    mockDispatch.mockResolvedValue(undefined);
    mockSendMessage.mockImplementation(async () => ({}));
  });

  afterEach(() => {
    _setDispatchTimeoutForTests(null); // reset any per-test timeout override
  });

  it("resolves the CHILD route by childChannelId", async () => {
    await run();
    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({ peer: { kind: "group", id: "group123____abc" } }),
    );
  });

  it("FORK-TRIGGER INVARIANT: SessionKey comes from the child route, not the seed ctx", async () => {
    await run();
    const ctx = mockFinalize.mock.calls[0][0] as ForkSeedContext & { SessionKey: string };
    // SessionKey is the child route's key — NOT copied from any seed field.
    expect(ctx.SessionKey).toBe("octo:acct1:group123____abc");
    // ParentSessionKey is preserved from the seed.
    expect(ctx.ParentSessionKey).toBe("octo:acct1:group123");
    // The hard invariant that makes get-reply fork (and never pollute the parent).
    expect(ctx.ParentSessionKey).not.toBe(ctx.SessionKey);
  });

  it("stamps AccountId from the child route", async () => {
    mockResolveAgentRoute.mockReturnValue({ sessionKey: "child-key", accountId: "acctX" });
    await run();
    const ctx = mockFinalize.mock.calls[0][0] as ForkSeedContext;
    expect(ctx.AccountId).toBe("acctX");
  });

  it("ISOLATION GUARD (fail-closed): SessionKey === ParentSessionKey → throws, does NOT dispatch", async () => {
    // Child route resolves to the SAME key as the seed's ParentSessionKey →
    // auto-fork would not trigger and the seed would run ON the parent session.
    // Upgraded from warn-and-continue to fail-closed: refuse to dispatch.
    mockResolveAgentRoute.mockReturnValue({ sessionKey: "octo:acct1:group123", accountId: "acct1" });
    const warn = vi.fn();
    await expect(
      dispatchForkSeedReply({
        seedCtx: makeSeedCtx(), // ParentSessionKey = "octo:acct1:group123"
        childChannelId: "group123____abc",
        accountId: "acct1",
        account: { config: {} } as never,
        apiUrl: "https://api.test",
        botToken: "bf_tok",
        config: {} as never,
        log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never,
      }),
    ).rejects.toThrow(/isolation guard/i);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("isolation guard");
    // fail-closed core assertion: neither finalize nor dispatch must run.
    expect(mockFinalize).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("does NOT warn when SessionKey differs from ParentSessionKey (normal fork)", async () => {
    // beforeEach default child key "octo:acct1:group123____abc" ≠ parent key.
    const warn = vi.fn();
    await dispatchForkSeedReply({
      seedCtx: makeSeedCtx(),
      childChannelId: "group123____abc",
      accountId: "acct1",
      account: { config: {} } as never,
      apiUrl: "https://api.test",
      botToken: "bf_tok",
      config: {} as never,
      log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("final kind → sends once into the child thread (CommunityTopic)", async () => {
    driveDeliver([{ kind: "final", text: "here is the answer" }]);
    await run();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "group123____abc",
        channelType: 5, // ChannelType.CommunityTopic
        content: "here is the answer",
      }),
    );
  });

  it("tool kind → also sends immediately", async () => {
    driveDeliver([{ kind: "tool", text: "tool output" }]);
    await run();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: "tool output" }));
  });

  it("block-only → buffered, flushed once after the dispatcher settles", async () => {
    driveDeliver([{ kind: "block", text: "buffered block" }]);
    await run();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: "buffered block" }));
  });

  it("reasoning / empty payloads are ignored", async () => {
    driveDeliver([
      { kind: "block", isReasoning: true, text: "thinking..." },
      { kind: "final", text: "   " },
    ]);
    await run();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("final then a trailing block → only the final is sent (state machine)", async () => {
    driveDeliver([
      { kind: "final", text: "the answer" },
      { kind: "block", text: "late stray block" },
    ]);
    await run();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: "the answer" }));
  });

  it("dispatch throws after a buffered block → finally still flushes, then rejects", async () => {
    driveDeliver([{ kind: "block", text: "partial work" }], { throwAfter: true });
    await expect(run()).rejects.toThrow("dispatch boom");
    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: "partial work" }));
  });

  it("resolves the bot's @[uid:name] output into mention entities", async () => {
    driveDeliver([{ kind: "final", text: "ping @[u1:Alice] done" }]);
    await run();
    const arg = mockSendMessage.mock.calls[0][0] as { content: string; mentionEntities?: unknown[] };
    expect(arg.mentionEntities && arg.mentionEntities.length).toBeGreaterThan(0);
  });

  it.each([172_800_000, 0])("fork seed follows the host budget %i beyond the old 11-minute limit", async budget => {
    vi.useFakeTimers();
    mockTimeout.mockReturnValue(budget);
    let release!: () => void;
    mockDispatch.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    try {
      const running = run();
      await vi.advanceTimersByTimeAsync(720_000);
      expect(mockTimeout).toHaveBeenCalledWith({ cfg: {} });
      release();
      await running;
    } finally { vi.useRealTimers(); }
  });

  it("TIMEOUT GUARD (issue #75): a hung dispatcher times out and rejects, never hangs forever", async () => {
    mockTimeout.mockReturnValue(600_000);
    mockDispatch.mockImplementation(() => new Promise<void>(() => {})); // never settles
    const warn = vi.fn();
    await expect(
      dispatchForkSeedReply({
        seedCtx: makeSeedCtx(),
        childChannelId: "group123____abc",
        accountId: "acct1",
        account: { config: { dispatchTimeoutMs: 50 } } as never,
        apiUrl: "https://api.test",
        botToken: "bf_tok",
        config: {} as never,
        log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never,
      }),
    ).rejects.toThrow(/timed out/i);
    // The timeout rethrow is what lets spawnChildBoundSession surface seedFailed
    // and the parent enqueueInbound queue advance instead of locking forever.
    expect(warn.mock.calls.some((c) => String(c[0]).includes("hung past"))).toBe(true);
  });

  it("normal dispatch resolves well within the timeout (guard does not fire)", async () => {
    _setDispatchTimeoutForTests(10_000);
    driveDeliver([{ kind: "final", text: "quick answer" }]);
    const warn = vi.fn();
    await dispatchForkSeedReply({
      seedCtx: makeSeedCtx(),
      childChannelId: "group123____abc",
      accountId: "acct1",
      account: { config: {} } as never,
      apiUrl: "https://api.test",
      botToken: "bf_tok",
      config: {} as never,
      log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never,
    });
    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: "quick answer" }));
    expect(warn.mock.calls.some((c) => String(c[0]).includes("hung past"))).toBe(false);
  });

  it("finally flush failure does NOT mask the original dispatch error", async () => {
    driveDeliver([{ kind: "block", text: "partial" }], { throwAfter: true });
    // The single sendMessage call is the finally flush; make it throw too.
    mockSendMessage.mockImplementationOnce(async () => {
      throw new Error("flush boom");
    });
    const error = vi.fn();
    await expect(
      dispatchForkSeedReply({
        seedCtx: makeSeedCtx(),
        childChannelId: "group123____abc",
        accountId: "acct1",
        account: { config: {} } as never,
        apiUrl: "https://api.test",
        botToken: "bf_tok",
        config: {} as never,
        log: { info: vi.fn(), warn: vi.fn(), error, debug: vi.fn() } as never,
      }),
    ).rejects.toThrow("dispatch boom"); // original error wins, NOT "flush boom"
    expect(error.mock.calls.some((c) => String(c[0]).includes("finally flush failed"))).toBe(true);
  });

  it("DELIVERY FAILURE: a final send error → throws (→ seedFailed → ok_seed_failed)", async () => {
    // deliver() for a final block tries to send; the send throws. The SDK does
    // not reject the outer promise for this, so without tracking it the fork
    // would falsely report success. We track it and throw after settle.
    driveDeliver([{ kind: "final", text: "the answer" }]);
    mockSendMessage.mockImplementationOnce(async () => {
      throw new Error("octo 500");
    });
    await expect(run()).rejects.toThrow(/delivery failed/i);
  });

  it("DELIVERY FAILURE: onError(final) → throws even though the dispatcher resolved", async () => {
    mockDispatch.mockImplementation(async (o: any) => {
      // dispatcher resolves normally; the failure surfaces only via onError.
      await o.dispatcherOptions.onError(new Error("upstream boom"), { kind: "final" });
    });
    await expect(run()).rejects.toThrow(/delivery failed/i);
  });

  it("onError(block) does NOT fail the seed (only final/tool are user-facing)", async () => {
    mockDispatch.mockImplementation(async (o: any) => {
      await o.dispatcherOptions.onError(new Error("block hiccup"), { kind: "block" });
    });
    await expect(run()).resolves.toBeUndefined();
  });
});
