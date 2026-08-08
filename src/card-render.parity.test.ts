import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as head from "./card-render.js";
import * as headEcho from "./card-action-status.js";
import * as base from "./__tests__/fixtures/card-render.def63bb.js";
import * as baseEcho from "./__tests__/fixtures/card-action-status.def63bb.js";
import {
  generateParitySpace,
  runSink,
  fabricatedHosts,
  PARITY_SINKS,
  type Dims,
  type Row,
} from "./__tests__/fixtures/parity-space.js";

/**
 * **与 merge-base `def63bb` 的差分。**
 *
 * 这一组和 `card-render.corpus.test.ts` 的分工要说清楚:语料是**被点过名的输入**的行为快照,
 * 期望值是字面量;这里一个期望值都没有 —— 判据全部由**执行** `def63bb` 的冻结快照算出来。
 *
 * 为什么非要执行而不是抄:手抄的护栏在这条分支上失效过两次,成因相同。
 *   - 第八轮:一次性脚本报「0 回归」,同一份代码上第九轮找到 120 条。脚本的行全是
 *     「口令不含 `/`、外部副本等于完整口令、无长 URL」—— 和代码同一批盲点。
 *   - 第九轮:`PARITY_CORPUS` 8 行手写字面量,第十轮的四类回归全部通过。最长的一行 375 字符,
 *     而其中一类的边界在 131 072。
 * 挑行的人有多少盲点,护栏就有多少盲点。改成按**维度**生成之后,要漏得先漏掉一整个维度 ——
 * 维度只有六个,可以逐个审。
 *
 * 三条判据,都是「不弱于 base」而不是「等于某个字面量」:
 *   1. 凭据回归 —— base 藏住的子串,head 不许渲染出来。**硬判据**,只允许 `KNOWN_OPEN` 里
 *      显式声明的类别。
 *   2. 过度隐藏 —— base 渲染、head 整行打空。方向安全,所以按类别钉住**数量**而不是禁止。
 *   3. 造串 —— head 不许发出 base 不发的、输入里没有的主机。**硬判据**,必须为 0。
 */

const FIXTURES = [
  ["card-render.def63bb.ts", "5856c9eeb7069d5b556b875611530cde434917cbddb3b3897d9dae8f6452bfb6"],
  ["card-action-status.def63bb.ts", "ff308ae18efd334088b3590ac9fc3508cb4dcd900d1b42d5431b032506de866d"],
] as const;

/**
 * 当前**已知未修**的回归类别,按维度描述。
 *
 * 每一条都带实测数量。数量对不上就变红 —— 这样「修了一半」和「新开了一个口子」都看得见,
 * 而不是被一句「反正在豁免里」盖掉。修好之后这一条会因为 `matched === 0` 变红,提示把它删掉:
 * 护栏不允许留下一条断言不到任何东西的豁免(这条分支上第二类反复出现的缺陷就是
 * 「测试丢了自己的被测对象」)。
 */
interface KnownOpen {
  id: string;
  note: string;
  when: (d: Dims) => boolean;
  regressions: number;
}

const KNOWN_OPEN: KnownOpen[] = [
  {
    id: "R10-P0-1",
    note:
      "collapseForReduction 的输入无界,却把尾巴喂给了 tailScanWindow —— 超过 2×RAW_INPUT_MAX 的" +
      "扣留信号任何一档都看不见。def63bb 无此窗口。修法:整条尾巴给 p.linear,只给 p.bounded 开窗。",
    when: (d) => d.signal === "keywordFar",
    regressions: 95,
  },
  {
    id: "R10-Q2",
    note:
      "poison 的 base 兼容判定是 MAIN_PASS3_RE.test(m) —— 「出现过」而不是「吃掉整段」。" +
      "嵌一个 base 能归约的 DSN 进去就能压掉 poison。修法:要求 main 的正则消费掉整个 m。",
    when: (d) => d.pw === "nestedDsn",
    regressions: 74,
  },
  {
    id: "R10-Q3",
    note:
      "poison 只问 isSensitiveHere.linear,而 JWT_RE 住在 hasBoundedSecretShape 里,于是被删 span " +
      "里的 JWT 不算扣留信号。def63bb 上 JWT 属于永远生效的前缀集。修法:改用 .all。",
    when: (d) => d.pw === "jwt" || d.user === "jwtName",
    regressions: 229,
  },
];

