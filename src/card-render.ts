/**
 * InteractiveCard(=17) 进度卡渲染 —— 把 agent 运行状态渲染成 Adaptive Cards 1.5
 * JSON（octo/v1 profile 白名单:TextBlock/Container 等）。纯函数、无副作用、无
 * `Date.now`（耗时由 state.elapsedMs 传入），便于单测。
 *
 * 波 B(卡片进度帧):卡仅承载过程/状态(C2 决策),最终答案走文本。
 * 帧内容:工具名友好化 + 参数摘要 + 耗时,让用户看清 agent 在做什么。
 * 视觉属性仅用端到端验证过的(weight/spacing/size/wrap),不用未验证的 color 以规避白名单。
 */
import { CARD_VERSION } from "./types.js";
import { buildDisplayCard, EN_BUDGET_MARKER, EN_DROP_MARKER, type DisplayBlock, type RichSegment } from "./card-blocks.js";
import { cardFitsLimits, type CardLimits } from "./card-limits.js";

/**
 * Plain-text fallback for the progress / reasoning card. Deliberately not `CARD_PLACEHOLDER`:
 * that constant is the **inbound** derivation for a received card and feeds the model in a
 * Chinese-copy context, whereas these two renderers are English end to end. Reachable here when a
 * tight negotiated payload budget drops every group and the body degrades to empty.
 */
export const PROGRESS_CARD_PLACEHOLDER = "[card]";

export const OCTO_CARD_LAYOUTS = {
  agentProgressV1: "agent_progress_v1",
} as const;

const AGENT_PROGRESS_DETAIL_ID = "timeline_detail";
const AGENT_PROGRESS_COLLAPSE_ID = "btn_collapse";
const AGENT_PROGRESS_EXPAND_ID = "btn_expand";

export type OctoCardLayout = (typeof OCTO_CARD_LAYOUTS)[keyof typeof OCTO_CARD_LAYOUTS];

const KNOWN_OCTO_CARD_LAYOUTS = new Set<string>(Object.values(OCTO_CARD_LAYOUTS));

export function detectOctoCardLayout(card: Record<string, unknown>): OctoCardLayout | undefined {
  const metadata = card.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const layout = (metadata as { octo_layout?: unknown }).octo_layout;
  return typeof layout === "string" && KNOWN_OCTO_CARD_LAYOUTS.has(layout)
    ? (layout as OctoCardLayout)
    : undefined;
}

/** 单个工具步骤的状态。 */
export interface CardStep {
  tool: string;
  status: "running" | "done" | "error";
  durationMs?: number;
  error?: string;
  /** 参数摘要(在读哪个文件 / 执行什么命令),来自 before_tool_call 的 params。 */
  summary?: string;
  /**
   * SDK 提供的工具调用唯一 id(before/after_tool_call 都带)。用于把 after 事件
   * 精确回填到对应步骤 —— 并发同名工具(两个 exec/process)乱序完成时,按 id 匹配
   * 避免把 duration/error 标到错误行。缺失(旧 host)时回退按 toolName 匹配。
   */
  toolCallId?: string;
  /**
   * hook 侧记录的开始时间(ms epoch)。用于没有成对 end hook 的内部步骤:
   * `__thinking__` 由 before_tool_call/finalize 收尾，`__subagent_wait__` 由受信 completion
   * continuation 收尾，duration = now - startedAt。渲染层只看 durationMs。
   */
  startedAt?: number;
  /** OpenClaw model_call_started.callId; used to close the matching reasoning phase. */
  modelCallId?: string;
  /** User-visible reasoning lane text associated with this model call. */
  thought?: string;
  /** Bounded structural summary derived from after_tool_call.result. */
  resultSummary?: string;
}

/** 进度卡的渲染状态。 */
export interface CardProgressState {
  phase: "thinking" | "tool" | "paused" | "resuming" | "answering" | "expired" | "done" | "stopped" | "error";
  steps: CardStep[];
  /** Stable contract identifier: sessionKey + runId when the host provides runId. */
  reasoningId?: string;
  elapsedMs?: number;
  errorText?: string;
}

const MCP_TOOL_PREFIX = "mcp__";
export const SUBAGENT_WAIT_STEP_TOOL = "__subagent_wait__";

/** 常见工具只映射图标；fallback 标签始终保留原始 toolName，供客户端按稳定名称做 i18n。 */
const TOOL_ICONS: Record<string, string> = {
  read: "📖",
  write: "✏️",
  edit: "✏️",
  apply_patch: "✏️",
  exec: "⌨️",
  bash: "⌨️",
  shell: "⌨️",
  process: "⚙️",
  search: "🔍",
  grep: "🔍",
  find: "🔍",
  glob: "🔍",
  ls: "📂",
  fetch: "🌐",
  web_search: "🌐",
  update_plan: "🗺️",
  octo_management: "💬",
};

/** 工具名 → 图标 + 原始名称；内部合成步骤使用可读的英文 fallback。 */
export function resolveToolMeta(tool: string): { icon: string; label: string } {
  // 特殊内部 tool 名:agent 一轮 model_call = 一步"思考"(P1-g)。以 __ 前缀,agent 侧无冲突可能。
  if (tool === "__thinking__") return { icon: "💭", label: "Reasoning" };
  if (tool === SUBAGENT_WAIT_STEP_TOOL) return { icon: "⏸️", label: "Waiting for subtask" };
  if (tool.startsWith(MCP_TOOL_PREFIX)) return { icon: "🔌", label: tool };
  return { icon: TOOL_ICONS[tool] ?? "🔧", label: tool };
}

export const SUMMARY_MAX = 64;
/**
 * `reduceUrlsInText` 的输入长度上限。
 *
 * 归约管线里的几趟正则在长串上是二次的。实测(`b1e3def`,默认配置,`"a"×100k + "?x"`):
 *
 *     reduceUrlsInText(直接)      11171 ms
 *     sanitizeErrorText            9452 ms
 *     summarizeToolParams(read)    9463 ms
 *     renderCardActionStatus       9371 ms
 *
 * 这些函数都在同步路径上、都没有 try/catch,几秒就是整个插件的事件循环被卡住,所有账号、所有群
 * 一起停。
 *
 * **上限住在 reduceUrlsInText 里,不是住在调用方。** 上一版把它放在 summarizeToolParams 里,
 * 于是十一个调用点只有一个被挡住;剩下十个跑的还是同一条二次管线。最要命的是
 * card-action-status.ts 的 neutralizeEcho —— 它的输入是**群成员提交的表单值**和用户自设的
 * 显示名(它自己的文档注释就写着 untrusted),信任边界比「模型生成的工具参数」还低,而且因为
 * summarizeToolParams 已经快了,它成了唯一剩下的那条路,反而更难被发现。
 *
 * 怎么截断见 boundedForReduction —— 切口必须落在空白上,那是这个上限能否安全存在的前提。
 */
export const REDUCE_INPUT_MAX = 4000;

/**
 * 敏感串守卫模式。群卡片对全体成员可见 —— 摘要一旦命中即整串隐藏(fail-safe:
 * 宁可误伤含 "token" 字样的正常文本,也不泄露 token/密钥/口令)。
 */
const SECRET_RE =
  /token|api[_-]?key|secret|password|passwd|pwd|authorization|bearer|access[_-]?key|client[_-]?secret|credential/i;

/**
 * 明确前缀式凭据形状(AKIA/GitHub/Slack/OpenAI/JWT)。这些格式**在任何位置都几乎不可能
 * 是正常内容**,故对所有策略(含 path/shell)都应用 —— 关键词正则只认密钥名字,认不出这些形状。
 */
// 关键:这些前缀模式**不加前导 `\b`/`(?<!\w)` 词界锚点**。词界锚点会被"前面粘一个词字符"
// (`xAKIA…`、`KeyAKIA…`)绕过 —— 短前缀(AKIA=20 / sk-≈19 / Slack / JWT)又都短于 32 位,
// 逃过高熵兜底 → 明文密钥渲进群卡片(yujiawei 复现的 P1)。故按**无锚点子串**匹配;`{16,}`/`{20,}`
// 长度下限仍能把连字符英文(`risk-averse`/`task-force`)挡在外面。宁可过度隐藏,绝不泄露。
const SECRET_PREFIX_RES: RegExp[] = [
  /AKIA[0-9A-Z]{12,}/,                                  // AWS access key id
  /(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/,         // GitHub token / fine-grained PAT
  /xox[baprs]-[A-Za-z0-9-]{10,}/,                       // Slack bot/user token
  /xapp-[0-9]-[A-Za-z0-9-]{10,}/,                       // Slack app-level token
  /sk-[A-Za-z0-9_-]{16,}/,                              // OpenAI-style secret key
  /[srp]k_(?:live|test)_[A-Za-z0-9]{10,}/,             // Stripe secret/restricted/publishable
  /glpat-[A-Za-z0-9_-]{16,}/,                           // GitLab personal access token
  /AIza[0-9A-Za-z_-]{30,}/,                             // Google API key
  /npm_[A-Za-z0-9]{30,}/,                               // npm automation token
  /shpat_[A-Fa-f0-9]{32,}/,                             // Shopify access token
  /dop_v1_[A-Fa-f0-9]{32,}/,                            // DigitalOcean PAT
];

/**
 * JWT。**单独拎出来,因为整个守卫里只有它不是线性的。**
 *
 * 在没有点号的长 base64 串上,每个 `eyJ` 都是一个起点,各自向后扫到底找 `.`,于是代价是二次的。
 * 实测(单条正则,`"eyJ"` 重复):
 *
 *     4000  19 ms      8000  80 ms      32000  1230 ms      64000  (分钟级)
 *
 * 其余每一条都便宜且线性 —— 同一批输入下 64 KB 上的实测:SECRET_RE 0.07 ms,11 条前缀正则
 * 各 ≤0.02 ms,长 hex 0.14 ms,高熵 0.41 ms。
 *
 * **试过把它改成线性,失败了,记在这里免得下一个人再试一遍。** 把 `[A-Za-z0-9_-]{8,}` 用
 * lookahead 捕获 + 反向引用模拟成占有型量词(`(?=([A-Za-z0-9_-]{8,}))\1`),语义等价
 * (8 个用例 + 20000 条随机串对拍全一致),但**只快 2 倍,仍然是干净的二次方**:代价不在
 * 单个起点内部的回溯,在起点的**数量**。真要线性得手写一个按点号扫描的匹配器 —— 那是把一条
 * 正则换成一份手写实现,而这条分支上出问题的地方几乎全是「同一条规则被实现了第二遍」。
 *
 * 所以界加在它身上,不加在输入上:线性档喂整条尾巴,这一条只喂 TAIL_SCAN_MAX 的窗口。
 */
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/;

/** 长 hex(md5/sha/hex 密钥)。也命中 git object/docker digest 等常见路径,故仅用于 query/url。 */
const LONG_HEX_RE = /\b[0-9a-fA-F]{32,}\b/;

/**
 * 通用高熵串:32+ 位连续 base64/base64url 段。会误伤
 * webpack 缓存名/UUID 目录等常见路径,故与长 hex 一样**仅用于 query/url**(裸 token 的场景),
 * 不套用到 path/shell。只按长度会误伤长英文(如 80 个 `x`),故要求字母数字混合,
 * 或出现 base64/base64url 特有的 `+ / = _ -` 信号。
 */
function hasGenericSecretShape(s: string): boolean {
  if (LONG_HEX_RE.test(s)) return true;
  const runs = s.match(/[A-Za-z0-9_+\/=-]{32,}/g);
  return !!runs && runs.some((r) => (
    (/[0-9]/.test(r) && /[A-Za-z]/.test(r)) || /[+\/_=-]/.test(r)
  ));
}

/**
 * 是否命中敏感串。`generic` 为 true(query/url 策略)时额外套用长 hex/高熵检测;path/shell
 * 只走关键词 + 明确前缀,避免把 git SHA / docker digest / 缓存哈希等正常路径误伤成空。
 * 群卡片对全员可见,任一命中即隐藏。
 */
export function isSensitive(s: string, generic: boolean): boolean {
  // 两档的**并集**就是原来那三项检查,按构造相等 —— 拆开是为了让尾部扫描能分别对待代价,
  // 不是为了改判定。任何一档漏掉一条正则,这里立刻就少一项,不需要靠第二处断言去发现。
  return hasLinearSecretShape(s, generic) || hasBoundedSecretShape(s);
}

/**
 * 代价与长度成正比的那一档:关键词 + 11 条明确前缀 + (generic 时)长 hex/高熵。
 * 64 KB 上实测合计 0.74 ms,1 MB 11.6 ms —— 可以喂完整条尾巴。
 */
function hasLinearSecretShape(s: string, generic: boolean): boolean {
  if (SECRET_RE.test(s)) return true;
  if (SECRET_PREFIX_RES.some((re) => re.test(s))) return true;
  if (hasOverlongUserinfo(s)) return true;
  return generic && hasGenericSecretShape(s);
}

/**
 * 一个 `user:pass@host` 里的 userinfo 段超过 SCHEMELESS_USERINFO_RE 的口令上限(256)时,
 * 那条正则整条匹配不上、DSN 原样流过归约 —— 而**这里必须把它当命中扣下,不能让它漏过去**。
 *
 * 上限本身是对的(它是 `a:b/c/…` 那条二次方的唯一解),问题是超限的失败方向:上一版超限 =
 * 不归约 = 明文渲染(评审第六轮的 P0,阈值精确在 257,无长度前提,五个群可见 sink 全中,
 * 且 path/shell 的 generic=false 连高熵兜底都不跑)。补一道 fail-closed:超限即敏感。
 *
 * **线性实现,不用正则。** 按空白分词,找一个「前面紧挨用户名字符的冒号」在先、`@` 在后,
 * 且中间那段(口令)超过 256 的 token,即命中。indexOf/lastIndexOf 都是线性。
 * 放在 generic 判定**之前**,所以 path/shell 也走它 —— 那正是漏得最狠的那条路。
 *
 * **分隔冒号必须紧挨用户名字符**(`[A-Za-z0-9._%+-]`),这是为了对齐 SCHEMELESS_USERINFO_RE
 * 只匹配 `[A-Za-z0-9._%+-]+:` 开头这一点 —— 否则一段无空白的 minified JSON
 * (`{"level":"error","detail":"<300 z>","owner":"ops@example.com"}`)里,第一个冒号前面是
 * `"`,却因为「有冒号、有 @、中间超 256」被整块打空(评审第七轮 P2)。要求冒号前是用户名字符,
 * JSON 那些 `":"` 全部被跳过,而 `alice:<300>@host` 照样命中。
 */
/**
 * `def63bb` 的 pass 3,**逐字抄下来**。poison 要问的是「main 当初会不会归约这一段」,
 * 那就问 main 的规则本身,不要再复刻一遍 —— 上一版只复刻了 host 半边、漏掉口令类不含 `/`,
 * 整个「口令含 `/`」的族因此判错。这条只读不改,是一份历史快照。
 */
const MAIN_PASS3_RE =
  /\b[A-Za-z0-9._%+-]+:[^\s/]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d+)?(?:\/[^\s]*)?/;

