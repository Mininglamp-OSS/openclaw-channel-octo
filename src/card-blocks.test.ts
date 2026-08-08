import { describe, it, expect } from "vitest";
import { buildDisplayCard, validateDisplayBlocks, REDUCE_BUDGET_PER_CARD, type DisplayBlock } from "./card-blocks.js";
import type { CardCaps } from "./card-render.js";

/**
 * 展示卡构建器 —— 方案乙契约测试:DisplayBlock → AC 1.5 JSON,按 caps 协商降级,
 * 每 block 产 plain 兜底,脱敏与 card-render 同套(URL 降级 + secret 命中隐藏)。
 */

/** 便利:advertise 全套元素(RichTextBlock/FactSet/Container 都可用)。 */
const FULL_CAPS: CardCaps = {
  elements: new Set([
    "TextBlock", "RichTextBlock", "FactSet", "Container", "ColumnSet",
    "Image", "Table", "ActionSet",
  ]),
  actions: new Set(["Action.OpenUrl", "Action.ToggleVisibility", "Action.CopyToClipboard"]),
};

const CAPS_WITH_COPY: CardCaps = {
  elements: new Set(["TextBlock", "ActionSet"]),
  actions: new Set(["Action.CopyToClipboard"]),
};

const CAPS_WITH_OPEN_URL: CardCaps = {
  elements: new Set(["TextBlock"]),
  actions: new Set(["Action.OpenUrl"]),
};

/** 便利:仅基线(相当于旧部署不 advertise elements,card-render baseline)。 */
const BASELINE_CAPS: CardCaps | undefined = undefined;

/** 类型窄化:取 body 元素。 */
type Element = Record<string, unknown>;
function body(res: { card: Record<string, unknown> }): Element[] {
  return (res.card.body as Element[]) ?? [];
}

describe("buildDisplayCard 骨架", () => {
  it("最小卡:type=AdaptiveCard + version=1.5 + $schema + body 数组", () => {
    const { card } = buildDisplayCard({ blocks: [] });
    expect(card.type).toBe("AdaptiveCard");
    expect(card.version).toBe("1.5");
    expect(card.$schema).toBe("http://adaptivecards.io/schemas/adaptive-card.json");
    expect(Array.isArray(card.body)).toBe(true);
  });

  it("title 渲染成置顶 Bolder TextBlock,plain 首行是 title", () => {
    const { card, plain } = buildDisplayCard({ title: "审批请求", blocks: [] });
    const els = body({ card });
    expect(els[0]).toEqual({ type: "TextBlock", text: "审批请求", wrap: true, weight: "Bolder" });
    expect(plain.split("\n")[0]).toBe("审批请求");
  });

  it("plain 每个 block 一行,与视觉降级无关", () => {
    const { plain } = buildDisplayCard({
      blocks: [
        { type: "heading", text: "H" },
        { type: "text", text: "L1" },
        { type: "text", text: "L2" },
      ],
    });
    expect(plain.split("\n")).toEqual(["H", "L1", "L2"]);
  });
});

describe("heading / text block", () => {
  it("heading → Bolder TextBlock", () => {
    const { card } = buildDisplayCard({ blocks: [{ type: "heading", text: "标题" }] });
    expect(body({ card })[0]).toEqual({ type: "TextBlock", text: "标题", wrap: true, weight: "Bolder" });
  });

  it("text → 普通 TextBlock(wrap)", () => {
    const { card } = buildDisplayCard({ blocks: [{ type: "text", text: "正文" }] });
    expect(body({ card })[0]).toEqual({ type: "TextBlock", text: "正文", wrap: true });
  });

  it("跨截断点的密钥不出现在渲染结果里", () => {
    // 归约管线对超过 REDUCE_INPUT_MAX(4000 字符)的输入会截断,而 text block **没有渲染上限**
    // —— 与摘要(64)、错误(120)、debug 串(512)不同,长文本会整段渲染。于是横跨截断点的密钥
    // 被切成两半,isSensitive 认不出那个片段,整块照渲。修好之前实测:
    //
    //     "z"×3990 + " AKIAIOSFODNN7EXAMPLE"  →  渲染 4000 字符,尾部是 `AKIAIOSFO`
    //
    // 偏移量是可选的 —— padding 调一下,几乎整个 token 都能渲染出来。
    //
    // **断言的是「密钥不出现」,不是「整块不渲染」。** 这两者不是一回事:安全的截断前缀渲染出来
    // 也满足不变式,而 `toHaveLength(0)` 会把「整块扣下」钉成唯一正确答案 —— 那比不变式严,
    // 会把一处本可以放宽的实现选择锁死。这一组正是 LEAK 语料用非等值断言的同一个理由。
    for (const [pad, secret] of [
      [3990, "AKIAIOSFODNN7EXAMPLE"],
      [3985, "AKIAIOSFODNN7EXAMPLE"],   // 偏移可选:切点后移,露出更多
      [3990, "ghp_ABCDEFGHIJ1234567890XY"],
      [3990, "sk-ABCDEFGHIJKLMNOP1234"],
    ] as [number, string][]) {
      const rendered = buildDisplayCard({ blocks: [{ type: "text", text: `${"z".repeat(pad)} ${secret}` }] });
      const all = JSON.stringify(rendered.card) + rendered.plain;
      // 整个密钥、以及它任何 ≥8 字符的前缀片段,都不许出现 —— 后者是"被切成两半"那一类。
      for (let n = secret.length; n >= 8; n--) {
        expect(all, `pad=${pad} ${secret} 的前 ${n} 字符出现在渲染结果里`).not.toContain(secret.slice(0, n));
      }
    }
    // 反向:归约后本该安全的内容必须照常渲染 —— 下面这条归约后是 `https://slack.com`。
    // 曾经这里有一道查**整串**的预检,它会把这类内容整块丢掉;界改成只查被丢掉的那一段之后,
    // 长文本里带 webhook 的形状也能正常渲染(见 card-render.corpus.ts 的 COST 组)。
    const ok = buildDisplayCard({
      blocks: [{ type: "text", text: "https://hooks.slack.com/services/T00/B00/abcdEFGH1234abcdEFGH1234" }],
    });
    expect((body(ok)[0] as { text: string }).text).toContain("https://slack.com");
    const long = buildDisplayCard({
      blocks: [{ type: "text", text: "https://hooks.slack.com/services/T00/B00/abcdEFGH1234abcdEFGH1234 " + "word ".repeat(900) }],
    });
    expect((body(long)[0] as { text: string }).text, "空白充裕、归约后安全的长文本被整块丢掉")
      .toContain("https://slack.com");
  });

  // 这一条钉住 sanitize 把自己的 generic 传进了界里。删掉那个实参、退回缺省的最严档时,
  // 整个套件依然全绿(子代理评审跑变异发现的),而行为是可观察的:trusted 卡走 generic=false,
  // 尾部的 git SHA 不该被当成密钥 —— 那正是 generic 这个开关存在的理由。
  it("界丢掉的那一段按本卡的 generic 判定,而不是一律用最严的一档", () => {
    const text = "word ".repeat(900) + "2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c";
    const trusted = buildDisplayCard({ trusted: true, blocks: [{ type: "text", text }] });
    expect(body(trusted), "trusted 卡(generic=false)不该因为尾部 git SHA 被打空").toHaveLength(1);
    // 反面:不可信卡是 generic=true,长 hex 归它管,整块扣下。
    const untrusted = buildDisplayCard({ blocks: [{ type: "text", text }] });
    expect(body(untrusted)).toHaveLength(0);
  });

  it("text 内嵌 URL 降级到 scheme://注册域(webhook/隧道/预签名主机都吃)", () => {
    const { card } = buildDisplayCard({
      blocks: [{ type: "text", text: "回调 https://hooks.slack.com/services/T00/B00/xy → 500" }],
    });
    // Slack webhook path 里嵌的密钥被 URL 降级抹掉,只留 slack.com 主机
    expect((body({ card })[0] as { text: string }).text).toContain("https://slack.com");
    expect((body({ card })[0] as { text: string }).text).not.toContain("xy");
    expect((body({ card })[0] as { text: string }).text).not.toContain("services");
  });

  it("text 命中 secret shape → 整个 block 不渲染(fail-closed)", () => {
    const { card, plain } = buildDisplayCard({
      blocks: [
        { type: "text", text: "token=AKIAIOSFODNN7EXAMPLE" }, // AWS key shape
        { type: "text", text: "正常正文" },
      ],
    });
    const texts = body({ card }).map((e) => (e as { text?: string }).text);
    expect(texts).toContain("正常正文");
    expect(texts).not.toContain("token=AKIAIOSFODNN7EXAMPLE");
    // plain 也应隐藏,保持一致
    expect(plain).not.toContain("AKIA");
  });
});