/**
 * 过度隐藏的类别与实测数量。方向安全(藏多了不泄漏),所以这里钉数量而不是禁止 ——
 * 但数量必须精确:悄悄多藏 200 组和悄悄少藏 200 组都该有人看一眼。
 */
const OVER_HIDE: Array<{ id: string; note: string; when: (d: Dims) => boolean; count: number }> = [
  // **顺序即归因,首个匹配胜出。** 开着的 finding 排在刻意代价前面 —— 一条既是嵌套 DSN、
  // 用户名又是 JWT 的行,该记在 finding 头上,而不是记成「我们本来就想藏」。
  // 第一版顺序反了,结果 Q2 那一格是 0,变成一条断言不到任何东西的豁免。
  {
    id: "R10-Q2 连带",
    note: "嵌套 DSN,与凭据回归里的 Q2 同源,修 Q2 时会一起变",
    when: (d) => d.pw === "nestedDsn",
    count: 18,
  },
  {
    id: "R10-Q3 连带",
    note: "JWT 作口令或用户名时 head 的守卫触发而 base 不触发,与 Q3 同源",
    when: (d) => d.pw === "jwt" || d.user === "jwtName",
    count: 212,
  },
  {
    id: "刻意/超 256 口令",
    note: "hasOverlongUserinfo:超长 userinfo 整行扣下,是本 PR 明确选择的代价",
    when: (d) => d.pw === "overlong",
    count: 1116,
  },
  {
    id: "刻意/IDN 与纯数字主机",
    note: "R11:这两类走到逐字比对,new URL() 规范化后的主机不在输入里 → 删除,比渲染原文安全",
    when: (d) => d.host === "idn" || d.host === "numeric",
    count: 28,
  },
];

interface Hit {
  row: Row;
  sink: string;
  base: string;
  head: string;
}

function classify<T extends { when: (d: Dims) => boolean; id: string }>(
  entries: T[],
  hits: Hit[],
): { counts: Map<string, number>; unclassified: Hit[] } {
  const counts = new Map(entries.map((e) => [e.id, 0]));
  const unclassified: Hit[] = [];
  for (const hit of hits) {
    const entry = entries.find((e) => e.when(hit.row.dims));
    if (entry) counts.set(entry.id, counts.get(entry.id)! + 1);
    else unclassified.push(hit);
  }
  return { counts, unclassified };
}

function show(hit: Hit): string {
  return (
    `  ${hit.sink} [${hit.row.id}]\n` +
    `    输入 ${JSON.stringify(hit.row.input).slice(0, 96)}\n` +
    `    base ${JSON.stringify(hit.base).slice(0, 96)}\n` +
    `    head ${JSON.stringify(hit.head).slice(0, 96)}`
  );
}

