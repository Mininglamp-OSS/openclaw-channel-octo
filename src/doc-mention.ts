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

/** 串行队列键:同评论串串行,把文档任务挪出发起人的 DM 队列(轮询器串行 await 每个 handler,这里并不带来跨评论串并行),且不占用发起人的 DM 队列。 */
export function docTaskQueueScope(mention: DocCommentMention): string {
  return docTaskSessionScope(mention);
}

/**
 * 把用户评论原文放进 JSON 值,而不是直接拼进控制文本 —— 与 card_action 的
 * formatCardActionText 同样的注入防御姿态。
 */
export function formatDocMentionText(mention: DocCommentMention): string {
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
    ...(mention.docKind === "html"
      ? [
          "改动要窄：只替换锚点指向的那一个元素，别整篇重写 —— 重写会让同文档其它评论的锚点失效。",
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
export function synthesizeDocMentionMessage(mention: DocCommentMention, botUid: string): BotMessage {
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
      content: formatDocMentionText(mention),
      mention: { uids: [botUid] },
    },
  };
}

/**
 * docs 评论 API 的 parentId 是整数,而 octo-server 事件里的 id 是字符串。
 * 无法解析成正整数时返回 undefined —— 宁可发一条根评论,也不要把非法值发上去。
 *
 * 用 threadId 而不是 mention.parentId:server 那边 `thread_id = parent_id ‖ comment_id`,
 * threadId 才是评论串的根,回在它下面才和「同串共享会话」的语义一致。mention.parentId
 * 仍然解析并被契约测试钉住(它是 server 契约的一部分),只是不作为回复目标。
 *
 * 已知边界:超过 2^53 的雪花 id 会解析失败并退化成根评论。这是安全的失败方向,
 * 但接口契约本身尚未对着真实 docs 后端验证过 —— 若 parentId 其实接受字符串,
 * 应当原样透传 server 给的值,这个精度悬崖就一并消失了。
 */
export function docCommentParentId(mention: DocCommentMention): number | undefined {
  if (!/^\d+$/.test(mention.threadId)) return undefined;
  const parsed = Number(mention.threadId);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
