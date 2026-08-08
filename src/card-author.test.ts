import { describe, expect, it, vi } from "vitest";
import { buildInteractiveCard } from "./card-author.js";
import { CARD_INTERACTIVE_PROFILE } from "./types.js";
import { cardPayloadBytes } from "./card-limits.js";
import { REDUCE_INPUT_MAX } from "./card-render.js";

const caps = {
  elements: new Set(["TextBlock"]),
  inputs: new Set(["Input.Text", "Input.ChoiceSet"]),
  actions: new Set(["Action.Submit"]),
  maxNodes: 20,
  maxDepth: 8,
  maxPayloadBytes: 16_384,
  maxInputTextBytes: 4096,
  maxInputsBytes: 8192,
};

const allInputCaps = {
  ...caps,
  inputs: new Set([
    "Input.Text",
    "Input.Number",
    "Input.Date",
    "Input.Time",
    "Input.Toggle",
    "Input.ChoiceSet",
  ]),
};

describe("buildInteractiveCard", () => {
  it("把受控 section/options blocks 构造成 Container/FactSet/ChoiceSet", () => {
    const result = buildInteractiveCard({
      title: "选择方案",
      text: "请选择一个方向",
      blocks: [
        {
          type: "section",
          title: "A · 体验碾压",
          text: "把响应速度、工具调用和多端体验做到极致。",
          facts: [{ title: "适合", value: "通用产品竞争" }],
        },
        {
          type: "options",
          id: "strategy",
          label: "方案",
          options: [
            { title: "A · 体验碾压", value: "a" },
            { title: "B · 垂直场景", value: "b" },
            { title: "C · 生态打法", value: "c" },
          ],
        },
      ],
      buttons: [{ id: "submit", label: "确认选择", style: "positive" }],
    } as never, {
      ...caps,
      elements: new Set(["TextBlock", "Container", "FactSet"]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "Container",
        items: expect.arrayContaining([
          expect.objectContaining({ type: "TextBlock", text: "A · 体验碾压" }),
          expect.objectContaining({
            type: "FactSet",
            facts: [{ title: "适合", value: "通用产品竞争" }],
          }),
        ]),
      }),
      expect.objectContaining({
        type: "Input.ChoiceSet",
        id: "strategy",
        style: "expanded",
        choices: expect.arrayContaining([{ title: "C · 生态打法", value: "c" }]),
      }),
    ]));
    expect(result.inputIds).toContain("strategy");
    expect(result.plain).toContain("A · 体验碾压");
    expect(result.plain).toContain("C · 生态打法");
  });

  it("options 最多 128 项且每项必须有安全的 title/value", () => {
    const build = (options: unknown[]) => buildInteractiveCard({
      title: "选择方案",
      blocks: [{ type: "options", id: "strategy", options }],
      buttons: [{ id: "submit", label: "确认" }],
    } as never, caps);

    expect(build(Array.from({ length: 129 }, (_, index) => ({
      title: `方案 ${index}`,
      value: `v${index}`,
    })))).toEqual(expect.objectContaining({ error: expect.stringMatching(/max 128/) }));
    expect(build([{ title: "", value: "a" }])).toEqual(expect.objectContaining({ ok: false }));
    expect(build([{ title: "方案 A", value: "" }])).toEqual(expect.objectContaining({ ok: false }));
  });

  it("构造顶层 Action.Submit 与输入，并生成同源 plain", () => {
    const result = buildInteractiveCard({
      title: "发布确认",
      text: "请选择下一步",
      buttons: [
        { id: "approve", label: "批准", data: { workflow: "release" }, style: "positive" },
        { id: "reject", label: "拒绝" },
      ],
      inputs: [
        { id: "reason", kind: "text", label: "原因" },
        {
          id: "env",
          kind: "choice",
          label: "环境",
          choices: [{ title: "生产", value: "prod" }],
        },
      ],
    }, caps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card.actions).toEqual([
      expect.objectContaining({ type: "Action.Submit", id: "approve", title: "批准" }),
      expect.objectContaining({ type: "Action.Submit", id: "reject", title: "拒绝" }),
    ]);
    expect(JSON.stringify(result.card.body)).toContain("Input.Text");
    expect(JSON.stringify(result.card.body)).toContain("Input.ChoiceSet");
    expect(result.plain).toContain("批准 / 拒绝");
    expect(result.plain).toContain("生产");
    expect(result.inputIds).toEqual(["reason", "env"]);
    expect(cardPayloadBytes(result.card, result.plain, CARD_INTERACTIVE_PROFILE))
      .toBeLessThanOrEqual(caps.maxPayloadBytes);
  });

  it("缺少 Action.Submit 或具体 Input capability 时 fail-closed", () => {
    expect(buildInteractiveCard({
      title: "确认",
      buttons: [{ id: "ok", label: "确定" }],
    }, { ...caps, actions: new Set() })).toEqual(expect.objectContaining({ ok: false }));

    expect(buildInteractiveCard({
      title: "确认",
      buttons: [{ id: "ok", label: "确定" }],
      inputs: [{ id: "amount", kind: "number" }],
    }, caps)).toEqual(expect.objectContaining({ ok: false }));
  });

  it("拒绝重复 id、无按钮、choice 无选项和超限 payload", () => {
    expect(buildInteractiveCard({ title: "确认", buttons: [] }, caps)).toEqual(expect.objectContaining({ ok: false }));
    expect(buildInteractiveCard({
      title: "确认",
      buttons: [{ id: "same", label: "A" }, { id: "same", label: "B" }],
    }, caps)).toEqual(expect.objectContaining({ ok: false }));
    expect(buildInteractiveCard({
      title: "确认",
      buttons: [{ id: "ok", label: "确定" }],
      inputs: [{ id: "env", kind: "choice", choices: [] }],
    }, caps)).toEqual(expect.objectContaining({ ok: false }));
    expect(buildInteractiveCard({
      title: "确认",
      text: "x".repeat(1000),
      buttons: [{ id: "ok", label: "确定" }],
    }, { ...caps, maxPayloadBytes: 100 })).toEqual(expect.objectContaining({ ok: false }));
  });

  it("卡片文本和 Action.data 中的密钥会被拒绝或脱敏", () => {
    expect(buildInteractiveCard({
      title: "token=sk-abcdefghijklmnopqrstuvwxyz123456",
      buttons: [{ id: "ok", label: "确定" }],
    }, caps)).toEqual(expect.objectContaining({ ok: false }));

    const result = buildInteractiveCard({
      title: "确认",
      buttons: [{
        id: "ok",
        label: "确定",
        data: { apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456", note: "safe" },
      }],
    }, caps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.stringify(result.card)).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it("覆盖所有输入类型并执行文本截断、data 深度限制和样式保留", () => {
    const result = buildInteractiveCard({
      title: "T".repeat(250),
      buttons: [{
        id: "delete",
        label: "删除",
        style: "destructive",
        data: {
          nested: [[[[[["too deep"]]]]]],
          values: [null, 1, true],
          note: "safe",
          ignored: undefined,
        },
      }],
      inputs: [
        { id: "text", placeholder: "说明" },
        { id: "number", kind: "number" },
        { id: "date", kind: "date" },
        { id: "time", kind: "time" },
        { id: "toggle", kind: "toggle" },
      ],
    }, { ...allInputCaps, maxInputTextBytes: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.title).toHaveLength(201);
    expect(result.card.actions).toEqual([
      expect.objectContaining({ id: "delete", style: "destructive" }),
    ]);
    expect(JSON.stringify(result.card)).toContain("[truncated]");
    expect(result.card.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "Input.Text", maxLength: 1, placeholder: "说明" }),
      expect.objectContaining({ type: "Input.Number" }),
      expect.objectContaining({ type: "Input.Date" }),
      expect.objectContaining({ type: "Input.Time" }),
      expect.objectContaining({ type: "Input.Toggle" }),
    ]));
  });

  it("拒绝不支持元素、数量越界和非法字段", () => {
    expect(buildInteractiveCard({
      title: "确认",
      buttons: [{ id: "ok", label: "确定" }],
    }, { ...caps, elements: new Set() })).toEqual(expect.objectContaining({ error: "TextBlock is not supported" }));
    expect(buildInteractiveCard({
      title: "确认",
      buttons: Array.from({ length: 7 }, (_, index) => ({ id: `b${index}`, label: `B${index}` })),
    }, caps)).toEqual(expect.objectContaining({ error: expect.stringMatching(/too many buttons/) }));
    expect(buildInteractiveCard({
      title: "确认",
      buttons: [{ id: "", label: "确定" }],
    }, caps)).toEqual(expect.objectContaining({ error: expect.stringMatching(/button id/) }));
    expect(buildInteractiveCard({
      title: "确认",
      buttons: [{ id: "ok", label: "token=sk-abcdefghijklmnopqrstuvwxyz123456" }],
    }, caps)).toEqual(expect.objectContaining({ error: expect.stringMatching(/safe label/) }));
    expect(buildInteractiveCard({
      title: "确认",
      text: "token=sk-abcdefghijklmnopqrstuvwxyz123456",
      buttons: [{ id: "ok", label: "确定" }],
    }, caps)).toEqual(expect.objectContaining({ error: expect.stringMatching(/text contains/) }));
  });

  it("拒绝非法输入定义、占位符和输入定义字节超限", () => {
    expect(buildInteractiveCard({
      title: "确认", buttons: [{ id: "ok", label: "确定" }], inputs: "bad",
    } as never, caps)).toEqual(expect.objectContaining({ error: "inputs must be an array" }));
    expect(buildInteractiveCard({
      title: "确认",
      buttons: [{ id: "ok", label: "确定" }],
      inputs: Array.from({ length: 6 }, (_, index) => ({ id: `i${index}` })),
    }, caps)).toEqual(expect.objectContaining({ error: expect.stringMatching(/too many inputs/) }));
    expect(buildInteractiveCard({
      title: "确认", buttons: [{ id: "ok", label: "确定" }], inputs: [{ id: "same" }, { id: "same" }],
    }, caps)).toEqual(expect.objectContaining({ error: "duplicate input id: same" }));
    expect(buildInteractiveCard({
      title: "确认", buttons: [{ id: "ok", label: "确定" }], inputs: [{ id: "kind", kind: "other" }],
    } as never, allInputCaps)).toEqual(expect.objectContaining({ error: "unsupported input kind: other" }));
    expect(buildInteractiveCard({
      title: "确认",
      buttons: [{ id: "ok", label: "确定" }],
      inputs: [{ id: "note", placeholder: "token=sk-abcdefghijklmnopqrstuvwxyz123456" }],
    }, caps)).toEqual(expect.objectContaining({ error: expect.stringMatching(/invalid placeholder/) }));
    expect(buildInteractiveCard({
      title: "确认",
      buttons: [{ id: "ok", label: "确定" }],
      inputs: [{ id: "env", kind: "choice", choices: [{ title: "", value: "prod" }] }],
    }, caps)).toEqual(expect.objectContaining({ error: expect.stringMatching(/invalid choices/) }));
    expect(buildInteractiveCard({
      title: "确认", buttons: [{ id: "ok", label: "确定" }], inputs: [{ id: "note", label: "备注" }],
    }, { ...caps, maxInputsBytes: 1 })).toEqual(expect.objectContaining({ error: "input definitions exceed max_inputs_bytes" }));
  });
});