describe("rich block(高价值:一行多样式,顺带解决 ColumnSet plain 分行)", () => {
  it("advertise RichTextBlock → RichTextBlock + inlines(bold/color 逐段)", () => {
    const { card } = buildDisplayCard({
      caps: FULL_CAPS,
      blocks: [{ type: "rich", segments: [
        { text: "📖 " },
        { text: "读取文件", bold: true },
        { text: "：/a.md" },
        { text: " · 30ms", color: "good" },
      ]}],
    });
    const el = body({ card })[0] as { type: string; inlines: Array<Record<string, unknown>> };
    expect(el.type).toBe("RichTextBlock");
    expect(el.inlines).toHaveLength(4);
    expect(el.inlines.every((i) => i.type === "TextRun")).toBe(true); // 前端 validator 不接受 string shorthand
    expect(el.inlines[1]).toEqual({ type: "TextRun", text: "读取文件", weight: "Bolder" });
    expect(el.inlines[3]).toEqual({ type: "TextRun", text: " · 30ms", color: "good" });
  });

  it("rich segment 支持 Monospace 字体,用于工具参数/命令片段", () => {
    const { card } = buildDisplayCard({
      caps: FULL_CAPS,
      blocks: [{ type: "rich", segments: [
        { text: "query_metrics", bold: true },
        { text: " channel=B range=90d", fontType: "Monospace" },
      ] }],
    });
    const el = body({ card })[0] as { inlines: Array<Record<string, unknown>> };
    expect(el.inlines[1]).toMatchObject({ text: " channel=B range=90d", fontType: "Monospace" });
  });

  it("不 advertise RichTextBlock → 段拼成单个 TextBlock(降级,零回归)", () => {
    const { card, plain } = buildDisplayCard({
      caps: { elements: new Set(["TextBlock"]) }, // 只 baseline TextBlock
      blocks: [{ type: "rich", segments: [
        { text: "📖 " },
        { text: "读取文件" },
        { text: "：/a.md · 30ms" },
      ]}],
    });
    const el = body({ card })[0] as { type: string; text: string };
    expect(el.type).toBe("TextBlock");
    expect(el.text).toBe("📖 读取文件：/a.md · 30ms"); // 一行,顺带解决 ColumnSet plain 分行
    expect(plain).toBe("📖 读取文件：/a.md · 30ms");
  });

  it("rich 段命中 secret → 整块隐藏", () => {
    const { card } = buildDisplayCard({
      caps: FULL_CAPS,
      blocks: [{ type: "rich", segments: [
        { text: "Bearer sk-1234567890abcdef" },
      ]}],
    });
    expect(body({ card })).toEqual([]);
  });

  it("F1: rich 段内 URL 也降级 —— card 绝不多于 plain(webhook 密钥不进 TextRun)", () => {
    const { card, plain } = buildDisplayCard({
      caps: FULL_CAPS,
      blocks: [{ type: "rich", segments: [
        { text: "Webhook: " },
        { text: "https://hooks.slack.com/services/T00000000/B11111111/AbCdEfSecretTokenXyz123" }, // gitleaks:allow (fake fixture)
      ]}],
    });
    const cardStr = JSON.stringify(card);
    expect(cardStr).not.toContain("AbCdEfSecretTokenXyz123");
    expect(cardStr).not.toContain("/services/");
    expect(cardStr).toContain("https://slack.com");
    expect(plain).toBe("Webhook: https://slack.com");
    // 含 URL → 降级为单个 TextBlock(不再逐段 TextRun,防跨段拆开的 URL 漏出)
    expect((body({ card })[0] as { type: string }).type).toBe("TextBlock");
  });

  it("前缀式密钥被词字符粘连(含 rich 段空串拼接)也不漏进卡体", () => {
    // 回归 yujiawei P1:renderRich 用空串拼 segments,相邻段会把 `foo` 与 `sk-…` 粘成 `foosk-…`,
    // 抹掉词界 → 若前缀检测带 `\b` 就漏。text 单字段粘连同理。
    const text = buildDisplayCard({ blocks: [{ type: "text", text: "KeyAKIA1234567890ABCDEF" }], caps: FULL_CAPS });
    expect(JSON.stringify(text.card)).not.toContain("AKIA1234567890ABCDEF");
    expect(text.plain).not.toContain("AKIA1234567890ABCDEF");
    const rich = buildDisplayCard({
      caps: FULL_CAPS,
      blocks: [{ type: "rich", segments: [{ text: "foo" }, { text: "sk-liveABCDEFGHIJKLMNOP" }] }],
    });
    expect(JSON.stringify(rich.card)).not.toContain("sk-liveABCDEFGHIJKLMNOP");
    expect(rich.plain).not.toContain("sk-liveABCDEFGHIJKLMNOP");
  });

  it("F1: URL 跨 segment 拆开也不漏(joined 降级 + 降级为 TextBlock)", () => {
    const { card, plain } = buildDisplayCard({
      caps: FULL_CAPS,
      blocks: [{ type: "rich", segments: [
        { text: "https://hooks.slack.com/services/T00" },
        { text: "/B00/SuperSecretTail99" },
      ]}],
    });
    const cardStr = JSON.stringify(card);
    expect(cardStr).not.toContain("SuperSecretTail99");
    expect(plain).toBe("https://slack.com");
  });
});

describe("table block(Table)", () => {
  it("advertise Table → 渲染原生 Table,Row/Cell 作为 Table 内部子结构生成", () => {
    const { card, plain } = buildDisplayCard({
      caps: FULL_CAPS,
      blocks: [{ type: "table", rows: [
        { cells: [{ text: "阶段" }, { text: "状态" }] },
        { cells: [{ text: "联调" }, { text: "完成" }] },
      ]}],
    });
    const el = body({ card })[0] as {
      type: string;
      firstRowAsHeader: boolean;
      columns: Array<{ width: number }>;
      rows: Array<{ type: string; cells: Array<{ type: string; items: Array<{ type: string; text: string }> }> }>;
    };
    expect(el.type).toBe("Table");
    expect(el.firstRowAsHeader).toBe(true);
    expect(el).toMatchObject({ columns: [{ width: 1 }, { width: 1 }] });
    expect(el.rows[0].type).toBe("TableRow");
    expect(el.rows[0].cells[0].type).toBe("TableCell");
    expect(el.rows[0].cells[0].items[0]).toMatchObject({ type: "TextBlock", text: "阶段" });
    expect(plain).toBe("阶段 | 状态\n联调 | 完成");
  });

  it("producer 可控制列宽、表头开关,并在 cell 内放 rich/group 等展示块", () => {
    const { card, plain } = buildDisplayCard({
      caps: FULL_CAPS,
      blocks: [{
        type: "table",
        firstRowAsHeader: false,
        columns: [{ width: 1 }, { width: 2 }],
        rows: [
          { cells: [
            { blocks: [{ type: "rich", segments: [{ text: "模块", bold: true }] }] },
            { text: "内容" },
          ] },
          { cells: [
            { text: "状态" },
            { blocks: [{ type: "group", style: "emphasis", blocks: [{ type: "text", text: "可用" }] }] },
          ] },
        ],
      }],
    });
    const table = body({ card })[0] as {
      firstRowAsHeader: boolean;
      columns: Array<{ width: number }>;
      rows: Array<{ cells: Array<{ items: Array<Record<string, unknown>> }> }>;
    };
    expect(table.firstRowAsHeader).toBe(false);
    expect(table.columns).toEqual([{ width: 1 }, { width: 2 }]);
    expect(table.rows[0].cells[0].items[0]).toMatchObject({
      type: "RichTextBlock",
      inlines: [{ type: "TextRun", text: "模块", weight: "Bolder" }],
    });
    expect(table.rows[1].cells[1].items[0]).toMatchObject({
      type: "Container",
      style: "emphasis",
    });
    expect(plain).toBe("模块 | 内容\n状态 | 可用");
  });

  it("未 advertise Table → 降级为管道分隔文本行", () => {
    const { card, plain } = buildDisplayCard({
      caps: { elements: new Set(["TextBlock"]) },
      blocks: [{ type: "table", rows: [
        { cells: [{ text: "A" }, { text: "B" }] },
      ]}],
    });
    expect((body({ card })[0] as { type: string; text: string }).type).toBe("TextBlock");
    expect((body({ card })[0] as { text: string }).text).toBe("A | B");
    expect(plain).toBe("A | B");
  });

  it("table cell 内容逐格脱敏,敏感 cell 被跳过", () => {
    const { card, plain } = buildDisplayCard({
      caps: FULL_CAPS,
      blocks: [{ type: "table", rows: [
        { cells: [{ text: "safe" }, { text: "AKIAIOSFODNN7EXAMPLE" }] },
      ]}],
    });
    const cardStr = JSON.stringify(card);
    expect(cardStr).toContain("safe");
    expect(cardStr).not.toContain("AKIA");
    expect(plain).toBe("safe");
  });
});

