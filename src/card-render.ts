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
import { buildDisplayCard, EN_DROP_MARKER, type DisplayBlock, type RichSegment } from "./card-blocks.js";
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

const SUMMARY_MAX = 64;
/** 放开档渲染的 token 更多,给更宽的余量(与 ERROR_MAX 对齐),但仍必须有硬上限。 */
const SUMMARY_DETAILED_MAX = 120;
/**
 * 放开档接受的**输入**长度上限(区别于上面的渲染上限)。超过则退回保守摘要,不进分词与分类。
 * 取 2000 是因为渲染上限只有 120,更长的输入本来也只剩截断,而真实命令(压缩 JSON body、
 * base64 块)实测都在这个量级以下。
 */
const DETAILED_INPUT_MAX = 2000;
/**
 * 进入 URL 归约管线前的**无条件**输入长度上限。
 *
 * 归约管线里的几趟正则在长串上是二次的。实测(本文件当前状态,默认配置,无任何开关):
 *
 *     read  {file_path: "a"×50k  + "?x"}   2363 ms
 *     read  {file_path: "a"×100k + "?x"}   9311 ms      ← 输入 ×2,耗时 ×4
 *     exec  {command:   "a:b@"   + "a"×60k} 3442 ms
 *
 * summarizeToolParams 由 before_tool_call 钩子**同步**调用且没有 try/catch,而工具参数是模型
 * 生成的 —— 这几秒是整个插件的事件循环被卡住,所有账号、所有群一起停。
 *
 * 截断而不是整串丢弃:渲染上限只有 SUMMARY_MAX(64),截断掉的部分本来也不会被渲染,所以下游
 * 的敏感串守卫仍然跑在「会被渲染的那一段」的完整形态上,判定不受影响。
 *
 * 上限必须落在**进管线之前**。放在管线中间或之后等于没设 —— 代价全部发生在管线里。
 */
const SUMMARY_INPUT_MAX = 4000;

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
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/, // JWT
];

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
  if (SECRET_RE.test(s)) return true;
  if (SECRET_PREFIX_RES.some((re) => re.test(s))) return true;
  return generic && hasGenericSecretShape(s);
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
 * 工具参数摘要的档位。
 *
 * - `off`      程序名 / 短路径 / 注册域。默认。
 * - `additive` 只渲染能正面归类为安全的 token,其余 `***`。漏掉一个形状 = 多打一个 `***`,
 *              残留是**可枚举的两条**(见 summarizeShellAdditive)。
 *
 * 刻意**没有**「渲染整条命令、再减掉认出来的危险形状」这一档:那条路径上漏掉一个形状就是一次
 * 明文泄漏,残留无界 —— 评审无法收敛到「已覆盖」这个结论上。见 summarizeShellAdditive 的说明。
 */
export type SummaryDetail = "off" | "additive";
const SUMMARY_STRATEGY: Record<string, SummaryStrategy> = {
  read: "path", write: "path", edit: "path", apply_patch: "path", ls: "path", find: "path", glob: "path",
  exec: "shell", bash: "shell", shell: "shell",
  process: "enum",
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


/**
 * 凭据形状的变量名。关键词必须落在**下划线分段边界**上(`(?:^|_)…(?:_|$)`),而不是子串匹配 ——
 * 否则 `StrictHostKeyChecking` 里的 `Key` 会命中,把 `ssh -o StrictHostKeyChecking=no` 的值抹掉,
 * 而那恰恰是运维最需要看见的安全选项。同理 `AUTHOR` 不因含 `AUTH` 而被抹。
 * 无下划线的连写形式(`APIKEY`)单独列出。
 */
const CREDENTIAL_KEYWORDS =
  "token|secret|password|passwd|pwd|passphrase|credentials?|creds?|key|privkey|apikey|accesskey"
  + "|apitoken|auth|bearer|session|sessionid|sid|cookie|jwt|otp|salt|signature|pat|pass|refresh";


const PROGRAM_TOKEN_RE = /^[A-Za-z0-9_./@:+-]+$/;
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

/* ── 加法 shell 摘要(cardToolDetail: true)────────────────────────────────────────────────
 *
 * 这一档**只渲染能正面归类为安全的 token,其余一律 `***`**。它与「渲染整条命令、再把认出来的
 * 危险形状减掉」的减法思路是相反的判据,而判据的方向决定了失败模式:
 *
 *   减法:漏掉一个形状 = **一次明文泄漏**,残留无界
 *   加法:漏掉一个形状 = **多打一个 `***`**,残留由接受规则界定
 *
 * 这不是风格取舍。这个模块此前每一个凭据泄漏类都出在减法路径上;而 `path` / `url` / `enum`
 * 三个策略一次都没出过,因为它们本来就是加法的(`new URL()` 解析、封闭 enum、与路径同源的
 * 形状)—— 保证是结构性的,不是靠把危险形状列全。
 *
 * 由此,评审要问的问题也换了:不再是「有没有哪个输入能让密文活下来」(搜索空间 = 整个 shell
 * 语法,无界),而是「有没有哪个 token 被**正面分类进安全类别**却含密文」(搜索空间 = 下面这
 * 几条接受规则,可枚举)。分词器写错也不会泄漏 —— 分错的 token 归不了类,结果就是 `***`。
 *
 * 已知残留(可枚举,README 里逐条写明):
 *  1. 值粘在单横线 flag 上且形似长 flag(`mysql -pRealPw123`)—— 与 `-verbose` 无法区分。
 *  2. 密文本身就是一个普通位置参数(`deploy prod hunter2`)—— 与子命令无法区分。
 * 两条都靠 SECRET_RE / 形状守卫兜底,兜不住就是残留。
 */

/** 尊重引号与反斜杠的分词。分错只会让 token 归不了类 → `***`,所以这里不需要完美。 */
function splitShellWords(cmd: string): string[] {
  const words: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let started = false; // 空引号 `''` 也是一个词
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') cur += c + (cmd[++i] ?? "");
      else if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (c === "\\") { cur += cmd[++i] ?? ""; started = true; continue; }
    if (/\s/.test(c)) { if (cur || started) words.push(cur); cur = ""; started = false; continue; }
    cur += c;
  }
  if (cur || started) words.push(cur);
  return words;
}