const OVERLONG_USERINFO_MAX = 256;
const USERINFO_NAME_CHAR = /[A-Za-z0-9._%+-]/;
const WS_SCAN_RE = /\s/g;
function hasOverlongUserinfo(s: string): boolean {
  // **一次原生空白扫描,短 token 连 slice 都不做。**
  //
  // 判据是 `lastAt - colon - 1 > OVERLONG_USERINFO_MAX`,而 `colon >= 1`(冒号前要有用户名
  // 字符),所以命中的 token 至少 260 个字符 —— 短于这个长度的 token **不可能**为真。先按长度
  // 筛掉,再谈里面有什么。
  //
  // 为什么在意:线性档现在看整条尾巴(P0-1 的修法),这个函数就跑在 MB 级的串上了。
  // 三版实测(4 MB,neutralizeEcho / sanitizeErrorText,def63bb 分别是 70 / 248 ms):
  //     s.split(/\s+/)            散文 265 / 213 ms  ← 八十万个字符串分配
  //     沿 @ 走 + 逐字符找边界      散文  69 /  76 ms,DSN 密集 189 / 195 ms  ← 每 token 数十次正则
  //     本版(空白扫描 + 长度筛)     见下
  // def63bb 没有这个函数,所以这里的每一毫秒都是本 PR 新加的,不能拿「base 也慢」搪塞。
  // 没有 `@` 就不可能命中 —— 一次原生 indexOf 就能挡掉整条散文尾巴,连空白扫描都省了。
  if (s.indexOf("@") < 0) return false;
  const MIN_TOKEN = OVERLONG_USERINFO_MAX + 4;
  WS_SCAN_RE.lastIndex = 0;
  let from = 0;
  for (;;) {
    const m = WS_SCAN_RE.exec(s);
    const to = m ? m.index : s.length;
    if (to - from >= MIN_TOKEN) {
      const tok = s.slice(from, to);
      if (!TOKEN_SCHEME_RE.test(tok)) {          // 带 scheme 的 URL 不是裸 userinfo
        const at = tok.lastIndexOf("@");
        if (at >= 2) {                           // `x:@` 起码要 3 个字符
          let colon = -1;
          for (let c = tok.indexOf(":"); c >= 0 && c < at; c = tok.indexOf(":", c + 1)) {
            if (c > 0 && USERINFO_NAME_CHAR.test(tok[c - 1]!)) { colon = c; break; }
          }
          if (colon >= 0 && at - colon - 1 > OVERLONG_USERINFO_MAX) return true;
        }
      }
    }
    if (!m) return false;
    from = WS_SCAN_RE.lastIndex;
  }
}

/** 必须设界的那一档。目前只有 JWT 一条(见 JWT_RE 上面那段)。 */
function hasBoundedSecretShape(s: string): boolean {
  return JWT_RE.test(s);
}

/**
 * 调用方自己的敏感判定,**按代价分成两档**。
 *
 * 上一版这里是一个不透明的 `(s) => boolean`,于是尾部扫描只能对整个守卫设界,而守卫里
 * 只有 JWT 一条贵 —— 结果是为了那一条,把便宜的关键词检测也一起关在 4000 字符之外,
 * 泄漏了 base 会扣下的凭据(见 boundedForReduction)。
 *
 * 两档由**同一个工厂**构造,`all` 就是两档之和,所以不存在「下游守卫与尾部守卫分岔」。
 */
export interface SensitivePredicate {
  linear(s: string): boolean;
  bounded(s: string): boolean;
  all(s: string): boolean;
}

/** 按 generic 档构造谓词。query/url 用 true,path/shell 用 false。 */
export function sensitivePredicate(generic: boolean): SensitivePredicate {
  return {
    linear: (s) => hasLinearSecretShape(s, generic),
    bounded: hasBoundedSecretShape,
    all: (s) => isSensitive(s, generic),
  };
}

/**
 * 常见多段有效后缀(eTLD),用于计算注册域时多保留一段。非穷举,只覆盖高频场景;
 * 未命中的按「末两段」处理即可(始终丢掉子域 → 不会泄露子域里的密钥)。
 */
const MULTI_PART_TLDS = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "com.au", "com.br", "com.hk", "com.tw", "com.sg", "co.jp", "co.kr",
]);

/**
 * 取注册域(丢掉所有子域):隧道/预签名场景**主机名本身就是密钥**(如 ngrok 随机子域、
 * 预签名 bucket 名),故只保留 eTLD+1。多段后缀(com.cn/co.uk 等)多保留一段。
 * 纯 IPv4 原样返回。
 */
