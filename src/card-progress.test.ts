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

  /** Fetch stub whose /message/edit answers 429 for the first `limitedEdits` calls. */
  function makeRateLimitedApi(opts: { retryAfter?: string; limitedEdits?: number } = {}) {
    const retryAfter = opts.retryAfter ?? "5";
    const limitedEdits = opts.limitedEdits ?? Number.POSITIVE_INFINITY;
    const edits: string[] = [];
    let editCalls = 0;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/card/profile")) {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ enabled: true }) };
      }
      if (u.includes("/sendMessage")) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ message_id: "card-1" }),
        };
      }
      if (u.includes("/message/edit")) {
        editCalls++;
        if (editCalls <= limitedEdits) {
          return {
            ok: false,
            status: 429,
            statusText: "too many",
            headers: {
              get: (n: string) => (n.toLowerCase() === "retry-after" ? retryAfter : null),
            },
            text: async () => "rate limited",
          };
        }
        edits.push(String(init?.body ?? ""));
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => "" };
      }
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => "" };
    }) as unknown as typeof fetch;
    return {
      editCount: () => editCalls,
      acceptedEdits: () => edits,
    };
  }

  /** Drive one tool event through the debounced flush. */
  async function toolEvent(
    handlers: Record<string, (e: unknown, c: unknown) => unknown>,
    sessionKey: string,
    id: string,
  ) {
    handlers.before_tool_call!({ toolName: "read", toolCallId: id }, { sessionKey });
    await vi.advanceTimersByTimeAsync(900);
    handlers.after_tool_call!({ toolName: "read", toolCallId: id, result: {} }, { sessionKey });
    await vi.advanceTimersByTimeAsync(900);
  }

  it("stops probing for the whole window the server named", async () => {
    // 30s 窗口远长于后面四个事件合计的 7.2s,断言的是"窗口内一次都不发"。
    const api = makeRateLimitedApi({ retryAfter: "30" });
    const { handlers } = makeApi();
    setCardContext("cool-1", {
      apiUrl: "https://cool1.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
    });

    await toolEvent(handlers, "cool-1", "t1"); // sends the placeholder
    await toolEvent(handlers, "cool-1", "t2"); // first edit → 429, arms the cooldown
    const afterFirst429 = api.editCount();
    expect(afterFirst429).toBeGreaterThan(0);

    // Keep the events coming well inside the 5s window: not one of them may reach the wire.
    await toolEvent(handlers, "cool-1", "t3");
    await toolEvent(handlers, "cool-1", "t4");
    expect(api.editCount()).toBe(afterFirst429);
  });

  // The frame that hit the limit is held, not lost: dirty was already cleared before the
  // send, so without the hold it would be the one frame nobody ever retries.
  it("sends the held frame when the window expires, with no further events", async () => {
    const api = makeRateLimitedApi({ retryAfter: "2", limitedEdits: 1 });
    const { handlers } = makeApi();
    setCardContext("cool-2", {
      apiUrl: "https://cool2.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
    });

    await toolEvent(handlers, "cool-2", "t1");
    await toolEvent(handlers, "cool-2", "t2"); // 429
    const during = api.editCount();

    await vi.advanceTimersByTimeAsync(2_500); // past the window, no new events at all
    expect(api.editCount()).toBe(during + 1);
    expect(api.acceptedEdits()).toHaveLength(1);
  });

  it("coalesces everything that piled up into a single send at expiry", async () => {
    const api = makeRateLimitedApi({ retryAfter: "30", limitedEdits: 1 });
    const { handlers } = makeApi();
    setCardContext("cool-3", {
      apiUrl: "https://cool3.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
    });

    await toolEvent(handlers, "cool-3", "t1");
    await toolEvent(handlers, "cool-3", "t2"); // 429
    const during = api.editCount();
    for (const id of ["t3", "t4", "t5"]) await toolEvent(handlers, "cool-3", id);
    expect(api.editCount()).toBe(during); // still nothing

    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.editCount()).toBe(during + 1); // one frame, not three
  });

  // A later 429 carrying a shorter wait must not pull the deadline back in.
  it("does not shorten an open window with a smaller retry_after", async () => {
    let retryAfter = "6";
    const edits: number[] = [];
    let editCalls = 0;
    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/card/profile")) {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ enabled: true }) };
      }
      if (u.includes("/sendMessage")) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ message_id: "card-1" }),
        };
      }
      if (u.includes("/message/edit")) {
        editCalls++;
        edits.push(Date.now());
        return {
          ok: false,
          status: 429,
          statusText: "too many",
          headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? retryAfter : null) },
          text: async () => "rate limited",
        };
      }
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => "" };
    }) as unknown as typeof fetch;

    const { handlers } = makeApi();
    setCardContext("cool-4", {
      apiUrl: "https://cool4.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
    });
    await toolEvent(handlers, "cool-4", "t1");
    await toolEvent(handlers, "cool-4", "t2"); // 429 with retry_after 6 → window opens
    const after6 = editCalls;

    // A second bot on the same backend gets a 1s wait; the 6s window must survive it.
    retryAfter = "1";
    setCardContext("cool-4b", {
      apiUrl: "https://cool4.test",
      botToken: "bf",
      channelId: "g2",
      channelType: ChannelType.Group,
    });
    await toolEvent(handlers, "cool-4b", "s1");

    await vi.advanceTimersByTimeAsync(2_000); // past 1s, nowhere near 6s
    expect(editCalls).toBe(after6);
  });

  it("shares the window across sessions on one backend, trailing slash and all", async () => {
    const api = makeRateLimitedApi({ retryAfter: "30" });
    const { handlers } = makeApi();
    setCardContext("cool-5a", {
      apiUrl: "https://cool5.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
    });
    await toolEvent(handlers, "cool-5a", "t1");
    await toolEvent(handlers, "cool-5a", "t2"); // 429 on https://cool5.test
    const during = api.editCount();

    // Same backend written with a trailing slash: it is one bucket on the server, so it
    // has to be one bucket here too.
    setCardContext("cool-5b", {
      apiUrl: "https://cool5.test/",
      botToken: "bf",
      channelId: "g2",
      channelType: ChannelType.Group,
    });
    await toolEvent(handlers, "cool-5b", "s1");
    await toolEvent(handlers, "cool-5b", "s2");
    expect(api.editCount()).toBe(during);
  });

  it("lets a finalize frame through inside the window", async () => {
    const api = makeRateLimitedApi({ retryAfter: "30", limitedEdits: 1 });
    const { handlers } = makeApi();
    setCardContext("cool-6", {
      apiUrl: "https://cool6.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
    });
    await toolEvent(handlers, "cool-6", "t1");
    await toolEvent(handlers, "cool-6", "t2"); // 429
    const during = api.editCount();

    // Terminal state has to land; it is not a discardable intermediate frame.
    await finalizeCard("cool-6");
    expect(api.editCount()).toBeGreaterThan(during);
  });

  it("keeps the card enabled — a 429 is not a permanent rejection", async () => {
    const api = makeRateLimitedApi({ retryAfter: "1", limitedEdits: 1 });
    const { handlers } = makeApi();
    setCardContext("cool-7", {
      apiUrl: "https://cool7.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
    });
    await toolEvent(handlers, "cool-7", "t1");
    await toolEvent(handlers, "cool-7", "t2"); // 429
    await vi.advanceTimersByTimeAsync(1_500);
    await toolEvent(handlers, "cool-7", "t3");
    // Frames resume once the window closes; a 4xx that meant "stop" would have skipped
    // the session for good.
    expect(api.acceptedEdits().length).toBeGreaterThan(0);
  });
});