const MASK = "***";
/** 控制算子原样保留:它们是结构,不是值,而且决定了下一个词是程序名。 */
const SHELL_OPERATORS = new Set(["&&", "||", "|", ";", "&", "|&"]);
/**
 * `--`(end-of-options)是结构记号,不是值 —— 但它**排在 maskNext 之后**:`cli --token -- x`
 * 里 `--` 就是 `--token` 收到的那个值,按 shell 语义该抹。结构性只在它不占值位时成立。
 */
const END_OF_FLAGS = "--";
/** 简单标识符:子命令、目标名、镜像 tag 之外的裸词。不含 `=` `:` `@` 等承载凭据的分隔符。 */
const PLAIN_WORD_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
/** `.` / `..`:当前目录与上级目录,`find . …` 里最常见的操作数。不含任何值。 */
const CWD_WORD_RE = /^\.{1,2}$/;
/**
 * 相对或绝对路径。与 path 策略同源的形状,七轮零泄漏。
 * 前瞻要求**至少含一个 `/`**:否则这条会吞掉所有裸词,绕过下面裸词分支的长度与高熵检查。
 */
const PATH_WORD_RE = /^(?=.*\/)\.{0,2}\/?[A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]*)*$/;
/** `--long` / `--long=value`(值仍抹掉)。 */
const LONG_FLAG_RE = /^--[A-Za-z0-9][A-Za-z0-9-]*$/;
const FLAG_WITH_VALUE_RE = /^(--?[A-Za-z0-9][A-Za-z0-9-]*)=/;
/**
 * 单横线 flag,**只接受 ≤2 字符**。
 *
 * 曾经也接受「3–12 位纯小写」,理由是要保住 `-verbose` / `-name` 这类长形式。那是错的:
 * `-pswordfish`、`-phunterlove`、`-sletmein` 与它们**在形状上完全一致**,于是明文口令被正面
 * 归类成 flag 名渲染出去 —— 实测 `mysql --password hunter2 -phunterlove mydb` 在加法档渲染
 * `-phunterlove`,一条明文口令被当作 flag 名渲染了出去。
 *
 * 加法模型的规则是「归类不了就抹」,`-xxx` 归类不了。代价是 `-name` / `-jar` / `-xzf` 也变成
 * `***`(`--long` 不受影响,双横线后不存在粘连值)。这是加法档为「残留可枚举」付的价钱。
 */
const SHORT_FLAG_RE = /^-[A-Za-z0-9]{1,2}$/;
/** 名字像凭据的 flag → 下一个词一定抹掉(`--token X`、`-p X`)。复用赋值名的关键词表。 */
/**
 * additive 输出里「已抹掉的值 + 紧邻的名字」。用于把它们排除出敏感串守卫的检测。
 *
 * 只匹配以 `***` 收尾的片段,前面可选一个赋值名或 flag 名。加法输出里 `***` 一定是我们自己
 * 打的(输入里的字面 `***` 也只会被归类成一个普通词,不会造出 `NAME=***` 这种结构),所以
 * 这里删掉的永远是名字与占位符,不会是任何被渲染的值。
 */
const ADDITIVE_MASKED_RE =
  /(?:[A-Za-z_][A-Za-z0-9_]*(?:\+|\[[^\]]*\])?=|--?[A-Za-z0-9][A-Za-z0-9-]*[= ])?\*\*\*/g;