function registrableDomain(host: string): string {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return host; // IPv4 原样
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const last2 = labels.slice(-2).join(".");
  const keep = MULTI_PART_TLDS.has(last2) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/**
 * 工具 → 摘要提取策略(allowlist)。未列出的工具(含 MCP、未知工具)一律**不显示摘要**,
 * 杜绝把任意参数直渲到群卡片的泄露面。
 */
type SummaryStrategy = "path" | "shell" | "url" | "query" | "enum";

/**
 * `process` 工具的动作白名单。
 *
 * 它此前映射到 `"shell"`,而 shell 策略读的是 `command`/`cmd` —— `process` 根本没有这两个字段
 * (它的参数是 `action` + `sessionId` 等),于是这个工具的摘要**恒为空串**。实测
 * `{action:"kill",sessionId:"x"}` → `""`。
 *
 * 取值抄自 vendored 的 `openclaw/dist/bash-tools.schemas-*.js`,而那里 `action` 声明的是
 * `Type.String`,枚举只写在 description 里、**并不被 schema 强制**。所以这里按白名单渲染:
 * 认得的动作原样显示,认不出的返回空串(退回只显示工具名)。上游新增动作时的失败模式是
 * **少显示一个词**,不是渲染出未知内容 —— 这是刻意选的那一侧,`openclaw` 的依赖声明是
 * `^2026.6.9` 这样的范围,不是 pin。
 */
const PROCESS_ACTIONS = new Set([
  "list", "poll", "log", "write", "send-keys", "submit", "paste", "kill", "clear", "remove",
]);

/** enum 策略:只渲染白名单内的动作名。 */
function summarizeEnum(p: Record<string, unknown>, allowed: ReadonlySet<string>): string {
  const raw = firstString(p, ["action"]).trim();
  return allowed.has(raw) ? raw : "";
}
const SUMMARY_STRATEGY: Record<string, SummaryStrategy> = {
  read: "path", write: "path", edit: "path", apply_patch: "path", ls: "path", find: "path", glob: "path",
  exec: "shell", bash: "shell", shell: "shell", process: "enum",
  fetch: "url",
  web_search: "query", search: "query", grep: "query",
};

/**
 * 深路径智能压缩 —— 保留末 2 段(倒数第二段 + 文件名),前缀省略号。
 * 段数 ≤ 3 时原样返回(信息量不大,压缩反而丢上下文);
 * 末段(文件名/最深目录)永远完整,防止只见 `.../SKILL.md` 分不出是哪个 skill。
 *
 * 例:
 *   /root/.openclaw/workspace/octo-server/modules/bot_api/send.go → …/bot_api/send.go
 *   /work/README.md                                                → /work/README.md (未压缩)
 *   docs/card-protocol.md                                          → docs/card-protocol.md (未压缩)
 *
 * 家目录/绝对根不做特殊 `~` 标记,保持规则简单一致。空路径原样返回。
 */
function shortenPath(p: string): string {
  if (!p) return p;
  // 用 posix 分隔符做主判定;Windows `\` 若出现也能处理,但 shell/工具场景以 posix 为主。
  const segs = p.split("/").filter((s) => s.length > 0);
  if (segs.length <= 3) return p;
  return `…/${segs[segs.length - 2]}/${segs[segs.length - 1]}`;
}

/** 取 keys 中首个非空字符串值。 */
function firstString(p: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

/**
 * shell 里能结束一个词的字符。给下面的赋值折叠正则与两条 URL 正则划边界。
 *
 * `/` 与 `=` 都**不在**集合里:`sed 's/DEPLOY_KEY=v/x/'` 里的赋值属于 sed 脚本文本、不是赋值位;
 * 而排除 `=` 会让 `TOKEN_URL=http://x?a=b` 的值在第二个 `=` 处断开、尾段 `=b` 留在渲染串里。
 */
const SHELL_BREAK = "\\s'\"(;|&`<>)";

const PROGRAM_TOKEN_RE = /^[A-Za-z0-9_./@:+-]+$/;
/**
 * `user:pass@host` 形状的 token —— **不是程序名**,是凭据。
 *
 * `PROGRAM_TOKEN_RE` 的字符类里 `:` 和 `@` 都在,所以一个 DSN 能当程序名渲染出去。main 上这
 * 通常撞不到,因为空白分词把带引号的值切碎、候选停在 `b'` 这种带引号的碎片上、被形状校验挡下;
 * 赋值折叠**把分词修好了**,搜索于是多走一个 token,正好落到 DSN 上:
 *
 *     X='a b' user:hunter2@localhost      main ""  →  折叠后 "user:hunter2@localhost"
 *
 * 底下那个凭据形状是 UNFIXED 里那一类(单标签主机,归约要求带点),折叠没有开新口,但它扩大了
 * 可达面 —— 而"折叠结果永不渲染,所以最多让卡片空白"这句话正是因此不成立:折叠不渲染自己,
 * 它改变**选中哪个 token**,而选中的那个是原样渲染的。
 *
 * 带 scheme 的要排除掉:`mysql://root:hunter2@10.0.0.5:3306/prod` 由第 1 趟 `new URL()` 归约成
 * `mysql://10.0.0.5`,那是正确输出,不该在这里被打成空白。这条只管**无 scheme** 的形状 ——
 * 也正是归约够不着、会原样渲染出去的那一类。
 *
 * **按最后一个 `@` 判定,和 pass 3 一致。** 第一版写成正则 `[^@]*:[^@]*@`,而 `[^@]*` 跨不过
 * `@`,于是它要求冒号在**第一个** `@` 之前 —— 可 SCHEMELESS_USERINFO_RE 的注释写得很清楚:
 * 「密码可含 `@`,按最后一个 `@` 分隔主机」。两条规则一分岔,用户名里带 `@` 的 DSN(Azure SQL /
 * MongoDB Atlas / Snowflake 都是这个形态)就整类走过去:
 *
 *     X='a b' alice@corp.com:hunter2@localhost     main ""  →  原样渲染
 *     X='a b' alice@corp.com:p/w@db.example.com    main ""  →  原样渲染
 *
 * 这正是本分支反复犯的那一个错:第二张表本该照着第一张写,却没有。
 *
 * 用下标而不是正则,还顺带解决了代价:`[^@]*:[^@]*@` 在「冒号密集、没有 `@`」的 token 上是
 * 二次的,而 summarizeShell 跑在**归约那道界之上**,`REDUCE_INPUT_MAX` 管不到它 ——
 * `":"×131072` 实测 19 077 ms(main 4.3 ms)。indexOf/lastIndexOf 是线性的。
 *
 * (summarizeShell 现在自己设了界,那条超长 token 走不到这里;但线性的实现仍然是对的 ——
 * 界是第二道防线,不该让这个函数的正确性依赖调用方喂了多少。)
 */
const TOKEN_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
function isDsnShapedToken(t: string): boolean {
  if (TOKEN_SCHEME_RE.test(t)) return false;
  const host = t.lastIndexOf("@");
  if (host <= 0) return false;
  const colon = t.indexOf(":");
  return colon >= 0 && colon < host;
}
const ASSIGNMENT_TOKEN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * shell **词**的组成单元。一个词是若干这样的段**拼接**而成的,段与段之间不需要分隔符 ——
 * `a"b"c'd'` 在 shell 里是一个词,不是四个。写成「段的重复」而不是「段的单选」,引号才能在词的
 * 任意偏移处生效,而不只是紧跟 `=` 的第 0 位。
 *
 * 引号分支都认转义(`(?:\\.|[^'])*`);闭合引号可选(`'?` / `"?`),未闭合时吃到串尾。
 * `$(…)` 与反引号单列,否则 `(` 和反引号(都在 SHELL_BREAK 里)会把词截断。
 * 每个分支都至少吃一个字符,不会空转。
 */
const SHELL_WORD_ATOM =
  `'(?:\\\\.|[^'])*'?`               // '…'
  + `|"(?:\\\\.|[^"])*"?`            // "…"
  + `|\\$\\((?:\\\\.|[^)])*\\)?`     // $(…) 命令替换
  + `|\`(?:\\\\.|[^\`])*\`?`         // `…` 命令替换
  + `|(?:\\\\.|[^${SHELL_BREAK}])+`; // 裸段,含反斜杠转义

const ASSIGNMENT_VALUE_RE = new RegExp(
  `(^|[${SHELL_BREAK}])([A-Za-z_][A-Za-z0-9_]*)=(?:${SHELL_WORD_ATOM})*`,
  "g",
);

/**
 * 仅用于**定位程序名**:把每个赋值的值折叠成单 token。折叠结果永不进入渲染,所以这里不存在
 * 误杀问题 —— 折过头最多让程序名取不到、卡片少显示一个词。
 */
function foldAssignmentValues(cmd: string): string {
  return cmd.replace(ASSIGNMENT_VALUE_RE, (_m, lead: string, name: string) => `${lead}${name}=_`);
}

/**
 * shell:只取程序名。跳过前缀式环境变量赋值(`VAR=value cmd ...`)—— 否则会把密钥值
 * (如 `SLACK_WEBHOOK=https://…`、`MY_CREDS=xxx`)当成程序名原样渲染,且这类变量名多不含
 * token/secret 等关键词,躲过 SECRET_RE。不渲染任何参数。
 *
 * 落定的 program token 再过一层保守形状校验:只接受 `[\w./@:+-]`(程序名/路径的合法字符),
 * 含引号/空格/等号等异常字符的 token 一律判为可疑值片段 → 不展示。
 */
function summarizeShell(p: Record<string, unknown>): string {
  // **自己设界。** 这一步跑在归约那道界**之上**(见 summarizeToolParams:先取程序名,再折叠归约),
  // 所以 REDUCE_INPUT_MAX 管不到它,而下面的 foldAssignmentValues + split 都按整串长度走:
  // 4 MB 的 command 实测 91 ms。程序名必定在头一段里,后面再长也影响不到结果。
  // 切口走 cutOnWhitespace —— 盲切会把程序名切成半截(`docker` → `doc`)渲染出去;
  // 窗口内没有空白说明这是一个 4000 字符以上的单 token,不可能是程序名,返回空。
  const bounded = cutOnWhitespace(firstString(p, ["command", "cmd"]), REDUCE_INPUT_MAX);
  const cmd = (bounded ?? "").trim();
  if (!cmd) return "";
  // 先折叠赋值,再按空白取程序名。直接空白分词会把带引号的多词值切碎,跳过首个片段后落在值的
  // **第二个**词上,而那个词往往不含异常字符、能通过 PROGRAM_TOKEN_RE:
  //
  //     PASSPHRASE='correct horse battery staple' gpg --sign x   →   horse
  //     MY_CREDS='alpha hunter2 charlie' ./go                    →   hunter2
  //
  // 这类变量名(PASSPHRASE/CREDS/DEPLOY_KEY)恰好是 SECRET_RE **没有**的,关键词守卫救不回来。
  const tokens = foldAssignmentValues(cmd).split(/\s+/);
  let i = 0;
  while (i < tokens.length && ASSIGNMENT_TOKEN_RE.test(tokens[i])) i++;
  const prog = tokens[i] ?? "";
  if (!PROGRAM_TOKEN_RE.test(prog) || isDsnShapedToken(prog)) return "";
  return prog;
}

/**
 * URL → `scheme://注册域`。丢弃 path/query/userinfo **和所有子域**:凭据既可能在 query,
 * 也常整段嵌在 path 里(Slack/Discord webhook `/services/T../B../XXXX`),更有隧道/预签名
 * 场景**主机名本身即密钥**(ngrok 随机子域、预签名 bucket 名)—— 这些随机串不含关键词、躲过
 * SECRET_RE。故只暴露注册域(eTLD+1)。解析失败返回 null(原串可能含 token,调用方丢弃)。
 */
function originDomain(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    return `${u.protocol}//${registrableDomain(u.hostname)}`;
  } catch {
    return null;
  }
}

/** 协议相对 URL(`//host/path`):按 https 处理。 */
const PROTOCOL_RELATIVE_RE =
  /(^|[^A-Za-z0-9/:])\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?::\d+)?(?:\/[^\s]*)?/g;
/**
 * 无 scheme 的 userinfo DSN(`user:pass@host[:port][/path]`):userinfo 即明文口令。
 * 密码可含 `@`,按最后一个 `@` 分隔主机。
 *
 * **单标签主机、IPv6、口令带 `/` 都覆盖。** 这四种形状此前挂在 `UNFIXED_CORPUS` 上 ——
 * 归约够不着,守卫也认不出,于是 `user:hunter2@localhost` 原样渲染进群卡片。
 *
 * 关掉它们不是为了补一个洞,是为了让**一句话成立**:这条管线一直声称「渲染的永远只有 kept,
 * 而 kept 自己要过守卫」。只要单标签 userinfo 还在 UNFIXED 里,这句话就是假的 —— kept 可以
 * 装着明文口令大摇大摆走过守卫。评审两轮指出:前提是假的,那么「尾部扫描能伸多远」这个界
 * 放在哪里都是泄漏而不是取舍,因为无论界在 4000 还是 131072,总有一个更远的位置。
 * 收窄了三次都没关掉,第四次该改的是前提。
 *
 * 放宽会踩两个坑 —— 造串,和小写化泄漏。**它们由下面 pass 3 里那条「归约出的主机必须逐字
 * 出现在 host 里」的检查一并关掉,不在这条正则上解决。** 那才是承重的机制,说明写在检查那里。
 *
 * 这条正则里唯一为「坑」而写的是末尾的 `(?![A-Za-z0-9-])(?!:\d)`:要求匹配停在 token 边界上,
 * 且冒号后不是数字。它挡的是 `nginx:1.21@sha256:1234` 被切在词中间(sha256 的冒号接的是数字),
 * 而放行 `user:pw@localhost: refused`(冒号接的不是数字)—— 后者是 DSN 在错误串里最常见的写法。
 * **早先这里写的是 `(?![A-Za-z0-9:-])`,把冒号一律排除,于是那个最常见的形状整条匹配不上、
 * 口令原样渲染;评审第四轮点出。** `(?!:\d)` 才是那条规则的准确表述。
 *
 * 造串曾经试过用「单标签必须含字母 / 带点分支不受影响」来挡 —— **那个说法是错的,评审证伪:**
 * 前瞻会让带点分支回退成纯数字主机,`new URL()` 照样把它规范成输入里没有的地址。所以不靠
 * 分支形状,靠逐字比对(见 pass 3)。
 *
 * 代价是几种误伤,方向安全(少渲染)、不造串,记在 REWRITE 组里:`at 10:30@venue` →
 * `at https://venue`,`com.foo:bar:1.0@jar` → `https://jar`。误伤面比两行宽 ——
 * `word:number@word` 与 `word:word@word` 在工具输出里都常见,详见 README。凭据泄漏在群可见
 * sink 上,这笔换得起。
 *
 * **口令段有长度上限 256,那是为了不引入一条新的二次方。** 旧版口令写作 `[^\s/]+`,`/` 把
 * 长串切成短段;放开 `/` 之后,`a:b/c/a:b/c/…` 这种无 `@` 的长 token 上,每个起点都要扫到
 * token 末尾再回退 —— 实测 4000/16000/64000 字符是 5.0/74.9/1245.8 ms,干净的二次方,
 * 而旧版是平的 0.1 ms。加上限之后 1.3/4.7/17.5 ms,回到线性。
 * 代价:口令超过 256 字符的 DSN 不再被归约。那个长度本身已经是高熵串,交给守卫 ——
 * `LEAK_CORPUS` 里 3995 字符口令那两行正是这一类,它们靠守卫扣下,不靠归约。
 */
