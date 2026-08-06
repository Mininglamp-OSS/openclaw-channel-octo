import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("./accounts.js", () => ({
  listOctoAccountIds: vi.fn(),
  resolveOctoAccount: vi.fn(),
  resolveDefaultOctoAccountId: vi.fn(),
}));

vi.mock("./api-fetch.js", () => ({
  sendCardMessage: vi.fn(),
  generateClientMsgNo: vi.fn(),
}));
vi.mock("./card-profile-cache.js", () => ({
  getBotCardProfile: vi.fn(),
  peekBotCardProfile: vi.fn(),
}));

import { createDisplayCardTool } from "./card-display-tool.js";
import {
  listOctoAccountIds,
  resolveOctoAccount,
} from "./accounts.js";
import { sendCardMessage } from "./api-fetch.js";
import { getBotCardProfile, peekBotCardProfile } from "./card-profile-cache.js";
import { generateClientMsgNo } from "./api-fetch.js";
import { cardMaxDepth, cardPayloadBytes, countCardNodes } from "./card-limits.js";

const mockCfg = { channels: { octo: { botToken: "t" } } } as never;
type DisplayToolParams = Parameters<typeof createDisplayCardTool>[0] & {
  deliveryContext?: { channel?: string; to?: string; threadId?: string | number; accountId?: string };
  messageChannel?: string;
};

const CURRENT_DELIVERY = {
  channel: "octo",
  to: "group:g1",
  accountId: "default",
} as const;

function setupOk(): void {
  vi.mocked(generateClientMsgNo).mockReturnValue("client-msg-no-1");
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
  vi.mocked(peekBotCardProfile).mockReturnValue(undefined);
  vi.mocked(getBotCardProfile).mockResolvedValue({
    available: true,
    enabled: true,
    profiles: ["octo/v1"],
    card_version: "1.5",
    elements: ["TextBlock", "RichTextBlock", "Container", "FactSet"],
    config: {
      card_enabled: true,
      display_enabled: true,
      interaction_enabled: true,
      reasoning_enabled: false,
      reasoning_template_ref: null,
    },
  } as never);
  vi.mocked(sendCardMessage).mockResolvedValue({ message_id: "m1" } as never);
}

function getTool(deliveryContext: DisplayToolParams["deliveryContext"] | null = CURRENT_DELIVERY): {
  name: string;
  description: string;
  parameters: unknown;
  execute: (id: string, args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details?: unknown }>;
} {
  const tools = createDisplayCardTool({
    cfg: mockCfg,
    agentAccountId: "default",
    deliveryContext: deliveryContext ?? undefined,
    messageChannel: deliveryContext?.channel,
  } as DisplayToolParams);
  expect(tools).toHaveLength(1);
  return tools[0];
}

