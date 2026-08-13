/**
 * Pure constants and pure functions for plugin/channel identifiers.
 *
 * **Layering rule**:
 * This file is `src/`-only and has no fs/child_process dependencies, so it can
 * be safely imported from both runtime code (`src/*.ts`) and CLI code
 * (`cli/*.ts`). Runtime code MUST NOT import from `cli/`.
 */

/**
 * OpenClaw runtime/install/config/inspect identifier for this plugin.
 * Must match `openclaw.plugin.json#id` and `package.json#openclaw.id`.
 */
export const PLUGIN_ID = "octo";


export const CHANNEL_ID = "octo";

/**
 * P1-e agent 展示卡工具名(见 `card-display-tool.ts`)。card-progress 侧据此把它排除
 * 出进度追踪:展示卡 turn 的产出**就是那张卡本身**,不该再有旁边的"正在处理/已中断"
 * 进度卡噪音。集中定义避免字面量漂移。
 */
export const DISPLAY_CARD_TOOL_NAME = "octo_send_display_card";
export const INTERACTIVE_CARD_TOOL_NAME = "octo_send_card";

/**
 * Separator between parent group_no and thread short_id in Octo's CommunityTopic
 * channel ID format (`<groupNo>____<shortId>`, 4 underscores). Centralized here
 * to avoid drift across modules that need to split or compose thread refs.
 */
export const THREAD_ID_SEPARATOR = "____";

/**
 * Maximum payload size for outbound bot uploads, in bytes (100 MB).
 *
 * This is the local-side cap enforced by both the outbound action handler
 * (channel.ts) and the inbound `uploadMedia` helper. It is intentionally aligned
 * to the server's `file.MaxFileSize` (octo-server `modules/file/const.go:128`):
 * `GET /v1/bot/upload/presigned` rejects any `fileSize > MaxFileSize` before
 * signing the PUT URL, so a higher local cap would just produce a clear local
 * error to a less clear remote 4xx.
 *
 * Centralized here so future bumps (when server `file.MaxFileSize` is raised)
 * change one number, not three.
 */
export const MAX_UPLOAD_SIZE = 100 * 1024 * 1024;

/**
 * 文档任务会话的**不可路由**出站哨兵。
 *
 * 文档任务的合成 inbound 是 DM 形状的,此前 `ctx.To` / `OriginatingTo` 直接写发起人的
 * 私聊 id。inbound.ts 内部的 IM 出站已经被 imEgress 闸门关掉,但 agent 只要调一次
 * message 工具,框架侧的 `outbound.sendText`(channel.ts)就会拿 `ctx.to` 把文档内容
 * 发进发起人私聊 —— 那条路**不在闸门管辖范围内**,闸门看不见也拦不住。
 *
 * 所以把 `To` 换成一个任何 IM 目标都不可能等于的哨兵,并让出站解析器对它
 * **fail-closed 抛错**:默认目标不再指向任何真实会话,漏配/新增出站点也只会得到一个
 * 明确的错误,而不是一次静默的内容泄漏。前缀带 `:` 且含 `doctask`,与真实 uid /
 * group_no 的字符集不重叠。
 */
export const DOC_TASK_NON_ROUTABLE_PREFIX = "doctask-no-im:";

/**
 * 判定一个出站目标是不是文档任务哨兵。**必须先剥运行时前缀**:框架会在不同层给
 * 同一个目标加 `octo:` / `channel:` / `group:`,只比裸串会漏判。
 */
export function isDocTaskNonRoutableTarget(target: string | null | undefined): boolean {
  if (!target) return false;
  return stripAllChannelPrefixes(target.trim()).startsWith(DOC_TASK_NON_ROUTABLE_PREFIX);
}

/**
 * 文档任务回合在 message 工具里**唯一允许**的 action 集合(正向允许集)。
 *
 * 为什么是允许集而不是拒绝集:前五轮的收口都是「再减一个出口」—— 逐个把
 * send / typing / 进度卡 / slash / fork 关掉,清单靠人肉枚举,每加一个新出口就
 * 默认敞着,直到下一轮评审把它找出来。允许集把默认反过来:**新分支默认关**,
 * 要开必须显式写进这里,于是「文档回合够得着什么」是一行可复核的声明,而不是
 * 一条需要逐分支重新推导的性质。
 *
 * 只留 read / search 的理由:这两条按**发起人身份**(requesterSenderId = 评论作者)
 * 判权限,读不到发起人本来读不到的东西 —— 它们不放大权限。其余分支(send /
 * member-info / channel-list / channel-info / group-md-read / group-md-update)
 * 一律跑在 Bot 权限下,其中 group-md-update 还是写操作。
 */
export const DOC_TASK_ALLOWED_MESSAGE_ACTIONS: ReadonlySet<string> = new Set(["read", "search"]);