/**
 * 名字像凭据的 flag → 下一个词一定抹掉(`--token X`、`-p X`)。
 *
 * **必须与 SECRET_ASSIGNMENT_NAME_RE 同源。** 这里原本是手写的第二张表,比赋值名表窄了 14 个
 * 关键词(`privkey`/`jwt`/`otp`/`signature`/`cookie`/`sid`/`salt`/`pat`/`refresh`/`session`/
 * `bearer`/`accesskey`/`apitoken`/`sessionid`),于是 `cli --private-key hunter2` 在加法档明文
 * 渲染,而 `--accesskey` 只是**碰巧**被 SECRET_RE 兜住 —— 两个都藏不藏,操作者无从推断。
 *
 * 这是这条 PR 反复出现的同一个形状:**本该互为镜像的第二张表,和第一张不同步**(兜底 vs 归约、
 * flag 表 vs 赋值名表、长度上限 vs 它保护的递归)。派生而不是重抄,这一类才算封住。
 * 分段符取 `[-_]`:命令行写 `--private-key`,环境变量写 `PRIVATE_KEY`,是同一个词。
 */
const CREDENTIAL_FLAG_RE = new RegExp(
  `^-{1,2}(?:[A-Za-z0-9]+[-_])*(?:${CREDENTIAL_KEYWORDS})(?:[-_][A-Za-z0-9]+)*$`,
  "i",
);

/**
 * 凭据关键词之后挂着**非关键词**尾段的 flag(`--token-hunter2`)。这种 token 要整个抹掉。
 * 尾段本身是关键词的(`--refresh-token`、`--api-key`)是正常 flag 名,照常渲染。
 *
 * `--api-key` / `--client-secret` / `--private-key` 的关键词落在**末尾**,前缀段是限定词,是
 * 正常 flag 名;而 `--token-hunter2` 的尾段没有任何理由存在 —— 值粘进 flag 名里正是这个形状。
 * 光靠下游关键词守卫兜不住:additive 的豁免会把 flag 名整个从探针里删掉,于是 `--tokenhunter2`
 * 被整串隐藏,`--token-hunter2` 却渲染出来,两者差一个连字符,操作者无从推断。
 */
const CREDENTIAL_FLAG_CLEAN_RE = new RegExp(
  `^-{1,2}(?:[A-Za-z0-9]+[-_])*(?:${CREDENTIAL_KEYWORDS})(?:[-_](?:${CREDENTIAL_KEYWORDS}))*$`,
  "i",
);

/** 凭据 flag,但关键词之后挂着**不是关键词**的尾段。`--refresh-token` 的尾段是关键词,正常。 */
const credentialFlagCarriesValue = (w: string): boolean =>
  CREDENTIAL_FLAG_RE.test(w) && !CREDENTIAL_FLAG_CLEAN_RE.test(w);

/**
 * 加法 shell 摘要:程序名 + 子命令 + flag 名 + 归约后的 URL + 路径;其余一律 `***`。
 * 赋值**不看名字**,一律抹值 —— 加法模型下没有「这个名字像不像凭据」的判断,所以也没有
 * 「变量名没有凭据暗示就漏」(`FOO=hunter2`)这条残留 —— 加法路径上它不存在。
 */
function summarizeShellAdditive(p: Record<string, unknown>): string {
  const cmd = firstString(p, ["command", "cmd"]).trim();
  if (!cmd) return "";
  const out: string[] = [];
  let expectProgram = true; // 串首,以及每个控制算子之后
  let maskNext = false;     // 上一个词是凭据形状的 flag
  for (const w of splitShellWords(cmd)) {
    if (SHELL_OPERATORS.has(w)) { out.push(w); expectProgram = true; maskNext = false; continue; }
    if (maskNext) { out.push(MASK); maskNext = false; continue; }
    if (w === END_OF_FLAGS) { out.push(w); continue; }
    // 赋值:`NAME=`、`NAME+=`、`NAME[i]=` 都算。值一律不渲染。
    // 下标内容(`arr[…]`)在加法档同样必须**分类过**才能渲染 —— 它是任意文本,不是结构。
    // 只放行简单标识符/数字下标,其余连下标一起抹掉。
    const assign = /^([A-Za-z_][A-Za-z0-9_]*)(\+|\[([^\]]*)\])?=/.exec(w);
    if (assign) {
      const [, name, suffix, subscript] = assign;
      const safeSuffix = !suffix || suffix === "+"
        || (subscript !== undefined && /^[A-Za-z0-9_]*$/.test(subscript) && subscript.length <= 24);
      out.push(safeSuffix ? `${name}${suffix ?? ""}=${MASK}` : `${name}=${MASK}`);
      continue;
    }
    if (expectProgram) {
      // 与下面的操作数分支用**同一组**检查。`expectProgram` 在每个控制算子之后重新置位,
      // 所以这个分支在命令中段也可达(`sh -c x ; <高熵串>`),少一组检查就是一条绕过路径。
      expectProgram = false;
      const safe = (PLAIN_WORD_RE.test(w) && w.length <= 24) || PATH_WORD_RE.test(w) || CWD_WORD_RE.test(w);
      out.push(safe && !hasGenericSecretShape(w) ? w : MASK);
      continue;
    }
    // URL:解析得动才渲染,并且**必须再过一次高熵形状检测** —— webhook path
    // (`/services/T../B../XXXX`)与隧道/预签名子域的随机串**本身就是凭据**,它们能通过
    // `new URL()`,所以"解析成功"不等于"安全"。url 策略一直是这么做的(generic=true),
    // shell 策略此前没有,于是同一个 Slack webhook 经 fetch 会被降级、经 exec 却整条渲染。
    if (w.includes("://")) {
      const u = detailedUrl(w);
      out.push(u && !hasGenericSecretShape(u) ? u : MASK);
      continue;
    }
    const withValue = FLAG_WITH_VALUE_RE.exec(w);
    if (withValue) { out.push(`${withValue[1]}=${MASK}`); continue; }
    if (LONG_FLAG_RE.test(w) || SHORT_FLAG_RE.test(w)) {
      if (credentialFlagCarriesValue(w)) { out.push(MASK); maskNext = true; continue; }
      out.push(w);
      maskNext = CREDENTIAL_FLAG_RE.test(w);
      continue;
    }
    if (CWD_WORD_RE.test(w)) { out.push(w); continue; }
    if (PATH_WORD_RE.test(w) && !hasGenericSecretShape(w)) { out.push(w); continue; }
    if (PLAIN_WORD_RE.test(w) && w.length <= 24 && !hasGenericSecretShape(w)) { out.push(w); continue; }
    out.push(MASK);
  }
  return out.join(" ");
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
  const cmd = firstString(p, ["command", "cmd"]).trim();
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
  return PROGRAM_TOKEN_RE.test(prog) ? prog : "";
}

