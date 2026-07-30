import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api-fetch.js", () => ({ editCardMessage: vi.fn() }));

import { editCardMessage } from "./api-fetch.js";
import { handleCardAction } from "./card-action-handler.js";
import { _resetCardSessionsForTests, registerCardSession } from "./card-session.js";
import type { CardAction } from "./card-action.js";

const action = (overrides: Partial<CardAction> = {}): CardAction => ({
  eventId: 10,
  messageId: "m1",
  channelId: "g1",
  channelType: 2,
  actionId: "approve",
  inputs: { note: "ok" },
  operatorUid: "u1",
  ...overrides,
});

function register(): void {
  registerCardSession("m1", {
    sessionKey: "s1",
    accountId: "a1",
    channelId: "g1",
    channelType: 2,
    title: "发布确认",
    card: {
      type: "AdaptiveCard",
      version: "1.5",
      body: [
        { type: "TextBlock", text: "发布确认" },
        { type: "Input.Text", id: "note", label: "备注" },
      ],
      actions: [{ type: "Action.Submit", id: "approve", title: "批准" }],
    },
    plain: "发布确认\n[备注]",
    actionLabels: { approve: "批准" },
    inputIds: ["note"],
    maxInputTextBytes: 16,
    maxInputsBytes: 64,
  });
}

