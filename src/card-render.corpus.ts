/**
 * 摘要管线的形状语料 —— 四轮评审里**被点过名的每一个输入**,连同它当前的渲染结果。
 *
 * 为什么是一张表而不是散落的断言:这条分支上反复出现同一种失败 —— 为了修一条 finding 而调紧
 * 或调松一个字符类/前瞻/终止符,在另一个方向开了一个更大的口子,而现有测试全绿。逐条打补丁看
 * 不出这种事,因为每条补丁只带来它自己那一条断言。
 *
 * 这张表把「改了这个正则会不会碰坏别的」从判断题变成跑一次测试:任何一处改动,这里会精确列出
 * 哪些行变了、变成了什么。**期望值不是"应该是什么",而是"现在是什么"** —— 它是行为快照,不是
 * 规范。改动让某一行变了,那不一定是 bug,但必须是有意的:改期望值的同时要能说出为什么。
 *
 * 分组即判据,四类各自的失败方向不同:
 *   - LEAK    凭据必须**不出现**在渲染结果里。这一组变红一律是 bug。
 *   - BENIGN  普通内容不该被误伤成空白。变红是过度隐藏,方向安全但要知情。
 *   - REWRITE 归约改写了内容。**渲染结果里的每个字符都必须来自输入**(scheme 前缀除外)——
 *             凭空造串是本模块声明的最坏失败模式:输出看起来像脱敏过的,操作者却无从知道
 *             自己读到的是被改过的。
 *   - PERF    耗时上限。这些函数都在同步路径上、无 try/catch。
 */

/** 一行语料。`note` 说明这一行是哪一轮评审点出来的、为什么留在这里。 */
export interface CorpusRow {
  input: string;
  /** 各策略下的渲染结果。缺省的键表示该策略不适用/未固定。 */
  expect: Partial<Record<"grep" | "read" | "exec" | "fetch", string>>;
  note: string;
}

/** 凭据必须不出现在结果里。 */
export const LEAK_CORPUS: CorpusRow[] = [
  {
    input: "PASSPHRASE='correct horse battery staple' gpg --sign x",
    expect: { exec: "gpg" },
    note: "R3:空白分词把带引号的多词值切碎,程序名落在值的第二个词上 → main 渲染 `horse`",
  },
  {
    input: "MY_CREDS='alpha hunter2 charlie' ./go",
    expect: { exec: "./go" },
    note: "R3:同上,main 渲染 `hunter2`",
  },
  {
    input: 'DEPLOY_KEY="one s3cr3tvalue two" ./deploy.sh',
    expect: { exec: "./deploy.sh" },
    note: "R3:双引号形态,main 渲染 `s3cr3tvalue`",
  },
  {
    input: "MY_CREDS=$'alpha hunter2 x' ./go",
    expect: { exec: "./go" },
    note: "R3:ANSI-C 引用。词原子必须写成**重复**而非单选,否则引号只在 `=` 后第 0 位生效",
  },
  {
    input: 'PASSPHRASE="alpha\\" hunter2 x" gpg',
    expect: { exec: "gpg" },
    note: "R3:值里有转义引号,不能在转义处提前收尾",
  },
  {
    input: "internal/v1/pay?signature=dead",
    expect: { grep: "internal/v1/pay", read: "internal/v1/pay" },
    note: "R4:单标签主机的 query 段。main 原样渲染",
  },
  {
    input: "192.168.0.1?code=abc",
    expect: { grep: "192.168.0.1", read: "192.168.0.1" },
    note: "R4b:IPv4 字面量是内网最常见的无字母主机。OAuth code 等价于 bearer",
  },
  {
    input: "127.0.0.1?sid=abcdef",
    expect: { grep: "127.0.0.1", read: "127.0.0.1" },
    note: "R4b:同上",
  },
  {
    input: `'localhost:8080/s?f={"a":1}&code=hunter2'`,
    expect: { grep: "" },
    note: "R4:query 里嵌引号 → 归约不改写(半改写会把命令改成另一条),整串不渲染",
  },
  {
    input: "https://hooks.slack.com/services/T00/B00/abcdEFGH1234abcdEFGH1234",
    expect: { grep: "https://slack.com", fetch: "https://slack.com" },
    note: "既有:webhook path 即凭据,只暴露注册域",
  },
  {
    input: "https://u:p@host.com/a/b?token=sk-secret&x=1",
    expect: { fetch: "https://host.com" },
    note: "既有:带 scheme 的 DSN 由第 1 趟 new URL() 剥掉 userinfo 与 query",
  },
];