/**
 * URL → `scheme://注册域`。丢弃 path/query/userinfo **和所有子域**:凭据既可能在 query,
 * 也常整段嵌在 path 里(Slack/Discord webhook `/services/T../B../XXXX`),更有隧道/预签名
 * 场景**主机名本身即密钥**(ngrok 随机子域、预签名 bucket 名)—— 这些随机串不含关键词、躲过
 * SECRET_RE。故只暴露注册域(eTLD+1)。解析失败返回 null(原串可能含 token,调用方丢弃)。
 */

/**
 * process 的 action 白名单。action 是模型可控字段(上游 processSchema 把它声明为裸
 * `Type.String()`,枚举只写在 description 里),所以只认枚举值。
 *
 * 出处:`node_modules/openclaw/dist/bash-tools.schemas-*.js` 的 processSchema。上游新增 action
 * 时这里不会报错,只会静默渲染空串 —— 升级后需比对。
 *
 * 注意这条**不受 cardToolDetail 控制**:改动前 process 走 shell 策略而 processSchema 没有
 * command 字段,恒取空串,所以两种模式下渲染 action 都不是暴露面的放大,而是修一个恒空的 bug。
 */
const PROCESS_ACTIONS: ReadonlySet<string> = new Set([
  "list", "poll", "log", "write", "send-keys", "submit", "paste", "kill", "clear", "remove",
]);
function summarizeEnum(p: Record<string, unknown>): string {
  const action = firstString(p, ["action"]).trim();
  return PROCESS_ACTIONS.has(action) ? action : "";
}


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
 * userinfo 用户名允许的字符。归约(SCHEMELESS_USERINFO_RE)与兜底(RESIDUAL_USERINFO_RE)
 * **共用同一个常量,而且共用同一种锚点形式**(负向后顾)。
 *
 * 两者一旦在起始位上不同步,兜底就兜不住它本该兜的东西:凡是归约认、兜底不认的起点,归约漏掉的
 * 形状会直达渲染。所以这里不只统一字符集,连锚点写法也统一。
 */
const USERINFO_USER_CHARS = "A-Za-z0-9._%+-";

/**
 * 无 scheme 的 userinfo DSN(`user:pass@host[:port][/path]`):userinfo 即明文口令。
 * 密码可含 `@`,按最后一个 `@` 分隔主机。
 *
 * 两个主机分支:
 *  - **带点主机**(`db.example.com`):port/path 可省。
 *  - **单标签主机**(`localhost`、compose 服务名、k8s 短名):后接 `:端口`、`/路径` 或 `:/路径`
 *    (rsync/scp 的远端路径形态)。只认带点会让 `psql user:pw@localhost:5432/prod` 一趟都不匹配、
 *    明文口令原样渲染。
 *
 * 这里**不覆盖**既无端口也无路径的裸单标签(`user:pw@localhost`、`guest:pw@rabbitmq`):无条件
 * 放宽会把 `sed 's:a:b@c:g'`、`docker run -v a:b@c`、`echo 10:30@office` 当成 DSN 改写掉,而
 * `x:y@z` 本身无法与它们区分 —— 改写会毁命令,放行会泄漏明文口令。第三条路见
 * RESIDUAL_USERINFO_RE:归约不了的形状**整串不渲染**。所以这条正则只需覆盖「能确定是 DSN」的
 * 形状,不必、也不该去猜剩下的。
 *
 * 用户名可空(`*` 而非 `+`):`redis-cli -u :hunter2@localhost:6379/0` 是「只有口令」的标准 DSN
 * 形态(Redis 及一切按口令认证的服务),要求用户名非空会让它一趟都不匹配;而且这条不限于单标签,
 * `psql :hunter2@db.example.com/prod` 一样漏。空匹配用不了 `\b`(空格与 `:` 都是非词字符,中间
 * 没有词边界),故改用「前面不是 userinfo 字符」的负向后顾。
 */
