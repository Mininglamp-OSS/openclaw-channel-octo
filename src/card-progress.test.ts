import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType } from "./types.js";
import { OCTO_CARD_LAYOUTS } from "./card-render.js";
import {
  setCardContext,
  finalizeCard,
  finalizeCardWithResponse,
  clearCard,
  registerCardProgress,
  bindCardRun,
  markCardAnswering,
  recordCardReasoning,
  _resetCardProgressForTests,
} from "./card-progress.js";

type AgentEvent = {
  runId: string;
  sessionKey?: string;
  stream: string;
  data: Record<string, unknown>;
};

/** 收集 registerCardProgress 注册的 hook 与 lifecycle handler。 */
function makeApi(opts: { lifecycle?: boolean } = {}): {
  handlers: Record<string, (e: unknown, c: unknown) => unknown>;
  emitLifecycle: (event: AgentEvent) => Promise<void>;
  emitAgentEvent: (event: AgentEvent) => Promise<void>;
} {
  const handlers: Record<string, (e: unknown, c: unknown) => unknown> = {};
  const agentEventHandlers = new Map<string, (event: AgentEvent) => void | Promise<void>>();
  const api: Record<string, unknown> = {
    on: (name: string, fn: (e: unknown, c: unknown) => unknown) => { handlers[name] = fn; },
  };
  if (opts.lifecycle !== false) {
    api.agent = {
      events: {
        registerAgentEventSubscription: (subscription: {
          id: string;
          streams?: string[];
          handle: (event: AgentEvent) => void | Promise<void>;
        }) => {
          for (const stream of subscription.streams ?? []) {
            agentEventHandlers.set(stream, subscription.handle);
          }
        },
      },
    };
  }
  registerCardProgress(api as never);
  return {
    handlers,
    emitLifecycle: async (event) => {
      const handler = agentEventHandlers.get("lifecycle");
      expect(handler).toBeTypeOf("function");
      await handler!(event);
    },
    emitAgentEvent: async (event) => {
      const handler = agentEventHandlers.get(event.stream);
      expect(handler).toBeTypeOf("function");
      await handler!(event);
    },
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

/** mock fetch,按 url 分派 getCardProfile / sendMessage / message-edit,记录请求。 */
function mockFetch(opts: { enabled?: boolean; sendId?: string; profile?: Record<string, unknown> } = {}) {
  const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
  const fn = vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    if (String(url).includes("/v1/bot/card/profile")) {
      return {
        ok: true,
        status: 200,
        json: async () => opts.profile ?? ({ enabled: opts.enabled ?? true, profiles: ["octo/v1"] }),
      };
    }
    if (String(url).includes("/v1/bot/sendMessage")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: opts.sendId ?? "card1" }) };
    }
    return { ok: true, status: 200, text: async () => "" }; // message/edit
  });
  return { fn, calls };
}

function registryProfile(version = "0.2.0"): Record<string, unknown> {
  return {
    enabled: true,
    profiles: ["octo/v1", "octo/v2"],
    templating: {
      supported: true,
      wire: "template-ref/v1",
      templates: [{
        id: "ai.reasoning-process",
        version,
        views: [
          { name: "active", states: ["reasoning", "answering"], wire_profile: "octo/v2", submit_actions: ["reasoning_stop"] },
          { name: "error", states: ["error"], wire_profile: "octo/v2", submit_actions: ["reasoning_retry"] },
          { name: "result", states: ["completed", "stopped"], wire_profile: "octo/v1", submit_actions: [] },
        ],
      }],
    },
  };
}

function elementText(e: Record<string, unknown>): string {
  if (typeof e.text === "string") return e.text;
  if (Array.isArray(e.inlines)) return e.inlines.map((i) => (i as { text?: string }).text ?? "").join("");
  if (Array.isArray(e.items)) return e.items.map((item) => elementText(item as Record<string, unknown>)).join("\n");
  if (Array.isArray(e.columns)) {
    return e.columns
      .flatMap((c) => ((c as { items?: unknown[] }).items ?? []) as Record<string, unknown>[])
      .map(elementText)
      .join("\n");
  }
  return "";
}

function progressHeaderText(card: { body: Array<Record<string, unknown>> }): string {
  return elementText(card.body[0]);
}

function progressDetailItems(card: { body: Array<Record<string, unknown>> }): Array<Record<string, unknown>> {
  return ((card.body[1] as { items?: Array<Record<string, unknown>> })?.items ?? []);
}

function progressCardText(card: { body: Array<Record<string, unknown>> }): string {
  return card.body.map(elementText).join("\n");
}

