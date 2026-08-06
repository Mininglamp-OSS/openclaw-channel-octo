import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./accounts.js", () => ({
  listOctoAccountIds: vi.fn(),
  resolveOctoAccount: vi.fn(),
}));
vi.mock("./api-fetch.js", () => ({
  getCardProfile: vi.fn(),
  sendCardMessage: vi.fn(),
  sendMessage: vi.fn(),
}));
vi.mock("./card-session.js", () => ({ registerCardSession: vi.fn() }));

import { createInteractiveCardTool } from "./card-tool.js";
import { listOctoAccountIds, resolveOctoAccount } from "./accounts.js";
import { getCardProfile, sendCardMessage, sendMessage } from "./api-fetch.js";
import { registerCardSession } from "./card-session.js";

const cfg = { channels: { octo: { botToken: "tok" } } } as never;
const deliveryContext = { channel: "octo", to: "group:g1", accountId: "default" };

function setup(): void {
  vi.mocked(listOctoAccountIds).mockReturnValue(["default"]);
  vi.mocked(resolveOctoAccount).mockReturnValue({
    accountId: "default",
    enabled: true,
    configured: true,
    config: {
      botToken: "tok",
      apiUrl: "https://api.test",
      pollIntervalMs: 2000,
      heartbeatIntervalMs: 30000,
    },
  } as never);
  vi.mocked(getCardProfile).mockResolvedValue({
    available: true,
    enabled: true,
    profiles: ["octo/v1", "octo/v2"],
    card_version: "1.5",
    elements: ["TextBlock"],
    inputs: ["Input.Text"],
    actions: ["Action.OpenUrl", "Action.ToggleVisibility", "Action.CopyToClipboard"],
    limits: { max_nodes: 20, max_depth: 8, max_payload_bytes: 16384 },
    config: {
      card_enabled: true,
      display_enabled: true,
      interaction_enabled: true,
      reasoning_enabled: false,
      reasoning_template_ref: null,
    },
  });
  vi.mocked(sendCardMessage).mockResolvedValue({ message_id: "m1" } as never);
  vi.mocked(sendMessage).mockResolvedValue({ message_id: "fallback" } as never);
}

function tool(context: typeof deliveryContext | null = deliveryContext) {
  const tools = createInteractiveCardTool({
    cfg,
    agentAccountId: "default",
    agentId: "agent-1",
    sessionKey: "session-1",
    deliveryContext: context ?? undefined,
    messageChannel: context?.channel,
  } as never);
  expect(tools).toHaveLength(1);
  return tools[0];
}