/**
 * 文档任务回合在 `octo_management` 工具里允许的 action 集合。
 *
 * 该工具比 message 工具更宽:它带 create-group / update-group / add-members /
 * remove-members / delete-thread / thread-md-update / voice-context-* /
 * write-secret 这些**写与管理**动作,全部跑在 Bot 权限下,且不带 requesterSenderId。
 * 它不是默认开启的(需要 profile 里 tools.alsoAllow),但「配置上没开」不是边界,
 * 开了就洞开。所以这里给的是空集:**文档回合一个 management action 都不许用**。
 *
 * 之所以留成一个具名空集而不是直接 `return error`:与上面那条同形,将来若确有
 * 只读的 management 动作需要放开(如 group-info),改动落在这一行、连带被测试钉住,
 * 而不是散进 execute 里的条件分支。
 */
export const DOC_TASK_ALLOWED_MANAGEMENT_ACTIONS: ReadonlySet<string> = new Set<string>();

/**
 * 文档任务会话键的作用域片段(与 doc-mention.ts 的 `docTaskSessionScope` 同源)。
 * 放在 constants 里是为了让**不经过 inbound.ts 的调用方**(插件工具工厂)也能判断
 * 「当前这一轮是不是文档任务」,而不必反向依赖 inbound 模块。
 */
export const DOC_TASK_SESSION_SCOPE_PREFIX = "doctask:";

/**
 * 判定一个 sessionKey 是否属于文档任务回合。
 *
 * 为什么不只看 `deliveryContext.to` 的哨兵:哨兵是**出站目标**,由 inbound 合成
 * 消息时写入;而插件工具工厂拿到的 ctx 里 `deliveryContext` 是可选字段,宿主在
 * 某些注册阶段(tool-discovery)根本不传。sessionKey 则是文档回合一定带的,
 * 且由 inbound.ts 用固定构造式写死。两个判据取**或**:任一命中即按文档回合处理 ——
 * 门控这种场合,漏判(把文档回合当普通回合放行)比误判(把普通回合当文档回合拒掉)
 * 严重得多,所以往严的方向合并。
 *
 * 匹配 `(^|:)doctask:` 而不是 `includes("doctask")`:前者钉在段边界上。真实 uid /
 * group_no 的字符集不含 `:`,所以普通 DM / 群会话键不可能凑出这个形状。
 */
export function isDocTaskSessionKey(sessionKey: string | null | undefined): boolean {
  if (!sessionKey) return false;
  return /(^|:)doctask:/.test(sessionKey.trim());
}


/**
 * Strip any of the known channel namespace prefixes (`octo:`, `channel:`,
 * `group:`) from a channelId / sessionKey / target string. Strips
 * **recursively** — stacked prefixes such as `"octo:group:grp1"` or
 * `"channel:octo:grp1"` are stripped down to `"grp1"` in one call.
 * Fully idempotent for any input.
 *
 * Why three prefixes: the OpenClaw runtime passes channel ids through several
 * layers (gateway, plugin SDK, agent tool context) and different layers
 * historically attach different namespace prefixes. Comparisons between
 * channel ids therefore need a single normalization step that strips
 * whichever prefix is present, so two callers do not silently miscompare
 * `"octo:grp1"` against `"grp1"` or `"channel:grp1"` against `"group:grp1"`.
 *
 * Recursive vs. the old chained-replace site: the previous threadId-parsing
 * site at src/actions.ts ran `replace(/^octo:/)` then `replace(/^group:/)`
 * then `replace(/^channel:/)`, which collapsed some stacked forms (e.g.
 * `"octo:group:topicA"` → `"topicA"`) but NOT all (e.g.
 * `"channel:octo:grp1"` → `"octo:grp1"`, because only the final
 * `channel:` replace stripped the outer layer and the chain never re-ran
 * `octo:` against the now-exposed inner prefix). The recursive helper is
 * **intentionally broader** than the old chain: it canonicalizes any order
 * of stacked runtime prefixes. Net effect is strictly safer for downstream
 * comparisons and matches the helper's "all channel prefixes" name.
 *
 * Note: this is a prefix-strip, not a prefix-rewrite. `normalizeOutboundChannelPrefix`
 * in src/actions.ts is a different operation that canonicalises outbound
 * channel-group targets to a single leading `group:` (and shares this
 * recursive collapse internally to handle stacked outbound forms safely).
 */
export function stripAllChannelPrefixes(s: string): string {
  let out = s;
  // Loop bounded by the number of leading runtime prefixes (at most a
  // handful in any realistic input). Each iteration strictly shortens
  // `out`, so termination is guaranteed regardless of order.
  while (true) {
    const next = out.replace(/^(octo:|channel:|group:)/, "");
    if (next === out) return out;
    out = next;
  }
}

/** Return the per-channel sub-config for the current channel id (runtime read). */
export function getChannelConfig<T = unknown>(cfg: any): T {
  return (cfg?.channels?.[CHANNEL_ID] ?? {}) as T;
}

/**
 * Lazily ensure `cfg.channels.<CHANNEL_ID>` exists and return the mutable
 * reference. Used to write account configuration.
 */
export function ensureChannelConfigObject(cfg: any): any {
  cfg.channels ??= {};
  cfg.channels[CHANNEL_ID] ??= {};
  cfg.channels[CHANNEL_ID].accounts ??= {};
  return cfg.channels[CHANNEL_ID];
}
