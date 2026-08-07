import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType } from "./types.js";
import {
  _resetCardProgressForTests,
  bindCardRun,
  clearCard,
  finalizeCard,
  markCardAnswering,
  recordCardReasoning,
  registerCardProgress,
  setCardContext,
} from "./card-progress.js";
import { DISPLAY_CARD_TOOL_NAME } from "./constants.js";

type Hook = (event: Record<string, unknown>, ctx: { sessionKey: string; runId?: string }) => unknown;

function makeApi(): Record<string, Hook> {
  const handlers: Record<string, Hook> = {};
  registerCardProgress({
    on: (name: string, handler: Hook) => { handlers[name] = handler; },
  } as never);
  return handlers;
}

function template(version: string) {
  return {
    id: "ai.reasoning-process",
    version,
    views: [
      { name: "active", states: ["reasoning", "answering"], wire_profile: "octo/v2", submit_actions: ["reasoning_stop"] },
      { name: "error", states: ["error"], wire_profile: "octo/v2", submit_actions: ["reasoning_retry"] },
      { name: "result", states: ["completed", "stopped"], wire_profile: "octo/v1", submit_actions: [] },
    ],
  };
}

function completionPrompt(childSessionKey: string): string {
  return [
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
    "OpenClaw runtime context (internal):",
    "This context is runtime-generated, not user-authored. Keep internal details private.",
    "",
    "[Internal task completion event]",
    "source: subagent",
    `session_key: ${childSessionKey}`,
    "status: completed",
    "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
  ].join("\n");
}

function profile(opts: {
  reasoningEnabled?: boolean;
  configuredVersion?: string | null;
  catalogVersions?: string[];
} = {}): Record<string, unknown> {
  const reasoningEnabled = opts.reasoningEnabled ?? true;
  const configuredVersion = opts.configuredVersion === undefined ? "0.3.0" : opts.configuredVersion;
  return {
    enabled: true,
    profiles: ["octo/v1", "octo/v2"],
    config: {
      card_enabled: true,
      display_enabled: true,
      interaction_enabled: true,
      reasoning_enabled: reasoningEnabled,
      reasoning_template_ref: reasoningEnabled && configuredVersion !== null
        ? { id: "ai.reasoning-process", version: configuredVersion }
        : null,
    },
    templating: {
      supported: true,
      wire: "template-ref/v1",
      templates: (opts.catalogVersions ?? ["0.3.0"]).map(template),
    },
  };
}

type Call = { url: string; body?: Record<string, unknown>; signal?: AbortSignal };

function mockFetch(opts: {
  profile?: Record<string, unknown>;
  profileResponses?: Array<Record<string, unknown> | Error>;
  sendResponses?: Array<{ status: number; body?: string; messageId?: string }>;
  editResponses?: number[];
} = {}): { fetch: ReturnType<typeof vi.fn>; calls: Call[] } {
  const calls: Call[] = [];
  let profileIndex = 0;
  let sendIndex = 0;
  let editIndex = 0;
  const fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
      ...(init?.signal ? { signal: init.signal } : {}),
    };
    calls.push(call);
    if (call.url.includes("/card/profile")) {
      const response = opts.profileResponses?.[profileIndex++] ?? opts.profile ?? profile();
      if (response instanceof Error) {
        return new Response(response.message, { status: 500 });
      }
      return Response.json(response);
    }
    if (call.url.includes("/sendMessage")) {
      const response = opts.sendResponses?.[sendIndex++] ?? { status: 200, messageId: "card-1" };
      return new Response(
        response.body ?? JSON.stringify({ message_id: response.messageId ?? "card-1" }),
        { status: response.status, statusText: response.status >= 400 ? "Rejected" : "OK" },
      );
    }
    const status = opts.editResponses?.[editIndex++] ?? 200;
    return new Response(status >= 400 ? "temporary" : "", {
      status,
      statusText: status >= 400 ? "Rejected" : "OK",
    });
  });
  return { fetch, calls };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    apiUrl: "https://api.test",
    botToken: "bot-a",
    channelId: "group-1",
    channelType: ChannelType.Group,
    ...overrides,
  } as never;
}