const SCHEMELESS_USERINFO_RE =
  /\b[A-Za-z0-9._%+-]+:[^\s]{1,256}@(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|[.\u002d\p{L}\p{N}]+)(?::\d+)?(?:\/[^\s]*)?(?![A-Za-z0-9-])(?!:\d)/gu;

/** 任意无 scheme 的 `host.tld/path`:path 常承载 webhook token、签名或对象凭据。 */
const SCHEMELESS_HOST_PATH_RE =
  /(^|[^A-Za-z0-9@._/:+-])([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?::\d+)?\/[^\s]+)/g;

/** 缺省谓词取最严的一档:不知道调用方是谁时,宁可过度隐藏。 */
const DEFAULT_SENSITIVE: SensitivePredicate = sensitivePredicate(true);

/**
 * 被丢掉的那一段是否敏感。**两处尾部扫描共用这一份** —— 折叠那一处和归约那一处。
 *
 * 分档的理由和数字见 JWT_RE:线性档看整条尾巴(和 main 一样),只有 JWT 那一档收进
 * TAIL_SCAN_MAX 的窗口。上一版对整个守卫设界,于是
 *
 *     "alice:hunter2@localhost " + "word "×900 + "pad "×1300 + " token"
 *
 * 里那个 4000 字符之外的 `token` 不再压住整串,而 `alice:hunter2@localhost` 是本仓
 * `UNFIXED_CORPUS` 里记着的、守卫**抓不住**的形状 —— 于是明文口令渲染进了群卡片。
 * 「渲染的永远只有 kept,而 kept 自己要过守卫」这句话,前提是守卫抓得住 kept 里的东西。
 */
function tailIsSensitive(tail: string, p: SensitivePredicate): boolean {
  if (!tail) return false;
  // 线性档吃**原文**。折叠只有有界档需要:它的窗口只有 TAIL_SCAN_MAX 那么大,折叠比高时
  // 4000 个原始字符可能全是空白,不折叠就什么也扫不到。而线性档看的是整条尾巴 —— 关键词与
  // 前缀正则本来就与空白无关,高熵那条找的是连续串、折叠也不会把两段接起来。
  //
  // 这不只是省一次遍历。尾巴现在**无界**(见两个调用方去掉窗口的那段说明),先折叠一遍等于
  // 为每次调用多分配一份整条尾巴的副本:实测 4 MB 散文经 neutralizeEcho,折叠 206 ms、
  // 不折叠 78 ms,而 def63bb 是 69 ms —— 折叠那一版比 merge-base 慢 3 倍,是本 PR 自己
  // 「不许比 base 慢」那条底线踩不过去的地方。
  //
  // 顺带把两个调用方对齐:collapseForReduction 此前先折叠再传,boundedForReduction 传原文 ——
  // 又是同一条规则的两份拷贝,而且只有一份是对的。现在两边都传原文,折叠只在这里做一次。
  if (p.linear(tail)) return true;
  const win = tailScanWindow(tail, 0, TAIL_SCAN_MAX);
  return win === null || p.bounded(win.replace(/\s+/g, " ").trim());
}

/**
 * 界丢掉的那一段,最多喂给谓词多少字符。见 boundedForReduction 里那段说明 ——
 * 谓词里的正则不保证线性,所以喂进去的量必须自己有界。
 */
const TAIL_SCAN_MAX = REDUCE_INPUT_MAX;

/**
 * **按长度截断的唯一实现。** 切口只能落在空白上:归约靠锚点定位,盲切会把锚点切掉,于是本该
 * 被剥掉的凭据原样留下;窗口里没有空白就返回 null,由调用方 fail closed。
 *
 * 这个函数存在的理由不是复用,是**消灭第二份**。这条分支上反复出现的缺陷是同一类 ——
 * 「第二处该镜像第一处的规则,没镜像上」:兜底正则的字符类与归约的分岔、DSN token 取第一个
 * `@` 而第 3 趟取最后一个、`collapseForReduction` 写成裸 slice。每次都是把规则**又写了一遍**
 * 而不是**用同一份**。三个截断点(64 KiB 折叠、4000 归约界、shell 程序名)现在共用这一份。
 */
export function cutOnWhitespace(s: string, max: number): string | null {
  if (s.length <= max) return s;
  // +1:空白正好落在下标 max 时也要找得到,否则那一位被当成"窗口内无空白"。
  const cut = s.slice(0, max + 1);
  const lastSpace = cut.search(/\s\S*$/);
  return lastSpace < 0 ? null : cut.slice(0, lastSpace);
}

/**
 * 取 `s` 从 `from` 起、约 `max` 个字符喂给敏感判定。**窗口末端也只能落在空白上。**
 *
 * 上一版这里是裸 `slice`,于是跨过窗口边界的 token 被切成碎片、正则匹配不上,等于没扫:
 * `AKIAIOSFODNN7EXAMPLE` 起点落在 7986 时窗口只盖住 20 个字符里的 14 个,而
 * `/AKIA[0-9A-Z]{12,}/` 要 16 个 —— 于是 base 掩掉的输入在这里照渲。
 *
 * 方向必须是**往前延**,不是往回缩:缩到上一个空白会把那个 token 整个排除在窗口外,漏得更多。
 * 延长再多给 `max` 个字符;还找不到空白就说明尾巴是一整块无空白 token —— 返回 null,fail closed。
 */
function tailScanWindow(s: string, from: number, max: number): string | null {
  if (from >= s.length) return "";
  const end = from + max;
  if (end >= s.length) return s.slice(from);
  // `max + 1` 与 cutOnWhitespace 同一条边界约定:空白正好落在窗口末端那一位时也要找得到。
  // 上一版这里是 `end + max`,于是空白恰好在 `end + max` 的输入被判成「没有空白」→ fail closed。
  // 方向安全,但**这条 PR 的论点就是两条截断规则同源不会分岔,而边界约定正是它们唯一还在
  // 分岔的地方** —— 评审点出来的,对。
  const ws = s.slice(end, end + max + 1).search(/\s/);
  if (ws >= 0) return s.slice(from, end + ws);
  // 延长窗口里没有空白,但它已经吃到串尾 —— 那个 token 到此为止,整段收进来就是完整的,
  // 长度仍然有界:**≤2×max + 1**(不是 2×max —— 延长窗口自己是 `max + 1` 长,吃到尾时整段
  // 都还回去,评审量到过 8001)。预算按这个长度计价,所以这个 +1 也进了账,无害但要说准。
  // 第一版这里直接 fail closed,把「尾巴只比窗口多 1 个字符」也判成超长 token,
  // `"x X=" + "'a"×1999` 这类本该跑完管线的输入被整块拒掉。
  return end + max + 1 >= s.length ? s.slice(from) : null;
}

/**
 * 归约之前那一步空白折叠的输入上限。
 *
 * `REDUCE_INPUT_MAX` 管的是管线,但把文本送进管线之前先要对**原串**折叠空白,而那一步没有
 * 任何上限。实测(4 MB,同一台机器,形状不同差三倍):
 *
 *     普通散文  62 ms/MB    制表对齐  78    单空格密集  92    多空格密集  32
 *
 * 界救不了它,因为它跑在界之前 —— `sanitizeErrorText` 吃 4 MB 要 493 ms,而 200 个 1 MB 的
 * 块要 6673 ms。
 *
 * 取 64 KiB。**它不是"对输出中性"的** —— 上一版这么写,而且据此把切口写成了裸 slice,结果
 * 在折叠比高的输入上把归约的锚点切掉、渲染出完整口令。真实的性质弱一些,但足够:
 *
 *   - 切口**只落在空白上**(`cutOnWhitespace`),所以不会把 token 切开、不会切掉锚点;
 *   - 被丢掉的那一段**要过一遍调用方的谓词**(见下面的实现)。这一条是推送前的对抗评审补上的:
 *     上一版只镜像了 `boundedForReduction` 的切口规则,没镜像它的尾部守卫,于是
 *
 *         `user:hunter2@localhost ` + ("x" + " "×23)×3000 + ` y token`
 *
 *     里那个把整串压住的 `token` 落在 64 KiB 之外被切掉,base 渲染 `""`,而这里渲染出
 *     `user:hunter2@localhost` —— 一个**为了性能加的截断,自己变成了泄漏路径**。
 *   - 折叠比高时(大量连续空白、对齐排版),64 KiB 原文可能只折出几千字符,此时后面的内容
 *     **会**被丢掉。方向是安全的(少渲染),但它是一处真实的可用性代价,不是"不改变输出"。
 */
export const RAW_INPUT_MAX = 64 * 1024;

/**
 * 折叠空白,并且**先把原串收进上限**。
 *
 * 三个把未截断文本送进管线的 sink 走它:`sanitize`(展示卡)、`sanitizeErrorText`、
 * `summarizeToolParams`。`reasoning-process` 与 `card-display-tool` 仍各自写着
 * `replace(/\s+/g, " ")`,但它们的输入在上游已有上限(思考文本 4000、debug 串 512),
 * 或者折叠跑在归约**之后**、面对的已是 ≤4000 的串 —— 逐个查过,不是遗漏。
 */
export function collapseForReduction(
  text: string,
  isSensitiveHere: SensitivePredicate = DEFAULT_SENSITIVE,
): string {
  const kept = cutOnWhitespace(text, RAW_INPUT_MAX);
  if (kept === null) return "";
  const collapsed = kept.replace(/\s+/g, " ").trim();
  if (kept.length === text.length) return collapsed;
  // 丢掉的那一段也要过谓词 —— 与 boundedForReduction 同一条规则。**尾巴是原文,先折叠再看**:
  // 折叠比高时(这个上限存在的理由就是它)4000 个原始字符可能全是空白,直接喂进去什么也扫不到。
  //
  // **整条尾巴,不开窗。** 上一版这里是 `tailScanWindow(text, kept.length, RAW_INPUT_MAX)`,
  // 于是超过 `2 × RAW_INPUT_MAX` 的扣留信号任何一档都看不见(评审第十轮 P0-1)。
  // 那个窗口在 boundedForReduction 里是无害的 —— 它的输入已经 ≤RAW_INPUT_MAX,窗口覆盖全部;
  // 而**本函数的输入无界**,同一行代码在这里就变成了一道缺口。`def63bb` 没有这道窗口:它折叠
  // 整串、把整个剩余部分交给守卫。分档在 tailIsSensitive 里 —— 线性档看整条,JWT 那档才开窗。
  //
  // 代价是线性扫描不再有界,所以它必须**计价**:见 card-blocks 的 metered.linear。
  return tailIsSensitive(text.slice(kept.length), isSensitiveHere) ? "" : collapsed;
}