describe("columns block(ColumnSet 摘要区)", () => {
  it("advertise ColumnSet → 三块摘要渲染为 ColumnSet,Column 作为 ColumnSet 内部子结构生成", () => {
    const { card, plain } = buildDisplayCard({
      title: "北京天气",
      caps: FULL_CAPS,
      blocks: [
        { type: "heading", text: "北京天气" }, // 与 title 重复,应去掉
        { type: "columns", columns: [
          { blocks: [{ type: "heading", text: "天气" }, { type: "text", text: "多云转晴" }] },
          { blocks: [{ type: "heading", text: "温度" }, { type: "text", text: "28°C / 19°C" }] },
          { blocks: [{ type: "heading", text: "降水概率" }, { type: "text", text: "20%" }] },
        ]},
        { type: "facts", items: [
          { label: "城市", value: "北京" },
          { label: "日期", value: "2026-07-11" },
        ]},
      ],
    });
    const b = body({ card });
    expect((b[0] as { text: string }).text).toBe("北京天气");
    expect(b.filter((e) => (e as { text?: string }).text === "北京天气")).toHaveLength(1);
    const colSet = b.find((e) => e.type === "ColumnSet") as {
      type: string;
      columns: Array<{ type: string; items: Array<{ text?: string }> }>;
    };
    expect(colSet).toBeTruthy();
    expect(colSet.columns).toHaveLength(3);
    expect(colSet.columns[0].type).toBe("Column");
    expect(colSet.columns[0].items.map((i) => i.text)).toEqual(["天气", "多云转晴"]);
    expect(plain.split("\n")).toEqual([
      "北京天气",
      "天气；多云转晴 | 温度；28°C / 19°C | 降水概率；20%",
      "城市：北京",
      "日期：2026-07-11",
    ]);
  });

  it("未 advertise ColumnSet → 摘要降级为单行 TextBlock", () => {
    const { card, plain } = buildDisplayCard({
      caps: { elements: new Set(["TextBlock"]) },
      blocks: [{ type: "columns", columns: [
        { blocks: [{ type: "text", text: "天气：晴" }] },
        { blocks: [{ type: "text", text: "温度：28°C" }] },
      ]}],
    });
    const el = body({ card })[0] as { type: string; text: string };
    expect(el.type).toBe("TextBlock");
    expect(el.text).toBe("天气：晴 | 温度：28°C");
    expect(plain).toBe("天气：晴 | 温度：28°C");
  });
});

describe("link block(Action.OpenUrl)", () => {
  it("advertise ActionSet+Action.OpenUrl → 用可见 ActionSet 按钮,且不会生成 Submit", () => {
    const { card, plain } = buildDisplayCard({
      caps: FULL_CAPS,
      blocks: [{ type: "link", text: "打开控制台", url: "https://admin.example.com/path?token=abc" }],
    });
    const el = body({ card })[0] as { type: string; actions: Array<Record<string, unknown>> };
    expect(el.type).toBe("ActionSet");
    expect(el.actions[0]).toEqual({
      type: "Action.OpenUrl",
      title: "打开控制台",
      url: "https://example.com",
    });
    expect(JSON.stringify(card)).not.toContain("Action.Submit");
    expect(plain).toBe("打开控制台：https://example.com");
  });

  it("advertise Action.OpenUrl 但缺 ActionSet → 退回 TextBlock.selectAction", () => {
    const { card } = buildDisplayCard({
      caps: CAPS_WITH_OPEN_URL,
      blocks: [{ type: "link", text: "打开控制台", url: "https://admin.example.com/path?token=abc" }],
    });
    const el = body({ card })[0] as { type: string; text: string; selectAction: Record<string, unknown> };
    expect(el.type).toBe("TextBlock");
    expect(el.text).toBe("打开控制台");
    expect(el.selectAction).toMatchObject({ type: "Action.OpenUrl" });
  });

  it("未 advertise Action.OpenUrl → 降级为普通文本", () => {
    const { card } = buildDisplayCard({
      caps: { elements: new Set(["TextBlock"]) },
      blocks: [{ type: "link", text: "Docs", url: "https://docs.example.com/a" }],
    });
    const el = body({ card })[0] as { type: string; text: string; selectAction?: unknown };
    expect(el.type).toBe("TextBlock");
    expect(el.text).toBe("Docs：https://example.com");
    expect(el.selectAction).toBeUndefined();
  });
});

describe("facts block(键值对)", () => {
  it("advertise FactSet → FactSet + facts[]", () => {
    const { card } = buildDisplayCard({
      caps: FULL_CAPS,
      blocks: [{ type: "facts", items: [
        { label: "状态", value: "已完成" },
        { label: "耗时", value: "30ms" },
      ]}],
    });
    const el = body({ card })[0] as { type: string; facts: Array<{ title: string; value: string }> };
    expect(el.type).toBe("FactSet");
    expect(el.facts).toEqual([
      { title: "状态", value: "已完成" },
      { title: "耗时", value: "30ms" },
    ]);
  });

  it("不 advertise FactSet → 降级为多行 TextBlock 「label:value」", () => {
    const { card, plain } = buildDisplayCard({
      caps: { elements: new Set(["TextBlock"]) },
      blocks: [{ type: "facts", items: [
        { label: "状态", value: "已完成" },
        { label: "耗时", value: "30ms" },
      ]}],
    });
    const els = body({ card });
    expect(els).toHaveLength(2);
    expect((els[0] as { text: string }).text).toBe("状态：已完成");
    expect((els[1] as { text: string }).text).toBe("耗时：30ms");
    expect(plain).toBe("状态：已完成\n耗时：30ms");
  });

  it("facts.value 内嵌 URL 降级;命中 secret → 该条隐藏,不影响其它条", () => {
    const { card, plain } = buildDisplayCard({
      caps: FULL_CAPS,
      blocks: [{ type: "facts", items: [
        { label: "webhook", value: "https://hooks.slack.com/services/T/B/xy" },
        { label: "token", value: "AKIAIOSFODNN7EXAMPLE" }, // secret shape
        { label: "状态", value: "ok" },
      ]}],
    });
    const el = body({ card })[0] as { facts: Array<{ title: string; value: string }> };
    // 3 条剩下 2 条:webhook 只留主机;token 整条被抹;状态原样
    expect(el.facts).toHaveLength(2);
    expect(el.facts[0].value).toBe("https://slack.com");
    expect(el.facts[1].title).toBe("状态");
    expect(plain).not.toContain("AKIA");
  });
});

describe("group block(分组着色)", () => {
  it("advertise Container → Container(style)包住子 block", () => {
    const { card } = buildDisplayCard({
      caps: FULL_CAPS,
      blocks: [{ type: "group", style: "good", blocks: [
        { type: "text", text: "成功" },
      ]}],
    });
    const el = body({ card })[0] as { type: string; style: string; items: Element[] };
    expect(el.type).toBe("Container");
    expect(el.style).toBe("good");
    expect(el.items).toHaveLength(1);
    expect((el.items[0] as { text: string }).text).toBe("成功");
  });

  it("baseline(无 caps)含 Container → 走 Container 路径(零回归)", () => {
    const { card } = buildDisplayCard({
      caps: BASELINE_CAPS,
      blocks: [{ type: "group", blocks: [{ type: "text", text: "内" }] }],
    });
    expect((body({ card })[0] as { type: string }).type).toBe("Container");
  });

  it("不 advertise Container → 平铺子 block(降级不丢内容,只丢着色)", () => {
    const { card } = buildDisplayCard({
      caps: { elements: new Set(["TextBlock"]) },
      blocks: [{ type: "group", style: "warning", blocks: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]}],
    });
    const els = body({ card });
    expect(els).toHaveLength(2); // 平铺,无 Container 外壳
    expect((els[0] as { text: string }).text).toBe("a");
    expect((els[1] as { text: string }).text).toBe("b");
  });
});