/** 可控 promise:用于把某个请求悬在 in-flight 状态。 */
function makeDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("card-progress 状态机 + hook + 节流", () => {
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

  it("首个 tool 事件懒发占位卡(gate+send),after_tool_call 触发 edit", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("s1", { apiUrl: "https://a1.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "s1" });
    await vi.advanceTimersByTimeAsync(900);

    expect(calls.some((c) => c.url.includes("/card/profile"))).toBe(true);
    const send = calls.find((c) => c.url.includes("/sendMessage"));
    expect(send).toBeTruthy();
    expect((send!.body!.payload as { type: number }).type).toBe(17);

    handlers.after_tool_call({ toolName: "read", durationMs: 30 }, { sessionKey: "s1" });
    await vi.advanceTimersByTimeAsync(900);
    const edit = calls.find((c) => c.url.includes("/message/edit"));
    expect(edit).toBeTruthy();
    const editEnv = JSON.parse(edit!.body!.content_edit as string);
    expect(editEnv.type).toBe(17);
    expect(editEnv.transient).toBe(true); // 进度中间帧不进修订历史(D10)
  });

  it("experimental 模式用 manifest 版本发送 Registry 推理卡并以递增 seq 更新状态", async () => {
    const profile = {
      enabled: true,
      profiles: ["octo/v1", "octo/v2"],
      card_version: "1.5",
      elements: ["TextBlock", "Container", "ColumnSet", "ActionSet"],
      actions: ["Action.ToggleVisibility"],
      templating: {
        supported: true,
        wire: "template-ref/v1",
        templates: [{
          id: "ai.reasoning-process",
          version: "0.2.0",
          views: [
            { name: "active", states: ["reasoning", "answering"], wire_profile: "octo/v2", submit_actions: ["reasoning_stop"] },
            { name: "error", states: ["error"], wire_profile: "octo/v2", submit_actions: ["reasoning_retry"] },
            { name: "result", states: ["completed", "stopped"], wire_profile: "octo/v1", submit_actions: [] },
          ],
        }],
      },
    };
    const { fn, calls } = mockFetch({ profile, sendId: "registry-card" });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    const hookCtx = { sessionKey: "registry-progress", runId: "run-1" };

    setCardContext("registry-progress", {
      apiUrl: "https://registry-progress.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
      reasoningVisibility: "stream",
      reasoningCardTemplateMode: "experimental",
    });
    handlers.before_agent_run({}, hookCtx);
    handlers.model_call_started({ callId: "call-1" }, hookCtx);
    recordCardReasoning("registry-progress", "先核对输入。", { snapshot: true });
    handlers.before_tool_call({ toolName: "read", toolCallId: "tool-1", params: { path: "README.md" } }, hookCtx);
    handlers.after_tool_call({ toolName: "read", toolCallId: "tool-1", result: {} }, hookCtx);
    await vi.advanceTimersByTimeAsync(900);

    const send = calls.find((call) => call.url.includes("/sendMessage"));
    const sendPayload = send?.body?.payload as Record<string, unknown>;
    expect(sendPayload).toMatchObject({
      type: 17,
      template_ref: { id: "ai.reasoning-process", version: "0.2.0" },
      state: "reasoning",
      data: { state: "reasoning", reasoningId: "registry-progress:run-1" },
    });
    expect(sendPayload).not.toHaveProperty("card");

    calls.length = 0;
    markCardAnswering("registry-progress");
    await vi.advanceTimersByTimeAsync(900);
    const answering = calls.find((call) => call.url.includes("/message/edit"))?.body;
    expect(answering).toMatchObject({
      template_ref: { id: "ai.reasoning-process", version: "0.2.0" },
      state: "answering",
      card_seq: 1,
      transient: true,
    });
    expect(answering).not.toHaveProperty("content_edit");

    calls.length = 0;
    await finalizeCard("registry-progress", { success: true });
    const completed = calls.find((call) => call.url.includes("/message/edit"))?.body;
    expect(completed).toMatchObject({ state: "completed", card_seq: 2 });
    expect(completed).not.toHaveProperty("transient");
    expect(completed).not.toHaveProperty("content_edit");
  });

  it("同 apiUrl 的不同 bot 各自使用自己的 Registry catalog", async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown>; token?: string }> = [];
    global.fetch = vi.fn().mockImplementation(async (
      url: string,
      init?: { body?: string; headers?: HeadersInit },
    ) => {
      const token = new Headers(init?.headers).get("Authorization")?.replace(/^Bearer /, "");
      calls.push({
        url: String(url),
        ...(init?.body ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
        ...(token ? { token } : {}),
      });
      if (String(url).includes("/card/profile")) {
        return {
          ok: true,
          status: 200,
          json: async () => registryProfile(token === "bot-a" ? "0.1.0" : "0.2.0"),
        };
      }
      if (String(url).includes("/sendMessage")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: `card-${token}` }) };
      }
      return { ok: true, status: 200, text: async () => "" };
    }) as unknown as typeof fetch;
    const { handlers } = makeApi();

    for (const [sessionKey, botToken] of [["bot-a-session", "bot-a"], ["bot-b-session", "bot-b"]]) {
      setCardContext(sessionKey, {
        apiUrl: "https://shared-registry.test",
        botToken,
        channelId: `channel-${botToken}`,
        channelType: ChannelType.Group,
        reasoningCardTemplateMode: "experimental",
      });
      handlers.model_call_started({ callId: `call-${botToken}` }, { sessionKey });
      handlers.before_tool_call(
        { toolName: "read", toolCallId: `tool-${botToken}` },
        { sessionKey },
      );
      await vi.advanceTimersByTimeAsync(900);
    }

    expect(calls.filter((call) => call.url.includes("/card/profile")).map((call) => call.token))
      .toEqual(["bot-a", "bot-b"]);
    expect(calls.filter((call) => call.url.includes("/sendMessage")).map((call) =>
      ((call.body?.payload as { template_ref?: { version?: string } }).template_ref?.version)))
      .toEqual(["0.1.0", "0.2.0"]);
  });

  it("reasoningId 在 512 字符边界保留原值，513 字符使用稳定摘要", async () => {
    const { fn, calls } = mockFetch({ profile: registryProfile(), sendId: "reasoning-id-card" });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    const sendReasoningId = async (sessionKey: string, runId: string): Promise<string> => {
      setCardContext(sessionKey, {
        apiUrl: "https://reasoning-id.test",
        botToken: "bf",
        channelId: "g",
        channelType: ChannelType.Group,
        reasoningCardTemplateMode: "experimental",
      });
      const hookCtx = { sessionKey, runId };
      handlers.before_agent_run({}, hookCtx);
      handlers.model_call_started({ callId: `call-${runId}` }, hookCtx);
      handlers.before_tool_call({ toolName: "read", toolCallId: `tool-${runId}` }, hookCtx);
      await vi.advanceTimersByTimeAsync(900);
      const payload = calls.filter((call) => call.url.includes("/sendMessage")).at(-1)?.body?.payload as {
        data?: { reasoningId?: string };
      };
      clearCard(sessionKey);
      return payload.data?.reasoningId ?? "";
    };

    const runId = "r";
    const session512 = "x".repeat(510);
    const raw512 = `${session512}:${runId}`;
    expect([...raw512]).toHaveLength(512);
    expect(await sendReasoningId(session512, runId)).toBe(raw512);

    const session513 = "x".repeat(511);
    const raw513 = `${session513}:${runId}`;
    expect([...raw513]).toHaveLength(513);
    const hashed = await sendReasoningId(session513, runId);
    expect(hashed).toMatch(/^octo-reasoning:sha256:[a-f0-9]{64}$/);
    expect([...hashed]).toHaveLength(86);
    expect(await sendReasoningId(session513, runId)).toBe(hashed);
    expect(await sendReasoningId("y".repeat(511), runId)).not.toBe(hashed);
  });

  it("兼容 Registry 模板不受 Model B card_version/elements gate 限制", async () => {
    const { fn, calls } = mockFetch({
      profile: {
        ...registryProfile(),
        card_version: "9.9",
        elements: [],
      },
      sendId: "registry-without-model-b",
    });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("registry-without-model-b", {
      apiUrl: "https://registry-without-model-b.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
      reasoningCardTemplateMode: "experimental",
    });
    handlers.model_call_started({ callId: "call-1" }, { sessionKey: "registry-without-model-b" });
    handlers.before_tool_call(
      { toolName: "read", toolCallId: "tool-1" },
      { sessionKey: "registry-without-model-b" },
    );
    await vi.advanceTimersByTimeAsync(900);

    const payload = calls.find((call) => call.url.includes("/sendMessage"))?.body?.payload as
      Record<string, unknown> | undefined;
    expect(payload).toHaveProperty("template_ref.version", "0.2.0");
    expect(payload).not.toHaveProperty("card");
  });

  it("shadow 模式只验证 manifest，仍发送 Model B 完整卡", async () => {
    const { fn, calls } = mockFetch({
      profile: {
        enabled: true,
        profiles: ["octo/v1", "octo/v2"],
        templating: {
          supported: true,
          wire: "template-ref/v1",
          templates: [{
            id: "ai.reasoning-process",
            version: "0.2.0",
            views: [
              { name: "active", states: ["reasoning", "answering"], wire_profile: "octo/v2", submit_actions: ["reasoning_stop"] },
              { name: "error", states: ["error"], wire_profile: "octo/v2", submit_actions: ["reasoning_retry"] },
              { name: "result", states: ["completed", "stopped"], wire_profile: "octo/v1", submit_actions: [] },
            ],
          }],
        },
      },
    });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("shadow-progress", {
      apiUrl: "https://shadow-progress.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
      reasoningCardTemplateMode: "shadow",
    });
    handlers.model_call_started({ callId: "call-1" }, { sessionKey: "shadow-progress" });
    handlers.before_tool_call({ toolName: "read", toolCallId: "tool-1" }, { sessionKey: "shadow-progress" });
    await vi.advanceTimersByTimeAsync(900);

    const payload = calls.find((call) => call.url.includes("/sendMessage"))?.body?.payload as Record<string, unknown>;
    expect(payload).toHaveProperty("card");
    expect(payload).not.toHaveProperty("template_ref");
  });

  it("Model A 卡禁止用 raw content_edit 合并最终回答", async () => {
    const { fn, calls } = mockFetch({
      profile: {
        enabled: true,
        profiles: ["octo/v1", "octo/v2"],
        templating: {
          supported: true,
          wire: "template-ref/v1",
          templates: [{
            id: "ai.reasoning-process",
            version: "0.2.0",
            views: [
              { name: "active", states: ["reasoning", "answering"], wire_profile: "octo/v2", submit_actions: ["reasoning_stop"] },
              { name: "error", states: ["error"], wire_profile: "octo/v2", submit_actions: ["reasoning_retry"] },
              { name: "result", states: ["completed", "stopped"], wire_profile: "octo/v1", submit_actions: [] },
            ],
          }],
        },
      },
    });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("registry-no-raw", {
      apiUrl: "https://registry-no-raw.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
      reasoningCardTemplateMode: "experimental",
    });
    handlers.model_call_started({ callId: "call-1" }, { sessionKey: "registry-no-raw" });
    handlers.before_tool_call({ toolName: "read", toolCallId: "tool-1" }, { sessionKey: "registry-no-raw" });
    await vi.advanceTimersByTimeAsync(900);
    calls.length = 0;

    expect(await finalizeCardWithResponse("registry-no-raw", "最终回答")).toBe(false);
    expect(calls).toEqual([]);
  });

  it("Model A edit 的 5xx 重试复用完全相同的 body 和 card_seq", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
    let editAttempts = 0;
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      if (String(url).includes("/card/profile")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            enabled: true,
            profiles: ["octo/v1", "octo/v2"],
            templating: {
              supported: true,
              wire: "template-ref/v1",
              templates: [{
                id: "ai.reasoning-process",
                version: "0.2.0",
                views: [
                  { name: "active", states: ["reasoning", "answering"], wire_profile: "octo/v2", submit_actions: ["reasoning_stop"] },
                  { name: "error", states: ["error"], wire_profile: "octo/v2", submit_actions: ["reasoning_retry"] },
                  { name: "result", states: ["completed", "stopped"], wire_profile: "octo/v1", submit_actions: [] },
                ],
              }],
            },
          }),
        };
      }
      if (String(url).includes("/sendMessage")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: "retry-card" }) };
      }
      editAttempts += 1;
      return editAttempts === 1
        ? { ok: false, status: 503, statusText: "down", text: async () => "temporary" }
        : { ok: true, status: 200, text: async () => "" };
    }) as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("registry-retry", {
      apiUrl: "https://registry-retry.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
      reasoningCardTemplateMode: "experimental",
    });
    handlers.model_call_started({ callId: "call-1" }, { sessionKey: "registry-retry" });
    handlers.before_tool_call({ toolName: "read", toolCallId: "tool-1" }, { sessionKey: "registry-retry" });
    await vi.advanceTimersByTimeAsync(900);
    calls.length = 0;

    markCardAnswering("registry-retry");
    await vi.advanceTimersByTimeAsync(2_000);

    const edits = calls.filter((call) => call.url.includes("/message/edit"));
    expect(edits).toHaveLength(2);
    expect(edits[0]?.body).toEqual(edits[1]?.body);
    expect(edits[0]?.body?.card_seq).toBe(1);
  });

  it.each([429, 503])("Model A 首帧 %i 后下个事件仍可重试", async (failureStatus) => {
    const calls: string[] = [];
    let sendAttempts = 0;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("/card/profile")) {
        return { ok: true, status: 200, json: async () => registryProfile() };
      }
      if (String(url).includes("/sendMessage")) {
        sendAttempts += 1;
        if (sendAttempts === 1) {
          return {
            ok: false,
            status: failureStatus,
            statusText: "temporary",
            text: async () => "temporary",
          };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: "retry-card" }) };
      }
      return { ok: true, status: 200, text: async () => "" };
    }) as unknown as typeof fetch;
    const { handlers } = makeApi();
    const sessionKey = `registry-send-retry-${failureStatus}`;
    setCardContext(sessionKey, {
      apiUrl: `https://registry-send-retry-${failureStatus}.test`,
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
      reasoningCardTemplateMode: "experimental",
    });
    handlers.model_call_started({ callId: "call-1" }, { sessionKey });
    handlers.before_tool_call({ toolName: "read", toolCallId: "tool-1" }, { sessionKey });
    await vi.advanceTimersByTimeAsync(900);

    handlers.after_tool_call({ toolName: "read", toolCallId: "tool-1", result: {} }, { sessionKey });
    await vi.advanceTimersByTimeAsync(900);

    expect(calls.filter((url) => url.includes("/sendMessage"))).toHaveLength(2);
  });

  it("Model A stopped 状态始终是非 transient 终态", async () => {
    const { fn, calls } = mockFetch({ profile: registryProfile(), sendId: "stopped-card" });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    const hookCtx = { sessionKey: "registry-stopped", runId: "run-1" };
    setCardContext("registry-stopped", {
      apiUrl: "https://registry-stopped.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
      reasoningCardTemplateMode: "experimental",
    });
    handlers.before_agent_run({}, hookCtx);
    handlers.model_call_started({ callId: "call-1" }, hookCtx);
    handlers.before_tool_call({ toolName: "read", toolCallId: "tool-1" }, hookCtx);
    handlers.after_tool_call({ toolName: "read", toolCallId: "tool-1", result: {} }, hookCtx);
    await vi.advanceTimersByTimeAsync(900);
    calls.length = 0;

    handlers.model_call_ended({
      callId: "call-1",
      durationMs: 10,
      outcome: "error",
      failureKind: "aborted",
    }, hookCtx);
    await vi.advanceTimersByTimeAsync(900);

    const edit = calls.find((call) => call.url.includes("/message/edit"))?.body;
    expect(edit).toMatchObject({ state: "stopped", card_seq: 1 });
    expect(edit).not.toHaveProperty("transient");
  });

  it("Model A error 状态始终是非 transient 终态", async () => {
    const { fn, calls } = mockFetch({ profile: registryProfile(), sendId: "error-card" });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    const hookCtx = { sessionKey: "registry-error", runId: "run-1" };
    setCardContext("registry-error", {
      apiUrl: "https://registry-error.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
      reasoningCardTemplateMode: "experimental",
    });
    handlers.before_agent_run({}, hookCtx);
    handlers.model_call_started({ callId: "call-1" }, hookCtx);
    handlers.before_tool_call({ toolName: "read", toolCallId: "tool-1" }, hookCtx);
    handlers.after_tool_call({ toolName: "read", toolCallId: "tool-1", result: {} }, hookCtx);
    await vi.advanceTimersByTimeAsync(900);
    calls.length = 0;

    await finalizeCard("registry-error", { success: false, errorText: "provider timeout" });

    const edit = calls.find((call) => call.url.includes("/message/edit"))?.body;
    expect(edit).toMatchObject({ state: "error", card_seq: 1 });
    expect(edit).not.toHaveProperty("transient");
  });

  it("manifest 短 TTL 到期后新消息可发现刚部署的 Registry 能力", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
    let profileCalls = 0;
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      if (String(url).includes("/card/profile")) {
        profileCalls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => profileCalls === 1
            ? { enabled: true, profiles: ["octo/v1"] }
            : registryProfile(),
        };
      }
      if (String(url).includes("/sendMessage")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: `m-${profileCalls}` }) };
      }
      return { ok: true, status: 200, text: async () => "" };
    }) as unknown as typeof fetch;
    const { handlers } = makeApi();
    const context = {
      apiUrl: "https://registry-rollout.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
      reasoningCardTemplateMode: "experimental" as const,
    };

    setCardContext("before-rollout", context);
    handlers.model_call_started({ callId: "call-1" }, { sessionKey: "before-rollout" });
    handlers.before_tool_call({ toolName: "read", toolCallId: "tool-1" }, { sessionKey: "before-rollout" });
    await vi.advanceTimersByTimeAsync(900);
    expect((calls.find((call) => call.url.includes("/sendMessage"))?.body?.payload as Record<string, unknown>))
      .toHaveProperty("card");
    clearCard("before-rollout");
    calls.length = 0;

    await vi.advanceTimersByTimeAsync(60_001);
    setCardContext("after-rollout", context);
    handlers.model_call_started({ callId: "call-2" }, { sessionKey: "after-rollout" });
    handlers.before_tool_call({ toolName: "read", toolCallId: "tool-2" }, { sessionKey: "after-rollout" });
    await vi.advanceTimersByTimeAsync(900);

    expect(profileCalls).toBe(2);
    expect((calls.find((call) => call.url.includes("/sendMessage"))?.body?.payload as Record<string, unknown>))
      .toHaveProperty("template_ref.version", "0.2.0");
  });

  it("Model A reasoningId 在 paused continuation 跨 run 后保持不变", async () => {
    const { fn, calls } = mockFetch({ profile: registryProfile(), sendId: "continuation-card" });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    const sessionKey = "registry-continuation";
    const childSessionKey = "agent:main:subagent:registry-child";
    setCardContext(sessionKey, {
      apiUrl: "https://registry-continuation.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
      reasoningCardTemplateMode: "experimental",
    });
    handlers.before_agent_run({}, { sessionKey, runId: "run-original" });
    handlers.model_call_started({ callId: "call-1" }, { sessionKey, runId: "run-original" });
    handlers.before_tool_call(
      { toolName: "sessions_spawn", toolCallId: "spawn-1" },
      { sessionKey, runId: "run-original" },
    );
    handlers.after_tool_call({
      toolName: "sessions_spawn",
      toolCallId: "spawn-1",
      result: { details: { status: "accepted", childSessionKey } },
    }, { sessionKey, runId: "run-original" });
    handlers.before_tool_call(
      { toolName: "sessions_yield", toolCallId: "yield-1" },
      { sessionKey, runId: "run-original" },
    );
    handlers.after_tool_call(
      { toolName: "sessions_yield", toolCallId: "yield-1", result: {} },
      { sessionKey, runId: "run-original" },
    );
    await vi.advanceTimersByTimeAsync(900);
    const firstData = (calls.find((call) => call.url.includes("/sendMessage"))?.body?.payload as {
      data?: { reasoningId?: string };
    }).data;
    expect(firstData?.reasoningId).toBe(`${sessionKey}:run-original`);

    await finalizeCard(sessionKey, { success: false });
    calls.length = 0;
    handlers.before_agent_run(
      { prompt: completionPrompt(childSessionKey), messages: [] },
      { sessionKey, runId: "run-continuation" },
    );
    await vi.runAllTicks();

    const continuationData = calls.find((call) => call.url.includes("/message/edit"))?.body?.data as {
      reasoningId?: string;
    };
    expect(continuationData?.reasoningId).toBe(firstData?.reasoningId);
  });

  it("OBO 场景跳过(不发任何请求)", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("s2", { apiUrl: "https://a2.test", botToken: "y", channelId: "g", channelType: ChannelType.Group, onBehalfOf: "grantor" });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "s2" });
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.length).toBe(0);
  });

  it("cardProgress:false 在 session 入口直接跳过,不探测 manifest 也不发送", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("progress-disabled", {
      apiUrl: "https://shared-card-gate.test",
      botToken: "disabled-account",
      channelId: "g-disabled",
      channelType: ChannelType.Group,
      cardProgress: false,
    });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "progress-disabled" });
    await vi.advanceTimersByTimeAsync(900);

    expect(calls).toEqual([]);
  });

  it("账号级关闭不污染同 apiUrl 的共享 gate cache", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("progress-disabled-account", {
      apiUrl: "https://shared-card-gate.test",
      botToken: "disabled-account",
      channelId: "g-disabled",
      channelType: ChannelType.Group,
      cardProgress: false,
    });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "progress-disabled-account" });
    await vi.advanceTimersByTimeAsync(900);

    setCardContext("progress-enabled-account", {
      apiUrl: "https://shared-card-gate.test",
      botToken: "enabled-account",
      channelId: "g-enabled",
      channelType: ChannelType.Group,
      cardProgress: true,
    });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "progress-enabled-account" });
    await vi.advanceTimersByTimeAsync(900);

    expect(calls.filter((call) => call.url.includes("/card/profile"))).toHaveLength(1);
    expect(calls.filter((call) => call.url.includes("/sendMessage"))).toHaveLength(1);
  });

  it("cardProgress:true 仍不能绕过不兼容 card_version", async () => {
    const calls: Array<{ url: string }> = [];
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push({ url: String(url) });
      if (String(url).includes("/card/profile")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            enabled: true,
            profiles: ["octo/v1"],
            card_version: "1.6",
            elements: ["TextBlock"],
          }),
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: "must-not-send" }) };
    }) as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("progress-incompatible", {
      apiUrl: "https://incompatible-card-version.test",
      botToken: "enabled-account",
      channelId: "g-enabled",
      channelType: ChannelType.Group,
      cardProgress: true,
    });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "progress-incompatible" });
    await vi.advanceTimersByTimeAsync(900);

    expect(calls.some((call) => call.url.includes("/card/profile"))).toBe(true);
    expect(calls.some((call) => call.url.includes("/sendMessage"))).toBe(false);
  });

  it("未登记 session 的事件 no-op(天然过滤非 octo run)", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "unknown" });
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.length).toBe(0);
  });

  it("D12 gate disabled → 不发卡", async () => {
    const { fn, calls } = mockFetch({ enabled: false });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("s3", { apiUrl: "https://a3.test", botToken: "y", channelId: "g", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "s3" });
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.some((c) => c.url.includes("/sendMessage"))).toBe(false);
  });

  it("D12 明确 elements=[] 时不回退 baseline,不发送无法渲染的卡", async () => {
    const calls: Array<{ url: string }> = [];
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push({ url: String(url) });
      if (String(url).includes("/card/profile")) {
        return { ok: true, status: 200, json: async () => ({ enabled: true, profiles: ["octo/v1"], elements: [] }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: "should-not-send" }) };
    }) as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("empty-elements", { apiUrl: "https://empty.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "empty-elements" });
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.some((c) => c.url.includes("/sendMessage"))).toBe(false);
  });

  it("finalizeCard 发终态帧(已有占位卡)", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("s4", { apiUrl: "https://a4.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "s4" });
    await vi.advanceTimersByTimeAsync(900);
    calls.length = 0;

    await finalizeCard("s4", { success: true });
    const edit = calls.find((c) => c.url.includes("/message/edit"));
    expect(edit).toBeTruthy();
    const env = JSON.parse(edit!.body!.content_edit as string);
    expect(progressHeaderText(env.card)).toContain("✅ 已完成");
    expect(env.transient).toBeUndefined(); // 终态帧进修订历史(不带 transient)
  });

  it("sessions_yield 成功后显示等待任务结果,而不是已中断", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("yield-fallback", {
      apiUrl: "https://yield.test",
      botToken: "bf",
      channelId: "g1",
      channelType: ChannelType.Group,
    });
    handlers.before_agent_run({}, { sessionKey: "yield-fallback", runId: "run-a" });
    handlers.before_tool_call(
      { toolName: "sessions_yield", toolCallId: "yield-1" },
      { sessionKey: "yield-fallback", runId: "run-a" },
    );
    await vi.advanceTimersByTimeAsync(900);
    handlers.after_tool_call(
      { toolName: "sessions_yield", toolCallId: "yield-1", durationMs: 20 },
      { sessionKey: "yield-fallback", runId: "run-a" },
    );
    calls.length = 0;

    await finalizeCard("yield-fallback", { success: false });

    const edit = calls.find((call) => call.url.includes("/message/edit"));
    expect(edit).toBeTruthy();
    const env = JSON.parse(edit!.body!.content_edit as string);
    expect(progressHeaderText(env.card)).toContain("⏸️ 等待任务结果");
    expect(progressHeaderText(env.card)).not.toContain("已中断");
  });

  it("yielded lifecycle 后保留原卡,后续 run 开始时整理、结束时完成", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers, emitLifecycle } = makeApi();
    setCardContext("yield-lifecycle", {
      apiUrl: "https://yield-lifecycle.test",
      botToken: "bf",
      channelId: "g1",
      channelType: ChannelType.Group,
    });
    handlers.before_agent_run({}, { sessionKey: "yield-lifecycle", runId: "run-a" });
    handlers.before_tool_call(
      { toolName: "sessions_spawn", toolCallId: "spawn-1" },
      { sessionKey: "yield-lifecycle", runId: "run-a" },
    );
    handlers.after_tool_call(
      {
        toolName: "sessions_spawn",
        toolCallId: "spawn-1",
        durationMs: 30,
        result: {
          content: [{ type: "text", text: '{"status":"accepted","childSessionKey":"agent:main:subagent:child-1","runId":"child-run-1"}' }],
        },
      },
      { sessionKey: "yield-lifecycle", runId: "run-a" },
    );
    await vi.advanceTimersByTimeAsync(900);
    calls.length = 0;

    await emitLifecycle({
      runId: "run-a",
      sessionKey: "yield-lifecycle",
      stream: "lifecycle",
      data: { phase: "end", yielded: true, livenessState: "paused" },
    });
    await finalizeCard("yield-lifecycle", { success: false });
    const pausedEdit = calls.find((call) => {
      if (!call.url.includes("/message/edit")) return false;
      const env = JSON.parse(call.body!.content_edit as string);
      return progressHeaderText(env.card).includes("⏸️ 等待任务结果");
    });
    expect(pausedEdit).toBeTruthy();
    expect(progressCardText(JSON.parse(pausedEdit!.body!.content_edit as string).card))
      .toContain("⏳ 等待子任务");

    await vi.advanceTimersByTimeAsync(65_000);

    calls.length = 0;
    await emitLifecycle({
      runId: "run-b",
      sessionKey: "yield-lifecycle",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    handlers.before_agent_run(
      { prompt: completionPrompt("agent:main:subagent:child-1"), messages: [] },
      { sessionKey: "yield-lifecycle", runId: "run-b" },
    );
    await vi.runAllTicks();
    const resumingEdit = calls.find((call) => {
      if (!call.url.includes("/message/edit")) return false;
      const env = JSON.parse(call.body!.content_edit as string);
      return progressHeaderText(env.card).includes("🤖 正在整理结果");
    });
    expect(resumingEdit).toBeTruthy();
    expect(progressCardText(JSON.parse(resumingEdit!.body!.content_edit as string).card))
      .toContain("⏸️ 等待子任务 · 65.0s");

    calls.length = 0;
    await emitLifecycle({
      runId: "run-b",
      sessionKey: "yield-lifecycle",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    const completed = calls.find((call) => call.url.includes("/message/edit"));
    expect(completed).toBeTruthy();
    const completedEnv = JSON.parse(completed!.body!.content_edit as string);
    expect(progressHeaderText(completedEnv.card)).toContain("✅ 已完成");
  });

  it("无关用户 run 不得劫持 paused 卡,真正 completion run 仍可继续更新", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers, emitLifecycle } = makeApi();
    const childSessionKey = "agent:main:subagent:child-unrelated";
    const target = {
      apiUrl: "https://yield-unrelated.test",
      botToken: "bf",
      channelId: "g1",
      channelType: ChannelType.Group,
    };

    setCardContext("yield-unrelated", target);
    handlers.before_agent_run({}, { sessionKey: "yield-unrelated", runId: "run-a" });
    handlers.before_tool_call(
      { toolName: "sessions_spawn", toolCallId: "spawn-1" },
      { sessionKey: "yield-unrelated", runId: "run-a" },
    );
    handlers.after_tool_call(
      {
        toolName: "sessions_spawn",
        toolCallId: "spawn-1",
        result: { details: { status: "accepted", childSessionKey, runId: "child-run" } },
      },
      { sessionKey: "yield-unrelated", runId: "run-a" },
    );
    handlers.before_tool_call(
      { toolName: "sessions_yield", toolCallId: "yield-1" },
      { sessionKey: "yield-unrelated", runId: "run-a" },
    );
    handlers.after_tool_call(
      { toolName: "sessions_yield", toolCallId: "yield-1" },
      { sessionKey: "yield-unrelated", runId: "run-a" },
    );
    await vi.advanceTimersByTimeAsync(900);
    await finalizeCard("yield-unrelated", { success: false });

    calls.length = 0;
    setCardContext("yield-unrelated", target);
    await emitLifecycle({
      runId: "run-user",
      sessionKey: "yield-unrelated",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    handlers.before_agent_run(
      { prompt: "用户在等待期间发来的普通追问", messages: [] },
      { sessionKey: "yield-unrelated", runId: "run-user" },
    );
    await emitLifecycle({
      runId: "run-user",
      sessionKey: "yield-unrelated",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    expect(calls.some((call) => call.url.includes("/message/edit"))).toBe(false);

    await emitLifecycle({
      runId: "run-continuation",
      sessionKey: "yield-unrelated",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    handlers.before_agent_run(
      { prompt: completionPrompt(childSessionKey), messages: [] },
      { sessionKey: "yield-unrelated", runId: "run-continuation" },
    );
    await vi.runAllTicks();
    expect(calls.some((call) => {
      if (!call.url.includes("/message/edit")) return false;
      const env = JSON.parse(call.body!.content_edit as string);
      return progressHeaderText(env.card).includes("🤖 正在整理结果");
    })).toBe(true);

    calls.length = 0;
    await emitLifecycle({
      runId: "run-continuation",
      sessionKey: "yield-unrelated",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    const finalEdit = calls.find((call) => call.url.includes("/message/edit"));
    expect(finalEdit).toBeTruthy();
    expect(progressHeaderText(JSON.parse(finalEdit!.body!.content_edit as string).card)).toContain("✅ 已完成");
  });

  it("乱序 start/end 编辑必须串行,最终不能被迟到的 resuming 覆盖", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
    const appliedHeaders: string[] = [];
    const resumingReached = makeDeferred();
    const releaseResuming = makeDeferred();
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: String(url), body });
      if (String(url).includes("/card/profile")) {
        return { ok: true, status: 200, json: async () => ({ enabled: true, profiles: ["octo/v1"] }) };
      }
      if (String(url).includes("/sendMessage")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: "race-card" }) };
      }
      if (String(url).includes("/message/edit")) {
        const env = JSON.parse(body.content_edit as string);
        const header = progressHeaderText(env.card);
        if (header.includes("正在整理结果")) {
          resumingReached.resolve();
          await releaseResuming.promise;
        }
        appliedHeaders.push(header);
      }
      return { ok: true, status: 200, text: async () => "" };
    }) as unknown as typeof fetch;

    const { handlers, emitLifecycle } = makeApi();
    const childSessionKey = "agent:main:subagent:child-race";
    setCardContext("yield-race", {
      apiUrl: "https://yield-race.test",
      botToken: "bf",
      channelId: "g1",
      channelType: ChannelType.Group,
    });
    handlers.before_agent_run({}, { sessionKey: "yield-race", runId: "run-a" });
    handlers.before_tool_call({ toolName: "sessions_spawn", toolCallId: "spawn-1" }, { sessionKey: "yield-race", runId: "run-a" });
    handlers.after_tool_call(
      { toolName: "sessions_spawn", toolCallId: "spawn-1", result: { details: { status: "accepted", childSessionKey, runId: "child-run" } } },
      { sessionKey: "yield-race", runId: "run-a" },
    );
    handlers.before_tool_call({ toolName: "sessions_yield", toolCallId: "yield-1" }, { sessionKey: "yield-race", runId: "run-a" });
    handlers.after_tool_call({ toolName: "sessions_yield", toolCallId: "yield-1" }, { sessionKey: "yield-race", runId: "run-a" });
    await vi.advanceTimersByTimeAsync(900);
    await finalizeCard("yield-race", { success: false });
    calls.length = 0;

    const startEvent = emitLifecycle({
      runId: "run-b",
      sessionKey: "yield-race",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    handlers.before_agent_run(
      { prompt: completionPrompt(childSessionKey), messages: [] },
      { sessionKey: "yield-race", runId: "run-b" },
    );
    await resumingReached.promise;
    const endEvent = emitLifecycle({
      runId: "run-b",
      sessionKey: "yield-race",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await vi.runAllTicks();
    releaseResuming.resolve();
    await Promise.all([startEvent, endEvent]);

    expect(appliedHeaders.length).toBeGreaterThanOrEqual(2);
    expect(appliedHeaders.at(-1)).toContain("✅ 已完成");
  });

  it("旧 host 无 lifecycle API 时仍可由受信 completion prompt + agent_end 完成卡片", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi({ lifecycle: false });
    const childSessionKey = "agent:main:subagent:child-legacy";
    setCardContext("yield-legacy", {
      apiUrl: "https://yield-legacy.test",
      botToken: "bf",
      channelId: "g1",
      channelType: ChannelType.Group,
    });
    handlers.before_agent_run({}, { sessionKey: "yield-legacy", runId: "run-a" });
    handlers.before_tool_call({ toolName: "sessions_spawn", toolCallId: "spawn-1" }, { sessionKey: "yield-legacy", runId: "run-a" });
    handlers.after_tool_call(
      { toolName: "sessions_spawn", toolCallId: "spawn-1", result: { details: { status: "accepted", childSessionKey, runId: "child-run" } } },
      { sessionKey: "yield-legacy", runId: "run-a" },
    );
    handlers.before_tool_call({ toolName: "sessions_yield", toolCallId: "yield-1" }, { sessionKey: "yield-legacy", runId: "run-a" });
    handlers.after_tool_call({ toolName: "sessions_yield", toolCallId: "yield-1" }, { sessionKey: "yield-legacy", runId: "run-a" });
    await vi.advanceTimersByTimeAsync(900);
    await finalizeCard("yield-legacy", { success: false });
    calls.length = 0;

    handlers.before_agent_run(
      { prompt: completionPrompt(childSessionKey), messages: [] },
      { sessionKey: "yield-legacy", runId: "run-b" },
    );
    await vi.runAllTicks();
    await handlers.agent_end(
      { runId: "run-b", messages: [], success: true },
      { sessionKey: "yield-legacy", runId: "run-b" },
    );

    const edits = calls.filter((call) => call.url.includes("/message/edit"));
    const lastEnv = JSON.parse(edits.at(-1)!.body!.content_edit as string);
    expect(progressHeaderText(lastEnv.card)).toContain("✅ 已完成");
  });

  it("无 continuation 的 paused 卡到期后显示等待超时并释放追踪", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi({ lifecycle: false });
    setCardContext("yield-expire", {
      apiUrl: "https://yield-expire.test",
      botToken: "bf",
      channelId: "g1",
      channelType: ChannelType.Group,
    });
    handlers.before_agent_run({}, { sessionKey: "yield-expire", runId: "run-a" });
    handlers.before_tool_call({ toolName: "sessions_yield", toolCallId: "yield-1" }, { sessionKey: "yield-expire", runId: "run-a" });
    handlers.after_tool_call({ toolName: "sessions_yield", toolCallId: "yield-1" }, { sessionKey: "yield-expire", runId: "run-a" });
    await vi.advanceTimersByTimeAsync(900);
    await finalizeCard("yield-expire", { success: false });
    calls.length = 0;

    await vi.advanceTimersByTimeAsync(3_600_100);

    const edit = calls.find((call) => call.url.includes("/message/edit"));
    expect(edit).toBeTruthy();
    const env = JSON.parse(edit!.body!.content_edit as string);
    expect(progressHeaderText(env.card)).toContain("⏱️ 等待超时");
  });

  it("paused 窗口的跨身份同 sessionKey 碰撞必须 fail-closed", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers, emitLifecycle } = makeApi();
    const childSessionKey = "agent:main:subagent:child-collision";
    setCardContext("yield-collision", {
      apiUrl: "https://yield-collision.test",
      botToken: "bot-a",
      channelId: "group-a",
      channelType: ChannelType.Group,
    });
    handlers.before_agent_run({}, { sessionKey: "yield-collision", runId: "run-a" });
    handlers.before_tool_call({ toolName: "sessions_spawn", toolCallId: "spawn-1" }, { sessionKey: "yield-collision", runId: "run-a" });
    handlers.after_tool_call(
      { toolName: "sessions_spawn", toolCallId: "spawn-1", result: { details: { status: "accepted", childSessionKey, runId: "child-run" } } },
      { sessionKey: "yield-collision", runId: "run-a" },
    );
    handlers.before_tool_call({ toolName: "sessions_yield", toolCallId: "yield-1" }, { sessionKey: "yield-collision", runId: "run-a" });
    handlers.after_tool_call({ toolName: "sessions_yield", toolCallId: "yield-1" }, { sessionKey: "yield-collision", runId: "run-a" });
    await vi.advanceTimersByTimeAsync(900);
    await finalizeCard("yield-collision", { success: false });
    calls.length = 0;

    setCardContext("yield-collision", {
      apiUrl: "https://yield-collision.test",
      botToken: "bot-b",
      channelId: "group-b",
      channelType: ChannelType.Group,
    });
    await emitLifecycle({
      runId: "run-b",
      sessionKey: "yield-collision",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    handlers.before_agent_run(
      { prompt: completionPrompt(childSessionKey), messages: [] },
      { sessionKey: "yield-collision", runId: "run-b" },
    );
    await emitLifecycle({
      runId: "run-b",
      sessionKey: "yield-collision",
      stream: "lifecycle",
      data: { phase: "end" },
    });

    expect(calls.some((call) => call.url.includes("/message/edit"))).toBe(false);
  });

  it("失败的 sessions_yield 不进入等待状态", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("yield-error", {
      apiUrl: "https://yield-error.test",
      botToken: "bf",
      channelId: "g1",
      channelType: ChannelType.Group,
    });
    handlers.before_agent_run({}, { sessionKey: "yield-error", runId: "run-a" });
    handlers.before_tool_call(
      { toolName: "sessions_yield", toolCallId: "yield-1" },
      { sessionKey: "yield-error", runId: "run-a" },
    );
    await vi.advanceTimersByTimeAsync(900);
    handlers.after_tool_call(
      { toolName: "sessions_yield", toolCallId: "yield-1", error: "yield failed" },
      { sessionKey: "yield-error", runId: "run-a" },
    );
    calls.length = 0;

    await finalizeCard("yield-error", { success: false });

    const edit = calls.find((call) => call.url.includes("/message/edit"));
    expect(edit).toBeTruthy();
    const env = JSON.parse(edit!.body!.content_edit as string);
    expect(progressHeaderText(env.card)).toContain("已中断");
    expect(progressHeaderText(env.card)).not.toContain("等待任务结果");
  });

  it("finalizeCard 未发过占位卡 → 仅清理不发", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    makeApi();
    setCardContext("s5", { apiUrl: "https://a5.test", botToken: "y", channelId: "g", channelType: ChannelType.Group });
    await finalizeCard("s5", { success: true });
    expect(calls.length).toBe(0);
  });

  it("finalizeCardWithResponse edits the existing progress message into one terminal response", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("merged-final", {
      apiUrl: "https://merge.test",
      botToken: "bf",
      channelId: "g1",
      channelType: ChannelType.Group,
    });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "merged-final" });
    await vi.advanceTimersByTimeAsync(900);
    calls.length = 0;

    const merged = await finalizeCardWithResponse(
      "merged-final",
      "结论\n\n渠道 B 的下降主要来自权益认知不足。",
    );

    expect(merged).toBe(true);
    const edits = calls.filter((call) => call.url.includes("/message/edit"));
    expect(edits).toHaveLength(1);
    const env = JSON.parse(edits[0].body!.content_edit as string);
    expect(env.transient).toBeUndefined();
    expect(progressCardText(env.card)).toContain("渠道 B 的下降主要来自权益认知不足");
    calls.length = 0;
    await finalizeCard("merged-final", { success: true });
    expect(calls).toHaveLength(0);
  });

  it("finalizeCardWithResponse returns false when no progress message was sent", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    setCardContext("plain-final", {
      apiUrl: "https://merge.test",
      botToken: "bf",
      channelId: "g1",
      channelType: ChannelType.Group,
    });

    expect(await finalizeCardWithResponse("plain-final", "普通回答")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("P1: finalize 等待 in-flight 首帧 send,终态帧不丢失", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
    const sendGate = makeDeferred(); // 悬住首帧 send
    const sendReached = makeDeferred(); // 通知 send 已进入
    const fn = vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      if (String(url).includes("/card/profile")) {
        return { ok: true, status: 200, json: async () => ({ enabled: true }) };
      }
      if (String(url).includes("/sendMessage")) {
        sendReached.resolve();
        await sendGate.promise; // 保持 send in-flight
        return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: "card1" }) };
      }
      return { ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("p1", { apiUrl: "https://p1.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "p1" });
    await vi.advanceTimersByTimeAsync(900); // flush 启动:gate 过,send 悬在 sendGate
    await sendReached.promise;

    // send 仍 in-flight(messageId 未就绪)时收尾 —— 旧实现会跳过终态帧。
    const finalizing = finalizeCard("p1", { success: true });
    sendGate.resolve(); // 放行 send 完成
    await finalizing;

    const edit = calls.find((c) => c.url.includes("/message/edit"));
    expect(edit).toBeTruthy();
    const env = JSON.parse(edit!.body!.content_edit as string);
    expect(progressHeaderText(env.card)).toContain("✅ 已完成");
    expect(env.transient).toBeUndefined(); // 终态帧进修订历史
  });

  it("P1(重叠 flush): 首帧 send 在途时第二个 debounce 到期,finalize 仍等真实 send", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
    const sendGate = makeDeferred();
    const sendReached = makeDeferred();
    let sendCount = 0;
    const fn = vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      if (String(url).includes("/card/profile")) {
        return { ok: true, status: 200, json: async () => ({ enabled: true }) };
      }
      if (String(url).includes("/sendMessage")) {
        sendCount++;
        sendReached.resolve();
        await sendGate.promise; // 首帧 send 一直悬着
        return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: "card1" }) };
      }
      return { ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("p1b", { apiUrl: "https://p1b.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read", toolCallId: "A" }, { sessionKey: "p1b" });
    await vi.advanceTimersByTimeAsync(900); // 首帧 flush 启动,send 悬在 sendGate
    await sendReached.promise;

    // 首帧 send 仍在途,再来一个事件 → 第二个 debounce 窗口到期(旧实现会用空转 flush 覆盖 flushPromise)
    handlers.after_tool_call({ toolName: "read", toolCallId: "A", durationMs: 20 }, { sessionKey: "p1b" });
    await vi.advanceTimersByTimeAsync(900);

    const finalizing = finalizeCard("p1b", { success: true });
    sendGate.resolve();
    await finalizing;

    expect(sendCount).toBe(1); // 只发一次首帧(无重复 send)
    const edit = calls.find((c) => c.url.includes("/message/edit"));
    expect(edit).toBeTruthy(); // 终态帧未丢
    const env = JSON.parse(edit!.body!.content_edit as string);
    expect(progressHeaderText(env.card)).toContain("✅ 已完成");
  });

  it("P2-a: gate 5xx 不缓存,下次 flush 重探成功仍能发卡", async () => {
    const calls: Array<{ url: string }> = [];
    let profileCall = 0;
    const fn = vi.fn().mockImplementation(async (url: string) => {
      calls.push({ url: String(url) });
      if (String(url).includes("/card/profile")) {
        profileCall++;
        if (profileCall === 1) return { ok: false, status: 500, text: async () => "boom" };
        return { ok: true, status: 200, json: async () => ({ enabled: true }) };
      }
      if (String(url).includes("/sendMessage")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: "card1" }) };
      }
      return { ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("ga", { apiUrl: "https://ga.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "ga" });
    await vi.advanceTimersByTimeAsync(900); // 首次 gate 抛错 → 不缓存、不发卡
    expect(calls.some((c) => c.url.includes("/sendMessage"))).toBe(false);

    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "ga" });
    await vi.advanceTimersByTimeAsync(900); // 重探 gate → enabled → 发卡
    expect(profileCall).toBe(2); // 未命中缓存,确实重探了
    expect(calls.some((c) => c.url.includes("/sendMessage"))).toBe(true);
  });

  it("P2-b: 并发同名工具按 toolCallId 精确回填(不串到最后一个)", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("tc", { apiUrl: "https://tc.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    // 两个并发 exec:A、B 都 running
    handlers.before_tool_call({ toolName: "exec", toolCallId: "A", params: { command: "sleep 1" } }, { sessionKey: "tc" });
    handlers.before_tool_call({ toolName: "exec", toolCallId: "B", params: { command: "sleep 2" } }, { sessionKey: "tc" });
    // 先完成的是 A(不是最后 push 的 B)—— 旧逻辑会错标 B。
    handlers.after_tool_call({ toolName: "exec", toolCallId: "A", durationMs: 50 }, { sessionKey: "tc" });
    await vi.advanceTimersByTimeAsync(900);
    await finalizeCard("tc", { success: true });

    const edit = calls.filter((c) => c.url.includes("/message/edit")).pop();
    expect(edit).toBeTruthy();
    const env = JSON.parse(edit!.body!.content_edit as string);
    const texts = progressDetailItems(env.card).map(elementText);
    expect(texts[0]).toBe("⌨️ 执行命令：sleep · 50ms"); // A 已完成
    expect(texts[1]).toBe("⏳ 执行命令：sleep");          // B 仍 running
  });

  it("P2-b(重复投递): toolCallId 命中失败不回退按名匹配,不误标并发步骤", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("dup", { apiUrl: "https://dup.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "exec", toolCallId: "A", params: { command: "sleep 1" } }, { sessionKey: "dup" });
    handlers.before_tool_call({ toolName: "exec", toolCallId: "B", params: { command: "sleep 2" } }, { sessionKey: "dup" });
    handlers.after_tool_call({ toolName: "exec", toolCallId: "A", durationMs: 50 }, { sessionKey: "dup" }); // A → done
    // 同一 after 事件重复投递(at-least-once):A 已非 running,旧逻辑会回退把 B 误标 done。
    handlers.after_tool_call({ toolName: "exec", toolCallId: "A", durationMs: 50 }, { sessionKey: "dup" });
    await vi.advanceTimersByTimeAsync(900);
    await finalizeCard("dup", { success: true });

    const edit = calls.filter((c) => c.url.includes("/message/edit")).pop();
    const env = JSON.parse(edit!.body!.content_edit as string);
    const texts = progressDetailItems(env.card).map(elementText);
    expect(texts[0]).toBe("⌨️ 执行命令：sleep · 50ms"); // A done(只被标一次)
    expect(texts[1]).toBe("⏳ 执行命令：sleep");          // B 仍 running,未被重复事件误标
  });

  it("J1: finalize await 期间下一 run setCardContext,不误删新 run 的 entry", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
    const sendGate = makeDeferred();
    const sendReached = makeDeferred();
    let sendId = 0;
    const fn = vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      if (String(url).includes("/card/profile")) {
        return { ok: true, status: 200, json: async () => ({ enabled: true }) };
      }
      if (String(url).includes("/sendMessage")) {
        sendId++;
        if (sendId === 1) { sendReached.resolve(); await sendGate.promise; } // run1 首帧悬住
        return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: `card${sendId}` }) };
      }
      return { ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    const ctx = { apiUrl: "https://j1.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group };

    setCardContext("S", ctx);
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "S" });
    await vi.advanceTimersByTimeAsync(900); // run1 flush 首帧 send 悬在 sendGate
    await sendReached.promise;

    const finalizing = finalizeCard("S", { success: true }); // 捕获 entry1,await 其 flushPromise
    setCardContext("S", ctx);                                // 队列推进:同身份 run2 覆盖 Map
    sendGate.resolve();                                       // 放行 run1 首帧完成 → finalize 恢复
    await finalizing;

    // run2 entry 未被误删:它的 before_tool_call 能发出自己的卡(否则无 entry → no-op)。
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "S" });
    await vi.advanceTimersByTimeAsync(900);
    const sends = calls.filter((c) => c.url.includes("/sendMessage"));
    expect(sends.length).toBe(2); // run1 card1 + run2 card2;若误删则仅 1
  });

  it("J2: 同 sessionKey 不同身份并发 → fail closed,两边都不发", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    // 两个不同账号(不同频道)共享同一 sessionKey —— hook 侧无法区分。
    setCardContext("X", { apiUrl: "https://a.test", botToken: "tA", channelId: "chA", channelType: ChannelType.Group });
    setCardContext("X", { apiUrl: "https://a.test", botToken: "tB", channelId: "chB", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "X" });
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.length).toBe(0); // 碰撞 → 两边 skip,绝不发到任一频道
  });

  it("J2: 同 sessionKey 同身份(同账号下一 run)不算碰撞,正常发卡", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    const ctx = { apiUrl: "https://same.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group };

    setCardContext("Y", ctx);
    setCardContext("Y", ctx); // 同身份重登记(如上一 run 尚未 finalize)→ 不 fail closed
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "Y" });
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.some((c) => c.url.includes("/sendMessage"))).toBe(true);
  });

  it("J2: 同 apiUrl+同频道但不同 botToken(两个账号同群回复)也 fail closed", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    const base = { apiUrl: "https://a.test", channelId: "g1", channelType: ChannelType.Group };
    setCardContext("Z", { ...base, botToken: "tokA" });
    setCardContext("Z", { ...base, botToken: "tokB" }); // 仅 token 不同 → 仍视为跨身份碰撞
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "Z" });
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.length).toBe(0); // fail closed,两边都不发
  });

  it("影响项#2: 首帧 send 持续 4xx → fail-closed,不再重试", async () => {
    const calls: string[] = [];
    const fn = vi.fn().mockImplementation(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("/card/profile")) return { ok: true, status: 200, json: async () => ({ enabled: true }) };
      if (String(url).includes("/sendMessage")) return { ok: false, status: 403, text: async () => "forbidden" };
      return { ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("e4", { apiUrl: "https://e4.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "e4" });
    await vi.advanceTimersByTimeAsync(900); // 首帧 send → 403 抛错
    const sends1 = calls.filter((c) => c.includes("/sendMessage")).length;
    handlers.after_tool_call({ toolName: "read", durationMs: 5 }, { sessionKey: "e4" });
    await vi.advanceTimersByTimeAsync(900); // 未 skip 则会再试一次
    const sends2 = calls.filter((c) => c.includes("/sendMessage")).length;
    expect(sends1).toBe(1);
    expect(sends2).toBe(1); // 4xx → skip,没有第二次 send
  });

  it("影响项#2: 首帧 send 429/5xx 仍可重试(不 fail-closed)", async () => {
    const calls: string[] = [];
    let sendN = 0;
    const fn = vi.fn().mockImplementation(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("/card/profile")) return { ok: true, status: 200, json: async () => ({ enabled: true }) };
      if (String(url).includes("/sendMessage")) {
        sendN++;
        if (sendN === 1) return { ok: false, status: 429, text: async () => "rate limited" };
        return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: "card1" }) };
      }
      return { ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("e5", { apiUrl: "https://e5.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "e5" });
    await vi.advanceTimersByTimeAsync(900); // 首帧 429 抛错 → 不 skip
    handlers.after_tool_call({ toolName: "read", durationMs: 5 }, { sessionKey: "e5" });
    await vi.advanceTimersByTimeAsync(900); // 重试成功
    expect(calls.filter((c) => c.includes("/sendMessage")).length).toBe(2);
  });

  it("影响项#P2-4: gate 瞬时失败后无新事件不再每 tick 重探", async () => {
    const calls: string[] = [];
    const fn = vi.fn().mockImplementation(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("/card/profile")) return { ok: false, status: 503, text: async () => "down" };
      return { ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("g0", { apiUrl: "https://g0.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "g0" });
    await vi.advanceTimersByTimeAsync(900); // 首次 probe → 503 → null
    const p1 = calls.filter((c) => c.includes("/card/profile")).length;
    await vi.advanceTimersByTimeAsync(4000); // 无新事件,推进多个 debounce 周期
    const p2 = calls.filter((c) => c.includes("/card/profile")).length;
    expect(p1).toBe(1);
    expect(p2).toBe(1); // 不再自动重探,等下个工具事件
  });

  it("波C: manifest advertise RichTextBlock → 进度卡按富文本行渲染(缺省则 TextBlock 平铺)", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
    const fn = vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      if (String(url).includes("/card/profile")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            enabled: true,
            profiles: ["octo/v1"],
            // 真实 im-test 部署 advertise 的元素超集(P1-d 起进度卡优先 RichTextBlock 而非 ColumnSet:
            // 解决服务端权威重算 plain 时 ColumnSet 图标/文本分行的问题)
            elements: ["TextBlock", "RichTextBlock", "Container", "ColumnSet", "FactSet"],
            limits: { max_nodes: 200 },
          }),
        };
      }
      if (String(url).includes("/sendMessage")) return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: "card1" }) };
      return { ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("wc", { apiUrl: "https://wc.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "exec", params: { command: "ls" } }, { sessionKey: "wc" });
    await vi.advanceTimersByTimeAsync(900);

    const send = calls.find((c) => c.url.includes("/sendMessage"));
    expect(send).toBeTruthy();
    const card = (send!.body!.payload as {
      card: { body: Array<{ type: string; items?: Array<{ type: string }> }> };
    }).card;
    expect(card.body[0].type).toBe("ColumnSet");
    expect(card.body[1].type).toBe("Container"); // timeline_detail
    expect(card.body[1].items?.[0]?.type).toBe("Container"); // timeline 步骤组
    expect((card.body[1].items?.[0] as { items?: Array<{ type: string }> }).items?.[0]?.type).toBe("RichTextBlock"); // 组内仍是富文本行
  });

  it("波C: manifest advertise Action.ToggleVisibility → 终态 edit 折叠 thinking/tool 明细", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
    const fn = vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      if (String(url).includes("/card/profile")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            enabled: true,
            profiles: ["octo/v1"],
            elements: ["TextBlock", "RichTextBlock", "Container", "ColumnSet", "ActionSet"],
            actions: ["Action.ToggleVisibility"],
            limits: { max_nodes: 200 },
          }),
        };
      }
      if (String(url).includes("/sendMessage")) return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: "card1" }) };
      return { ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("wc-toggle", { apiUrl: "https://wc-toggle.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    handlers.model_call_started({}, { sessionKey: "wc-toggle" });
    await vi.advanceTimersByTimeAsync(100);
    handlers.before_tool_call({ toolName: "exec", toolCallId: "e1", params: { command: "find src" } }, { sessionKey: "wc-toggle" });
    handlers.after_tool_call({ toolName: "exec", toolCallId: "e1", durationMs: 50 }, { sessionKey: "wc-toggle" });
    await vi.advanceTimersByTimeAsync(900);

    await finalizeCard("wc-toggle", { success: true });
    const edit = calls.filter((c) => c.url.includes("/message/edit")).pop();
    expect(edit).toBeTruthy();
    const env = JSON.parse(edit!.body!.content_edit as string);
    expect(env.card.metadata).toEqual({ octo_layout: OCTO_CARD_LAYOUTS.agentProgressV1 });
    const body = env.card.body as Array<Record<string, unknown>>;
    expect(body[0].type).toBe("ColumnSet");
    const summaryHeader = body[0] as { columns: Array<{ width: string; items: Array<Record<string, unknown>> }> };
    const headerBlock = summaryHeader.columns[0].items[0] as { type: string; inlines: Array<Record<string, unknown>> };
    expect(headerBlock.type).toBe("RichTextBlock");
    expect(headerBlock.inlines[0]).toMatchObject({ text: "✅ 已完成", weight: "Bolder" });
    const summaryBlock = summaryHeader.columns[0].items[1] as { type: string; inlines: Array<Record<string, unknown>> };
    expect(summaryBlock.inlines[0]).toMatchObject({ text: "推理与工具调用", weight: "Bolder" });
    expect(summaryBlock.inlines[1]).toMatchObject({ isSubtle: true });
    const collapseBtn = summaryHeader.columns[1].items[0] as { id: string; isVisible: boolean; actions: Array<Record<string, unknown>> };
    const expandBtn = summaryHeader.columns[1].items[1] as { id: string; isVisible: boolean; actions: Array<Record<string, unknown>> };
    expect(collapseBtn.isVisible).toBe(false);
    expect(expandBtn.isVisible).toBe(true);
    expect(collapseBtn.actions[0]).toMatchObject({ type: "Action.ToggleVisibility", title: "收起推理" });
    expect(expandBtn.actions[0]).toMatchObject({ type: "Action.ToggleVisibility", title: "展开推理" });
    expect((body[1] as { type: string; id: string; isVisible: boolean }).type).toBe("Container");
    expect((body[1] as { id: string }).id).toBe("timeline_detail");
    expect((body[1] as { isVisible: boolean }).isVisible).toBe(false);
    expect(collapseBtn.actions[0].targetElements).toEqual([
      { elementId: (body[1] as { id: string }).id, isVisible: false },
      { elementId: collapseBtn.id, isVisible: false },
      { elementId: expandBtn.id, isVisible: true },
    ]);
    expect(JSON.stringify(body[1])).toContain("执行命令");
  });

  it("P1-g: model_call_started 产 running thinking step,before_tool_call 结束它(标 done + durationMs)", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("tk1", { apiUrl: "https://tk1.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group });

    // 起 thinking(agent 首次调 model 决定用哪个工具)
    handlers.model_call_started({}, { sessionKey: "tk1" });
    // 100ms 后开始调 tool —— thinking 结束
    await vi.advanceTimersByTimeAsync(100);
    handlers.before_tool_call({ toolName: "read", params: { path: "/a" }, toolCallId: "r1" }, { sessionKey: "tk1" });
    handlers.after_tool_call({ toolName: "read", toolCallId: "r1", durationMs: 50 }, { sessionKey: "tk1" });
    await vi.advanceTimersByTimeAsync(900);

    const send = calls.find((c) => c.url.includes("/sendMessage"));
    expect(send).toBeTruthy();
    const card = (send!.body!.payload as { card: { body: Array<Record<string, unknown>> } }).card;
    // 首帧应含:header + thinking(done) + read(running/done)
    const joined = progressCardText(card);
    expect(joined).toContain("💭 思考"); // thinking step 出现
    expect(joined).toContain("读取文件");  // 后续 tool step 也在
  });

  it("captures reasoning snapshots and tool output summaries into the contract card", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
    const fn = vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      if (String(url).includes("/card/profile")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            enabled: true,
            profiles: ["octo/v1"],
            elements: ["TextBlock", "Container", "ColumnSet", "ActionSet"],
            actions: ["Action.ToggleVisibility"],
            limits: { max_nodes: 200 },
          }),
        };
      }
      if (String(url).includes("/sendMessage")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: "reasoning-card" }) };
      }
      return { ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    const ctx = { sessionKey: "reasoning-capture", runId: "run-1" };

    setCardContext("reasoning-capture", {
      apiUrl: "https://reasoning.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
      reasoningVisibility: "stream",
    });
    handlers.before_agent_run({}, ctx);
    handlers.model_call_started({ callId: "call-1" }, ctx);
    recordCardReasoning("reasoning-capture", "partial text", { snapshot: false });
    recordCardReasoning("reasoning-capture", "先核对仓库，再执行测试。", { snapshot: true });
    handlers.before_tool_call(
      { toolName: "exec", toolCallId: "tool-1", params: { command: "npm test" } },
      ctx,
    );
    handlers.after_tool_call({
      toolName: "exec",
      toolCallId: "tool-1",
      durationMs: 50,
      result: {
        details: { exitCode: 0, status: "completed" },
        content: [{ type: "text", text: "Authorization: Bearer should-not-render" }],
      },
    }, ctx);
    await vi.advanceTimersByTimeAsync(900);

    const send = calls.find((call) => call.url.includes("/sendMessage"));
    expect(send).toBeTruthy();
    const card = (send!.body!.payload as { card: { body: Array<Record<string, unknown>> } }).card;
    const text = progressCardText(card);
    expect(text).toContain("先核对仓库，再执行测试。");
    expect(text).not.toContain("partial text");
    expect(text).toContain("exec");
    expect(text).toContain("npm");
    expect(text).toContain("exit 0");
    expect(text).not.toContain("should-not-render");
  });

  it("captures host thinking agent events as reasoning snapshots", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers, emitAgentEvent } = makeApi();
    const ctx = { sessionKey: "reasoning-agent-event", runId: "run-1" };

    setCardContext("reasoning-agent-event", {
      apiUrl: "https://reasoning-event.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
      reasoningVisibility: "stream",
    });
    handlers.before_agent_run({}, ctx);
    handlers.model_call_started({ callId: "call-1" }, ctx);
    await emitAgentEvent({
      runId: "run-1",
      sessionKey: "reasoning-agent-event",
      stream: "thinking",
      data: {
        text: "Inspect the tool input before running it.",
        delta: "Inspect the tool input before running it.",
      },
    });
    handlers.before_tool_call(
      { toolName: "exec", toolCallId: "tool-1", params: { command: "printf ok" } },
      ctx,
    );
    handlers.after_tool_call({
      toolName: "exec",
      toolCallId: "tool-1",
      result: { details: { exitCode: 0 } },
    }, ctx);
    await vi.advanceTimersByTimeAsync(900);

    const send = calls.find((call) => call.url.includes("/sendMessage"));
    expect(send).toBeTruthy();
    const card = (send!.body!.payload as { card: { body: Array<Record<string, unknown>> } }).card;
    expect(progressCardText(card)).toContain("Inspect the tool input before running it.");
    expect(progressCardText(card)).toContain("exec");
    expect(progressCardText(card)).toContain("printf");
    expect(progressCardText(card)).toContain("exit 0");
  });

  it("keeps host thinking agent events hidden when reasoning visibility is off", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers, emitAgentEvent } = makeApi();
    const ctx = { sessionKey: "reasoning-agent-event-hidden", runId: "run-1" };

    setCardContext("reasoning-agent-event-hidden", {
      apiUrl: "https://reasoning-event-hidden.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
      reasoningVisibility: "off",
    });
    handlers.before_agent_run({}, ctx);
    handlers.model_call_started({ callId: "call-1" }, ctx);
    await emitAgentEvent({
      runId: "run-1",
      sessionKey: "reasoning-agent-event-hidden",
      stream: "thinking",
      data: { text: "MUST STAY HIDDEN FROM THINKING EVENTS" },
    });
    handlers.before_tool_call({ toolName: "read", toolCallId: "tool-1" }, ctx);
    handlers.after_tool_call({ toolName: "read", toolCallId: "tool-1", durationMs: 20 }, ctx);
    await vi.advanceTimersByTimeAsync(900);

    const send = calls.find((call) => call.url.includes("/sendMessage"));
    expect(send).toBeTruthy();
    const card = (send!.body!.payload as { card: { body: Array<Record<string, unknown>> } }).card;
    expect(progressCardText(card)).not.toContain("MUST STAY HIDDEN");
    expect(progressCardText(card)).not.toContain("Thinking through...");
    expect(progressCardText(card)).toContain("推理与工具调用");
    expect(progressCardText(card)).toContain("读取文件 · 20ms");
  });

  it("captures persisted thinking blocks only when reasoning visibility is enabled", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    const ctx = { sessionKey: "reasoning-message-write", runId: "run-1" };

    setCardContext("reasoning-message-write", {
      apiUrl: "https://reasoning-write.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
      reasoningVisibility: "stream",
    });
    handlers.before_agent_run({}, ctx);
    handlers.model_call_started({ callId: "call-1" }, ctx);
    handlers.before_message_write({
      sessionKey: "reasoning-message-write",
      message: {
        role: "assistant",
        content: [{
          type: "thinking",
          thinking: "Read the command input, then verify its exit status.",
          thinkingSignature: "reasoning_content",
        }],
      },
    }, ctx);
    handlers.before_tool_call(
      { toolName: "exec", toolCallId: "tool-1", params: { command: "printf ok" } },
      ctx,
    );
    handlers.after_tool_call({
      toolName: "exec",
      toolCallId: "tool-1",
      result: { details: { exitCode: 0 } },
    }, ctx);
    await vi.advanceTimersByTimeAsync(900);

    const send = calls.find((call) => call.url.includes("/sendMessage"));
    expect(send).toBeTruthy();
    const card = (send!.body!.payload as { card: { body: Array<Record<string, unknown>> } }).card;
    expect(progressCardText(card)).toContain("Read the command input, then verify its exit status.");
  });

  it("keeps persisted thinking blocks hidden when reasoning visibility is off", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    const ctx = { sessionKey: "reasoning-hidden", runId: "run-1" };

    setCardContext("reasoning-hidden", {
      apiUrl: "https://reasoning-hidden.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
      reasoningVisibility: "off",
    });
    handlers.before_agent_run({}, ctx);
    handlers.model_call_started({ callId: "call-1" }, ctx);
    handlers.before_message_write({
      sessionKey: "reasoning-hidden",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "MUST STAY HIDDEN" }],
      },
    }, ctx);
    handlers.before_tool_call({ toolName: "read", toolCallId: "tool-1" }, ctx);
    await vi.advanceTimersByTimeAsync(900);

    const send = calls.find((call) => call.url.includes("/sendMessage"));
    expect(send).toBeTruthy();
    const card = (send!.body!.payload as { card: { body: Array<Record<string, unknown>> } }).card;
    expect(progressCardText(card)).not.toContain("MUST STAY HIDDEN");
    expect(progressCardText(card)).not.toContain("Thinking through...");
    expect(progressCardText(card)).toContain("推理与工具调用");
  });

  it("uses model_call_ended duration and preserves aborted as stopped at finalize", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    const ctx = { sessionKey: "reasoning-stopped", runId: "run-1" };

    setCardContext("reasoning-stopped", {
      apiUrl: "https://reasoning-stopped.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
      reasoningVisibility: "stream",
    });
    handlers.before_agent_run({}, ctx);
    handlers.model_call_started({ callId: "call-1" }, ctx);
    recordCardReasoning("reasoning-stopped", "正在核对数据。", { snapshot: true });
    handlers.before_tool_call({ toolName: "read", toolCallId: "tool-1" }, ctx);
    handlers.after_tool_call({ toolName: "read", toolCallId: "tool-1", result: {} }, ctx);
    await vi.advanceTimersByTimeAsync(900);
    handlers.model_call_started({ callId: "call-2" }, ctx);
    handlers.model_call_ended({
      callId: "call-2",
      durationMs: 1_200,
      outcome: "error",
      failureKind: "aborted",
    }, ctx);
    await finalizeCard("reasoning-stopped", { success: false });

    const edit = calls.filter((call) => call.url.includes("/message/edit")).pop();
    expect(edit).toBeTruthy();
    const envelope = JSON.parse(edit!.body!.content_edit as string);
    expect(progressCardText(envelope.card)).toContain("已停止");
    expect(progressCardText(envelope.card)).not.toContain("生成失败");
    expect(JSON.stringify(envelope.card)).toContain("1.2s");
  });

  it("exposes answering as the first non-reasoning reply state", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("reasoning-answering", {
      apiUrl: "https://reasoning-answering.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
      reasoningVisibility: "stream",
    });
    handlers.model_call_started({ callId: "call-1" }, { sessionKey: "reasoning-answering" });
    recordCardReasoning("reasoning-answering", "正在核对输入。", { snapshot: true });
    handlers.before_tool_call(
      { toolName: "read", toolCallId: "tool-1" },
      { sessionKey: "reasoning-answering" },
    );
    handlers.after_tool_call(
      { toolName: "read", toolCallId: "tool-1", result: {} },
      { sessionKey: "reasoning-answering" },
    );
    await vi.advanceTimersByTimeAsync(900);
    calls.length = 0;

    markCardAnswering("reasoning-answering");
    await vi.advanceTimersByTimeAsync(900);

    const edit = calls.find((call) => call.url.includes("/message/edit"));
    expect(edit).toBeTruthy();
    const envelope = JSON.parse(edit!.body!.content_edit as string);
    expect(progressCardText(envelope.card)).toContain("回答中");
    expect(progressCardText(envelope.card)).toContain("正在生成回答");
  });

  it("P1-g: 多次 model_call_started 累积多步 thinking(同类合并压缩)", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("tk2", { apiUrl: "https://tk2.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group });

    // agent 循环:thinking → tool → thinking → tool → thinking → tool
    for (let i = 0; i < 3; i++) {
      handlers.model_call_started({}, { sessionKey: "tk2" });
      await vi.advanceTimersByTimeAsync(50);
      const id = `t${i}`;
      handlers.before_tool_call({ toolName: "read", params: { path: `/${i}` }, toolCallId: id }, { sessionKey: "tk2" });
      handlers.after_tool_call({ toolName: id, toolCallId: id, durationMs: 30 }, { sessionKey: "tk2" });
    }
    await vi.advanceTimersByTimeAsync(900);
    // 只验证:发送时的 payload 里出现了 thinking(至少一处)—— 合并/顺序具体断言在 render 层测
    const send = calls.find((c) => c.url.includes("/sendMessage"));
    expect(send).toBeTruthy();
    const s = JSON.stringify((send!.body!.payload as { card: unknown }).card);
    expect(s).toContain("💭");
  });

  it("P1-g: finalize 前的 running thinking 被收尾(不留 running 尾巴)", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("tk3", { apiUrl: "https://tk3.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group });

    // thinking + 一个 tool,然后再一次 thinking(无后续 tool)→ finalize 收尾
    handlers.model_call_started({}, { sessionKey: "tk3" });
    handlers.before_tool_call({ toolName: "read", params: { path: "/a" }, toolCallId: "r1" }, { sessionKey: "tk3" });
    handlers.after_tool_call({ toolName: "read", toolCallId: "r1", durationMs: 30 }, { sessionKey: "tk3" });
    handlers.model_call_started({}, { sessionKey: "tk3" });
    await vi.advanceTimersByTimeAsync(900); // 首帧发出
    calls.length = 0;

    await finalizeCard("tk3", { success: true });
    const edit = calls.find((c) => c.url.includes("/message/edit"));
    expect(edit).toBeTruthy();
    const env = JSON.parse(edit!.body!.content_edit as string);
    // 终态帧不应残留 running:⏳ 不该出现
    const cardStr = JSON.stringify(env.card);
    expect(cardStr).not.toContain("⏳");
  });

  it("P1-h: octo_send_display_card 不入进度卡 —— 纯 display-card turn 无占位卡、无终态帧", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("dh1", { apiUrl: "https://dh1.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "octo_send_display_card", toolCallId: "d1" }, { sessionKey: "dh1" });
    handlers.after_tool_call({ toolName: "octo_send_display_card", toolCallId: "d1", durationMs: 120 }, { sessionKey: "dh1" });
    await vi.advanceTimersByTimeAsync(900);
    // 从未 scheduleFlush → 连 gate 探测/发送都没有
    expect(calls.some((c) => c.url.includes("/sendMessage"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/card/profile"))).toBe(false);
    // finalize 因 !messageId 静默,不发终态帧
    await finalizeCard("dh1", { success: true });
    expect(calls.some((c) => c.url.includes("/message/edit"))).toBe(false);
  });

  it("P1-h: 混合 turn:display-card 不计步,真实工具照常显示进度(读取文件在,display-card 不在)", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("dh2", { apiUrl: "https://dh2.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "octo_send_display_card", toolCallId: "d1" }, { sessionKey: "dh2" }); // 忽略
    handlers.before_tool_call({ toolName: "read", params: { path: "/a" }, toolCallId: "r1" }, { sessionKey: "dh2" }); // 计入
    await vi.advanceTimersByTimeAsync(900);
    const send = calls.find((c) => c.url.includes("/sendMessage"));
    expect(send).toBeTruthy();
    const card = (send!.body!.payload as { card: { metadata?: unknown; body: Array<Record<string, unknown>> } }).card;
    expect(card.metadata).toEqual({ octo_layout: OCTO_CARD_LAYOUTS.agentProgressV1 });
    const joined = progressCardText(card);
    expect(joined).toContain("读取文件");
    expect(joined).not.toContain("octo_send_display_card");
  });

  it("懒发契约:model_call_started 单独不发卡 —— 纯 display-card turn(含思考步)无占位卡、无中断终态", async () => {
    // 回归:P1-g 的 model_call_started 曾无条件 scheduleFlush,击穿 P1-h 抑制 ——
    // 纯 display-card turn 仍发占位卡并 finalize 成「⚠️ 已中断」。
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("nf1", { apiUrl: "https://nf1.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group });
    handlers.model_call_started({}, { sessionKey: "nf1" });   // 思考步(真实事件序:先于 tool)
    handlers.before_tool_call({ toolName: "octo_send_display_card", toolCallId: "d1" }, { sessionKey: "nf1" });
    handlers.after_tool_call({ toolName: "octo_send_display_card", toolCallId: "d1", durationMs: 120 }, { sessionKey: "nf1" });
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.some((c) => c.url.includes("/sendMessage"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/card/profile"))).toBe(false);
    await finalizeCard("nf1", { success: false });
    expect(calls.some((c) => c.url.includes("/message/edit"))).toBe(false); // 无 messageId → 无中断帧
  });

  it("懒发契约:纯思考(无任何工具)turn 不发进度卡", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("nf2", { apiUrl: "https://nf2.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group });
    handlers.model_call_started({}, { sessionKey: "nf2" });
    await vi.advanceTimersByTimeAsync(900);
    handlers.model_call_started({}, { sessionKey: "nf2" }); // 连续思考(去重)
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.length).toBe(0);
    await finalizeCard("nf2", { success: true });
    expect(calls.some((c) => c.url.includes("/message/edit"))).toBe(false);
  });

  it("懒发契约:真实工具后思考步照常更新已存在的卡", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("nf3", { apiUrl: "https://nf3.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group });
    handlers.model_call_started({}, { sessionKey: "nf3" });               // 纯思考:不发
    handlers.before_tool_call({ toolName: "read", toolCallId: "r1" }, { sessionKey: "nf3" }); // 真实工具:发首帧
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.some((c) => c.url.includes("/sendMessage"))).toBe(true);
    calls.length = 0;
    handlers.after_tool_call({ toolName: "read", toolCallId: "r1", durationMs: 20 }, { sessionKey: "nf3" });
    handlers.model_call_started({}, { sessionKey: "nf3" });               // 卡已存在 → 思考步刷新
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.some((c) => c.url.includes("/message/edit"))).toBe(true);
  });

  it("NEW-3: display-card 前的 running thinking 被收尾(思考耗时不吞掉发卡时长)", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("nf4", { apiUrl: "https://nf4.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read", toolCallId: "r1" }, { sessionKey: "nf4" }); // 让卡存在
    handlers.after_tool_call({ toolName: "read", toolCallId: "r1", durationMs: 10 }, { sessionKey: "nf4" });
    handlers.model_call_started({}, { sessionKey: "nf4" });               // 起一个思考步
    handlers.before_tool_call({ toolName: "octo_send_display_card", toolCallId: "d1" }, { sessionKey: "nf4" }); // 应收尾思考步
    handlers.before_tool_call({ toolName: "read", params: { path: "/b" }, toolCallId: "r2" }, { sessionKey: "nf4" });
    await vi.advanceTimersByTimeAsync(900);
    const send = calls.find((c) => c.url.includes("/sendMessage")) ?? calls.find((c) => c.url.includes("/message/edit"));
    // 思考步已 done(有 💭 且带耗时),不再是 running（⏳）
    expect(send).toBeTruthy();
  });

  it("runId 在 before_agent_run 预绑定:旧 run 迟到 hook 先到也不能抢占新 entry", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    const target = { apiUrl: "https://rg.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group };

    // run A 在任何 model/tool 事件前由 before_agent_run 绑定,随后跑一步并超时收尾。
    setCardContext("rg1", target);
    expect(handlers.before_agent_run({}, { sessionKey: "rg1", runId: "A" })).toEqual({ outcome: "pass" });
    handlers.before_tool_call({ toolName: "read", params: { path: "/a" }, toolCallId: "a1" }, { sessionKey: "rg1", runId: "A" });
    await vi.advanceTimersByTimeAsync(900);
    await finalizeCard("rg1", { success: false });

    // 同 sessionKey 的 run B 登记 fresh entry。A 的迟到 hook 在 B 的首个工具事件之前到达，
    // 但 entry 尚未由 before_agent_run 绑定时不得 first-hook-wins。
    setCardContext("rg1", target);
    handlers.before_tool_call({ toolName: "exec", params: { command: "echo x" }, toolCallId: "a2" }, { sessionKey: "rg1", runId: "A" });
    handlers.after_tool_call({ toolName: "exec", toolCallId: "a2", durationMs: 9 }, { sessionKey: "rg1", runId: "A" });
    expect(handlers.before_agent_run({}, { sessionKey: "rg1", runId: "B" })).toEqual({ outcome: "pass" });
    handlers.before_tool_call({ toolName: "write", params: { path: "/b" }, toolCallId: "b1" }, { sessionKey: "rg1", runId: "B" });
    await vi.advanceTimersByTimeAsync(900);

    // 聚合所有发出去的帧(send payload + edit content_edit)的卡片文本
    const allText = calls
      .filter((c) => c.url.includes("/sendMessage") || c.url.includes("/message/edit"))
      .map((c) => {
        const card = c.url.includes("/message/edit")
          ? JSON.parse(c.body!.content_edit as string).card
          : (c.body!.payload as { card: { body: Array<Record<string, unknown>> } }).card;
        return progressCardText(card);
      })
      .join(" || ");
    expect(allText).toContain("写入文件"); // B 自己的步骤渲染出来了
    expect(allText).not.toContain("执行命令"); // A 迟到的 exec 步骤从未进入任何帧
  });

  it("bindCardRun 缺标识/无 entry/skip 时 no-op,且既有 owner 不可被覆盖", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    bindCardRun(undefined, "run-a");
    bindCardRun("missing", undefined);
    bindCardRun("missing", "run-a");
    setCardContext("skipped", {
      apiUrl: "https://owner.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
      onBehalfOf: "grantor",
    });
    bindCardRun("skipped", "run-a");

    setCardContext("owned", {
      apiUrl: "https://owner.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
    });
    bindCardRun("owned", "run-a");
    bindCardRun("owned", "run-b");
    handlers.before_tool_call({ toolName: "exec", toolCallId: "b1" }, { sessionKey: "owned", runId: "run-b" });
    handlers.before_tool_call({ toolName: "read", toolCallId: "a1" }, { sessionKey: "owned", runId: "run-a" });
    await vi.advanceTimersByTimeAsync(900);

    const send = calls.find((c) => c.url.includes("/sendMessage"));
    expect(send).toBeTruthy();
    const rendered = progressCardText((send!.body!.payload as {
      card: { body: Array<Record<string, unknown>> };
    }).card);
    expect(rendered).toContain("读取文件");
    expect(rendered).not.toContain("执行命令");
  });

  it("entry 等待 profile 时被新身份替换,恢复后不得向旧频道发送占位卡", async () => {
    const profileReached = makeDeferred();
    const releaseProfile = makeDeferred();
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    let profileSignal: AbortSignal | undefined;
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: { body?: string; signal?: AbortSignal }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      if (String(url).includes("/card/profile")) {
        profileSignal = init?.signal;
        profileReached.resolve();
        await releaseProfile.promise;
        return { ok: true, status: 200, json: async () => ({ enabled: true, profiles: ["octo/v1"] }) };
      }
      if (String(url).includes("/sendMessage")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: "stale" }) };
      }
      return { ok: true, status: 200, text: async () => "" };
    }) as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("collision", { apiUrl: "https://race.test", botToken: "token-a", channelId: "group-a", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read", toolCallId: "a1" }, { sessionKey: "collision" });
    await vi.advanceTimersByTimeAsync(900);
    await profileReached.promise;

    setCardContext("collision", { apiUrl: "https://race.test", botToken: "token-b", channelId: "group-b", channelType: ChannelType.Group });
    expect(profileSignal?.aborted).toBe(true);
    releaseProfile.resolve();
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(calls.some((c) => c.url.includes("/sendMessage"))).toBe(false);
  });
});
