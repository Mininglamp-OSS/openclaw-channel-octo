import { ChannelType, MessageType, type BotMessage } from "./types.js";
import type { BotEvent } from "./card-action.js";

/**
 * 文档评论 @Bot 任务（octo-server `doc_comment_mention` 事件）。
 *
 * 与 card_action 的区别在于「产出去向」:card_action 的回复回到原 IM 会话,
 * 文档任务的回复必须回到文档评论串。合成消息仍走正常 inbound 管线以复用
 * mention 门控 / 会话隔离 / 分发骨架,但出站被重定向到 docs 评论 API
 * (见 inbound.ts 的 docTask 分支),IM 侧零发送。
 */
export interface DocCommentMention {
  eventId: number;
  idempotencyKey: string;
  docId: string;
  /**
   * docId 是哪一类文档的标识。缺省(旧 server 不发这个字段)= docs-backend 文档,
   * 与加它之前的行为一致;"html" 表示 docId 是 octo-doc 的 slug。
   *
   * 决定两件事:agent 用哪套 `octo-cli` 命令,以及**最终答复往哪发** —— 后者是插件
   * 自己的代码路径,不能靠 agent 判断。HTML 文档在 docs-backend 的评论接口上按
   * docId 查不到(那些接口不认 slug),没有这个字段就只能靠 404 猜,而 404 跟
   * 「文档真的不存在」没法区分。
   */
  docKind?: "html";
  commentId: string;
  /** 评论串根 id。server 已按 parent_id→comment_id 派生,插件不再自行推断。 */
  threadId: string;
  parentId?: string;
  fromUid: string;
  botUid: string;
  text: string;
  url?: string;
  spaceId?: string;
  enqueuedAt?: number;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 解析 server 权威的 doc_comment_mention 信封。字段名与
 * octo-server `modules/bot_mention` 的 event_data 契约一一对应;
 * 任一必填字段缺失即整条丢弃,不做兜底猜测。
 */
export function parseDocCommentMention(event: BotEvent): DocCommentMention | null {
  if (
    !Number.isSafeInteger(event.event_id) ||
    event.event_id < 0 ||
    event.event_type !== "doc_comment_mention" ||
    !event.event_data ||
    typeof event.event_data !== "object"
  ) {
    return null;
  }

  const data = event.event_data;
  const idempotencyKey = stringValue(data.idempotency_key);
  const docId = stringValue(data.doc_id);
  const commentId = stringValue(data.comment_id);
  // thread_id 由 server 派生并保证非空;这里仍回落到 comment_id,避免旧版本
  // server 漏发该字段时整条任务被丢弃。
  const threadId = stringValue(data.thread_id) || commentId;
  const fromUid = stringValue(data.from_uid);
  const botUid = stringValue(data.bot_uid);
  const text = typeof data.text === "string" ? data.text : "";
  if (!idempotencyKey || !docId || !commentId || !threadId || !fromUid || !botUid || !text.trim()) {
    return null;
  }

  const mention: DocCommentMention = {
    eventId: event.event_id,
    idempotencyKey,
    docId,
    commentId,
    threadId,
    fromUid,
    botUid,
    text,
  };
  const parentId = stringValue(data.parent_id);
  if (parentId) mention.parentId = parentId;
  // 只认 "html" 这一个已知值。将来 server 加了别的类型,旧插件会把它当普通文档 ——
  // 那正是安全的一侧:走 docs-backend 会拿到明确的报错,而认下一个不会用的类型只会
  // 让它去调一套自己还不支持的 API。
  if (stringValue(data.doc_kind).toLowerCase() === "html") mention.docKind = "html";
  const url = stringValue(data.url);
  if (url) mention.url = url;
  const spaceId = stringValue(data.space_id);
  if (spaceId) mention.spaceId = spaceId;
  if (typeof data.enqueued_at === "number" && Number.isFinite(data.enqueued_at)) {
    mention.enqueuedAt = data.enqueued_at;
  }
  return mention;
}

/**
 * 会话隔离键的作用域片段。与 DM/群会话彻底分开,粒度是「评论串」而非「单次任务」:
 * 同一评论串内的追问共享上下文,跨评论串互不可见。
 *
 * 注意不要落进 `octo:group:` 命名空间 —— group-md.ts 靠该前缀正则决定是否注入
 * GROUP.md,文档任务不应继承群聊规则。
 */
export function docTaskSessionScope(mention: DocCommentMention): string {
  return `doctask:${escapeScopeSegment(mention.docId)}:${escapeScopeSegment(mention.threadId)}`;
}

/**
 * `:` 是作用域键的分隔符,所以字段里的 `:` 必须转义,否则键的结构有歧义 ——
 * docId="d:1"/threadId="2" 与 docId="d"/threadId="1:2" 会拼成同一个键,两条不相干
 * 的评论串就共享了会话和串行队列。
 */
function escapeScopeSegment(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

/**
 * 串行队列键:同评论串串行,把文档任务挪出发起人的 DM 队列。
 *
 * ★ **刻意保留的代价,不是疏漏 —— 一个文档任务在跑时,该账号的整条事件流停摆。**
 *
 * `events-poll.ts` 在批次循环里 `await options.onDocMention(...)`,而
 * `doc-mention-handler.ts` 又 `await deps.dispatch(...)`,后者要等 agent 整轮跑完才
 * resolve。所以**轮询器才是串行点,不是这个队列键** —— 这个键既不带来跨评论串并行,
 * 也拦不住下面的停摆。受影响的不止文档任务:
 *
 *   - 同批次里排在它后面的 `card_action`(用户点卡片按钮)要等它跑完才处理;
 *   - `bot_setting_updated` 的缓存失效同样被推迟;
 *   - 这期间不再发起新的 fetch,所以**运行中新到的事件也一起等**。
 *
 * 上界是 dispatch 兜底超时,默认推导为 **660s** —— 最坏情况下卡片按钮十一分钟无响应。
 * 卡片动作是用户已有的功能,这条代价落在它身上,不只落在新功能上。
 *
 * 为什么现在仍然选串行:文档任务会改用户的文档、会往评论区发言,重放不幂等
 * (实测重放形态见 events-poll.ts 的注释:3.2s 内跑了 6 遍,永不收敛)。放开并发要
 * 先让「不阻塞地推进游标 + ack」与持久化 dedupe、按评论串排队三者一起成立;这套机器
 * (`doc-mention-dedupe.ts` + 本键)已经在位,但那是一次独立的改动,不塞进本 PR。
 * 届时把 handler 从轮询循环里摘出去,这个键才真正开始承重。
 */
export function docTaskQueueScope(mention: DocCommentMention): string {
  return docTaskSessionScope(mention);
}

/**
 * 把用户评论原文放进 JSON 值,而不是直接拼进控制文本 —— 与 card_action 的
 * formatCardActionText 同样的注入防御姿态。
 *
 * `docsBaseUrl` 由调用方从**已解析的账号配置**(accounts.ts 的 docsApiUrl,缺省回退
 * apiUrl)传进来,不由 agent 从载荷里的 url= 推。README 把这件事写死了:docsApiUrl
 * 是配置值不是可推导值,拆开部署时 IM/网页那个 origin 上根本没有文档路由 ——
 * 「the fix is a separate htmlDocsApiUrl, not a heuristic」。让模型从 url= 取协议+域名
 * 再把 bot token 发过去,既会在拆分部署上打错主机,也等于把凭证送到一个**由入站文本
 * 决定**的地址上。这里改成直接给出拼好的绝对 URL。
 */
export function formatDocMentionText(
  mention: DocCommentMention,
  opts?: { docsBaseUrl?: string },
): string {
  // 载荷里的 url= 可能带 ?code= 这类分享读票;拼我们自己的地址时一概不带它。
  const docsBase = opts?.docsBaseUrl?.replace(/\/+$/, "");
  const wholeDocUrl = docsBase
    ? `${docsBase}/docs-html/d/${encodeURIComponent(mention.docId)}/v/latest/export?download=0`
    : null;
  const lines = [
    "[Octo doc comment task]",
    `doc_id=${JSON.stringify(mention.docId)}`,
    `comment_id=${JSON.stringify(mention.commentId)}`,
    `thread_id=${JSON.stringify(mention.threadId)}`,
  ];
  if (mention.url) lines.push(`url=${JSON.stringify(mention.url)}`);
  lines.push(`comment=${JSON.stringify(mention.text)}`);
  lines.push(
    "",
    "请按上面这条文档评论的要求，读取并修改该文档（用哪套命令取决于 docType，见下）。",
    "",
    // 位置信息不在这条载荷里：DocCommentMention 只有 doc/comment/thread id 与正文,
    // octo-server 的 /v1/internal/bot-mentions 请求体也没有 anchor 字段。但锚点在
    // docs-backend 是存着的(doc_comment.anchor_text,表格里就是 "E8" 这样的单元格
    // 地址),`docs comments list` 会把它带回来。实测教训:不点明这一步,agent 会
    // 忽略 anchorText —— 用户在 E8 评论"写入888",它把 888 写进了 A1。
    "**先定位改哪里,再动手改**：",
    // 锚点不在这条载荷里(octo-server 的请求体没有 anchor 字段),但**存在评论记录上**,
    // 得自己去读回来。读法按文档类型分流:HTML 的评论存在 octo-doc,docs-backend 的
    // `docs comments list` 对它 404。具体命令与字段名交给 skill,这里只说要做这件事。
    mention.docKind === "html"
      ? "  用 octo-html skill 里列评论的命令(按 slug),找到 id=<comment_id> 那条,读它锚点里的定位信息。"
      : "  octo-cli docs comments list <doc_id>   # 找到 id=<comment_id> 那条,读它的 anchorText",
    "  锚点就是这条评论钉住的位置:表格里是单元格地址(如 E8),文档里是被选中的原文片段,",
    "  HTML 里是某个被盖了 aid 的元素。**只改那个位置**。",
    "  锚点为空时才回到「按评论文字自行判断」,并在答复里说明你改了哪里。",
    // HTML 的「自行判断」跟另外两种不是一回事:文档/表格能把正文读回来再判断,HTML
    // 的正文不在 CLI 的任何 op 里(见下面 whole-doc 那几条,要走渲染路由取),所以这里
    // 点明它此时该走那条路,免得它以为「自行判断」= 继续找锚点,然后猜 aid 猜到超时。
    ...(mention.docKind === "html"
      ? ["  HTML 的锚点为空就是 whole-doc 请求,按下面 whole-doc 那三步取回整篇再动手,别凭空猜 aid。"]
      : []),
    "",
    // 为什么要显式点名 skill:实测 agent 会自己去摸索 —— 先读 SKILL.md,再读
    // doc.md,中途还撞过 `docs content edit` 的 400(ops 格式没读对)和 412
    // (base-version 过期)才成功。那些往返每一步都发一条进度评论,评论区被
    // 工具调用刷满,用户看不到结果。先告诉它权威文档在哪,把试错换成一次读取。
    "**动手前先读 skill 文档**（它随 octo-cli 二进制内嵌，与当前 CLI 版本一致，是权威参考）：",
    // 已知类型时就别把另一篇也摆出来 —— HTML 任务列出 octo-docs 只会招来一次
    // 「先 docs get 看看」的无效往返(那条对 slug 必然 404)。
    mention.docKind === "html"
      ? "  octo-cli skills octo-html        # HTML 文档（独立后端）"
      : "  octo-cli skills octo-docs        # 文档/表格/画板：含 doc.md、sheet.md、board.md、common.md\n  octo-cli skills octo-html        # HTML 文档（独立后端）",
    // 按类型指到具体那一篇。不指名的话 agent 要么全读(浪费上下文),
    // 要么读错(表格去读 doc.md,会拿 content edit 去打 sheet,吃 409)。
    docTypeSkillHint(mention),
    "",
    // 「base-version 令牌」是 docs-backend 的并发模型;HTML 那侧是
    // base_version + 单元素替换,规则写在 octo-html skill 里,别在这里替它说。
    //
    // HTML 分支按**锚点有无**分流。锚点不在这条载荷里(见上面「先定位改哪里」那段),
    // 所以这里没法在代码里判断,只能把两种情况都写清楚交给 agent 自己分流。
    //
    // 为什么不能再无条件写「别整篇重写」:那句话(#217 随侧边栏派发一起进来)把
    // whole-doc 请求堵死了 —— 「把所有字体都改成红色」这类评论没有锚点,而 CLI
    // 侧唯一的写入口 `html element replace` 必须按 aid,`html element get` 也必须
    // 按 aid、`html get` 只有元数据(200 响应只有 slug/title/latest/created/updated),
    // 没有任何命令能读整篇或列出 aid 清单。于是 agent 既不许整篇重写、又拿不到
    // aid,只能瞎猜到超时(实测空转 8 分钟)。
    //
    // 读整篇的路不在 CLI 里,在 octo-doc 的渲染路由上:
    //   GET /d/{doc}/v/{version}           handlers_docs.go:353 handleRender
    //   GET /d/{doc}/v/{version}/{kind}    handleForkExport, kind ∈ {export, fork}
    // 两条都是 requireDocReadHTML(CapRead) 把门,version 接受 "latest";export 默认
    // 带 Content-Disposition: attachment,加 ?download=0 关掉。吐出来的 HTML 是
    // StampAids 之后的,带 data-odoc-aid —— 这正是 agent 缺的那份 aid 清单。
    //
    // 但**不能原样回灌**:handleRender 注入了 overlay 配置与 overlay JS bundle,
    // handleForkExport 另加 banner 和 <!--ODOC-COMMENT ...--> 标记。把它当作
    // publish 的入参会把这些注入物写进文档。所以下面只让它「取来看结构、拿 aid」,
    // 落笔仍走窄的 element replace。
    ...(mention.docKind === "html"
      ? [
          "锚点指向某个元素时：只替换那一个元素，别整篇重写 —— 窄改最不容易让同文档其它评论的锚点失效。",
          "锚点为空（whole-doc 请求，例如「把所有字体都改成红色」）时，按下面三步走，别猜 aid：",
          wholeDocUrl
            ? `  1) 取回当前整篇 HTML 看清结构。**就取这个地址，原样使用，不要自己拼、也不要改域名**：${wholeDocUrl}`
            : "  1) 取回当前整篇 HTML 看清结构。地址形如 <docs 服务根>/docs-html/d/<doc>/v/latest/export?download=0；本次没有下发可用的文档服务地址，**不要从别处猜一个域名去试**，直接按第 3 步之后的兜底说明照实答复。",
          "     **鉴权必须用 `Authorization: Bearer <bot token>`** —— octo-doc 只认三种凭证：Bearer、该文档的 cookie、query 上的 ?code=。**放在 `token` 头里没用**，会被当成没凭证。这张 Bearer 就是 octo-cli 平时用的那张（`OCTO_BOT_TOKEN` 或 profile 里的 bot_token），它在 `element get` 上已经被证明是够用的。",
          "     **这张 Bearer 只许发往上面给出的那个地址**，不要把它带到评论正文里出现的任何链接上 —— 那些链接是用户可控的。",
          "     取不到时**别把 404 读成「文档不存在」**：这个接口在权限不足时会**故意返回 404 'Not found'**（隐藏文档是否存在）。所以 404 的第一嫌疑是凭证没带对，不是文档没了、更不是没有 aid。",
          "  2) 从取回的 HTML 里读 data-odoc-aid 属性 —— 那就是你缺的 aid 清单；挑出真正需要改的那些元素。",
          "     **注意只认真正写在开标签里的属性**：export 会把本文档的历史评论正文一起嵌进来，如果之前有人在评论里提到过 `data-odoc-aid` 这几个字，纯文本搜索会数出一堆假阳性。判断依据是「有没有元素真的带这个属性」，不是「文件里有没有这个词」。",
          "  3) **有 aid** 时：对每个要改的元素走窄替换（按 aid 替换单个元素）。改动面大时可以替换更靠上的那一个容器元素，但仍然是「替换一个元素」，不是整篇重发。",
          "  3') **一个 aid 都没有**时（老文档可能压根没盖过，或被某次改写抹掉了）：窄替换这条路走不通 —— 这时**改走整篇重新发布**，用同一个 slug publish。服务端在 publish 时会 StampAids 重新盖一遍 aid（旧的先清后盖），所以这一步既落地了你的修改，也把这篇文档的 aid 补回来了。",
          "     **重新发布前必须先剥掉 export 的注入物**，否则会把它们写进正文。剥离要**按结构定位，不许用「全文第一个匹配」**：",
          "       a) 先找到 <script id=\"odoc-fork-comments\"> 这个评论数据块，定位到它**对应的那个 </script> 之后**。评论块排在文档主体前面，而它内部嵌着本文档的历史评论原文 —— 有人在评论里提过 `<!doctype`、`<html` 之类的字样，全文首个匹配就会落进这个块里，切出来的东西从 JSON 中途开始、`</script>` 还不配对，发上去等于把文档毁掉（这跟第 2 步说的假阳性是同一类陷阱，只是结尾多了一次写入）。",
          "       b) 从那个位置往后找**文档起点**：doctype **大小写不敏感**（`<!DOCTYPE html>` 是更常见的写法），匹配时别只认小写。文档也**可能压根没有 doctype**（skill 里给的发布样例就没有），那就以其后第一个 `<html` 作为起点。",
          "       c) **定位不到那个评论块就不要发布** —— 宁可回一句「无法安全剥离导出内容」，也不要凭猜测切一刀。发布前再自检一次：取出来的内容应当以 doctype 或 `<html` 开头、且 `<script>` 标签成对，不满足就别发。",
          "       d) 正文里的锚点标记要**成对删掉**：`<!--ODOC-COMMENT id=... by=...-->` 和它配套的 `<!--/ODOC-COMMENT-->`。只删开标记会把闭标记留在正文里。它们是导出时为标注评论位置插入的，不属于文档。",
          "     只在「确认没有任何 aid」时才走这条。有 aid 就必须窄替换 —— 整篇重发会让同文档其它评论的锚点重新计算，能不动就不动。",
          "**aid 是内容哈希，不是 body/main/section 这种名字。** 拿这类名字去 element get 必然 404，而那个 404 只说明「你猜的名字不是 aid」，**不能**据此断定文档没有 aid。要判断有没有 aid，只能看第 1 步取回的 HTML 里有没有元素真的带这个属性。",
          "**别把取回的 HTML 原样拿去发布**：export 在文档主体前面加了「fork 使用说明」banner 和评论数据块，正文里还插了锚点标记。按上面 3' 的 a→d 剥干净再发。若你取回的是渲染页而不是 export（渲染页还会额外注入 overlay 脚本），那就别拿它当发布入参 —— 换成 export 那条地址重取。",
          // 这条答复会被系统自动发到评论区(公开面)。早先这里让 agent「原样附上你请求的完整 URL」,
          // 一旦 URL 上带着 ?code= 分享读票或 token,就等于把一张有效凭证贴进公开评论 ——
          // inbound.ts 跳过非 http 的文档任务媒体走的是同一个理由。所以只许报状态码和路径。
          "如果第 1 步确实取不到内容：不要猜 aid，也不要凭空造一篇新文档覆盖上去 —— 直接在答复里说明「读不到当前文档内容，无法执行整篇修改」，附上**收到的状态码**即可。答复会公开发到评论区，**不要把请求 URL 的 query 部分、任何 token / ?code= 之类的凭证写进答复**。宁可明确回一句，也不要空转到超时。",
        ]
      : [
          "改动一律走「读-改-写」：先 get 拿到 base-version 令牌，再带着它 edit。",
          "带上令牌，并发冲突会被服务端拒绝；不带就是静默覆盖别人的编辑。",
          "只发你真正改动的部分，别整篇重写 —— 那样协作者的光标和批注不会被打乱。",
        ]),
    "",
    "你的最终答复会由系统自动发布到该评论串，请不要自己再发一条评论。",
  );
  return lines.join("\n");
}

/**
 * 按目标的文档类型指名该读哪一篇参考文件。
 *
 * 这里**只指路,不复述用法** —— 命令形状、参数、限制全在 skill 里,它随 octo-cli 二进制
 * 内嵌、与当前 CLI 版本锁步。在提示词里抄一份等于开第二个事实来源,CLI 一升级就漂,
 * 而漂掉的那份还长得像权威。
 *
 * 分两种情况:
 *   - docKind==='html' —— 载荷已经告诉我们了,直接指到 octo-html,不必再去查类型。
 *     这类文档的 doc_id 是 octo-doc 的 slug,docs-backend 的接口(含 `docs get`
 *     /`docs comments list`)一律查不到,所以连「先 docs get 看看」都不能说。
 *   - 其余 —— 类型不在载荷里,让 agent 自己一条 `docs get` 判定,别在这里猜。
 */
function docTypeSkillHint(mention: DocCommentMention): string {
  if (mention.docKind === "html") {
    return [
      "  这是 **HTML 文档**（正文在 octo-doc 这个独立后端，不在 docs-backend）：",
      "  - 只读 `octo-cli skills octo-html`，按它说的做。",
      "  - 上面的 doc_id **就是 slug**，`octo-cli html …` 直接用它;`octo-cli docs …`",
      "    那一套（含 docs get / docs comments list）对它一律 404，不要试。",
      // ★ 必须在这里再说一次。上面那条通用禁令(「答复由系统发布」)太靠后也太笼统,
      // 而 octo-html skill 里明确教了 `html reply` 怎么用 —— 两条指令打架时 agent 选了
      // 更具体的那个,于是自己回一条 + 系统再自动发一条,评论区出现两条重复答复(实测)。
      // 这里点名那个命令,把「读 skill」和「别用它的回帖口」分开说清。
      "  - **不要用 `octo-cli html reply`**：skill 里有这个命令，但这条链路上答复由系统",
      "    统一发布。你自己再回一条会变成两条重复答复。改动做完就把结果写在最终答复里。",
    ].join("\n");
  }
  return [
    "  先 `octo-cli docs get <doc_id>` 看 docType，再按类型只读对应那一篇：",
    "  - doc→doc.md，sheet→sheet.md，board→board.md；三者的编辑接口互不通用。",
    "  - 若 docType 是 html，改读 `octo-cli skills octo-html`，并用同一条响应里的",
    "    octoDocSlug（html 正文不在 docs-backend，`docs content edit` 对它无效）。",
  ].join("\n");
}

/**
 * 合成 DM 形状消息复用正常 inbound 管线。channel_id 采用 Space 感知形式与
 * card_action 保持一致;真正决定隔离的是 docTask 作用域(会话键 + 队列键),
 * 而不是这里的 channel_id。
 */
export function synthesizeDocMentionMessage(
  mention: DocCommentMention,
  botUid: string,
  opts?: { docsBaseUrl?: string },
): BotMessage {
  const channelId = mention.spaceId ? `s${mention.spaceId}_${mention.fromUid}` : mention.fromUid;
  return {
    message_id: `doc_mention:${mention.idempotencyKey}`,
    message_seq: 0,
    from_uid: mention.fromUid,
    channel_id: channelId,
    channel_type: ChannelType.DM,
    timestamp: mention.enqueuedAt ?? Math.floor(Date.now() / 1000),
    payload: {
      type: MessageType.Text,
      content: formatDocMentionText(mention, opts),
      mention: { uids: [botUid] },
    },
  };
}

/**
 * docs 评论 API 的 parentId 是 JSON **数字**,而 octo-server 事件里的 id 是字符串
 * 形态的雪花 id。这里返回**十进制字符串**,由出站侧转成无损的 JSON 数字字面量 ——
 * 不在这里 `Number()`,因为超过 2^53 的雪花 id 一旦进 JS number 就已经变了值。
 *
 * 用 threadId 而不是 mention.parentId:server 那边 `thread_id = parent_id ‖ comment_id`,
 * threadId 才是评论串的根,回在它下面才和「同串共享会话」的语义一致。mention.parentId
 * 仍然解析并被契约测试钉住(它是 server 契约的一部分),只是不作为回复目标。
 *
 * 只接受纯十进制正整数写法。`1e3` / `0x10` / `+70` / `70.0` 一律退化成根评论 ——
 * 它们要么不是 server 会发的形状,要么会在另一端被解析成**另一条真实评论**的 id,
 * 那是把答复投错串,比发成根评论严重。前导零同样拒:`070` 与 `70` 在数字域相等,
 * 但它不是 server 的输出形状,出现即说明上游契约变了,应当暴露而不是猜。
 */
export function docCommentParentId(mention: DocCommentMention): string | undefined {
  const raw = mention.threadId;
  if (!/^[1-9]\d*$/.test(raw)) return undefined;
  return raw;
}
