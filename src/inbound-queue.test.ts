import { describe, expect, it } from "vitest";
import {
  dispatchInboundWithQueue,
  enqueueInbound,
  getInboundQueueKey,
  shouldBypassInboundQueue,
} from "./inbound-queue.js";
import { ChannelType, MessageType, type BotMessage } from "./types.js";

function message(channelId: string, channelType: ChannelType): BotMessage {
  return {
    message_id: "m1",
    message_seq: 1,
    from_uid: "u1",
    channel_id: channelId,
    channel_type: channelType,
    timestamp: 1,
    payload: { type: MessageType.Text, content: "hello" },
  };
}

describe("shared inbound queue", () => {
  it("账号和频道共同隔离队列 key，Thread 保留完整 channel_id", () => {
    expect(getInboundQueueKey("Bot-A", message("g1", ChannelType.Group)))
      .toBe("bot-a:group:g1");
    expect(getInboundQueueKey("Bot-A", message("g1____t1", ChannelType.CommunityTopic)))
      .toBe("bot-a:group:g1____t1");
    expect(getInboundQueueKey("Bot-B", message("g1", ChannelType.Group)))
      .toBe("bot-b:group:g1");
    expect(getInboundQueueKey("Bot-A", message("s123_u1@bot", ChannelType.DM)))
      .toBe("bot-a:dm:123:u1");
    expect(getInboundQueueKey("Bot-A", {
      ...message("sspace-42_human_user@sspace-42_bot_user", ChannelType.DM),
      from_uid: "human_user",
    })).toBe("bot-a:dm:space-42:human_user");
    expect(getInboundQueueKey("Bot-A", {
      ...message("s123_other_user@s123_user", ChannelType.DM),
      from_uid: "user",
    })).toBe("bot-a:dm:123:user");
    expect(getInboundQueueKey("Bot-A", { ...message("u1", ChannelType.DM), channel_id: undefined }))
      .toBe("bot-a:dm:u1");
  });

  it("同一 key 串行执行，并返回当前任务完成的 Promise", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = enqueueInbound("a:group:g1", async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
    });
    const second = enqueueInbound("a:group:g1", async () => {
      order.push("second");
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("前一个任务失败后仍执行后续任务", async () => {
    const order: string[] = [];
    const first = enqueueInbound("a:dm:u1", async () => {
      order.push("failed");
      throw new Error("boom");
    });
    const second = enqueueInbound("a:dm:u1", async () => {
      order.push("next");
    });

    await expect(first).rejects.toThrow("boom");
    await second;
    expect(order).toEqual(["failed", "next"]);
  });

  it("向调用方返回当前任务的实际结果", async () => {
    await expect(enqueueInbound("a:dm:u1", async () => "completed" as const))
      .resolves.toBe("completed");
  });

  it("仅让可信 Owner 在明确私聊中发送的审批命令绕过会话队列", () => {
    const direct = message("u1", ChannelType.DM);
    expect(
      shouldBypassInboundQueue({
        ...direct,
        payload: {
          type: MessageType.Text,
          content: "/approve plugin:request-1 allow-once",
        },
      }, "u1"),
    ).toBe(true);
    expect(
      shouldBypassInboundQueue({
        ...direct,
        payload: {
          type: MessageType.Text,
          content: "/approve plugin:request-1 deny",
        },
      }, "u1"),
    ).toBe(true);
    expect(
      shouldBypassInboundQueue({
        ...direct,
        payload: { type: MessageType.Text, content: "/approve request-1" },
      }, "u1"),
    ).toBe(false);
    expect(
      shouldBypassInboundQueue({
        ...message("g1", ChannelType.Group),
        payload: {
          type: MessageType.Text,
          content: "/approve plugin:request-1 allow-once",
        },
      }, "u1"),
    ).toBe(false);
  });

  it("兼容 OpenClaw 的决策别名和两种参数顺序", () => {
    const direct = message("u1", ChannelType.DM);
    const accepted = [
      "/approve request-1 allow",
      "/approve request-1 once",
      "/approve request-1 allowonce",
      "/approve request-1 always",
      "/approve request-1 allow-always",
      "/approve request-1 allowalways",
      "/approve request-1 deny",
      "/approve request-1 reject",
      "/approve request-1 block",
      "/approve deny request-1",
      "/approve allow request id with spaces",
      "approve request-1 allow-once",
      "approve deny request-1",
    ];

    for (const content of accepted) {
      expect(
        shouldBypassInboundQueue({
          ...direct,
          payload: { type: MessageType.Text, content },
        }, "u1"),
        content,
      ).toBe(true);
    }

  });

  it.each([
    "/approve request-1 allow-once",
    "approve request-1 allow-once",
  ])("dispatcher 仅让可信 Owner 的审批命令跳过同一会话队列: %s", async (approvalCommand) => {
    const direct = message("u1", ChannelType.DM);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });

    const dispatch = (content: string, run: (mode: "standard" | "approval-bypass") => Promise<void>) =>
      dispatchInboundWithQueue({
        accountId: "acct1",
        message: {
          ...direct,
          payload: { type: MessageType.Text, content },
        },
        ownerUid: "u1",
        run,
      });

    const first = dispatch("first ordinary message", async (mode) => {
      order.push(`first:${mode}`);
      markFirstStarted();
      await firstGate;
    });
    await firstStarted;
    const queued = dispatch("second ordinary message", async (mode) => {
      order.push(`second:${mode}`);
    });
    const approval = dispatch(approvalCommand, async (mode) => {
      order.push(`approval:${mode}`);
    });

    await approval;
    expect(order).toEqual([
      "first:standard",
      "approval:approval-bypass",
    ]);

    releaseFirst();
    await Promise.all([first, queued]);
    expect(order).toEqual([
      "first:standard",
      "approval:approval-bypass",
      "second:standard",
    ]);
  });

  it("非 Owner、未登记 Owner 和不完整审批命令不能绕过", () => {
    const direct = message("u1", ChannelType.DM);
    const approval = {
      ...direct,
      payload: {
        type: MessageType.Text,
        content: "/approve request-1 allow-once",
      },
    };

    expect(shouldBypassInboundQueue(approval, "u2")).toBe(false);
    expect(shouldBypassInboundQueue(approval, undefined)).toBe(false);
    expect(shouldBypassInboundQueue({
      ...direct,
      payload: { type: MessageType.Text, content: "/approve request-1" },
    }, "u1")).toBe(false);
    expect(shouldBypassInboundQueue({
      ...direct,
      payload: { type: MessageType.Text, content: "/approve request-1 unknown" },
    }, "u1")).toBe(false);
  });

  it("字段缺失、群聊、Topic 和非文本载荷均 fail closed", () => {
    const approvalPayload = {
      type: MessageType.Text,
      content: "/approve request-1 allow-once",
    };
    const direct = message("u1", ChannelType.DM);

    expect(shouldBypassInboundQueue({
      ...direct,
      channel_type: undefined,
      payload: approvalPayload,
    }, "u1")).toBe(false);
    expect(shouldBypassInboundQueue({
      ...message("g1", ChannelType.Group),
      channel_id: undefined,
      payload: approvalPayload,
    }, "u1")).toBe(false);
    expect(shouldBypassInboundQueue({
      ...message("g1____t1", ChannelType.CommunityTopic),
      payload: approvalPayload,
    }, "u1")).toBe(false);
    expect(shouldBypassInboundQueue({
      ...direct,
      payload: {
        type: MessageType.File,
        content: "/approve request-1 allow-once",
      },
    }, "u1")).toBe(false);
  });
});