describe("标题失败时的原因", () => {
  const button = { id: "b", label: "ok", value: "v" };
  // 归约跑在 cleanText 自己的 max 截断**之前**,所以一个超长且不含空白的标题会被界整段拒掉。
  // 之前一律报「含敏感信息」,把作者指向了错误的方向 —— 真实原因是长度。
  it("超长无空白 → 说长度,不说敏感", () => {
    const r = buildInteractiveCard({ title: "T".repeat(4100), buttons: [button] } as never);
    expect("error" in r && r.error).toContain("too long to sanitize");
    expect("error" in r && r.error).not.toContain("sensitive");
  });
  it("真敏感 → 说敏感", () => {
    const r = buildInteractiveCard({ title: "my password is hunter2", buttons: [button] } as never);
    expect("error" in r && r.error).toContain("must not contain sensitive data");
  });
  it("空 → 说必填", () => {
    const r = buildInteractiveCard({ title: "   ", buttons: [button] } as never);
    expect("error" in r && r.error).toContain("is required");
  });
  // 归约返回空还有第三个原因,而上面三条一条都盖不到它 —— 反向验证时把长度判据改成恒真,
  // 这一组全绿,说明「短标题被告知超过 4000 字符」这个缺陷当时没有任何断言看得见。
  it("短的不可解析 URL → 说 URL,不说长度", () => {
    const r = buildInteractiveCard({ title: "http://[", buttons: [button] } as never);
    expect("error" in r && r.error).toContain("could not be parsed");
    expect("error" in r && r.error, "5 个字符的标题被告知超过 4000 字符")
      .not.toContain("too long");
  });
  // 超长、有空白、但切口之后那段敏感 —— 界拒的理由是内容不是长度,报错也要这么说。
  it("超长但敏感尾巴 → 说敏感,不说长度", () => {
    const title = `deploy notes ${"word ".repeat(900)} AKIAIOSFODNN7EXAMPLE`;
    expect(title.length).toBeGreaterThan(4000);
    const r = buildInteractiveCard({ title, buttons: [button] } as never);
    expect("error" in r && r.error).toContain("must not contain sensitive data");
    expect("error" in r && r.error).not.toContain("too long");
  });

  it("超长标题的空白判定不在 raw string 上 trim", () => {
    const originalTrim = String.prototype.trim;
    let maxTrimmedLength = 0;
    const trim = vi.spyOn(String.prototype, "trim").mockImplementation(function (this: string) {
      maxTrimmedLength = Math.max(maxTrimmedLength, this.length);
      return originalTrim.call(this);
    });
    try {
      const title = "x" + " ".repeat(1_000_000);
      const r = buildInteractiveCard({ title, buttons: [button] } as never);
      expect("error" in r && r.error).toContain("must not contain sensitive data");
      expect(maxTrimmedLength, `trim 收到了 ${maxTrimmedLength} 字符的原始值`)
        .toBeLessThanOrEqual(REDUCE_INPUT_MAX);
    } finally {
      trim.mockRestore();
    }
  });
});
