import { describe, it, expect } from "vitest";
import {
  OCTO_CARD_LAYOUTS,
  detectOctoCardLayout,
  renderProgressCard,
  renderProgressResponseCard,
  resolveToolMeta,
  summarizeToolParams,
  sanitizeErrorText,
  reduceUrlsInText,
  isSensitive,
  collapseForReduction,
  boundedForReduction,
  REDUCE_INPUT_MAX,
  RAW_INPUT_MAX,
  fmtDuration,
  stepLine,
  cardSupports,
} from "./card-render.js";
import { countCardNodes } from "./card-limits.js";

function elementText(e: Record<string, unknown>): string {
  if (typeof e.text === "string") return e.text;
  if (Array.isArray(e.inlines)) return e.inlines.map((i) => (i as { text?: string }).text ?? "").join("");
  if (Array.isArray(e.items)) return e.items.map((item) => elementText(item as Record<string, unknown>)).join("\n");
  if (Array.isArray(e.columns)) {
    return e.columns
      .flatMap((c) => ((c as { items?: unknown[] }).items ?? []) as Record<string, unknown>[])
      .map(elementText)
      .join("\n");
  }
  return "";
}

function progressHeaderText(card: Record<string, unknown>): string {
  const body = card.body as Array<Record<string, unknown>>;
  return elementText(body[0]);
}

function progressDetailItems(card: Record<string, unknown>): Array<Record<string, unknown>> {
  const body = card.body as Array<Record<string, unknown>>;
  return ((body[1] as { items?: Array<Record<string, unknown>> })?.items ?? []);
}

function progressDetailText(card: Record<string, unknown>): string {
  return progressDetailItems(card).map(elementText).join("\n");
}

const ERROR_REDACTION_CASES = [
  {
    name: "standard base64",
    value: "driver failed: " + "AbCdEf012345678901234567890" + "+ghIjKl/mnOpQr==",
    hidden: "AbCdEf012345678901234567890+ghIjKl/mnOpQr==",
  },
  {
    name: "unlabelled long hex",
    value: "driver failed: " + "0123456789abcdef0123" + "456789abcdef01234567",
    hidden: "0123456789abcdef0123456789abcdef01234567",
  },
  {
    name: "scheme glued to a word character",
    value: "conn_https://my-relay.example.com/h/aB3cD9xQ",
    hidden: "/h/aB3cD9xQ",
  },
  {
    name: "protocol-relative URL after an equals sign",
    value: "endpoint=//cdn.example.com/deliver/aB3cD9xQ",
    hidden: "/deliver/aB3cD9xQ",
  },
  {
    name: "schemeless host and path",
    value: "my-relay.example.com/h/aB3cD9xQ",
    hidden: "/h/aB3cD9xQ",
  },
  {
    name: "schemeless DSN with an at sign in the password",
    value: "admin:p@ss@db.example.com:5432/app",
    hidden: "admin:p@ss",
  },
] as const;

describe("resolveToolMeta", () => {
  it("已知工具 → 专属图标 + 原始 toolName", () => {
    expect(resolveToolMeta("read")).toEqual({ icon: "📖", label: "read" });
    expect(resolveToolMeta("exec")).toEqual({ icon: "⌨️", label: "exec" });
    expect(resolveToolMeta("process")).toEqual({ icon: "⚙️", label: "process" });
  });
  it("OpenClaw update_plan → 专属地图图标 + 原始 toolName", () => {
    expect(resolveToolMeta("update_plan")).toEqual({ icon: "🗺️", label: "update_plan" });
    const { card } = renderProgressCard({
      phase: "tool",
      steps: [{ tool: "update_plan", status: "done", durationMs: 29 }],
    });
    expect(progressDetailText(card)).toContain("🗺️ update_plan");
    expect(progressDetailText(card)).not.toContain("🔧 update_plan");
  });
  it("MCP 工具保留原始 toolName", () => {
    expect(resolveToolMeta("mcp__github__create_issue")).toEqual({
      icon: "🔌",
      label: "mcp__github__create_issue",
    });
  });
  it("未知工具 → 通用图标 + 原名", () => {
    expect(resolveToolMeta("weirdtool")).toEqual({ icon: "🔧", label: "weirdtool" });
  });
  it("host 内建工具名 find 保留原名,且仍走 path 摘要策略", () => {
    expect(resolveToolMeta("find")).toEqual({ icon: "🔍", label: "find" });
    expect(summarizeToolParams("find", { path: "/work/src/card-render.ts" })).toBe("/work/src/card-render.ts");
  });
});