/**
 * 超长输入的截断:**切口只能落在空白上**,切不到就整串不渲染。
 *
 * 上一版是 `s.slice(0, REDUCE_INPUT_MAX)` —— 盲切。它自己就是一条泄漏路径:下面几趟归约靠
 * **锚点**定位,而盲切会把锚点切掉,于是本该被归约掉的凭据原样留下。最直接的一例是
 * SCHEMELESS_USERINFO_RE 要 `@带点主机`:
 *
 *     "alice:" + "h"×3995 + "@db.example.com"
 *       main   https://example.com          ← userinfo 被剥掉
 *       盲切   alice:hhhhhhhh…              ← 切口落在口令和 @host 之间,归约不匹配
 *
 * 而且**不限于没有渲染上限的 sink**:口令本身长时,存活前缀从 offset 0 开始,摘要的 64 字符
 * 和错误的 120 字符上限都挡不住,进度卡直接渲染凭据。偏移是可选的 —— 任何口令长度都存在一个
 * 让它整个活下来的填充长度。
 *
 * 切在空白上,token 就永远不会被切开,这一类由构造消失。它同时收掉另外两件:
 *  - 横跨切口的密钥被切成两半、`isSensitive` 认不出那个片段(card-blocks 那道预检因此从承重
 *    降级为保险);
 *  - UTF-16 代理对被从中间切开、留下孤立代理。
 *
 * **切不到空白 → 返回空串**,而不是退回盲切。付出的代价是真实的,而且比"无法归约的怪串"更宽:
 * 一条 4000 字符以上的无空白 URL 也走这条路,`main` 会把它归约成注册域,这里整块丢掉。
 * 代价钉在 `COST_CORPUS`,取舍见下面 reduceUrlsInText 里那段「为什么第 1 趟不能提到界之上」。
 *
 * 搜索范围取 `REDUCE_INPUT_MAX + 1` 而不是 `REDUCE_INPUT_MAX`:空白**正好落在下标 4000** 时,
 * 前 4000 字符已经是一个完整的、token 边界对齐的前缀,取 4000 会把它连同整串一起拒掉。
 * (`"a"×4000 + " " + "b"×100` 曾整串不渲染,而 `"a"×3999 + " " + …` 正常留下 3999 字符。)
 * 多取的那一个字符只用于**发现**切点,不会进入结果 —— 返回值长度恒 ≤ REDUCE_INPUT_MAX。
 *
 * **被丢掉的那一段要过一遍调用方自己的守卫。** 切开 token 不是界唯一能造成的伤害:守卫读的是
 * **截断后**的串,所以界还能把「正在压住一个凭据的那个关键词」一起删掉,让本该 fail-closed 的
 * 输入变成看起来干净的输入:
 *
 *     "user:hunter2@localhost " + "x "×1988 + "y token"      (4006 字符)
 *       main   ""                       ← 尾部的 `token` 命中 SECRET_RE,整串扣下
 *       无此守卫  "user:hunter2@localhost x x x…"  ← ` token` 被切掉,剩下的在守卫眼里干净
 *
 * 凭据在 offset 0,所以摘要 64 / 错误 120 的渲染上限一个都挡不住。
 *
 * 判定必须是**调用方自己那一个**,不能写死。实测 main 的行为本身就按策略分岔 —— 同一个尾部
 * 长 hex,`grep`(generic=true)扣下、`read`(generic=false)渲染。写死 `true` 会把 git SHA /
 * docker digest 结尾的普通长文本打空(main 渲染),写死 `false` 又漏掉纯高熵尾巴(main 扣下)。
 * 传进来的是**同一个函数**,所以这道守卫和下游那道不会在"用哪套规则"上分岔。
 *
 * 只查**被丢掉的那一段**,不查整串:整串查会把归约本该救回来的内容打空 —— 一段以 webhook
 * 开头、后接 900 个普通词的文本,整串查是 null,只查尾巴仍渲染 4000 字符。
 *
 * **这道守卫比下游那道严,这是明知故犯的。** 它跑在归约**之前**,看到的是原文;下游那道跑在
 * 归约之后。于是尾巴里一条普通文档链接(路径 ≥32 字符、含 `/`)会命中 hasGenericSecretShape,
 * 而它在下游是被归约掉、根本看不见的。代价真实:
 *
 *     "connection refused after 3 retries " + "word "×900 + "see https://docs.example.com/…"
 *       main  "connection refused after 3 retries word word…"(121 字符)
 *       这里  ""
 *
 * 看起来的修法是「尾巴也先定界再归约,然后才判」。**实测它会开一个新泄漏**:尾巴自己超过 4000
 * 时,定界会把尾巴的尾巴也切掉,而 main 是看得到那一段的 ——
 *
 *     "word "×900 + "pad "×1100 + "AKIAIOSFODNN7EXAMPLE"   密钥在尾巴的第 4901 位
 *       查整条 raw 尾巴        isSensitive=true   ← 抓到
 *       尾巴先定界再归约        isSensitive=false  ← 漏掉
 *
 * 用可用性换泄漏是这条管线不做的交易,所以守卫维持查原文。代价钉在 COST_CORPUS。
 *
 * **但扫多长是有界的(TAIL_SCAN_MAX)。** 上一版把整条尾巴喂给谓词,而谓词里的 JWT 正则
 * `eyJ…{8,}\.…` 在**没有点的长串**上是二次的:`eyJ` 每出现一次都是一个起点,每个起点都要
 * 贪心扫到串尾再逐字符回退找 `.`。于是这道守卫自己成了它要防的那种停顿 ——
 * 单个 block 实测,计费只收 4000 却:
 *
 *      15 KB     90 ms
 *      30 KB    354 ms
 *      60 KB   1404 ms
 *     120 KB   5710 ms      ← 干净的 4× 每翻倍
 *
 * 修法不是去改那条正则(这条分支已经证明追着正则改会一直有下一个),而是**限定喂给它的量**:
 * 与界本身同一个数,4000 字符。
 *
 * 这条规则要能说出口:**切口之后 4000 字符以外的凭据,不再导致前面那段安全内容被一起扣下。**
 * 它不会让凭据被渲染出来 —— 渲染的永远只有 kept,而 kept 自己要过下游那道守卫。被放弃的只是
 * 「因为远处有东西,所以连近处也不显示」这一层 fail-closed。
 */
export function boundedForReduction(
  s: string,
  isSensitiveHere: SensitivePredicate = DEFAULT_SENSITIVE,
): string | null {
  const kept = cutOnWhitespace(s, REDUCE_INPUT_MAX);
  if (kept === null) return null;
  if (kept.length === s.length) return kept;
  // **整条尾巴,不开窗** —— 与 collapseForReduction 同一条规则,分档在 tailIsSensitive 里:
  // 线性档看整条,只有 JWT 那档收进 TAIL_SCAN_MAX。
  //
  // 上一版这里是 `tailScanWindow(s, kept.length, RAW_INPUT_MAX)`,注释写着「线性档要看完整条」
  // —— 那句话只在「输入已经 ≤RAW_INPUT_MAX」时成立,而**本函数是整条管线的唯一入口**:
  // `reduceUrlsInText` 把调用方的原串直接交给它。`neutralizeEcho`(表单回显,本文件里信任
  // 边界最低的一路)就是这样,于是超过 `2 × RAW_INPUT_MAX` 的关键词在那一路仍然看不见 ——
  // 评审第十轮 P0-1 在 collapseForReduction 那边修掉之后,这 22 组还留在 echo 上。
  // 同一句注释在两个函数里各写了一遍,而只有一处的前提成立:又是「第二份没镜像上」。
  const rawTail = s.slice(kept.length);
  return tailIsSensitive(rawTail, isSensitiveHere) ? null : kept;
}

/**
 * 把文本里内嵌的 URI 就地降级为 scheme://注册域(解析失败则整段抹除)。
 *
 * **为什么第 1 趟不能提到界之上。** 界跑在第 1 趟之前,代价是一条超长无空白 URL 被整块丢掉,
 * 而不是归约成注册域(`COST_CORPUS`)。看起来很自然的修法是「先跑第 1 趟再定界」—— 第 1 趟由
 * `new URL()` 驱动,而且会**缩小**输入,所以直觉上它无界也便宜。**实测不是。** 第 1 趟的正则
 * `[a-z][a-z0-9+.-]*://…` 在**串里找不到 `://` 时**是二次的:scheme 字符类要在每个起始位置
 * 贪心吃完整个 token、再逐字符回退找 `://`。单独测这一趟(不含其余几趟):
 *
 *       4 000 字符无 `://`         18 ms
 *      10 000                     104 ms
 *      20 000                     415 ms
 *     100 000                   10 877 ms
 *
 * 便宜的只是**含 `://`** 的形状(120k 字符 1.25 ms)—— 而 `input.includes("://")` 也救不了:
 * `"a"×100000 + " http://x.com"` 含 `://`,仍然 10 580 ms,因为回溯发生在扫到它之前。
 * 也就是说,把第 1 趟提到界之上,等于把本 PR 修掉的那个 9–11 秒停顿原样放回来,触发条件还更
 * 宽松(任意超长无空白 token,不需要任何 URL 语法)。所以界留在最前面,代价记在文档和语料里。
 */
