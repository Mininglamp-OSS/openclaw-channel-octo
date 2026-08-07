import { describe, it, expect } from "vitest";
import { summarizeToolParams, reduceUrlsInText, sanitizeErrorText } from "./card-render.js";
import { REDUCE_INPUT_MAX, SUMMARY_MAX, boundedForReduction } from "./card-render.js";
import { LEAK_CORPUS, BENIGN_CORPUS, COST_CORPUS, REWRITE_CORPUS, UNFIXED_CORPUS, PERF_CORPUS, type CorpusRow } from "./card-render.corpus.js";

const PARAM: Record<string, (s: string) => Record<string, unknown>> = {
  grep: (s) => ({ pattern: s }),
  read: (s) => ({ file_path: s }),
  exec: (s) => ({ command: s }),
  fetch: (s) => ({ url: s }),
};

function run(row: CorpusRow, tool: string): string {
  return summarizeToolParams(tool, PARAM[tool]!(row.input));
}

/** 每行对每个固定了期望的策略断言一次,失败信息带上它是哪一轮点出来的。 */
function assertRows(rows: CorpusRow[]) {
  for (const row of rows) {
    for (const [tool, want] of Object.entries(row.expect)) {
      const got = run(row, tool);
      expect(got, `${tool} ${JSON.stringify(row.input)}\n      note: ${row.note}`).toBe(want);
    }
  }
}

