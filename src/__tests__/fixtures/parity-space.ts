/**
 * 差分 parity 的**输入空间生成器**与 sink 调用面。
 *
 * 它和 `card-render.corpus.ts` 的分工:语料是一张**被点过名的输入**的快照表,期望值是字面量;
 * 这里是**按维度生成**的空间,期望值一个都没有 —— 判据全部由执行 `def63bb` 快照算出来。
 *
 * 为什么必须是生成的:这条分支上手挑行的护栏失效过两次。第八轮的一次性脚本报「0 回归」而
 * 实际 120 条,第九轮的 PARITY 语料组 8 行手写字面量而第十轮的四类回归全部通过。两次同一个
 * 成因 —— 挑行的人有多少盲点,护栏就有多少盲点。维度笛卡尔积没有这个性质:漏掉一个**维度**
 * 才会漏,而维度比具体输入少得多、也好审得多。
 *
 * 本文件不进 tsc(见 tsconfig 的 `src/__tests__/**` 排除),因此不会被编译进 dist 发出去。
 */

/** 一行的维度元组。豁免清单按**维度**写,不按字符串写 —— 字符串豁免会随生成器漂移而失效。 */
export interface Dims {
  user: string;
  pw: string;
  host: string;
  copy: string;
  wrap: string;
  signal: string;
}

export interface Row {
  id: string;
  input: string;
  /** 必须不出现在渲染结果里的凭据子串。 */
  secret: string;
  dims: Dims;
}

/** 用户名形状。历史上每一种都各自漏过一次。 */
const USERS: Record<string, string> = {
  ascii: "user",
  cjk: "用户",
  cyrillic: "а",
  withAt: "u@v",
  pctEncoded: "a%40b",
  jwtName: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.dQw4w9WgXcQ",
};

/**
 * 口令形状。每一个都带一个可辨认的标记(`Kx`/`Qz`/`Zq`),这样「这个子串出现了」不会因为
 * 撞上普通英文而误报。
 */
const PWS: Record<string, string> = {
  plain: "hunter2Kx",
  withSlash: "paKx/ssQz",
  overlong: "Zq" + "p".repeat(298),
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJLeCJ9.QzKx9wRt",
  entropy36: "Ab3xY9zQ1wKpAb3xY9zQ1wKpAb3xY9zQ1wKp",
  nestedDsn: "aB3xY9zQ1wKp/inner:pQz@a.example.com",
};

const HOSTS: Record<string, string> = {
  singleLabel: "vault",
  dotted: "db.example.com",
  ipv4: "10.0.0.5",
  ipv6: "[::1]",
  ipv6Zone: "[fe80::1%eth0]",
  empty: "",
  idn: "例え.jp",
  numeric: "2",
  withPort: "db.example.com:5432",
  withPath: "db.example.com/prod",
};

const WRAPS: Record<string, (dsn: string) => string> = {
  bare: (d) => d,
  leadingSlash: (d) => "/" + d,
  protocolRelative: (d) => "//" + d + "/x",
  scheme: (d) => "https://" + d + "/x?q=1",
  inProse: (d) => `connect to ${d} failed after 3 retries`,
};

/**
 * 扣留信号的位置。`keywordFar` 那一档把关键词推到 `2 × RAW_INPUT_MAX` 之外 —— 评审第十轮
 * 的 P0-1 就住在这条边界上,而在它之前,整个语料里最长的一行是 375 字符。
 */