describe("createDisplayCardTool 骨架", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OCTO_CARD_REQUEST_LOG_DIR;
    setupOk();
  });

  it("无 configured account → 空数组(tool discovery 阶段安全)", () => {
    vi.mocked(listOctoAccountIds).mockReturnValue([]);
    expect(createDisplayCardTool({ cfg: mockCfg })).toEqual([]);
  });

  it("cfg 缺失 → 空数组", () => {
    expect(createDisplayCardTool({ cfg: undefined as never })).toEqual([]);
  });

  it("非 Octo 会话不注册展示卡工具", () => {
    expect(createDisplayCardTool({
      cfg: mockCfg,
      agentAccountId: "default",
      deliveryContext: { channel: "telegram", to: "group:other", accountId: "default" },
      messageChannel: "telegram",
    } as DisplayToolParams)).toEqual([]);
  });

  it("本地 cardDisplay:false 已弃用，discovery 不再读取它", () => {
    vi.mocked(resolveOctoAccount).mockReturnValue({
      accountId: "default",
      enabled: true,
      configured: true,
      config: {
        botToken: "tok",
        apiUrl: "https://api.test",
        pollIntervalMs: 2000,
        heartbeatIntervalMs: 30000,
        cardDisplay: false,
      },
    } as never);

    expect(createDisplayCardTool({
      cfg: mockCfg,
      agentAccountId: "default",
      deliveryContext: CURRENT_DELIVERY,
      messageChannel: "octo",
    } as DisplayToolParams)).toHaveLength(1);
  });

  it("无当前账号上下文时也不读取本地 cardDisplay:false", () => {
    vi.mocked(resolveOctoAccount).mockReturnValue({
      accountId: "only-account",
      enabled: true,
      configured: true,
      config: {
        botToken: "tok",
        apiUrl: "https://api.test",
        pollIntervalMs: 2000,
        heartbeatIntervalMs: 30000,
        cardDisplay: false,
      },
    } as never);
    vi.mocked(listOctoAccountIds).mockReturnValue(["only-account"]);

    expect(createDisplayCardTool({ cfg: mockCfg } as DisplayToolParams)).toHaveLength(1);
  });

  it("多账号 discovery 不再聚合本地 cardDisplay 值", () => {
    vi.mocked(listOctoAccountIds).mockReturnValue(["account-a", "account-b"]);
    vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: { accountId?: string }) => ({
      accountId: accountId ?? "default",
      enabled: true,
      configured: true,
      config: {
        botToken: `tok-${accountId}`,
        apiUrl: "https://api.test",
        pollIntervalMs: 2000,
        heartbeatIntervalMs: 30000,
        cardDisplay: false,
      },
    }) as never);

    expect(createDisplayCardTool({ cfg: mockCfg } as DisplayToolParams)).toHaveLength(1);
  });

  it("多账号且 discovery 无法确定当前账号时,任一账号允许展示卡则保留工具", () => {
    vi.mocked(listOctoAccountIds).mockReturnValue(["account-a", "account-b"]);
    vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: { accountId?: string }) => ({
      accountId: accountId ?? "default",
      enabled: true,
      configured: true,
      config: {
        botToken: `tok-${accountId}`,
        apiUrl: "https://api.test",
        pollIntervalMs: 2000,
        heartbeatIntervalMs: 30000,
        cardDisplay: accountId === "account-a" ? false : true,
      },
    }) as never);

    expect(createDisplayCardTool({ cfg: mockCfg } as DisplayToolParams)).toHaveLength(1);
  });

  it("cached display_enabled 只隐藏匹配 Bot 的展示卡工具", () => {
    vi.mocked(listOctoAccountIds).mockReturnValue(["account-a", "account-b"]);
    vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: { accountId?: string }) => ({
      accountId: accountId ?? "account-a",
      enabled: true,
      configured: true,
      config: {
        botToken: `tok-${accountId}`,
        apiUrl: "https://api.test",
        pollIntervalMs: 2000,
        heartbeatIntervalMs: 30000,
      },
    }) as never);
    vi.mocked(peekBotCardProfile).mockImplementation(({ botToken }) => ({
      available: true,
      enabled: true,
      config: {
        card_enabled: true,
        display_enabled: botToken !== "tok-account-a",
        interaction_enabled: true,
        reasoning_enabled: false,
        reasoning_template_ref: null,
      },
    }));

    expect(createDisplayCardTool({
      cfg: mockCfg,
      deliveryContext: { ...CURRENT_DELIVERY, accountId: "account-a" },
    } as DisplayToolParams)).toEqual([]);
    expect(createDisplayCardTool({
      cfg: mockCfg,
      deliveryContext: { ...CURRENT_DELIVERY, accountId: "account-b" },
    } as DisplayToolParams)).toHaveLength(1);
  });

  it("tool 元数据:name=octo_send_display_card,description 涵盖『展示型』『不回流』", () => {
    const t = getTool();
    expect(t.name).toBe("octo_send_display_card");
    expect(t.description.length).toBeGreaterThan(20);
    expect(t.description).toMatch(/display|展示|non[- ]?interactive|not interactive/i);
  });

  it("P1-i: description 明确指引富样式(group.style + rich color),引用 SKILL 文档", () => {
    const t = getTool();
    // 显式提到 group.style 三色和 rich color 才算引导到位
    expect(t.description).toMatch(/group.*style/i);
    expect(t.description).toMatch(/good.*warning.*attention|attention.*warning.*good/);
    expect(t.description).toMatch(/rich.*color|color.*rich/i);
    // 指向 SKILL 详细节
    expect(t.description).toMatch(/SKILL(\.md)?/);
  });

  it("卡片过程指引:description 要求 reasoning_sections,避免 raw tool_events 日志卡", () => {
    const t = getTool();
    expect(t.description).toMatch(/reasoning_sections/);
    expect(t.description).toMatch(/tool_events/);
    expect(t.description).toMatch(/human-readable reasoning sentence/i);
    expect(t.description).toMatch(/2-3 .*reasoning_sections/);
    expect(t.description).toMatch(/查看过程/);
  });

  it("收尾约束:description 提醒发卡是 side-effect,turn 必须补文本收尾(否则被判 incomplete)", () => {
    const t = getTool();
    // 强调发卡不是对话回复
    expect(t.description).toMatch(/side[- ]?effect/i);
    // 要求调用后仍要输出文本 / 不要以工具调用结束 turn
    expect(t.description).toMatch(/final text|text message|end your turn/i);
    // 点明零文本收尾会被判 incomplete
    expect(t.description).toMatch(/incomplete/i);
  });

  it("schema 不暴露模型可控 channelId/threadId,只要求 blocks", () => {
    const schema = getTool().parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.properties.channelId).toBeUndefined();
    expect(schema.properties.threadId).toBeUndefined();
    expect(schema.required).toEqual(["blocks"]);
  });
});