export function reduceUrlsInText(
  input: string,
  isSensitiveHere: SensitivePredicate = DEFAULT_SENSITIVE,
): string {
  // 截断先于管线 —— 这里是这条管线的**唯一**入口,所以上限也只该有这一处;放在任何一个调用方
  // 里都只挡住那一个调用方。`isSensitiveHere` 是调用方下游那道守卫,界用它检查自己丢掉了什么。
  const s = boundedForReduction(input, isSensitiveHere);
  if (s === null) return "";
  // 超限 userinfo 必须在**归约之前**查。口令含 `/` 时,归约会在口令中间找到一个重启点
  // (`…/x:b@host`),把原来那个真正超限的 `@` 吃掉;等归约跑完,post-reduction 的
  // hasOverlongUserinfo 已经看不到那个 `@` 了(评审第八轮 P1-b)。在原串上查一次,与 main 一致
  // (main 同样整行扣下),而且方向只会更严。
  if (hasOverlongUserinfo(s)) return "";
  // 归约会**删掉**它匹配的 span。如果那个 span 里有一个正压着整行的关键词/前缀,而这一行在
  // main 上本来是靠它整行扣下的,删掉之后剩下的部分(可能含口令的另一份副本)就渲染出来了 ——
  // 评审第八轮的 P1-a:`credential:tok@vault retry with tok`,main 扣下,本分支渲染
  // `https://vault retry with tok`。**只发生在 main 没归约、而本分支新归约的那些 host 形状上**
  // (main 的 pass 3 只认带点 host);带点的 main 也归约,两边一致,不在此列。
  // **两个判据都直接问,不再自己建模。** 上一版把它们写成了手工近似,两处都错了(评审第九轮):
  //
  //   - 「main 会不会归约这一段」曾写成 `/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(host)` ——
  //     只复刻了 main pass 3 的 **host** 半边,漏掉它的口令类 `[^\s/]+` **不含 `/`**。于是
  //     「口令含 `/`」整类被判成「main 也归约」,poison 不触发:
  //     `credential:pa/ss@db.example.com retry with pa/ss` main 扣下、本分支渲染出 `pa/ss`。
  //     实测这一类 120 条 sink 级回归、45 个不同输入。现在直接拿 main 那条正则逐字来判。
  //   - 「这一段带没带信号」曾写死 `hasLinearSecretShape(m, false)`,丢掉了 generic 高熵档 ——
  //     而调用方自己的谓词就在作用域里。理由曾写成「高熵那份在被删的 span 里、删掉即消失」,
  //     那是**假的**:外部副本可以是被删长串的**子串**,自身短于 32 字符触发不了高熵检测 ——
  //     `user:<36字符>@vault retry with <其中12字符>`。用 isSensitiveHere 就没有这个缺口。
  let poisoned = false;
  const poisonIfNewShapeCarriesSignal = (m: string, _host: string): void => {
    // **`.exec()[0] === m`,不是 `.test(m)`。** 要问的是「main 会不会归约**这一段**」,而
    // `test` 回答的是「main 的形状在这段里出现过没有」—— 嵌一个 base 能归约的 DSN 进去就能
    // 压掉 poison:`credential:pw/u:p@a.example.com@vault retry with pw`,base 扣下、本分支
    // 渲染出 `pw`(评审第十轮 Q2)。这里不另写一条带锚的正则 —— 「第二份该镜像第一份的规则
    // 没镜像上」正是这条分支反复出问题的成因,所以仍然用同一份快照,只改提问方式。
    if (MAIN_PASS3_RE.exec(m)?.[0] === m) return;
    // **`.all` 而不是 `.linear`。** JWT_RE 住在 hasBoundedSecretShape 里,只问线性档等于说
    // 「被删 span 里的 JWT 不算扣留信号」,而 def63bb 上 JWT 属于永远生效的前缀集
    // (评审第十轮 Q3)。m 的长度由 SCHEMELESS_USERINFO_RE 自身封顶,有界档在这里不失控。
    if (isSensitiveHere.all(m)) poisoned = true;
  };
  // 1. 任意 `scheme://…`,不止 http(s):DB/AMQP/ssh DSN(postgres://user:pass@host 等)也常
  //    出现在 query/shell/错误文本里,userinfo 即明文密码。要求 `://` 故不误伤 Windows 盘符(C:/)。
  let out = s.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, (m) => originDomain(m) ?? "");
  // 2. 协议相对 `//host/path`:补 https 后降级(secret 可能在 path)。
  out = out.replace(PROTOCOL_RELATIVE_RE, (_m, p1: string) => {
    const url = _m.slice(p1.length); // 去掉前导分隔符
    return p1 + (originDomain(`https:${url}`) ?? "");
  });
  // 3. 无 scheme 的 userinfo DSN(`user:pass@host…`):只留注册域,丢 userinfo/path。
  out = out.replace(SCHEMELESS_USERINFO_RE, (m) => {
    const afterAt = m.slice(m.lastIndexOf("@") + 1);
    // IPv6 主机整段带方括号,而按 `:` 切会把 `[::1]` 切成 `[` —— `new URL("https://[")` 抛错,
    // 整条落到 `?? ""`,于是一条 IPv6 DSN 把整行打空。方向安全,但没必要:方括号里的部分
    // 本来就是完整主机,直接取到 `]` 为止。
    const host = afterAt.startsWith("[")
      ? afterAt.slice(0, afterAt.indexOf("]") + 1)
      : afterAt.split(/[/:]/)[0];
    const reduced = originDomain(`https://${host}`);
    // **归约出的主机必须逐字出现在被替换的那一段里,否则什么都不发。**
    //
    // 这一条同时关掉两类缺陷,而且是按构造关掉,不是逐个枚举:
    //
    //   1. `new URL()` 的规范化会造串。`a:b@1.2.3` → `1.2.0.3`、`scope:name@1.0.0` →
    //      `1.0.0.0`、`a:b@0x7f.1` → `127.0.0.1` —— 都是输入里没有的地址。此前只给**无点**
    //      分支加了「必须含字母」,而带点分支是同一个 new URL() 的第二条路,漏在那里;
    //      而语料的造串检测按「4 个以上字母数字连排」找,`1.0.0.0` 拆开全是单字符,看不见。
    //   2. `new URL()` 会把主机**小写**(WHATWG)。而 `AKIA…`/`AIza…` 两条探测器是大小写敏感的,
    //      于是 `a:b@AKIAIOSFODNN7EXAMPLE` 归约成 `https://akiaiosfodnn7example`,守卫再看
    //      就认不出了 —— 归约把唯一压着它的信号自己毁掉。逐字比对时大小写不同即不匹配,
    //      这条路直接断掉。
    //
    // 代价:主机大小写混写的 DSN(`user:pw@DB.Example.COM`)不再归约,整段被丢弃而不是
    // 渲染成注册域。方向安全(少渲染),而且这种写法在 DSN 里罕见。
    //
    // **比对的是 `host`,不是整段 `m`。** `m` 含 userinfo,也就是口令 —— 拿归约结果去它里面找,
    // 口令里塞一份小写主机名就能满足检查:`a:akiaiosfodnn7example@AKIAIOSFODNN7EXAMPLE` 会渲染出
    // `https://akiaiosfodnn7example`,第 2 类那条小写化泄漏原样复活。必须只在 `host` 上比。
    poisonIfNewShapeCarriesSignal(m, host);
    if (reduced === null) return "";
    return host.includes(reduced.slice("https://".length)) ? reduced : "";
  });
  // 4. 任意无 scheme 的 `host.tld/path`:保留注册域,统一抹掉可能承载凭据的 path。
  out = out.replace(SCHEMELESS_HOST_PATH_RE, (_m, prefix: string, hostAndPath: string) => (
    prefix + (originDomain(`https://${hostAndPath}`) ?? "")
  ));
  // 新归约的 host 形状里带着 main 据以整行扣下的关键词/前缀 → 与 main 一样整行扣下。
  return poisoned ? "" : out;
}

/** url 策略:取 url 参数并降级为注册域。 */
function summarizeUrl(p: Record<string, unknown>): string {
  const raw = firstString(p, ["url"]);
  if (!raw) return "";
  return originDomain(raw) ?? "";
}

/**
 * 从工具参数提取一句人可读摘要 —— 按工具 allowlist 策略取值,未知/MCP 工具不显示,
 * 命中敏感串则整串隐藏,最后折叠空白并截断。群卡片对全员可见,安全优先于信息量。
 */
export function summarizeToolParams(toolName: string | undefined, params: unknown): string {
  if (!toolName || !params || typeof params !== "object") return "";
  const strategy = SUMMARY_STRATEGY[toolName];
  if (!strategy) return ""; // MCP / 未知工具:不渲染任意参数
  const p = params as Record<string, unknown>;
  let v: string;
  switch (strategy) {
    case "path": v = shortenPath(firstString(p, ["path", "file_path", "file"])); break;
    case "shell": v = summarizeShell(p); break;
    case "url": v = summarizeUrl(p); break;
    case "query": v = firstString(p, ["query", "pattern"]); break;
    case "enum": v = summarizeEnum(p, PROCESS_ACTIONS); break;
  }
  if (!v) return "";
  // query/url 是「裸 token」易出没处 → 额外套用通用高熵/长 hex 检测;path/shell 只走关键词
  // + 明确前缀,避免把 git SHA / docker digest / 缓存哈希等正常路径误伤成空。
  const generic = strategy === "query" || strategy === "url";
  const sensitiveHere = sensitivePredicate(generic);
  // 单一 choke point:所有策略统一把内嵌 URL 降级为 scheme://注册域。避免逐 sink 加降级时
  // 漏掉某个策略(query 的 pattern、shell 的 URL-as-program 都会原样渲染 webhook/userinfo/内网主机)。
  // 输入上限住在 reduceUrlsInText 内部,这里不再重复设界(见 REDUCE_INPUT_MAX)。**同一个谓词
  // 传进去**,界丢掉的那一段就用下面这道守卫检查,两者不可能再分岔。
  // **两趟折叠都要带上谓词** —— 折叠自己会在 RAW_INPUT_MAX 处截断,被截掉的那一段要过同一道
  // 守卫,否则「压住凭据的那个关键词」被丢掉,fail-closed 的输入就变成看起来干净的输入。
  const s = collapseForReduction(
    reduceUrlsInText(collapseForReduction(v, sensitiveHere), sensitiveHere),
    sensitiveHere,
  );
  if (!s || sensitiveHere.all(s)) return "";
  return s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX) + "…" : s;
}

/** ms → 友好耗时(<1s 用 ms,否则 x.xs)。 */
export function fmtDuration(ms?: number): string {
  if (typeof ms !== "number") return "";
  // NaN/Infinity(时钟回拨、未初始化的起点)会一路穿过下面的取整,渲出 `Infinityh NaNm NaNs`。
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  // Pick the unit from the rounded value, not the raw one: `toFixed(1)` rounds up, so branching on
  // `ms < 60_000` let 59_999 render as `60.0s` — the very output the minute branch exists to avoid.
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return hours > 0
    ? `${hours}h ${minutes}m ${seconds}s`
    : `${totalMinutes}m ${seconds}s`;
}

/** 错误文本展示上限(比参数摘要略宽,但仍防多 KB 堆栈撑爆卡片)。 */
const ERROR_MAX = 120;

/**
 * 清洗工具错误文本后再渲染 —— 错误串是与参数摘要**同等**的泄露 sink:常含 stderr、
 * 失败命令输出、请求 URL/header、webhook 路径、token、文件片段,且长度不可控。清洗顺序:
 *   1. 折叠空白;
 *   2. **内嵌 URL 降级为 scheme://注册域**(与参数路径 summarizeUrl 对称)—— 否则 webhook
 *      路径/隧道主机等短、无关键词的密钥会绕过下面的 isSensitive 直接泄露;
 *   3. 关键词/明确前缀/通用高熵命中则整串隐藏。带 `commit`/`sha`/`digest` 标签的普通构建
 *      哈希先从高熵检测中排除,兼顾错误可读性与裸凭据 fail-closed;
 *   4. 截断到 ERROR_MAX。
 */
export function sanitizeErrorText(err?: string): string {
  if (!err) return "";
  // 传自己的守卫:界和折叠丢掉的那一段都用**同一个**判定检查(错误文本这道多一条构建哈希豁免)。
  let s = collapseForReduction(err, ERROR_TEXT_SENSITIVE);
  if (!s) return "";
  s = collapseForReduction(reduceUrlsInText(s, ERROR_TEXT_SENSITIVE), ERROR_TEXT_SENSITIVE); // URL 降级可能留下空隙
  if (!s || ERROR_TEXT_SENSITIVE.all(s)) return "";
  return s.length > ERROR_MAX ? s.slice(0, ERROR_MAX) + "…" : s;
}