describe("summarizeToolParams", () => {
  it("文件类工具取 path", () => {
    expect(summarizeToolParams("read", { path: "/work/README.md" })).toBe("/work/README.md");
    expect(summarizeToolParams("edit", { file_path: "/a/b.ts", offset: 0 })).toBe("/a/b.ts");
  });

  it("path 智能压缩:深路径保留末 2 段 + 前缀省略号,末段(文件名)必须完整", () => {
    // 典型痛点:/root/.openclaw/workspace/octo-server/modules/bot_api/send.go
    expect(summarizeToolParams("read", { path: "/root/.openclaw/workspace/octo-server/modules/bot_api/send.go" }))
      .toBe("…/bot_api/send.go");
    expect(summarizeToolParams("read", { path: "/Users/fangling/conductor/workspaces/kyoto/src/card-render.ts" }))
      .toBe("…/src/card-render.ts");
    // 3 段以内不压缩(信息本来就少)
    expect(summarizeToolParams("read", { path: "/work/README.md" })).toBe("/work/README.md");
    expect(summarizeToolParams("read", { path: "docs/card-protocol.md" })).toBe("docs/card-protocol.md");
    expect(summarizeToolParams("read", { path: "a/b/c" })).toBe("a/b/c");
    // 首段是家目录/根也一视同仁(不做特殊 `~` 标记,保持简单)
    expect(summarizeToolParams("ls", { path: "/root/.openclaw/workspace/octo-server/docs" }))
      .toBe("…/octo-server/docs");
    // 无扩展名的深目录同规则
    expect(summarizeToolParams("glob", { path: "a/b/c/d/e" })).toBe("…/d/e");
  });
  it("shell 类只取程序名,不渲染完整命令(避免参数泄露)", () => {
    expect(summarizeToolParams("exec", { command: "git commit -m x" })).toBe("git");
    expect(summarizeToolParams("bash", { command: "curl -H 'Authorization: Bearer sk-xxx' https://x" })).toBe("curl");
  });
  it("shell 跳过前缀式环境变量赋值(VAR=secret cmd),不泄露密钥值", () => {
    expect(summarizeToolParams("exec", { command: "SLACK_WEBHOOK=https://hooks.slack.com/services/T/B/X curl -X POST" })).toBe("curl");
    expect(summarizeToolParams("bash", { command: "MY_CREDS=abc123 DEPLOY_KEY=xyz ./deploy.sh" })).toBe("./deploy.sh");
  });
  it("shell 带引号的多词赋值值先折叠,程序名不会落在值的中间那个词上", () => {
    // 不折叠时空白分词会把值切碎,跳过首个片段后落在**第二个**词上 —— 而那个词往往不含异常
    // 字符、能通过 PROGRAM_TOKEN_RE。加折叠前实测:
    //   PASSPHRASE='correct horse battery staple' gpg --sign x  →  "horse"
    //   MY_CREDS='alpha hunter2 charlie' ./go                   →  "hunter2"
    //   DEPLOY_KEY="one s3cr3tvalue two" ./deploy.sh            →  "s3cr3tvalue"
    // 这些变量名恰好是 SECRET_RE 没有的,关键词守卫救不回来。
    expect(summarizeToolParams("exec", { command: "PASSPHRASE='correct horse battery staple' gpg --sign x" }))
      .toBe("gpg");
    expect(summarizeToolParams("bash", { command: "MY_CREDS='alpha hunter2 charlie' ./go" })).toBe("./go");
    expect(summarizeToolParams("exec", { command: 'DEPLOY_KEY="one s3cr3tvalue two" ./deploy.sh' }))
      .toBe("./deploy.sh");
    // 两个词的值原本靠「片段带引号」侥幸挡住,折叠后走的是正路。
    expect(summarizeToolParams("exec", { command: 'TOKEN="a b" node app.js' })).toBe("node");
    // 值里带转义引号,不能在转义处提前收尾。
    expect(summarizeToolParams("exec", { command: 'PASSPHRASE="alpha\\" hunter2 x" gpg' })).toBe("gpg");
    // 拼接词:引号出现在值的中间偏移处也要覆盖(shell 里 `a"b"c` 是一个词)。
    expect(summarizeToolParams("exec", { command: "MY_CREDS=$'alpha hunter2 x' ./go" })).toBe("./go");
    // 合法程序名/路径不受影响。
    expect(summarizeToolParams("exec", { command: "/usr/bin/python3 x.py" })).toBe("/usr/bin/python3");
  });
  it("query/shell 策略也降级内嵌 URL(与 url/error 路径对称,单一 choke point)", () => {
    // query 里的 webhook URL:路径段短、无关键词 → isSensitive 抓不到,靠 URL 降级。
    expect(summarizeToolParams("web_search", { query: "https://hooks.slack.com/services/T00/B00/abcdEFGH1234abcdEFGH1234" })).toBe(
      "https://slack.com",
    );
    // query 里的 userinfo / PII query / 内网主机 —— 非密钥形状,但仍不该原样泄露。
    expect(summarizeToolParams("grep", { pattern: "https://user:pw@example.com/x" })).toBe("https://example.com");
    expect(summarizeToolParams("grep", { pattern: "https://example.com/reset?email=ceo@corp.com" })).toBe("https://example.com");
    // shell:URL 作为程序名(argv[0])→ 降级为注册域,不原样渲染。
    expect(summarizeToolParams("exec", { command: "https://hooks.slack.com/services/T1/B2/tok arg" })).toBe("https://slack.com");
    // 常规 query 不受影响。
    expect(summarizeToolParams("grep", { pattern: "TODO fix later" })).toBe("TODO fix later");
  });
  it("非 http scheme 的凭据 URI 也降级(postgres/mysql/redis/ssh…),明文密码不泄露", () => {
    // query 里的 DB DSN:密码短、无关键词 → isSensitive 抓不到,靠 URL 降级丢掉 userinfo。
    expect(summarizeToolParams("web_search", { query: "postgres://admin:s3cr3t@db.internal:5432/app" })).toBe("postgres://db.internal");
    // shell:DSN 作为程序名(argv[0])。
    expect(summarizeToolParams("bash", { command: "mysql://root:hunter2@10.0.0.5:3306/prod" })).toBe("mysql://10.0.0.5");
    // 其它 scheme。
    expect(summarizeToolParams("grep", { pattern: "redis://:pw@cache.internal:6379/0" })).toBe("redis://cache.internal");
    expect(summarizeToolParams("grep", { pattern: "ssh://deploy:key@bastion.example.com" })).toBe("ssh://example.com");
    // 不误伤 Windows 盘符路径(无 ://)。
    expect(summarizeToolParams("read", { path: "C:/Users/me/app.ts" })).toBe("…/me/app.ts");
  });
  // 注:shell 策略在默认档只渲染程序名,所以只有 DSN **本身就是 argv[0]** 时才会经由 shell
  // 泄漏;path/query 策略则原样返回整个值,是这一类的主要 sink。下面按各自的真实 sink 取样。
  it("url 类只保留 scheme://注册域,丢弃 path/query/userinfo 与所有子域", () => {
    expect(summarizeToolParams("fetch", { url: "https://u:p@host.com/a/b?token=sk-secret&x=1" })).toBe(
      "https://host.com",
    );
    // Slack webhook 密钥整段在 path 里 —— 连 path 与子域一起丢。
    expect(summarizeToolParams("fetch", { url: "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXX" })).toBe(
      "https://slack.com",
    );
    // 隧道/预签名:主机名本身即密钥(随机子域)→ 只留注册域,子域丢弃。
    expect(summarizeToolParams("fetch", { url: "https://s3cr3ttok.abc1234.ngrok.io/hook" })).toBe(
      "https://ngrok.io",
    );
    // 多段有效后缀多保留一段。
    expect(summarizeToolParams("fetch", { url: "https://x.example.com.cn/p" })).toBe("https://example.com.cn");
    expect(summarizeToolParams("fetch", { url: "not a url" })).toBe("");
  });

  it("归约后残留的 schemeless name:secret@ token 一律 fail closed", () => {
    const residual = [
      "用户:hunter2Kx@host.example",
      "а:hunter2Kx@host.example",
      "u:hunter2Kx@[fe80::1%eth0]",
      "u:hunter2Kx@",
      '"user":hunter2Kx@db.example.com',
      "[postgres]:hunter2Kx@db.example.com",
    ];
    for (const input of residual) {
      expect(reduceUrlsInText(input), input).toBe("");
      expect(summarizeToolParams("read", { file_path: input }), input).toBe("");
      expect(sanitizeErrorText(input), input).toBe("");
    }

    // 已识别的 DSN 仍走原来的安全归约,default-deny 只处理 pass 之后的 residue。
    expect(reduceUrlsInText("user:hunter2Kx@db.example.com")).toBe("https://example.com");
  });
  it("检索类取 query/pattern", () => {
    expect(summarizeToolParams("grep", { pattern: "TODO", path: "/x" })).toBe("TODO");
    expect(summarizeToolParams("web_search", { query: "how to" })).toBe("how to");
  });
  it("形状脱敏:query/pattern 里的裸密钥(无关键词)也隐藏", () => {
    expect(summarizeToolParams("grep", { pattern: "AKIAIOSFODNN7EXAMPLE" })).toBe(""); // AWS key id
    expect(summarizeToolParams("web_search", { query: "d41d8cd98f00b204e9800998ecf8427e" })).toBe(""); // 32 hex
    expect(summarizeToolParams("grep", { pattern: "ghp_16C7e42F292c6912E7710c838347Ae178B4a" })).toBe(""); // GitHub token — gitleaks:allow (fake fixture)
    expect(summarizeToolParams("web_search", { query: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456" })).toBe(""); // JWT — gitleaks:allow (fake fixture)
    // 混合字母数字的 40+ 位随机串。
    expect(summarizeToolParams("grep", { pattern: "aB3dE7gH1jK4mN8pQ2rS5tU9vW6xY0zA1bC2dE3f" })).toBe("");
    // 正常长英文 / 纯字母长串不误伤。
    expect(summarizeToolParams("web_search", { query: "how to configure oauth flow correctly" })).toBe("how to configure oauth flow correctly");
  });
  // 这里原来有两条计时断言,已删除,由 card-render.corpus.test.ts 的 PERF 组接管。
  //
  // 删而不是修,是因为它们已经**在断言另一件事而不自知**。它们只用三个不含空白的形状
  // (`"a"×100000+"?x"`、`"http://"+"a"×120000`、`"a:b@"+"a"×60000`),而空白边界截断落地后,
  // 这三个都在长度判定处被拒,一趟正则都不跑 —— 十五个格子全部 0.005 ms。它们自己的注释写着
  // 存在理由是「测调用方测不出上限放错了地方,测管线本身才行」,而那个性质已经不是它们测的了:
  // 现在测的是「长度守卫存在」,测了两遍。预算还停在 2000 ms,R4a 那个三次方(4000 字符约
  // 1.7 秒)会绿着通过。
  //
  // 留着两套计时断言,本身就是这条分支反复犯的那个错:**第二张表该跟着第一张改而没有跟**。
  // PERF 组同时覆盖 reduceUrlsInText / sanitizeErrorText / summarizeToolParams 的三个策略
  // (与删掉这两条的入口完全相同),含这三个形状,并且每行标注 reachesPasses、标注本身被断言。

  // 切点搜索的边界形态。这几条此前一条都没有,而它们正是改动切法时最先坏掉的一批。
  // 「空白正好在下标 4000」曾经是错的:搜索范围取 REDUCE_INPUT_MAX 而不是 +1,前 4000 字符
  // 明明已经是一个完整的、token 边界对齐的前缀,却连同整串一起被拒。
  it("空白边界截断:切点搜索的边界形态", () => {
    // 填充字符全部用非十六进制的 `z`/`y`。用 `a`/`b` 会踩到 LONG_HEX_RE —— 被丢掉的那一段现在
    // 要过一遍守卫,而 `"b"×100` 是一个 100 字符的十六进制串,于是测的就不是切点而是守卫了。
    const CASES: Array<[string, string, number]> = [
      ["空白正好在下标 4000", "z".repeat(4000) + " " + "y".repeat(100), 4000],
      ["空白在下标 3999", "z".repeat(3999) + " " + "y".repeat(100), 3999],
      ["长度正好 4000、无空白", "z".repeat(4000), 4000],
      ["长度 4001、无空白", "z".repeat(4001), 0],
      ["空白只在下标 0", " " + "z".repeat(4100), 0],
      ["全是空白", " ".repeat(5000), 4000],
    ];
    for (const [label, input, wantLen] of CASES) {
      expect(reduceUrlsInText(input).length, label).toBe(wantLen);
    }
    // 返回值长度恒 ≤ 上限 —— 多取的那一个字符只用于**发现**切点,不能进入结果。
    for (const [, input] of CASES) expect(reduceUrlsInText(input).length).toBeLessThanOrEqual(4000);
    // 代理对不会被从中间切开。切在空白上时这一条由构造成立,但它是切法改动时最容易回归的一项。
    const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const input of [
      "z".repeat(3998) + "\u{1F600}".repeat(60), // 切口落在代理对中间
      "z".repeat(3990) + " " + "\u{1F600}".repeat(60), // 切口前有空白,emoji 整段落在保留段外
    ]) {
      expect(LONE.test(reduceUrlsInText(input)), `${JSON.stringify(input.slice(0, 12))}… 输出里出现孤立代理`).toBe(false);
    }
  });
  // 界丢掉的那一段用**哪一个**谓词判定,是可观察的 —— 但上一版三处接线里有两处删掉之后
  // 整个 1838 条的套件依然全绿(子代理评审跑变异发现的)。下面三条各钉一处接线。
  it("界丢掉的那一段:三处谓词接线各自可观察", () => {
    const PAD = "word ".repeat(900);
    // 1) 缺省谓词必须是**最严**的一档:尾巴只有高熵、没有关键词也没有明确前缀。
    //    写成 isSensitive(s, false) 时这一条会渲染出来。
    expect(reduceUrlsInText(PAD + "aB3dE7gH1jK4mN8pQ2rS5tU9vW6xY0zA")).toBe("");
    expect(reduceUrlsInText(PAD + "just more ordinary words here")).not.toBe("");
    // 2) sanitizeErrorText 必须传自己那道(带构建哈希豁免的)判定。不传就退回缺省的最严档,
    //    而缺省档不认 `commit:` 豁免 → 一条标注过的构建哈希把整条错误打空。
    const withHash = PAD + "commit: 2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c";
    expect(sanitizeErrorText(withHash), "错误文本没把自己的豁免传进界里").not.toBe("");
    // 3) query/url 策略是 generic=true、path/shell 是 false —— 同一个尾部 git SHA,
    //    grep 扣下、read 渲染。任一侧接错线,这里立刻分岔。
    const withSha = PAD + "2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c";
    expect(summarizeToolParams("grep", { pattern: withSha })).toBe("");
    expect(summarizeToolParams("read", { file_path: withSha })).not.toBe("");
  });

  it("前缀式密钥被前置词字符粘连也隐藏(去词界锚点;两类 sink 都覆盖)", () => {
    // 回归 yujiawei P1:`\b` 词界锚点会被"前面粘一个词字符"绕过 → 明文密钥泄露。
    // query 策略(generic=true):
    expect(summarizeToolParams("grep", { pattern: "xAKIA1234567890ABCDEF" })).toBe("");
    expect(summarizeToolParams("grep", { pattern: "9sk-ABCDEFGHIJKLMNOP1234" })).toBe("");     // 数字前缀
    expect(summarizeToolParams("web_search", { query: "a_glpat-ABCDEFGHIJ1234567890" })).toBe(""); // 下划线前缀 — gitleaks:allow (fake fixture)
    // path/shell 策略(generic=false,无高熵兜底)—— 更关键,靠前缀命中:
    expect(summarizeToolParams("read", { path: "tokenAKIAIOSFODNN7EXAMPLE" })).toBe("");
    expect(summarizeToolParams("read", { path: "keyghp_ABCDEFGHIJ1234567890XY" })).toBe("");
    expect(summarizeToolParams("exec", { command: "Xsk-ABCDEFGHIJKLMNOP1234" })).toBe("");
    // 但连字符英文不被长度下限误伤:
    expect(summarizeToolParams("grep", { pattern: "risk-averse task-force" })).toBe("risk-averse task-force");
  });
  it("path 只走关键词+明确前缀:常见 git/docker/缓存哈希路径不被误伤成空", () => {
    // 通用高熵/长 hex 检测**不**套用到 path —— 否则日常路径会频繁 blank。
    // git object 深路径 → 压缩到末 2 段;关键是 SHA(长 hex)在末段完整保留,且不被 secret 形状误伤。
    expect(summarizeToolParams("read", { path: "/repo/.git/objects/1a/2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c" })).toBe(
      "…/1a/2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c",
    );
    expect(summarizeToolParams("edit", { file_path: ".cache/webpack/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6" })).toBe(
      ".cache/webpack/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    );
    // 但明确前缀式密钥(AKIA/sk-/gh_)即使出现在路径里仍隐藏。
    expect(summarizeToolParams("read", { path: "/tmp/AKIAIOSFODNN7EXAMPLE.pem" })).toBe("");
  });
  it("MCP / 未知工具 → 不显示摘要(不渲染任意参数)", () => {
    expect(summarizeToolParams("mcp__github__create_issue", { title: "leak", body: "secret" })).toBe("");
    expect(summarizeToolParams("weirdtool", { foo: "bar" })).toBe("");
  });
  it("命中敏感串守卫 → 整串隐藏", () => {
    expect(summarizeToolParams("read", { path: "/etc/my-api-key.txt" })).toBe("");
    expect(summarizeToolParams("grep", { pattern: "password=hunter2" })).toBe("");
  });
  it("非法输入 → 空串", () => {
    expect(summarizeToolParams("read", undefined)).toBe("");
    expect(summarizeToolParams(undefined, { path: "/a" })).toBe("");
    expect(summarizeToolParams("read", "x")).toBe("");
  });
  it("超长截断 + 折叠空白", () => {
    const long = "/a/" + "x".repeat(80);
    const out = summarizeToolParams("read", { path: long });
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(65);
    expect(summarizeToolParams("read", { path: "/a\n  b\tc" })).toBe("/a b c");
  });
});

describe("fmtDuration", () => {
  it("<1s 用 ms", () => expect(fmtDuration(200)).toBe("200ms"));
  it("1s..60s 用 x.xs", () => expect(fmtDuration(10165)).toBe("10.2s"));
  it(">=60s 使用紧凑分钟格式", () => expect(fmtDuration(1_750_300)).toBe("29m 10s"));
  it(">=1h 使用紧凑小时格式", () => expect(fmtDuration(3_723_000)).toBe("1h 2m 3s"));
  it("undefined → 空", () => expect(fmtDuration(undefined)).toBe(""));
  it("非有限值 → 空(不渲出 Infinityh NaNm NaNs)", () => {
    expect(fmtDuration(Number.NaN)).toBe("");
    expect(fmtDuration(Number.POSITIVE_INFINITY)).toBe("");
  });
  it("负数 → 空(时钟回拨不渲出 -5000ms)", () => expect(fmtDuration(-5000)).toBe(""));
  it("秒/分边界按取整后的值选单位(不渲出 60.0s)", () => {
    expect(fmtDuration(59_499)).toBe("59.5s");
    expect(fmtDuration(59_950)).toBe("1m 0s");
    expect(fmtDuration(59_999)).toBe("1m 0s");
    expect(fmtDuration(60_000)).toBe("1m 0s");
  });
});

describe("sanitizeErrorText adversarial boundaries", () => {
  it.each(ERROR_REDACTION_CASES)("redacts $name at the helper boundary", ({ value, hidden }) => {
    expect(sanitizeErrorText(value)).not.toContain(hidden);
  });

  it.each(ERROR_REDACTION_CASES)("keeps $name out of progress-card JSON and plain", ({ value, hidden }) => {
    const { card, plain } = renderProgressCard({
      phase: "error",
      errorText: value,
      steps: [{ tool: "exec", status: "error", error: value }],
    });
    expect(JSON.stringify(card)).not.toContain(hidden);
    expect(plain).not.toContain(hidden);
  });
});

describe("stepLine", () => {
  it("running:⏳ + 标签 + 摘要", () =>
    expect(stepLine({ tool: "exec", status: "running", summary: "ls -la" })).toBe("⏳ exec: ls -la"));
  it("done:图标 + 标签 + 摘要 + 耗时", () =>
    expect(stepLine({ tool: "exec", status: "done", summary: "ls -la", durationMs: 10165 })).toBe(
      "⌨️ exec: ls -la · 10.2s",
    ));
  it("done 无摘要", () =>
    expect(stepLine({ tool: "read", status: "done", durationMs: 200 })).toBe("📖 read · 200ms"));
  it("error", () =>
    expect(stepLine({ tool: "bash", status: "error", summary: "rm x", error: "boom" })).toBe(
      "❌ bash: rm x — boom",
    ));
  it("error 详情脱敏:命中敏感串则只留状态、不渲染原始错误", () => {
    // 含 token 关键词
    expect(stepLine({ tool: "bash", status: "error", error: "auth failed: Bearer sk-live-abc" })).toBe("❌ bash");
    // 裸 sk- 前缀长 token(不在 URL 里)→ 整行隐藏
    expect(stepLine({ tool: "bash", status: "error", error: "token sk-live-ABC123XYZ456def789ghi rejected" })).toBe("❌ bash");
    // AKIA 出现在错误里
    expect(stepLine({ tool: "exec", status: "error", error: "invalid key AKIAIOSFODNN7EXAMPLE" })).toBe("❌ exec");
  });
  it("error 详情超长截断,折叠空白", () => {
    const long = "line1\n" + "z".repeat(200); // 非 hex、无数字 → 不算密钥,仅超长
    const out = stepLine({ tool: "read", status: "error", error: long });
    expect(out.startsWith("❌ read — line1 ")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThan(140); // 图标+标签 + 120 上限 + 省略号
  });
  it("error 含 git SHA / digest / UUID 不被整段吞掉(不套用长 hex/高熵)", () => {
    // webhook 由 URL 降级兜住,故错误文本不套用长 hex/高熵形状 → 普通运维错误不被 blank。
    expect(stepLine({ tool: "read", status: "error", error: "build failed at commit 5f2a1c9d8e7b6a5f4c3d2e1f0a9b8c7d6e5f4a3b" })).toBe(
      "❌ read — build failed at commit 5f2a1c9d8e7b6a5f4c3d2e1f0a9b8c7d6e5f4a3b",
    );
    // 但明确关键词/前缀仍拦。
    expect(stepLine({ tool: "read", status: "error", error: "AKIAIOSFODNN7EXAMPLE rejected" })).toBe("❌ read");
  });
  it("P2-1: 工具名 label 过长截断 / 敏感形状回退通用标签", () => {
    // 超长 MCP 工具名 → 截断,防卡片被 label 撑爆。
    const longName = "mcp__" + "z".repeat(60) + "__tool"; // 非 hex、无数字 → 只超长,不算密钥形状
    const out = stepLine({ tool: longName, status: "running" });
    expect(out.length).toBeLessThan(60);
    expect(out.endsWith("…")).toBe(true);
    // 未知工具名命中敏感关键词 → 回退通用「工具」(不把疑似密钥的标识符渲进群卡片)。
    expect(stepLine({ tool: "fetch_api_key_helper", status: "running" })).toBe("⏳ Tool");
    // 按段扫描放宽了整串熵检测,所以必须锁住「什么仍然被抓住」:已知前缀落在任一段里 → 仍打码。
    expect(stepLine({ tool: "mcp__github__ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", status: "running" }))
      .toBe("⏳ Tool");
    expect(stepLine({ tool: "mcp__aws__AKIAIOSFODNN7EXAMPLE", status: "running" })).toBe("⏳ Tool");
    // 关键词同理(段内命中即整个 label 回退)。
    expect(stepLine({ tool: "mcp__vault__read_secret", status: "running" })).toBe("⏳ Tool");
    // label 也过 URL 降级(与 params/error sink 一致):工具名里嵌 webhook/DSN → 只留注册域。
    const urlName = stepLine({ tool: "https://hooks.slack.com/services/T00/B00/SeCrEtXyZ", status: "running" });
    expect(urlName).toContain("https://slack.com");
    expect(urlName).not.toContain("/services/");
    expect(urlName).not.toContain("SeCrEtXyZ");
  });
  it("error 内嵌 URL 降级为注册域(对称参数路径),webhook 路径/隧道主机不泄露", () => {
    // 短、无关键词的 webhook 路径段:isSensitive 抓不到,靠 URL 降级丢掉。
    const slack = stepLine({ tool: "bash", status: "error", error: "curl: (22) https://hooks.slack.com/services/T01ABCDEF/B02GHIJKL/Xy8zQw3rT7uVwXyZ0 returned 404" });
    expect(slack).toContain("https://slack.com");
    expect(slack).not.toContain("services");
    expect(slack).not.toContain("Xy8zQw3rT7uVwXyZ0");
    // Discord webhook。
    const discord = stepLine({ tool: "bash", status: "error", error: "POST https://discord.com/api/webhooks/123456789012345678/aBcDeFgHiJkLmNoPqRsTuVwX failed" });
    expect(discord).toContain("https://discord.com");
    expect(discord).not.toContain("webhooks");
    // 内网主机 + 短 opaque token(16 hex,<32 → 形状抓不到),靠降级丢子域+path。
    const internal = stepLine({ tool: "exec", status: "error", error: "failed to POST https://mytenant.internal.corp:8443/webhook/9f8e7d6c5b4a3210 — 500" });
    expect(internal).toContain("https://internal.corp");
    expect(internal).not.toContain("mytenant");
    expect(internal).not.toContain("9f8e7d6c5b4a3210");
    // 预签名 URL 的签名在 query,降级后连同子域一起丢。
    const s3 = stepLine({ tool: "bash", status: "error", error: "fetch https://mybucket.s3.amazonaws.com/f?X-Amz-Signature=deadbeefcafe returned 403" });
    expect(s3).toContain("https://amazonaws.com");
    expect(s3).not.toContain("mybucket");
    expect(s3).not.toContain("Signature");
    // 最可达:DB 驱动连接错误回显完整 DSN(非 http scheme)→ 明文密码不泄露。
    const dsn = stepLine({ tool: "exec", status: "error", error: "connect ECONNREFUSED postgres://svc:Hunter2Pw@10.0.0.5:5432/prod" });
    expect(dsn).toContain("postgres://10.0.0.5");
    expect(dsn).not.toContain("Hunter2Pw");
    expect(dsn).not.toContain("svc:");
  });
});

describe("renderProgressCard", () => {
  it("builds one terminal card with a collapsed progress panel and the final text below it", () => {
    const result = renderProgressResponseCard(
      {
        phase: "done",
        elapsedMs: 12_000,
        steps: [
          { tool: "__thinking__", status: "done", durationMs: 4_000 },
          { tool: "read", status: "done", summary: "渠道 B 周报", durationMs: 300 },
        ],
      },
      "结论\n\n渠道 B 的下降主要来自权益认知不足。",
      {
        elements: new Set(["TextBlock", "RichTextBlock", "Container", "ColumnSet", "ActionSet"]),
        actions: new Set(["Action.ToggleVisibility"]),
      },
    );

    expect(result).not.toBeNull();
    expect(result!.card).not.toHaveProperty("metadata");
    const body = result!.card.body as Array<Record<string, unknown>>;
    expect(body[0]).toMatchObject({ type: "Container", style: "emphasis" });
    expect(elementText(body[0])).toContain("✅ Done");
    expect(elementText(body[1])).toContain("渠道 B 的下降主要来自权益认知不足");
    expect(result!.plain).toBe("结论\n\n渠道 B 的下降主要来自权益认知不足。");
  });

  it("declines the merge when the combined card exceeds negotiated payload limits", () => {
    const result = renderProgressResponseCard(
      { phase: "done", elapsedMs: 100, steps: [{ tool: "read", status: "done" }] },
      "很长的最终回答".repeat(100),
      { maxPayloadBytes: 256 },
    );

    expect(result).toBeNull();
  });

  it("marks agent progress cards with root metadata layout", () => {
    const { card } = renderProgressCard({ phase: "thinking", steps: [] });
    expect(card.metadata).toEqual({ octo_layout: OCTO_CARD_LAYOUTS.agentProgressV1 });
    expect(detectOctoCardLayout(card)).toBe(OCTO_CARD_LAYOUTS.agentProgressV1);
    expect(detectOctoCardLayout({ ...card, metadata: { octo_layout: "agent_progress_v2" } })).toBeUndefined();
  });

  it("agent_progress_v1 uses root ColumnSet + timeline_detail structure and keeps status style inside steps", () => {
    const caps = {
      elements: new Set(["TextBlock", "RichTextBlock", "Container", "ColumnSet", "ActionSet"]),
      actions: new Set(["Action.ToggleVisibility"]),
    };
    const { card } = renderProgressCard(
      {
        phase: "error",
        elapsedMs: 3200,
        errorText: "命令失败",
        steps: [
          { tool: "__thinking__", status: "done", durationMs: 3000 },
          { tool: "exec", status: "error", summary: "npm test", error: "exit 1" },
        ],
      },
      caps,
    );

    const body = card.body as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    expect(body[0].type).toBe("ColumnSet");
    expect(body[1]).toMatchObject({
      type: "Container",
      id: "timeline_detail",
      isVisible: false,
    });
    expect(body[1]).not.toHaveProperty("style");
    const detail = body[1] as { items: Array<Record<string, unknown>> };
    expect(detail.items.some((item) => item.type === "Container" && item.style === "attention")).toBe(true);
  });

  it("thinking 骨架", () => {
    const { card, plain } = renderProgressCard({ phase: "thinking", steps: [] });
    expect(card.type).toBe("AdaptiveCard");
    expect(card.version).toBe("1.5");
    expect(progressHeaderText(card)).toBe("🤖 Thinking…");
    expect(progressDetailItems(card)).toHaveLength(0);
    expect(plain).toBe("🤖 Thinking…");
  });

  it("tool 阶段带摘要步骤", () => {
    const { card } = renderProgressCard({
      phase: "tool",
      steps: [{ tool: "read", status: "done", summary: "/work/README.md", durationMs: 200 }],
    });
    expect(progressHeaderText(card)).toContain("🤖 Working…");
    expect(progressDetailText(card)).toBe("📖 read: /work/README.md · 200ms");
  });

  it("同类合并:连续 3 个 read done → 1 行 「读取文件 × 3」,含总耗时和最近文件名", () => {
    const { card, plain } = renderProgressCard({
      phase: "tool",
      steps: [
        { tool: "read", status: "done", summary: "/a/b.md", durationMs: 100 },
        { tool: "read", status: "done", summary: "/c/d.md", durationMs: 150 },
        { tool: "read", status: "done", summary: "/e/f.md", durationMs: 200 },
      ],
    });
    const detail = progressDetailItems(card);
    expect(detail.length).toBe(1);
    expect(elementText(detail[0])).toContain("read × 3");
    expect(elementText(detail[0])).toContain("450ms"); // 累加耗时
    expect(elementText(detail[0])).toContain("/e/f.md"); // 最近 = 最后一个
    expect(plain).toContain("read × 3");
  });

  it("同类合并:running/error 不合并 —— 当前重点不能糊掉", () => {
    const { card } = renderProgressCard({
      phase: "tool",
      steps: [
        { tool: "read", status: "done", summary: "/a.md", durationMs: 30 },
        { tool: "read", status: "done", summary: "/b.md", durationMs: 40 },
        { tool: "read", status: "error", summary: "/c.md", error: "EISDIR" }, // 中间 error
        { tool: "read", status: "done", summary: "/d.md", durationMs: 50 },
        { tool: "read", status: "running", summary: "/e.md" }, // 末尾 running
      ],
    });
    const detail = progressDetailItems(card);
    // 期望:合并组[a,b done] + error 单独 + done 单独 + running 单独 = 4 行
    expect(detail.length).toBe(4);
    expect(elementText(detail[0])).toContain("read × 2"); // 前两个合并
    expect(elementText(detail[1])).toContain("❌"); // error 保留
    expect(elementText(detail[2])).toContain("/d.md"); // 单个 done 不合并
    expect(elementText(detail[3])).toContain("⏳"); // running 保留
  });

  it("同类合并:跨 tool 边界不合并(read+exec+read 不能合成一组)", () => {
    const { card } = renderProgressCard({
      phase: "tool",
      steps: [
        { tool: "read", status: "done", summary: "/a", durationMs: 30 },
        { tool: "read", status: "done", summary: "/b", durationMs: 30 },
        { tool: "exec", status: "done", summary: "ls", durationMs: 100 },
        { tool: "read", status: "done", summary: "/c", durationMs: 30 },
        { tool: "read", status: "done", summary: "/d", durationMs: 30 },
      ],
    });
    const detail = progressDetailItems(card);
    // [read×2] + [exec 单个] + [read×2] = 3 行
    expect(detail.length).toBe(3);
    expect(elementText(detail[0])).toContain("read × 2");
    expect(elementText(detail[1])).toContain("exec");
    expect(elementText(detail[2])).toContain("read × 2");
  });

  it("同类合并:done 收尾 header 计数仍用原始步数(合并不影响 N 步展示)", () => {
    const steps = [
      { tool: "read" as const, status: "done" as const, durationMs: 30 },
      { tool: "read" as const, status: "done" as const, durationMs: 30 },
      { tool: "read" as const, status: "done" as const, durationMs: 30 },
    ];
    const { card } = renderProgressCard({ phase: "done", steps, elapsedMs: 100 });
    expect(progressHeaderText(card)).toContain("✅ Done · 3 steps · 100ms"); // 用户看到"3 steps",不是"1 group"
  });

  it("done 收尾:步数 + 耗时", () => {
    const { card } = renderProgressCard({
      phase: "done",
      steps: [{ tool: "read", status: "done" }],
      elapsedMs: 2500,
    });
    expect(progressHeaderText(card)).toContain("✅ Done · 1 step · 2.5s");
  });

  it("yield 暂停与恢复使用短状态文案", () => {
    const paused = renderProgressCard({ phase: "paused", steps: [] });
    const resuming = renderProgressCard({ phase: "resuming", steps: [] });
    const expired = renderProgressCard({ phase: "expired", steps: [] });

    expect(progressHeaderText(paused.card)).toBe("⏸️ Waiting for results");
    expect(progressHeaderText(resuming.card)).toBe("🤖 Preparing results");
    expect(progressHeaderText(expired.card)).toBe("⏱️ Wait timed out");
  });

  it("error 收尾", () => {
    const { card } = renderProgressCard({ phase: "error", steps: [], errorText: "超时" });
    expect(progressHeaderText(card)).toContain("⚠️ Interrupted");
  });

  it("R2: 含 git SHA 的步骤行不被 buildDisplayCard 二次误删(进度卡内容视为可信)", () => {
    const { card, plain } = renderProgressCard({
      phase: "tool",
      steps: [{ tool: "read", status: "done", durationMs: 30, summary: "…/1a/2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e" }],
    });
    // 步骤行没有因 40-hex 高熵检测被删
    expect(progressDetailItems(card)).toHaveLength(1);
    expect(plain).toContain("2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e");
  });

  it("R2: 错误终态帧含 commit SHA 时不整卡清空", () => {
    const { card, plain } = renderProgressCard({
      phase: "error",
      steps: [],
      errorText: "build failed at commit 5f2a1c9d8e7b6a5f4c3d2e1f0a9b8c7d6e5f4a3b",
    });
    expect(progressHeaderText(card)).toContain("⚠️ Interrupted");
    expect(plain).not.toBe("[卡片]");
    expect(plain).toContain("5f2a1c9d");
  });

  it("plain never empty", () => {
    expect(renderProgressCard({ phase: "tool", steps: [] }).plain.length).toBeGreaterThan(0);
  });

  it("超服务端限制的截断提示与整卡同为英文(不中英混排)", () => {
    // maxPayloadBytes 收紧到只装得下首行 —— 走 buildDisplayCard 的丢块路径,而不是进度卡
    // 自己的 maxVisibleSteps 裁剪(那条已经是英文的 `… N earlier steps hidden`)。
    const steps = Array.from({ length: 12 }, (_, i) => ({
      tool: `tool_number_${i}`,
      status: "done" as const,
      durationMs: 1000 + i,
      summary: "y".repeat(100),
    }));
    const { plain } = renderProgressCard({ phase: "done", steps, elapsedMs: 120_000 }, { maxPayloadBytes: 900 });
    expect(plain).toContain("items dropped");
    expect(plain).not.toContain("省略");
  });

  it("步骤超上限 → 只渲染最近 N 步 + 折叠计数(防卡片膨胀)", () => {
    // 用交替 tool 避开同类合并 —— 这里要测的是「合并后仍超上限」的裁剪路径
    const steps = Array.from({ length: 20 }, (_, i) => ({
      tool: i % 2 === 0 ? "read" : "exec",
      status: "done" as const,
      summary: `/f${i}`,
      durationMs: 10,
    }));
    const { card } = renderProgressCard({ phase: "tool", steps });
    const detail = progressDetailItems(card);
    // 20 个 read/exec 交替 → 无合并;折叠行(1) + 最近 12 步 = 13 个 detail block
    expect(detail.length).toBe(13);
    expect(elementText(detail[0])).toBe("… 8 earlier steps hidden");
    // 最后一步是最新的 /f19
    expect(elementText(detail[detail.length - 1])).toContain("/f19");
    // 已折叠掉最早的 /f0
    // 锚到实际渲染形态 `📖 read: /f0 · 200ms`;旧写法用 "/f0:" —— 冒号在路径前面,
    // 这个子串永不出现,即使被折叠的步骤仍在渲染也会通过。
    expect(detail.every((b) => !elementText(b).includes(": /f0 "))).toBe(true);
  });

  it("窄屏 fallback 去掉重复标题/可见步数,并压缩长耗时", () => {
    const steps = [
      ...Array.from({ length: 67 }, () => ({ tool: "__thinking__", status: "done" as const, durationMs: 100 })),
      ...Array.from({ length: 84 }, () => ({ tool: "process", status: "done" as const, durationMs: 100 })),
    ];
    const { card, plain } = renderProgressCard({ phase: "done", steps, elapsedMs: 1_750_300 });

    expect(progressHeaderText(card)).toContain("✅ Done · 151 steps · 29m 10s");
    expect(plain).toContain("Reasoning 67 · Tools 84");
    expect(plain).toContain("… 139 earlier steps hidden");
    expect(plain).not.toContain("Reasoning and tool calls");
    expect(plain).not.toContain("12/151 steps");
  });

  it("done 收尾 header 计数用全量步数(不受裁剪影响)", () => {
    const steps = Array.from({ length: 20 }, () => ({ tool: "read", status: "done" as const }));
    const { card } = renderProgressCard({ phase: "done", steps, elapsedMs: 1000 });
    expect(progressHeaderText(card)).toContain("✅ Done · 20 steps · 1.0s");
  });
});

describe("cardSupports / CardCaps 渲染协商(波 C)", () => {
  it("cardSupports:明确 advertise 以其为准,否则用基线", () => {
    expect(cardSupports({ elements: new Set(["TextBlock"]) }, "TextBlock")).toBe(true);
    expect(cardSupports({ elements: new Set(["TextBlock"]) }, "ColumnSet")).toBe(false);
    expect(cardSupports(undefined, "ColumnSet")).toBe(true); // 基线含
    expect(cardSupports(undefined, "Input.Text")).toBe(false); // 基线不含输入
  });

  it("无 caps → 根结构固定,步骤在 timeline_detail 内按 TextBlock 降级", () => {
    const { card } = renderProgressCard({
      phase: "tool",
      steps: [{ tool: "read", status: "done", summary: "/a", durationMs: 200 }],
    });
    const body = card.body as Array<Record<string, unknown>>;
    expect(body.map((b) => b.type)).toEqual(["ColumnSet", "Container"]);
    expect(progressDetailItems(card)[0].type).toBe("TextBlock");
  });

  it("advertise RichTextBlock → 单步 label 使用灰色常规字重,plain 一行完整不分行", () => {
    // 优于 ColumnSet 列的原因:服务端 Finalize 权威重算 plain 时,ColumnSet 会把图标列/文本列
    // 各当一行,输出成"⌨️\n执行命令:ls · 200ms"两行(降级客户端视觉退化)。RichTextBlock 是单元素,
    // 内联多段样式,plain 输出干净一行。
    const caps = { elements: new Set(["TextBlock", "RichTextBlock", "Container", "ColumnSet"]) };
    const { card, plain } = renderProgressCard(
      { phase: "tool", steps: [{ tool: "exec", status: "done", summary: "ls", durationMs: 200 }] },
      caps,
    );
    const detailItem = progressDetailItems(card)[0];
    const row = detailItem.type === "Container"
      ? (detailItem.items as Array<Record<string, unknown>>)[0]
      : detailItem;
    expect(row.type).toBe("RichTextBlock");
    const inlines = row.inlines as Array<Record<string, unknown>>;
    // 至少有:图标段、label(subtle)段、summary/duration 段
    expect(inlines.length).toBeGreaterThanOrEqual(2);
    const label = inlines.find((i) => i.text === "exec");
    expect(label).toMatchObject({ text: "exec", isSubtle: true });
    expect(label).not.toHaveProperty("weight");
    expect(plain).toContain("⌨️ exec: ls · 200ms"); // plain 一行完整
    expect(plain).not.toContain("⌨️\nexec"); // 关键:不分行
  });

  it("advertise RichTextBlock → 合并步骤 label 使用灰色常规字重", () => {
    const caps = { elements: new Set(["TextBlock", "RichTextBlock", "Container", "ColumnSet"]) };
    const { card } = renderProgressCard(
      {
        phase: "tool",
        steps: [
          { tool: "exec", status: "done", durationMs: 100 },
          { tool: "exec", status: "done", durationMs: 200 },
        ],
      },
      caps,
    );
    const detailItem = progressDetailItems(card)[0];
    const row = detailItem.type === "Container"
      ? (detailItem.items as Array<Record<string, unknown>>)[0]
      : detailItem;
    const inlines = row.inlines as Array<Record<string, unknown>>;
    const label = inlines.find((inline) => inline.text === "exec");
    expect(label).toMatchObject({ text: "exec", isSubtle: true });
    expect(label).not.toHaveProperty("weight");
  });

  it("advertise Container+RichTextBlock → 进度步骤按 thinking 阶段收进 timeline 容器", () => {
    const caps = { elements: new Set(["TextBlock", "RichTextBlock", "Container", "ColumnSet"]) };
    const { card, plain } = renderProgressCard(
      {
        phase: "tool",
        steps: [
          { tool: "__thinking__", status: "done", durationMs: 3000 },
          { tool: "exec", status: "done", summary: "find", durationMs: 100 },
          { tool: "__thinking__", status: "running" },
        ],
      },
      caps,
    );
    const body = card.body as Array<Record<string, unknown>>;
    expect(body[0].type).toBe("ColumnSet");
    const containers = progressDetailItems(card) as Array<{ type: string; style?: string; items?: Array<Record<string, unknown>> }>;
    expect(containers).toHaveLength(2);
    expect(containers[0].type).toBe("Container");
    expect(containers[0].items?.map((e) => e.type)).toEqual(["RichTextBlock", "RichTextBlock"]);
    expect(containers[1].style).toBe("warning");
    expect(containers[1].items?.[0]?.type).toBe("RichTextBlock");
    expect(plain).toContain("💭 Reasoning · 3.0s");
    expect(plain).toContain("⌨️ exec: find · 100ms");
  });

  it("advertise ToggleVisibility → terminal card defaults collapsed and buttons target timeline_detail", () => {
    const caps = {
      elements: new Set(["TextBlock", "RichTextBlock", "Container", "ColumnSet", "ActionSet"]),
      actions: new Set(["Action.ToggleVisibility"]),
    };
    const { card, plain } = renderProgressCard(
      {
        phase: "done",
        elapsedMs: 3200,
        steps: [
          { tool: "__thinking__", status: "done", durationMs: 3000 },
          { tool: "exec", status: "done", summary: "find", durationMs: 100 },
        ],
      },
      caps,
    );

    const body = card.body as Array<Record<string, unknown>>;
    expect(body[0].type).toBe("ColumnSet");
    const summaryHeader = body[0] as { columns: Array<{ width: string; items: Array<Record<string, unknown>> }> };
    expect(summaryHeader.columns[0].width).toBe("stretch");
    expect(summaryHeader.columns[1].width).toBe("auto");
    const headerBlock = summaryHeader.columns[0].items[0] as { type: string; inlines: Array<Record<string, unknown>> };
    expect(headerBlock.type).toBe("RichTextBlock");
    expect(headerBlock.inlines).toMatchObject([
      { text: "✅ Done", weight: "Bolder" },
      { text: " · 2 steps · 3.2s", isSubtle: true },
    ]);
    const summaryBlock = summaryHeader.columns[0].items[1] as { type: string; inlines: Array<Record<string, unknown>> };
    expect(summaryBlock.inlines).toMatchObject([
      { text: "Reasoning 1 · Tools 1", isSubtle: true },
    ]);

    const collapseBtn = summaryHeader.columns[1].items[0] as { id: string; isVisible: boolean; actions: Array<Record<string, unknown>> };
    const expandBtn = summaryHeader.columns[1].items[1] as { id: string; isVisible: boolean; actions: Array<Record<string, unknown>> };
    expect(collapseBtn.isVisible).toBe(false);
    expect(expandBtn.isVisible).toBe(true);
    expect(collapseBtn.actions[0]).toMatchObject({ type: "Action.ToggleVisibility", title: "Hide details" });
    expect(expandBtn.actions[0]).toMatchObject({ type: "Action.ToggleVisibility", title: "Show details" });

    const detail = body[1] as { type: string; id: string; isVisible: boolean; items: Array<Record<string, unknown>> };
    expect(detail.type).toBe("Container");
    expect(detail.id).toBe("timeline_detail");
    expect(expandBtn.actions[0].targetElements).toEqual([
      { elementId: detail.id, isVisible: true },
      { elementId: collapseBtn.id, isVisible: true },
      { elementId: expandBtn.id, isVisible: false },
    ]);
    expect(detail.isVisible).toBe(false);
    expect(collapseBtn.actions[0].targetElements).toEqual([
      { elementId: detail.id, isVisible: false },
      { elementId: collapseBtn.id, isVisible: false },
      { elementId: expandBtn.id, isVisible: true },
    ]);
    expect(detail.items[0].type).toBe("Container");
    expect(JSON.stringify(detail.items)).toContain("💭");
    expect(JSON.stringify(detail.items)).toContain("exec");
    expect(plain).toContain("Reasoning 1 · Tools 1");
    expect(plain).not.toContain("2/2 steps");
    expect(plain).toContain("⌨️ exec: find · 100ms");
  });

  it("advertise ToggleVisibility → running card keeps timeline_detail visible", () => {
    const caps = {
      elements: new Set(["TextBlock", "RichTextBlock", "Container", "ColumnSet", "ActionSet"]),
      actions: new Set(["Action.ToggleVisibility"]),
    };
    const { card } = renderProgressCard(
      {
        phase: "tool",
        steps: [{ tool: "exec", status: "running", summary: "npm test" }],
      },
      caps,
    );
    const body = card.body as Array<Record<string, unknown>>;
    const summaryHeader = body[0] as { columns: Array<{ items: Array<Record<string, unknown>> }> };
    const collapseBtn = summaryHeader.columns[1].items[0] as { isVisible: boolean };
    const expandBtn = summaryHeader.columns[1].items[1] as { isVisible: boolean };
    expect((body[1] as { id: string; isVisible: boolean }).id).toBe("timeline_detail");
    expect((body[1] as { isVisible: boolean }).isVisible).toBe(true);
    expect(collapseBtn.isVisible).toBe(true);
    expect(expandBtn.isVisible).toBe(false);
  });

  it("缺 ColumnSet → 降级普通平面卡,不伪装 agent_progress_v1", () => {
    const caps = { elements: new Set(["TextBlock", "RichTextBlock", "Container", "ActionSet"]) };
    const { card } = renderProgressCard(
      {
        phase: "done",
        steps: [
          { tool: "__thinking__", status: "done", durationMs: 100 },
          { tool: "exec", status: "done", summary: "find", durationMs: 50 },
        ],
      },
      caps,
    );
    const body = card.body as Array<Record<string, unknown>>;
    expect(body.every((b) => b.type === "TextBlock" || b.type === "RichTextBlock" || b.type === "Container")).toBe(true);
    expect(body.some((b) => b.type === "ColumnSet")).toBe(false);
    expect(card.metadata).toBeUndefined();
  });

  it("只支持 TextBlock → 整张进度卡纯 TextBlock 降级且无布局 metadata", () => {
    const caps = { elements: new Set(["TextBlock", "FactSet"]) };
    const { card } = renderProgressCard({ phase: "tool", steps: [{ tool: "read", status: "done" }] }, caps);
    const body = card.body as Array<Record<string, unknown>>;
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((item) => item.type === "TextBlock")).toBe(true);
    expect(card.metadata).toBeUndefined();
  });

  it("caps.maxNodes 权威收紧可见步数(比本地上限更严)", () => {
    // 用不同 tool 避同类合并,保留"裁剪导致展示 cap 步"的原意图
    const steps = Array.from({ length: 20 }, (_, i) => ({
      tool: i % 2 === 0 ? "read" : "exec",
      status: "done" as const,
    }));
    const { card } = renderProgressCard({ phase: "tool", steps }, { maxNodes: 6 }); // reserve=2 → 4 步
    expect(countCardNodes(card)).toBeLessThanOrEqual(6);
    expect(card.metadata).toBeUndefined(); // enhanced root 超预算后降级普通平面卡
  });

  it("P1-g: __thinking__ 特殊 tool 名 → icon 💭, label 'Reasoning'(done 时用 icon, running 时仍用 ⏳)", () => {
    // done 状态:显示 💭 思考
    const done = renderProgressCard({
      phase: "tool",
      steps: [{ tool: "__thinking__", status: "done", durationMs: 200 }],
    });
    expect(progressDetailText(done.card)).toContain("💭 Reasoning");
    expect(progressDetailText(done.card)).toContain("200ms");
    // running 状态:仍用 ⏳(running 图标),label 是"思考"
    const running = renderProgressCard({
      phase: "thinking",
      steps: [{ tool: "__thinking__", status: "running" }],
    });
    expect(progressDetailText(running.card)).toContain("⏳ Reasoning");
  });

  it("子任务等待作为独立明细展示,不能误算成工具耗时", () => {
    const { card, plain } = renderProgressCard({
      phase: "done",
      elapsedMs: 67_300,
      steps: [
        { tool: "__thinking__", status: "done", durationMs: 2_000 },
        { tool: "sessions_spawn", status: "done", durationMs: 50 },
        { tool: "sessions_yield", status: "done", durationMs: 10 },
        { tool: "__subagent_wait__", status: "done", durationMs: 65_000 },
      ],
    });

    expect(progressDetailText(card)).toContain("⏸️ Waiting for subtask · 1m 5s");
    expect(plain).toContain("Reasoning 1 · Tools 2 · Waiting 1");
    expect(plain).not.toContain("Tools 3");
  });

  it("P1-g: 连续 thinking done 触发同类合并 → 💭 思考 × N", () => {
    const { card } = renderProgressCard({
      phase: "tool",
      steps: [
        { tool: "__thinking__", status: "done", durationMs: 100 },
        { tool: "__thinking__", status: "done", durationMs: 200 },
        { tool: "__thinking__", status: "done", durationMs: 300 },
      ],
    });
    const t = progressDetailText(card);
    expect(t).toContain("💭");
    expect(t).toContain("Reasoning × 3");
    expect(t).toContain("total 600ms");
  });

  it("cardSupports 支持 input/action 查询(与 element 同接口):advertise 以其为准", () => {
    // Input.* / Action.* 走同一函数,不再另开 API。基线不含输入/动作,不 advertise → 都为 false。
    expect(cardSupports(undefined, "Input.Text")).toBe(false);
    expect(cardSupports(undefined, "Action.ToggleVisibility")).toBe(false);
    expect(cardSupports({ inputs: new Set(["Input.Text", "Input.Number"]) }, "Input.Text")).toBe(true);
    expect(cardSupports({ inputs: new Set(["Input.Text"]) }, "Input.Number")).toBe(false);
    expect(cardSupports({ actions: new Set(["Action.ToggleVisibility"]) }, "Action.ToggleVisibility")).toBe(true);
    expect(cardSupports({ actions: new Set(["Action.Submit"]) }, "Action.ToggleVisibility")).toBe(false);
  });
});

describe("归约管线的输入有界(每一处都自己有界,不靠调用方)", () => {
  // discarded tail 在固定额度内由同一个线性 authority 完整检查;超过额度直接 fail closed。
  // 下面先钉旧窗口之外的前缀信号,再单独钉 JWT 与超额路径。
  it("额度内的 discarded tail 完整检查,不因信号离切口较远而放行", () => {
    const kept = "word ".repeat(800).trim();          // 3999 字符,切口落在这里
    for (const [pads, where] of [[200, "尾巴第 ~800 位"], [1200, "尾巴第 ~4800 位"]] as [number, string][]) {
      const s = `${kept} ${"pad ".repeat(pads)}AKIAIOSFODNN7EXAMPLE`;
      expect(reduceUrlsInText(s), `AKIA 在${where}没有让整串扣下`).toBe("");
    }
    // 再远时 discarded tail 已超过额度,结果仍是 fail closed,但不再扫描无界原文。
    const beyond = `${kept} ${"pad ".repeat(20_000)}AKIAIOSFODNN7EXAMPLE`;
    expect(reduceUrlsInText(beyond), "超额尾巴必须 fail closed").toBe("");
  });

  it("短 JWT 无论离切口多远,都不能从 base 的扣留变成 head 的放行", () => {
    const kept = "word ".repeat(800).trim();
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij";
    const near = `${kept} ${"pad ".repeat(200)}${jwt}`;
    const far  = `${kept} ${"pad ".repeat(1200)}${jwt}`;
    expect(reduceUrlsInText(near), "切口附近的 JWT 应让整串扣下").toBe("");
    expect(reduceUrlsInText(far), "切口 4000 字符外的 JWT 也必须让整串扣下").toBe("");
  });

  it("丢弃段超过固定扫描额度时直接 fail closed,不扫描无界原文", () => {
    const kept = "db_pass hunter2Kx " + "word ".repeat(800);
    const input = kept + "plain ".repeat(12_000);
    expect(input.length).toBeGreaterThan(RAW_INPUT_MAX);
    expect(boundedForReduction(input)).toBeNull();
    expect(reduceUrlsInText(input)).toBe("");
  });

  it("未计费的摘要与错误 sink 对超额原文保持固定成本", () => {
    // Reviewer 在旧实现上量到 16 MiB 约 300 ms、64 MiB 超 1 秒。输入构造放在计时外;
    // 当前路径只切前 64 KiB、按剩余长度 fail closed,不读取那 16 MiB tail。
    const input = "db_pass hunter2Kx " + "plain ".repeat(Math.ceil((16 * 1024 * 1024) / 6));
    for (const [label, fn] of [
      ["sanitizeErrorText", () => sanitizeErrorText(input)],
      ["summarizeToolParams/grep", () => summarizeToolParams("grep", { pattern: input })],
    ] as const) {
      const t0 = performance.now();
      expect(fn()).toBe("");
      const elapsed = performance.now() - t0;
      expect(elapsed, `${label} / 16 MiB 耗时 ${elapsed.toFixed(1)} ms`).toBeLessThan(150);
    }
  });

  it("JWT 判定在密集 eyJ 起点上保持线性成本", () => {
    const adversarial = "eyJ".repeat(5000);
    const t0 = performance.now();
    expect(isSensitive(adversarial, true)).toBe(false);
    const elapsed = performance.now() - t0;
    expect(elapsed, `15 KB 无点 eyJ 串耗时 ${elapsed.toFixed(1)} ms`).toBeLessThan(40);
  });

  it("JWT 线性扫描器与原规则等价,且不会从短 run 反复搜索远端 eyJ", () => {
    const legacy = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/;
    const alphabet = "eyJa0_-.:/";
    let state = 0x5eed1234;
    let legacyMatches = 0;
    let legacyNonMatches = 0;
    const checkEquivalent = (input: string): void => {
      const expected = legacy.test(input);
      if (expected) legacyMatches++;
      else legacyNonMatches++;
      expect(isSensitive(input, false), JSON.stringify(input)).toBe(expected);
    };

    // 保留宽随机背景,专门找意料之外的状态机分岔。
    for (let sample = 0; sample < 20_000; sample++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const length = state % 80;
      let input = "";
      for (let i = 0; i < length; i++) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        input += alphabet[state % alphabet.length];
      }
      checkEquivalent(input);
    }

    // 随机串几乎不可能碰出完整 JWT。结构化扫三段长度的 7/8 边界、run 内起始偏移和错误分隔符,
    // 同时制造足量正例与只差一个条件的近似反例,避免全 false 的实现通过这道等价护栏。
    for (const prefix of ["", "x", "a0_-", "/"]) {
      for (const first of [7, 8, 9, 16]) {
        for (const middle of [7, 8, 9, 16]) {
          for (const tail of [0, 1, 2, 8]) {
            for (const firstSep of [".", "..", "/"]) {
              for (const secondSep of [".", "..", ":"]) {
                checkEquivalent(
                  `${prefix}eyJ${"a".repeat(first)}${firstSep}` +
                  `${"b".repeat(middle)}${secondSep}${"c".repeat(tail)} end`,
                );
              }
            }
          }
        }
      }
    }
    expect(legacyMatches, "等价对拍没有覆盖足量 JWT 正例,全 false 的实现也会通过").toBeGreaterThan(100);
    expect(legacyNonMatches, "等价对拍没有覆盖足量 JWT 反例,全 true 的实现也会通过").toBeGreaterThan(20_000);

    // 若每个 run 都用无上界的 indexOf("eyJ", start),前面的 20 000 个短 run 会反复扫描到
    // 最后那个 eyJ,总成本退化成二次方。真正的 run-local 扫描只读每个字符常数次。
    const manyRuns = "a.".repeat(20_000) + "eyJabcdefgh.abcdefgh.abc";
    const t0 = performance.now();
    expect(isSensitive(manyRuns, false)).toBe(true);
    const elapsed = performance.now() - t0;
    expect(elapsed, `短 run + 远端 eyJ 耗时 ${elapsed.toFixed(1)} ms`).toBeLessThan(100);
  });

  it("切口之后的关键词仍然压得住 kept 里守卫抓不住的凭据", () => {
    // 这是收窄整个守卫时漏掉的那个前提:「渲染的永远只有 kept,而 kept 自己要过守卫」——
    // 只在守卫抓得住 kept 里的东西时成立。`alice:hunter2@localhost` 是本仓 UNFIXED_CORPUS
    // 记着的、守卫**抓不住**的形状,当时压住它的只有 4000 字符之外那个 `token`。
    const leaky = "alice:hunter2@localhost " + "word ".repeat(900) + "pad ".repeat(1300) + " token";
    expect(leaky.length).toBeGreaterThan(8000);
    expect(sanitizeErrorText(leaky)).toBe("");
    expect(summarizeToolParams("grep", { pattern: leaky })).toBe("");
  });

  it("折叠空白之前先把原串收进 RAW_INPUT_MAX", () => {
    // 折叠跑在界**之前**,所以界救不了它 —— 实测 32–92 ms/MB。
    const head = "word ".repeat(20_000);                  // 100 KB,已超 64 KiB
    // 64 KiB 之后的**普通**内容不参与输出。注意这一条只说"不参与输出",不说"中性" ——
    // 见下一条:它参与判定。
    expect(collapseForReduction(head + "TAILMARKER"))
      .toBe(collapseForReduction(head));
    // 上限之内的内容一字不差。
    expect(collapseForReduction("a  b\n\nc")).toBe("a b c");
    expect(collapseForReduction("x".repeat(1000))).toBe("x".repeat(1000));
  });

  it("折叠丢掉的那一段也要过谓词 —— 否则截断自己变成泄漏路径", () => {
    // 上一版这里断言的是「尾巴被丢掉」,而那**正是缺陷本身**:它把一个 fail-open 的行为
    // 写成了期望值。boundedForReduction 会检查自己丢掉的那一段,collapseForReduction 当时
    // 只镜像了切口规则、没镜像这道守卫 —— 又一次「第二处该照着第一处写,却没有」。
    //
    // 压住整串的关键词落在 64 KiB 之外:折叠比 ~12,所以折叠后它离渲染出来的内容并不远,
    // 「远处的东西不再压住近处」那条豁免在这里不成立。
    const leaky = `user:hunter2@localhost ${("x" + " ".repeat(23)).repeat(3000)} y token`;
    expect(leaky.length).toBeGreaterThan(64 * 1024);
    expect(collapseForReduction(leaky), "被丢掉的 token 关键词没有参与判定").toBe("");
    expect(sanitizeErrorText(leaky)).toBe("");
    // 同样的串,尾巴不敏感时照常渲染 —— 这道守卫不是"超过 64 KiB 一律打空"。
    const benign = `user hunter2 localhost ${("x" + " ".repeat(23)).repeat(3000)} y done`;
    expect(collapseForReduction(benign)).not.toBe("");
  });

  it("exec 的程序名扫描自己有界,而且界的代价说得出口", () => {
    // summarizeShell 跑在归约那道界**之上**,所以 REDUCE_INPUT_MAX 管不到它:4 MB 的 command
    // 实测 201 ms,只为读出一个词。它现在自己先切一刀。
    //
    // 这一刀**有可观察的代价**,不是纯优化 —— 所以断言它,而不是只测耗时(耗时断言在 4 MB
    // 这个量级上要么慢得不能进套件,要么松得抓不到东西)。程序名落在切口之后就读不到了:
    const many = "A=1 ".repeat(1200) + "docker";      // 4806 字符,程序名在 4800 之后
    expect(many.length).toBeGreaterThan(4000);
    expect(summarizeToolParams("exec", { command: many }), "切口之后的程序名不该被读出来").toBe("");
    // 切口之内一切如常 —— 这道界不是"超长就打空"。
    const few = "A=1 ".repeat(100) + "docker";
    expect(summarizeToolParams("exec", { command: few })).toBe("docker");
    // 4000 字符以上的单 token 不可能是程序名,切不出空白就整条返回空。
    expect(summarizeToolParams("exec", { command: "x".repeat(5000) })).toBe("");
  });

  it("discarded tail 在 64 KiB 内完整扫描,多一个字符就 fail closed", () => {
    const head = "word ".repeat(800).trim();            // 3999,切口落在它后面那个空格上
    const maxTail = RAW_INPUT_MAX;
    expect(boundedForReduction(`${head} ${"p".repeat(maxTail - 1)}`), "恰好 64 KiB 的良性尾巴")
      .not.toBeNull();
    expect(boundedForReduction(`${head} ${"p".repeat(maxTail)}`), "尾巴超过额度一个字符")
      .toBeNull();

    const jwt = "eyJabcdefgh.abcdefgh.abc";
    const jwtAtEnd = `${head} ${"p".repeat(maxTail - 1 - jwt.length)}${jwt}`;
    expect(boundedForReduction(jwtAtEnd), "额度最后一个完整 token 也必须被检查").toBeNull();
  });
});

describe("process 工具的摘要", () => {
  // 它此前映射到 `"shell"`,而 shell 策略读的是 `command`/`cmd` —— `process` 根本没有这两个
  // 字段(参数是 `action` + `sessionId` 等),于是这个工具的摘要**恒为空串**。
  it("渲染白名单内的动作名", () => {
    expect(summarizeToolParams("process", { action: "kill", sessionId: "s1" })).toBe("kill");
    expect(summarizeToolParams("process", { action: "list" })).toBe("list");
    expect(summarizeToolParams("process", { action: "send-keys", keys: ["a"] })).toBe("send-keys");
  });

  it("认不出的动作退回空串,而不是原样渲染", () => {
    // 上游 schema 把 action 声明成 Type.String,枚举只写在 description 里、并不强制,而
    // openclaw 的依赖是范围不是 pin。所以失败模式选在"少显示一个词"这一侧。
    expect(summarizeToolParams("process", { action: "rm -rf /" })).toBe("");
    expect(summarizeToolParams("process", { action: "未来新增的动作" })).toBe("");
    expect(summarizeToolParams("process", {})).toBe("");
  });
});