const SCHEMELESS_USERINFO_RE = new RegExp(
  `(?<![${USERINFO_USER_CHARS}])[${USERINFO_USER_CHARS}]*:[^\\s/]+@`
  + `(?:[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+(?::\\d+)?(?:\\/[^\\s]*)?`
  + `|[A-Za-z0-9-]+(?::\\d+(?:\\/[^\\s]*)?|:\\/[^\\s]*|\\/[^\\s]*))`,
  "g",
);

/**
 * 归约后**仍然残留**的 `user:pass@host` 形状 → 摘要整串不渲染。
 *
 * SCHEMELESS_USERINFO_RE 只处理能确定是 DSN 的形状;裸单标签主机(`psql user:hunter2@localhost`、
 * `celery -b guest:guestpw@rabbitmq`、`ftp user:hunter2@ftpserver`)一趟都不匹配,而 `hunter2`
 * 这类口令既无关键词也无高熵形状,下游守卫同样抓不住 —— 实测明文口令直达群可见卡片。
 *
 * 判据不是「这是不是 DSN」(无法判定),而是「归约管线**有没有**处理掉它」:能确定的形状在上面
 * 几趟里已被剥掉 userinfo、这里不再命中;还留着 `x:y@z` 的,一律不渲染。误伤方向是少显示细节
 * (`sed 's:a:b@c:g'` 只渲染 `sed`),而不是把命令改写成另一条命令 —— 后者更糟:操作者看不出
 * 自己看到的是被改过的。
 *
 * **兜底的每一个字符类都必须 ⊇ 归约的对应字符类。** 口令段取最宽的 `[^\s]`,而不是照抄归约的
 * `[^\s/]`:照抄会留下一条缝 —— 归约**因为**某个字符匹配不上的串,兜底也同样匹配不上,于是原样
 * 渲染。`/` 就在 base64 口令的字母表里,而且不限于裸单标签:`user:pa/ss@db.example.com`、
 * `user:pa/ss@localhost:5432/prod` 两边都逃掉。用户名同样可空,理由同上。
 *
 * 放宽到 `/` 之后必须排掉 `scheme://`,否则 `https://x.test/a:b@c` 会被读成
 * 「user=`https`、pass=`//x.test/a:b`」而整串隐藏 —— 路径里带 `@` 的 URL 很常见
 * (`/users/@me`、`/@scope/pkg`)。带 scheme 的串在第 1 趟已经过 `new URL()` 剥掉 userinfo,
 * 本来就不需要这条兜底;解析失败的那些在同一趟被整段抹除,也不会走到这里。
 */
const RESIDUAL_USERINFO_RE = new RegExp(
  `(?<![${USERINFO_USER_CHARS}])[^\\s:@/]*:(?!\\/\\/)[^\\s]*@`,
);
/** 任意无 scheme 的 `host.tld/path`:path 常承载 webhook token、签名或对象凭据。 */
const SCHEMELESS_HOST_PATH_RE =
  /(^|[^A-Za-z0-9@._/:+-])([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?::\d+)?\/[^\s]+)/g;

/**
 * URL 相关那几趟的前导集:SHELL_BREAK **再加** `=` 和 `,`。
 *
 * 比 SHELL_BREAK 宽是安全的 —— 这几趟只把前导原样回填,不存在「值吞掉下一个起始位置」的问题,
 * 所以放宽只会多覆盖、不会漏。`=` 是必须的:`curl --url=localhost/reset?code=…` 里 query 前面
 * 粘的正是 `=`;`,` 则来自 `--conf a=1,b=localhost/x?c=…` 这类逗号分隔的参数列表。
 */
const URL_LEAD = `${SHELL_BREAK}=,`;

/**
 * 无 scheme、**单标签主机**的 `host/path?query`。上面几趟都要求主机带点,这类串一趟都不匹配,
 * query 会原样渲染(`curl localhost/reset?code=…`)。
 *
 * 不放宽主机形状去匹配整串 —— 那样 `src/index.ts` 会被当成 host/path,把普通相对路径毁掉。
 * 只针对**含 `=` 的 query 段**下手:shell glob(`src/file?.ts`)里不含 `=`,不会被误伤。
 *
 * 前导取 URL_LEAD 而不是只认空白:命令行上给 URL **加引号是常态写法**,只认空白时
 * `curl 'localhost/reset?code=…'` 和 `curl --url=localhost/reset?code=…` 的 query 原样渲染。
 */