/** 普通内容不该被误伤成空白。 */
export const BENIGN_CORPUS: CorpusRow[] = [
  {
    input: "src/index.ts",
    expect: { read: "src/index.ts", grep: "src/index.ts" },
    note: "R4:普通相对路径。放宽 query 趟的主机形状会把它当 host/path 毁掉",
  },
  {
    input: "src/file?.ts",
    expect: { read: "src/file?.ts", grep: "src/file?.ts" },
    note: "R4:shell glob 不含 `=`,不被 query 趟碰",
  },
  {
    input: "10/20?ok=yes",
    expect: { grep: "10/20?ok=yes" },
    note: "R4:纯数字主机归约主动不碰;兜底也必须不拦,否则 query 策略直接空白卡",
  },
  {
    input: "2026-08-06?ok=yes",
    expect: { grep: "2026-08-06?ok=yes" },
    note: "R4:同上,日期形态",
  },
  {
    input: "8080?code=abc",
    expect: { grep: "8080?code=abc" },
    note: "R4b:裸数字单标签。与上面两行形状一致,无法区分 → 已知残留,README 写明",
  },
  {
    input: "email:\\s*\\S+@\\S+",
    expect: { grep: "email:\\s*\\S+@\\S+" },
    note: "R4c:搜邮箱是常规操作。曾被 userinfo 兜底整串打空",
  },
  {
    input: "user:.*@example",
    expect: { grep: "user:.*@example" },
    note: "R4c:同上",
  },
  {
    input: "sed 's:a:b@c:g'",
    expect: { exec: "sed" },
    note: "既有:与 DSN 形状无法区分,shell 有程序名可退",
  },
  {
    input: "/repo/.git/objects/1a/2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c",
    expect: { read: "…/1a/2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c" },
    note: "既有:高熵检测不套用到 path,否则日常路径频繁空白",
  },
  {
    input: "risk-averse task-force",
    expect: { grep: "risk-averse task-force" },
    note: "既有:前缀式密钥的长度下限不能误伤连字符英文",
  },
];

/**
 * 归约改写了内容的行。**结果里的每个字符都必须来自输入**(`https://` 前缀除外)。
 * 这一组是给「凭空造串」这一类失败准备的:R4a 里 `nginx:1.21@sha256:1234abcd` 曾被改写成
 * `https://sha256abcd`,`3:4@2/x` 曾被 new URL() 规范化成 `https://0.0.0.2`。
 */
export const REWRITE_CORPUS: CorpusRow[] = [
  {
    input: "'localhost/reset?code=abc'",
    expect: { read: "'localhost/reset'" },
    note: "R4:命令行上给 URL 加引号是常态,前导集必须认引号",
  },
  {
    input: "--url=localhost/reset?code=abc",
    expect: { read: "--url=localhost/reset" },
    note: "R4:query 前面粘的是 `=`",
  },
  {
    input: "localhost?code=abc",
    expect: { read: "localhost" },
    note: "R4:query 直接挂在裸主机上,路径段两边都必须可选",
  },
  {
    input: "1.2.3.4?rev=5",
    expect: { grep: "1.2.3.4" },
    note: "R4b 新增代价:四段数字版本号(.NET 程序集版本)与 IPv4 无法区分。README 写明",
  },
  {
    input: "colou?r=red",
    expect: { grep: "colou" },
    note: "R4:grep 模式里 `?` 是量词的概率远大于 query 分隔符。静默改写,README 写明",
  },
  {
    input: "reports/q3?draft=1.pdf",
    expect: { read: "reports/q3" },
    note: "R4:同上,文件名形态",
  },
  {
    input: "user:pw@db.example.com:5432/prod",
    expect: { grep: "https://example.com" },
    note: "既有:带点主机的 DSN,main 就是这个行为",
  },
];