describe("collapsible block(forward-compat 折叠/展开)", () => {
  /**
   * 升级 = advertise Container + advertise ActionSet + advertise Action.ToggleVisibility。
   * 任一不满足 → 降级为平铺(summary 当 heading,inner 全部展开在下方 —— 零回归)。
   */
  const CAPS_WITH_TOGGLE: CardCaps = {
    elements: new Set(["TextBlock", "RichTextBlock", "Container", "ColumnSet", "ActionSet"]),
    actions: new Set(["Action.ToggleVisibility"]),
  };

  it("advertise ToggleVisibility+ActionSet+Container+ColumnSet → 升级:summary 左侧 + 右侧展开/收起按钮 + 隐藏 Container", () => {
    const { card } = buildDisplayCard({
      caps: CAPS_WITH_TOGGLE,
      blocks: [{ type: "collapsible", summary: "详情", blocks: [
        { type: "text", text: "机密上下文 A" },
        { type: "text", text: "机密上下文 B" },
      ]}],
    });
    const els = body({ card });
    expect(els).toHaveLength(2);
    const header = els[0] as { type: string; columns: Array<{ width: string; items: Array<Record<string, unknown>> }> };
    expect(header.type).toBe("ColumnSet");
    expect(header.columns[0].width).toBe("stretch");
    expect(header.columns[0].items[0]).toMatchObject({ type: "TextBlock", text: "详情" });
    expect(header.columns[1].width).toBe("auto");
    const collapseBtn = header.columns[1].items[0] as { id: string; isVisible: boolean; actions: Array<Record<string, unknown>> };
    const expandBtn = header.columns[1].items[1] as { id: string; isVisible: boolean; actions: Array<Record<string, unknown>> };
    expect(collapseBtn.isVisible).toBe(false);
    expect(expandBtn.isVisible).toBe(true);

    const container = els.find((e) => e.type === "Container") as { id: string; isVisible: boolean; items: Element[] };
    expect(container).toBeTruthy();
    expect(container.isVisible).toBe(false);
    expect(container.id).toMatch(/^octo_disp_clp_\d+$/); // 展示元素 id 统一命名空间,避免与 input/action 撞名
    expect(container.items).toHaveLength(2);

    expect(expandBtn.actions[0]).toMatchObject({
      type: "Action.ToggleVisibility",
      title: "展开",
      targetElements: [
        { elementId: container.id, isVisible: true },
        { elementId: collapseBtn.id, isVisible: true },
        { elementId: expandBtn.id, isVisible: false },
      ],
    });
    expect(collapseBtn.actions[0]).toMatchObject({
      type: "Action.ToggleVisibility",
      title: "收起",
      targetElements: [
        { elementId: container.id, isVisible: false },
        { elementId: collapseBtn.id, isVisible: false },
        { elementId: expandBtn.id, isVisible: true },
      ],
    });
  });

  it("plain 兜底:summary + 详情行(全展开,与折叠无关 —— 服务端 Finalize 权威重算)", () => {
    const { plain } = buildDisplayCard({
      caps: CAPS_WITH_TOGGLE,
      blocks: [{ type: "collapsible", summary: "详情", blocks: [
        { type: "text", text: "行1" },
        { type: "text", text: "行2" },
      ]}],
    });
    expect(plain).toBe("详情\n行1\n行2");
  });

  it("actionLabel 可自定义为展示卡过程入口文案", () => {
    const { card } = buildDisplayCard({
      caps: CAPS_WITH_TOGGLE,
      blocks: [{ type: "collapsible", summary: "✓ 已思考 12 秒 · 6 次工具调用", actionLabel: "查看过程", blocks: [
        { type: "text", text: "先拆分线索" },
      ]}],
    });
    const header = body({ card })[0] as { columns: Array<{ items: Array<{ actions: Array<Record<string, unknown>> }> }> };
    const expandBtn = header.columns[1].items[1];
    expect(expandBtn.actions[0]).toMatchObject({
      type: "Action.ToggleVisibility",
      title: "查看过程",
    });
  });

  it("summary 与 actionLabel 同名时只保留按钮,避免截图里标题/按钮重复", () => {
    const { card, plain } = buildDisplayCard({
      caps: CAPS_WITH_TOGGLE,
      blocks: [{ type: "collapsible", summary: "查看过程", actionLabel: "查看过程", blocks: [
        { type: "text", text: "先定位问题" },
      ]}],
    });
    const els = body({ card });
    expect(els).toHaveLength(2);
    expect(els[0].type).toBe("ColumnSet");
    const header = els[0] as { columns: Array<{ items: Array<Record<string, unknown>> }> };
    expect((header.columns[1].items[1] as { actions: Array<Record<string, unknown>> }).actions[0].title).toBe("展开");
    expect(els[1].type).toBe("Container");
    expect(JSON.stringify(card).match(/查看过程/g)).toHaveLength(1);
    expect(plain).toBe("查看过程\n先定位问题");
  });

  it("未 advertise Action.ToggleVisibility → 降级平铺(summary 当 heading,inner 展开)", () => {
    // Container/ActionSet 有,但缺 actions 白名单 → 保守降级。
    const { card } = buildDisplayCard({
      caps: { elements: new Set(["TextBlock", "Container", "ActionSet"]) }, // 无 actions
      blocks: [{ type: "collapsible", summary: "详情", blocks: [
        { type: "text", text: "行1" },
      ]}],
    });
    const els = body({ card });
    // 无 ActionSet / 无 isVisible:false 的 Container(全展开,heading + text)
    expect(els.some((e) => e.type === "ActionSet")).toBe(false);
    expect(els.some((e) => (e as { isVisible?: boolean }).isVisible === false)).toBe(false);
    // 至少有:summary heading + inner 行
    const texts = els.map((e) => (e as { text?: string }).text).filter(Boolean);
    expect(texts).toEqual(expect.arrayContaining(["详情", "行1"]));
  });

  it("未 advertise ActionSet → 同样降级(缺哪一维都退回展开)", () => {
    const { card } = buildDisplayCard({
      caps: {
        elements: new Set(["TextBlock", "Container"]), // 缺 ActionSet
        actions: new Set(["Action.ToggleVisibility"]),
      },
      blocks: [{ type: "collapsible", summary: "S", blocks: [{ type: "text", text: "inner" }] }],
    });
    const els = body({ card });
    expect(els.some((e) => e.type === "ActionSet")).toBe(false);
  });

  it("summary 命中 secret 整块隐藏(fail-closed);summary 空 → 整块跳过", () => {
    const { card: c1 } = buildDisplayCard({
      caps: CAPS_WITH_TOGGLE,
      blocks: [{ type: "collapsible", summary: "Bearer sk-1234567890abcdef", blocks: [
        { type: "text", text: "inner" },
      ]}],
    });
    expect(body({ card: c1 })).toEqual([]);

    const { card: c2 } = buildDisplayCard({
      caps: CAPS_WITH_TOGGLE,
      blocks: [{ type: "collapsible", summary: "", blocks: [{ type: "text", text: "inner" }] }],
    });
    expect(body({ card: c2 })).toEqual([]);
  });

  it("inner 全部空/被脱敏抹掉 → 整个 collapsible 不渲染(避免产生「点击展开发现空」的死块)", () => {
    const { card } = buildDisplayCard({
      caps: CAPS_WITH_TOGGLE,
      blocks: [{ type: "collapsible", summary: "标题", blocks: [
        { type: "text", text: "" },
        { type: "text", text: "AKIAIOSFODNN7EXAMPLE" }, // secret shape → 隐藏
      ]}],
    });
    expect(body({ card })).toEqual([]);
  });

  it("多个 collapsible 各自 target 独立 id(不串扰)", () => {
    const { card } = buildDisplayCard({
      caps: CAPS_WITH_TOGGLE,
      blocks: [
        { type: "collapsible", summary: "A", blocks: [{ type: "text", text: "a" }] },
        { type: "collapsible", summary: "B", blocks: [{ type: "text", text: "b" }] },
      ],
    });
    const containers = body({ card }).filter((e) => e.type === "Container") as Array<{ id: string }>;
    expect(containers).toHaveLength(2);
    expect(containers[0].id).not.toBe(containers[1].id);
  });
});

