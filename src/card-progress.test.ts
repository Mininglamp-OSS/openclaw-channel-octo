import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocTaskTracker, registerDocTaskProgress, type DocTaskProgress } from "./doc-task-progress.js";
import { ChannelType } from "./types.js";
import { registerDocTaskToolPolicy } from "./doc-task-tool-policy.js";
import {
  _resetCardProgressForTests,
  bindCardRun,
  clearCard,
  finalizeCard,
  markCardAnswering,
  createCardFinalizer,
  createCardReasoningRecorder,
  recordCardReasoning,
  registerCardProgress,
  setCardContext,
} from "./card-progress.js";
import { DISPLAY_CARD_TOOL_NAME, INTERACTIVE_CARD_TOOL_NAME } from "./constants.js";

type Hook = (event: Record<string, unknown>, ctx: { sessionKey: string; runId?: string; inputProvenance?: unknown }) => unknown;

function makeApi(lifecycle = false): Record<string, Hook> {
  const handlers: Record<string, Hook> = {};
  registerCardProgress({
    on: (name: string, handler: Hook) => { handlers[name] = handler; },
    ...(lifecycle ? { agent: { events: { registerAgentEventSubscription: (subscription: { id: string; handle: Hook }) => {
      handlers[subscription.id] = subscription.handle;
    } } } } : {}),
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
  maxPayloadBytes?: number;
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
    ...(opts.maxPayloadBytes === undefined ? {} : {
      limits: { max_payload_bytes: opts.maxPayloadBytes },
    }),
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

  it("keeps the actual Registry send and edit envelopes within the advertised UTF-8 byte limit", async () => {
    const maxPayloadBytes = 16_384;
    const wire = mockFetch({
      profile: profile({
        configuredVersion: "0.4.0",
        catalogVersions: ["0.4.0"],
        maxPayloadBytes,
      }),
    });
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    const sessionKey = "payload-limit";
    const hookContext = { sessionKey, runId: "run-1" };
    setCardContext(sessionKey, context({ reasoningVisibility: "on" }));
    handlers.before_agent_run?.({}, hookContext);

    for (let index = 0; index < 6; index++) {
      handlers.model_call_started?.({ callId: `model-${index}` }, hookContext);
      recordCardReasoning(sessionKey, "界".repeat(4_000), { snapshot: true });
      handlers.before_tool_call?.({ toolName: "read", toolCallId: `tool-${index}` }, hookContext);
    }
    await vi.advanceTimersByTimeAsync(900);

    const sent = wire.calls.find((call) => call.url.includes("/sendMessage"))?.body?.payload;
    expect(sent).toBeDefined();
    expect(new TextEncoder().encode(JSON.stringify(sent)).byteLength)
      .toBeLessThanOrEqual(maxPayloadBytes);

    handlers.model_call_started?.({ callId: "model-edit" }, hookContext);
    recordCardReasoning(sessionKey, "界".repeat(4_000), { snapshot: true });
    handlers.before_tool_call?.({ toolName: "read", toolCallId: "tool-edit" }, hookContext);
    await vi.advanceTimersByTimeAsync(900);

    const edit = wire.calls.find((call) => call.url.includes("/message/edit"))?.body;
    expect(edit).toBeDefined();
    const {
      message_id: _messageId,
      channel_id: _channelId,
      channel_type: _channelType,
      ...editedEnvelope
    } = edit!;
    expect(editedEnvelope).toHaveProperty("card_seq");
    expect(editedEnvelope).toHaveProperty("transient", true);
    expect(new TextEncoder().encode(JSON.stringify(editedEnvelope)).byteLength)
      .toBeLessThanOrEqual(maxPayloadBytes);
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

  it("warns when an available profile carries no config at all", async () => {
    // config 在类型上可选。`available: true` 却没有 config 是契约不一致,不是「配置如此」——
    // 混进 reasoning-disabled 会又造出一个静默消失的场景。
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { config: _dropped, ...withoutConfig } = profile() as Record<string, unknown>;
    const wire = mockFetch({ profile: withoutConfig });
    global.fetch = wire.fetch as typeof fetch;
    setCardContext("no-config", context({ botToken: "bot-no-config" }));
    await triggerFirstFrame(makeApi(), "no-config");

    expect(wire.calls.some((call) => call.url.includes("/sendMessage"))).toBe(false);
    expect(warnSpy.mock.calls.flat().join("\n")).toContain("config-missing");
  });

  it("warns once per bot for a persistent template mismatch, not once per turn", async () => {
    // profile 按 bot 缓存,日志不缓存的话,持续广告不兼容模板的服务端会在每个产卡 turn 上 warn。
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wire = mockFetch({ profile: profile({ configuredVersion: "9.9.9" }) });
    global.fetch = wire.fetch as typeof fetch;
    for (const key of ["dup-1", "dup-2", "dup-3"]) {
      setCardContext(key, context({ botToken: "bot-dup" }));
      await triggerFirstFrame(makeApi(), key);
    }
    const hits = warnSpy.mock.calls.flat().filter((line) =>
      String(line).includes("template-incompatible")).length;
    expect(hits).toBe(1);
  });

  it("warns again after the dedup window, so a recurrence is not silent", async () => {
    // 「warn 过一次就永远不再说」意味着修好之后再次损坏时是静默的 —— 而这条信号的全部意义
    // 就是「卡片为什么没有」的唯一线索。
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hits = (): number => warnSpy.mock.calls.flat()
      .filter((line) => String(line).includes("template-incompatible")).length;
    const wire = mockFetch({ profile: profile({ configuredVersion: "9.9.9" }) });
    global.fetch = wire.fetch as typeof fetch;

    setCardContext("ttl-1", context({ botToken: "bot-ttl" }));
    await triggerFirstFrame(makeApi(), "ttl-1");
    expect(hits()).toBe(1);

    setCardContext("ttl-2", context({ botToken: "bot-ttl" }));
    await triggerFirstFrame(makeApi(), "ttl-2");
    expect(hits()).toBe(1); // 窗口内不重复

    await vi.advanceTimersByTimeAsync(61_000);
    setCardContext("ttl-3", context({ botToken: "bot-ttl" }));
    await triggerFirstFrame(makeApi(), "ttl-3");
    expect(hits()).toBe(2); // 窗口过后再次可见
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

  it.each([
    ["legacy prompt", false], ["legacy prompt", true],
    ["subagent_announce", false], ["subagent_announce", true], ["subagent_settle", true],
  ] as const)("keeps one Registry card across acknowledgment, yield and a trusted continuation: %s (lifecycle: %s)", async (source, lifecycle) => {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi(lifecycle);
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
    // The host delivers a waiting acknowledgment after yielding. It is not a
    // completed answer and must not undo the pause before dispatch finalizes.
    markCardAnswering("continuation");
    await vi.advanceTimersByTimeAsync(900);
    await finalizeCard("continuation", { success: true });
    const waitingEdits = wire.calls.filter((call) => call.url.includes("/message/edit"));
    expect(waitingEdits.at(-1)?.body).toMatchObject({ state: "reasoning" });
    expect(waitingEdits.at(-1)?.body?.transient).not.toBe(true);
    expect(waitingEdits.some((call) => call.body?.state === "completed")).toBe(false);

    setCardContext("continuation", context());
    const secondContext = {
      sessionKey: "continuation", runId: "run-2",
      ...(source !== "legacy prompt" ? { inputProvenance: {
        kind: "inter_session", sourceTool: source, sourceSessionKey: "child-1",
      } } : {}),
    };
    handlers.before_agent_run?.({ prompt: source === "legacy prompt" ? completionPrompt("child-1") : "A runtime event arrived." }, secondContext);
    if (lifecycle) {
      await handlers["octo-card-progress-lifecycle"]?.({ ...secondContext, stream: "lifecycle", data: { phase: "end" } }, secondContext);
    } else {
      await handlers.agent_end?.({ runId: "run-2", success: true }, secondContext);
    }

    const edits = wire.calls
      .filter((call) => call.url.includes("/message/edit"))
      .map((call) => call.body!);
    expect(edits.at(-1)).toMatchObject({ state: "completed" });
    expect(edits.map((body) => body.card_seq)).toEqual(
      edits.map((_body, index) => index + 1),
    );
    expect(wire.calls.filter((call) => call.url.includes("/sendMessage"))).toHaveLength(1);
  });

  it.each([false, true])("keeps the original card through two consecutive spawn/yield cycles (lifecycle: %s)", async lifecycle => {
    const wire = mockFetch(); global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi(lifecycle);
    setCardContext("repeat-yield", context());
    await triggerFirstFrame(handlers, "repeat-yield", "r1");
    for (let n = 1; n <= 2; n++) {
      const ctx = { sessionKey: "repeat-yield", runId: `r${n}` };
      handlers.after_tool_call?.({ toolName: "sessions_spawn", result: { details: { status: "accepted", childSessionKey: `child${n}` } } }, ctx);
      handlers.after_tool_call?.({ toolName: "sessions_yield", result: { details: { status: "yielded" } } }, ctx);
      markCardAnswering(ctx.sessionKey);
      await finalizeCard(ctx.sessionKey, { success: true });
      await handlers.agent_end?.({ success: true }, ctx);
      expect(wire.calls.some(c => c.body?.state === "completed")).toBe(false);
      setCardContext(ctx.sessionKey, context());
      handlers.before_agent_run?.({ prompt: "Runtime event" }, { sessionKey: ctx.sessionKey, runId: `r${n+1}`, inputProvenance: {
        kind: "inter_session", sourceTool: "subagent_settle", sourceSessionKey: `child${n}`,
      } });
    }
    const ctx = { sessionKey: "repeat-yield", runId: "r3" };
    if (lifecycle) await handlers["octo-card-progress-lifecycle"]?.({ ...ctx, stream: "lifecycle", data: { phase: "end" } }, ctx);
    else await handlers.agent_end?.({ success: true }, ctx);
    expect(wire.calls.filter(c => c.url.includes("/sendMessage"))).toHaveLength(1);
    expect(wire.calls.filter(c => c.url.includes("/message/edit")).at(-1)?.body?.state).toBe("completed");
  });

  it.each(["on", "off"] as const)("continuation uses current reasoning visibility and rejects previous generation callbacks: %s", async reasoningVisibility => {
    const wire = mockFetch(); global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi(); const sk = "reasoning-generation";
    setCardContext(sk, { ...context(), reasoningVisibility: "on" });
    const oldRecorder = createCardReasoningRecorder(sk);
    await triggerFirstFrame(handlers, sk, "r1");
    handlers.after_tool_call?.({ toolName: "sessions_spawn", result: { status: "accepted", childSessionKey: "child" } }, { sessionKey: sk, runId: "r1" });
    handlers.after_tool_call?.({ toolName: "sessions_yield" }, { sessionKey: sk, runId: "r1" });
    await finalizeCard(sk, { success: true });
    setCardContext(sk, { ...context(), reasoningVisibility });
    const currentRecorder = createCardReasoningRecorder(sk);
    handlers.before_agent_run?.({ prompt: "event" }, { sessionKey: sk, runId: "r2", inputProvenance: {
      kind: "inter_session", sourceTool: "subagent_settle", sourceSessionKey: "child",
    } });
    currentRecorder("current reasoning"); oldRecorder("STALE_SECRET_REASONING");
    await vi.advanceTimersByTimeAsync(900);
    const rendered = JSON.stringify(wire.calls);
    expect(rendered).not.toContain("STALE_SECRET_REASONING");
    if (reasoningVisibility === "on") expect(rendered).toContain("current reasoning");
    else expect(rendered).not.toContain("current reasoning");
  });

  it.each([["end", false], ["error", true]] as const)("orders in-flight lifecycle %s against dispatch success=%s without losing a failure", async (phase, success) => {
    const wire = mockFetch(); global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi(true); const sk = "resume-failure-order";
    setCardContext(sk, context()); await triggerFirstFrame(handlers, sk, "r1");
    handlers.after_tool_call?.({ toolName: "sessions_spawn", result: { status: "accepted", childSessionKey: "child" } }, { sessionKey: sk, runId: "r1" });
    handlers.after_tool_call?.({ toolName: "sessions_yield" }, { sessionKey: sk, runId: "r1" });
    await finalizeCard(sk, { success: true });
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
    global.fetch = (async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes("/message/edit")) { entered(); await gate; }
      return wire.fetch(...args);
    }) as typeof fetch;
    setCardContext(sk, context()); const finalizer = createCardFinalizer(sk);
    handlers.before_agent_run?.({ prompt: "Runtime event" }, { sessionKey: sk, runId: "r2", inputProvenance: {
      kind: "inter_session", sourceTool: "subagent_settle", sourceSessionKey: "child",
    } });
    await started;
    const lifecycleEnd = handlers["octo-card-progress-lifecycle"]?.({ sessionKey: sk, runId: "r2", stream: "lifecycle", data: { phase, error: "actual lifecycle failure" } }, { sessionKey: sk, runId: "r2" });
    const failing = finalizer.finish({ success, failed: !success });
    release(); await failing; await lifecycleEnd;
    expect(wire.calls.filter(c => c.url.includes("/message/edit")).at(-1)?.body?.state).toBe("error");
    await handlers.agent_end?.({ success: true }, { sessionKey: sk, runId: "r2" });
    expect(wire.calls.filter(c => c.url.includes("/message/edit")).at(-1)?.body?.state).toBe("error");
  });

  it("does not retain a yielded card after a real delivery failure", async () => {
    const wire = mockFetch(); global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("yield-failure", context());
    await triggerFirstFrame(handlers, "yield-failure");
    handlers.after_tool_call?.({ toolName: "sessions_yield", result: { status: "yielded" } }, { sessionKey: "yield-failure", runId: "run-1" });
    markCardAnswering("yield-failure");
    await finalizeCard("yield-failure", { success: false, failed: true });
    expect(wire.calls.filter(c => c.url.includes("/message/edit")).at(-1)?.body?.state).toBe("error");
  });

  it("still sends the first progress card when queue release precedes its debounce", async () => {
    const wire = mockFetch(); global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi(); const sk = "pending-first-send";
    const ctx = { sessionKey: sk, runId: "run-1" };
    setCardContext(sk, context());
    const finalizer = createCardFinalizer(sk);
    handlers.before_agent_run?.({}, ctx);
    handlers.before_tool_call?.({ toolName: "exec", toolCallId: "first" }, ctx);
    await finalizer.pending();
    await vi.advanceTimersByTimeAsync(850);
    expect(wire.calls.filter(c => c.url.includes("/sendMessage"))).toHaveLength(1);
    await finalizer.finish({ success: true });
    expect(wire.calls.filter(c => c.url.includes("/message/edit")).at(-1)?.body?.state).toBe("completed");
  });

  it("continues flushing tool progress after a queue-release snapshot", async () => {
    const wire = mockFetch(); global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi(); const sk = "pending-flush";
    const ctx = { sessionKey: sk, runId: "run-1" };
    setCardContext(sk, context());
    const finalizer = createCardFinalizer(sk);
    await triggerFirstFrame(handlers, sk);
    handlers.before_tool_call?.({ toolName: "exec", toolCallId: "later" }, ctx);
    await finalizer.pending();
    const edits = wire.calls.filter(c => c.url.includes("/message/edit")).length;
    handlers.after_tool_call?.({ toolName: "exec", toolCallId: "later", result: {} }, ctx);
    await vi.advanceTimersByTimeAsync(850);
    expect(wire.calls.filter(c => c.url.includes("/message/edit")).length).toBeGreaterThan(edits);
    await finalizer.finish({ success: true });
  });

  it.each(["delivered", "foreign target", "tool error", "failed run"])("retains only the released run's tool delivery evidence: %s", async mode => {
    const wire = mockFetch({ sendResponses: [{ status: 200, messageId: "old-card" }, { status: 200, messageId: "new-card" }] });
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi(); const sk = "released-evidence";
    const old = { sessionKey: sk, runId: "old-run" };
    setCardContext(sk, context());
    const finalizer = createCardFinalizer(sk);
    await triggerFirstFrame(handlers, sk, old.runId);
    await finalizer.pending();
    setCardContext(sk, context());
    await triggerFirstFrame(handlers, sk, "new-run");
    handlers.before_tool_call?.({ toolName: "message", toolCallId: "late-send", params: {
      action: "send", target: mode === "foreign target" ? "group:another-group" : "group:group-1",
    } }, old);
    handlers.after_tool_call?.({ toolName: "message", toolCallId: "late-send", result: {},
      ...(mode === "tool error" ? { error: "send failed" } : {}),
    }, old);
    await finalizer.finish({ success: false, failed: mode === "failed run" });
    const oldFinal = wire.calls.filter(c => c.url.includes("/message/edit") && c.body?.message_id === "old-card").at(-1)?.body;
    expect(oldFinal?.state).toBe(mode === "delivered" ? "completed" : "error");
    await finalizeCard(sk, { success: false });
    expect(wire.calls.filter(c => c.url.includes("/message/edit") && c.body?.message_id === "new-card").at(-1)?.body?.state).toBe("error");
  });

  it.each(["before", "after"])("keeps a continuation's second spawn/yield when the unrelated inbound settles %s continuation start", async order => {
    const wire = mockFetch(); global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi(true); const sk = "overlapping-continuation";
    setCardContext(sk, context()); await triggerFirstFrame(handlers, sk, "first");
    const first = { sessionKey: sk, runId: "first" };
    handlers.after_tool_call?.({ toolName: "sessions_spawn", result: { status: "accepted", childSessionKey: "child-1" } }, first);
    handlers.after_tool_call?.({ toolName: "sessions_yield", result: { status: "yielded" } }, first);
    await finalizeCard(sk, { success: true });
    const second = { sessionKey: sk, runId: "second", inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce", sourceSessionKey: "child-1" } };
    handlers.before_agent_run?.({}, second);
    setCardContext(sk, context());
    handlers.before_agent_run?.({}, { sessionKey: sk, runId: "unrelated" });
    handlers.before_tool_call?.({ toolName: "sessions_spawn", toolCallId: "spawn-2" }, second);
    handlers.after_tool_call?.({ toolName: "sessions_spawn", toolCallId: "spawn-2", result: { status: "accepted", childSessionKey: "child-2" } }, second);
    handlers.after_tool_call?.({ toolName: "sessions_yield", result: { status: "yielded" } }, second);
    const unrelatedFinalizer = createCardFinalizer(sk);
    if (order === "before") await unrelatedFinalizer.finish({ success: false, failed: true });
    const third = { sessionKey: sk, runId: "third", inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce", sourceSessionKey: "child-2" } };
    handlers.before_agent_run?.({}, third);
    if (order === "after") await unrelatedFinalizer.finish({ success: false, failed: true });
    await handlers["octo-card-progress-lifecycle"]?.({ sessionKey: sk, runId: "third", stream: "lifecycle", data: { phase: "end" } }, third);
    expect(wire.calls.filter(c => c.url.includes("/sendMessage"))).toHaveLength(1);
    expect(wire.calls.filter(c => c.url.includes("/message/edit")).at(-1)?.body?.state).toBe("completed");
  });

  it("debounces retained continuation tools and observes shared cooldown without delaying its terminal frame", async () => {
    const wire = mockFetch(); global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi(true); const sk = "retained-rate";
    setCardContext(sk, context()); await triggerFirstFrame(handlers, sk, "first");
    const first = { sessionKey: sk, runId: "first" };
    handlers.after_tool_call?.({ toolName: "sessions_spawn", result: { status: "accepted", childSessionKey: "child" } }, first);
    handlers.after_tool_call?.({ toolName: "sessions_yield", result: { status: "yielded" } }, first);
    await finalizeCard(sk, { success: true });
    const continuation = { sessionKey: sk, runId: "second", inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce", sourceSessionKey: "child" } };
    handlers.before_agent_run?.({}, continuation);
    await vi.advanceTimersByTimeAsync(0);
    setCardContext(sk, context());
    handlers.before_agent_run?.({}, { sessionKey: sk, runId: "unrelated" });
    const edits = () => wire.fetch.mock.calls.filter(([url]) => String(url).includes("/message/edit")).length;
    const burst = (prefix: string) => {
      for (let i = 0; i < 20; i++) {
        handlers.before_tool_call?.({ toolName: "read", toolCallId: prefix + i }, continuation);
        handlers.after_tool_call?.({ toolName: "read", toolCallId: prefix + i, result: {} }, continuation);
      }
    };
    const before = edits();
    burst("first-");
    await vi.advanceTimersByTimeAsync(799); expect(edits()).toBe(before);
    await vi.advanceTimersByTimeAsync(1); expect(edits()).toBe(before + 1);
    wire.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ error: {
      code: "err.shared.rate.limited", http_status: 429, details: { retry_after: 30 },
    } }), { status: 429, headers: { "Retry-After": "30", "Content-Type": "application/json" } }));
    burst("limited-"); await vi.advanceTimersByTimeAsync(850);
    const limitedCount = edits();
    burst("held-"); await vi.advanceTimersByTimeAsync(20_000);
    expect(edits()).toBe(limitedCount);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(edits()).toBe(limitedCount + 1);
    wire.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ error: {
      code: "err.shared.rate.limited", http_status: 429, details: { retry_after: 30 },
    } }), { status: 429, headers: { "Retry-After": "30", "Content-Type": "application/json" } }));
    burst("last-"); await vi.advanceTimersByTimeAsync(850);
    await handlers["octo-card-progress-lifecycle"]?.({ sessionKey: sk, runId: "second", stream: "lifecycle", data: { phase: "end" } }, continuation);
    expect(wire.calls.filter(c => c.url.includes("/message/edit")).at(-1)?.body?.state).toBe("completed");
    const doneCount = edits(); await vi.advanceTimersByTimeAsync(1000);
    expect(edits()).toBe(doneCount);
  });

  async function retainedProgressFixture() {
    const wire = mockFetch(); global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi(true); const sk = "retained-retry";
    setCardContext(sk, context()); await triggerFirstFrame(handlers, sk, "first");
    const first = { sessionKey: sk, runId: "first" };
    handlers.after_tool_call?.({ toolName: "sessions_spawn", result: { status: "accepted", childSessionKey: "child" } }, first);
    handlers.after_tool_call?.({ toolName: "sessions_yield", result: { status: "yielded" } }, first);
    await finalizeCard(sk, { success: true });
    const continuation = { sessionKey: sk, runId: "second", inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce", sourceSessionKey: "child" } };
    handlers.before_agent_run?.({}, continuation);
    await vi.advanceTimersByTimeAsync(0);
    setCardContext(sk, context());
    handlers.before_agent_run?.({}, { sessionKey: sk, runId: "unrelated" });
    const edits = () => wire.fetch.mock.calls.filter(([url]) => String(url).includes("/message/edit"));
    const event = (id = "retry-tool") => handlers.after_tool_call?.({ toolName: "read", toolCallId: id, result: {} }, continuation);
    const finish = () => handlers["octo-card-progress-lifecycle"]?.({ sessionKey: sk, runId: "second", stream: "lifecycle", data: { phase: "end" } }, continuation);
    return { wire, handlers, sk, continuation, edits, event, finish };
  }

  it.each(["503", "network", "timeout", "semantic-500"])("retries a retained progress frame after exhausted short retries: %s", async kind => {
    const { wire, edits, event, finish } = await retainedProgressFixture();
    const fail = async () => {
      if (kind === "network") throw new TypeError("fetch failed");
      if (kind === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      if (kind === "semantic-500") return new Response(JSON.stringify({ error: { code: "err.shared.internal", http_status: 500 } }), { status: 400 });
      return new Response("temporary", { status: 503 });
    };
    for (let i = 0; i < 3; i++) wire.fetch.mockImplementationOnce(fail);
    const before = edits().length;
    event(); await vi.advanceTimersByTimeAsync(1_150);
    expect(edits()).toHaveLength(before + 3);
    // No new hook: the card-local wake must retry the failed snapshot itself.
    await vi.advanceTimersByTimeAsync(999);
    expect(edits()).toHaveLength(before + 3);
    await vi.advanceTimersByTimeAsync(501);
    expect(edits()).toHaveLength(before + 4);
    const bodies = edits().slice(before).map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies[0].card_seq).toBe(bodies[2].card_seq);
    expect(bodies[3].card_seq).toBeGreaterThan(bodies[2].card_seq);
    expect(bodies[3].state).toBe("reasoning");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(edits()).toHaveLength(before + 4);
    await finish();
  });

  it("bounds retained progress retries during an outage and recovers on a fresh tool event", async () => {
    const { wire, edits, event, finish } = await retainedProgressFixture();
    const original = wire.fetch.getMockImplementation()!;
    wire.fetch.mockImplementation(async () => new Response("unavailable", { status: 503 }));
    const before = edits().length;
    event(); await vi.advanceTimersByTimeAsync(60_000);
    expect(edits()).toHaveLength(before + 12); // initial frame + 3 fresh-frame retries, each with 3 wire attempts
    await vi.advanceTimersByTimeAsync(60_000);
    expect(edits()).toHaveLength(before + 12);
    wire.fetch.mockImplementation(original);
    event("after-recovery"); await vi.advanceTimersByTimeAsync(800);
    expect(edits()).toHaveLength(before + 13);
    await finish();
  });

  it.each(["finish", "clear", "identity-replacement"])("cancels retained progress retry on %s without a stale frame", async end => {
    const { wire, edits, event, finish, sk } = await retainedProgressFixture();
    for (let i = 0; i < 3; i++) wire.fetch.mockImplementationOnce(async () => new Response("temporary", { status: 503 }));
    event(); await vi.advanceTimersByTimeAsync(1_150);
    if (end === "finish") {
      await finish();
      expect(wire.calls.filter(c => c.url.includes("/message/edit")).at(-1)?.body?.state).toBe("completed");
    } else if (end === "clear") clearCard(sk);
    else setCardContext(sk, context({ botToken: "another-bot", onBehalfOf: "different-owner" }));
    const before = edits().length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(edits()).toHaveLength(before);
  });

  it.each([403, 422])("does not retry deterministic retained progress rejection %s", async status => {
    const { wire, edits, event } = await retainedProgressFixture();
    wire.fetch.mockImplementationOnce(async () => new Response("rejected", { status }));
    const before = edits().length;
    event(); await vi.advanceTimersByTimeAsync(60_000);
    event("later"); await vi.advanceTimersByTimeAsync(60_000);
    expect(edits()).toHaveLength(before + 1);
  });

  it("persists a running card on queue release and finishes only that card after a new turn starts", async () => {
    const wire = mockFetch(); global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("queue-release", context());
    const finalizer = createCardFinalizer("queue-release");
    await triggerFirstFrame(handlers, "queue-release", "old-run");
    await finalizer.pending();
    const waiting = wire.calls.filter(c => c.url.includes("/message/edit")).at(-1)?.body;
    expect(waiting?.state).toBe("reasoning");
    expect(waiting?.transient).not.toBe(true);
    setCardContext("queue-release", context());
    await triggerFirstFrame(handlers, "queue-release", "new-run");
    await finalizer.finish({ success: true });
    const done = wire.calls.filter(c => c.url.includes("/message/edit")).at(-1)?.body;
    expect(done?.state).toBe("completed");
    expect(done?.message_id).toBe(waiting?.message_id);
    await finalizeCard("queue-release", { success: true });
    expect(wire.calls.filter(c => c.url.includes("/sendMessage"))).toHaveLength(2);
  });

  it.each(["nothing_pending", "deferred", "already_pending", "error"])("does not pause on a sessions_yield no-op result: %s", async status => {
    const wire = mockFetch(); global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("no-yield", context());
    await triggerFirstFrame(handlers, "no-yield");
    handlers.after_tool_call?.({ toolName: "sessions_yield", result: { details: { status } } }, { sessionKey: "no-yield", runId: "run-1" });
    await finalizeCard("no-yield", { success: true });
    expect(wire.calls.filter(c => c.url.includes("/message/edit")).at(-1)?.body?.state).toBe("completed");
  });

  it("uses lifecycle-only yield evidence, ignores stale ends and preserves a real continuation failure", async () => {
    const wire = mockFetch(); global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi(true);
    const ctx = { sessionKey: "lifecycle-wait", runId: "run-1" };
    const lifecycle = (runId: string, data: Record<string, unknown>) =>
      handlers["octo-card-progress-lifecycle"]?.({ sessionKey: ctx.sessionKey, runId, stream: "lifecycle", data }, ctx);
    setCardContext(ctx.sessionKey, context());
    await triggerFirstFrame(handlers, ctx.sessionKey);
    handlers.after_tool_call?.({ toolName: "sessions_spawn", result: { details: { status: "accepted", childSessionKey: "child-1" } } }, ctx);
    await lifecycle("run-1", { phase: "end", yielded: true });
    markCardAnswering(ctx.sessionKey);
    await finalizeCard(ctx.sessionKey, { success: true });
    await lifecycle("unrelated", { phase: "end" });
    await lifecycle("run-1", { phase: "end" });
    expect(wire.calls.filter(c => c.url.includes("/message/edit")).at(-1)?.body?.state).toBe("reasoning");
    const continuation = { sessionKey: ctx.sessionKey, runId: "run-2", inputProvenance: {
      kind: "inter_session", sourceTool: "subagent_settle", sourceSessionKey: "child-1",
    } };
    handlers.before_agent_run?.({ prompt: "Runtime event" }, continuation);
    await lifecycle("unrelated", { phase: "error", error: "unrelated failure" });
    await lifecycle("run-2", { phase: "error", error: "continuation failed" });
    expect(wire.calls.filter(c => c.url.includes("/message/edit")).at(-1)?.body?.state).toBe("error");
    expect(wire.calls.some(c => c.body?.state === "completed")).toBe(false);
    expect(wire.calls.filter(c => c.url.includes("/sendMessage"))).toHaveLength(1);
  });

  it.each([
    undefined,
    { kind: "external_user", sourceTool: "subagent_announce", sourceSessionKey: "child-1" },
    { kind: "inter_session", sourceTool: "sessions_send", sourceSessionKey: "child-1" },
    { kind: "inter_session", sourceTool: "subagent_announce", sourceSessionKey: "unrelated-child" },
  ])("does not let unrelated provenance finish the waiting card: %j", async inputProvenance => {
    const wire = mockFetch(); global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("protected-wait", context());
    await triggerFirstFrame(handlers, "protected-wait");
    const ctx = { sessionKey: "protected-wait", runId: "run-1" };
    handlers.after_tool_call?.({ toolName: "sessions_spawn", result: { details: { status: "accepted", childSessionKey: "child-1" } } }, ctx);
    handlers.after_tool_call?.({ toolName: "sessions_yield", result: { details: { status: "yielded" } } }, ctx);
    await finalizeCard(ctx.sessionKey, { success: true });
    setCardContext(ctx.sessionKey, context());
    const other = { sessionKey: ctx.sessionKey, runId: "other-run", inputProvenance };
    handlers.before_agent_run?.({ prompt: inputProvenance
      ? completionPrompt("child-1") // Contradictory provenance must defeat the legacy fallback.
      : 'sourceTool: subagent_announce, sourceSessionKey: child-1' }, other);
    markCardAnswering(ctx.sessionKey);
    await handlers.agent_end?.({ success: true }, other);
    await finalizeCard(ctx.sessionKey, { success: true });
    expect(wire.calls.filter(c => c.url.includes("/message/edit")).at(-1)?.body?.state).toBe("reasoning");
  });

  it.each([true, false])("keeps IM card continuation independent of the completed document receipt (card first: %s)", async cardFirst => {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    // api.on appends in OpenClaw's typed-hook registry; exercise both modules
    // with one dispatch, rather than the single-module makeApi test double.
    const hooks = new Map<string, Hook[]>();
    const api = { on: (name: string, handler: Hook) => {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    } } as never;
    for (const register of cardFirst ? [registerCardProgress, registerDocTaskProgress] : [registerDocTaskProgress, registerCardProgress]) register(api);
    const fire = async (name: string, event: Record<string, unknown>, ctx: { sessionKey: string; runId: string }) => {
      const results = [];
      for (const handler of hooks.get(name) ?? []) results.push(await handler(event, ctx));
      return results;
    };
    registerDocTaskToolPolicy(api);
    const sessionKey = "agent:one:octo:acct:group:combined-continuation";
    const docSessionKey = "agent:one:octo:acct:doctask:doc:thread";
    const snapshots: DocTaskProgress[] = [];
    const tracker = new DocTaskTracker(async snapshot => { snapshots.push(snapshot); });
    const detach = tracker.attach(docSessionKey);
    const docCtx = { sessionKey: docSessionKey, runId: "doc-run" };
    const ctx = { sessionKey, runId: "run-1" };
    try {
      setCardContext(sessionKey, context());
      expect(await fire("before_agent_run", {}, docCtx)).toEqual([{ outcome: "pass" }, { outcome: "pass" }]);
      await fire("model_call_started", {}, docCtx);
      await fire("before_tool_call", { toolName: "read", toolCallId: "doc-read" }, docCtx);
      await fire("after_tool_call", { toolName: "read", toolCallId: "doc-read" }, docCtx);
      expect(await fire("before_agent_run", {}, ctx)).toEqual([{ outcome: "pass" }, { outcome: "pass" }]);
      await fire("model_call_started", { callId: "model-1" }, ctx);
      await fire("before_tool_call", { toolName: "read", toolCallId: "read-1" }, ctx);
      await fire("after_tool_call", { toolName: "read", toolCallId: "read-1", result: { text: "read complete" } }, ctx);
      await vi.advanceTimersByTimeAsync(900);
      expect(snapshots.at(-1)).toMatchObject({ state: "running", steps: [{ tool: "read", state: "finished" }] });
      expect(wire.calls.filter(call => call.url.includes("/sendMessage"))).toHaveLength(1);
      await fire("before_tool_call", { toolName: "sessions_spawn", toolCallId: "spawn-1" }, ctx);
      await fire("after_tool_call", { toolName: "sessions_spawn", toolCallId: "spawn-1", result: { status: "accepted", childSessionKey: "child-1" } }, ctx);
      await fire("before_tool_call", { toolName: "sessions_yield", toolCallId: "yield-1" }, ctx);
      await fire("after_tool_call", { toolName: "sessions_yield", toolCallId: "yield-1" }, ctx);
      await vi.advanceTimersByTimeAsync(900);
      await finalizeCard(sessionKey, { success: false });
    } finally { detach(); await tracker.finish({ finalDelivered: true }); }

    const completedSnapshotCount = snapshots.length;
    const resumedCtx = { sessionKey, runId: "run-2" };
    try {
      setCardContext(sessionKey, context());
      expect(await fire("before_agent_run", { prompt: completionPrompt("child-1") }, resumedCtx))
        .toEqual([{ outcome: "pass" }, { outcome: "pass" }]);
      await fire("model_call_started", { callId: "model-2" }, resumedCtx);
      await vi.advanceTimersByTimeAsync(300);
      expect(snapshots).toHaveLength(completedSnapshotCount);
      expect(snapshots.at(-1)).toMatchObject({ state: "finished", replyDelivered: true });
      await fire("agent_end", { runId: "run-2", success: true }, resumedCtx);
      const edits = wire.calls.filter(call => call.url.includes("/message/edit")).map(call => call.body!);
      expect(edits).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ progressText: "Subtask returned. Wrapping up…" }) }));
      expect(edits.at(-1)).toMatchObject({ state: "completed" });
      expect(wire.calls.filter(call => call.url.includes("/sendMessage"))).toHaveLength(1);
    } finally { clearCard(sessionKey); }
  });

  it.each([
    ["group-1", ChannelType.Group],
    ["user-1", ChannelType.DM],
    ["group-1____topic", ChannelType.CommunityTopic],
    ["s1001_user-1", ChannelType.DM],
  ])("completes a targetless message-tool reply to %s from its actual receipt", async (channelId, channelType) => {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    const sessionKey = "implicit-reply";
    setCardContext(sessionKey, context({ channelId, channelType, accountId: "bot-1" }));
    await triggerFirstFrame(handlers, sessionKey);
    const ctx = { sessionKey, runId: "run-1" };
    handlers.before_tool_call?.({ toolName: "message", toolCallId: "send-1", params: { action: "send", message: "done", final: true } }, ctx);
    handlers.after_tool_call?.({ toolName: "message", toolCallId: "send-1", result: { details: {
      ok: true, data: { sent: true, channelId, resolvedTarget: channelId, channelType, accountId: "bot-1" },
    } } }, ctx);
    await finalizeCard(sessionKey, { success: false });
    expect(wire.calls.filter(call => call.url.includes("/message/edit")).at(-1)?.body).toMatchObject({ state: "completed" });
  });

  it.each([undefined, "group:group-1"])("normalizes the account in an actual receipt (requested target: %s)", async target => {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    const sessionKey = "mixed-case-reply";
    setCardContext(sessionKey, context({ accountId: "27pBwzf2F6bfa5cd142_bot" }));
    await triggerFirstFrame(handlers, sessionKey);
    const ctx = { sessionKey, runId: "run-1" };
    handlers.before_tool_call?.({ toolName: "message", toolCallId: "send-1", params: { action: "send", message: "done", ...(target ? { target } : {}) } }, ctx);
    handlers.after_tool_call?.({ toolName: "message", toolCallId: "send-1", result: { details: {
      ok: true, data: { sent: true, channelId: "group-1", resolvedTarget: "group-1", channelType: ChannelType.Group, accountId: "27pbwzf2f6bfa5cd142_bot" },
    } } }, ctx);
    await finalizeCard(sessionKey, { success: false });
    expect(wire.calls.filter(call => call.url.includes("/message/edit")).at(-1)?.body).toMatchObject({ state: "completed" });
  });

  it("pairs the nested message hook independently of its outer tool_call hook", async () => {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    const sessionKey = "nested-message-reply";
    setCardContext(sessionKey, context());
    await triggerFirstFrame(handlers, sessionKey);
    const ctx = { sessionKey, runId: "run-1" };
    const params = { action: "send", message: "done" };
    const result = { details: { ok: true, data: { sent: true, resolvedTarget: "group-1", channelType: ChannelType.Group } } };
    handlers.before_tool_call?.({ toolName: "tool_call", toolCallId: "outer-1", params: { id: "message", args: params } }, ctx);
    handlers.before_tool_call?.({ toolName: "message", toolCallId: "tool_call:outer-1:message:1", params }, ctx);
    handlers.after_tool_call?.({ toolName: "message", toolCallId: "tool_call:outer-1:message:1", result }, ctx);
    handlers.after_tool_call?.({ toolName: "tool_call", toolCallId: "outer-1", result: { details: { result } } }, ctx);
    await finalizeCard(sessionKey, { success: false });
    expect(wire.calls.filter(call => call.url.includes("/message/edit")).at(-1)?.body).toMatchObject({ state: "completed" });
  });

  it.each([
    { ok: false },
    { data: { sent: false } },
    { data: { resolvedTarget: "other-group", channelId: "other-group" } },
    { data: { channelType: ChannelType.DM } },
    { data: { accountId: "other-bot" } },
    { data: { accountId: undefined } },
    { data: { resolvedTarget: "" } },
    { data: { failedMedia: [{ url: "failed.txt" }] } },
    { data: { failedMedia: "malformed" } },
  ])("does not let an explicit target override an unsuccessful or foreign receipt: %j", async override => {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    const sessionKey = "receipt-rejected";
    setCardContext(sessionKey, context({ accountId: "bot-1" }));
    await triggerFirstFrame(handlers, sessionKey);
    const ctx = { sessionKey, runId: "run-1" };
    handlers.before_tool_call?.({ toolName: "message", toolCallId: "send-1", params: { action: "send", target: "group:group-1", message: "done" } }, ctx);
    const details = { ok: true, ...override, data: { sent: true, resolvedTarget: "group-1", channelId: "group-1", channelType: ChannelType.Group, accountId: "bot-1", ...override.data } };
    handlers.after_tool_call?.({ toolName: "message", toolCallId: "send-1", result: { details } }, ctx);
    await finalizeCard(sessionKey, { success: false });
    expect(wire.calls.filter(call => call.url.includes("/message/edit")).at(-1)?.body).toMatchObject({ state: "error" });
  });

  it.each(["top-level-error", "successful-duplicate-after-error"])("does not credit %s even with a matching receipt", async failure => {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    const sessionKey = "receipt-error-ownership";
    setCardContext(sessionKey, context());
    await triggerFirstFrame(handlers, sessionKey);
    const ctx = { sessionKey, runId: "run-1" };
    handlers.before_tool_call?.({ toolName: "message", toolCallId: "send-1", params: { action: "send", target: "group:group-1", message: "done" } }, ctx);
    if (failure === "successful-duplicate-after-error") {
      handlers.after_tool_call?.({ toolName: "message", toolCallId: "send-1", error: "send failed" }, ctx);
    }
    handlers.after_tool_call?.({ toolName: "message", toolCallId: "send-1", result: {
      ...(failure === "top-level-error" ? { isError: true } : {}),
      details: { ok: true, data: { sent: true, resolvedTarget: "group-1", channelType: ChannelType.Group } },
    } }, ctx);
    await finalizeCard(sessionKey, { success: false });
    expect(wire.calls.filter(call => call.url.includes("/message/edit")).at(-1)?.body).toMatchObject({ state: "error" });
  });

  it.each(["missing-receipt", "unpaired-call", "foreign-run", "tool-error", "dispatch-failed"])("keeps %s failed even for a current-source message", async failure => {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    const sessionKey = "implicit-failure";
    setCardContext(sessionKey, context());
    await triggerFirstFrame(handlers, sessionKey);
    const ctx = { sessionKey, runId: "run-1" };
    handlers.before_tool_call?.({ toolName: "message", toolCallId: "send-1", params: { action: "send", message: "done" } }, ctx);
    handlers.after_tool_call?.({ toolName: "message", toolCallId: failure === "unpaired-call" ? "unknown" : "send-1",
      ...(failure === "tool-error" ? { error: "send failed" } : {}),
      ...(failure === "missing-receipt" ? {} : { result: { details: { ok: true, data: { sent: true, channelId: "group-1", resolvedTarget: "group-1", channelType: ChannelType.Group } } } }),
    }, { ...ctx, runId: failure === "foreign-run" ? "older-run" : ctx.runId });
    await finalizeCard(sessionKey, { success: false, ...(failure === "dispatch-failed" ? { failed: true } : {}) });
    expect(wire.calls.filter(call => call.url.includes("/message/edit")).at(-1)?.body).toMatchObject({ state: "error" });
  });

  it("preserves explicit-target delivery on older hosts without structured receipts", async () => {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    const sessionKey = "legacy-explicit-reply";
    setCardContext(sessionKey, context());
    await triggerFirstFrame(handlers, sessionKey);
    const ctx = { sessionKey, runId: "run-1" };
    handlers.before_tool_call?.({ toolName: "message", toolCallId: "send-1", params: { action: "send", target: "group:group-1", message: "done" } }, ctx);
    handlers.after_tool_call?.({ toolName: "message", toolCallId: "send-1" }, ctx);
    await finalizeCard(sessionKey, { success: false });
    expect(wire.calls.filter(call => call.url.includes("/message/edit")).at(-1)?.body).toMatchObject({ state: "completed" });
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

  it.each([
    ["display", DISPLAY_CARD_TOOL_NAME],
    ["interactive", INTERACTIVE_CARD_TOOL_NAME],
  ])("treats a successful %s card tool as delivery for an existing reasoning card", async (_label, toolName) => {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    const sessionKey = `card-tool-delivery-${toolName}`;
    const hookContext = { sessionKey, runId: "run-1" };
    setCardContext(sessionKey, context());

    await triggerFirstFrame(handlers, sessionKey);
    handlers.after_tool_call?.({ toolName: "read", toolCallId: "tool-1", result: {} }, hookContext);
    handlers.before_tool_call?.({ toolName, toolCallId: "card-tool-1" }, hookContext);
    handlers.after_tool_call?.({
      toolName,
      toolCallId: "card-tool-1",
      result: toolName === DISPLAY_CARD_TOOL_NAME
        ? {
            content: [{ type: "text", text: "sent display card" }],
            details: {
              message_id: "display-card-1",
              channel_id: "group-1",
              client_msg_no: "display-client-1",
            },
          }
        : {
            content: [{ type: "text", text: "sent interactive card" }],
            details: { sent: true, message_id: "interactive-card-1", channel_id: "group-1" },
          },
    }, hookContext);
    await finalizeCard(sessionKey, { success: false });

    const terminalEdit = wire.calls.filter((call) => call.url.includes("/message/edit")).at(-1)?.body;
    expect(terminalEdit).toMatchObject({ state: "completed" });
  });

  it("does not count a failed display-card tool as delivery", async () => {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    const sessionKey = "failed-display-card-tool";
    const hookContext = { sessionKey, runId: "run-1" };
    setCardContext(sessionKey, context());

    await triggerFirstFrame(handlers, sessionKey);
    handlers.after_tool_call?.({ toolName: "read", toolCallId: "tool-1", result: {} }, hookContext);
    handlers.before_tool_call?.({
      toolName: DISPLAY_CARD_TOOL_NAME,
      toolCallId: "display-1",
    }, hookContext);
    handlers.after_tool_call?.({
      toolName: DISPLAY_CARD_TOOL_NAME,
      toolCallId: "display-1",
      result: {
        content: [{ type: "text", text: "Error: send rejected" }],
        details: null,
      },
    }, hookContext);
    await finalizeCard(sessionKey, { success: false });

    const terminalEdit = wire.calls.filter((call) => call.url.includes("/message/edit")).at(-1)?.body;
    expect(terminalEdit).toMatchObject({ state: "error" });
  });

  it("keeps a real dispatch failure ahead of successful card-tool delivery evidence", async () => {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    const sessionKey = "display-card-dispatch-failed";
    const hookContext = { sessionKey, runId: "run-1" };
    setCardContext(sessionKey, context());

    await triggerFirstFrame(handlers, sessionKey);
    handlers.after_tool_call?.({ toolName: "read", toolCallId: "tool-1", result: {} }, hookContext);
    handlers.before_tool_call?.({
      toolName: DISPLAY_CARD_TOOL_NAME,
      toolCallId: "display-1",
    }, hookContext);
    handlers.after_tool_call?.({
      toolName: DISPLAY_CARD_TOOL_NAME,
      toolCallId: "display-1",
      result: {
        content: [{ type: "text", text: "sent display card" }],
        details: {
          message_id: "display-card-1",
          channel_id: "group-1",
          client_msg_no: "display-client-1",
        },
      },
    }, hookContext);
    await finalizeCard(sessionKey, { success: false, failed: true });

    const terminalEdit = wire.calls.filter((call) => call.url.includes("/message/edit")).at(-1)?.body;
    expect(terminalEdit).toMatchObject({ state: "error" });
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

/**
 * llm_output 车道:宿主持久化的 lastAssistant 快照。它存在的前提是**流式车道什么都没给**
 * (见 card-progress.ts 该 hook 上方注释)。评审指出整个 hook 此前没有任何测试 —— 把它整块
 * revert 掉套件仍然全绿,而它正是上一轮那个覆盖回归所在的位置。
 */
describe("llm_output reasoning capture lane", () => {
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

  const thinking = (thought: string, signature?: string) => ({
    type: "thinking",
    ...(thought ? { thinking: thought } : { thinking: "" }),
    ...(signature ? { thinkingSignature: signature } : {}),
  });

  async function cardThought(
    setup: (handlers: Record<string, Hook>, ctx: { sessionKey: string; runId?: string }) => void,
  ): Promise<string> {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    const sessionKey = "llm-lane-" + Math.random().toString(36).slice(2, 8);
    setCardContext(sessionKey, context({ reasoningVisibility: "stream" }));
    const hookCtx = { sessionKey, runId: "run-1" };
    handlers.before_agent_run?.({}, hookCtx);
    handlers.model_call_started?.({ callId: "model-1" }, hookCtx);
    setup(handlers, hookCtx);
    handlers.before_tool_call?.({ toolName: "read", toolCallId: "tool-1" }, hookCtx);
    await vi.advanceTimersByTimeAsync(900);
    const sent = wire.calls.find((call) => call.url.includes("/sendMessage"))?.body?.payload as
      { data?: { phases?: Array<{ thought: string }> } } | undefined;
    return sent?.data?.phases?.[0]?.thought ?? "";
  }

  it("records real thinking text from the snapshot", async () => {
    expect(await cardThought((handlers, ctx) => {
      handlers.llm_output?.({ lastAssistant: { role: "assistant", content: [thinking("Checking the reducer.")] } }, ctx);
    })).toBe("Checking the reducer.");
  });

  it("reports a signed block with no text as reasoned-without-summary", async () => {
    // 否则这条车道会把「推理了但拿不到内容」退化成「压根没推理」。
    expect(await cardThought((handlers, ctx) => {
      handlers.llm_output?.({ lastAssistant: { role: "assistant", content: [thinking("", "sig-abc")] } }, ctx);
    })).toBe("Reasoned without a visible summary");
  });

  it("does not let a signed empty snapshot clobber text the streaming lane already captured", async () => {
    // snapshot 是无条件替换。上一轮的回归:Anthropic 的 redacted_thinking 作为最后一个 block 时,
    // 会把已经捕获到的真实推理冲成「没有可见摘要」。
    expect(await cardThought((handlers, ctx) => {
      recordCardReasoning(ctx.sessionKey, "Checking the reducer.");
      handlers.llm_output?.({ lastAssistant: { role: "assistant", content: [thinking("", "sig-abc")] } }, ctx);
    })).toBe("Checking the reducer.");
  });

  it("keeps real text when the snapshot mixes it with a signed empty block", async () => {
    expect(await cardThought((handlers, ctx) => {
      handlers.llm_output?.({
        lastAssistant: { role: "assistant", content: [thinking("", "sig-abc"), thinking("Checking the reducer.")] },
      }, ctx);
    })).toBe("Checking the reducer.");
  });

  it("ignores the snapshot when reasoning visibility is off", async () => {
    const wire = mockFetch();
    global.fetch = wire.fetch as typeof fetch;
    const handlers = makeApi();
    setCardContext("llm-lane-off", context({ reasoningVisibility: "off" }));
    const hookCtx = { sessionKey: "llm-lane-off", runId: "run-1" };
    handlers.before_agent_run?.({}, hookCtx);
    handlers.model_call_started?.({ callId: "model-1" }, hookCtx);
    handlers.llm_output?.({ lastAssistant: { role: "assistant", content: [thinking("private thought")] } }, hookCtx);
    handlers.before_tool_call?.({ toolName: "read", toolCallId: "tool-1" }, hookCtx);
    await vi.advanceTimersByTimeAsync(900);
    expect(JSON.stringify(wire.calls.find((call) => call.url.includes("/sendMessage"))?.body))
      .not.toContain("private thought");
  });
});