const SIGNALS: Record<string, (s: string) => string> = {
  none: (s) => s,
  keywordInSpan: (s) => s.replace(/^(\/*)/, "$1credential:"),
  keywordNear: (s) => s + " token",
  keywordFar: (s) => s + " " + "x ".repeat(70_000) + "token",
};

export function generateParitySpace(): Row[] {
  const rows: Row[] = [];
  const push = (dims: Dims, input: string, secret: string): void => {
    rows.push({ id: Object.values(dims).join("/"), input, secret, dims });
  };
  const mk = (user: string, pw: string, host: string, copy: string, wrap: string, signal: string): void => {
    const pwText = PWS[pw]!;
    // 外部副本取前 12 字符时,它自己短于高熵阈值 —— 第九轮 P1-b 就是这一类。
    const secret = copy === "substring" ? pwText.slice(0, 12) : pwText;
    const dsn = `${USERS[user]}:${pwText}@${HOSTS[host]}`;
    const tail = copy === "none" ? "" : ` retry with ${secret}`;
    push({ user, pw, host, copy, wrap, signal }, SIGNALS[signal]!(WRAPS[wrap]!(dsn) + tail), secret);
  };

  // 主体:便宜的维度全笛卡尔,不带长尾。
  for (const user of Object.keys(USERS)) {
    for (const pw of Object.keys(PWS)) {
      for (const host of Object.keys(HOSTS)) {
        for (const copy of ["none", "full", "substring"]) {
          for (const wrap of Object.keys(WRAPS)) mk(user, pw, host, copy, wrap, "none");
        }
      }
    }
  }
  // 信号位置 × 包裹。**这一片必须铺开到 wrap。** 第一版只铺 `wrap=bare`,于是把 poison 的
  // base 兼容判定退回手抄版本时,整个空间只有 11 组变红 —— 够变红,但那是运气:
  // `protocolRelative` / `scheme` 这两种包裹与守卫的交互一条都没覆盖。这一片不带长尾,很便宜。
  for (const pw of Object.keys(PWS)) {
    for (const host of Object.keys(HOSTS)) {
      for (const wrap of Object.keys(WRAPS)) {
        for (const signal of ["keywordInSpan", "keywordNear"]) mk("ascii", pw, host, "full", wrap, signal);
      }
    }
  }
  // 越界尾部每行 132 KB,收到一个切片。这条边界不能没有 —— P0-1 就在这里。
  for (const pw of ["plain", "withSlash", "entropy36"]) {
    for (const host of Object.keys(HOSTS)) mk("ascii", pw, host, "full", "bare", "keywordFar");
  }
  // 与归约完全无关的一类:信号不在任何 userinfo 里。P0-1 在这里同样成立,
  // 说明它不是 userinfo 的问题,是尾部窗口的问题。
  const INLINE: Array<[string, string]> = [
    ["db_pass hunter2Kx", "hunter2Kx"],
    ["api_key Ab3xY9zQ1wKp", "Ab3xY9zQ1wKp"],
    ["PASSPHRASE=hunter2Kx gpg --sign x", "hunter2Kx"],
  ];
  for (const [i, [text, secret]] of INLINE.entries()) {
    for (const signal of ["none", "keywordNear", "keywordFar"]) {
      push({ user: "n/a", pw: `inline${i}`, host: "n/a", copy: "inline", wrap: "bare", signal },
        SIGNALS[signal]!(text), secret);
    }
  }
  return rows;
}

/**
 * 组内可见的 sink。
 *
 * **`echo` 这一路的参数形状必须对。** 第一版我传了一个臆想的 `{title,state,values}`,两边同时
 * 抛异常、被 catch 成同一个字符串 —— 809 组比对全是空转,而报告显示「0 差异」。
 * 展示卡(`buildDisplayCard`)不在这里:它与 `card-render` 循环依赖,冻结它要连带冻结 1000 行,
 * 而它调用的归约/守卫原语与这五个 sink 是同一套。**这是一个明示的覆盖缺口,不是遗漏。**
 */
export const PARITY_SINKS = ["grep", "read", "exec", "error", "echo"] as const;
export type ParitySink = (typeof PARITY_SINKS)[number];

export function runSink(render: any, actionStatus: any, sink: ParitySink, input: string): string {
  if (sink === "error") return render.sanitizeErrorText(input);
  if (sink === "echo") {
    return actionStatus.renderCardActionStatus({
      card: { body: [{ type: "Input.Text", id: "q", label: "Q" }] },
      plain: "",
      inputs: { q: input },
      operator: "op",
      actionLabel: "submit",
      status: "completed",
    }).plain;
  }
  const params =
    sink === "grep" ? { pattern: input } : sink === "read" ? { file_path: input } : { command: input };
  return render.summarizeToolParams(sink, params);
}

/**
 * 输出里归约发出的每一个主机。
 *
 * 三个坑都踩过:
 *  - `replace(/[:/].*$/, "")` 会把 `[::1]` 削成 `[`,于是「主机必须逐字在输入里」对所有方括号
 *    IPv6 恒真(评审第十轮 Q6 指出的空转断言)。这里方括号整体取。
 *  - `echo` 会做 markdown 转义(`\[`),不还原就会把转义符当成造串。
 *  - 摘要在 `SUMMARY_MAX` 处截断补 `…`,最后一个主机可能被切了一半,真伪无从判断,跳过。
 *
 * 即便如此仍不完美(`https://https://x` 这类嵌套)。所以造串判据写成**差分**:head 不许造出
 * base 不造的主机 —— 提取器的瑕疵在两边同样出现,自动抵消。
 */
export function fabricatedHosts(input: string, out: string): Set<string> {
  const unescaped = out.replace(/\\([\\`*_~[\]<>])/g, "$1");
  const found = new Set<string>();
  for (const m of unescaped.matchAll(/[a-z][a-z0-9+.-]*:\/\/(\[[^\]]*\]|[^\s/?#,)"':…]+)/gi)) {
    const host = m[1]!;
    if (host && !host.includes("…") && !input.includes(host)) found.add(host);
  }
  return found;
}