describe("copy block(Action.CopyToClipboard 本地动作)", () => {
  it("advertise Action.CopyToClipboard+ActionSet → 渲染复制按钮,不产生顶层 callback action", () => {
    const { card, plain } = buildDisplayCard({
      caps: CAPS_WITH_COPY,
      blocks: [{ type: "copy", label: "复制 SQL", text: "SELECT 1;" }],
    });
    const el = body({ card })[0] as { type: string; actions: Array<Record<string, unknown>> };
    expect(el.type).toBe("ActionSet");
    expect(el.actions[0]).toEqual({
      type: "Action.CopyToClipboard",
      title: "复制 SQL",
      text: "SELECT 1;",
    });
    expect(card).not.toHaveProperty("actions");
    expect(plain).toBe("SELECT 1;");
  });

  it("未 advertise CopyToClipboard 或 ActionSet → 降级为普通文本(不 400,内容不丢)", () => {
    const noAction = buildDisplayCard({
      caps: { elements: new Set(["TextBlock", "ActionSet"]) },
      blocks: [{ type: "copy", label: "复制", text: "abc" }],
    });
    expect((body(noAction)[0] as { type: string; text: string }).type).toBe("TextBlock");
    expect((body(noAction)[0] as { text: string }).text).toBe("abc");

    const noActionSet = buildDisplayCard({
      caps: { elements: new Set(["TextBlock"]), actions: new Set(["Action.CopyToClipboard"]) },
      blocks: [{ type: "copy", label: "复制", text: "abc" }],
    });
    expect((body(noActionSet)[0] as { type: string; text: string }).type).toBe("TextBlock");
    expect((body(noActionSet)[0] as { text: string }).text).toBe("abc");
  });

  it("CopyToClipboard.text 按 UTF-8 4KiB 限制,超限降级为说明而不是发非法 action", () => {
    const ok = buildDisplayCard({
      caps: CAPS_WITH_COPY,
      blocks: [{ type: "copy", text: "中".repeat(1365) }], // 4095 bytes
    });
    expect((body(ok)[0] as { type: string }).type).toBe("ActionSet");

    const tooLong = buildDisplayCard({
      caps: CAPS_WITH_COPY,
      blocks: [{ type: "copy", text: "中".repeat(1366) }], // 4098 bytes
    });
    const el = body(tooLong)[0] as { type: string; text: string };
    expect(el.type).toBe("TextBlock");
    expect(el.text).toContain("4KiB");
    expect(JSON.stringify(tooLong.card)).not.toContain("Action.CopyToClipboard");
  });

  it("超限判定跑在原始 text 上:绝不把截断过的残值塞进复制按钮", () => {
    // 归约管线对超过 REDUCE_INPUT_MAX(4000 字符)的输入会截断 —— 那是它的性能界。若超限判定
    // 跑在 sanitize 的**输出**上,ASCII 下 4000 字符恒 ≤ 4096 字节,4KiB 那条判定就永远不再
    // 触发:20000 字符会安静地变成 4000 字符进复制按钮,而 4050 字符这种**合法在契约内**的
    // 内容同样被截成 4000。两种情况用户粘出来都是残的,却没有任何提示。
    //
    // 复制按钮是读者会直接拿去用的 sink。要么给全文,要么给提示,不给残值。
    // 两条上限的理由不同,提示语也必须不同:4050 个 ASCII 字符**就是 4050 字节**,合法地在
    // 4KiB 契约内 —— 告诉读者"超过 4KiB"是假话,下一个人去查字节数会什么也查不到。
    for (const [label, n, want] of [
      ["超出字符上限", 4050, "字符"],
      ["远超两条上限", 20_000, "字符"],
    ] as [string, number, string][]) {
      const r = buildDisplayCard({ caps: CAPS_WITH_COPY, blocks: [{ type: "copy", text: "x".repeat(n) }] });
      const el = body(r)[0] as { type: string; text: string };
      expect(el.type, label).toBe("TextBlock");
      expect(el.text, label).toContain(want);
      expect(JSON.stringify(r.card), label).not.toContain("Action.CopyToClipboard");
    }
    // 字节超限但字符数在界内(CJK)仍报 4KiB。
    const cjk = buildDisplayCard({ caps: CAPS_WITH_COPY, blocks: [{ type: "copy", text: "中".repeat(1366) }] });
    expect((body(cjk)[0] as { text: string }).text).toContain("4KiB");
    // 不支持复制按钮的客户端走普通 TextBlock —— 那条路径没有复制按钮,不该收到"未渲染复制按钮"。
    // **两条上限都要覆盖到**:上一版这里只测了 1366 个 CJK 字符,那走的是**字节**路径,于是新加的
    // 字符判定放错了位置(在能力回退之前)也照样绿。断言与它要守的路径必须对得上。
    for (const [label, text] of [
      ["字节路径", "中".repeat(1366)],
      ["字符路径", "y".repeat(4100)],
    ] as [string, string][]) {
      const noCopy = buildDisplayCard({ blocks: [{ type: "copy", text }] });
      const el = body(noCopy)[0] as { type: string; text: string };
      expect(el.type, label).toBe("TextBlock");
      expect(el.text, label).not.toContain("未渲染复制按钮");
    }
    // 界内的照常给出完整内容,一个字符都不少。
    const ok = buildDisplayCard({ caps: CAPS_WITH_COPY, blocks: [{ type: "copy", text: "x".repeat(3000) }] });
    expect((body(ok)[0] as { type: string }).type).toBe("ActionSet");
    expect(JSON.stringify(ok.card)).toContain("x".repeat(3000));
  });

  it("copy text / label 仍走脱敏;label 命中敏感时退回默认标题", () => {
    const hidden = buildDisplayCard({
      caps: CAPS_WITH_COPY,
      blocks: [{ type: "copy", label: "复制", text: "AKIAIOSFODNN7EXAMPLE" }],
    });
    expect(body(hidden)).toEqual([]);

    const defaultLabel = buildDisplayCard({
      caps: CAPS_WITH_COPY,
      blocks: [{ type: "copy", label: "token=AKIAIOSFODNN7EXAMPLE", text: "safe" }],
    });
    const action = (body(defaultLabel)[0] as { actions: Array<Record<string, unknown>> }).actions[0];
    expect(action.title).toBe("复制");
  });
});