describe("handleCardAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCardSessionsForTests();
    register();
    vi.mocked(editCardMessage).mockResolvedValue();
  });

  it("先显示处理中，dispatch 成功后显示完成并使用递增 card_seq", async () => {
    const dispatch = vi.fn().mockResolvedValue("completed");
    expect(await handleCardAction({
      action: action(),
      accountId: "a1",
      apiUrl: "https://api.test",
      botToken: "tok",
      operatorName: "Alice",
      dispatch,
    })).toBe("completed");

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(editCardMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(editCardMessage).mock.calls[0][0]).toEqual(expect.objectContaining({
      profile: "octo/v2",
      cardSeq: 1,
    }));
    expect(vi.mocked(editCardMessage).mock.calls[1][0]).toEqual(expect.objectContaining({
      profile: "octo/v2",
      cardSeq: 2,
    }));
    const completed = vi.mocked(editCardMessage).mock.calls[1][0];
    const completedJson = JSON.stringify(completed.card);
    expect(completedJson).toContain("发布确认");
    expect(completedJson).toContain("备注：ok");
    expect(completedJson).toContain("Alice 已选择「批准」");
    expect(completedJson).not.toContain("Input.Text");
    expect(completedJson).not.toContain("Action.Submit");
    expect(completed.plain).not.toContain("可选操作：");
  });

  it("重复 event 或第二次点击不再 dispatch", async () => {
    const dispatch = vi.fn().mockResolvedValue("completed");
    await handleCardAction({
      action: action(), accountId: "a1", apiUrl: "https://api.test", botToken: "tok", dispatch,
    });
    expect(await handleCardAction({
      action: action({ eventId: 11 }), accountId: "a1", apiUrl: "https://api.test", botToken: "tok", dispatch,
    })).toBe("duplicate");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("未知卡、账号/频道不匹配、未知 action 均 fail-safe 忽略", async () => {
    const dispatch = vi.fn();
    expect(await handleCardAction({
      action: action({ messageId: "missing" }), accountId: "a1", apiUrl: "x", botToken: "t", dispatch,
    })).toBe("ignored");
    expect(await handleCardAction({
      action: action(), accountId: "other", apiUrl: "x", botToken: "t", dispatch,
    })).toBe("ignored");
    expect(await handleCardAction({
      action: action({ channelId: "g2" }), accountId: "a1", apiUrl: "x", botToken: "t", dispatch,
    })).toBe("ignored");
    expect(await handleCardAction({
      action: action({ actionId: "forged" }), accountId: "a1", apiUrl: "x", botToken: "t", dispatch,
    })).toBe("ignored");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["reasoning_stop", "reasoning_retry"])(
    "%s 只记录 unsupported 并消费，不派发 agent 或伪造成功状态",
    async (actionId) => {
      const dispatch = vi.fn();
      const warnings: string[] = [];
      expect(await handleCardAction({
        action: action({
          messageId: "registry-reasoning-card",
          actionId,
          data: {
            action: actionId,
            effect: actionId === "reasoning_stop" ? "stop_reasoning" : "retry_reasoning",
            reasoning_id: "run-1",
            owner: "ai",
            action_type: "reasoning.control",
          },
        }),
        accountId: "a1",
        apiUrl: "x",
        botToken: "t",
        dispatch,
        log: { warn: (message) => warnings.push(message) },
      })).toBe("ignored");
      expect(dispatch).not.toHaveBeenCalled();
      expect(editCardMessage).not.toHaveBeenCalled();
      expect(warnings).toContainEqual(expect.stringContaining(`reasoning control is not supported action=${actionId}`));
    },
  );

  it("inputs 超限时不 dispatch，并把原卡更新为失败", async () => {
    const dispatch = vi.fn();
    expect(await handleCardAction({
      action: action({ inputs: { note: "汉".repeat(20) } }),
      accountId: "a1", apiUrl: "x", botToken: "t", dispatch,
    })).toBe("rejected");
    expect(dispatch).not.toHaveBeenCalled();
    expect(editCardMessage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(editCardMessage).mock.calls[0][0].card)).toContain("提交内容过大");
  });

  it("dispatch 失败时显示失败、释放 claim 并向 poller 抛错以便重试", async () => {
    const failure = new Error("agent unavailable");
    const dispatch = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce("completed");
    await expect(handleCardAction({
      action: action(), accountId: "a1", apiUrl: "x", botToken: "t", dispatch,
    })).rejects.toThrow("agent unavailable");
    expect(JSON.stringify(vi.mocked(editCardMessage).mock.calls.at(-1)?.[0].card)).toContain("处理失败");

    await expect(handleCardAction({
      action: action(), accountId: "a1", apiUrl: "x", botToken: "t", dispatch,
    })).resolves.toBe("completed");
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("派发被明确丢弃时把卡标为失败，而不是 completed", async () => {
    const dispatch = vi.fn().mockResolvedValue("rejected");
    expect(await handleCardAction({
      action: action(), accountId: "a1", apiUrl: "x", botToken: "t", dispatch,
    })).toBe("rejected");
    expect(JSON.stringify(vi.mocked(editCardMessage).mock.calls.at(-1)?.[0].card)).toContain("处理失败");
  });

  it("dispatch 持续抛错达到上限后落终态并停止重放（不再无限重跑 agent turn）", async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error("agent down"));
    // 同一 event 的前两次向 poller 抛错以便重放（cursor 不前进）。
    await expect(handleCardAction({
      action: action(), accountId: "a1", apiUrl: "x", botToken: "t", dispatch,
    })).rejects.toThrow("agent down");
    await expect(handleCardAction({
      action: action(), accountId: "a1", apiUrl: "x", botToken: "t", dispatch,
    })).rejects.toThrow("agent down");
    // 第三次达到上限：不再抛错，落终态 rejected（poller 得以推进 cursor）。
    expect(await handleCardAction({
      action: action(), accountId: "a1", apiUrl: "x", botToken: "t", dispatch,
    })).toBe("rejected");
    expect(dispatch).toHaveBeenCalledTimes(3);
    const deadLetter = JSON.stringify(vi.mocked(editCardMessage).mock.calls.at(-1)?.[0].card);
    expect(deadLetter).toContain("处理失败");
    // Dead-letter 是终态：剥离控件，成为只读状态帧。
    expect(deadLetter).not.toContain("Action.Submit");
    // 终态后同卡再点击（新 event）一律 duplicate，不再 dispatch。
    expect(await handleCardAction({
      action: action({ eventId: 11 }), accountId: "a1", apiUrl: "x", botToken: "t", dispatch,
    })).toBe("duplicate");
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it("可恢复失败的错误卡保留 Action.Submit 与可编辑输入，重试可从同卡发起", async () => {
    // 校验失败：错误帧仍须带提交按钮与输入控件（否则文案承诺的“重试”无从点击）。
    const dispatch = vi.fn().mockResolvedValue("completed");
    expect(await handleCardAction({
      action: action({ inputs: { note: "n".repeat(50) } }),
      accountId: "a1", apiUrl: "x", botToken: "t", dispatch,
    })).toBe("rejected");
    const validationCard = JSON.stringify(vi.mocked(editCardMessage).mock.calls.at(-1)?.[0].card);
    expect(validationCard).toContain("提交内容过大");
    expect(validationCard).toContain("Action.Submit");
    expect(validationCard).toContain("Input.Text");

    // dispatch 被明确丢弃：错误帧同样保留控件。
    vi.mocked(editCardMessage).mockClear();
    const rejectDispatch = vi.fn().mockResolvedValue("rejected");
    expect(await handleCardAction({
      action: action({ eventId: 11 }), accountId: "a1", apiUrl: "x", botToken: "t", dispatch: rejectDispatch,
    })).toBe("rejected");
    const rejectedCard = JSON.stringify(vi.mocked(editCardMessage).mock.calls.at(-1)?.[0].card);
    expect(rejectedCard).toContain("处理失败");
    expect(rejectedCard).toContain("Action.Submit");
    expect(rejectedCard).toContain("Input.Text");
  });

  it("校验失败后释放 claim，纠正输入后可在同卡重新提交", async () => {
    const dispatch = vi.fn().mockResolvedValue("completed");
    expect(await handleCardAction({
      action: action({ inputs: { note: "n".repeat(50) } }),
      accountId: "a1", apiUrl: "x", botToken: "t", dispatch,
    })).toBe("rejected");
    expect(dispatch).not.toHaveBeenCalled();
    // 纠正后（新 event）重新提交 → 正常 dispatch，而不是被永久锁死。
    expect(await handleCardAction({
      action: action({ eventId: 11, inputs: { note: "ok" } }),
      accountId: "a1", apiUrl: "x", botToken: "t", dispatch,
    })).toBe("completed");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("dispatch 明确丢弃后释放 claim，可重新提交（“请稍后重试”文案属实）", async () => {
    const dispatch = vi.fn().mockResolvedValueOnce("rejected").mockResolvedValueOnce("completed");
    expect(await handleCardAction({
      action: action(), accountId: "a1", apiUrl: "x", botToken: "t", dispatch,
    })).toBe("rejected");
    expect(await handleCardAction({
      action: action({ eventId: 11 }), accountId: "a1", apiUrl: "x", botToken: "t", dispatch,
    })).toBe("completed");
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