describe("摘要管线形状语料", () => {
  // 这四组是**行为快照**,不是规范。改动让某一行变了不一定是 bug,但必须是有意的 ——
  // 改期望值的同时要能说出为什么。见 card-render.corpus.ts 顶部。
  it("LEAK:凭据不出现在渲染结果里", () => {
    assertRows(LEAK_CORPUS);
    // 除了逐行等值,再断言一次「口令子串不出现」—— 等值断言只能守住已知的输出形态,
    // 这一条守住的是「无论输出变成什么,那几个串都不许在里面」。
    const SECRETS = ["horse", "hunter2", "s3cr3tvalue", "abcdEFGH1234", "sk-secret",
                     "AKIA", "hhhhhhhh", "abcdefghij"];
    for (const row of LEAK_CORPUS) {
      for (const [tool] of Object.entries(row.expect)) {
        const got = run(row, tool);
        for (const secret of SECRETS) {
          if (!row.input.includes(secret)) continue;
          expect(got, `${tool} ${JSON.stringify(row.input)} 渲染出了 ${secret}`).not.toContain(secret);
        }
      }
    }
  });

  it("BENIGN:普通内容不被误伤成空白", () => {
    assertRows(BENIGN_CORPUS);
  });

  // 这一组期望值全是空串 —— 但**空不等于记录到了代价**。上一轮这里放的是三条结构检查(超长、
  // 前 4000 无空白、非纯 hex),而那是**代理不是观测**:`"token=" + "z"×4100` 三条全过,两边
  // 却都是空。现在判据换成 `mainRenders` —— 每行必须带上它在 main 上的实测输出,且非空。
  // 想加一行,得先去 main 上量;量出来是空,就说明这行根本不属于这一组。
  it("COST:刻意付出的代价 —— 每一行都必须真的记录到一处差异", () => {
    assertRows(COST_CORPUS);
    for (const row of COST_CORPUS) {
      const at = JSON.stringify(row.input.slice(0, 40));
      expect(row.mainRenders, `${at} 的 mainRenders 为空 —— main 上也不渲染,这一行记录不到差异`)
        .not.toBe("");
      // 长度必须是这条策略发得出来的。`mainRenders` 是手写的实测值,而这一组的判据全靠它 ——
      // 上一版有一行写着 70 个字符,那是 grep 策略**不可能**产出的长度(SUMMARY_MAX + 省略号
      // 封顶 65),而当时的断言只查非空,看不见。漂移就这么搬进了被指定为真相的那个字段。
      expect(row.mainRenders.length,
        `${at} 的 mainRenders 有 ${row.mainRenders.length} 字符,而 grep 策略最多发出 ${SUMMARY_MAX + 1}`)
        .toBeLessThanOrEqual(SUMMARY_MAX + 1);
      // 期望值必须全空:有一项非空就说明这不是"刻意打空",放错组了。
      for (const [tool, want] of Object.entries(row.expect)) {
        expect(want, `${at} 的 ${tool} 期望值非空,它不属于 COST 组`).toBe("");
      }
      expect(row.input.length, `${at} 不超过上限,进不了这一组`).toBeGreaterThan(REDUCE_INPUT_MAX);
    }
  });

  // 这一组断言的是**本 PR 没有改变**这些形状 —— 期望值是 main 的行为,不是"正确"的行为。
  // 前四行在 main 上就是明文泄漏,留给 userinfo 那条后续 PR;放在这里是为了让它们进造串检测。
  it("UNFIXED:留给后续 PR 的形状,本 PR 未改变其行为", () => {
    assertRows(UNFIXED_CORPUS);
  });

  it("REWRITE:改写结果里的每个字符都来自输入", () => {
    assertRows(REWRITE_CORPUS);
    // 造串检测:去掉归约自己加的 `https://` 前缀后,输出的每个字母数字段都必须在输入里出现过。
    // `nginx:1.21@sha256:1234abcd` → `https://sha256abcd` 这类失败就是被这一条抓住的:
    // `sha256abcd` 是端口在词中间截断后、把没匹配上的尾巴拼上去造出来的,输入里没有。
    for (const row of [...REWRITE_CORPUS, ...BENIGN_CORPUS, ...COST_CORPUS, ...UNFIXED_CORPUS]) {
      for (const [tool] of Object.entries(row.expect)) {
        const got = run(row, tool).replace(/https?:\/\//g, "");
        for (const seg of got.match(/[A-Za-z0-9]{4,}/g) ?? []) {
          expect(row.input, `${tool} ${JSON.stringify(row.input)} 的输出里出现了输入中没有的串 ${seg}`)
            .toContain(seg);
        }
      }
    }
  });

  // 每一行标注的 reachesPasses 必须与实际一致。空白边界截断落地后,超过上限且前 4000 字符
  // 不含空白的输入在长度判定处就被拒,一趟正则都不跑 —— 那种行断言的是「守卫存在」,不是
  // 「那几趟有界」。这条断言让「某行悄悄滑进短路组」变成红,而不是安静地失去覆盖。
  it("PERF:每行是否真的进入管线,与它的标注一致", () => {
    for (const { label, input, reachesPasses } of PERF_CORPUS) {
      // **调用真正的守卫,不复刻一份判定。** 上一版写的是
      //     input.length <= REDUCE_INPUT_MAX || /\s/.test(input.slice(0, REDUCE_INPUT_MAX))
      // 它当时等价于守卫,然后 `+1` 一落地就悄悄错了(空白正好在下标 4000 时模型说 false、
      // 守卫其实跑完了整条管线),而且因为当时没有一行是那个形状,断言还是绿的 —— 正是它自己
      // 要防的那种漂移。观测守卫本身,这一类由构造消失。
      const actual = boundedForReduction(input) !== null;
      expect(actual, `${label}:标注 reachesPasses=${reachesPasses},实际 ${actual}`).toBe(reachesPasses);
    }
    // 至少要有真正跑完管线的行,否则整组退化成「长度守卫存在」的重复断言。
    expect(PERF_CORPUS.filter((r) => r.reachesPasses).length).toBeGreaterThanOrEqual(4);
  });

  // 计时断言。**管线和调用方都要测** —— 上一轮只加了管线级断言,而当时的回归住在调用方、
  // 在管线下游,于是 5.9 秒的缺陷全绿通过。
  it("PERF:管线与调用方在所有形状上都有界", () => {
    // 预算要同时满足两头:高于真实代价 × CI 抖动(可达行实测最贵 17.5 ms),且**低于已知回归**
    // —— R4a 那个三次方在 4000 字符处约 1.7 秒。2000 ms 只满足前一头,那个回归会绿着通过。
    const budgetMs = 300;
    for (const { label, input, note } of PERF_CORPUS) {
      const entries: Array<[string, () => unknown]> = [
        ["reduceUrlsInText", () => reduceUrlsInText(input)],
        ["sanitizeErrorText", () => sanitizeErrorText(input)],
        ["summarizeToolParams/grep", () => summarizeToolParams("grep", { pattern: input })],
        ["summarizeToolParams/read", () => summarizeToolParams("read", { file_path: input })],
        ["summarizeToolParams/exec", () => summarizeToolParams("exec", { command: input })],
      ];
      for (const [name, fn] of entries) {
        // 先跑一次不计时:第一格会背上 JIT 编译的成本,而预算是按稳态代价定的。
        // 这是为了不必**放宽预算**去容纳一次性开销 —— 预算的下限由已知回归钉着,不能动。
        fn();
        const t0 = performance.now();
        fn();
        const ms = performance.now() - t0;
        expect(ms, `${name} / ${label} 耗时 ${ms.toFixed(0)} ms\n      note: ${note}`)
          .toBeLessThan(budgetMs);
      }
    }
  });
});