describe("组合与边界", () => {
  function countNodes(value: unknown, root = true): number {
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + countNodes(item, false), 0);
    if (!value || typeof value !== "object") return 0;
    return (root ? 0 : 1) + Object.values(value as Record<string, unknown>)
      .reduce<number>((sum, item) => sum + countNodes(item, false), 0);
  }

  function maxDepth(value: unknown, depth = 0, root = true): number {
    if (Array.isArray(value)) return value.reduce((max, item) => Math.max(max, maxDepth(item, depth, root)), depth);
    if (!value || typeof value !== "object") return depth;
    const currentDepth = root ? depth : depth + 1;
    return Object.values(value as Record<string, unknown>)
      .reduce<number>((max, item) => Math.max(max, maxDepth(item, currentDepth, false)), currentDepth);
  }

  function envelopeBytes(card: Record<string, unknown>, plain: string): number {
    return new TextEncoder().encode(JSON.stringify({
      type: 17,
      profile: "octo/v1",
      card_version: "1.5",
      card,
      plain,
    })).byteLength;
  }

  it("多种 block 依序 + title,plain 逐行", () => {
    const blocks: DisplayBlock[] = [
      { type: "heading", text: "报告" },
      { type: "facts", items: [{ label: "总数", value: "3" }] },
      { type: "text", text: "尾注" },
    ];
    const { plain } = buildDisplayCard({ title: "T", blocks, caps: FULL_CAPS });
    expect(plain).toBe("T\n报告\n总数：3\n尾注");
  });

  it("空 blocks + 空 title → 空 body,plain 为空串", () => {
    const { card, plain } = buildDisplayCard({ blocks: [] });
    expect(body({ card })).toEqual([]);
    expect(plain).toBe("");
  });

  it("空白 text 自动跳过(不产元素也不产 plain 行)", () => {
    const { card, plain } = buildDisplayCard({
      blocks: [
        { type: "text", text: "" },
        { type: "text", text: "   " },
        { type: "text", text: "有内容" },
      ],
    });
    expect(body({ card })).toHaveLength(1);
    expect(plain).toBe("有内容");
  });

  it("F3: 超 max_nodes → 截断 body 并附省略提示(不产出会被服务端 400 的结构)", () => {
    const many: DisplayBlock[] = Array.from({ length: 10 }, (_, i) => ({ type: "text", text: `行${i}` }));
    const { card, plain } = buildDisplayCard({ blocks: many, caps: { elements: new Set(["TextBlock"]), maxNodes: 3 } });
    const b = body({ card }) as Array<{ type: string; text: string }>;
    expect(b).toHaveLength(3);
    expect(b[2].text).toContain("省略");
    // plain 与 card 同步:被卡片丢弃的项(行2..行9)不得出现在 plain 里(P2-1)
    expect(plain.split("\n")).toHaveLength(3);
    expect(plain).not.toContain("行2");
    expect(plain).not.toContain("行9");
    expect(plain).toContain("行0");
  });

  it("max_nodes 递归统计嵌套 Table/Column/Cell/inline,最终输出不超预算", () => {
    const caps = {
      ...FULL_CAPS,
      maxNodes: 8,
    };
    const { card } = buildDisplayCard({
      blocks: [{
        type: "table",
        rows: Array.from({ length: 4 }, (_, row) => ({
          cells: Array.from({ length: 3 }, (_, col) => ({
            blocks: [{ type: "rich", segments: [{ text: `${row}-${col}`, bold: true }, { text: "value" }] }],
          })),
        })),
      }],
      caps,
    });
    expect(countNodes(card)).toBeLessThanOrEqual(caps.maxNodes);
  });

  it("max_depth 对渲染后的 Adaptive Card 树生效,不是只限制输入 block 深度", () => {
    const caps = {
      ...FULL_CAPS,
      maxDepth: 2,
    } as CardCaps & { maxDepth: number };
    const { card } = buildDisplayCard({
      blocks: [{
        type: "group",
        blocks: [{ type: "group", blocks: [{ type: "text", text: "deep" }] }],
      }],
      caps,
    });
    expect(maxDepth(card)).toBeLessThanOrEqual(caps.maxDepth);
  });

  it("max_payload_bytes 按完整 type-17 信封的 UTF-8 字节裁剪", () => {
    const caps = {
      elements: new Set(["TextBlock"]),
      maxPayloadBytes: 360,
    } as CardCaps & { maxPayloadBytes: number };
    const { card, plain } = buildDisplayCard({
      title: "UTF-8",
      blocks: [{ type: "text", text: "汉字🙂".repeat(300) }],
      caps,
    });
    expect(envelopeBytes(card, plain)).toBeLessThanOrEqual(caps.maxPayloadBytes);
    expect((card.body as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("validateDisplayBlocks 结构上限(不可信输入)", () => {
  it("无效 heading.size 仅丢弃可选属性,保留有效 heading", () => {
    const out = validateDisplayBlocks([{ type: "heading", text: "保留标题", size: "huge" }]);
    expect(out).toEqual([{ type: "heading", text: "保留标题" }]);
    expect(buildDisplayCard({ blocks: out }).plain).toBe("保留标题");
  });

  it("无效 group.style 仅丢弃可选属性,保留 group 与有效子块", () => {
    const out = validateDisplayBlocks([{
      type: "group",
      style: "invalid",
      blocks: [{ type: "text", text: "保留子块" }],
    }]);
    expect(out).toEqual([{
      type: "group",
      blocks: [{ type: "text", text: "保留子块" }],
    }]);
    expect(buildDisplayCard({ blocks: out }).plain).toBe("保留子块");
  });

  it("F6: 超深嵌套不 RangeError(深度耗尽 → 该层丢弃)", () => {
    let deep: unknown = { type: "text", text: "leaf" };
    for (let i = 0; i < 5000; i++) deep = { type: "group", blocks: [deep] };
    expect(() => validateDisplayBlocks([deep])).not.toThrow();
  });

  it("F6: 超大数组按总数上限截断", () => {
    const huge = Array.from({ length: 100000 }, (_, i) => ({ type: "text", text: `t${i}` }));
    const out = validateDisplayBlocks(huge);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it("合法浅结构照常通过", () => {
    const out = validateDisplayBlocks([
      { type: "heading", text: "H" },
      { type: "table", columns: [{ width: 1 }, { width: 2 }], rows: [{ cells: [{ text: "a" }, { blocks: [{ type: "rich", segments: [{ text: "b", bold: true, fontType: "Monospace" }] }] }] }] },
      { type: "columns", columns: [{ blocks: [{ type: "text", text: "c" }] }] },
      { type: "link", text: "Docs", url: "https://example.com/a" },
      { type: "group", blocks: [{ type: "text", text: "x" }] },
      { type: "collapsible", summary: "过程", actionLabel: "查看过程", blocks: [{ type: "text", text: "p" }] },
      { type: "copy", label: "复制", text: "y" },
    ]);
    expect(out).toHaveLength(7);
    expect(out[1]).toMatchObject({ type: "table", columns: [{ width: 1 }, { width: 2 }] });
    expect(JSON.stringify(out[1])).toContain("Monospace");
    expect(out[5]).toMatchObject({ type: "collapsible", actionLabel: "查看过程" });
  });

  it("facts.items 计入总节点预算 —— facts-heavy 卡被截断(防服务端 node 上限 400)", () => {
    const bigFacts = { type: "facts", items: Array.from({ length: 1000 }, (_, i) => ({ label: `k${i}`, value: `v${i}` })) };
    const out = validateDisplayBlocks([bigFacts]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("facts");
    const items = (out[0] as { items: unknown[] }).items;
    expect(items.length).toBeLessThanOrEqual(200); // 受 MAX_TOTAL_BLOCKS 约束
  });
});

describe("单卡片归约预算", () => {
  const mk = (n: number, text: string) => Array.from({ length: n }, () => ({ type: "text" as const, text }));
  // 归约管线在这种形状上最贵(实测 200 块 1084 ms,普通散文同样体积只要 47 ms)。
  // REDUCE_INPUT_MAX 管单次、RAW_INPUT_MAX 管折叠、MAX_TOTAL_BLOCKS 管块数,都不管累计代价。
  const COLON_DENSE = "a:".repeat(1999) + " x";   // 4000 字符,刚好占满一次调用的额度

  // 断言的是**元素个数**,不是耗时。上一版写的是「200 块耗时不超过 50 块的 1.5 倍」,那种断言
  // 在共享 CI 上会被一次 GC 掀翻,而它想守的性质本来就是可直接观察的:通过预算的块数与提交
  // 多少块无关。
  it("超预算的块不渲染,通过的块数与提交多少块无关", () => {
    const at50 = body(buildDisplayCard({ blocks: mk(50, COLON_DENSE) })).length;
    const at200 = body(buildDisplayCard({ blocks: mk(200, COLON_DENSE) })).length;
    expect(at50).toBe(at200);                       // 都是 30 块 + 1 条提示
    expect(at200).toBe(120_000 / 4000 + 1);
  });

  it("超预算时说明原因,而不是让内容静默消失", () => {
    const { card } = buildDisplayCard({ blocks: mk(200, COLON_DENSE) });
    const texts = body({ card }).map((e) => (e as { text?: string }).text ?? "");
    expect(texts.some((s) => s.includes("超出本卡片的脱敏预算"))).toBe(true);
  });

  it("提示走 marker 钩子,整卡英文化的调用方不会被塞进一句中文", () => {
    const { card, plain } = buildDisplayCard({
      blocks: mk(200, COLON_DENSE),
      budgetMarker: () => ({ text: "EN budget notice", plain: "EN budget plain" }),
    });
    const texts = body({ card }).map((e) => (e as { text?: string }).text ?? "");
    expect(texts).toContain("EN budget notice");
    expect(texts.some((s) => s.includes("脱敏预算"))).toBe(false);
    expect(plain).toContain("EN budget plain");
  });

  it("真实体量的卡片一个元素都不少", () => {
    // 这几种是预算**不该**碰到的。给足余量:20 × 4000 = 80000,离 120000 还有三分之一,
    // 不是靠掐着上限刚好通过(上一版 30 × 3999 = 119970,任何一处多花 30 字符就翻车)。
    for (const [label, n, text] of [
      ["200 块 × 200 字符英文", 200, "word ".repeat(40)],
      ["200 块 × 200 字符中文", 200, "这是一段普通的中文说明文字。".repeat(14)],
      ["20 块 × 4000 字符英文", 20, "word ".repeat(800)],
      ["20 块 × 4000 字符中文", 20, "这是一段普通的中文说明文字。".repeat(285)],
    ] as [string, number, string][]) {
      // **个数之外还要断言没有提示。** 元素个数分不清「一个都没少」和「少了一个、提示正好补上
      // 元素位」—— 实测 n=31 时 elements=31 而内容块只有 30,`toHaveLength(31)` 照样绿。
      // 这个坑在隔壁那条测试里已经写下来并修过一次,而这两条就在它旁边、当时没跟着改。
      const card = buildDisplayCard({ blocks: mk(n, text) });
      expect(body(card), `${label} 被预算误伤`).toHaveLength(n);
      expect(JSON.stringify(card), `${label} 有块被预算打掉,提示补上了元素位`).not.toContain("脱敏预算");
    }
  });

  it("线性档命中让整块扣下时,也要计价 —— 否则预算整条不生效", () => {
    // 评审第十轮 Q4:`collapseForReduction` 因**线性档**命中而返回 "" 时,`bounded` 一次没被
    // 调用,而 `cost` 那行在早退之前 —— 这一块扫了 64 KiB 切割加一整条尾巴,却一分不付。
    // 200 块下来 `exhausted` 始终不翻转、提示不出现,实测 base 525 ms / 修前 830 ms,
    // 而这条 PR 加预算管的就是这根轴。
    //
    // **断言提示出现,不断言耗时。** 计时断言在 CI 上会抖,而且「慢」是症状、「没计价」才是缺陷;
    // 提示出不出现是那个缺陷的直接观测。反向验证过:把 linear 换回 `plain.linear`,这条变红。
    const text = "h ".repeat(32_768) + "x".repeat(120_000) + " token";
    const { card } = buildDisplayCard({ blocks: mk(200, text) });
    expect(JSON.stringify(card), "线性档扫了 200 块却一分没付,预算没耗尽").toContain("脱敏预算");
  });

  it("超长块按管线真正处理的量计费,不按原长", () => {
    // **断言内容,不断言元素个数**:块被打掉时,超预算提示正好补上元素位,个数仍是 1 —— 第一版
    // 就是这么绿错的。
    const { card } = buildDisplayCard({ blocks: [{ type: "text", text: "word ".repeat(200_000) }] });
    const first = body({ card })[0] as { text?: string } | undefined;
    expect(first?.text, "超长块被预算打掉了").toMatch(/^word word/);
    expect(first?.text).not.toContain("脱敏预算");

    // 单块看不出差别 —— RAW_INPUT_MAX 已经把折叠后长度压到 ≤64 KiB,按原长计费也进得来。
    // 差别在**多块**:按原长计,两块 64 KiB 就超 120000,只进得去 1 块。
    //
    // 一块 100 KB 现在收三笔,每笔约 4000,因为它确实被扫了三次 ≤4000 的量:折叠那一步的尾部
    // 扫描、归约本身、归约那一步的尾部扫描(窗口末端要对齐空白,所以每笔略多于 4000)。
    // 120000 / ~12005 → **9 块**。上一版能进 20 块,是因为两次尾部扫描一分钱没收 ——
    // 而那正是 200 块 14.8 秒(main 14.6 秒,两边持平)那个洞的来源。
    const big = "word ".repeat(20_000);              // 100 KB → 折叠后被 RAW_INPUT_MAX 截到 64 KiB
    const fit = buildDisplayCard({ blocks: mk(9, big) });
    expect(body(fit), "多个大块被按原长收费饿死了").toHaveLength(9);
    expect(JSON.stringify(fit), "9 块就该刚好装下").not.toContain("脱敏预算");
    // 按原长计费的话两块就超预算,只进得去 1 块 —— 这才是这条测试要挡的那个改法。
    expect(2 * big.length, "按原长计,两块就该超预算").toBeGreaterThan(REDUCE_BUDGET_PER_CARD);
    // **两侧都要钉。** 上面那条只挡"多收",少收一分钱它照样绿(反向验证时把尾部扫描的计价
    // 改成扣 0,它没红)。第 10 块必须超出去 —— 这一条挡的是"少收"。
    expect(JSON.stringify(buildDisplayCard({ blocks: mk(10, big) })), "第 10 块也装下了,尾部扫描的账没收")
      .toContain("脱敏预算");
  });

  // renderRich 曾在 sanitize 之外又跑一遍整条管线,于是 rich 的实际代价是 text 的两倍
  // (200 块 612 ms vs 305 ms),而预算只扣一次 —— 进度卡的明细体整个由 rich 块构成,那条路上
  // 的天花板因此是文档写的两倍。改成拿 `clean` 与折叠后的输入比,省掉那一趟。
  //
  // **这一条钉不住那个成本。** 少跑一趟管线只改耗时,不改任何可观察的输出,而计时比值断言在
  // 共享 CI 上会被一次 GC 掀翻。所以这里钉的是**重构没有改变行为**(那才是重构的风险),
  // 耗时那一头交给下面那条百毫秒量级的兜底。
  it("rich 块与 text 块渲染结果一致(重构未改变行为)", () => {
    const rich = Array.from({ length: 200 }, () => ({ type: "rich" as const, segments: [{ text: COLON_DENSE }] }));
    expect(body(buildDisplayCard({ caps: FULL_CAPS, blocks: rich })))
      .toHaveLength(body(buildDisplayCard({ caps: FULL_CAPS, blocks: mk(200, COLON_DENSE) })).length);
    // 多空格的富文本不该因为改了判据而白白降级成单个 TextBlock。
    const spaced = buildDisplayCard({ caps: FULL_CAPS, blocks: [{ type: "rich", segments: [{ text: "a  b" }, { text: " c" }] }] });
    expect((body(spaced)[0] as { type: string }).type).toBe("RichTextBlock");
  });

  it("collapsible 的 summarySegments 不被重复计费", () => {
    // 上一版 rawSummary 先 sanitize 一次,renderRich 里又一次 —— 同一段文本收两次费。
    //
    // 规模是算出来的,不是随手取的:每块正常花 摘要 3995 + 正文 3995 ≈ 7990,双重计费则
    // ≈ 11985。取 12 块 —— 正常 95 880 装得下,双重计费 143 820 装不下。断言的是**有无
    // summarySegments 的结果一致**,而不是某个绝对数,这样它守的就是"多收了一次费"本身。
    const chunk = "word ".repeat(799).trim();  // ~3995 字符
    const make = (withSegments: boolean) => Array.from({ length: 12 }, () => ({
      type: "collapsible" as const,
      summary: chunk,
      ...(withSegments ? { summarySegments: [{ text: chunk }] } : {}),
      blocks: [{ type: "text" as const, text: chunk }],
    }));
    const plain = buildDisplayCard({ caps: FULL_CAPS, blocks: make(false) });
    const rich = buildDisplayCard({ caps: FULL_CAPS, blocks: make(true) });
    expect(body(rich).length, "带 summarySegments 时预算被多收了一次")
      .toBe(body(plain).length);
    expect(JSON.stringify(rich.card)).not.toContain("脱敏预算");
  });

  // 计时只留一条,它守的是"分钟级回归"这一档,不参与毫秒级的判断。
  //
  // **上一版这条测的是空气。** 用的形状是 `"x " + "eyJ".repeat(40_000)` —— 唯一的空白在下标 1,
  // 于是 RAW_INPUT_MAX 的切口把每个 120 KB 的块折成**单个字符 `"x"`**,200 块实测 68 ms,而
  // 断言写的是 5000 ms。当初钉住这个修复的形状,在修复落地之后自己失去了被测对象:它测的不再是
  // "最坏形状有多贵",而是"短路生效了没有"。这正是 PERF_CORPUS 里 `reachesPasses` 那条断言
  // 要防的漂移,而这条卡片级的测试当时没跟着一起加。
  //
  // 换成真的会跑完整条管线的形状,并且**先断言它确实跑了** —— 形状一旦再退化成短路,
  // 下面两条内容断言先红,而不是计时安静地变成 0 ms。
  it("最坏形状:预算把它压住,而且形状确实跑完了管线", () => {
    // 每块 3905 字符(≤4000,界不截断),主体是一个 3900 字符的纯字母长词:第 1 趟的
    // `[a-z][a-z0-9+.-]*://` 在没有 `://` 的长串上是二次的,单次实测 ~29 ms。不带 `mk` 的
    // `b${i} ` 前缀 —— 带上就 4005 > 4000,界会把 kept 砍成两个字符,又变成测空气。
    const blocks = Array.from({ length: 200 }, (_, i) => ({
      type: "text" as const,
      text: "ghijklmnopqrstuvwxyz".repeat(195).slice(0, 3900) + ` blk${i}`,
    }));
    const { card } = buildDisplayCard({ blocks });
    const rendered = body({ card });
    // 30 个内容块(120000 / 4000)+ 1 条超预算提示。数字对上,才说明每块真按 4000 计了费。
    expect(rendered, "形状退化了:没有按每块 4000 字符计费").toHaveLength(31);
    expect((rendered[0] as { text: string }).text.length, "首块被截短了,管线没有跑在 3900 字符上")
      .toBe(3905);

    buildDisplayCard({ blocks });
    const t0 = performance.now();
    buildDisplayCard({ blocks });
    const ms = performance.now() - t0;
    // 实测(独立进程,5 次):main 5383–7114 ms,本分支 819–856 ms。预算管的是**字符不是时间**
    // —— 30 次 × ~29 ms,所以天花板是 0.9 秒而不是"百毫秒",这个数字写在 README 里。
    // 阈值取 3500:同一进程里跑在别的用例后面时,GC 争用实测能把它推到 2046 ms,2500 太贴脸;
    // 而 main 的下限是 5383,3500 仍然稳稳卡在两者中间 —— 预算失效会红,CI 抖动不会。
    expect(ms, `200 块 × 3905 字符最坏形状耗时 ${ms.toFixed(0)} ms`).toBeLessThan(3500);
  });
});

describe("展开按钮标签与摘要去重", () => {
  it("actionLabel 与摘要相同就不重复显示,不同才采纳", () => {
    const at = (summary: string, actionLabel: string) => {
      const { card } = buildDisplayCard({
        caps: FULL_CAPS,
        blocks: [{ type: "collapsible", summary, actionLabel, blocks: [{ type: "text", text: "x" }] }],
      });
      return JSON.stringify(card);
    };
    expect(at("Build failed", "Build failed"), "标签与摘要相同,不该再显示一遍").toContain("展开");
    expect(at("Build failed", "查看详情")).toContain("查看详情");
    // 比的是**原文**摘要:空白差异会让两者判不相等,于是采纳 actionLabel。记录这个行为,
    // 它是摘要重排那次改动带进来的,之前既没断言也没写进说明。
    expect(at("Build  failed", "Build failed"), "空白差异让去重判不相等 —— 已知行为")
      .toContain("Build failed");
  });
});

describe("预算耗尽之后不再做工", () => {
  it("空白密集 + 无点 base64 尾巴:计价按扫描量,整卡有界", () => {
    // 评审复现的形状。折叠后每块只剩 `b0 x`,按折叠后长度计费就是 4 块钱,200 块也耗不尽预算 ——
    // 可每块仍把 7800 字符的无点 base64 喂进二次方的 JWT 正则。实测 main 14609 ms / 修复前
    // 14793 ms(**两边持平**,预算对它完全没生效),按扫描量计价之后 372 ms。
    // 阈值 3000:远低于失效时的量级,又给足 CI 抖动。
    const blocks = Array.from({ length: 200 }, (_, i) => ({
      type: "text" as const,
      text: `b${i} x` + " ".repeat(65_535) + "eyJ".repeat(2600) + " tailend zzz",
    }));
    buildDisplayCard({ blocks });
    const t0 = performance.now();
    const { card } = buildDisplayCard({ blocks });
    const ms = performance.now() - t0;
    // 前提:预算必须真的触发,否则这条测的只是"这台机器快"。
    expect(JSON.stringify({ card }), "预算没触发,这个形状又白嫖了").toContain("脱敏预算");
    expect(body({ card }).length, "200 块全渲染出来了,预算没起作用").toBeLessThan(40);
    expect(ms, `200 块 × 空白密集+无点 base64 耗时 ${ms.toFixed(0)} ms`).toBeLessThan(3000);
  });


  it("代价不随块数增长 —— 耗尽之后每块仍要折叠一次是白付的", () => {
    // 计费跑在折叠**之后**,所以耗尽之后不早退的话,每个块还要付一次最多 64 KiB 的折叠。
    // 用**比值**而不是绝对毫秒:机器快慢不影响它,而缺陷的信号非常清楚 ——
    // 实测有早退 66/70/67/64 ms(30/60/120/200 块,元素数从第 30 块起就钉死),
    // 无早退 69/119/230/369 ms。比值 1.0 对 5.3。
    const at = (n: number) => {
      const blocks = Array.from({ length: n }, (_, i) => ({
        type: "text" as const,
        text: `b${i} ` + "word ".repeat(24_000),      // 单块 120 KB
      }));
      buildDisplayCard({ blocks });
      const t0 = performance.now();
      const { card } = buildDisplayCard({ blocks });
      return { ms: performance.now() - t0, elements: body({ card }).length };
    };
    // 两个规模都必须**已经耗尽**才可比:30 块正好花完 120 000,还没有超预算提示,元素数是 30
    // 而不是 31 —— 拿它当基准会在前提断言上先红,红的还是个假信号。从 40 块起才进耗尽路径。
    const small = at(40);
    const large = at(200);
    // 前提:两者渲染出的元素数一样,也就是多出来的 160 块确实一个都没渲染。
    expect(large.elements, "多出来的块渲染了,这一条测的不是耗尽路径").toBe(small.elements);
    expect(large.ms / small.ms, `40 块 ${small.ms.toFixed(0)} ms → 200 块 ${large.ms.toFixed(0)} ms`)
      .toBeLessThan(2.5);
  });
});

describe("64 KiB 折叠上限本身不能变成泄漏面", () => {
  // 这三条都是推送前的对抗评审找出来的,而且**都出自新加的那个上限**:一个为了性能加的截断,
  // 如果不带上模块原有的规则,就会自己变成泄漏路径。
  const SECRETS = [
    "AKIAIOSFODNN7EXAMPLE",
    "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij",
  ];

  it("展示卡这条路也要把谓词传进折叠 —— 不传就把压住凭据的关键词丢了", () => {
    // 同一个缺陷在 card-render 那边有一条断言,但那条走的是 sanitizeErrorText。**这条路是
    // sanitize**,它自己单独调一次 collapseForReduction,漏传谓词不会让那条断言变红 ——
    // 反向验证时正是这里没红,才发现展示卡这条路没有覆盖。
    const leaky = `user:hunter2@localhost ${("x" + " ".repeat(23)).repeat(3000)} y token`;
    const { card, plain } = buildDisplayCard({ blocks: [{ type: "text", text: leaky }] });
    expect(JSON.stringify(card), "64 KiB 之外的 token 没参与判定,口令渲染出来了")
      .not.toContain("hunter2");
    expect(plain).not.toContain("hunter2");
  });

  it("rich 段:64 KiB 之后的原文不许绕过清洗进 TextRun", () => {
    // RichTextBlock 分支写出的是**每段原文**,不是清洗结果。所以样式判据一旦建立在 joined 的
    // 有损视图上(比如折叠+截断之后的样子),超出那个视图的段就直接进卡片了。
    // 触发条件不是"必须是空白块":前 64 KiB 折叠比超过约 20 就够,一张 80 列对齐、单元格大多
    // 为空的报表就是这个比例。
    for (const secret of SECRETS) {
      const { card, plain } = buildDisplayCard({
        caps: FULL_CAPS,
        blocks: [{ type: "rich", segments: [
          { text: "Deployment summary\n" + " ".repeat(64 * 1024) },
          { text: `AWS key ${secret} for the runner`, bold: true },
        ] }],
      });
      // 断言看**整张卡的 JSON**,不只是 text 字段 —— TextRun 的文本不在顶层 text 上。
      const all = JSON.stringify(card) + plain;
      for (let n = secret.length; n >= 8; n--) {
        expect(all, `rich 段渲染出了 ${secret.slice(0, n)}`).not.toContain(secret.slice(0, n));
      }
    }
  });

  it("折叠的切口也只能落在空白上,否则归约的锚点被切掉", () => {
    // boundedForReduction 早就立了这条规则(归约靠 `@host` 定位,盲切会把锚点切掉,于是口令
    // 原样留下)。第一版把 64 KiB 的截断写成了裸 slice,同一个缺陷在新函数里复活:
    //     " "×(64Ki-23) + "alice:Tr0ub4dor3xK9pWqZ@db.example.com/deploy"
    //       main  "https://example.com"      裸切  "alice:Tr0ub4dor3xK9pWqZ"
    for (const keep of [21, 23, 30]) {
      const payload = "alice:Tr0ub4dor3xK9pWqZ@db.example.com/deploy";
      const { card, plain } = buildDisplayCard({
        blocks: [{ type: "text", text: " ".repeat(64 * 1024 - keep) + payload }],
      });
      const all = JSON.stringify(card) + plain;
      expect(all, `keep=${keep} 渲染出了用户名`).not.toContain("alice:");
      expect(all, `keep=${keep} 渲染出了口令前缀`).not.toContain("Tr0ub4dor3xK9pW");
    }
  });

  it("collapsible 的摘要必须留在 plain 里", () => {
    // plain 是每张卡都附带的兜底正文,而摘要正是折叠态唯一可见的那一行。第一版把 cleanSummary
    // 置空去掉重复计费,却忘了 plain 还在拼它 —— 摘要变成空行,而当时的测试只数元素个数。
    const { plain } = buildDisplayCard({
      caps: FULL_CAPS,
      blocks: [{
        type: "collapsible",
        summary: "Build failed on step 3",
        summarySegments: [{ text: "Build failed on step 3", bold: true }],
        blocks: [{ type: "text", text: "exit code 1" }],
      }],
    });
    expect(plain).toBe("Build failed on step 3\nexit code 1");
    expect(plain.startsWith("\n"), "摘要在 plain 里变成了空行").toBe(false);
  });
});

describe("copy block 的字符判定跑在原始长度上", () => {
  // 这一组记录的是一次**改对了理由、改错了做法**的回退。曾经把判据换成折叠后长度,理由是
  // 「4001 个空格折叠后什么都不剩,却拿到一句『超过 4000 字符』」—— 理由成立,但那个改法同时
  // 打开了一条泄漏路径和一笔 670× 的代价(见 renderCopy 里的说明)。回退了,下面两条钉住回退。
  it("超长内容一律给提示,绝不把残值塞进复制按钮", () => {
    // 这一条是回退的**理由本身**:折叠会在 RAW_INPUT_MAX 处截断,判折叠后长度时这个输入
    // 折出 11 个字符、闸门放行,复制按钮拿到 `HEAD-MARKER` 而 `TAIL-MARKER` 无声消失。
    const { card } = buildDisplayCard({
      blocks: [{ type: "copy", text: "HEAD-MARKER" + "\n".repeat(70_000) + "TAIL-MARKER" }],
    });
    const json = JSON.stringify(card);
    expect(json, "残值被塞进了复制按钮").not.toContain("HEAD-MARKER");
    expect((body({ card })[0] as { text: string }).text).toContain("超过 4000 字符");
  });
  it("判定是 O(1),不按块长扫描", () => {
    // 折叠后长度那一版在这里是每块一次最多 64 KiB 的正则扫描,而且 renderCopy 在 sanitize
    // **之前**返回,这笔钱 REDUCE_BUDGET_PER_CARD 一分收不到:实测 0.40 ms → 269 ms。
    // 余量给到 40 倍 —— 它守的是"判据又长回原长之外"这一档,不参与毫秒级判断。
    const copy = Array.from({ length: 200 }, (_, i) => ({
      type: "copy" as const,
      text: `blk${i} ` + "connection refused after retries word ".repeat(3322), // 单块 ~123 KB
    }));
    buildDisplayCard({ blocks: copy });
    const t0 = performance.now();
    buildDisplayCard({ blocks: copy });
    const ms = performance.now() - t0;
    expect(ms, `200 个超长 copy 块耗时 ${ms.toFixed(1)} ms`).toBeLessThan(20);
  });
  it("真的超长仍然拒绝", () => {
    const { card } = buildDisplayCard({ blocks: [{ type: "copy", text: "y".repeat(4001) }] });
    expect((body({ card })[0] as { text: string }).text).toContain("超过 4000 字符");
  });
});
