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
        it("单标签主机的 query 段被剥掉(上面几趟都要求主机带点,漏掉这一类)", () => {
    // 归约:主机/路径保留,query 整段剥掉。
    expect(summarizeToolParams("read", { file_path: "localhost/reset?code=abc" })).toBe("localhost/reset");
    expect(summarizeToolParams("read", { file_path: "localhost:8080/api?mode=fast" })).toBe("localhost:8080/api");
    // 前导必须认引号与 `=` —— 命令行上给 URL 加引号、或挂在 `--url=` 后面都是常态写法。
    expect(summarizeToolParams("read", { file_path: "'localhost/reset?code=abc'" })).toBe("'localhost/reset'");
    expect(summarizeToolParams("read", { file_path: "--url=localhost/reset?code=abc" })).toBe("--url=localhost/reset");
    // IPv4 字面量:内网/开发环境里最常见的无字母主机。只要求字母时它既过不了这一趟、也过不了
    // 第 4 趟(要求字母 TLD),query 原样渲染 —— 按本分支自己的论据,这正是要挡的那类。
    expect(summarizeToolParams("grep", { pattern: "192.168.0.1?code=abc" })).toBe("192.168.0.1");
    expect(summarizeToolParams("read", { file_path: "127.0.0.1?sid=abcdef" })).toBe("127.0.0.1");
    // 不误伤:普通相对路径、以及不含 `=` 的 shell glob。
    expect(summarizeToolParams("read", { file_path: "src/index.ts" })).toBe("src/index.ts");
    expect(summarizeToolParams("read", { file_path: "src/file?.ts" })).toBe("src/file?.ts");
  });
  it("归约不掉的 query 形状整串不渲染(结构要求也会在兜底里被抄错)", () => {
    // query 直接挂在**裸主机**上:路径段两边都必须可选。只有归约放宽、兜底照抄「`?` 前必须
    // 有 `/`」这条结构要求的话,这条两边都不匹配、原样渲染。
    expect(summarizeToolParams("read", { file_path: "localhost?code=abc" })).toBe("localhost");
    // query 里嵌引号 → 归约不改写(半改写会把命令改成另一条),整串不渲染。
    // `code` 是 OAuth 授权码,等价于 bearer;既不在关键词表里,值也没有高熵形状。
    // (shell 策略在默认档只渲染程序名,所以这一类的 sink 是 path/query。)
    expect(summarizeToolParams("grep", { pattern: `'localhost:8080/s?f={"a":1}&code=hunter2'` })).toBe("");
    // 反向:归约**主动不碰**的纯数字主机,兜底也不能拦 —— query 策略没有程序名可退,
    // 整串拦掉会让卡片直接空白,看起来像 bug。
    expect(summarizeToolParams("grep", { pattern: "10/20?ok=yes" })).toBe("10/20?ok=yes");
    expect(summarizeToolParams("grep", { pattern: "2026-08-06?ok=yes" })).toBe("2026-08-06?ok=yes");
  });
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
  // 这两条是本文件仅有的计时断言。用耗时而不是「输出被截断」来断言,是因为要守的性质就是耗时本身
  // —— 归约管线里的正则在长串上是二次的,而这几个函数都在同步路径上、都没有 try/catch。
  //
  // **第一条直接测 reduceUrlsInText,而不是只测它的某一个调用方。** 上一版只测了
  // summarizeToolParams,于是上限被放进那一个调用方里也能让测试全绿 —— 而另外八个调用方跑的
  // 还是同一条二次管线,其中 card-action-status 的 neutralizeEcho 输入是**群成员提交的表单值**。
  // 测调用方测不出上限放错了地方,测管线本身才行。
  it("归约管线自身有无条件输入上限(不是只有某一个调用方有)", () => {
    const SHAPES: Array<[string, string]> = [
      ["无点长串 + query", "a".repeat(100_000) + "?x"],
      ["scheme + 长主机", "http://" + "a".repeat(120_000)],
      ["userinfo 前缀 + 长串", "a:b@" + "a".repeat(60_000)],
    ];
    for (const [shape, input] of SHAPES) {
      for (const [name, run] of [
        ["reduceUrlsInText", () => reduceUrlsInText(input)],
        ["sanitizeErrorText", () => sanitizeErrorText(input)],
      ] as Array<[string, () => unknown]>) {
        const t0 = performance.now();
        run();
        const ms = performance.now() - t0;
        // 修好后实测每格 20 ms 内;上限 2000 ms 给 CI 留余量,仍能抓住回归(未设上限时
        // reduceUrlsInText × 无点长串实测 11171 ms,sanitizeErrorText 9452 ms)。
        expect(ms, `${name} / ${shape} 耗时 ${ms.toFixed(0)} ms`).toBeLessThan(2000);
      }
    }
  });
  // 三种形状分别测:回溯代价随输入形状变化很大(`http://` 那条走第 1 趟,无点长串走第 3/4 趟),
  // 只测一种会得出「另外几趟不要紧」的错误结论。
  it("超长输入不进归约管线:默认档、所有策略都有无条件上限", () => {
    const SHAPES: Array<[string, string]> = [
      ["无点长串 + query", "a".repeat(100_000) + "?x"],
      ["scheme + 长主机", "http://" + "a".repeat(120_000)],
      ["userinfo 前缀 + 长串", "a:b@" + "a".repeat(60_000)],
    ];
    const CALLS: Array<[string, (s: string) => Record<string, unknown>]> = [
      ["read", (s) => ({ file_path: s })],
      ["exec", (s) => ({ command: s })],
      ["grep", (s) => ({ pattern: s })],
    ];
    for (const [shape, input] of SHAPES) {
      for (const [tool, mk] of CALLS) {
        const t0 = performance.now();
        summarizeToolParams(tool, mk(input));
        const ms = performance.now() - t0;
        // 修好后实测每格都在几十毫秒内;上限取 2000 ms 是给 CI 留足余量,同时仍能抓住回归
        // (未设上限时 read × 无点长串实测 9311 ms)。
        expect(ms, `${tool} / ${shape} 耗时 ${ms.toFixed(0)} ms`).toBeLessThan(2000);
      }
    }
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