// query 段止于空白或引号,并且**整段必须干净收尾**:收尾条件要求匹配停在串尾、空白,或一个「后面
// 就是 SHELL_BREAK 字符或串尾」的闭合引号上 —— 即那个引号确实是**词的结尾**,而不是 query 内部
// 的引号。
//
// 少了这个收尾条件,query 里只要出现一个引号,匹配就在那里断掉、只删前半段,后半段原样渲染:
//
//     curl 'localhost:8080/search?filter={"a":1}&code=hunter2'
//       →  curl 'localhost:8080/search"a":1}&code=hunter2'      ← code= 泄漏
//
// 半改写的输出看起来像脱敏过的,却留着尾巴,是最坏的失败模式。修法不是把引号放进集合(那会把
// 闭合引号连同后面的 `&&echo x` 一起吃掉、把命令改写成另一条),而是**确认不了就不改写** ——
// 交给 RESIDUAL_QUERY_RE 整串不渲染。与 userinfo 那条走的是同一个判据。
//
// `&` 必须留在集合内 —— 多参数 query(`?a=1&b=2`)靠它,排除掉会把 `&b=2` 留在渲染串里。
const SCHEMELESS_QUERY_RE = new RegExp(
  `(^|[${URL_LEAD}])((?=[A-Za-z0-9._-]*[A-Za-z])[A-Za-z0-9._-]+(?::\\d+)?(?:\\/[^\\s?]*)?)\\?[^\\s'"]*=[^\\s'"]*(?=$|\\s|['"](?:[${SHELL_BREAK}]|$))`,
  "g",
);

/**
 * 归约后**仍然残留**的单标签 `host/path?…=…` → 摘要整串不渲染(与 RESIDUAL_USERINFO_RE 同理)。
 *
 * 路径段两边都是**可选**的。这一条不只是字符类要对齐:如果只有归约放宽、兜底照抄了「`?` 前必须
 * 有 `/`」这条**结构要求**,`host?query`(query 直接挂在裸主机上,`curl localhost?code=abc`)就会
 * 两边都不匹配 —— 归约不处理、兜底也不拦,原样渲染。兜底与被兜底者共享盲点时,兜底就不是兜底。
 *
 * 字母前瞻与 SCHEMELESS_QUERY_RE 一致。少了它,归约**主动不碰**的纯数字主机(`10/20?ok=yes`、
 * `2026-08-06?ok=yes`)会被兜底整串拦掉 —— 而 query 策略没有程序名可退,卡片直接空白,看起来
 * 像 bug。这说明「兜底的字符类必须 ⊇ 归约的」写窄了:两者真正需要的是**归约不肯动的地方,
 * 兜底也不要拦**;单向的包含关系只覆盖了泄漏方向,没覆盖过度隐藏方向。
 *
 * SCHEMELESS_QUERY_RE 只改写能干净收尾的形状;query 里嵌了引号的(JSON 参数、带引号的值、
 * OAuth 回调里的 `state='…'`)一趟都不匹配,而 `code=`/`sid=`/`refresh=` 这些既不在关键词表里、
 * 值也没有高熵形状,下游守卫同样抓不住 —— `code` 是 OAuth 授权码,等价于 bearer。
 */
const RESIDUAL_QUERY_RE =
  /(?=[A-Za-z0-9._-]*[A-Za-z])[A-Za-z0-9._-]+(?::\d+)?(?:\/[^\s?]*)?\?[^\s]*=/;

/** 把文本里内嵌的 URI 就地降级为 scheme://注册域(解析失败则整段抹除)。 */
/**
 * 放开档的 URL 归约:保留 scheme + **完整主机名(含子域)** + path,丢掉 query/fragment。
 *
 * 相对 originDomain 放开的是子域与路径 —— 这正是「隧道/预签名场景主机名即密钥」那条防护
 * 覆盖的面,由 cardToolDetail 显式承担。**userinfo 与 query 仍然永不渲染**:前者是明文口令,
 * 后者是裸 token 最常见的位置,二者都不影响「看清访问了哪个接口」这个诉求。
 */
function detailedUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    // u.host 不含 userinfo。纯主机 URL 的 pathname 是 "/",直接拼会给卡片留个多余的尾斜杠
    // (`redis-cli -u redis:6379/`),看着像被截断过。
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return null;
  }
}

/**
 * 把文本里内嵌的 URI 就地归约(解析失败则整段抹除)。
 * detailed=false → scheme://注册域;detailed=true → scheme://完整主机/path(仍剥 userinfo/query)。
 */