describe("execute:发展示卡", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OCTO_CARD_REQUEST_LOG_DIR;
    setupOk();
  });

  it("始终发送到可信当前会话,忽略模型伪造 channelId", async () => {
    const t = getTool();
    const res = await t.execute("call-1", {
      channelId: "group:attacker-controlled",
      title: "报告",
      blocks: [
        { type: "text", text: "任务完成" },
        { type: "facts", items: [{ label: "耗时", value: "30ms" }] },
      ],
    });
    expect(sendCardMessage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendCardMessage).mock.calls[0][0];
    expect(call.channelId).toBe("g1");
    expect((call.card as { type: string }).type).toBe("AdaptiveCard");
    expect((call.card as { version: string }).version).toBe("1.5");
    // 展示型 → 顶层无 actions
    expect(call.card).not.toHaveProperty("actions");
    expect(res.content[0].text).toContain("m1"); // 返回 message_id
  });

  it("execute 忽略本地 cardDisplay:false，仍以服务端配置为准", async () => {
    const tool = getTool();
    vi.mocked(resolveOctoAccount).mockReturnValue({
      accountId: "default",
      enabled: true,
      configured: true,
      config: {
        botToken: "tok",
        apiUrl: "https://api.test",
        pollIntervalMs: 2000,
        heartbeatIntervalMs: 30000,
        cardDisplay: false,
      },
    } as never);
    const res = await tool.execute("display-disabled-after-discovery", {
      blocks: [{ type: "text", text: "server policy allows this" }],
    });

    expect(res.details).toMatchObject({ message_id: "m1" });
    expect(getBotCardProfile).toHaveBeenCalledTimes(1);
    expect(sendCardMessage).toHaveBeenCalledTimes(1);
  });

  it("服务端 display_enabled=false 时拒绝发送展示卡", async () => {
    vi.mocked(getBotCardProfile).mockResolvedValue({
      available: true,
      enabled: true,
      profiles: ["octo/v1"],
      card_version: "1.5",
      elements: ["TextBlock"],
      config: {
        card_enabled: true,
        display_enabled: false,
        interaction_enabled: true,
        reasoning_enabled: false,
        reasoning_template_ref: null,
      },
    } as never);

    const res = await getTool().execute("server-display-disabled", {
      blocks: [{ type: "text", text: "must use plain text" }],
    });

    expect(res.content[0].text).toMatch(/disabled|plain text/i);
    expect(sendCardMessage).not.toHaveBeenCalled();
  });

  it("服务端成功响应缺 message_id 时保持稳定空值结果", async () => {
    vi.mocked(sendCardMessage).mockResolvedValue({} as never);
    const res = await getTool().execute("missing-message-id", {
      blocks: [{ type: "text", text: "sent without id" }],
    });
    expect(sendCardMessage).toHaveBeenCalledTimes(1);
    expect(res.details).toMatchObject({ message_id: "" });
  });

  it("当前 thread 从可信 deliveryContext 合成 CommunityTopic 目标", async () => {
    const t = getTool({ channel: "octo", to: "group:g1", threadId: "topic-7", accountId: "default" });
    await t.execute("thread-call", {
      channelId: "user:attacker",
      threadId: "evil-topic",
      blocks: [{ type: "text", text: "thread result" }],
    });
    const call = vi.mocked(sendCardMessage).mock.calls[0][0];
    expect(call.channelId).toBe("g1____topic-7");
    expect(call.channelType).toBe(5);
  });

  it("缺少可信当前会话上下文时拒绝副作用,即使模型提供 channelId", async () => {
    const t = getTool(null);
    const res = await t.execute("missing-route", {
      channelId: "group:g1",
      blocks: [{ type: "text", text: "must not send" }],
    });
    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/trusted|current.*conversation|delivery context/i);
  });

  it("blocks 空 + title 空 → 拒绝(不发)", async () => {
    const t = getTool();
    const res = await t.execute("call-2", { channelId: "group:g1", blocks: [] });
    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(res.content[0].text.toLowerCase()).toMatch(/error|empty|blocks/);
  });

  it("gate available:false + env 未开 → 拒绝(agent 由错误退回文本)", async () => {
    vi.mocked(getBotCardProfile).mockResolvedValue({ available: false, enabled: false } as never);
    delete process.env.OCTO_CARD_MESSAGE_ENABLED;
    const t = getTool();
    const res = await t.execute("c3", { channelId: "group:g1", title: "T", blocks: [{ type: "text", text: "a" }] });
    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(res.content[0].text.toLowerCase()).toMatch(/error|not (available|enabled)|unavailable/);
  });

  it("gate available:false 即使有旧 env opt-in 也 fail closed", async () => {
    vi.mocked(getBotCardProfile).mockResolvedValue({ available: false, enabled: false } as never);
    process.env.OCTO_CARD_MESSAGE_ENABLED = "1";
    try {
      const res = await getTool().execute("legacy-opt-in", {
        blocks: [{ type: "text", text: "legacy deployment" }],
      });
      expect(sendCardMessage).not.toHaveBeenCalled();
      expect(res.content[0].text).toMatch(/disabled|policy/i);
    } finally {
      delete process.env.OCTO_CARD_MESSAGE_ENABLED;
    }
  });

  it("gate enabled:false → 拒绝", async () => {
    vi.mocked(getBotCardProfile).mockResolvedValue({
      available: true,
      enabled: false,
      config: {
        card_enabled: false,
        display_enabled: false,
        interaction_enabled: false,
        reasoning_enabled: false,
        reasoning_template_ref: null,
      },
    } as never);
    const t = getTool();
    const res = await t.execute("c4", { channelId: "group:g1", title: "T", blocks: [{ type: "text", text: "a" }] });
    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(res.content[0].text.toLowerCase()).toMatch(/error|disabled|not enabled/);
  });

  it("profile 不含 octo/v1 → 拒绝(避免 400)", async () => {
    vi.mocked(getBotCardProfile).mockResolvedValue({
      available: true,
      enabled: true,
      profiles: ["octo/v2"],
      card_version: "1.5",
      config: {
        card_enabled: true,
        display_enabled: true,
        interaction_enabled: true,
        reasoning_enabled: false,
        reasoning_template_ref: null,
      },
    } as never);
    const t = getTool();
    const res = await t.execute("c5", { channelId: "group:g1", title: "T", blocks: [{ type: "text", text: "a" }] });
    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(res.content[0].text.toLowerCase()).toMatch(/profile|不兼容/);
  });

  it("card_version 不兼容 → fail closed", async () => {
    vi.mocked(getBotCardProfile).mockResolvedValue({
      available: true,
      enabled: true,
      profiles: ["octo/v1"],
      card_version: "1.4",
      config: {
        card_enabled: true,
        display_enabled: true,
        interaction_enabled: true,
        reasoning_enabled: false,
        reasoning_template_ref: null,
      },
    } as never);
    const res = await getTool().execute("bad-version", {
      blocks: [{ type: "text", text: "must not send" }],
    });
    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/card_version|compatible/i);
  });

  it("无 accountId 时仅允许唯一配置账号回退；多账号歧义则拒绝", async () => {
    const single = createDisplayCardTool({
      cfg: mockCfg,
      deliveryContext: { channel: "octo", to: "group:g1" },
      messageChannel: "octo",
    } as DisplayToolParams)[0];
    await single.execute("single-account", { blocks: [{ type: "text", text: "ok" }] });
    expect(sendCardMessage).toHaveBeenCalledTimes(1);

    vi.mocked(sendCardMessage).mockClear();
    vi.mocked(listOctoAccountIds).mockReturnValue(["a", "b"]);
    const ambiguous = createDisplayCardTool({
      cfg: mockCfg,
      deliveryContext: { channel: "octo", to: "group:g1" },
      messageChannel: "octo",
    } as DisplayToolParams)[0];
    const res = await ambiguous.execute("ambiguous-account", {
      blocks: [{ type: "text", text: "must not send" }],
    });
    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/no configured Octo account/i);
  });

  it("可信 delivery account 与 active agent 不一致时拒绝", async () => {
    const res = await getTool({
      channel: "octo",
      to: "group:g1",
      accountId: "other",
    }).execute("account-mismatch", { blocks: [{ type: "text", text: "must not send" }] });
    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/account.*does not match/i);
  });

  it("目标账号未完整配置或缺 apiUrl 时拒绝", async () => {
    vi.mocked(listOctoAccountIds).mockReturnValue(["default", "bad"]);
    vi.mocked(resolveOctoAccount).mockImplementation(({ accountId }: { accountId?: string }) => ({
      accountId: accountId ?? "default",
      enabled: accountId !== "bad",
      configured: accountId !== "bad",
      config: {
        botToken: accountId === "bad" ? "" : "tok",
        apiUrl: "https://api.test",
      },
    }) as never);
    const bad = createDisplayCardTool({
      cfg: mockCfg,
      agentAccountId: "bad",
      deliveryContext: { channel: "octo", to: "group:g1", accountId: "bad" },
    } as DisplayToolParams)[0];
    const badResult = await bad.execute("bad-account", { blocks: [{ type: "text", text: "x" }] });
    expect(badResult.content[0].text).toMatch(/not fully configured/i);

    setupOk();
    vi.mocked(resolveOctoAccount).mockReturnValue({
      accountId: "default",
      enabled: true,
      configured: true,
      config: { botToken: "tok", apiUrl: "" },
    } as never);
    const missingUrl = await getTool().execute("missing-url", { blocks: [{ type: "text", text: "x" }] });
    expect(missingUrl.content[0].text).toMatch(/apiUrl not configured/i);
    expect(sendCardMessage).not.toHaveBeenCalled();
  });

  it("profile probe 与 send 的非 Error 异常都转成稳定工具错误", async () => {
    vi.mocked(getBotCardProfile).mockRejectedValue("profile unavailable");
    const probe = await getTool().execute("probe-failure", { blocks: [{ type: "text", text: "x" }] });
    expect(probe.content[0].text).toContain("profile unavailable");

    setupOk();
    vi.mocked(sendCardMessage).mockRejectedValue({ reason: "send rejected" });
    const send = await getTool().execute("send-failure", { blocks: [{ type: "text", text: "x" }] });
    expect(send.content[0].text).toContain("[object Object]");
  });

  it("能力协商生效:advertise 不含 FactSet → 卡里 FactSet 被降级(不 400,不拒绝)", async () => {
    vi.mocked(getBotCardProfile).mockResolvedValue({
      available: true,
      enabled: true,
      profiles: ["octo/v1"],
      card_version: "1.5",
      elements: ["TextBlock"], // 无 FactSet
      config: {
        card_enabled: true,
        display_enabled: true,
        interaction_enabled: true,
        reasoning_enabled: false,
        reasoning_template_ref: null,
      },
    } as never);
    const t = getTool();
    await t.execute("c6", { channelId: "group:g1", blocks: [
      { type: "facts", items: [{ label: "k", value: "v" }] },
    ]});
    const call = vi.mocked(sendCardMessage).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    const body = (call!.card as { body: Array<Record<string, unknown>> }).body;
    // FactSet 降级为 TextBlock 罗列 —— 不会有 FactSet 元素
    expect(body.some((e) => e.type === "FactSet")).toBe(false);
    expect(body.some((e) => e.type === "TextBlock")).toBe(true);
  });

  it("manifest 明确 elements=[] → 无安全 fallback,拒绝发送", async () => {
    vi.mocked(getBotCardProfile).mockResolvedValue({
      available: true,
      enabled: true,
      profiles: ["octo/v1"],
      card_version: "1.5",
      elements: [],
      config: {
        card_enabled: true,
        display_enabled: true,
        interaction_enabled: true,
        reasoning_enabled: false,
        reasoning_template_ref: null,
      },
    } as never);
    const res = await getTool().execute("empty-elements", {
      blocks: [{ type: "text", text: "cannot render" }],
    });
    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/TextBlock|fallback/i);
  });

  it("manifest hard limits 贯穿到最终 sendCardMessage 信封", async () => {
    vi.mocked(getBotCardProfile).mockResolvedValue({
      available: true,
      enabled: true,
      profiles: ["octo/v1"],
      card_version: "1.5",
      elements: ["TextBlock", "RichTextBlock", "Container", "Table"],
      limits: { max_nodes: 8, max_depth: 3, max_payload_bytes: 420 },
      config: {
        card_enabled: true,
        display_enabled: true,
        interaction_enabled: true,
        reasoning_enabled: false,
        reasoning_template_ref: null,
      },
    } as never);
    await getTool().execute("limited", {
      blocks: [{
        type: "table",
        rows: Array.from({ length: 8 }, (_, row) => ({
          cells: [{ blocks: [{ type: "rich", segments: [{ text: `第${row}行🙂`.repeat(20), bold: true }] }] }],
        })),
      }],
    });
    const sent = vi.mocked(sendCardMessage).mock.calls[0][0];
    expect(countCardNodes(sent.card)).toBeLessThanOrEqual(8);
    expect(cardMaxDepth(sent.card)).toBeLessThanOrEqual(3);
    expect(cardPayloadBytes(sent.card, sent.plain ?? "")).toBeLessThanOrEqual(420);
  });

  it("安全:agent 传入的 onBehalfOf 被忽略(不接受不可信身份,防 persona 冒充)", async () => {
    const t = getTool();
    await t.execute("c7", {
      channelId: "group:g1",
      title: "T",
      blocks: [{ type: "text", text: "a" }],
      onBehalfOf: "u_grantor", // 不可信入参 —— 不应透传
    });
    // 展示卡始终以 bot 自身身份发出;OBO 绝不由模型输入指定(与进度卡路径一致)。
    expect(vi.mocked(sendCardMessage).mock.calls[0][0].onBehalfOf).toBeUndefined();
  });

  it("非法 block 静默丢弃(不 fail;不合法字段类型的整块跳过)", async () => {
    const t = getTool();
    await t.execute("c8", {
      channelId: "group:g1",
      blocks: [
        { type: "invalid_kind", stuff: "x" }, // 未知 type
        { type: "text" }, // 缺 text
        { type: "text", text: 42 }, // text 非 string
        { type: "text", text: "存活" },
      ],
    });
    const call = vi.mocked(sendCardMessage).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    const body = (call!.card as { body: Array<{ text?: string }> }).body;
    // 只剩存活的
    expect(body.some((e) => e.text === "存活")).toBe(true);
    expect(body).toHaveLength(1);
  });

  it("blocks 全被验证/脱敏过滤空 + title 空 → 拒绝", async () => {
    const t = getTool();
    const res = await t.execute("c9", {
      channelId: "group:g1",
      blocks: [
        { type: "invalid" },
        { type: "text", text: "AKIAIOSFODNN7EXAMPLE" }, // 全被脱敏
      ],
    });
    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(res.content[0].text.toLowerCase()).toMatch(/error|empty|blocks/);
  });

  it("OCTO_CARD_REQUEST_LOG_DIR:记录脱敏后的请求参数,用 client_msg_no 关联实际消息", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "octo-card-req-"));
    process.env.OCTO_CARD_REQUEST_LOG_DIR = dir;
    try {
      const t = getTool();
      const res = await t.execute("trace-call-1", {
        channelId: "group:g1",
        title: "调试卡",
        blocks: [
          { type: "text", text: "safe text" },
          { type: "text", text: "Authorization: Bearer sk-abcdefghijklmnop" },
        ],
      });
      const sent = vi.mocked(sendCardMessage).mock.calls[0][0];
      expect(typeof sent.clientMsgNo).toBe("string");
      expect(sent.clientMsgNo).toBeTruthy();
      expect(res.details).toMatchObject({ client_msg_no: sent.clientMsgNo });

      const logText = await readFile(path.join(dir, "display-card-requests.jsonl"), "utf8");
      const entry = JSON.parse(logText.trim());
      expect(entry.tool_call_id).toBe("trace-call-1");
      expect(entry.message_id).toBe("m1");
      expect(entry.client_msg_no).toBe(sent.clientMsgNo);
      expect(entry.args.title).toBe("调试卡");
      expect(entry.args.channelId).toBeUndefined();
      expect(entry.args.threadId).toBeUndefined();
      expect(JSON.stringify(entry)).toContain("safe text");
      expect(JSON.stringify(entry)).not.toContain("sk-abcdefghijklmnop");
      expect(JSON.stringify(entry)).toContain("[redacted]");
    } finally {
      delete process.env.OCTO_CARD_REQUEST_LOG_DIR;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