describe("octo_send_card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  it("本地 cardInteraction:false 已弃用，discovery 不再读取它", () => {
    vi.mocked(resolveOctoAccount).mockReturnValue({
      accountId: "default",
      enabled: true,
      configured: true,
      config: {
        botToken: "tok",
        apiUrl: "https://api.test",
        pollIntervalMs: 2000,
        heartbeatIntervalMs: 30000,
        cardInteraction: false,
      },
    } as never);
    expect(createInteractiveCardTool({ cfg, agentAccountId: "default", deliveryContext } as never))
      .toHaveLength(1);
  });

  it("cfg 缺失、非 Octo 会话、无可用账号时不暴露工具", () => {
    expect(createInteractiveCardTool({ cfg: undefined } as never)).toEqual([]);
    expect(createInteractiveCardTool({
      cfg,
      deliveryContext: { channel: "telegram", to: "group:g1", accountId: "default" },
      messageChannel: "telegram",
    } as never)).toEqual([]);
    vi.mocked(listOctoAccountIds).mockReturnValue([]);
    expect(createInteractiveCardTool({ cfg } as never)).toEqual([]);
  });

  it("多账号 discovery 仅在全部禁用时隐藏，并吞掉配置解析异常", () => {
    vi.mocked(listOctoAccountIds).mockReturnValue(["a", "b"]);
    vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: { accountId: string }) => ({
      accountId,
      enabled: true,
      configured: true,
      config: { botToken: "tok", cardInteraction: accountId === "a" ? false : true },
    } as never));
    expect(createInteractiveCardTool({ cfg, deliveryContext: { channel: "octo", to: "group:g1" } } as never))
      .toHaveLength(1);

    vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: { accountId: string }) => ({
      accountId, enabled: true, configured: true, config: { botToken: "tok", cardInteraction: false },
    } as never));
    expect(createInteractiveCardTool({ cfg } as never)).toHaveLength(1);

    vi.mocked(listOctoAccountIds).mockImplementation(() => { throw new Error("bad config"); });
    expect(createInteractiveCardTool({ cfg } as never)).toEqual([]);
  });

  it("schema 不暴露 channelId/accountId，成功发送 v2 后登记 session", async () => {
    const current = tool();
    const schema = current.parameters as { properties: Record<string, unknown> };
    expect(schema.properties.channelId).toBeUndefined();
    expect(schema.properties.accountId).toBeUndefined();
    expect(schema.properties.blocks).toBeDefined();

    const result = await current.execute("call-1", {
      title: "确认发布",
      buttons: [{ id: "approve", label: "批准" }],
      channelId: "group:attacker",
    });

    expect(sendCardMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "g1",
      profile: "octo/v2",
    }));
    expect(registerCardSession).toHaveBeenCalledWith("m1", expect.objectContaining({
      sessionKey: "session-1",
      agentId: "agent-1",
      accountId: "default",
      channelId: "g1",
      inputIds: [],
    }));
    expect(result.details).toEqual(expect.objectContaining({ sent: true, message_id: "m1" }));
  });

  it("octo/v2 profile 即表示 Submit 可用，不要求本地 actions 列出 Action.Submit", async () => {
    vi.mocked(getCardProfile).mockResolvedValue({
      available: true,
      enabled: true,
      profiles: ["octo/v1", "octo/v2"],
      card_version: "1.5",
      elements: ["TextBlock"],
      inputs: ["Input.Text"],
      actions: ["Action.OpenUrl", "Action.ToggleVisibility", "Action.CopyToClipboard"],
    });

    const result = await tool().execute("live-d12-shape", {
      title: "确认模拟发布",
      buttons: [{ id: "continue", label: "继续模拟" }, { id: "cancel", label: "取消" }],
    });

    expect(sendCardMessage).toHaveBeenCalledWith(expect.objectContaining({ profile: "octo/v2" }));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.details).toEqual(expect.objectContaining({ sent: true, message_id: "m1" }));
  });

  it("把 tool 的 section/options blocks 传给受控构建器并登记原卡快照", async () => {
    vi.mocked(getCardProfile).mockResolvedValue({
      available: true,
      enabled: true,
      profiles: ["octo/v2"],
      card_version: "1.5",
      elements: ["TextBlock", "Container", "FactSet"],
      inputs: ["Input.ChoiceSet"],
      actions: ["Action.OpenUrl"],
    });

    await tool().execute("structured", {
      title: "选择方案",
      blocks: [
        { type: "section", title: "C · 生态打法", text: "开放插件和技能。" },
        {
          type: "options",
          id: "strategy",
          label: "方案",
          options: [{ title: "C · 生态打法", value: "c" }],
        },
      ],
      buttons: [{ id: "submit", label: "确认选择" }],
    });

    const sent = vi.mocked(sendCardMessage).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(JSON.stringify(sent.card)).toContain("Input.ChoiceSet");
    expect(JSON.stringify(sent.card)).toContain("C · 生态打法");
    expect(registerCardSession).toHaveBeenCalledWith("m1", expect.objectContaining({
      card: sent.card,
      plain: expect.stringContaining("C · 生态打法"),
      inputIds: ["strategy"],
    }));
  });

  it("服务端不支持 octo/v2 时降级为当前会话纯文本，不登记 session", async () => {
    vi.mocked(getCardProfile).mockResolvedValue({
      available: true,
      enabled: true,
      profiles: ["octo/v1"],
      card_version: "1.5",
    });
    const result = await tool().execute("call-2", {
      title: "选择环境",
      buttons: [{ id: "prod", label: "生产" }, { id: "test", label: "测试" }],
    });

    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ channelId: "g1" }));
    expect(registerCardSession).not.toHaveBeenCalled();
    expect(result.details).toEqual(expect.objectContaining({ degraded: true }));
  });

  it("octo/v2 不依赖 actions 列表，但请求未支持 Input 时仍降级文本", async () => {
    vi.mocked(getCardProfile).mockResolvedValue({
      available: true,
      enabled: true,
      profiles: ["octo/v2"],
      card_version: "1.5",
      elements: ["TextBlock"],
      inputs: ["Input.Text"],
      actions: [],
    });
    await tool().execute("missing-action", {
      title: "确认",
      buttons: [{ id: "ok", label: "确定" }],
    });
    expect(sendCardMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();

    vi.mocked(getCardProfile).mockResolvedValue({
      available: true,
      enabled: true,
      profiles: ["octo/v2"],
      card_version: "1.5",
      elements: ["TextBlock"],
      inputs: [],
      actions: ["Action.OpenUrl"],
    });
    await tool().execute("missing-input", {
      title: "确认",
      buttons: [{ id: "ok", label: "确定" }],
      inputs: [{ id: "note", kind: "text" }],
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("manifest 不可用、服务端禁用或版本不匹配时均降级", async () => {
    const manifests = [
      { available: false, enabled: true, profiles: ["octo/v2"], card_version: "1.5" },
      { available: true, enabled: false, profiles: ["octo/v2"], card_version: "1.5" },
      { available: true, enabled: true, profiles: ["octo/v2"], card_version: "1.4" },
      { available: true, enabled: true, profiles: ["octo/v2"] },
    ];
    for (const manifest of manifests) {
      vi.mocked(getCardProfile).mockResolvedValueOnce(manifest);
      const result = await tool().execute("gate", {
        title: "确认", buttons: [{ id: "ok", label: "确定" }],
      });
      expect(result.details).toEqual(expect.objectContaining({ degraded: true }));
    }
    expect(sendMessage).toHaveBeenCalledTimes(manifests.length);
  });

  it("规范化按钮/choice、协商 limits，且不伪造缺失的 sessionKey", async () => {
    vi.mocked(getCardProfile).mockResolvedValue({
      available: true,
      enabled: true,
      profiles: ["octo/v2"],
      card_version: "1.5",
      elements: ["TextBlock"],
      inputs: ["Input.Text", "Input.Number", "Input.Date", "Input.Toggle", "Input.ChoiceSet"],
      actions: ["Action.OpenUrl", "Action.ToggleVisibility", "Action.CopyToClipboard"],
      limits: {
        max_nodes: 50,
        max_depth: 8,
        max_payload_bytes: 16_384,
        max_input_text_bytes: 4096,
        max_inputs_bytes: 8192,
      },
    });
    const current = createInteractiveCardTool({
      cfg,
      agentId: "agent-1",
      deliveryContext: { channel: "octo", to: "group:g1", accountId: "default" },
    } as never)[0];
    const result = await current.execute("rich", {
      title: "发布",
      text: "请选择",
      buttons: [
        { id: "approve", label: "批准", data: { flow: "release" }, style: "positive" },
        { id: "reject", label: "拒绝", data: [], style: "unknown" },
      ],
      inputs: [
        { id: "note", kind: "text", label: "备注", placeholder: "可选" },
        { id: "amount", kind: "number" },
        { id: "date", kind: "date" },
        { id: "toggle", kind: "toggle" },
        {
          id: "env",
          kind: "choice",
          choices: [null, { title: 1, value: "bad" }, { title: "生产", value: "prod" }],
        },
      ],
    });

    expect(result.details).toEqual(expect.objectContaining({ sent: true, message_id: "m1" }));
    expect(registerCardSession).toHaveBeenCalledWith("m1", expect.objectContaining({
      inputIds: ["note", "amount", "date", "toggle", "env"],
      maxInputTextBytes: 4096,
      maxInputsBytes: 8192,
    }));
    const registered = vi.mocked(registerCardSession).mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(registered).not.toHaveProperty("sessionKey");
    expect(registered).not.toHaveProperty("agentId");
  });

  it("非结构化核心参数会被拒绝，非法可选 inputs 会被安全忽略", async () => {
    const current = tool();
    for (const args of [
      { title: 1, buttons: [{ id: "ok", label: "确定" }] },
      { title: "确认", buttons: "bad" },
      { title: "确认", buttons: [null] },
      { title: "确认", buttons: [{ id: 1, label: 2 }] },
    ]) {
      expect((await current.execute("invalid", args)).details).toBeNull();
    }
    expect(getCardProfile).not.toHaveBeenCalled();

    expect((await current.execute("invalid-inputs", {
      title: "确认", buttons: [{ id: "ok", label: "确定" }], inputs: "bad",
    })).details).toEqual(expect.objectContaining({ sent: true }));
  });

  it("manifest 探测失败时降级文本；fallback 失败返回错误", async () => {
    vi.mocked(getCardProfile).mockRejectedValue(new Error("profile down"));
    const degraded = await tool().execute("probe-down", {
      title: "确认",
      buttons: [{ id: "ok", label: "确定" }],
    });
    expect(degraded.details).toEqual(expect.objectContaining({ degraded: true }));

    vi.mocked(sendMessage).mockRejectedValueOnce(new Error("send down"));
    const failed = await tool().execute("fallback-down", {
      title: "确认",
      buttons: [{ id: "ok", label: "确定" }],
    });
    expect(failed.content[0].text).toMatch(/fallback failed/i);
  });

  it("非 Error 异常也会生成稳定错误信息", async () => {
    vi.mocked(getCardProfile).mockRejectedValueOnce("profile down");
    expect((await tool().execute("probe-string", {
      title: "确认", buttons: [{ id: "ok", label: "确定" }],
    })).details).toEqual(expect.objectContaining({ degraded: true }));

    vi.mocked(getCardProfile).mockRejectedValueOnce("profile down");
    vi.mocked(sendMessage).mockRejectedValueOnce("fallback down");
    expect((await tool().execute("fallback-string", {
      title: "确认", buttons: [{ id: "ok", label: "确定" }],
    })).content[0].text).toContain("fallback down");

    vi.mocked(sendCardMessage).mockRejectedValueOnce("card down");
    expect((await tool().execute("card-string", {
      title: "确认", buttons: [{ id: "ok", label: "确定" }],
    })).content[0].text).toContain("card down");
  });

  it("发送成功但缺 message_id 或发送抛错时不登记 session", async () => {
    vi.mocked(sendCardMessage).mockResolvedValueOnce({} as never);
    const missing = await tool().execute("missing-id", {
      title: "确认",
      buttons: [{ id: "ok", label: "确定" }],
    });
    expect(missing.content[0].text).toMatch(/no message_id/i);
    expect(registerCardSession).not.toHaveBeenCalled();

    vi.mocked(sendCardMessage).mockRejectedValueOnce(new Error("send failed"));
    const failed = await tool().execute("send-failed", {
      title: "确认",
      buttons: [{ id: "ok", label: "确定" }],
    });
    expect(failed.content[0].text).toMatch(/send failed/i);
    expect(registerCardSession).not.toHaveBeenCalled();
  });

  it("当前 Thread 从可信 deliveryContext 生成 CommunityTopic 目标", async () => {
    const current = tool({ channel: "octo", to: "group:g1", accountId: "default", threadId: "topic-7" } as never);
    await current.execute("thread", {
      title: "Thread 确认",
      buttons: [{ id: "ok", label: "确定" }],
      channelId: "group:attacker",
    });
    expect(sendCardMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "g1____topic-7",
      channelType: 5,
    }));
  });

  it("execute 忽略本地 cardInteraction:false，仍以服务端配置为准", async () => {
    const current = tool();
    vi.mocked(resolveOctoAccount).mockReturnValue({
      accountId: "default",
      enabled: true,
      configured: true,
      config: {
        botToken: "tok",
        apiUrl: "https://api.test",
        pollIntervalMs: 2000,
        heartbeatIntervalMs: 30000,
        cardInteraction: false,
      },
    } as never);
    expect((await current.execute("disabled", {
      title: "确认", buttons: [{ id: "ok", label: "确定" }],
    })).details).toEqual(expect.objectContaining({ sent: true, message_id: "m1" }));
    expect(sendCardMessage).toHaveBeenCalledTimes(1);
  });

  it("服务端 interaction_enabled=false 时拒绝副作用，不降级发送文本", async () => {
    vi.mocked(getCardProfile).mockResolvedValue({
      available: true,
      enabled: true,
      profiles: ["octo/v1", "octo/v2"],
      card_version: "1.5",
      config: {
        card_enabled: true,
        display_enabled: true,
        interaction_enabled: false,
        reasoning_enabled: false,
        reasoning_template_ref: null,
      },
    });

    const result = await tool().execute("server-disabled", {
      title: "确认", buttons: [{ id: "ok", label: "确定" }],
    });

    expect(result.content[0].text).toMatch(/disabled|plain text/i);
    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("execute 仍拒绝已失效账号", async () => {
    const current = tool();

    vi.mocked(resolveOctoAccount).mockReturnValue({
      accountId: "default", enabled: false, configured: false, config: {},
    } as never);
    expect((await current.execute("invalid-account", {
      title: "确认", buttons: [{ id: "ok", label: "确定" }],
    })).content[0].text).toMatch(/not fully configured/i);
    expect(sendCardMessage).not.toHaveBeenCalled();
  });

  it("结构非法时在探测和发送前返回错误", async () => {
    const result = await tool().execute("invalid", { title: "确认", buttons: [] });
    expect(result.content[0].text).toMatch(/at least one button/i);
    expect(getCardProfile).not.toHaveBeenCalled();
    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("缺少可信当前会话时拒绝发送", async () => {
    const result = await tool(null).execute("call-3", {
      title: "确认",
      buttons: [{ id: "ok", label: "确定" }],
    });
    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/trusted|current/i);
  });

  it("多账号且当前会话无 accountId 时 execute 拒绝猜测账号", async () => {
    vi.mocked(listOctoAccountIds).mockReturnValue(["a", "b"]);
    vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: { accountId: string }) => ({
      accountId, enabled: true, configured: true, config: { botToken: "tok" },
    } as never));
    const current = createInteractiveCardTool({
      cfg,
      deliveryContext: { channel: "octo", to: "group:g1" },
    } as never)[0];
    const result = await current.execute("ambiguous", {
      title: "确认", buttons: [{ id: "ok", label: "确定" }],
    });
    expect(result.content[0].text).toMatch(/account is unavailable/i);
  });
});