describe("与 def63bb 的差分 parity", () => {
  it("基准快照未被改动 —— 改一个字节,整组的基准就不再是 merge-base", () => {
    for (const [name, want] of FIXTURES) {
      const path = fileURLToPath(new URL(`./__tests__/fixtures/${name}`, import.meta.url));
      const got = createHash("sha256").update(readFileSync(path)).digest("hex");
      expect(got, `${name} 变了。它是 \`git show def63bb:src/…\` 的冻结快照,不是产品代码。` +
        `如果是有意重新 vendor(比如 merge-base 变了),更新这里的哈希并在 commit 里说明。`).toBe(want);
    }
  });

  const rows = generateParitySpace();
  const regressions: Hit[] = [];
  const overHides: Hit[] = [];
  const fabrications: Hit[] = [];
  for (const row of rows) {
    for (const sink of PARITY_SINKS) {
      const b = runSink(base, baseEcho, sink, row.input);
      const h = runSink(head, headEcho, sink, row.input);
      if (!b.includes(row.secret) && h.includes(row.secret)) regressions.push({ row, sink, base: b, head: h });
      else if (b !== "" && h === "") overHides.push({ row, sink, base: b, head: h });
      const bFab = fabricatedHosts(row.input, b);
      for (const host of fabricatedHosts(row.input, h)) {
        if (!bFab.has(host)) fabrications.push({ row, sink: `${sink} 造出主机 ${host}`, base: b, head: h });
      }
    }
  }

  it("输入空间没有退化 —— 维度、规模、越界行都还在", () => {
    // 这一条守的是**生成器自己**。上面三条判据都建立在「空间覆盖到了那些形状」之上,
    // 而空间一旦悄悄缩小,三条判据会一起变绿,看起来像修好了。
    expect(rows.length).toBeGreaterThan(5000);
    for (const dim of ["user", "pw", "host", "copy", "wrap", "signal"] as const) {
      const values = new Set(rows.map((r) => r.dims[dim]));
      expect(values.size, `维度 ${dim} 只剩 ${values.size} 个取值`).toBeGreaterThanOrEqual(3);
    }
    // 越界尾部是 P0-1 所在的边界,而在它进来之前,整个语料最长的一行是 375 字符。
    const far = rows.filter((r) => r.input.length > 131_072);
    expect(far.length, "没有任何一行越过 2×RAW_INPUT_MAX").toBeGreaterThanOrEqual(30);
    // 嵌套 DSN / JWT / 含 `/` 口令 / 非 ASCII 用户名 —— 每一类都曾经是护栏的盲点。
    for (const [label, pred] of [
      ["嵌套 DSN 口令", (r: Row) => r.dims.pw === "nestedDsn"],
      ["JWT", (r: Row) => r.dims.pw === "jwt" || r.dims.user === "jwtName"],
      ["含 / 的口令", (r: Row) => r.dims.pw === "withSlash"],
      ["非 ASCII 用户名", (r: Row) => r.dims.user === "cjk" || r.dims.user === "cyrillic"],
      ["外部副本是子串", (r: Row) => r.dims.copy === "substring"],
      ["与 userinfo 无关的信号", (r: Row) => r.dims.copy === "inline"],
    ] as const) {
      expect(rows.filter(pred).length, `${label} 这一类在输入空间里没有了`).toBeGreaterThan(0);
    }
  });

  it("凭据回归:base 藏住的,head 也要藏住", () => {
    const { counts, unclassified } = classify(KNOWN_OPEN, regressions);
    expect(
      unclassified.length,
      `${unclassified.length} 组回归不属于任何已声明的已知未修类别 —— 这是新开的口子。\n` +
        unclassified.slice(0, 8).map(show).join("\n"),
    ).toBe(0);
    // **整表比对,不逐条撞。** 逐条 `expect` 只报第一条不一致,而这些数字是联动的
    // (修一个类别常常同时改动另一个),一次只看见一个数字就会照着改一个、再撞下一个 ——
    // 我把这几个数字从一个归类顺序不同的脚本里手抄过来时,正是这样错的。
    expect(Object.fromEntries(counts)).toEqual(
      Object.fromEntries(KNOWN_OPEN.map((e) => [e.id, e.regressions])),
    );
    for (const entry of KNOWN_OPEN) {
      // 修好之后这一条会断言不到任何东西 —— 删掉它,别留一条空转的豁免。
      expect(counts.get(entry.id), `${entry.id} 一条都不命中了 —— 修复看来落地了,` +
        `把这条豁免从 KNOWN_OPEN 删掉,顺带把 ${entry.id} 从 PR 描述的未修清单里划掉。`)
        .toBeGreaterThan(0);
    }
  });

  it("过度隐藏:方向安全,但数量要精确", () => {
    const { counts, unclassified } = classify(OVER_HIDE, overHides);
    expect(
      unclassified.length,
      `${unclassified.length} 组「base 渲染 / head 打空」不属于任何声明过的类别。\n` +
        unclassified.slice(0, 8).map(show).join("\n"),
    ).toBe(0);
    expect(Object.fromEntries(counts)).toEqual(Object.fromEntries(OVER_HIDE.map((e) => [e.id, e.count])));
    for (const entry of OVER_HIDE) {
      expect(entry.count, `${entry.id} 声明成 0 —— 一条断言不到任何东西的豁免,删掉或者并进别的类别。`)
        .toBeGreaterThan(0);
    }
  });

  it("造串:head 不许发出 base 不发的、输入里没有的主机", () => {
    expect(
      fabrications.length,
      `${fabrications.length} 组造串。这是本模块声明的最坏失败模式 —— 输出看起来像脱敏过的,\n` +
        `操作者却无从知道自己读到的是被改过的。\n` + fabrications.slice(0, 8).map(show).join("\n"),
    ).toBe(0);
  });
});
