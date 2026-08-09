import { describe, expect, it, vi } from "vitest";
import { renderCardActionStatus } from "./card-action-status.js";
import { REDUCE_INPUT_MAX } from "./card-render.js";

/** Collect every `text` string in a rendered card, in-memory (single backslashes, no JSON escaping). */
function collectText(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, acc);
    return acc;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "text" && typeof value === "string") acc.push(value);
      else collectText(value, acc);
    }
  }
  return acc;
}

describe("renderCardActionStatus", () => {
  it("保留原卡方案正文，冻结已选输入，移除 Submit 并追加选择状态", () => {
    const rendered = renderCardActionStatus({
      card: {
        type: "AdaptiveCard",
        version: "1.5",
        body: [
          { type: "TextBlock", text: "选择一个方案", weight: "Bolder" },
          {
            type: "Container",
            items: [
              { type: "TextBlock", text: "A · 体验碾压" },
              { type: "TextBlock", text: "C · 生态打法" },
            ],
          },
          {
            type: "Input.ChoiceSet",
            id: "strategy",
            label: "方案",
            choices: [
              { title: "A · 体验碾压", value: "a" },
              { title: "C · 生态打法", value: "c" },
            ],
          },
        ],
        actions: [{ type: "Action.Submit", id: "submit", title: "确认选择" }],
      },
      plain: "选择一个方案\nA · 体验碾压\nC · 生态打法\n可选操作：确认选择",
      inputs: { strategy: "c" },
      operator: "Alice",
      actionLabel: "确认选择",
      status: "completed",
    } as never);

    const json = JSON.stringify(rendered.card);
    expect(json).toContain("A · 体验碾压");
    expect(json).toContain("C · 生态打法");
    expect(json).toContain("方案：C · 生态打法");
    expect(json).toContain("Alice 已选择「C · 生态打法」");
    expect(json).not.toContain("已选择「确认选择」");
    expect(json).not.toContain("Action.Submit");
    expect(json).not.toContain("Input.ChoiceSet");
    expect(rendered.plain).toContain("选择一个方案");
    expect(rendered.plain).toContain("方案：C · 生态打法");
    expect(rendered.plain).not.toContain("可选操作：");
  });

  it("中和提交值里的 markdown 链接：回显不产生活链接(防钓鱼冒名)", () => {
    const rendered = renderCardActionStatus({
      card: {
        type: "AdaptiveCard",
        version: "1.5",
        body: [
          { type: "TextBlock", text: "填写理由", weight: "Bolder" },
          { type: "Input.Text", id: "reason", label: "理由" },
        ],
        actions: [{ type: "Action.Submit", id: "submit", title: "提交" }],
      },
      plain: "填写理由\n可选操作：提交",
      // A group member submits a value crafted to render as a bot-authored hyperlink.
      inputs: { reason: "[Finance Portal](https://evil.example/login?token=abc)" },
      operator: "Mallory",
      actionLabel: "提交",
      status: "completed",
    } as never);

    const texts = collectText(rendered.card).join("\n");
    expect(texts).toContain("理由：");
    // Credential-bearing path/query stripped like authored content (reduceUrlsInText keeps only
    // scheme://registrable-domain — the deceptive part is the label, handled next).
    expect(texts).not.toContain("/login");
    expect(texts).not.toContain("token=abc");
    // Opening/closing brackets escaped → CommonMark renders them literally: the "Finance Portal"
    // label can no longer hide the evil destination behind a bot-authored hyperlink.
    expect(texts).toContain("\\[Finance Portal\\]");
    // The raw link markup that would linkify must not survive verbatim.
    expect(texts).not.toContain("[Finance Portal](");
    // Same property on the plain fallback.
    expect(rendered.plain).not.toContain("[Finance Portal](");
    expect(rendered.plain).not.toContain("token=abc");
  });

  it("中和 operator 显示名里的 markdown(显示名由用户自设)", () => {
    const rendered = renderCardActionStatus({
      card: {
        type: "AdaptiveCard",
        version: "1.5",
        body: [{ type: "TextBlock", text: "选择方案" }],
        actions: [{ type: "Action.Submit", id: "s", title: "确认" }],
      },
      plain: "选择方案",
      inputs: {},
      operator: "[admin](https://evil.example)",
      actionLabel: "确认",
      status: "processing",
    } as never);

    const texts = collectText(rendered.card).join("\n");
    expect(texts).toContain("正在处理");
    // The deceptive "admin" label link is broken (opening bracket escaped); the bare origin that
    // remains is honest and visible, matching how authored content reduces URLs.
    expect(texts).toContain("\\[admin\\]");
    expect(texts).not.toContain("[admin](");
  });

  it("显示名里归约漏掉的凭据退回 [redacted],不明文渲染", () => {
    // neutralizeEcho 是全树唯一「归约即脱敏、后面没有守卫」的 sink。归约本身漏掉的凭据形状
    // (口令超 256 上限整条不匹配 —— 评审第七轮 P1)此前原样进群卡片。补守卫后退回占位符。
    const pw = "correcthorsebatterystaple".repeat(11).slice(0, 275);
    const rendered = renderCardActionStatus({
      card: {
        type: "AdaptiveCard",
        version: "1.5",
        body: [{ type: "TextBlock", text: "选择方案" }],
        actions: [{ type: "Action.Submit", id: "s", title: "确认" }],
      },
      plain: "选择方案",
      inputs: {},
      operator: `alice:${pw}@db.example.com`,
      actionLabel: "确认",
      status: "completed",
    } as never);
    const texts = collectText(rendered.card).join("\n") + "\n" + rendered.plain;
    expect(texts, "275 字符口令明文进了群卡片").not.toContain(pw);
    expect(texts).toContain("[redacted]");
  });

  it("超长 operator 的空白判定不在 raw string 上 trim", () => {
    const originalTrim = String.prototype.trim;
    let maxTrimmedLength = 0;
    const trim = vi.spyOn(String.prototype, "trim").mockImplementation(function (this: string) {
      maxTrimmedLength = Math.max(maxTrimmedLength, this.length);
      return originalTrim.call(this);
    });
    try {
      const operator = "x" + " ".repeat(1_000_000);
      const rendered = renderCardActionStatus({
        card: { type: "AdaptiveCard", version: "1.5", body: [] },
        plain: "",
        inputs: {},
        operator,
        actionLabel: "确认",
        status: "completed",
      });
      expect(collectText(rendered.card).join("\n")).toContain("[redacted]");
      expect(maxTrimmedLength, `trim 收到了 ${maxTrimmedLength} 字符的原始值`)
        .toBeLessThanOrEqual(REDUCE_INPUT_MAX);
    } finally {
      trim.mockRestore();
    }
  });

  it("普通提交值与显示名不被加转义(无回归)", () => {
    const rendered = renderCardActionStatus({
      card: {
        type: "AdaptiveCard",
        version: "1.5",
        body: [{ type: "Input.Text", id: "amount", label: "金额" }],
        actions: [{ type: "Action.Submit", id: "s", title: "确认" }],
      },
      plain: "可选操作：确认",
      inputs: { amount: "100" },
      operator: "Alice",
      actionLabel: "确认",
      status: "completed",
    } as never);

    const texts = collectText(rendered.card).join("\n");
    expect(texts).toContain("金额：100");
    expect(texts).toContain("Alice 已选择");
    // Clean values gain no backslash noise.
    expect(texts).not.toContain("\\");
  });
});