async function triggerFirstFrame(
  handlers: Record<string, Hook>,
  sessionKey: string,
  runId = "run-1",
): Promise<void> {
  const hookContext = { sessionKey, runId };
  handlers.before_agent_run?.({}, hookContext);
  handlers.model_call_started?.({ callId: "model-1" }, hookContext);
  handlers.before_tool_call?.({ toolName: "read", toolCallId: "tool-1" }, hookContext);
  await vi.advanceTimersByTimeAsync(900);
}

describe("server-driven Registry reasoning progress", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    _resetCardProgressForTests();
  });

  afterEach(() => {
    _resetCardProgressForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
    global.fetch = originalFetch;
  });

  it("sends the configured Registry ref, then edits answering and terminal states with monotonic card_seq", async () => {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("lifecycle", context());

    await triggerFirstFrame(handlers, "lifecycle");
    const sent = wire.calls.find((call) => call.url.includes("/sendMessage"))?.body?.payload;
    expect(sent).toMatchObject({
      type: 17,
      template_ref: { id: "ai.reasoning-process", version: "0.3.0" },
      state: "reasoning",
    });
    expect(sent).not.toHaveProperty("card");

    markCardAnswering("lifecycle");
    await vi.advanceTimersByTimeAsync(900);
    await finalizeCard("lifecycle", { success: true });
    const edits = wire.calls.filter((call) => call.url.includes("/message/edit")).map((call) => call.body!);
    expect(edits.map((body) => [body.state, body.card_seq])).toEqual([
      ["answering", 1],
      ["completed", 2],
    ]);
    expect(edits[0]).toHaveProperty("transient", true);
    expect(edits[1]).not.toHaveProperty("transient");
    expect(edits.every((body) => !Object.hasOwn(body, "content_edit"))).toBe(true);
  });

  it("selects the exact configured ref from a multi-version catalog", async () => {
    const wire = mockFetch({
      profile: profile({ configuredVersion: "0.3.0", catalogVersions: ["0.2.0", "0.3.0"] }),
    });
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("exact-ref", context());
    await triggerFirstFrame(handlers, "exact-ref");

    expect(wire.calls.find((call) => call.url.includes("/sendMessage"))?.body?.payload)
      .toHaveProperty("template_ref.version", "0.3.0");
  });

  it("does not send when reasoning is disabled", async () => {
    const wire = mockFetch({ profile: profile({ reasoningEnabled: false }) });
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("disabled", context());
    await triggerFirstFrame(handlers, "disabled");

    expect(wire.calls.some((call) => call.url.includes("/card/profile"))).toBe(true);
    expect(wire.calls.some((call) => call.url.includes("/sendMessage"))).toBe(false);
  });

  /**
   * 卡片完全不发时,这几种成因在现象上一模一样(卡片凭空消失)。#204 之后更严重:模板不可用
   * 曾经退回本地渲染,用户至少看得见进度;现在没有任何输出。所以「服务端关掉了」与「服务端说
   * 开着但模板用不了」必须在日志上可区分 —— 后者是契约不一致,该走 warn 被看见;前者是正常
   * 配置状态,不该刷日志。
   *
   * 两种成因分成两个用例:profile 按 bot 缓存,同一个 botToken 复用同一份缓存,写在一个用例里
   * 第二半会读到第一半的 profile(实测两次都报 reasoning-disabled)。
   */
  it("keeps a server-disabled reasoning card out of the warn log", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wire = mockFetch({ profile: profile({ reasoningEnabled: false }) });
    global.fetch = wire.fetch as typeof fetch;
    setCardContext("reason-disabled", context());
    await triggerFirstFrame(makeApi(), "reason-disabled");

    expect(wire.calls.some((call) => call.url.includes("/sendMessage"))).toBe(false);
    // 正常配置状态,不该刷 warn。
    expect(warnSpy.mock.calls.flat().join("\n")).toBe("");
  });

  it("warns with the reason when the server enables reasoning but its template is unusable", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wire = mockFetch({ profile: profile({ configuredVersion: "9.9.9" }) });
    global.fetch = wire.fetch as typeof fetch;
    setCardContext("reason-incompatible", context());
    await triggerFirstFrame(makeApi(), "reason-incompatible");

    expect(wire.calls.some((call) => call.url.includes("/sendMessage"))).toBe(false);
    const warned = warnSpy.mock.calls.flat().join("\n");
    expect(warned).toContain("progress card skipped");
    expect(warned).toContain("template-incompatible");
  });

  it.each([
    profile({ configuredVersion: null }),
    profile({ configuredVersion: "9.9.9" }),
  ])("fails closed when the configured ref is missing or absent from the catalog", async (serverProfile) => {
    const wire = mockFetch({ profile: serverProfile });
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("invalid-ref", context());
    await triggerFirstFrame(handlers, "invalid-ref");

    expect(wire.calls.some((call) => call.url.includes("/sendMessage"))).toBe(false);
  });

  it("ignores deprecated local cardProgress and reasoningCardTemplateMode values", async () => {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("local-flags", context({
      cardProgress: false,
      reasoningCardTemplateMode: "off",
    }));
    await triggerFirstFrame(handlers, "local-flags");

    const sends = wire.calls.filter((call) => call.url.includes("/sendMessage"));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.body?.payload).toHaveProperty("template_ref.version", "0.3.0");
    expect(sends[0]?.body?.payload).not.toHaveProperty("card");
  });

  it("never retries a rejected Registry first frame as raw Model B", async () => {
    const wire = mockFetch({
      sendResponses: [{ status: 400, body: '{"code":"card_invalid"}' }],
    });
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("no-model-b", context());
    await triggerFirstFrame(handlers, "no-model-b");

    const sends = wire.calls.filter((call) => call.url.includes("/sendMessage"));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.body?.payload).toHaveProperty("template_ref");
    expect(sends[0]?.body?.payload).not.toHaveProperty("card");
  });

  it("does not cache a profile 500 and retries on the next tool event", async () => {
    const wire = mockFetch({ profileResponses: [new Error("down"), profile()] });
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("profile-retry", context());
    await triggerFirstFrame(handlers, "profile-retry");
    expect(wire.calls.filter((call) => call.url.includes("/card/profile"))).toHaveLength(1);
    expect(wire.calls.some((call) => call.url.includes("/sendMessage"))).toBe(false);

    handlers.after_tool_call?.({ toolName: "read", toolCallId: "tool-1" }, { sessionKey: "profile-retry", runId: "run-1" });
    await vi.advanceTimersByTimeAsync(900);
    expect(wire.calls.filter((call) => call.url.includes("/card/profile"))).toHaveLength(2);
    expect(wire.calls.filter((call) => call.url.includes("/sendMessage"))).toHaveLength(1);
  });

  it("retries a transient Registry edit with an identical body and card_seq", async () => {
    const wire = mockFetch({ editResponses: [503, 200] });
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("edit-retry", context());
    await triggerFirstFrame(handlers, "edit-retry");

    markCardAnswering("edit-retry");
    await vi.advanceTimersByTimeAsync(2_000);
    const edits = wire.calls.filter((call) => call.url.includes("/message/edit"));
    expect(edits).toHaveLength(2);
    expect(edits[0]?.body).toEqual(edits[1]?.body);
    expect(edits[0]?.body?.card_seq).toBe(1);
  });

  it("keeps editing an already-sent card to terminal state without rereading policy", async () => {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("terminal-after-off", context());
    await triggerFirstFrame(handlers, "terminal-after-off");

    await finalizeCard("terminal-after-off", { success: true });
    expect(wire.calls.filter((call) => call.url.includes("/card/profile"))).toHaveLength(1);
    expect(wire.calls.find((call) => call.url.includes("/message/edit"))?.body)
      .toMatchObject({ state: "completed", card_seq: 1 });
  });

  it("skips OBO contexts before any profile or send request", async () => {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("obo", context({ onBehalfOf: "grantor" }));
    await triggerFirstFrame(handlers, "obo");
    expect(wire.calls).toEqual([]);
  });

  it("pins the owning run and ignores a late hook from another run", async () => {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("run-owner", context());
    bindCardRun("run-owner", "run-new");
    handlers.before_tool_call?.(
      { toolName: "exec", toolCallId: "old-tool" },
      { sessionKey: "run-owner", runId: "run-old" },
    );
    handlers.before_tool_call?.(
      { toolName: "read", toolCallId: "new-tool" },
      { sessionKey: "run-owner", runId: "run-new" },
    );
    await vi.advanceTimersByTimeAsync(900);

    const data = wire.calls.find((call) => call.url.includes("/sendMessage"))?.body?.payload as {
      data?: { phases?: Array<{ actions?: Array<{ tool?: string }> }> };
    };
    const tools = data.data?.phases?.flatMap((phase) => phase.actions ?? []).map((action) => action.tool);
    expect(tools).toContain("read");
    expect(tools).not.toContain("exec");
    clearCard("run-owner");
  });

  it("waits for an in-flight first send before committing the terminal frame", async () => {
    let resolveSend!: () => void;
    const sendGate = new Promise<void>((resolve) => { resolveSend = resolve; });
    let sendStarted = false;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/card/profile")) {
        return { ok: true, status: 200, json: async () => profile() };
      }
      if (url.includes("/sendMessage")) {
        sendStarted = true;
        await sendGate;
        return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: "card-race" }) };
      }
      return { ok: true, status: 200, text: async () => "" };
    }) as typeof fetch;
    const handlers = makeApi();
    setCardContext("send-race", context());
    const hookContext = { sessionKey: "send-race", runId: "run-1" };
    handlers.before_agent_run?.({}, hookContext);
    handlers.before_tool_call?.({ toolName: "read", toolCallId: "tool-1" }, hookContext);

    vi.advanceTimersByTime(900);
    await vi.waitFor(() => expect(sendStarted).toBe(true));
    const finalized = finalizeCard("send-race", { success: true });
    resolveSend();
    await finalized;

    const calls = vi.mocked(global.fetch).mock.calls;
    const editInit = calls.find(([url]) => String(url).includes("/message/edit"))?.[1] as RequestInit;
    expect(JSON.parse(String(editInit.body))).toMatchObject({
      message_id: "card-race",
      state: "completed",
      card_seq: 1,
    });
  });

  it("releases the old finalize when a replacement aborts its shared profile wait", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let resolveProfile!: (response: Response) => void;
    const profileGate = new Promise<Response>((resolve) => { resolveProfile = resolve; });
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/card/profile")) return profileGate;
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;
    const handlers = makeApi();
    setCardContext("profile-timeout", context());
    const hookContext = { sessionKey: "profile-timeout", runId: "run-1" };
    handlers.before_agent_run?.({}, hookContext);
    handlers.before_tool_call?.({ toolName: "read", toolCallId: "tool-1" }, hookContext);

    vi.advanceTimersByTime(900);
    for (let index = 0; index < 10 && vi.mocked(global.fetch).mock.calls.length === 0; index++) {
      await Promise.resolve();
    }
    expect(vi.mocked(global.fetch)).toHaveBeenCalledOnce();

    let finalized = false;
    const finalizing = finalizeCard("profile-timeout", { success: true }).then(() => {
      finalized = true;
    });
    setCardContext("profile-timeout", context());
    await vi.waitFor(() => expect(finalized).toBe(true));
    expect(vi.mocked(global.fetch).mock.calls.some(([url]) => String(url).includes("/sendMessage")))
      .toBe(false);

    resolveProfile(Response.json(profile()));
    await finalizing;
    for (let index = 0; index < 5; index++) await Promise.resolve();

    const replacementContext = { sessionKey: "profile-timeout", runId: "run-2" };
    handlers.before_agent_run?.({}, replacementContext);
    handlers.before_tool_call?.({ toolName: "read", toolCallId: "tool-2" }, replacementContext);
    await vi.advanceTimersByTimeAsync(900);
    expect(vi.mocked(global.fetch).mock.calls.filter(([url]) => String(url).includes("/card/profile")))
      .toHaveLength(1);
    expect(vi.mocked(global.fetch).mock.calls.filter(([url]) => String(url).includes("/sendMessage")))
      .toHaveLength(1);
  });

  it("fails closed when the same sessionKey is replaced by a different Bot identity", async () => {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("identity-collision", context({ botToken: "bot-a" }));
    setCardContext("identity-collision", context({ botToken: "bot-b" }));

    await triggerFirstFrame(handlers, "identity-collision");
    expect(wire.calls).toEqual([]);
  });

  it("keeps one Registry card across yield and a trusted continuation", async () => {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("continuation", context());
    await triggerFirstFrame(handlers, "continuation", "run-1");
    const firstContext = { sessionKey: "continuation", runId: "run-1" };

    handlers.before_tool_call?.({ toolName: "sessions_spawn", toolCallId: "spawn-1" }, firstContext);
    handlers.after_tool_call?.({
      toolName: "sessions_spawn",
      toolCallId: "spawn-1",
      result: { status: "accepted", childSessionKey: "child-1" },
    }, firstContext);
    handlers.before_tool_call?.({ toolName: "sessions_yield", toolCallId: "yield-1" }, firstContext);
    handlers.after_tool_call?.({ toolName: "sessions_yield", toolCallId: "yield-1" }, firstContext);
    await vi.advanceTimersByTimeAsync(900);
    await finalizeCard("continuation", { success: false });

    setCardContext("continuation", context());
    const secondContext = { sessionKey: "continuation", runId: "run-2" };
    handlers.before_agent_run?.({ prompt: completionPrompt("child-1") }, secondContext);
    await handlers.agent_end?.({ runId: "run-2", success: true }, secondContext);

    const edits = wire.calls
      .filter((call) => call.url.includes("/message/edit"))
      .map((call) => call.body!);
    expect(edits.at(-1)).toMatchObject({ state: "completed" });
    expect(edits.map((body) => body.card_seq)).toEqual(
      edits.map((_body, index) => index + 1),
    );
    expect(wire.calls.filter((call) => call.url.includes("/sendMessage"))).toHaveLength(1);
  });

  it("does not create a reasoning card for a display-card-only turn", async () => {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("display-only", context());
    const hookContext = { sessionKey: "display-only", runId: "run-1" };
    handlers.before_agent_run?.({}, hookContext);
    handlers.model_call_started?.({ callId: "model-1" }, hookContext);
    handlers.before_tool_call?.({ toolName: DISPLAY_CARD_TOOL_NAME, toolCallId: "display-1" }, hookContext);
    handlers.after_tool_call?.({ toolName: DISPLAY_CARD_TOOL_NAME, toolCallId: "display-1" }, hookContext);
    await vi.advanceTimersByTimeAsync(900);
    await finalizeCard("display-only", { success: true });

    expect(wire.calls).toEqual([]);
  });

  it("captures visible reasoning but never captures it when visibility is off", async () => {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("reasoning-on", context({ reasoningVisibility: "on" }));
    const onContext = { sessionKey: "reasoning-on", runId: "run-1" };
    handlers.before_agent_run?.({}, onContext);
    handlers.model_call_started?.({ callId: "model-1" }, onContext);
    recordCardReasoning("reasoning-on", "visible thought", { snapshot: true });
    handlers.before_tool_call?.({ toolName: "read", toolCallId: "tool-1" }, onContext);
    await vi.advanceTimersByTimeAsync(900);
    expect(JSON.stringify(wire.calls.find((call) => call.url.includes("/sendMessage"))?.body))
      .toContain("visible thought");

    clearCard("reasoning-on");
    wire.calls.length = 0;
    setCardContext("reasoning-off", context({ reasoningVisibility: "off" }));
    const offContext = { sessionKey: "reasoning-off", runId: "run-2" };
    handlers.before_agent_run?.({}, offContext);
    handlers.model_call_started?.({ callId: "model-2" }, offContext);
    recordCardReasoning("reasoning-off", "private thought", { snapshot: true });
    handlers.before_tool_call?.({ toolName: "read", toolCallId: "tool-2" }, offContext);
    await vi.advanceTimersByTimeAsync(900);
    expect(JSON.stringify(wire.calls.find((call) => call.url.includes("/sendMessage"))?.body))
      .not.toContain("private thought");
  });
});