/**
 * **本 PR 不修**、留给 userinfo 那条后续 PR 的形状。期望值 = `main` 的行为。
 *
 * 为什么明确列出来而不是省略:这一组是 `SCHEMELESS_USERINFO_RE` 的单标签放宽 + 配套 fail-closed
 * 兜底要覆盖的面。那一对在四轮里两次把缺陷改成了更糟的缺陷 —— 放宽归约会把
 * `nginx:1.21@sha256:1234abcd` 改写成输入里不存在的 `https://sha256abcd`,收紧兜底又会让一个
 * 尾随逗号整条绕过它 —— 所以整对摘出去单独评审了。
 *
 * 但形状必须留在表里:它们同时进造串检测,谁再动那对正则,这里会立刻指出改写方向对不对。
 * 前四行是 `main` 上就存在的明文泄漏,**不是本 PR 引入的**,也不是本 PR 声称修好的。
 */
export const UNFIXED_CORPUS: CorpusRow[] = [
  {
    input: "user:hunter2@localhost",
    expect: { grep: "user:hunter2@localhost" },
    note: "main 上的既有泄漏:裸单标签主机的 DSN。归约要求带点,一趟都不匹配",
  },
  {
    input: "/user:pass@localhost",
    expect: { grep: "/user:pass@localhost" },
    note: "main 上的既有泄漏:前导 `/`",
  },
  {
    input: "prefix/user:pa/ss@db.example.com",
    expect: { grep: "prefix/user:pa/ss@db.example.com" },
    note: "main 上的既有泄漏:主机带点,但口令里的 `/` 让归约的 `[^\\s/]+` 匹配不上",
  },
  {
    input: "user:hunter2@[::1]",
    expect: { grep: "user:hunter2@[::1]" },
    note: "main 上的既有泄漏:IPv6 方括号主机",
  },
  {
    input: "nginx:1.21@sha256:1234abcd",
    expect: { grep: "nginx:1.21@sha256:1234abcd" },
    note: "造串哨兵:放宽单标签分支时曾被改写成 `https://sha256abcd`,输入里没有这个串",
  },
  {
    input: "3:4@2/x",
    expect: { grep: "3:4@2/x" },
    note: "造串哨兵:纯数字主机被 new URL() 规范化成 `https://0.0.0.2`",
  },
  {
    input: "image:v1@registry/repo",
    expect: { grep: "image:v1@registry/repo" },
    note: "造串哨兵:`word:token@letter-host/path` 这一类的代表形状",
  },
];

/**
 * 耗时上限。列在这里的每一个形状都曾经是几秒级停顿。
 *
 * **形状要多样。** 回溯代价随输入形状变化极大,只测一种会得出「另外几趟不要紧」的错误结论 ——
 * 这条分支上犯过两次:一次是只测了 `a:b@` + 无点串就断定 schemeless 那几趟免费,一次是只测了
 * 管线本身、没测冒号密集串,于是一个 5.9 秒的回归全绿通过。
 */
export const PERF_CORPUS: Array<{ label: string; input: string; note: string }> = [
  {
    label: "无点长串 + query",
    input: "a".repeat(100_000) + "?x",
    note: "R1:main 上 read 策略 9311 ms",
  },
  {
    label: "scheme + 长主机",
    input: "http://" + "a".repeat(120_000),
    note: "R1:走第 1 趟 scheme 正则,与上一行代价完全不同",
  },
  {
    label: "userinfo 前缀 + 长串",
    input: "a:b@" + "a".repeat(60_000),
    note: "R1:main 上 exec 策略 3442 ms",
  },
  {
    label: "冒号密集(无空白)",
    input: "a:".repeat(3000),
    note: "R4a:曾在兜底的无界前瞻上跑出 5877 ms。**串里不能有空白** —— 有空白的 `key: val` 只有 1 ms,回溯长度取决于单个 token",
  },
  {
    label: "冒号密集 + 长尾",
    input: "a:".repeat(1000) + "b".repeat(2000),
    note: "R4a:同上,7314 ms",
  },
  {
    label: "压缩 JSON(无空白)",
    input: "{" + Array.from({ length: 180 }, (_, i) => `"k${i}":"v${i}"`).join(",") + "}",
    note: "R4a:模型正常会生成的参数,曾 1247 ms。这一行是「不只是构造串」的证据",
  },
  {
    label: "label selector(无空白)",
    input: Array.from({ length: 250 }, (_, i) => `app${i}:v${i}`).join(","),
    note: "R4a:同上,曾 1272 ms",
  },
];
