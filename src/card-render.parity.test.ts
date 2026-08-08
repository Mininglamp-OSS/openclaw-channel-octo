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
 * 当前**已知未修**的回归类别。
 *
 * 每一条都带实测数量。数量对不上就变红 —— 这样「修了一半」和「新开了一个口子」都看得见,
 * 而不是被一句「反正在豁免里」盖掉。修好之后这一条会因为 `matched === 0` 变红,提示把它删掉:
 * 护栏不允许留下一条断言不到任何东西的豁免(这条分支上第二类反复出现的缺陷就是
 * 「测试丢了自己的被测对象」)。
 */
interface KnownOpen {
  id: string;
  note: string;
  /**
   * **谓词吃的是整个 hit,不只是维度。** 维度谓词写起来省事,但它描述的是「哪些输入」而不是
   * 「什么机制」—— 下面这条豁免要表达的是「base 自己也在泄漏,只是被截断了」,那是 base/head
   * 两个输出之间的关系,维度里根本没有这个信息。用维度近似它就会顺带盖住同维度下真正的回归。
   */
  when: (h: Hit) => boolean;
  regressions: number;
}

const KNOWN_OPEN: KnownOpen[] = [
  {
    id: "R11-截断错位",
    note:
      "两边都在泄漏,head 多露几个字符。base 没能归约前缀(反而造出一个小写化的假主机 —— " +
      "本 PR 的逐字比对关掉的正是那一路),输出更长,于是 read 摘要在 secret 中间截断;head 归约" +
      "成功、前缀更短,整份外部副本落进了 64 字符窗口。真正的洞是 read sink 对外部副本没有守卫" +
      "(generic=false 跳过高熵档,见 UNFIXED 组末尾那四行),不是这几处修复引入的,也没有" +
      "「既归约得更好、又少露字符」的改法。pass 2 前保存敏感证据顺带关掉了原来 5 组中的" +
      "4 组;剩下这一组不经过那条破坏证据的路径。\n" +
      "      **判据按机制写而不是按维度写**:要求 base 自己已经露出 secret 的前 12 个字符、" +
      "且它的输出确实被截断了。所以它吞不掉任何一条真正的「base 干净 / head 泄漏」。",
    when: (h) => h.base.endsWith("…") && h.base.includes(h.row.secret.slice(0, 12)),
    regressions: 1,
  },
];
/**
 * 过度隐藏的类别与实测数量。方向安全(藏多了不泄漏),所以这里钉数量而不是禁止 ——
 * 但数量必须精确:悄悄多藏 200 组和悄悄少藏 200 组都该有人看一眼。
 */
const OVER_HIDE: Array<{ id: string; note: string; when: (h: Hit) => boolean; count: number }> = [
  // **顺序即归因,首个匹配胜出。** 开着的 finding 排在刻意代价前面 —— 一条既是嵌套 DSN、
  // 用户名又是 JWT 的行,该记在 finding 头上,而不是记成「我们本来就想藏」。
  // 第一版顺序反了,结果 Q2 那一格是 0,变成一条断言不到任何东西的豁免。
  {
    id: "刻意/pass 2 前保存敏感证据",
    note:
      "pass 2 会消费 protocol-relative JWT 主机的前半段,让后半段在 pass 3 形成新的 userinfo。" +
      "preflight 在信号消失前与 pass 3 共用 matcher/helper 并整行扣下;这 30 组 base 只渲染了" +
      "不含外部口令的截断前缀,因此属于修复换来的安全方向可读性代价。",
    when: ({ row }) => row.dims.signal === "jwtDestroyedByPass2",
    count: 45,
  },
  {
    id: "刻意/嵌套 DSN",
    note:
      "Q2 修好之后的**预期效果**:base 把 `credential:pw/u:p@a.example.com@vault` 归约成 " +
      "`https://vault …` 并渲染出口令,head 整行扣下。按维度首个匹配归类,其中包含与 " +
      "residual-userinfo default-deny 重叠的行。pass 2 preflight 又使 72 组同类输入在信号被改写前" +
      "扣下,所以本格由 320 增至 392。",
    when: ({ row }) => row.dims.pw === "nestedDsn",
    count: 392,
  },
  {
    id: "刻意/JWT 在被删 span 里",
    note:
      "Q3 修好之后的**预期效果**:被删 span 里的 JWT 现在也交给调用方的单一敏感判定," +
      "head 整行扣下,而 base 渲染。Q3 修复把 212 增至 252;pass 2 preflight 再增加 89 组," +
      "现为 341。",
    when: ({ row }) => row.dims.pw === "jwt" || row.dims.user === "jwtName",
    count: 341,
  },
  {
    id: "刻意/超 256 口令",
    note: "超长口令维度的全部 over-hide;包含 hasOverlongUserinfo 与后置 default-deny 的重叠",
    when: ({ row }) => row.dims.pw === "overlong",
    count: 1836,
  },
  {
    id: "刻意/IDN 与纯数字主机",
    note: "IDN/纯数字主机维度的全部 over-hide;逐字比对删除与后置 default-deny 均为安全方向",
    when: ({ row }) => row.dims.host === "idn" || row.dims.host === "numeric",
    count: 356,
  },
  {
    id: "刻意/残余 userinfo default-deny",
    note:
      "head 在归约收口处扣下仍带 colon…@ 的 token。按 base 实际输出归类,而不是再复制生产字符类;" +
      "覆盖非 ASCII/标点用户名、IPv6 zone-id、空 host 及同形普通坐标。这里是未被前面重叠维度" +
      "先归类的 1790 条;本次 default-deny 使总 over-hide 相比 9d25997 增加 3140 条。",
    when: ({ base }) => base.split(/\s+/).some((token) => {
      const at = token.lastIndexOf("@");
      const colon = token.indexOf(":");
      return at > 0 && colon >= 0 && colon < at;
    }),
    count: 1790,
  },
];

interface Hit {
  row: Row;
  sink: string;
  base: string;
  head: string;
}

function classify<T extends { when: (h: Hit) => boolean; id: string }>(
  entries: T[],
  hits: Hit[],
): { counts: Map<string, number>; unclassified: Hit[] } {
  const counts = new Map(entries.map((e) => [e.id, 0]));
  const unclassified: Hit[] = [];
  for (const hit of hits) {
    const entry = entries.find((e) => e.when(hit));
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

  it("pass 2 删除 JWT 信号后,head 不能渲染 base 完全没露出的外部口令", () => {
    const secret = "correcthorsebattery";
    const input =
      `//eyJabcdefgh.${"b".repeat(80)}.abc4w9WgXcQ:${secret}@vault/x ` +
      `retry with ${secret}`;
    const b = runSink(base, baseEcho, "read", input);
    const h = runSink(head, headEcho, "read", input);
    expect(b, `这个用例不是 base-clean,不能证明回归。base=${JSON.stringify(b)}`).not.toContain(secret);
    expect(h, `head 渲染了 base 没露出的口令。head=${JSON.stringify(h)}`).not.toContain(secret);
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
    const passOrder = rows.filter((r) => r.dims.signal === "jwtDestroyedByPass2");
    expect(passOrder.length, "pass 2 删信号 × 新 pass 3 × 外部副本的交互切片退化了").toBe(60);
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
