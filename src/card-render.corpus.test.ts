import { describe, it, expect } from "vitest";
import { summarizeToolParams, reduceUrlsInText, sanitizeErrorText } from "./card-render.js";
import { LEAK_CORPUS, BENIGN_CORPUS, REWRITE_CORPUS, UNFIXED_CORPUS, PERF_CORPUS, type CorpusRow } from "./card-render.corpus.js";

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
    const SECRETS = ["horse", "hunter2", "s3cr3tvalue", "signature=", "code=abc", "sid=abcdef",
                     "abcdEFGH1234", "sk-secret"];
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
    for (const row of [...REWRITE_CORPUS, ...BENIGN_CORPUS, ...UNFIXED_CORPUS]) {
      for (const [tool] of Object.entries(row.expect)) {
        const got = run(row, tool).replace(/https?:\/\//g, "");
        for (const seg of got.match(/[A-Za-z0-9]{4,}/g) ?? []) {
          expect(row.input, `${tool} ${JSON.stringify(row.input)} 的输出里出现了输入中没有的串 ${seg}`)
            .toContain(seg);
        }
      }
    }
  });

  // 计时断言。**管线和调用方都要测** —— 上一轮只加了管线级断言,而当时的回归住在调用方、
  // 在管线下游,于是 5.9 秒的缺陷全绿通过。
  it("PERF:管线与调用方在所有形状上都有界", () => {
    const budgetMs = 2000; // 修好后实测每格 20 ms 内;余量留给 CI
    for (const { label, input, note } of PERF_CORPUS) {
      const entries: Array<[string, () => unknown]> = [
        ["reduceUrlsInText", () => reduceUrlsInText(input)],
        ["sanitizeErrorText", () => sanitizeErrorText(input)],
        ["summarizeToolParams/grep", () => summarizeToolParams("grep", { pattern: input })],
        ["summarizeToolParams/read", () => summarizeToolParams("read", { file_path: input })],
        ["summarizeToolParams/exec", () => summarizeToolParams("exec", { command: input })],
      ];
      for (const [name, fn] of entries) {
        const t0 = performance.now();
        fn();
        const ms = performance.now() - t0;
        expect(ms, `${name} / ${label} 耗时 ${ms.toFixed(0)} ms\n      note: ${note}`)
          .toBeLessThan(budgetMs);
      }
    }
  });
});