export function reduceUrlsInText(s: string, detailed = false): string {
  const reduce = detailed ? detailedUrl : originDomain;
  // 1. 任意 `scheme://…`,不止 http(s):DB/AMQP/ssh DSN(postgres://user:pass@host 等)也常
  //    出现在 query/shell/错误文本里,userinfo 即明文密码。要求 `://` 故不误伤 Windows 盘符(C:/)。
  let out = s.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, (m) => reduce(m) ?? "");
  // 2. 协议相对 `//host/path`:补 https 后归约(secret 可能在 path)。
  out = out.replace(PROTOCOL_RELATIVE_RE, (_m, p1: string) => {
    const url = _m.slice(p1.length); // 去掉前导分隔符
    return p1 + (reduce(`https:${url}`) ?? "");
  });
  // 3. 无 scheme 的 userinfo DSN(`user:pass@host…`):丢 userinfo。detailed 保留主机/path。
  out = out.replace(SCHEMELESS_USERINFO_RE, (m) => {
    const rest = m.slice(m.lastIndexOf("@") + 1); // host[:port][/path] 或 host:/path
    if (!detailed) return originDomain(`https://${rest.split(/[/:]/)[0]}`) ?? "";
    // `host:/path`(rsync/scp 远端路径)不能过 new URL():空端口会被吃掉,`backup:/data`
    // 变成 `backup/data`,语义就错了。userinfo 已经落在 rest 之外,保留主机与路径、只丢 query。
    if (/^[^/:]+:\//.test(rest)) return rest.replace(/\?.*$/, "");
    return detailedUrl(`https://${rest}`)?.replace(/^https:\/\//, "") ?? "";
  });
  // 4. 任意无 scheme 的 `host.tld/path`:非 detailed 统一抹掉可能承载凭据的 path。
  out = out.replace(SCHEMELESS_HOST_PATH_RE, (_m, prefix: string, hostAndPath: string) => {
    const reduced = reduce(`https://${hostAndPath}`);
    if (!reduced) return prefix;
    return prefix + (detailed ? reduced.replace(/^https:\/\//, "") : reduced);
  });
  // 5. 单标签主机的 `host/path?query`:上面几趟都要求主机带点,漏掉这一类,query 原样留下。
  //
  // 这一趟**有意不按 detailed 分流**,与 1–4 趟不同。「query 永不渲染」是全局不变量,而
  // reduceUrlsInText 的另外几个调用方(display card 文本、action label、reasoning 文本、
  // card-author、card-display-tool)同样群可见 —— 只在进度卡里补上,等于把另一半留着。
  // 见 README 的 scope note。
  out = out.replace(SCHEMELESS_QUERY_RE, "$1$2");
  return out;
}

/** url 策略:取 url 参数并归约(detailed 保留子域与路径)。 */
function summarizeUrl(p: Record<string, unknown>, detailed: boolean): string {
  const raw = firstString(p, ["url"]);
  if (!raw) return "";
  return (detailed ? detailedUrl(raw) : originDomain(raw)) ?? "";
}

/**
 * 从工具参数提取一句人可读摘要 —— 按工具 allowlist 策略取值,未知/MCP 工具不显示,
 * 命中敏感串则整串隐藏,最后折叠空白并截断。群卡片对全员可见,安全优先于信息量。
 */
/**
 * 放开档判定长度上限用的**原始输入**长度。刻意不复用 extractSummary —— 上限的全部意义就是
 * 不让超长输入进入解析/递归,先解析再量长度等于没设上限。
 */
function rawCommandLength(strategy: SummaryStrategy, p: Record<string, unknown>): number {
  switch (strategy) {
    case "shell": return firstString(p, ["command", "cmd"]).length;
    case "path": return firstString(p, ["path", "file_path", "file"]).length;
    case "url": return firstString(p, ["url"]).length;
    case "query": return firstString(p, ["query", "pattern"]).length;
    case "enum": return 0;
  }
}

export function summarizeToolParams(
  toolName: string | undefined,
  params: unknown,
  opts: { detail?: SummaryDetail } = {},
): string {
  if (!toolName || !params || typeof params !== "object") return "";
  const strategy = SUMMARY_STRATEGY[toolName];
  if (!strategy) return ""; // MCP / 未知工具:不渲染任意参数
  const p = params as Record<string, unknown>;
  let detail = opts.detail ?? "off";
  // 放开档的长度上限在 extractSummary **之前**判定,量的是**原始输入**。放到 sanitizeSummary
  // 里(晚一个调用帧)等于没设:分词与分类都发生在上游。这条与 SUMMARY_INPUT_MAX 阶段不同、
  // 目的也不同 —— 那条无条件截断、挡的是归约管线的正则回溯,两条都要留。
  if (detail !== "off" && rawCommandLength(strategy, p) > DETAILED_INPUT_MAX) detail = "off";
  const cleaned = sanitizeSummary(extractSummary(strategy, p, detail), strategy, detail);
  if (cleaned || detail === "off") return cleaned;
  // 放开后的内容更容易命中关键词/前缀,而脱敏是 fail-safe 整串隐藏 —— 直接返回空会让放开的
  // 模式比保守模式**信息更少**。退回保守摘要,保证信息量单调不减。
  return sanitizeSummary(extractSummary(strategy, p, "off"), strategy, "off");
}

/**
 * 按策略取原始摘要值。
 *
 * 只有 `shell` 需要单独的加法摘要 —— 其余三个策略本来就是加法的(`new URL()` 解析、封闭
 * enum、与路径同源的形状),放开档只是让它们少丢一点结构,判据不变。
 */
function extractSummary(
  strategy: SummaryStrategy,
  p: Record<string, unknown>,
  detail: SummaryDetail,
): string {
  const open = detail !== "off";
  switch (strategy) {
    case "path": {
      const raw = firstString(p, ["path", "file_path", "file"]);
      return open ? raw : shortenPath(raw);
    }
    case "shell": return open ? summarizeShellAdditive(p) : summarizeShell(p);
    case "enum": return summarizeEnum(p);
    case "url": return summarizeUrl(p, open);
    case "query": return firstString(p, ["query", "pattern"]);
  }
}

/** 摘要清洗管线:折叠空白 → URL 降级 → 敏感串守卫 → 截断。命中守卫返回空串(fail-safe)。 */
function sanitizeSummary(v: string, strategy: SummaryStrategy, detail: SummaryDetail): string {
  if (!v) return "";
  const open = detail !== "off";
  let s = v.replace(/\s+/g, " ").trim();
  // 无条件截断仍在这里(与放开档无关,见 SUMMARY_INPUT_MAX)。渲染上限只有 120/64,截断掉的
  // 部分本来也不会被渲染,所以守卫仍然跑在"会被渲染的那段"的完整形态上。
  if (s.length > SUMMARY_INPUT_MAX) s = s.slice(0, SUMMARY_INPUT_MAX);
  // 单一 choke point:所有策略统一归约内嵌 URL。避免逐 sink 加处理时漏掉某个策略(query 的
  // pattern、shell 的 URL-as-program 都会原样渲染 webhook/userinfo/内网主机)。detailed 只放开
  // 子域与路径,userinfo/query 在任何模式下都不渲染。
  s = reduceUrlsInText(s, open).replace(/\s+/g, " ").trim();
  // 归约管线处理不掉的 userinfo 形状 → 整串不渲染(放开档会退回保守摘要)。必须放在归约
  // **之后**:能确定是 DSN 的形状此时已被剥掉 userinfo,不会误伤。
  if (RESIDUAL_USERINFO_RE.test(s)) return "";
  if (RESIDUAL_QUERY_RE.test(s)) return "";
  // query/url 是「裸 token」易出没处 → 额外套用通用高熵/长 hex 检测;path/shell 只走关键词
  // + 明确前缀,避免把 git SHA / docker digest / 缓存哈希等正常路径误伤成空。
  //
  // 放开档**不**一并打开 generic。实测代价远不止误伤哈希 ——
  // `/root/.openclaw/workspace/octo-server/modules/bot_api/send.go` 这种普通路径就会命中,
  // path 策略在放开档等于失效(退回 `…/bot_api/send.go`)。而它要补的洞(`FOO=hunter2` 这类
  // 名字没有暗示的赋值)在加法路径上根本不存在:加法不看变量名,所有赋值一律抹值。
  const generic = strategy === "query" || strategy === "url";
  // 已抹掉的值及其紧邻的名字(`TOKEN=***`、`--token ***`)不参与守卫检测:值早就是 `***` 了,
  // 再让**名字**命中 SECRET_RE 只会把整条命令误伤成空、退回程序名 —— 加法档几乎每条带凭据
  // flag 的命令都会退化成只剩程序名,恰恰丢掉这一档想给的信息。
  //
  // 这条豁免之所以安全,理由是加法特有的、不可照搬到任何减法路径:加法输出里的值**按构造**
  // 已经是 `***`,所以删掉「`***` 及其紧邻的名字」不可能放出任何被渲染的值,能被删掉的只有
  // 我们已经正面归类为安全的 token。渲染字面值的路径没有这个性质。
  const probe = open && strategy === "shell" ? s.replace(ADDITIVE_MASKED_RE, " ") : s;
  if (!s || isSensitive(probe, generic)) return "";
  const max = open ? SUMMARY_DETAILED_MAX : SUMMARY_MAX;
  return s.length > max ? s.slice(0, max) + "…" : s;
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
  let s = err.replace(/\s+/g, " ").trim();
  if (!s) return "";
  s = reduceUrlsInText(s).replace(/\s+/g, " ").trim(); // URL 降级可能留下空隙
  if (!s || isSensitiveErrorText(s)) return "";
  return s.length > ERROR_MAX ? s.slice(0, ERROR_MAX) + "…" : s;
}

/** 错误文本允许明确标注的构建哈希,但未标注的长 hex/base64 一律按凭据处理。 */
const BENIGN_ERROR_HASH_RE =
  /\b(?:commit|revision|rev|digest|sha(?:-?(?:1|256))?)\b\s*(?:at\s+)?(?::|=|#)?\s*(?:sha256:)?[0-9a-fA-F]{32,64}\b/gi;

function isSensitiveErrorText(s: string): boolean {
  if (isSensitive(s, false)) return true;
  return hasGenericSecretShape(s.replace(BENIGN_ERROR_HASH_RE, ""));
}

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
  const detail = buildDisplayCard({ blocks: detailBlocks, caps, trusted: true, dropMarker: EN_DROP_MARKER });
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