/** 错误文本允许明确标注的构建哈希,但未标注的长 hex/base64 一律按凭据处理。 */
const BENIGN_ERROR_HASH_RE =
  /\b(?:commit|revision|rev|digest|sha(?:-?(?:1|256))?)\b\s*(?:at\s+)?(?::|=|#)?\s*(?:sha256:)?[0-9a-fA-F]{32,64}\b/gi;

/**
 * 错误文本这一档:非 generic + 一条构建哈希豁免后的高熵检测。
 *
 * 与 sensitivePredicate 一样按代价分两档,而且**分法必须一致** —— 豁免后的高熵检测是线性的
 * (`hasGenericSecretShape` 64 KB 实测 0.41 ms),所以它归线性档,跟着整条尾巴走;JWT 仍归
 * 有界档。`all` 是两档之和,与拆分前的语义按构造相等。
 */
const ERROR_TEXT_SENSITIVE: SensitivePredicate = {
  linear: (s) => hasLinearSecretShape(s, false) || hasGenericSecretShape(s.replace(BENIGN_ERROR_HASH_RE, "")),
  bounded: hasBoundedSecretShape,
  all: (s) => ERROR_TEXT_SENSITIVE.linear(s) || ERROR_TEXT_SENSITIVE.bounded(s),
};

/** 工具名 label 展示上限。MCP 工具名可能很长,防其撑爆卡片。 */
const LABEL_MAX = 40;

/**
 * 工具名 label 也是群可见 sink(与 params/error 一致):tool 名来自 registry/MCP 配置,长名会
 * 撑卡片,疑似密钥形状的标识符不应渲出。清洗与其它 sink 对齐:先 URL 降级(注册域),再命中
 * 敏感 → 回退通用 `Tool`,否则截断。(label 通常无 URL,reduceUrlsInText 为 no-op;统一以防
 * MCP/动态工具名里嵌了 webhook/DSN 形状。)
 */
function safeLabel(label: string): string {
  const s = reduceUrlsInText(label);
  // Raw MCP names are scanned per `__` segment rather than whole, because hasGenericSecretShape
  // counts a lone `_` as a base64url signal — so every snake_case MCP name of 32+ chars reads as
  // high-entropy and would render as `Tool`.
  //
  // Be precise about what this gives up: the keyword and known-prefix detectors (AKIA, ghp_, sk-,
  // JWT, token/api_key/…) still fail closed on any single segment, but whole-string entropy
  // detection does not survive the split — a high-entropy value that a `__` breaks into sub-32-char
  // pieces is no longer caught, and renders up to LABEL_MAX. Tool names come from operator-owned
  // registry/MCP config rather than model or user input, so that residue is defence-in-depth
  // against misconfiguration, not an attacker-reachable path. The real fix is one layer down in
  // hasGenericSecretShape; until then this carve-out is the narrower evil.
  const sensitive = s.startsWith(MCP_TOOL_PREFIX)
    ? s.split("__").some((segment) => isSensitive(segment, true))
    : isSensitive(s, true);
  if (sensitive) return "Tool";
  return s.length > LABEL_MAX ? s.slice(0, LABEL_MAX) + "…" : s;
}

/** 单步 → 一行文案:图标 + 标签 + 参数摘要 + 状态/耗时。错误详情经脱敏+截断,label 经脱敏+截断。 */
export function stepLine(step: CardStep): string {
  const { icon, label: rawLabel } = resolveToolMeta(step.tool);
  const label = safeLabel(rawLabel);
  const sum = step.summary ? `: ${step.summary}` : "";
  if (step.status === "running") return `⏳ ${label}${sum}`;
  if (step.status === "error") {
    const detail = sanitizeErrorText(step.error);
    return `❌ ${label}${sum}${detail ? ` — ${detail}` : ""}`;
  }
  const dur = fmtDuration(step.durationMs);
  return `${icon} ${label}${sum}${dur ? ` · ${dur}` : ""}`;
}

function headerText(state: CardProgressState): string {
  switch (state.phase) {
    case "thinking":
      return "🤖 Thinking…";
    case "tool":
      return "🤖 Working…";
    case "paused":
      return "⏸️ Waiting for results";
    case "resuming":
      return "🤖 Preparing results";
    case "answering":
      return "🤖 Answering";
    case "expired":
      return "⏱️ Wait timed out";
    case "error": {
      const detail = sanitizeErrorText(state.errorText);
      return `⚠️ Interrupted${detail ? `: ${detail}` : ""}`;
    }
    case "done": {
      const n = state.steps.length;
      const secs = fmtDuration(state.elapsedMs);
      const parts = ["✅ Done"];
      if (n > 0) parts.push(`${n} ${n === 1 ? "step" : "steps"}`);
      if (secs) parts.push(secs);
      return parts.join(" · ");
    }
    case "stopped":
      return "⚠️ Stopped";
  }
}

/** octo/v1 1.5 已验证可安全渲染的展示元素基线(manifest 未 advertise elements 时用)。 */
const BASELINE_ELEMENTS: ReadonlySet<string> = new Set([
  "TextBlock", "Container", "ColumnSet", "FactSet", "Image",
]);

/**
 * 输入/动作**没有安全基线** —— server 未 advertise 时消费方**保守视为不支持**(fail-closed),
 * 避免 producer 乐观发出旧部署不认的 Input.Number/Action.ToggleVisibility 等致 400。
 */
const BASELINE_INPUTS: ReadonlySet<string> = new Set();
const BASELINE_ACTIONS: ReadonlySet<string> = new Set();

/**
 * 服务端能力(D12 manifest 派生),供渲染按元素/结构上限裁剪。全可选,缺省即保守默认:
 * 未 advertise elements → 用 BASELINE_ELEMENTS;未 advertise inputs/actions → 空集(fail-closed);
 * 未给 maxNodes → 用本地 MAX_VISIBLE_STEPS。
 */
export interface CardCaps extends CardLimits {
  /** 服务端 advertise 的元素白名单(pkg/cardmsg 权威)。 */
  elements?: ReadonlySet<string>;
  /** 服务端 advertise 的输入白名单(Input.Text/Toggle/ChoiceSet/Number/Date/Time)。 */
  inputs?: ReadonlySet<string>;
  /** 服务端 advertise 的本地/导航动作；交互构建器从 octo/v2 profile 派生 Submit。 */
  actions?: ReadonlySet<string>;
  /** 递归节点数上限(limits.max_nodes)。 */
  maxNodes?: number;
  /** 渲染后 JSON 对象最大深度(limits.max_depth)。 */
  maxDepth?: number;
  /** 完整 type-17 payload UTF-8 字节上限(limits.max_payload_bytes)。 */
  maxPayloadBytes?: number;
}

/**
 * 元素/输入/动作是否可安全渲染 —— 按前缀分派到对应 caps 桶。
 * - `Input.*` → `caps.inputs`(不给则 fail-closed)
 * - `Action.*` → `caps.actions`(不给则 fail-closed)
 * - 其它 → `caps.elements`(不给则用保守基线,与旧行为兼容)
 * 一个函数覆盖三类,调用方无需分派;新增类别只需在此扩前缀即可。
 */
export function cardSupports(caps: CardCaps | undefined, kind: string): boolean {
  if (kind.startsWith("Input.")) return (caps?.inputs ?? BASELINE_INPUTS).has(kind);
  if (kind.startsWith("Action.")) return (caps?.actions ?? BASELINE_ACTIONS).has(kind);
  return (caps?.elements ?? BASELINE_ELEMENTS).has(kind);
}

/**
 * 展示步骤上限。长任务工具调用不断累积,全量渲染会撑爆卡片、超服务端结构上限致 edit 400。
 * 优先用服务端权威 max_nodes 推导上限(每步 1 节点),缺省退回本地保守值。
 */
const MAX_VISIBLE_STEPS = 12;

function maxVisibleSteps(caps: CardCaps | undefined): number {
  if (!caps?.maxNodes) return MAX_VISIBLE_STEPS;
  const reserve = 2; // header + 折叠计数行
  const byNodes = Math.max(1, caps.maxNodes - reserve); // 每步 = 1 元素(rich 或 TextBlock,同为 1)
  return Math.min(MAX_VISIBLE_STEPS, byNodes);
}

/**
 * 单步 → RichTextBlock 的多段 inlines(供 buildDisplayCard 的 rich block 使用):
 *   状态图标 | label(subtle) | :摘要 | · 耗时/— 错误详情(good/attention 着色)
 * 段拼接后与 `stepLine(step)` 输出完全一致 —— 保证 plain 兜底不变,且降级到 TextBlock 时视觉等价。
 */
function stepSegments(step: CardStep): RichSegment[] {
  const { icon, label: rawLabel } = resolveToolMeta(step.tool);
  const label = safeLabel(rawLabel);
  const sum = step.summary ? step.summary : "";
  if (step.status === "running") {
    return [
      { text: "⏳ " },
      { text: label, subtle: true },
      ...(sum ? [{ text: ": " }, { text: sum, fontType: "Monospace" as const }] : []),
    ];
  }
  if (step.status === "error") {
    const detail = sanitizeErrorText(step.error);
    const segs: RichSegment[] = [
      { text: "❌ " },
      { text: label, subtle: true },
      ...(sum ? [{ text: ": " }, { text: sum, fontType: "Monospace" as const }] : []),
    ];
    if (detail) segs.push({ text: ` — ${detail}`, color: "attention" });
    return segs;
  }
  const dur = fmtDuration(step.durationMs);
  const segs: RichSegment[] = [
    { text: `${icon} ` },
    { text: label, subtle: true },
    ...(sum ? [{ text: ": " }, { text: sum, fontType: "Monospace" as const }] : []),
  ];
  if (dur) segs.push({ text: ` · ${dur}`, color: "good" });
  return segs;
}

/**
 * 同类合并的一"组":≥2 个连续同 tool 且全 done 的步骤压成一行,大幅缩视觉噪音。
 * 显示:`<icon> <label> × N · total <duration> — latest: <last summary>`
 * running/error 步骤不参与合并(单独调 stepSegments),避免糊掉当前重点。
 */
function groupSegments(group: CardStep[]): RichSegment[] {
  const first = group[0];
  const { icon, label: rawLabel } = resolveToolMeta(first.tool);
  const label = safeLabel(rawLabel);
  // 仅在至少一步有耗时时才展示总耗时,否则不显示(避免全 undefined 渲成误导性的「共 0ms」)。
  const anyDuration = group.some((s) => typeof s.durationMs === "number");
  const total = group.reduce((acc, s) => acc + (s.durationMs ?? 0), 0);
  const dur = anyDuration ? fmtDuration(total) : "";
  const last = group[group.length - 1];
  const lastSum = last.summary ? last.summary : "";
  const segs: RichSegment[] = [
    { text: `${icon} ` },
    { text: label, subtle: true },
    { text: ` × ${group.length}` },
  ];
  if (dur) segs.push({ text: ` · total ${dur}`, color: "good" });
  if (lastSum) segs.push({ text: " — latest: " }, { text: lastSum, fontType: "Monospace" });
  return segs;
}

/**
 * 把可见步骤按"相邻同 tool 且全 done"分组:连续 ≥2 个 done → 合并组;单个 done / running / error
 * → 各自一组(即"单元素组")。返回二维数组,每个内数组是一段。
 *
 * 分组只在 done 之间做:running 与 error 不合并 —— 当前重点(还在跑/失败了)必须显眼。
 */
function groupSteps(steps: CardStep[]): CardStep[][] {
  const out: CardStep[][] = [];
  let i = 0;
  while (i < steps.length) {
    const cur = steps[i];
    if (cur.status !== "done") {
      out.push([cur]);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < steps.length && steps[j].tool === cur.tool && steps[j].status === "done") j++;
    out.push(steps.slice(i, j));
    i = j;
  }
  return out;
}

/** 显式 advertise 富布局能力时,把步骤收进 Container 分组;旧部署保持平铺零回归。 */
function supportsTimelineLayout(caps: CardCaps | undefined): boolean {
  return !!caps?.elements && cardSupports(caps, "Container") && cardSupports(caps, "RichTextBlock");
}

/**
 * 进度视觉分组:每个 thinking 步开启一个阶段,后续 tool call 收在同一阶段里,直到下一次
 * thinking。SDK 当前不给 thinking 正文,这里只能展示 thinking 耗时 + 工具摘要。
 */
function timelineGroups(steps: CardStep[]): CardStep[][] {
  const groups: CardStep[][] = [];
  let cur: CardStep[] = [];
  for (const step of steps) {
    if (step.tool === "__thinking__" && cur.length > 0) {
      groups.push(cur);
      cur = [];
    }
    cur.push(step);
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

function timelineGroupStyle(group: CardStep[]): "default" | "warning" | "attention" | undefined {
  if (group.some((s) => s.status === "error")) return "attention";
  if (group.some((s) => s.status === "running")) return "warning";
  return "default";
}

function renderStepBlocks(steps: CardStep[]): DisplayBlock[] {
  return groupSteps(steps).map((g) => ({
    type: "rich" as const,
    segments: g.length > 1 ? groupSegments(g) : stepSegments(g[0]),
  }));
}

function renderProgressDetailBlocks(steps: CardStep[], caps: CardCaps | undefined): DisplayBlock[] {
  if (supportsTimelineLayout(caps)) {
    return timelineGroups(steps).map((g) => ({
      type: "group" as const,
      style: timelineGroupStyle(g),
      blocks: renderStepBlocks(g),
    }));
  }
  return renderStepBlocks(steps);
}

function supportsTerminalCollapse(caps: CardCaps | undefined): boolean {
  return (
    cardSupports(caps, "Container") &&
    cardSupports(caps, "ColumnSet") &&
    cardSupports(caps, "ActionSet") &&
    cardSupports(caps, "Action.ToggleVisibility")
  );
}

function progressSummary(steps: CardStep[], total: number): string {
  const thinking = steps.filter((s) => s.tool === "__thinking__").length;
  const waiting = steps.filter((s) => s.tool === SUBAGENT_WAIT_STEP_TOOL).length;
  const tools = total - thinking - waiting;
  const parts: string[] = [];
  if (thinking > 0) parts.push(`Reasoning ${thinking}`);
  if (tools > 0) parts.push(`Tools ${tools}`);
  if (waiting > 0) parts.push(`Waiting ${waiting}`);
  // 今天 total === steps.length,三类必占其一;兜底是防 total 日后改成「累计步数」而 steps
  // 只保留窗口时,摘要行静默变空串。
  if (parts.length === 0) parts.push(`${total} ${total === 1 ? "step" : "steps"}`);
  return parts.join(" · ");
}

function terminalHeaderSegments(state: CardProgressState): RichSegment[] | null {
  if (state.phase === "done") {
    const n = state.steps.length;
    const secs = fmtDuration(state.elapsedMs);
    const stats = [n > 0 ? `${n} ${n === 1 ? "step" : "steps"}` : "", secs].filter(Boolean).join(" · ");
    return [
      { text: "✅ Done", bold: true },
      ...(stats ? [{ text: ` · ${stats}`, subtle: true } satisfies RichSegment] : []),
    ];
  }
  if (state.phase === "error") {
    const detail = sanitizeErrorText(state.errorText);
    return [
      { text: "⚠️ Interrupted", bold: true },
      ...(detail ? [{ text: `: ${detail}`, color: "attention" } satisfies RichSegment] : []),
    ];
  }
  return null;
}

function progressSummarySegments(steps: CardStep[], total: number): RichSegment[] {
  return [{ text: progressSummary(steps, total), subtle: true }];
}

function richTextBlock(segments: RichSegment[]): Record<string, unknown> {
  return {
    type: "RichTextBlock",
    inlines: segments.map((s) => ({
      type: "TextRun",
      text: s.text,
      ...(s.bold ? { weight: "Bolder" } : {}),
      ...(s.subtle ? { isSubtle: true } : {}),
      ...(s.fontType ? { fontType: s.fontType } : {}),
      ...(s.color && s.color !== "default" ? { color: s.color } : {}),
    })),
  };
}

function textBlock(text: string, opts?: { bold?: boolean; subtle?: boolean; size?: "Medium" }): Record<string, unknown> {
  return {
    type: "TextBlock",
    text,
    wrap: true,
    ...(opts?.bold ? { weight: "Bolder" } : {}),
    ...(opts?.subtle ? { isSubtle: true } : {}),
    ...(opts?.size ? { size: opts.size } : {}),
  };
}

function progressHeaderSegments(state: CardProgressState, fallbackHeader: string): RichSegment[] {
  return terminalHeaderSegments(state) ?? [{ text: fallbackHeader, bold: true }];
}

function progressSummaryText(steps: CardStep[], total: number): string {
  return progressSummary(steps, total);
}

function progressHeaderItems(
  state: CardProgressState,
  header: string,
  steps: CardStep[],
  total: number,
  canRichText: boolean,
): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  if (canRichText) {
    items.push(richTextBlock(progressHeaderSegments(state, header)));
    if (total > 0) items.push(richTextBlock(progressSummarySegments(steps, total)));
    return items;
  }
  items.push(textBlock(header, { bold: true, size: "Medium" }));
  if (total > 0) items.push(textBlock(progressSummaryText(steps, total), { subtle: true }));
  return items;
}

function progressToggleColumn(startVisible: boolean): Record<string, unknown> | null {
  return {
    type: "Column",
    width: "auto",
    items: [
      {
        type: "ActionSet",
        id: AGENT_PROGRESS_COLLAPSE_ID,
        isVisible: startVisible,
        actions: [
          {
            type: "Action.ToggleVisibility",
            title: "Hide details",
            targetElements: [
              { elementId: AGENT_PROGRESS_DETAIL_ID, isVisible: false },
              { elementId: AGENT_PROGRESS_COLLAPSE_ID, isVisible: false },
              { elementId: AGENT_PROGRESS_EXPAND_ID, isVisible: true },
            ],
          },
        ],
      },
      {
        type: "ActionSet",
        id: AGENT_PROGRESS_EXPAND_ID,
        isVisible: !startVisible,
        actions: [
          {
            type: "Action.ToggleVisibility",
            title: "Show details",
            targetElements: [
              { elementId: AGENT_PROGRESS_DETAIL_ID, isVisible: true },
              { elementId: AGENT_PROGRESS_COLLAPSE_ID, isVisible: true },
              { elementId: AGENT_PROGRESS_EXPAND_ID, isVisible: false },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * 渲染进度卡 —— header/toggle 使用 agent_progress_v1 专用根结构;步骤明细仍走
 * buildDisplayCard 底座(吃自己狗粮),复用协商降级与脱敏。
 * 每步用 rich block(advertise RichTextBlock 时是 RichTextBlock 富行、否则 TextBlock 平铺 —— 一行完整,
 * 不像 ColumnSet 会被服务端权威 plain 重算成图标/文本两行)。
 * 可见步数受服务端 max_nodes 权威约束(缺省用本地上限)。
 *
 * 返回 `{ card, plain }`:card = AC 1.5 JSON;plain = 纯文本兜底(与布局无关;服务端 Finalize 会
 * 权威重算)。plain 空则回退 PROGRESS_CARD_PLACEHOLDER。
 */
export function renderProgressCard(
  state: CardProgressState,
  caps?: CardCaps,
): {
  card: Record<string, unknown>;
  plain: string;
} {
  const header = headerText(state);
  const cap = maxVisibleSteps(caps);
  const total = state.steps.length;
  // 只展示最近 cap 步;更早的折叠成一行计数,避免卡片无界膨胀。
  const hidden = Math.max(0, total - cap);
  const visibleSteps = hidden > 0 ? state.steps.slice(-cap) : state.steps;
  const canRichText = cardSupports(caps, "RichTextBlock");

  const renderFlatFallback = (): { card: Record<string, unknown>; plain: string } => {
    // The specialized layout is all-or-nothing. Once either root element is unavailable or
    // the enhanced tree exceeds a hard limit, use only the universally degradable TextBlock
    // surface and omit agent_progress_v1 metadata so clients use ordinary AC rendering.
    const flatCaps: CardCaps = {
      ...caps,
      elements: new Set(["TextBlock"]),
      inputs: new Set(),
      actions: new Set(),
    };
    const flatBlocks: DisplayBlock[] = [];
    if (total > 0) flatBlocks.push({ type: "text", text: progressSummaryText(state.steps, total) });
    if (hidden > 0) flatBlocks.push({ type: "text", text: `… ${hidden} earlier steps hidden` });
    flatBlocks.push(...renderProgressDetailBlocks(visibleSteps, flatCaps));
    const flat = buildDisplayCard({
      title: header,
      blocks: flatBlocks,
      caps: flatCaps,
      trusted: true,
      dropMarker: EN_DROP_MARKER,
      budgetMarker: EN_BUDGET_MARKER,
    });
    return { card: flat.card, plain: flat.plain || PROGRESS_CARD_PLACEHOLDER };
  };

  if (!cardSupports(caps, "ColumnSet") || !cardSupports(caps, "Container")) {
    return renderFlatFallback();
  }

  const detailBlocks: DisplayBlock[] = [];
  if (hidden > 0) detailBlocks.push({ type: "text", text: `… ${hidden} earlier steps hidden` });
  detailBlocks.push(...renderProgressDetailBlocks(visibleSteps, caps));

  // trusted:进度卡的每行文案已在上游逐 sink 脱敏(summarizeToolParams/sanitizeErrorText/safeLabel:
  // URL 已降级、path/shell 按 generic=false 保留 git SHA/digest)。buildDisplayCard 默认 generic=true
  // 会二次套用长 hex/高熵检测,误删含哈希的正常行、甚至把错误终态帧整卡清空 —— 故此路径关掉严格 generic。
  const detail = buildDisplayCard({ blocks: detailBlocks, caps, trusted: true, dropMarker: EN_DROP_MARKER, budgetMarker: EN_BUDGET_MARKER });
  const headerItems = progressHeaderItems(state, header, state.steps, total, canRichText);
  const canToggle = supportsTerminalCollapse(caps);
  const isTerminal = state.phase === "done" || state.phase === "stopped" || state.phase === "error" || state.phase === "expired";
  const detailVisible = !(canToggle && isTerminal);
  const columns: Record<string, unknown>[] = [
    {
      type: "Column",
      width: "stretch",
      items: headerItems,
    },
  ];
  if (canToggle) {
    const toggleColumn = progressToggleColumn(detailVisible);
    if (toggleColumn) columns.push(toggleColumn);
  }

  const card: Record<string, unknown> = {
    type: "AdaptiveCard",
    version: CARD_VERSION,
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    body: [
      {
        type: "ColumnSet",
        columns,
      },
      {
        type: "Container",
        id: AGENT_PROGRESS_DETAIL_ID,
        isVisible: detailVisible,
        items: (detail.card.body as unknown[]) ?? [],
      },
    ],
  };
  card.metadata = { octo_layout: OCTO_CARD_LAYOUTS.agentProgressV1 };
  const summaryPlain = total > 0 ? progressSummaryText(state.steps, total) : "";
  const plain = [header, summaryPlain, detail.plain].filter(Boolean).join("\n");
  if (!cardFitsLimits(card, plain || PROGRESS_CARD_PLACEHOLDER, caps)) {
    return renderFlatFallback();
  }
  return { card, plain: plain || PROGRESS_CARD_PLACEHOLDER };
}

/**
 * Experimental terminal frame: keep the completed progress panel and append the
 * normal final text in the same type-17 message. The specialized
 * `agent_progress_v1` metadata is intentionally removed because its client
 * contract requires exactly `[ColumnSet, Container#timeline_detail]`; this
 * combined shape must go through the ordinary Adaptive Card renderer.
 *
 * `null` means the answer must be delivered through the normal text path. We
 * never truncate a user-facing final answer merely to make it fit a card.
 */
export function renderProgressResponseCard(
  state: CardProgressState,
  responseText: string,
  caps?: CardCaps,
): { card: Record<string, unknown>; plain: string } | null {
  const finalText = responseText.trim();
  if (state.phase !== "done" || !finalText) return null;

  const progress = renderProgressCard(state, caps);
  const progressBody = Array.isArray(progress.card.body) ? progress.card.body : [];
  if (progressBody.length === 0) return null;

  const responseBlock: Record<string, unknown> = {
    type: "TextBlock",
    text: finalText,
    wrap: true,
    spacing: "Large",
  };
  const body = cardSupports(caps, "Container")
    ? [
        {
          type: "Container",
          style: "emphasis",
          items: progressBody,
        },
        responseBlock,
      ]
    : [...progressBody, responseBlock];
  const { metadata: _progressLayout, ...baseCard } = progress.card;
  const card: Record<string, unknown> = { ...baseCard, body };
  if (!cardFitsLimits(card, finalText, caps)) return null;
  return { card, plain: finalText };
}