describe("progress frames under rate limiting", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    _resetCardProgressForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /**
   * An edit response shaped like the live server's: the rate limiter answers 429 with
   * Retry-After and the X-RateLimit-* trio, and the body carries the same wait again under
   * error.details. Captured from a real octo-server.
   */
  function limited(retryAfterSeconds: number): Response {
    return new Response(
      JSON.stringify({
        error: {
          code: "err.shared.rate.limited",
          details: { retry_after: retryAfterSeconds },
          http_status: 429,
          message: "请求过于频繁，请稍后再试。",
        },
        status: 429,
      }),
      {
        status: 429,
        statusText: "Too Many Requests",
        headers: {
          "Retry-After": String(retryAfterSeconds),
          "X-RateLimit-Limit": "1000",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Scope": "ip",
          "Content-Type": "application/json",
        },
      },
    );
  }

  /** mockFetch, but every edit after the first `okEdits` is rate limited. */
  function rateLimitedWire(opts: { retryAfterSeconds: number; limitFrom?: number }) {
    const calls: { url: string }[] = [];
    let edits = 0;
    const limitFrom = opts.limitFrom ?? 1;
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      const u = String(url);
      calls.push({ url: u });
      if (u.includes("/card/profile")) return Response.json(profile());
      if (u.includes("/sendMessage")) {
        return new Response(JSON.stringify({ message_id: "card-1" }), { status: 200 });
      }
      edits++;
      if (edits >= limitFrom) return limited(opts.retryAfterSeconds);
      return new Response("", { status: 200 });
    });
    return {
      fetch,
      editCount: () => calls.filter((c) => c.url.includes("/message/edit")).length,
      /** Sends and edits both; a profile probe is not a frame. */
      frameCount: () =>
        calls.filter((c) => c.url.includes("/message/edit") || c.url.includes("/sendMessage"))
          .length,
    };
  }

  /** One more tool event through the debounced flush. */
  async function toolEvent(handlers: Record<string, Hook>, sessionKey: string, id: string) {
    const hookContext = { sessionKey, runId: "run-1" };
    handlers.before_tool_call?.({ toolName: "read", toolCallId: id }, hookContext);
    await vi.advanceTimersByTimeAsync(900);
    handlers.after_tool_call?.({ toolName: "read", toolCallId: id, result: {} }, hookContext);
    await vi.advanceTimersByTimeAsync(900);
  }

  it("stops probing for the whole window the server named", async () => {
    // 30s window is far longer than the events below add up to, so the assertion is about
    // the window holding — not about a wake-up that has not come due yet.
    const wire = rateLimitedWire({ retryAfterSeconds: 30 });
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("cool-1", context({ apiUrl: "https://cool1.test" }));

    await triggerFirstFrame(handlers, "cool-1");
    await toolEvent(handlers, "cool-1", "t2"); // first edit → 429, window opens
    const afterLimit = wire.editCount();
    expect(afterLimit).toBeGreaterThan(0);

    await toolEvent(handlers, "cool-1", "t3");
    await toolEvent(handlers, "cool-1", "t4");
    expect(wire.editCount()).toBe(afterLimit);
  });

  // The frame that hit the limit is held, not lost: dirty is cleared before the send, so
  // without the hold it would be the one frame nobody ever retries.
  it("sends the held frame when the window expires, with no further events", async () => {
    const wire = rateLimitedWire({ retryAfterSeconds: 2, limitFrom: 1 });
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("cool-2", context({ apiUrl: "https://cool2.test" }));

    await triggerFirstFrame(handlers, "cool-2");
    await toolEvent(handlers, "cool-2", "t2"); // 429
    const during = wire.editCount();

    await vi.advanceTimersByTimeAsync(3_000); // past the window, no new events at all
    expect(wire.editCount()).toBe(during + 1);
  });

  it("coalesces everything that piled up into a single send at expiry", async () => {
    const wire = rateLimitedWire({ retryAfterSeconds: 30, limitFrom: 1 });
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("cool-3", context({ apiUrl: "https://cool3.test" }));

    await triggerFirstFrame(handlers, "cool-3");
    await toolEvent(handlers, "cool-3", "t2"); // 429
    const during = wire.editCount();
    for (const id of ["t3", "t4", "t5"]) await toolEvent(handlers, "cool-3", id);
    expect(wire.editCount()).toBe(during); // still nothing

    await vi.advanceTimersByTimeAsync(31_000);
    expect(wire.editCount()).toBe(during + 1); // one frame, not three
  });

  // The gate is the only consumer of the server's raw wait, and its blast radius is every
  // session on that backend. A day-long Retry-After must not silence the cards for a day.
  it("caps an absurd cooldown so the cards do not go dark for a day", async () => {
    const wire = rateLimitedWire({ retryAfterSeconds: 86_400, limitFrom: 1 });
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("cool-cap", context({ apiUrl: "https://coolcap.test" }));

    await triggerFirstFrame(handlers, "cool-cap");
    await toolEvent(handlers, "cool-cap", "t2"); // 429 asking for 24h
    const during = wire.editCount();

    await vi.advanceTimersByTimeAsync(6 * 60 * 1000); // past the 5-minute cap
    expect(wire.editCount()).toBe(during + 1);
  });

  it("shares the window across sessions on one backend, trailing slash and all", async () => {
    const wire = rateLimitedWire({ retryAfterSeconds: 30 });
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("cool-5a", context({ apiUrl: "https://cool5.test" }));

    await triggerFirstFrame(handlers, "cool-5a");
    await toolEvent(handlers, "cool-5a", "t2"); // 429 on https://cool5.test

    // Counting frames rather than edits: the window blocks the second session before it ever
    // gets a placeholder out, so an edit-only count would hold at zero whether the window
    // works or not — it would pass for the wrong reason.
    const framesBefore = wire.frameCount();

    // Same backend written with a trailing slash: one bucket on the server, so one here.
    setCardContext("cool-5b", context({ apiUrl: "https://cool5.test/", channelId: "group-2" }));
    await triggerFirstFrame(handlers, "cool-5b", "run-2");
    await toolEvent(handlers, "cool-5b", "s2");
    expect(wire.frameCount()).toBe(framesBefore);
  });

  // The capability probe is the one hot path that does not go through postJson, and it hits
  // the same per-IP bucket. Probing inside an open window is the exact behaviour this change
  // set exists to remove.
  it("records the window when the capability probe itself is rate limited", async () => {
    const calls: string[] = [];
    let probes = 0;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("/card/profile")) {
        probes++;
        return new Response(
          JSON.stringify({ error: { code: "err.shared.rate.limited", details: { retry_after: 30 } } }),
          {
            status: 429,
            statusText: "Too Many Requests",
            headers: { "Retry-After": "30", "X-RateLimit-Scope": "ip", "X-RateLimit-Remaining": "0" },
          },
        );
      }
      return new Response(JSON.stringify({ message_id: "card-1" }), { status: 200 });
    }) as typeof fetch;
    const handlers = makeApi();
    setCardContext("probe-1", context({ apiUrl: "https://probe1.test" }));

    await triggerFirstFrame(handlers, "probe-1"); // cold cache: probe → 429
    expect(probes).toBe(1);

    // Every later event used to probe again, hammering the bucket that just refused us.
    await toolEvent(handlers, "probe-1", "t2");
    await toolEvent(handlers, "probe-1", "t3");
    expect(probes).toBe(1);
  });

  // A window learned by one bot has to apply to the next one immediately, not only after its
  // own probe has already gone out.
  it("keeps a second session from probing inside a window the first one learned", async () => {
    const calls: string[] = [];
    let probes = 0;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("/card/profile")) {
        probes++;
        return new Response(
          JSON.stringify({ error: { code: "err.shared.rate.limited", details: { retry_after: 30 } } }),
          { status: 429, statusText: "Too Many Requests", headers: { "Retry-After": "30" } },
        );
      }
      return new Response(JSON.stringify({ message_id: "card-1" }), { status: 200 });
    }) as typeof fetch;
    const handlers = makeApi();

    setCardContext("probe-2a", context({ apiUrl: "https://probe2.test" }));
    await triggerFirstFrame(handlers, "probe-2a", "run-a"); // records the window
    expect(probes).toBe(1);

    // Same backend, different session: the window is shared, so no second probe.
    setCardContext("probe-2b", context({ apiUrl: "https://probe2.test", channelId: "group-2" }));
    await triggerFirstFrame(handlers, "probe-2b", "run-b");
    expect(probes).toBe(1);
  });

  // The probe failure path must not cancel a wake-up the probe's own 429 just armed —
  // otherwise the held frame waits for an event that may never come.
  it("still delivers the held frame after a rate-limited probe, with no further events", async () => {
    let probes = 0;
    let sends = 0;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes("/card/profile")) {
        probes++;
        if (probes === 1) {
          return new Response(
            JSON.stringify({ error: { code: "err.shared.rate.limited", details: { retry_after: 2 } } }),
            { status: 429, statusText: "Too Many Requests", headers: { "Retry-After": "2" } },
          );
        }
        return Response.json(profile());
      }
      sends++;
      return new Response(JSON.stringify({ message_id: "card-1" }), { status: 200 });
    }) as typeof fetch;
    const handlers = makeApi();
    setCardContext("probe-3", context({ apiUrl: "https://probe3.test" }));

    await triggerFirstFrame(handlers, "probe-3"); // probe → 429, window + wake-up
    expect(sends).toBe(0);

    await vi.advanceTimersByTimeAsync(3_000); // window closes; nothing else happens
    expect(probes).toBe(2); // re-probed once the window was over
    expect(sends).toBe(1); // and the held frame went out
  });

  // Contract: a terminal frame has to land. If the cooldown gate ever grew to cover the
  // terminal edit, a rate-limited card would freeze on "working" forever — and nothing else
  // in the suite would go red.
  it("lets a finalize frame through inside the window", async () => {
    const wire = rateLimitedWire({ retryAfterSeconds: 30, limitFrom: 1 });
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("cool-6", context({ apiUrl: "https://cool6.test" }));

    await triggerFirstFrame(handlers, "cool-6");
    await toolEvent(handlers, "cool-6", "t2"); // 429 opens a 30s window
    const during = wire.frameCount();

    await finalizeCard("cool-6");
    expect(wire.frameCount()).toBeGreaterThan(during);
  });

  // Contract 6 (the deadline only ever moves later) has no honest test at this level, and
  // saying so is more useful than a test that passes for the wrong reason.
  //
  // A shorter wait can only shorten an open window if two flushes both clear the gate before
  // either records its 429. Trying to arrange that showed the gate is tighter than assumed:
  // the second flush is already blocked by the first one's window, so only one 429 ever
  // lands. Faking the race would mean reaching into module state that is deliberately
  // private. The Math.max in noteRateLimited stays as defence against a future caller that
  // does record concurrently — reviewed by reading, not by test.

  // Contract: 429 is transient. The fail-closed branch that disables a session on a
  // deterministic 4xx carves it out, so frames resume once the window closes.
  it("keeps the card enabled — a 429 is not a permanent rejection", async () => {
    const wire = rateLimitedWire({ retryAfterSeconds: 2, limitFrom: 1 });
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("cool-7", context({ apiUrl: "https://cool7.test" }));

    await triggerFirstFrame(handlers, "cool-7");
    await toolEvent(handlers, "cool-7", "t2"); // 429
    const during = wire.frameCount();

    await vi.advanceTimersByTimeAsync(3_000);
    await toolEvent(handlers, "cool-7", "t3");
    // A 4xx that meant "stop" would have skipped the session for good.
    expect(wire.frameCount()).toBeGreaterThan(during);
  });

  // The two production call sites pass retryOn429: false, but a frame-count assertion here
  // cannot see it: postJson's retries happen inside the flush, and under a clock that is not
  // being advanced the extra attempts never fire, so the count is identical either way.
  // Mutating the opt-out away leaves this whole block green — which is why the property is
  // pinned where it is observable instead: api-fetch.test.ts asserts one request per
  // rate-limited call for each of the four card wrappers.

  // The stale guard already blocks a replaced entry from sending, so a send-count assertion
  // cannot tell "timer cancelled" from "timer fired and was turned away". The leak itself is
  // what needs asserting.
  it("cancels the cooldown wake-up when the entry is replaced", async () => {
    const wire = rateLimitedWire({ retryAfterSeconds: 30, limitFrom: 1 });
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("cool-8", context({ apiUrl: "https://cool8.test" }));

    await triggerFirstFrame(handlers, "cool-8");
    await toolEvent(handlers, "cool-8", "t2"); // 429 → window + wake-up armed
    const armed = vi.getTimerCount();

    setCardContext("cool-8", context({ apiUrl: "https://cool8.test" })); // next run replaces it
    expect(vi.getTimerCount()).toBeLessThan(armed);
  });

  it("cancels the cooldown wake-up when the card is finalized", async () => {
    const wire = rateLimitedWire({ retryAfterSeconds: 30, limitFrom: 1 });
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("cool-9", context({ apiUrl: "https://cool9.test" }));

    await triggerFirstFrame(handlers, "cool-9");
    await toolEvent(handlers, "cool-9", "t2"); // 429
    const armed = vi.getTimerCount();

    await finalizeCard("cool-9");
    expect(vi.getTimerCount()).toBeLessThan(armed);
  });

  it("cancels the cooldown wake-up when the card is cleared", async () => {
    const wire = rateLimitedWire({ retryAfterSeconds: 30, limitFrom: 1 });
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("cool-10", context({ apiUrl: "https://cool10.test" }));

    await triggerFirstFrame(handlers, "cool-10");
    await toolEvent(handlers, "cool-10", "t2"); // 429
    const armed = vi.getTimerCount();

    clearCard("cool-10");
    expect(vi.getTimerCount()).toBeLessThan(armed);
  });
});
